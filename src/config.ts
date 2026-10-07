/**
 * The tau configuration: `<tau directory>/config.json` (by default
 * `~/.pi/tau/config.json`). All fields are optional. There is no
 * configuration for each project.
 *
 * The file is JSON, and it can have comments (`// …` and `/* … *\/`), as in
 * the README example. tau reads it when the session starts (and again after
 * `/reload`).
 *
 * When a field is not valid, tau uses the default value of that field, and
 * shows a warning. When the file is not valid JSON, tau uses all default
 * values, and shows a warning. tau does not stop because of the
 * configuration.
 */

import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_MAX_IDLE_CONTINUATIONS } from "./stop.ts";
import { DEFAULT_MAX_SUB_AGENTS } from "./tasks/rules.ts";
import { DEFAULT_TASK_TYPE_DEFINITIONS, type TaskTypeDefinition } from "./tasks/types.ts";
import { cleanLine } from "./text.ts";
import { DEFAULT_MAX_TREE_LINES } from "./tree.ts";

export interface TauConfig {
  /** The key that shows or hides completed, canceled, and acknowledged tasks. */
  readonly toggleCompletedKey: string;
  /** Show task IDs as colored powerline pills. Needs a Nerd Font. */
  readonly idPills: boolean;
  /** The maximum number of task lines in the tree widget. */
  readonly maxTreeLines: number;
  /** The maximum number of sub-agents that run at the same time. */
  readonly maxParallelSubAgents: number;
  /** Continuations with no task change before tau stops the "do not stop" rule. */
  readonly maxIdleContinuations: number;
  /** The task types. This list replaces the default list. */
  readonly taskTypes: Readonly<Record<string, TaskTypeDefinition>>;
  /**
   * The name of the "ask question" tool of a different extension. When it is
   * set, tau does not register `tau_ask_user`, the work gate never blocks
   * this tool, and the text for the models names it. When it is not set,
   * tau registers `tau_ask_user` as the last resort.
   */
  readonly askTool?: string;
  /**
   * Send the state of each agent to the Sticky devices, through
   * `sticky server` (macOS). See `sticky/reporter.ts`.
   */
  readonly sticky: boolean;
}

export const DEFAULT_CONFIG: TauConfig = {
  toggleCompletedKey: "ctrl+shift+t",
  idPills: true,
  maxTreeLines: DEFAULT_MAX_TREE_LINES,
  maxParallelSubAgents: DEFAULT_MAX_SUB_AGENTS,
  maxIdleContinuations: DEFAULT_MAX_IDLE_CONTINUATIONS,
  taskTypes: DEFAULT_TASK_TYPE_DEFINITIONS,
  sticky: true,
};

/** The name of the configuration file in the tau directory. */
export const CONFIG_FILE = "config.json";
/** The maximum size of the configuration file, in bytes. */
export const MAX_CONFIG_BYTES = 64 * 1024;
/** The maximum number of task types. */
export const MAX_TASK_TYPES = 50;

const TASK_TYPE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** A tool name: the text that models get has it, so only these characters. */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/**
 * The built-in tools of pi. They cannot be the ask tool: the work gate never
 * blocks the ask tool.
 */
const BUILT_IN_TOOLS: ReadonlySet<string> = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

/** True when `value` can be the `askTool`: a tool name, not a tau tool and not a built-in tool. */
export function isAskToolName(value: string): boolean {
  return TOOL_NAME.test(value) && !value.startsWith("tau_") && !BUILT_IN_TOOLS.has(value);
}
const MAX_DESCRIPTION_LENGTH = 300;

/** The configuration, and the problems that tau found in the file. */
export interface LoadedConfig {
  readonly config: TauConfig;
  /** The path of the file. */
  readonly file: string;
  /** One line for each problem. Empty when the file is valid or does not exist. */
  readonly problems: readonly string[];
}

/** Reads the configuration file of a tau directory. Never throws. */
export async function loadConfig(tauDirectory: string): Promise<LoadedConfig> {
  const file = join(tauDirectory, CONFIG_FILE);
  const defaults = (problem: string): LoadedConfig => ({
    config: DEFAULT_CONFIG,
    file,
    problems: [`${problem} tau uses the default configuration.`],
  });
  try {
    await lstat(file);
  } catch (error) {
    // No file: the default configuration, with no problem.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: DEFAULT_CONFIG, file, problems: [] };
    return defaults(`tau cannot read ${file} (${errorText(error)}).`);
  }
  let text: string;
  try {
    // A symbolic link is permitted (for example, dotfiles in a repository).
    // Open the target one time, and check and read the open file: so the
    // file cannot change between the checks and the read.
    // O_NONBLOCK: a named pipe (FIFO) must not stop the start while it
    // waits for a writer. For a regular file, the flag has no effect.
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile()) return defaults(`${file} is not a regular file.`);
      const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_CONFIG_BYTES) return defaults(`${file} has more than ${MAX_CONFIG_BYTES} bytes.`);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Also a symbolic link to a file that does not exist: tell it.
    return defaults(`tau cannot read ${file} (${errorText(error)}).`);
  }
  const { config, problems } = parseConfig(text);
  return { config, file, problems };
}

function errorText(error: unknown): string {
  return cleanLine(error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/** The maximum number of problem lines. The rest shows as one line. */
const MAX_PROBLEMS = 20;

/** Parses the text of a configuration file. See the module comment. Never throws. */
export function parseConfig(text: string): { config: TauConfig; problems: string[] } {
  let parsed: { config: TauConfig; problems: string[] };
  try {
    parsed = parseConfigText(text);
  } catch (error) {
    return { config: DEFAULT_CONFIG, problems: [`tau cannot read the configuration (${errorText(error)}). tau uses the default configuration.`] };
  }
  const { config, problems } = parsed;
  if (problems.length <= MAX_PROBLEMS) return parsed;
  return { config, problems: [...problems.slice(0, MAX_PROBLEMS), `… and ${problems.length - MAX_PROBLEMS} more problems.`] };
}

/**
 * The configuration of a process. A sub-agent (its environment has
 * `TAU_TASKLIST`) uses the configuration of its lead (`TAU_CONFIG`), so that
 * all agents of a task list use the same rules. A lead reads the file of the
 * tau directory.
 *
 * A sub-agent with no valid `TAU_CONFIG` gets `fatal`: the defaults or its
 * own file can have less strict rules than the lead (for example, a type
 * that is read-only for the lead), so tau must not start in that process.
 */
export async function configFor(
  env: NodeJS.ProcessEnv,
  tauDirectory: string,
): Promise<LoadedConfig & { readonly fatal?: string }> {
  if (env.TAU_TASKLIST === undefined || env.TAU_TASKLIST === "") return loadConfig(tauDirectory);
  const inherited = env.TAU_CONFIG ?? "";
  const file = "TAU_CONFIG (the configuration of the lead)";
  const { config, problems } = inherited === "" ? { config: DEFAULT_CONFIG, problems: ["TAU_CONFIG is empty."] } : parseConfig(inherited);
  if (problems.length > 0) {
    return {
      config,
      file,
      problems,
      fatal: `This sub-agent did not get a valid configuration from its lead (${cleanLine(problems[0]!)}). tau does not start in this pi, so that it cannot use other rules than its lead.`,
    };
  }
  return { config, file, problems };
}

function parseConfigText(text: string): { config: TauConfig; problems: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(stripComments(text));
  } catch (error) {
    return {
      config: DEFAULT_CONFIG,
      problems: [`The file is not valid JSON (${errorText(error)}). tau uses the default configuration.`],
    };
  }
  if (!isRecord(value)) {
    return { config: DEFAULT_CONFIG, problems: ["The file must contain one JSON object. tau uses the default configuration."] };
  }
  const problems: string[] = [];
  const fields: Record<string, (item: unknown) => unknown> = {
    toggleCompletedKey: (item) => (typeof item === "string" && isKeyId(item) ? item : undefined),
    idPills: (item) => (typeof item === "boolean" ? item : undefined),
    maxTreeLines: (item) => integerIn(item, 1, 100),
    maxParallelSubAgents: (item) => integerIn(item, 1, 32),
    maxIdleContinuations: (item) => integerIn(item, 0, 100),
    taskTypes: (item) => taskTypes(item, problems),
    askTool: (item) => (typeof item === "string" && isAskToolName(item) ? item : undefined),
    sticky: (item) => (typeof item === "boolean" ? item : undefined),
  };
  const expected: Record<string, string> = {
    toggleCompletedKey: 'a key, for example "ctrl+shift+t"',
    idPills: "true or false",
    maxTreeLines: "an integer from 1 to 100",
    maxParallelSubAgents: "an integer from 1 to 32",
    maxIdleContinuations: "an integer from 0 to 100",
    taskTypes: "an object of task types (see the README)",
    askTool:
      'the name of an "ask question" tool of a different extension (a letter, then a-z, A-Z, 0-9, _, and -, at most 64 characters; not a tau_ tool or a built-in tool)',
    sticky: "true or false",
  };
  const config: Record<string, unknown> = { ...DEFAULT_CONFIG };
  for (const [key, item] of Object.entries(value)) {
    // Only the own fields of the table: not "__proto__", "constructor", …
    const check = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (check === undefined) {
      problems.push(`${quote(key)} is not a configuration field. tau does not use it.`);
      continue;
    }
    const checked = check(item);
    if (checked === undefined) {
      problems.push(`${key} must be ${expected[key]}. tau uses the default value.`);
      continue;
    }
    config[key] = checked;
  }
  return { config: config as unknown as TauConfig, problems };
}

const MAX_WRITABLE_EXTENSIONS = 20;
const WRITABLE_EXTENSION = /^\.[a-z0-9]{1,16}$/i;

/**
 * Checks the task types. Returns `undefined` when the value is not valid:
 * then tau uses the default list. Adds details to `problems`.
 */
function taskTypes(value: unknown, problems: string[]): Record<string, TaskTypeDefinition> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  const own: string[] = [];
  if (entries.length === 0) own.push("taskTypes has no task types.");
  if (entries.length > MAX_TASK_TYPES) own.push(`taskTypes has ${entries.length} task types. The maximum is ${MAX_TASK_TYPES}.`);
  const result: Record<string, TaskTypeDefinition> = {};
  for (const [name, definition] of entries) {
    if (!TASK_TYPE_NAME.test(name)) {
      own.push(`The task type ${quote(name)} is not a valid name (use a-z, 0-9, and -, at most 32 characters).`);
      continue;
    }
    if (!isRecord(definition) || typeof definition.description !== "string") {
      own.push(`The task type ${name} must be an object with a description.`);
      continue;
    }
    const unknown = Object.keys(definition).filter((key) => key !== "description" && key !== "readOnly" && key !== "writableExtensions");
    if (unknown.length > 0) own.push(`The task type ${name} has fields that tau does not know: ${unknown.map(quote).join(", ")}.`);
    if (definition.readOnly !== undefined && typeof definition.readOnly !== "boolean") {
      own.push(`readOnly of the task type ${name} must be true or false.`);
      continue;
    }
    let writableExtensions: string[] | undefined;
    if (definition.writableExtensions !== undefined) {
      const extensions = definition.writableExtensions;
      if (
        !Array.isArray(extensions) ||
        extensions.length < 1 ||
        extensions.length > MAX_WRITABLE_EXTENSIONS ||
        !extensions.every((extension) => typeof extension === "string" && WRITABLE_EXTENSION.test(extension))
      ) {
        own.push(
          `writableExtensions of the task type ${name} must be a list of 1 to ${MAX_WRITABLE_EXTENSIONS} extensions, for example [".md"].`,
        );
        continue;
      }
      writableExtensions = [...new Set((extensions as string[]).map((extension) => extension.toLowerCase()))];
    }
    const description = cleanLine(definition.description).trim();
    if (description === "" || [...description].length > MAX_DESCRIPTION_LENGTH) {
      own.push(`The description of the task type ${name} must have 1 to ${MAX_DESCRIPTION_LENGTH} characters.`);
      continue;
    }
    result[name] = {
      description,
      readOnly: definition.readOnly === true,
      ...(writableExtensions === undefined ? {} : { writableExtensions }),
    };
  }
  // The first task of each list (T0) has the type "plan".
  if (entries.length > 0 && result.plan === undefined && !own.some((line) => line.includes(" plan "))) {
    own.push('taskTypes must have the task type "plan": the first task of each list has this type.');
  }
  if (own.length > 0) {
    problems.push(...own);
    return undefined;
  }
  return result;
}

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
/** Keys that need a modifier other than shift (alone, they are normal input). */
const MODIFIED_KEYS = new Set([
  "enter", "tab", "space", "backspace", "delete", "insert", "home", "end", "pageUp", "pageDown", "up", "down", "left", "right",
]);
const FUNCTION_KEYS = new Set(["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12"]);
// Not "+" (pi splits keys on it), and not "[", "]", "\\" (with ctrl, a
// terminal sends the same bytes as Escape and other control keys).
const SYMBOL_KEYS = new Set([..."`-=;',./!@#$%^&*()_|~{}:<>?"]);

/**
 * True when `value` is a key that tau can bind for the toggle, for example
 * `ctrl+shift+t`:
 *
 * - Modifiers: `ctrl`, `shift`, `alt`, `super`, each at most one time.
 * - A letter, a digit, a symbol, or a special key (`tab`, `pageUp`, …) needs
 *   `ctrl`, `alt`, or `super`: else it catches normal input.
 * - A function key (`f1` … `f12`) has no modifier.
 * - Not Escape: pi uses it to stop the agent.
 */
export function isKeyId(value: string): boolean {
  const parts = value.split("+");
  const key = parts.pop()!;
  const modifiers = parts;
  if (key === "" || new Set(modifiers).size !== modifiers.length || !modifiers.every((modifier) => MODIFIERS.has(modifier))) {
    return false;
  }
  if (FUNCTION_KEYS.has(key)) return modifiers.length === 0;
  const strong = modifiers.some((modifier) => modifier !== "shift");
  // With ctrl, a terminal sends the same bytes for these letters as for
  // Backspace (h), Tab (i), and Enter (j, m).
  if (modifiers.includes("ctrl") && CONTROL_ALIASES.has(key)) return false;
  return strong && (/^[a-z0-9]$/u.test(key) || SYMBOL_KEYS.has(key) || MODIFIED_KEYS.has(key));
}

const CONTROL_ALIASES = new Set(["h", "i", "j", "m"]);

/**
 * Removes `// …` and `/* … *\/` comments from JSON text. Keeps the text in
 * strings. A comment becomes a space (so that it cannot join two tokens),
 * and keeps its line feeds (so that the JSON error positions stay correct).
 * Throws for a block comment with no end.
 */
export function stripComments(text: string): string {
  let result = "";
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    const next = text[index + 1];
    if (inString) {
      result += char;
      if (char === "\\") {
        result += next ?? "";
        index++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
    } else if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      result += " \n";
    } else if (char === "/" && next === "*") {
      index += 2;
      result += " ";
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        if (text[index] === "\n") result += "\n";
        index++;
      }
      if (index >= text.length) throw new SyntaxError("A /* comment has no */ end.");
      index++;
    } else {
      result += char;
    }
  }
  return result;
}

function integerIn(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quote(text: string): string {
  return JSON.stringify(cleanLine(text).slice(0, 60));
}
