/**
 * The identity of the current pi process in tau: the lead agent, or a
 * sub-agent that a different tau process started.
 *
 * A parent starts a sub-agent in a new herdr pane, and gives it these
 * environment variables:
 *
 * - `TAU_TASKLIST`: the path of the task list database of the lead.
 * - `TAU_TASK_ID`: the task that the sub-agent received.
 * - `TAU_AGENT_NAME`: the herdr name of the sub-agent.
 * - `TAU_PARENT_AGENT`: the name of the agent that started it.
 *
 * tau does not trust these values alone. The database must be in the tau
 * directory, and it must have an agent record with the same name, task,
 * parent, and herdr pane, and the task must be in progress with the
 * sub-agent as owner. See `checkSubAgent`.
 *
 * These checks keep cooperative agents of one user in order. They are not
 * a security boundary: a program of the same user can change the database
 * and the environment.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { isAgentName } from "./names.ts";
import { TauError } from "./tasks/errors.ts";
import { findTask, isTaskId, LEAD_AGENT, type TaskList } from "./tasks/model.ts";
import { taskListFile } from "./tasks/paths.ts";
import type { Actor } from "./tasks/rules.ts";

export type Identity =
  | { readonly role: "lead"; readonly actor: Actor; readonly file: string }
  | {
      readonly role: "subagent";
      readonly actor: Actor & { readonly scope: string };
      readonly parent: string;
      readonly file: string;
    };

export const ENV_TASKLIST = "TAU_TASKLIST";
export const ENV_TASK_ID = "TAU_TASK_ID";
export const ENV_AGENT_NAME = "TAU_AGENT_NAME";
export const ENV_PARENT_AGENT = "TAU_PARENT_AGENT";
/**
 * The effective configuration of the lead, as JSON (see `config.ts`). A
 * sub-agent uses it, not the file, so that all agents of one task list use
 * the same rules (task types, limits). Each sub-agent gives it to its own
 * sub-agents.
 */
export const ENV_CONFIG = "TAU_CONFIG";
/**
 * The herdr pane of the lead. A sub-agent puts the panes of its own
 * sub-agents in the column on the right of this pane (see `layout.ts`).
 * It is only for display: tau does not trust it for other things.
 */
export const ENV_LEAD_PANE = "TAU_LEAD_PANE";

/**
 * Finds the identity of this process. Without `TAU_TASKLIST`, the process is
 * a lead, and its task list is the one of its session.
 */
export function resolveIdentity(env: NodeJS.ProcessEnv, tauDirectory: string, sessionId: string): Identity {
  const file = env[ENV_TASKLIST];
  if (file === undefined || file === "") {
    return { role: "lead", actor: { name: LEAD_AGENT }, file: taskListFile(tauDirectory, sessionId) };
  }
  const task = env[ENV_TASK_ID] ?? "";
  const name = env[ENV_AGENT_NAME] ?? "";
  const parent = env[ENV_PARENT_AGENT] ?? "";
  if (!isTaskId(task)) {
    throw new TauError("invalid_argument", `${ENV_TASK_ID} ${JSON.stringify(task)} is not a task ID.`);
  }
  if (!isAgentName(name)) {
    throw new TauError("invalid_argument", `${ENV_AGENT_NAME} ${JSON.stringify(name)} is not a tau agent name.`);
  }
  if (parent !== LEAD_AGENT && !isAgentName(parent)) {
    throw new TauError("invalid_argument", `${ENV_PARENT_AGENT} ${JSON.stringify(parent)} is not a tau agent name.`);
  }
  return {
    role: "subagent",
    actor: { name, scope: task },
    parent,
    file: checkTaskListPath(file, tauDirectory),
  };
}

/**
 * Checks that `file` is a task list database in the tau directory: its real
 * directory is `<tau directory>/tasklists`, and its name is a safe session
 * file name.
 */
function checkTaskListPath(file: string, tauDirectory: string): string {
  const name = basename(file);
  if (!name.endsWith(".db")) {
    throw new TauError("invalid_argument", `${ENV_TASKLIST} ${JSON.stringify(file)} is not a task list database.`);
  }
  const expected = taskListFile(tauDirectory, name.slice(0, -".db".length));
  let realDirectory: string;
  let expectedDirectory: string;
  try {
    realDirectory = realpathSync(dirname(file));
    expectedDirectory = realpathSync(dirname(expected));
  } catch (error) {
    throw new TauError(
      "invalid_argument",
      `${ENV_TASKLIST} ${JSON.stringify(file)} is not a task list database (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (realDirectory !== expectedDirectory) {
    throw new TauError("invalid_argument", `${ENV_TASKLIST} ${JSON.stringify(file)} is not in the tau directory.`);
  }
  return join(expectedDirectory, name);
}

/**
 * Checks that the task list gave this task to this sub-agent. Throws when
 * the agent record or the task does not agree with the identity.
 *
 * The pane must be the pane of the record, except when the pane moved
 * after the parent made it and before pi started (a moved pane gets a new
 * ID): the sub-agent did not record its pi session yet, and herdr does not
 * show the pane of the record any more (`recordPaneGone`). Then the caller
 * records the new pane. This check is cooperative, not a security boundary.
 */
export function checkSubAgent(
  list: TaskList,
  identity: Extract<Identity, { role: "subagent" }>,
  paneId: string,
  recordPaneGone = false,
): void {
  const record = list.agents.find((agent) => agent.name === identity.actor.name);
  if (record === undefined || record.task !== identity.actor.scope || record.parent !== identity.parent) {
    throw new TauError(
      "permission_denied",
      `The task list has no sub-agent @${identity.actor.name} for task ${identity.actor.scope} with parent @${identity.parent}.`,
    );
  }
  if (record.pane !== paneId && (record.session !== undefined || !recordPaneGone)) {
    throw new TauError(
      "permission_denied",
      `The sub-agent @${identity.actor.name} must run in pane ${record.pane ?? "(none)"}, not in pane ${paneId}.`,
    );
  }
  if (record.state === "ended") {
    throw new TauError("invalid_state", `The sub-agent @${identity.actor.name} ended already.`);
  }
  const task = findTask(list, identity.actor.scope);
  if (task?.status !== "in_progress" || task.owner !== identity.actor.name) {
    throw new TauError(
      "invalid_state",
      `Task ${identity.actor.scope} is not in progress with @${identity.actor.name} as owner.`,
    );
  }
}
