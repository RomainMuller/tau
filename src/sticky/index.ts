/**
 * The Sticky support of tau: each pi process (the lead and each sub-agent)
 * sends the state of its agent to the stickies nearby. See `reporter.ts`
 * for the states, and `link.ts` and `server.ts` for the link to the stickies
 * (through `sticky server`).
 *
 * Sticky session IDs come from the task list and the agent name, so that a
 * sub-agent knows the session ID of its parent without a message:
 * `tau-<12 hex digits of the task list file name>-<agent name>`. The longest is
 * 4 + 12 + 1 + 32 = 49 bytes (the limit is 64).
 */

import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { basename } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { StickyLink } from "./link.ts";
import { registerStickyReporter, type StickyReporter } from "./reporter.ts";
import type { StickyServer } from "./server.ts";

/** A file for the log of the link to the sticky server. Only for problems: by default, there is no log. */
export const ENV_STICKY_LOG = "TAU_STICKY_LOG";

export function stickySessionId(taskListFile: string, agentName: string): string {
  // The file name only (the session ID of the lead): a sub-agent gets the
  // real path of the file, and the lead can have a path with a symbolic link.
  const hash = createHash("sha256").update(basename(taskListFile)).digest("hex").slice(0, 12);
  return `tau-${hash}-${agentName}`;
}

export interface StartStickyOptions {
  /** The task list of the lead (also for a sub-agent). */
  readonly taskListFile: string;
  readonly agentName: string;
  /** The agent name of the parent, for a sub-agent. */
  readonly parentAgentName?: string;
  readonly displayName: string;
  readonly workspace: string;
  readonly model: string | undefined;
  readonly modelLabel: (model: { readonly id: string; readonly name?: string }) => string | undefined;
  readonly isAskTool: (toolName: string) => boolean;
  readonly env: NodeJS.ProcessEnv;
  /** Makes the client of `sticky server` (see `server.ts`). */
  readonly server: () => StickyServer | undefined;
}

/**
 * Starts the Sticky support. Returns `undefined` (and does nothing) when
 * there is no socket path for `sticky server` (not macOS, and no
 * `STICKY_SOCKET`). When no server runs, or no sticky is near, it does
 * nothing visible.
 */
export function startSticky(pi: ExtensionAPI, options: StartStickyOptions): StickyReporter | undefined {
  const server = options.server();
  if (server === undefined) return undefined;
  const logFile = options.env[ENV_STICKY_LOG];
  const log =
    logFile === undefined || logFile === ""
      ? undefined
      : (message: string) =>
          void appendFile(logFile, `${new Date().toISOString()} ${options.agentName}: ${message}\n`).catch(() => undefined);
  const link = new StickyLink({ server, ...(log === undefined ? {} : { log }) });
  const reporter = registerStickyReporter(pi, {
    link,
    sessionId: stickySessionId(options.taskListFile, options.agentName),
    ...(options.parentAgentName === undefined
      ? {}
      : { parentSessionId: stickySessionId(options.taskListFile, options.parentAgentName) }),
    name: options.displayName,
    workspace: options.workspace,
    model: options.model,
    modelLabel: options.modelLabel,
    isAskTool: options.isAskTool,
  });
  link.start();
  return reporter;
}
