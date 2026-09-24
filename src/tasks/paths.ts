import { dirname, join } from "node:path";

import { TauError } from "./errors.ts";

/**
 * The tau directory: the parent of the pi agent directory, with `tau` added.
 * For the default agent directory `~/.pi/agent`, this is `~/.pi/tau`.
 */
export function tauDir(agentDir: string): string {
  return join(dirname(agentDir), "tau");
}

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The path of the task list database of a lead session. The session ID becomes a
 * file name, so it can contain only letters, digits, `.`, `_`, and `-`.
 */
export function taskListFile(tauDirectory: string, sessionId: string): string {
  if (!SAFE_SESSION_ID.test(sessionId) || sessionId.includes("..")) {
    throw new TauError("invalid_argument", `The session ID ${JSON.stringify(sessionId)} is not safe as a file name.`);
  }
  return join(tauDirectory, "tasklists", `${sessionId}.db`);
}
