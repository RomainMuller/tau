/**
 * The task list of a forked session (`/fork`).
 *
 * The new session gets a copy of the task list of the old session, rolled
 * back to the fork point. The fork point is a revision of the task list:
 *
 * - Before each message enters the session of the lead, tau writes the
 *   revision of the task list into the session, as a custom entry
 *   (`REVISION_ENTRY`), when it changed. Custom entries do not go to the
 *   model.
 * - pi copies the entries of the session up to the fork point into the new
 *   session. The last revision entry in the new session is the fork point.
 *
 * At the fork point, sub-agents can own tasks in progress. These sub-agents
 * work for the old session, not for the fork. In the copy, their tasks become
 * `failed` (retryable), with the result `owner is in a different session`
 * (their waiting sub-tasks are canceled first), and their agent records end.
 * A task of a sub-agent that has a task of the lead under it stays in
 * progress (with the waiting tasks between them) until the lead closes or
 * cancels them. Messages are not copied.
 *
 * The revision entries are hints: a revision above the revision of the old
 * list is not valid, and the old list must be the list of the old session.
 */

import { open } from "node:fs/promises";

import { LEAD_AGENT, rollback, seedTaskList, SYSTEM_ACTOR, type TaskList } from "./tasks/model.ts";
import { cancelTask, endAgent, failTasksOfAgent } from "./tasks/rules.ts";

/** The custom entry type of a task list revision in a session. */
export const REVISION_ENTRY = "tau-revision";
/** The result of a task whose owner works for the old session. */
export const OWNER_IN_OTHER_SESSION = "owner is in a different session";

/** The maximum size of the first line of a session file (its header), in bytes. */
const MAX_HEADER_BYTES = 64 * 1024;

/**
 * The fork point: the revision in the last revision entry of a session
 * branch. `undefined` when the branch has no revision entry (tau did not
 * change the list before the fork point).
 */
export function forkRevision(branch: readonly { readonly type: string; readonly customType?: string; readonly data?: unknown }[]): number | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (entry.type !== "custom" || entry.customType !== REVISION_ENTRY) continue;
    const revision = (entry.data as { revision?: unknown } | undefined)?.revision;
    if (typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0) return revision;
  }
  return undefined;
}

/**
 * The task list of the fork: `old` rolled back to `revision`, for the new
 * session. With no revision, a new list (the task `T0` only).
 */
export function forkTaskList(old: TaskList, revision: number | undefined, sessionId: string, now: string): TaskList {
  if (revision === undefined) return seedTaskList(sessionId, now);
  const list: TaskList = { ...rollback(old, revision), sessionId };
  const ctx = { actor: { name: SYSTEM_ACTOR }, now };
  const subAgents = new Set(list.agents.map((agent) => agent.name).filter((name) => name !== LEAD_AGENT));
  // Fail the tasks of the sub-agents. A task closes only after its sub-tasks
  // (rule 7): the sub-tasks of sub-agents fail first (deepest first), and
  // tau cancels their waiting sub-tasks, which are the plan of the old
  // sub-agent. A retry of the failed task makes its own plan. Repeat while a
  // pass changes the list.
  for (let changed = true; changed; ) {
    changed = false;
    for (const name of subAgents) {
      const { failed, blocked } = failTasksOfAgent(list, ctx, name, OWNER_IN_OTHER_SESSION);
      if (failed.length > 0) changed = true;
      for (const task of blocked) {
        for (const child of list.tasks.filter((item) => item.id.startsWith(`${task.id}.`) && item.id.split(".").length === task.id.split(".").length + 1)) {
          if (child.status !== "waiting") continue;
          // cancelTask refuses when a sub-task of the child is in progress:
          // then a later pass cancels it (after that sub-task failed).
          try {
            cancelTask(list, ctx, child.id, OWNER_IN_OTHER_SESSION);
            changed = true;
          } catch {
            // Try again in the next pass.
          }
        }
      }
    }
  }
  for (const agent of list.agents) endAgent(list, agent.name, now);
  return list;
}

/**
 * The session ID in the header (the first line) of a session file.
 * `undefined` when the file has no valid header.
 */
export async function sessionIdOf(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(MAX_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const end = text.indexOf("\n");
    const header = JSON.parse(end === -1 ? text : text.slice(0, end)) as { type?: unknown; id?: unknown };
    return header.type === "session" && typeof header.id === "string" ? header.id : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}
