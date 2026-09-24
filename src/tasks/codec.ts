/**
 * Reads a task list from JSON text, and checks that it has the correct shape.
 * Other processes (sub-agents) write the same file, so tau does not trust
 * its content.
 */

import { isDeepStrictEqual } from "node:util";

import { TauError } from "./errors.ts";
import {
  isTaskId,
  MAX_HISTORY,
  MAX_NOTES,
  MAX_TASKS,
  parentId,
  replay,
  TASK_STATUSES,
  type Note,
  type Task,
  type TaskEvent,
  type TaskList,
} from "./model.ts";

export function encodeTaskList(list: TaskList): string {
  return `${JSON.stringify(list, null, 2)}\n`;
}

export function decodeTaskList(text: string, source: string): TaskList {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw corrupt(source, `it is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  try {
    const list = checkList(value);
    checkConsistency(list);
    return list;
  } catch (error) {
    if (error instanceof ShapeError) {
      throw corrupt(source, error.message);
    }
    throw error;
  }
}

class ShapeError extends Error {}

function corrupt(source: string, detail: string): TauError {
  return new TauError("storage", `The task list file ${source} is not valid: ${detail}. tau does not change it.`);
}

function checkList(value: unknown): TaskList {
  const list = object(value, "the file");
  if (list.version !== 1) {
    throw new ShapeError(`the version is ${JSON.stringify(list.version)}, not 1`);
  }
  const rawTasks = array(list.tasks, "tasks");
  if (rawTasks.length > MAX_TASKS) {
    throw new ShapeError(`it has ${rawTasks.length} tasks, and the maximum is ${MAX_TASKS}`);
  }
  const tasks = rawTasks.map((task, index) => checkTask(task, `tasks[${index}]`));
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) {
      throw new ShapeError(`the task ID ${task.id} is used two times`);
    }
    ids.add(task.id);
  }
  return {
    version: 1,
    sessionId: string(list.sessionId, "sessionId"),
    createdAt: string(list.createdAt, "createdAt"),
    revision: integer(list.revision, "revision"),
    tasks,
  };
}

/**
 * Checks the relations in the list: each parent and dependency exists, the
 * event revisions are unique, and the fields of each task are the result of
 * its events. A process that writes a list with the rules always passes
 * these checks.
 */
function checkConsistency(list: TaskList): void {
  const ids = new Set(list.tasks.map((task) => task.id));
  const seen = new Set<number>();
  for (const task of list.tasks) {
    const parent = parentId(task.id);
    if (parent !== undefined && !ids.has(parent)) {
      throw new ShapeError(`the parent ${parent} of task ${task.id} does not exist`);
    }
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) {
        throw new ShapeError(`the dependency ${dependency} of task ${task.id} does not exist`);
      }
    }
    if (task.history[0]?.kind !== "created") {
      throw new ShapeError(`the history of task ${task.id} does not start with "created"`);
    }
    let previous = 0;
    for (const event of task.history) {
      if (event.seq < 1 || event.seq > list.revision || seen.has(event.seq) || event.seq <= previous) {
        throw new ShapeError(`task ${task.id} has an event with the revision ${event.seq}, which is not valid`);
      }
      seen.add(event.seq);
      previous = event.seq;
    }
  }
  // Each revision from 1 to `revision` belongs to exactly one event.
  if (seen.size !== list.revision) {
    throw new ShapeError(`the revision is ${list.revision}, but the list has ${seen.size} events`);
  }
  if (!isDeepStrictEqual(replay(list), list.tasks)) {
    throw new ShapeError("the fields of the tasks are not the result of their history");
  }
}

function checkTask(value: unknown, where: string): Task {
  const task = object(value, where);
  const id = string(task.id, `${where}.id`);
  if (!isTaskId(id)) {
    throw new ShapeError(`${where}.id ${JSON.stringify(id)} is not a task ID`);
  }
  const status = string(task.status, `${where}.status`);
  if (!(TASK_STATUSES as readonly string[]).includes(status)) {
    throw new ShapeError(`${where}.status ${JSON.stringify(status)} is not a status`);
  }
  const notes = array(task.notes, `${where}.notes`);
  if (notes.length > MAX_NOTES) {
    throw new ShapeError(`${where} has ${notes.length} notes, and the maximum is ${MAX_NOTES}`);
  }
  const history = array(task.history, `${where}.history`);
  if (history.length > MAX_HISTORY) {
    throw new ShapeError(`${where} has ${history.length} events, and the maximum is ${MAX_HISTORY}`);
  }
  const result: Task = {
    id,
    title: string(task.title, `${where}.title`),
    type: string(task.type, `${where}.type`),
    dependencies: array(task.dependencies, `${where}.dependencies`).map((item, index) =>
      string(item, `${where}.dependencies[${index}]`),
    ),
    status: status as Task["status"],
    notes: notes.map((note, index) => checkNote(note, `${where}.notes[${index}]`)),
    history: history.map((event, index) => checkEvent(event, `${where}.history[${index}]`)),
  };
  if (task.description !== undefined) result.description = string(task.description, `${where}.description`);
  if (task.owner !== undefined) result.owner = string(task.owner, `${where}.owner`);
  if (task.result !== undefined) result.result = string(task.result, `${where}.result`);
  if (task.retryable !== undefined) result.retryable = boolean(task.retryable, `${where}.retryable`);
  return result;
}

function checkNote(value: unknown, where: string): Note {
  const note = object(value, where);
  return {
    author: string(note.author, `${where}.author`),
    at: string(note.at, `${where}.at`),
    text: string(note.text, `${where}.text`),
  };
}

function checkEvent(value: unknown, where: string): TaskEvent {
  const event = object(value, where);
  const base = {
    seq: integer(event.seq, `${where}.seq`),
    at: string(event.at, `${where}.at`),
    actor: string(event.actor, `${where}.actor`),
  };
  const kind = string(event.kind, `${where}.kind`);
  switch (kind) {
    case "created":
      return {
        ...base,
        kind,
        title: string(event.title, `${where}.title`),
        type: string(event.type, `${where}.type`),
        ...(event.description === undefined ? {} : { description: string(event.description, `${where}.description`) }),
        dependencies: array(event.dependencies, `${where}.dependencies`).map((item, index) =>
          string(item, `${where}.dependencies[${index}]`),
        ),
      };
    case "updated": {
      const changes = object(event.changes, `${where}.changes`);
      return {
        ...base,
        kind,
        changes: {
          ...(changes.title === undefined ? {} : { title: string(changes.title, `${where}.changes.title`) }),
          ...(changes.type === undefined ? {} : { type: string(changes.type, `${where}.changes.type`) }),
          ...(changes.description === undefined
            ? {}
            : { description: string(changes.description, `${where}.changes.description`) }),
          ...(changes.dependencies === undefined
            ? {}
            : {
                dependencies: array(changes.dependencies, `${where}.changes.dependencies`).map((item, index) =>
                  string(item, `${where}.changes.dependencies[${index}]`),
                ),
              }),
        },
      };
    }
    case "claimed":
      return { ...base, kind };
    case "completed":
      return { ...base, kind, result: string(event.result, `${where}.result`) };
    case "failed":
      return {
        ...base,
        kind,
        result: string(event.result, `${where}.result`),
        retryable: boolean(event.retryable, `${where}.retryable`),
      };
    case "canceled":
      return { ...base, kind, reason: string(event.reason, `${where}.reason`) };
    case "noted":
      return { ...base, kind, text: string(event.text, `${where}.text`) };
    default:
      throw new ShapeError(`${where}.kind ${JSON.stringify(kind)} is not an event kind`);
  }
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ShapeError(`${where} is not an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ShapeError(`${where} is not an array`);
  }
  return value;
}

function string(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw new ShapeError(`${where} is not a string`);
  }
  return value;
}

function integer(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ShapeError(`${where} is not a positive integer`);
  }
  return value;
}

function boolean(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") {
    throw new ShapeError(`${where} is not a boolean`);
  }
  return value;
}
