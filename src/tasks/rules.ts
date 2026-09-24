/**
 * The rules of the task list. Each function checks the rules, then changes
 * the list with `applyEvent`. When a rule fails, the function throws a
 * `TauError` and does not change the list.
 *
 * See the "Task lifecycle" and "Sub-tasks" sections of the README.
 */

import { TauError } from "./errors.ts";
import {
  activeTask,
  addTask,
  ancestorIds,
  childrenOf,
  DEFAULT_TASK_TYPES,
  descendantsOf,
  findTask,
  getTask,
  isClosed,
  isDescendant,
  isInSubtree,
  isTaskId,
  MAX_NOTES,
  MAX_TASKS,
  nextTaskId,
  openDependencies,
  recordEvent,
  type Task,
  type TaskChanges,
  type TaskList,
} from "./model.ts";

/** The maximum length of a title, in characters. */
export const MAX_TITLE_LENGTH = 120;
/** The maximum length of a description, result, reason, or note. */
export const MAX_TEXT_LENGTH = 20_000;
export { MAX_EVENTS, MAX_HISTORY, MAX_NOTES, MAX_TASKS } from "./model.ts";

/** The agent that does a change, and the part of the list it can change. */
export interface Actor {
  /** The agent name. For example `lead` or `tau-t2-1`. */
  readonly name: string;
  /**
   * The task that the agent received from its parent. The agent can change
   * only this task and its sub-tasks. `undefined` for the lead agent, which
   * can change all tasks.
   */
  readonly scope?: string;
}

export interface RuleContext {
  readonly actor: Actor;
  /** The time of the change, as an ISO 8601 text. */
  readonly now: string;
  /** The task types that are valid. The default is `DEFAULT_TASK_TYPES`. */
  readonly taskTypes?: readonly string[];
}

export interface CreateInput {
  readonly title: string;
  readonly type: string;
  readonly description?: string;
  readonly parent?: string;
  readonly dependencies?: readonly string[];
}

export function createTask(list: TaskList, ctx: RuleContext, input: CreateInput): Task {
  const title = checkTitle(input.title);
  const type = checkType(ctx, input.type);
  const description = checkOptionalText("description", input.description);

  if (input.parent === undefined) {
    if (ctx.actor.scope !== undefined) {
      throw new TauError(
        "permission_denied",
        `You can create tasks only under your task ${ctx.actor.scope}. Set parent to ${ctx.actor.scope} or to one of its sub-tasks.`,
      );
    }
  } else {
    const parent = getTask(list, checkId(input.parent));
    checkScope(ctx, parent.id);
    if (parent.status === "in_progress") {
      if (parent.owner !== ctx.actor.name) {
        throw new TauError(
          "permission_denied",
          `Task ${parent.id} is in progress and @${parent.owner} owns it. Only the owner can add sub-tasks to it.`,
        );
      }
    } else if (parent.status !== "waiting") {
      throw new TauError(
        "invalid_state",
        `Task ${parent.id} is ${parent.status}. You cannot add sub-tasks to a closed task.`,
      );
    }
  }

  if (list.tasks.length >= MAX_TASKS) {
    throw new TauError(
      "invalid_state",
      `The task list has ${list.tasks.length} tasks. The maximum is ${MAX_TASKS}. Cancel or combine tasks.`,
    );
  }
  const id = nextTaskId(list, input.parent);
  const dependencies = checkDependencies(list, id, input.dependencies ?? []);
  return addTask(list, id, {
    kind: "created",
    at: ctx.now,
    actor: ctx.actor.name,
    title,
    type,
    ...(description === undefined ? {} : { description }),
    dependencies,
  });
}

export function updateTask(list: TaskList, ctx: RuleContext, id: string, changes: TaskChanges): Task {
  const task = getTask(list, checkId(id));
  checkScope(ctx, task.id);
  if (task.status === "in_progress") {
    checkOwner(ctx, task, "change");
  } else if (task.status !== "waiting") {
    throw new TauError("invalid_state", `Task ${task.id} is ${task.status}. You cannot change a closed task.`);
  }

  const checked: {
    title?: string;
    type?: string;
    description?: string;
    dependencies?: readonly string[];
  } = {};
  if (changes.title !== undefined && changes.title !== task.title) {
    checked.title = checkTitle(changes.title);
  }
  if (changes.type !== undefined && changes.type !== task.type) {
    checked.type = checkType(ctx, changes.type);
  }
  if (changes.description !== undefined && changes.description !== (task.description ?? "")) {
    checked.description = checkText("description", changes.description, { allowEmpty: true });
  }
  if (changes.dependencies !== undefined && !sameItems(changes.dependencies, task.dependencies)) {
    if (task.status !== "waiting") {
      throw new TauError(
        "invalid_state",
        `Task ${task.id} is ${task.status}. You can change dependencies only while a task is waiting.`,
      );
    }
    checked.dependencies = checkDependencies(list, task.id, changes.dependencies);
  }
  if (Object.keys(checked).length === 0) {
    throw new TauError("invalid_argument", `The changes do not change task ${task.id}.`);
  }
  recordEvent(list, task, { kind: "updated", at: ctx.now, actor: ctx.actor.name, changes: checked });
  return task;
}

export function claimTask(list: TaskList, ctx: RuleContext, id: string): Task {
  const task = getTask(list, checkId(id));
  checkScope(ctx, task.id);

  if (task.status === "in_progress") {
    throw new TauError("invalid_state", `Task ${task.id} is already in progress. @${task.owner} owns it.`);
  }
  if (task.status === "failed" && task.retryable !== true) {
    throw new TauError(
      "invalid_state",
      `Task ${task.id} failed and is not retryable. Create a new task if the work is still necessary.`,
    );
  }
  if (task.status !== "waiting" && task.status !== "failed") {
    throw new TauError("invalid_state", `Task ${task.id} is ${task.status}. You cannot claim it.`);
  }

  const closedAncestor = ancestorIds(task.id)
    .map((ancestor) => getTask(list, ancestor))
    .find((ancestor) => isClosed(ancestor));
  if (closedAncestor !== undefined) {
    throw new TauError(
      "invalid_state",
      `The parent task ${closedAncestor.id} is ${closedAncestor.status}. You cannot claim a sub-task of a closed task.`,
    );
  }

  const open = openDependencies(list, task);
  if (open.length > 0) {
    throw new TauError(
      "dependencies_not_complete",
      `Task ${task.id} waits for ${open.join(", ")}. Use tau_wait to wait for ${open.length === 1 ? "it" : "them"}.`,
    );
  }

  const active = activeTask(list, ctx.actor.name);
  if (active !== undefined && !isDescendant(task.id, active.id)) {
    throw new TauError(
      "busy",
      `You work on task ${active.id}. You can claim only a sub-task of ${active.id}. Close ${active.id} first to claim a different task.`,
    );
  }

  recordEvent(list, task, { kind: "claimed", at: ctx.now, actor: ctx.actor.name });
  return task;
}

export function completeTask(list: TaskList, ctx: RuleContext, id: string, result: string): Task {
  const text = checkText("result", result);
  const task = checkClose(list, ctx, id);
  recordEvent(list, task, { kind: "completed", at: ctx.now, actor: ctx.actor.name, result: text });
  return task;
}

export function failTask(
  list: TaskList,
  ctx: RuleContext,
  id: string,
  result: string,
  retryable: boolean,
): Task {
  const text = checkText("result", result);
  const task = checkClose(list, ctx, id);
  recordEvent(list, task, { kind: "failed", at: ctx.now, actor: ctx.actor.name, result: text, retryable });
  return task;
}

/**
 * Cancels a waiting task and all its waiting sub-tasks. Returns the canceled
 * tasks, the given task first.
 */
export function cancelTask(list: TaskList, ctx: RuleContext, id: string, reason: string): Task[] {
  const task = getTask(list, checkId(id));
  checkScope(ctx, task.id);
  const text = checkText("reason", reason);
  if (task.status !== "waiting") {
    throw new TauError("invalid_state", `Task ${task.id} is ${task.status}. You can cancel only a waiting task.`);
  }
  const descendants = descendantsOf(list, task.id);
  const running = descendants.filter((child) => child.status === "in_progress");
  if (running.length > 0) {
    throw new TauError(
      "invalid_state",
      `Sub-tasks of ${task.id} are in progress: ${running.map((child) => child.id).join(", ")}. Wait until they are closed, then cancel ${task.id}.`,
    );
  }

  const canceled = [task, ...descendants.filter((child) => child.status === "waiting")];
  for (const item of canceled) {
    recordEvent(list, item, {
      kind: "canceled",
      at: ctx.now,
      actor: ctx.actor.name,
      reason: item === task ? text : `Parent task ${task.id} was canceled: ${text}`,
    });
  }
  return canceled;
}

/** Adds a note to a task. All agents can add notes to all tasks. */
export function addNote(list: TaskList, ctx: RuleContext, id: string, text: string): Task {
  const task = getTask(list, checkId(id));
  if (task.notes.length >= MAX_NOTES) {
    throw new TauError("invalid_state", `Task ${task.id} has ${MAX_NOTES} notes. This is the maximum.`);
  }
  recordEvent(list, task, { kind: "noted", at: ctx.now, actor: ctx.actor.name, text: checkText("note", text) });
  return task;
}

/**
 * Fails each `in_progress` task that `agent` owns, because the agent does not
 * exist anymore. The tasks are retryable.
 *
 * A task can close only when all its sub-tasks are closed (rule 7). If a
 * sub-task is in progress and a different agent owns it (a sub-agent of the
 * stopped agent), the task stays in progress and is in `blocked`. The caller
 * must first stop or fail those sub-agents, then call this function again.
 *
 * `ctx.actor` is the agent or process that found the problem (for example
 * `tau`). This function does not check its scope. Call it only from a trusted
 * controller, never with agent names from tool arguments.
 */
export function failTasksOfAgent(
  list: TaskList,
  ctx: RuleContext,
  agent: string,
  reason: string,
): { failed: Task[]; blocked: Task[] } {
  const result = checkText("reason", reason);
  // Fail the deepest tasks first: a parent can close only after its sub-tasks.
  const owned = list.tasks
    .filter((task) => task.status === "in_progress" && task.owner === agent)
    .sort((a, b) => b.id.split(".").length - a.id.split(".").length);
  const failed: Task[] = [];
  const blocked: Task[] = [];
  for (const task of owned) {
    if (childrenOf(list, task.id).some((child) => !isClosed(child))) {
      blocked.push(task);
      continue;
    }
    recordEvent(list, task, { kind: "failed", at: ctx.now, actor: ctx.actor.name, result, retryable: true });
    failed.push(task);
  }
  return { failed, blocked };
}

/**
 * The tasks that an agent with no active task can claim now: waiting or
 * retryable tasks, with all dependencies complete and no closed ancestor.
 */
export function readyTasks(list: TaskList, scope?: string): Task[] {
  return list.tasks.filter((task) => {
    if (scope !== undefined && !isInSubtree(task.id, scope)) return false;
    const claimable = task.status === "waiting" || (task.status === "failed" && task.retryable === true);
    if (!claimable) return false;
    if (openDependencies(list, task).length > 0) return false;
    return ancestorIds(task.id).every((ancestor) => !isClosed(getTask(list, ancestor)));
  });
}

// ---------------------------------------------------------------------------
// Checks

function checkClose(list: TaskList, ctx: RuleContext, id: string): Task {
  const task = getTask(list, checkId(id));
  if (task.status !== "in_progress") {
    throw new TauError("invalid_state", `Task ${task.id} is ${task.status}. You can close only a task in progress.`);
  }
  checkOwner(ctx, task, "close");
  const open = childrenOf(list, task.id).filter((child) => !isClosed(child));
  if (open.length > 0) {
    throw new TauError(
      "invalid_state",
      `Sub-tasks of ${task.id} are not closed: ${open.map((child) => `${child.id} (${child.status})`).join(", ")}. Close or cancel them first.`,
    );
  }
  return task;
}

function checkOwner(ctx: RuleContext, task: Task, action: string): void {
  if (task.owner !== ctx.actor.name) {
    throw new TauError(
      "permission_denied",
      `@${task.owner} owns task ${task.id}. Only the owner can ${action} it.`,
    );
  }
}

function checkScope(ctx: RuleContext, id: string): void {
  const scope = ctx.actor.scope;
  if (scope !== undefined && !isInSubtree(id, scope)) {
    throw new TauError(
      "permission_denied",
      `You can change only your task ${scope} and its sub-tasks. Task ${id} is not one of them. Send a message to your parent agent if ${id} must change.`,
    );
  }
}

function checkId(id: string): string {
  if (!isTaskId(id)) {
    throw new TauError("invalid_argument", `${JSON.stringify(id)} is not a task ID. Task IDs look like T0, T2, or T2.1.`);
  }
  return id;
}

function checkTitle(title: string): string {
  const text = title.trim();
  if (text === "") {
    throw new TauError("invalid_argument", "The title is empty. Give a short title that tells what the task does.");
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(text)) {
    throw new TauError(
      "invalid_argument",
      "The title must be one line of text, without control characters. Put details in the description.",
    );
  }
  if (text.length > MAX_TITLE_LENGTH) {
    throw new TauError(
      "invalid_argument",
      `The title has ${text.length} characters. The maximum is ${MAX_TITLE_LENGTH}. Put details in the description.`,
    );
  }
  return text;
}

function checkType(ctx: RuleContext, type: string): string {
  const types = ctx.taskTypes ?? DEFAULT_TASK_TYPES;
  if (!types.includes(type)) {
    throw new TauError("invalid_argument", `${JSON.stringify(type)} is not a task type. Use one of: ${types.join(", ")}.`);
  }
  return type;
}

function checkText(name: string, value: string, options: { allowEmpty?: boolean } = {}): string {
  const text = value.trim();
  if (text === "" && options.allowEmpty !== true) {
    throw new TauError("invalid_argument", `The ${name} is empty.`);
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new TauError(
      "invalid_argument",
      `The ${name} has ${text.length} characters. The maximum is ${MAX_TEXT_LENGTH}.`,
    );
  }
  return text;
}

function checkOptionalText(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = checkText(name, value, { allowEmpty: true });
  return text === "" ? undefined : text;
}

/**
 * Checks the dependencies of task `id`. A task cannot depend on itself, on
 * its ancestors, or on a task that waits for it. See `findCycle`.
 */
function checkDependencies(list: TaskList, id: string, dependencies: readonly string[]): string[] {
  const unique = [...new Set(dependencies)];
  const ancestors = new Set(ancestorIds(id));
  for (const dependency of unique) {
    checkId(dependency);
    if (dependency === id) {
      throw new TauError("invalid_argument", `Task ${id} cannot depend on itself.`);
    }
    if (ancestors.has(dependency)) {
      throw new TauError(
        "invalid_argument",
        `Task ${id} cannot depend on ${dependency}, because ${dependency} is its parent task. A parent closes only after its sub-tasks.`,
      );
    }
    if (findTask(list, dependency) === undefined) {
      throw new TauError("not_found", `Task ${dependency} does not exist. Create it before you add it as a dependency.`);
    }
  }
  const cycle = findCycle(list, id, unique);
  if (cycle !== undefined) {
    throw new TauError(
      "invalid_argument",
      `These dependencies make a cycle, so no task in it can start: ${cycle.join(" → ")}. Remove one dependency.`,
    );
  }
  return unique;
}

/**
 * Finds a cycle that the new dependencies of task `id` make. Returns the
 * cycle, or `undefined` when there is no cycle.
 *
 * A task "waits for" these tasks:
 * - its dependencies (it can start only after they complete), and
 * - its sub-tasks (it can close only after they close).
 *
 * The ancestors of `id` wait for `id`, through their sub-tasks. So there is
 * a cycle when a new dependency waits for `id` or for an ancestor of `id`.
 */
function findCycle(list: TaskList, id: string, dependencies: readonly string[]): string[] | undefined {
  const targets = new Set([id, ...ancestorIds(id)]);
  const visited = new Set<string>();
  const visit = (current: string, path: readonly string[]): string[] | undefined => {
    if (targets.has(current)) return [...path, current];
    if (visited.has(current)) return undefined;
    visited.add(current);
    const task = findTask(list, current);
    const next = [...(task?.dependencies ?? []), ...childrenOf(list, current).map((child) => child.id)];
    for (const item of next) {
      const found = visit(item, [...path, current]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (const dependency of dependencies) {
    const found = visit(dependency, [id]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function sameItems(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}
