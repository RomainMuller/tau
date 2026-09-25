/**
 * The "do not stop" rule.
 *
 * An agent cannot stop while its task list has open work:
 *
 * - The lead cannot stop while a task in the list is `waiting` or
 *   `in_progress`.
 * - A sub-agent cannot stop while its task is `in_progress`.
 *
 * When the agent tries to stop too early, tau adds a continuation message
 * (pi `agent_before_settle` event), and pi sends one more model request.
 * After `maxIdleContinuations` continuations with no change to the task
 * list, tau stops the rule until the next user prompt, and tells the user.
 *
 * The rule does not apply when:
 *
 * - The run ended with an error, or the user stopped it (`outcome` is not
 *   `completed`).
 * - The last turn of the agent had only one tool call, a `tau_ask_user`
 *   call that did not fail: the stop waits for the answer of the user.
 */

import { isAgentName } from "./names.ts";
import { activeTask, isClosed, isDescendant, isInSubtree, LEAD_AGENT, type Task, type TaskList } from "./tasks/model.ts";
import { readyTasks, type Actor } from "./tasks/rules.ts";

/** The default number of continuations with no task change before tau stops the rule. */
export const DEFAULT_MAX_IDLE_CONTINUATIONS = 3;

/** The maximum number of task IDs in one line of the continuation message. */
const MAX_IDS = 10;

/** The custom message type of a continuation message. */
export const CONTINUE_MESSAGE_TYPE = "tau-continue";

/** The name of the tool that asks the user a question (see `tools.ts`). */
export const ASK_TOOL = "tau_ask_user";

/** The name of the system prompt section of tau. */
export const PROMPT_SECTION = "tau";

/**
 * The system prompt section that tells the rule. pi shows sections also
 * with a custom system prompt, but not the tool guidelines.
 */
export function promptSection(actor: Actor, askToolActive: boolean): string {
  const rule =
    actor.scope === undefined
      ? "You are the lead agent. You cannot stop while a task in the tau task list is waiting or in progress."
      : `You are a sub-agent for task ${actor.scope}. You cannot stop while your task ${actor.scope} is in progress.`;
  return [
    rule,
    "If you stop too early, tau tells you to continue.",
    'To get an answer from the user, call an available "ask question" tool. Do not end your turn to ask a question.',
    ...(askToolActive ? ['If no other "ask question" tool is available, call tau_ask_user alone, then end your turn.'] : []),
  ].join("\n");
}

/** The open work of an agent. */
export interface OpenWork {
  /** The tasks that stop the agent from stopping. */
  readonly open: readonly Task[];
  /** Waiting tasks that can start now: claim or delegate them. */
  readonly ready: readonly Task[];
  /** The active task of the agent, if it has one. */
  readonly active: Task | undefined;
  /** In-progress tasks of other agents. Wait for them with `tau_wait`. */
  readonly running: readonly Task[];
  /** Waiting tasks that cannot start now. */
  readonly blocked: readonly Task[];
}

/**
 * The open work of `actor`. For the lead (no scope), all `waiting` and
 * `in_progress` tasks. For a sub-agent, the open tasks in its scope, but only
 * while its scope task is `in_progress`. Returns `undefined` when the agent
 * can stop.
 */
export function openWork(list: TaskList, actor: Actor): OpenWork | undefined {
  const scope = actor.scope;
  if (scope !== undefined) {
    const own = list.tasks.find((task) => task.id === scope);
    if (own === undefined || own.status !== "in_progress") return undefined;
  }
  const open = list.tasks.filter(
    (task) => !isClosed(task) && (scope === undefined || isInSubtree(task.id, scope)),
  );
  if (open.length === 0) return undefined;
  // A failed task is not open work: the lead decides if it retries it.
  const ready = readyTasks(list, scope).filter((task) => task.status === "waiting");
  const readyIds = new Set(ready.map((task) => task.id));
  return {
    open,
    ready,
    active: activeTask(list, actor.name),
    running: open.filter((task) => task.status === "in_progress" && task.owner !== actor.name),
    blocked: open.filter((task) => task.status === "waiting" && !readyIds.has(task.id)),
  };
}

/**
 * The continuation message. For example:
 *
 * ```text
 * ⟳ tau: 4 tasks are open (T2, T3, T2.1, T2.2). Continue the work. Do not stop before the work is done.
 *   Your active task: T2. Do its work, then close it with tau_complete or tau_fail.
 *   Ready now: T3. Delegate it (you can claim it only after your active task closes).
 *   Not ready: T2.1 (@tau-t2-1), T2.2 (waits for T2.1).
 *   Use tau_wait with ids ["T2.1"]. Do not poll.
 * ```
 *
 * The message goes to the model as a user message. So it has only task IDs,
 * statuses, and agent names, which tau makes. It has no text that agents
 * wrote (for example titles), because such text must not look like an
 * instruction of the user.
 */
export function continuationText(list: TaskList, work: OpenWork, actor: Actor, askToolActive = true): string {
  const count = work.open.length;
  const lines: string[] = [];
  const subject =
    actor.scope === undefined
      ? `${count} ${count === 1 ? "task is" : "tasks are"} open (${ids(work.open)})`
      : `your task ${actor.scope} is in progress${count > 1 ? `, with ${count - 1} open ${count === 2 ? "sub-task" : "sub-tasks"}` : ""}`;
  lines.push(`⟳ tau: ${subject}. Continue the work. Do not stop before the work is done.`);
  const active = work.active;
  if (active !== undefined) {
    lines.push(`  Your active task: ${active.id}. Do its work, then close it with tau_complete or tau_fail.`);
  }
  // With an active task, the agent can claim only its sub-tasks (rule 3).
  const claimable = work.ready.filter((task) => active === undefined || isDescendant(task.id, active.id));
  const delegateOnly = work.ready.filter((task) => !claimable.includes(task));
  if (claimable.length > 0) {
    const it = claimable.length === 1 ? "it" : "them";
    lines.push(`  Ready now: ${ids(claimable)}. Claim ${it} or delegate ${it}.`);
  }
  if (delegateOnly.length > 0) {
    const it = delegateOnly.length === 1 ? "it" : "them";
    lines.push(`  Ready now: ${ids(delegateOnly)}. Delegate ${it} (you can claim ${it} only after your active task closes).`);
  }
  const waits = [
    ...work.running.map((task) => `${task.id} (${ownerText(task.owner)})`),
    ...work.blocked.map((task) => `${task.id} (${blockReason(list, task)})`),
  ];
  if (waits.length > 0) {
    const shown = waits.slice(0, MAX_IDS).join(", ");
    const more = waits.length > MAX_IDS ? `, and ${waits.length - MAX_IDS} more` : "";
    lines.push(`  Not ready: ${shown}${more}.`);
    // Only tasks of other agents: a wait for a task of this agent cannot end,
    // because this agent must close it.
    const waitIds = [...work.running, ...work.blocked.flatMap((task) => openDependencyTasks(list, task))]
      .filter((task) => task.status === "in_progress" && task.owner !== actor.name)
      .map((task) => task.id);
    const unique = [...new Set(waitIds)];
    if (unique.length > 0) {
      lines.push(`  Use tau_wait with ids ${JSON.stringify(unique.slice(0, MAX_IDS))}. Do not poll.`);
    }
  }
  if (work.blocked.some((task) => openDependencyTasks(list, task).some((dep) => dep.status === "failed" || dep.status === "canceled"))) {
    lines.push("  Some tasks wait for a failed or canceled task: retry that task, change the dependencies, or cancel the waiting task.");
  }
  lines.push(
    askToolActive
      ? "  If you must have an answer from the user, call an ask question tool (or tau_ask_user if no other one is available). Do not end your turn to ask."
      : "  If you must have an answer from the user, call an ask question tool. Do not end your turn to ask.",
  );
  return lines.join("\n");
}

/**
 * The owner of a task in the message. The task list is shared, so an owner
 * name can be any text (for example, a different program of the same user
 * can write the database). Show only names that tau makes.
 */
function ownerText(owner: string | undefined): string {
  return owner !== undefined && (owner === LEAD_AGENT || isAgentName(owner)) ? `@${owner}` : "in progress";
}

/** Why a waiting task cannot start now. */
function blockReason(list: TaskList, task: Task): string {
  const deps = openDependencyTasks(list, task);
  if (deps.length > 0) {
    return `waits for ${deps
      .map((dep) => (dep.status === "failed" || dep.status === "canceled" ? `${dep.id} ${dep.status}` : dep.id))
      .join(", ")}`;
  }
  return "waits for its parent task";
}

function openDependencyTasks(list: TaskList, task: Task): Task[] {
  return task.dependencies.flatMap((id) => {
    const dep = list.tasks.find((item) => item.id === id);
    return dep !== undefined && dep.status !== "completed" ? [dep] : [];
  });
}

function ids(tasks: readonly Task[]): string {
  const shown = tasks.slice(0, MAX_IDS).map((task) => task.id).join(", ");
  return tasks.length > MAX_IDS ? `${shown}, and ${tasks.length - MAX_IDS} more` : shown;
}

/** What the guard tells pi at the end of a run. */
export type SettleDecision =
  | { readonly kind: "stop" }
  | { readonly kind: "continue"; readonly text: string }
  /** The rule stops until the next user prompt. Tell the user. */
  | { readonly kind: "give_up"; readonly text: string }
  /** The agent stops, because tau cannot check the task list. Tell the user. */
  | { readonly kind: "warn"; readonly text: string };

export interface StopGuardOptions {
  readonly actor: Actor;
  /** Reads the task list. `undefined` when it does not exist. */
  readonly read: () => Promise<TaskList | undefined>;
  readonly maxIdleContinuations?: number;
  /** True when `tau_ask_user` is an active tool. The default is true. */
  readonly askToolActive?: () => boolean;
}

/**
 * The state of the "do not stop" rule for one agent. It is not stored: a
 * restart of pi starts with a new state.
 */
export class StopGuard {
  readonly #actor: Actor;
  readonly #read: () => Promise<TaskList | undefined>;
  readonly #max: number;
  readonly #askToolActive: () => boolean;
  /** The task list revision at the last continuation. */
  #lastRevision: number | undefined;
  /** The number of continuations in sequence after which the task list did not change. */
  #idle = 0;
  /** True after the rule stopped, until the next user prompt. */
  #gaveUp = false;
  /**
   * True when the last turn had only one tool call, and it was a
   * `tau_ask_user` call that did not fail. Cleared at the next stop, the next
   * user message, or the next turn.
   */
  #asked = false;

  constructor(options: StopGuardOptions) {
    this.#actor = options.actor;
    this.#read = options.read;
    this.#max = options.maxIdleContinuations ?? DEFAULT_MAX_IDLE_CONTINUATIONS;
    this.#askToolActive = options.askToolActive ?? (() => true);
  }

  /** A new user message: the rule applies again, from the start. */
  userPrompt(): void {
    this.#lastRevision = undefined;
    this.#idle = 0;
    this.#gaveUp = false;
    this.#asked = false;
  }

  /**
   * A turn ended with these tool results. When the turn had only a
   * `tau_ask_user` call that did not fail, the next stop waits for the user.
   * All other turns (also a turn with no tool call, or with more tool calls
   * in the batch) clear the question: then the rule applies to the next stop.
   */
  turnEnded(toolResults: readonly { readonly toolName: string; readonly isError: boolean }[]): void {
    const only = toolResults.length === 1 ? toolResults[0] : undefined;
    this.#asked = only !== undefined && only.toolName === ASK_TOOL && !only.isError;
  }

  /**
   * A different extension continued the run. The next stop is not the stop
   * for the question, so the rule applies to it.
   */
  continued(): void {
    this.#asked = false;
  }

  /** Decides what to do when the run is about to end. */
  async settle(outcome: string): Promise<SettleDecision> {
    const asked = this.#asked;
    this.#asked = false;
    if (outcome !== "completed" || asked || this.#gaveUp) {
      return { kind: "stop" };
    }
    let list: TaskList | undefined;
    try {
      list = await this.#read();
    } catch {
      // A continuation cannot help here: the agent cannot do work while tau
      // cannot read the task list. Tell the user. The text of the error can
      // contain data from the task list, so the warning does not show it:
      // the work gate shows it at the next tool call.
      return {
        kind: "warn",
        text: "tau: the agent stopped, and tau cannot read the task list to check for open work. Use /tau to see the error.",
      };
    }
    if (list === undefined) {
      return { kind: "warn", text: "tau: the agent stopped, and the task list does not exist. Restart the pi session." };
    }
    const work = openWork(list, this.#actor);
    if (work === undefined) {
      this.#lastRevision = undefined;
      this.#idle = 0;
      return { kind: "stop" };
    }
    if (this.#lastRevision !== undefined && list.revision === this.#lastRevision) {
      this.#idle += 1;
    } else {
      this.#idle = 0;
    }
    if (this.#idle >= this.#max) {
      this.#gaveUp = true;
      return {
        kind: "give_up",
        text: `tau: the agent stopped ${this.#max} times with no change to the task list, and ${work.open.length} ${
          work.open.length === 1 ? "task is" : "tasks are"
        } open (${ids(work.open)}). The "do not stop" rule is off until your next prompt.`,
      };
    }
    this.#lastRevision = list.revision;
    return { kind: "continue", text: continuationText(list, work, this.#actor, this.#askToolActive()) };
  }
}
