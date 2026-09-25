/**
 * The task tools that the model can call.
 *
 * The agent identity (`Actor`) comes from the state of this process, never
 * from tool arguments. So a model cannot act as a different agent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

import { agentSummary, formatChange, formatList, formatSection, formatTask, TASK_SECTIONS, type TaskSection } from "./format.ts";
import { TauError } from "./tasks/errors.ts";
import { activeTask, getTask, type TaskList } from "./tasks/model.ts";
import {
  addNote,
  cancelTask,
  claimTask,
  completeTask,
  createTask,
  failTask,
  updateTask,
  type Actor,
  type RuleContext,
} from "./tasks/rules.ts";
import type { TaskListStore } from "./tasks/store.ts";
import type { TaskTypeDefinition } from "./tasks/types.ts";

/** The state that the tools use. */
export interface TaskSession {
  readonly store: TaskListStore;
  readonly actor: Actor;
  readonly now: () => string;
  readonly taskTypes: Readonly<Record<string, TaskTypeDefinition>>;
  /** Called after each change of the task list by a tool. */
  readonly onChange?: () => void;
}

interface ToolSpec {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines?: string[];
  readonly parameters: TSchema;
  readonly run: (session: TaskSession, params: Record<string, unknown>) => Promise<string>;
}

const ID = (description: string) => Type.String({ description, pattern: "^T(0|[1-9][0-9]*)(\\.[1-9][0-9]*)*$" });
const OPTIONAL_ID = (description: string) => Type.Optional(ID(description));

function typeDescription(types: Readonly<Record<string, TaskTypeDefinition>>): string {
  const lines = Object.entries(types).map(
    ([name, type]) => `${name}: ${type.description}${type.readOnly ? " (read-only)" : ""}`,
  );
  return `The task type. One of:\n${lines.join("\n")}`;
}

function specs(taskTypes: Readonly<Record<string, TaskTypeDefinition>>): ToolSpec[] {
  return [
    {
      name: "tau_list",
      label: "tau list",
      description:
        "Show the task list, one compact line for each task. By default, completed and canceled tasks are hidden. Use tau_get for all fields of one task.",
      promptSnippet: "Show the task list",
      promptGuidelines: [
        "All work must be for a tau task that you own. Before other tools, claim a task with tau_claim, or create one with tau_create and claim it.",
        "Do only the work that your active task needs. When it is done, close it with tau_complete or tau_fail and a result.",
      ],
      parameters: Type.Object({
        all: Type.Optional(Type.Boolean({ description: "Show completed and canceled tasks too." })),
      }),
      run: async (session, params) => {
        const list = await readList(session);
        return formatList(list, {
          all: params.all === true,
          agent: session.actor.name,
          ...(session.actor.scope === undefined ? {} : { scope: session.actor.scope }),
        });
      },
    },
    {
      name: "tau_get",
      label: "tau get",
      description:
        "Show one task with all its fields: description, result, notes, dependencies, sub-tasks, and history. Long fields are cut, and only recent notes and events show. To read a complete field, set section, and offset for the next pages.",
      promptSnippet: "Show one task with all fields",
      parameters: Type.Object({
        id: ID("The task ID, for example T2 or T2.1."),
        section: Type.Optional(
          Type.String({
            description: `Show only this field, complete, in pages. One of: ${TASK_SECTIONS.join(", ")}.`,
          }),
        ),
        offset: Type.Optional(
          Type.Integer({ minimum: 0, description: "The first character of the page. Use the value that the last page gives." }),
        ),
      }),
      run: async (session, params) => {
        const list = await readList(session);
        const task = getTask(list, String(params.id));
        if (typeof params.section === "string") {
          if (!(TASK_SECTIONS as readonly string[]).includes(params.section)) {
            throw new TauError(
              "invalid_argument",
              `${JSON.stringify(params.section)} is not a section. Use one of: ${TASK_SECTIONS.join(", ")}.`,
            );
          }
          const offset = typeof params.offset === "number" ? params.offset : 0;
          return formatSection(task, params.section as TaskSection, offset);
        }
        return formatTask(list, task);
      },
    },
    {
      name: "tau_create",
      label: "tau create",
      description:
        "Create a task. Give a short title and a type. Set parent to make a sub-task. Set dependencies when the task needs the result of other tasks first.",
      promptSnippet: "Create a task or sub-task",
      parameters: Type.Object({
        title: Type.String({ description: "A short title (one line) that tells what the task does." }),
        type: Type.String({ description: typeDescription(taskTypes) }),
        description: Type.Optional(Type.String({ description: "Details, in Markdown." })),
        parent: OPTIONAL_ID("The parent task, to make a sub-task."),
        dependencies: Type.Optional(
          Type.Array(ID("A task ID."), { description: "The tasks that must complete before this task can start." }),
        ),
      }),
      run: async (session, params) =>
        change(session, (list, ctx) => {
          const task = createTask(list, ctx, {
            title: String(params.title),
            type: String(params.type),
            ...optionalString("description", params.description),
            ...optionalString("parent", params.parent),
            ...(Array.isArray(params.dependencies) ? { dependencies: params.dependencies.map(String) } : {}),
          });
          return formatChange(list, task, "Created", session.actor.name);
        }),
    },
    {
      name: "tau_update",
      label: "tau update",
      description:
        "Change the title, type, description, or dependencies of a task. Only the owner can change a task in progress. The type and the dependencies can change only while the task is waiting. An empty description removes it.",
      promptSnippet: "Change a task",
      parameters: Type.Object({
        id: ID("The task ID."),
        title: Type.Optional(Type.String({ description: "The new title." })),
        type: Type.Optional(Type.String({ description: "The new type." })),
        description: Type.Optional(Type.String({ description: "The new description. Empty removes it." })),
        dependencies: Type.Optional(Type.Array(ID("A task ID."), { description: "The new list of dependencies." })),
      }),
      run: async (session, params) =>
        change(session, (list, ctx) => {
          const task = updateTask(list, ctx, String(params.id), {
            ...optionalString("title", params.title),
            ...optionalString("type", params.type),
            ...optionalString("description", params.description),
            ...(Array.isArray(params.dependencies) ? { dependencies: params.dependencies.map(String) } : {}),
          });
          return formatChange(list, task, "Changed", session.actor.name);
        }),
    },
    {
      name: "tau_claim",
      label: "tau claim",
      description:
        "Claim a task. It becomes your active task, and you can do its work. You can claim a task when its dependencies are complete, and when you have no active task or the task is a sub-task of your active task.",
      promptSnippet: "Claim a task to work on it",
      parameters: Type.Object({ id: ID("The task ID.") }),
      run: async (session, params) =>
        change(session, (list, ctx) => {
          const task = claimTask(list, ctx, String(params.id));
          return `Claimed ${task.id}. It is your active task now.\n\n${formatTask(list, task)}`;
        }),
    },
    {
      name: "tau_complete",
      label: "tau complete",
      description:
        "Close your active task (or the given task that you own) as completed. Give a result that tells what you did and what the other agents must know. All sub-tasks must be closed first.",
      promptSnippet: "Close your task as completed",
      parameters: Type.Object({
        id: OPTIONAL_ID("The task ID. The default is your active task."),
        result: Type.String({ description: "What you did, in Markdown. Other agents read it." }),
      }),
      run: async (session, params) =>
        change(session, (list, ctx) => {
          const task = completeTask(list, ctx, targetId(list, session, params.id), String(params.result));
          return [`Completed ${task.id}.`, ...agentSummary(list, session.actor.name, session.actor.scope)].join("\n");
        }),
    },
    {
      name: "tau_fail",
      label: "tau fail",
      description:
        "Close your active task (or the given task that you own) as failed. Give a result that tells why. Set retryable to true when a different attempt can succeed. Use this also when you cannot do the task: you cannot give a task back.",
      promptSnippet: "Close your task as failed",
      parameters: Type.Object({
        id: OPTIONAL_ID("The task ID. The default is your active task."),
        result: Type.String({ description: "Why the task failed, in Markdown." }),
        retryable: Type.Boolean({ description: "True when a different attempt can succeed." }),
      }),
      run: async (session, params) =>
        change(session, (list, ctx) => {
          const task = failTask(
            list,
            ctx,
            targetId(list, session, params.id),
            String(params.result),
            params.retryable === true,
          );
          return [
            `Failed ${task.id} (${task.retryable === true ? "retryable" : "not retryable"}).`,
            ...agentSummary(list, session.actor.name, session.actor.scope),
          ].join("\n");
        }),
    },
    {
      name: "tau_cancel",
      label: "tau cancel",
      description:
        "Cancel a waiting task that is not necessary anymore, with a reason. Its waiting sub-tasks are canceled too.",
      promptSnippet: "Cancel a waiting task",
      parameters: Type.Object({
        id: ID("The task ID."),
        reason: Type.String({ description: "Why the task is not necessary." }),
      }),
      run: async (session, params) =>
        change(session, (list, ctx) => {
          const canceled = cancelTask(list, ctx, String(params.id), String(params.reason));
          return `Canceled ${canceled.map((task) => task.id).join(", ")}.`;
        }),
    },
    {
      name: "tau_note",
      label: "tau note",
      description:
        "Add a note to a task. Use notes for findings that other agents can need later. A note does not change the task status.",
      promptSnippet: "Add a note to a task",
      parameters: Type.Object({
        task: ID("The task ID."),
        text: Type.String({ description: "The note, in Markdown." }),
      }),
      run: async (session, params) =>
        change(session, (list, ctx) => {
          const task = addNote(list, ctx, String(params.task), String(params.text));
          return `Added note ${task.notes.length} to ${task.id}.`;
        }),
    },
  ];
}

/** The names of all task tools. */
export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set(specs({}).map((spec) => spec.name));

/**
 * The task tool names that a different extension registered before tau. pi
 * uses the first tool with a name, so tau cannot work when this is not
 * empty.
 */
export function conflictingTools(pi: ExtensionAPI): string[] {
  return pi
    .getAllTools()
    .map((tool) => tool.name)
    .filter((name) => TASK_TOOL_NAMES.has(name));
}

/** Registers the task tools. */
export function registerTaskTools(pi: ExtensionAPI, session: TaskSession): void {
  for (const spec of specs(session.taskTypes)) {
    pi.registerTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      promptSnippet: spec.promptSnippet,
      ...(spec.promptGuidelines === undefined ? {} : { promptGuidelines: spec.promptGuidelines }),
      parameters: spec.parameters,
      // Run tool calls one at a time when a batch has a tau tool. Then the
      // work gate checks each call after the tau calls before it changed the
      // task list (for example tau_complete, then bash, in one batch).
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        let text: string;
        try {
          text = await spec.run(session, params as Record<string, unknown>);
        } catch (error) {
          // Throwing makes a failed tool result. Give the model only the
          // message, which tells what to do.
          if (error instanceof TauError) {
            throw new Error(error.message);
          }
          throw error;
        }
        return { content: [{ type: "text", text }], details: undefined };
      },
    });
  }
}

async function readList(session: TaskSession): Promise<TaskList> {
  const list = await session.store.read();
  if (list === undefined) {
    throw new TauError("storage", "The task list does not exist. Restart the pi session.");
  }
  return list;
}

async function change(
  session: TaskSession,
  operation: (list: TaskList, ctx: RuleContext) => string,
): Promise<string> {
  const ctx: RuleContext = {
    actor: session.actor,
    now: session.now(),
    taskTypes: Object.keys(session.taskTypes),
  };
  const { result } = await session.store.mutate((list) => operation(list, ctx));
  session.onChange?.();
  return result;
}

function targetId(list: TaskList, session: TaskSession, id: unknown): string {
  if (typeof id === "string") return id;
  const active = activeTask(list, session.actor.name);
  if (active === undefined) {
    throw new TauError("invalid_state", "You have no active task. Give the task ID.");
  }
  return active.id;
}

function optionalString<K extends string>(key: K, value: unknown): { [P in K]?: string } {
  return typeof value === "string" ? ({ [key]: value } as { [P in K]: string }) : {};
}
