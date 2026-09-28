/**
 * The data model of a tau task list.
 *
 * Each change to a task is an event in the `history` of the task. The fields
 * of a task are always the result of its events, in order: `applyEvent` is
 * the only function that changes a task. This lets `rollback` make the task
 * list again as it was at an earlier revision (for a session fork).
 *
 * The task list has a `revision` number. Each event increments it, and keeps
 * the new value in `seq`. Thus the events of all tasks have one order, also
 * when they have the same time, or come from processes with different clocks.
 */

import { TauError } from "./errors.ts";

export type TaskStatus = "waiting" | "in_progress" | "completed" | "failed" | "canceled";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "waiting",
  "in_progress",
  "completed",
  "failed",
  "canceled",
];

/** A task with one of these statuses is closed. */
export const CLOSED_STATUSES: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "canceled"]);

/** The task types that tau uses when the configuration does not set them. */
export const DEFAULT_TASK_TYPES: readonly string[] = ["plan", "research", "code", "test", "review", "docs"];

/** The maximum number of tasks in a task list. */
export const MAX_TASKS = 500;
/** The maximum number of notes on one task. */
export const MAX_NOTES = 100;
/**
 * The maximum number of events in the history of one task, except events
 * that close the task (`completed`, `failed`, `canceled`). tau always accepts
 * a close, so that a task at the limit does not block its parent and its
 * dependents.
 */
export const MAX_EVENTS = 1_000;

/**
 * The maximum length of a history in a file. Each close follows a claim, or
 * is the only cancel of a waiting task, so a history has at most
 * `MAX_EVENTS` other events and `MAX_EVENTS + 1` closes.
 */
export const MAX_HISTORY = 2 * MAX_EVENTS + 1;

/** The name of the actor for changes that tau does, not an agent. */
export const SYSTEM_ACTOR = "tau";

export interface Note {
  readonly author: string;
  readonly at: string;
  readonly text: string;
}

/** The fields that an `updated` event can change. */
export interface TaskChanges {
  readonly title?: string;
  readonly type?: string;
  readonly description?: string;
  readonly dependencies?: readonly string[];
}

interface EventBase {
  /** The revision of the task list that this event made. */
  readonly seq: number;
  /** The time of the event, as an ISO 8601 text in UTC. */
  readonly at: string;
  /** The agent that did the change, or `tau`. */
  readonly actor: string;
}

export type TaskEvent =
  | (EventBase & {
      readonly kind: "created";
      readonly title: string;
      readonly type: string;
      readonly description?: string;
      readonly dependencies: readonly string[];
    })
  | (EventBase & { readonly kind: "updated"; readonly changes: TaskChanges })
  | (EventBase & { readonly kind: "claimed" })
  | (EventBase & { readonly kind: "completed"; readonly result: string })
  | (EventBase & { readonly kind: "failed"; readonly result: string; readonly retryable: boolean })
  | (EventBase & { readonly kind: "canceled"; readonly reason: string })
  | (EventBase & { readonly kind: "noted"; readonly text: string });

/** An event before `recordEvent` gives it its `seq`. */
export type NewTaskEvent = TaskEvent extends infer E ? (E extends TaskEvent ? Omit<E, "seq"> : never) : never;

export interface Task {
  readonly id: string;
  title: string;
  type: string;
  description?: string;
  dependencies: string[];
  status: TaskStatus;
  owner?: string;
  result?: string;
  retryable?: boolean;
  notes: Note[];
  history: TaskEvent[];
}

/** The name of the lead agent of each task list. */
export const LEAD_AGENT = "lead";

/** The state of a sub-agent. */
export type AgentState = "starting" | "running" | "ended";

/**
 * A sub-agent that an agent started with `tau_delegate`. The record lets the
 * parent agent watch its sub-agents (liveness), and close their panes.
 */
export interface AgentRecord {
  /** The herdr agent name. For example `tau-t2-1`. */
  readonly name: string;
  /** The agent that started this sub-agent. */
  readonly parent: string;
  /** The task that the sub-agent received. */
  readonly task: string;
  /** The herdr pane of the sub-agent. Not set before the pane exists. */
  pane?: string;
  /**
   * The pi session of the sub-agent (its session file, or its ID). The
   * sub-agent records it when it starts. The parent uses it to know the
   * sub-agent in herdr, also after a pane move.
   */
  session?: string;
  state: AgentState;
  readonly startedAt: string;
  endedAt?: string;
  /**
   * The kind of error when the last run of the sub-agent ended with an
   * error (for example `timeout`): the sub-agent waits for a message. tau
   * makes this text (see `errorKind` in `index.ts`). The sub-agent removes it
   * at its next turn.
   */
  error?: string;
}

/** The maximum number of characters of `AgentRecord.error`. */
export const MAX_AGENT_ERROR_CHARS = 200;

/**
 * The kinds of model provider errors (see `errorKind`). tau puts only these
 * in model-facing text: the raw error text comes from outside.
 */
const ERROR_KINDS = [
  "rate limit",
  "authentication or permission error",
  "not found (for example, the model does not exist: delegate with a different model)",
  "timeout",
  "connection error",
  "provider error",
  "other error",
] as const;

/**
 * The kind of a model provider error, for the parent. The raw error text
 * comes from outside (the provider): it can have instructions, request IDs,
 * or tokens, so the parent gets only one of `ERROR_KINDS`, with the HTTP
 * status when the text has one (the pane of the sub-agent shows the raw
 * error).
 */
export function errorKind(error: string): string {
  const status = /\b([45]\d\d)\b/u.exec(error)?.[1];
  const withStatus = (kind: (typeof ERROR_KINDS)[number]) => (status === undefined ? kind : `${kind} (HTTP ${status})`);
  if (status === "429" || /rate.?limit/iu.test(error)) return withStatus("rate limit");
  if (status === "401" || status === "403" || /unauthori[sz]ed|forbidden|api key|credential/iu.test(error)) {
    return withStatus("authentication or permission error");
  }
  if (status === "404" || /not.?found/iu.test(error)) {
    return withStatus("not found (for example, the model does not exist: delegate with a different model)");
  }
  if (/timed? ?out/iu.test(error)) return withStatus("timeout");
  if (/connection|network|econn|fetch failed|socket/iu.test(error)) return withStatus("connection error");
  if (status?.startsWith("5") === true || /overloaded|unavailable/iu.test(error)) return withStatus("provider error");
  return withStatus("other error");
}

/** True when `text` is a value that `errorKind` gives. */
export function isErrorKind(text: string): boolean {
  const match = /^(.*?)(?: \(HTTP [45]\d\d\))?$/u.exec(text);
  return match !== null && (ERROR_KINDS as readonly string[]).includes(match[1]!);
}

/**
 * The kind of error when the owner of an in-progress task stopped after an
 * error and waits for a message (see `AgentRecord.error`), else `undefined`.
 * The record is in a shared database: a text that `errorKind` does not give
 * shows as "other error", so that the text in model-facing messages is
 * always tau text.
 */
export function ownerError(list: TaskList, task: Task): string | undefined {
  if (task.status !== "in_progress" || task.owner === undefined) return undefined;
  const record = list.agents.find((agent) => agent.name === task.owner);
  if (record === undefined || record.state === "ended" || record.error === undefined) return undefined;
  return isErrorKind(record.error) ? record.error : "other error";
}

/** The maximum number of agent records in a task list. */
export const MAX_AGENTS = 1_000;

export interface TaskList {
  /** The version of the file format. */
  readonly version: 1;
  /** The pi session ID of the lead agent. */
  readonly sessionId: string;
  /**
   * The transcript (the pi session file) of the lead session: a path, or
   * `null` when the session has no file (`--no-session`). Lists from before
   * this field do not have it. See `gc.ts`.
   */
  sessionFile?: string | null;
  readonly createdAt: string;
  /** The number of events in the task list. See `recordEvent`. */
  revision: number;
  /** All tasks, in the order of creation. Tasks are never removed. */
  tasks: Task[];
  /**
   * The sub-agents, in the order of start. These records are not part of the
   * task history: a rollback keeps them.
   */
  agents: AgentRecord[];
}

// ---------------------------------------------------------------------------
// Task IDs

const TASK_ID = /^T(0|[1-9]\d*)(\.[1-9]\d*)*$/;

export function isTaskId(value: string): boolean {
  return TASK_ID.test(value);
}

/** The ID of the parent task, or `undefined` for a root task. */
export function parentId(id: string): string | undefined {
  const dot = id.lastIndexOf(".");
  return dot < 0 ? undefined : id.slice(0, dot);
}

/** The IDs of all ancestors of a task, from the parent to the root. */
export function ancestorIds(id: string): string[] {
  const result: string[] = [];
  for (let current = parentId(id); current !== undefined; current = parentId(current)) {
    result.push(current);
  }
  return result;
}

/** True when `id` is a sub-task of `ancestor`, at any depth. */
export function isDescendant(id: string, ancestor: string): boolean {
  return id.startsWith(`${ancestor}.`);
}

/** True when `id` is `root`, or a sub-task of `root` at any depth. */
export function isInSubtree(id: string, root: string): boolean {
  return id === root || isDescendant(id, root);
}

/**
 * The ID for a new task. Root tasks start at `T0`. The sub-tasks of each
 * parent start at 1: the first sub-task of `T2` is `T2.1`.
 */
export function nextTaskId(list: TaskList, parent: string | undefined): string {
  const siblings = list.tasks.filter((task) => parentId(task.id) === parent).length;
  return parent === undefined ? `T${siblings}` : `${parent}.${siblings + 1}`;
}

// ---------------------------------------------------------------------------
// Queries

export function findTask(list: TaskList, id: string): Task | undefined {
  return list.tasks.find((task) => task.id === id);
}

export function getTask(list: TaskList, id: string): Task {
  const task = findTask(list, id);
  if (task === undefined) {
    throw new TauError("not_found", `Task ${id} does not exist. Use tau_list to see the tasks.`);
  }
  return task;
}

export function childrenOf(list: TaskList, id: string): Task[] {
  return list.tasks.filter((task) => parentId(task.id) === id);
}

export function descendantsOf(list: TaskList, id: string): Task[] {
  return list.tasks.filter((task) => isDescendant(task.id, id));
}

export function isClosed(task: Task): boolean {
  return CLOSED_STATUSES.has(task.status);
}

/**
 * The task that an agent works on now: the `in_progress` task of the agent
 * that has no `in_progress` sub-task of the same agent.
 */
export function activeTask(list: TaskList, agent: string): Task | undefined {
  const owned = list.tasks.filter((task) => task.status === "in_progress" && task.owner === agent);
  return owned.find((task) => !owned.some((other) => isDescendant(other.id, task.id)));
}

/** The dependencies of a task that are not `completed`. */
export function openDependencies(list: TaskList, task: Task): string[] {
  return task.dependencies.filter((id) => findTask(list, id)?.status !== "completed");
}

// ---------------------------------------------------------------------------
// Events

/**
 * Changes `task` as `event` tells, and adds `event` to the history. This is
 * the only function that changes the fields of a task. It does not check the
 * rules: the functions in `rules.ts` do that before they make an event.
 */
export function applyEvent(task: Task, event: TaskEvent): void {
  switch (event.kind) {
    case "created":
      task.title = event.title;
      task.type = event.type;
      setOptional(task, "description", event.description);
      task.dependencies = [...event.dependencies];
      task.status = "waiting";
      break;
    case "updated":
      if (event.changes.title !== undefined) task.title = event.changes.title;
      if (event.changes.type !== undefined) task.type = event.changes.type;
      if (event.changes.description !== undefined) {
        setOptional(task, "description", event.changes.description || undefined);
      }
      if (event.changes.dependencies !== undefined) task.dependencies = [...event.changes.dependencies];
      break;
    case "claimed":
      task.status = "in_progress";
      task.owner = event.actor;
      delete task.result;
      delete task.retryable;
      break;
    case "completed":
      task.status = "completed";
      task.result = event.result;
      delete task.retryable;
      break;
    case "failed":
      task.status = "failed";
      task.result = event.result;
      task.retryable = event.retryable;
      break;
    case "canceled":
      task.status = "canceled";
      task.result = event.reason;
      delete task.retryable;
      break;
    case "noted":
      task.notes.push({ author: event.actor, at: event.at, text: event.text });
      break;
  }
  task.history.push(event);
}

/**
 * Gives `event` the next revision of `list`, then applies it to `task`. Use
 * this function for all changes, so that the revision stays correct.
 */
export function recordEvent(list: TaskList, task: Task, event: NewTaskEvent): void {
  const closes = event.kind === "completed" || event.kind === "failed" || event.kind === "canceled";
  if (!closes && task.history.filter((item) => !CLOSED_STATUSES.has(item.kind as TaskStatus)).length >= MAX_EVENTS) {
    throw new TauError(
      "invalid_state",
      `Task ${task.id} has ${MAX_EVENTS} changes. This is the maximum. You can still close it. Create a new task for more work.`,
    );
  }
  list.revision += 1;
  applyEvent(task, { ...event, seq: list.revision } as TaskEvent);
}

/**
 * Makes a new task from its `created` event, and adds it to `list`. The event
 * gets the next revision of `list`.
 */
export function addTask(
  list: TaskList,
  id: string,
  created: Omit<Extract<TaskEvent, { kind: "created" }>, "seq">,
): Task {
  list.revision += 1;
  const task = newTask(id, { ...created, seq: list.revision });
  list.tasks.push(task);
  return task;
}

/** Makes a task from its `created` event. */
function newTask(id: string, created: Extract<TaskEvent, { kind: "created" }>): Task {
  const task: Task = {
    id,
    title: "",
    type: "",
    dependencies: [],
    status: "waiting",
    notes: [],
    history: [],
  };
  applyEvent(task, created);
  return task;
}

/**
 * Makes the task list again as it was at `revision`. Events after `revision`
 * are removed. Tasks that did not exist at `revision` are removed.
 */
export function rollback(list: TaskList, revision: number): TaskList {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TauError("invalid_argument", `The revision ${revision} is not valid.`);
  }
  const tasks = replay(list, revision);
  // Keep only the agents that got their task at or before `revision`.
  const agents = list.agents
    .filter((agent) =>
      list.tasks
        .find((task) => task.id === agent.task)
        ?.history.some((event) => event.kind === "claimed" && event.actor === agent.name && event.seq <= revision),
    )
    .map((agent) => ({ ...agent }));
  return { ...list, revision: Math.min(revision, list.revision), tasks, agents };
}

/** Makes the tasks again from their events, up to and with `revision`. */
export function replay(list: TaskList, revision: number = list.revision): Task[] {
  const tasks: Task[] = [];
  for (const original of list.tasks) {
    const events = original.history.filter((event) => event.seq <= revision);
    const [created, ...rest] = events;
    if (created?.kind !== "created") {
      continue;
    }
    const task = newTask(original.id, created);
    for (const event of rest) {
      applyEvent(task, event);
    }
    tasks.push(task);
  }
  return tasks;
}

/** Makes a new task list with the task `T0 Prepare task list`. */
export function seedTaskList(sessionId: string, now: string): TaskList {
  const list: TaskList = { version: 1, sessionId, createdAt: now, revision: 0, tasks: [], agents: [] };
  addTask(list, "T0", {
        kind: "created",
        at: now,
        actor: SYSTEM_ACTOR,
        title: "Prepare task list",
        type: "plan",
        description: [
          "Read the user prompt. Plan the work, and make the tasks that it needs.",
          "Give each task a short title and the correct type. Add dependencies",
          "between tasks when one task needs the result of a different task.",
        ].join("\n"),
        dependencies: [],
  });
  return list;
}

function setOptional<K extends "description">(task: Task, key: K, value: Task[K]): void {
  if (value === undefined) {
    delete task[key];
  } else {
    task[key] = value;
  }
}
