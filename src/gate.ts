/**
 * The work gate. An agent must have an active task before it can use tools
 * other than the tau tools. When the type of the active task is read-only,
 * the gate also blocks the tools that change files.
 *
 * tau cannot check that a tool call is for the active task. The messages
 * tell the agent to do only the work that the active task needs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { activeTask, type TaskList } from "./tasks/model.ts";
import type { TaskTypeDefinition } from "./tasks/types.ts";
import { cleanLine } from "./text.ts";

/** The tools that change files. The gate blocks them for read-only tasks. */
export const FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

export interface GateInput {
  readonly toolName: string;
  /** The names of the tau tools. The gate never blocks them. */
  readonly tauTools: ReadonlySet<string>;
  readonly list: TaskList;
  readonly agent: string;
  readonly taskTypes: Readonly<Record<string, TaskTypeDefinition>>;
  /**
   * The configured "ask question" tool. The gate never blocks it: an agent
   * with no active task (for example a lead that waits for its sub-agents)
   * must be able to ask the user. The tool only reads an answer.
   */
  readonly askTool?: string | undefined;
  /** The arguments of the tool call. The gate reads `path` of `edit` and `write`. */
  readonly toolInput?: unknown;
  /** The working directory, to resolve a relative `path`. */
  readonly cwd?: string | undefined;
}

function hasExtension(file: string, extensions: readonly string[]): boolean {
  return extensions.includes(path.extname(file).toLowerCase());
}

/** The Unicode space characters that pi replaces with a normal space. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Resolves a tool path in the same way as pi. This mirrors `resolveToCwd` in
 * pi-coding-agent `dist/core/tools/path-utils.js`, and `normalizePath` and
 * `resolvePath` in `dist/utils/paths.js`. pi does not export them.
 * Throws when a `file://` URL is not valid.
 */
export function resolveLikePi(target: string, cwd: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const normalized = normalizeLikePi(target, true, platform);
  // Like pi: an absolute path does not use the cwd. On Windows, "\\x" has no
  // drive, and the drive comes from the cwd of the process.
  return paths.isAbsolute(normalized) ? paths.resolve(normalized) : paths.resolve(normalizeLikePi(cwd, false, platform), normalized);
}

/** Mirrors `normalizePath` of pi. pi uses the tool options only for the tool path. */
function normalizeLikePi(input: string, toolPath: boolean, platform: NodeJS.Platform): string {
  let normalized = toolPath ? input.replace(UNICODE_SPACES, " ") : input;
  if (toolPath && normalized.startsWith("@")) normalized = normalized.slice(1);
  if (platform === "win32") normalized = windowsShellPath(normalized);
  const home = os.homedir();
  if (normalized === "~") return home;
  if (normalized.startsWith("~/") || (platform === "win32" && normalized.startsWith("~\\"))) {
    return (platform === "win32" ? path.win32 : path.posix).join(home, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

/** Mirrors `normalizeWindowsShellPath` of pi: `/c/x`, `/mnt/c/x`, `/cygdrive/c/x` become `C:\x`. */
function windowsShellPath(file: string): string {
  if (!file.startsWith("/") || file.startsWith("//") || file.includes("\\")) return file;
  const match = file.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return file;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1]!.toUpperCase()}:\\${suffix ?? ""}`;
}

/** The real path of the parent directory when it exists, else the given path. */
function withRealParent(full: string): string {
  try {
    return path.join(fs.realpathSync(path.dirname(full)), path.basename(full));
  } catch {
    return full;
  }
}

/**
 * True when the tool call changes only a file with a permitted extension.
 * The check fails closed: when tau cannot be sure, it blocks the call.
 * - A symbolic link must point to an existing file with a permitted extension.
 * - A file with more than one hard link is blocked: tau cannot check the
 *   other names of the file.
 */
function writesPermittedFile(input: GateInput, extensions: readonly string[]): boolean {
  const target = (input.toolInput as { path?: unknown } | null | undefined)?.path;
  if (typeof target !== "string" || target === "") return false;
  let full: string;
  try {
    full = resolveLikePi(target, input.cwd ?? process.cwd());
  } catch {
    return false;
  }
  if (!hasExtension(full, extensions)) return false;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(full);
  } catch (error) {
    // The file does not exist (yet): the resolved path is the target.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return hasExtension(withRealParent(full), extensions);
    return false;
  }
  let real = full;
  if (stat.isSymbolicLink()) {
    try {
      real = fs.realpathSync(full);
      // The target of the link can also have more than one hard link.
      stat = fs.statSync(real);
    } catch {
      // A dangling link: a write would create its target.
      return false;
    }
    if (!hasExtension(real, extensions)) return false;
  }
  return !(stat.isFile() && stat.nlink > 1);
}

/** Returns the reason to block the tool call, or `undefined` to allow it. */
export function checkGate(input: GateInput): string | undefined {
  if (input.tauTools.has(input.toolName) || input.toolName === input.askTool) {
    return undefined;
  }
  // An ended agent (for example, an agent aborted it) must not work, also
  // when its task stays in progress because of open sub-tasks.
  if (input.list.agents.some((agent) => agent.name === input.agent && agent.state === "ended")) {
    return `tau blocked ${input.toolName}: your agent record ended (an agent stopped you, or your work ended). Do no more work. Stop now.`;
  }
  const active = activeTask(input.list, input.agent);
  if (active === undefined) {
    return [
      `tau blocked ${input.toolName}: you have no active task. All work must be for a task that you own.`,
      "1. Find the task that this work is for (tau_list), and claim it (tau_claim).",
      "2. If no task is correct, create one (tau_create), then claim it.",
      "Do only the work that the active task needs.",
    ].join("\n");
  }
  // A type that the configuration does not define is read-only: this is the
  // safe choice.
  const activeType = input.taskTypes[active.type];
  if (FILE_CHANGE_TOOLS.has(input.toolName) && activeType?.readOnly !== false) {
    const extensions = activeType?.writableExtensions;
    if (extensions !== undefined && extensions.length > 0 && writesPermittedFile(input, extensions)) return undefined;
    // Name a type that permits changes, from the configured types.
    const writable = Object.entries(input.taskTypes).find(([name, type]) => !type.readOnly && name !== "plan")?.[0];
    return [
      `tau blocked ${input.toolName}: your active task ${active.id} has the type "${cleanLine(active.type)}", which is read-only.`,
      ...(extensions === undefined || extensions.length === 0
        ? []
        : [`This type permits changes only to files with the extensions: ${extensions.join(", ")}.`]),
      writable === undefined
        ? 'Record what you found in the task result. No configured task type other than "plan" permits file changes: tell the user.'
        : `Record what you found in the task result. Create a "${writable}" task for changes.`,
    ].join("\n");
  }
  return undefined;
}
