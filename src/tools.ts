/**
 * The task tools that the model can call.
 *
 * The agent identity (`Actor`) comes from the state of this process, never
 * from tool arguments. So a model cannot act as a different agent.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

import { checkModel, checkThinking, delegate, delegationText, THINKING_LEVELS, type DelegationContext } from "./delegate.ts";
import { AGENT_START_TIMEOUT_MS, MAX_AGENT_START_TIMEOUT_MS } from "./herdr-client.ts";
import { agentSummary, descriptionIsWork, formatChange, formatList, formatSection, formatTask, TASK_SECTIONS, type TaskSection } from "./format.ts";
import { TauError } from "./tasks/errors.ts";
import { activeTask, findTask, getTask, isClosed, isTaskId, ownerError, type AgentRecord, type TaskList } from "./tasks/model.ts";
import {
  abortTask,
  acknowledgeTask,
  canRetry,
  addNote,
  cancelTask,
  claimTask,
  completeTask,
  createTask,
  failTask,
  updateTask,
  type Abort,
  type Actor,
  type RuleContext,
} from "./tasks/rules.ts";
import type { TaskListStore } from "./tasks/store.ts";
import type { TaskTypeDefinition } from "./tasks/types.ts";
import { ASK_TOOL } from "./stop.ts";
import { checkMessageText, checkRecipient, messagesText, PRIORITIES, type Priority } from "./messages.ts";
import { MAX_DELIVERY_CHARS, type StoredMessage } from "./tasks/store.ts";
import { cleanLine, cleanText } from "./text.ts";

/** The state that the tools use. */
export interface TaskSession {
  readonly store: TaskListStore;
  readonly actor: Actor;
  readonly now: () => string;
  readonly taskTypes: Readonly<Record<string, TaskTypeDefinition>>;
  /** Called after each change of the task list by a tool. */
  readonly onChange?: () => void;
  /** What `tau_delegate` needs. Without it, `tau_delegate` fails. */
  readonly delegation?: Omit<DelegationContext, "store" | "actor" | "now">;
  /** The model and thinking level of this agent: the default for sub-agents. */
  readonly current?: () => { readonly model?: string; readonly thinking: string };
  /** The time between two reads of `tau_wait`, in milliseconds. */
  readonly waitPollMs?: number;
  /**
   * Stops the processes of aborted agents: closes their panes when it is
   * safe (see `supervisor.ts`). Returns the agents whose panes are not
   * closed: `pending` (tau tries again at the next check) or `kept` (not
   * safe to close). Without it,
   * `tau_abort` fails and changes nothing: the records of aborted agents
   * end, so no liveness check stops them later.
   */
  readonly stopAgents?: (agents: readonly AgentRecord[]) => Promise<readonly UnclosedPane[]>;
  /**
   * The inbox of this agent: `tau_wait` returns when a message arrives. (pi
   * adds the messages to the tool result, see `index.ts`.) Without it,
   * `tau_send` fails.
   */
  readonly inbox?: {
    readonly hasMessages: () => Promise<boolean>;
  };
  /**
   * The configured "ask question" tool of a different extension. When it is
   * set, tau does not register `tau_ask_user` (the last resort), and the
   * work gate never blocks this tool.
   */
  readonly askTool?: string | undefined;
  /** Called when the agent asks the user a question with `tau_ask_user`. */
  readonly onAskUser?: (question: string, ctx: ExtensionContext | undefined) => void;
}


/** A pane of an aborted agent that tau did not close. */
export interface UnclosedPane {
  readonly agent: string;
  readonly pane: string;
  readonly outcome: "pending" | "kept";
}

/** The maximum number of characters of a `tau_ask_user` question. */
export const MAX_QUESTION_LENGTH = 4_000;

/** What a tool call gives to a tool, in addition to its arguments. */
interface CallContext {
  readonly signal: AbortSignal | undefined;
  readonly ctx: ExtensionContext | undefined;
}

interface ToolSpec {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines?: string[];
  readonly parameters: TSchema;
  /** Tell pi to stop after the tool batch (when all tools in the batch agree). */
  readonly terminate?: boolean;
  readonly run: (session: TaskSession, params: Record<string, unknown>, call: CallContext) => Promise<string>;
}

const ID = (description: string) => Type.String({ description, pattern: "^T(0|[1-9][0-9]*)(\\.[1-9][0-9]*)*$" });
const OPTIONAL_ID = (description: string) => Type.Optional(ID(description));

/**
 * A string schema with a fixed list of values, as a flat JSON Schema `enum`.
 * It is the same as `StringEnum` of pi-ai: some providers (Google) do not
 * accept `anyOf` of literals. The model sees the values in the schema, so it
 * does not have to find them in the description.
 */
const StringEnum = (values: readonly string[], description: string) =>
  Type.Unsafe<string>({ type: "string", enum: [...values], description });

function typeDescription(types: Readonly<Record<string, TaskTypeDefinition>>): string {
  const lines = Object.entries(types).map(
    ([name, type]) => `${name}: ${type.description}${type.readOnly ? ` (read-only${type.writableExtensions?.length ? `, except ${type.writableExtensions.join(" ")} files` : ""})` : ""}`,
  );
  return `The task type. One of:\n${lines.join("\n")}`;
}

function specs(taskTypes: Readonly<Record<string, TaskTypeDefinition>>): ToolSpec[] {
  return [
    {
      name: "tau_list",
      label: "tau list",
      description:
        "Show the task list, one compact line for each task. By default, completed, canceled, and acknowledged failed tasks are hidden. Use tau_get for all fields of one task.",
      promptSnippet: "Show the task list",
      promptGuidelines: [
        "All work must be for a tau task that you own. Before other tools, claim a task with tau_claim, or create one with tau_create and claim it.",
        "Do only the work that your active task needs. When it is done, close it with tau_complete or tau_fail and a result.",
        "To retry a failed task (retryable), use tau_delegate or tau_claim with the same task ID. Do not create a new task for a retry. You can first change the failed task with tau_update (for example, better instructions in its description). When you do not retry a failed task, acknowledge it with tau_ack.",
      ],
      parameters: Type.Object({
        all: Type.Optional(Type.Boolean({ description: "Show completed, canceled, and acknowledged tasks too." })),
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
        `Show one task with all its fields: description, result, notes, dependencies, sub-tasks, and history. Long fields are cut, and only recent notes and events show. To read one complete field, set section to one of: ${TASK_SECTIONS.join(", ")}. Other fields are always complete, and have no section. For the next pages, set offset.`,
      promptSnippet: "Show one task with all fields",
      parameters: Type.Object({
        id: ID("The task ID, for example T2 or T2.1."),
        section: Type.Optional(
          StringEnum(TASK_SECTIONS, `Show only this field, complete, in pages. One of: ${TASK_SECTIONS.join(", ")}.`),
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
          return formatSection(task, params.section as TaskSection, offset, descriptionIsWork(list, task, session.actor.name));
        }
        return formatTask(list, task, { viewer: session.actor.name });
      },
    },
    {
      name: "tau_create",
      label: "tau create",
      description:
        "Create a task. Give a short title and a type. Set parent to make a sub-task. Set dependencies when the task needs the result of other tasks first. Do not create a task to retry a failed task that is retryable: retry the failed task itself (tau_delegate or tau_claim with its ID).",
      promptSnippet: "Create a task or sub-task",
      parameters: Type.Object({
        title: Type.String({ description: "A short title (one line) that tells what the task does." }),
        type: StringEnum(Object.keys(taskTypes), typeDescription(taskTypes)),
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
        "Change the title, type, description, or dependencies of a task. Only the owner can change a task in progress. The type and the dependencies can change only while the task is waiting, or failed and retryable. Change a retryable failed task before you retry it, for example to give better instructions. An empty description removes it.",
      promptSnippet: "Change a task",
      parameters: Type.Object({
        id: ID("The task ID."),
        title: Type.Optional(Type.String({ description: "The new title." })),
        type: Type.Optional(
          StringEnum(Object.keys(taskTypes), `The new ${typeDescription(taskTypes).replace(/^The task type/u, "task type")}`),
        ),
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
        "Claim a task. It becomes your active task, and you can do its work. You can claim a task that is waiting, or failed and retryable (a retry), when its dependencies are complete, and when you have no active task or the task is a sub-task of your active task.",
      promptSnippet: "Claim a task to work on it",
      parameters: Type.Object({ id: ID("The task ID.") }),
      run: async (session, params) =>
        change(session, (list, ctx) => {
          const task = claimTask(list, ctx, String(params.id));
          return `Claimed ${task.id}. It is your active task now.\n\n${formatTask(list, task, { viewer: ctx.actor.name })}`;
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
      name: "tau_ack",
      label: "tau ack",
      description:
        "Acknowledge a failed task: you saw the failure, and you do not retry the task now. The task stays failed, and the default views do not show it anymore. A later retry (tau_delegate or tau_claim) is still possible for a retryable task. A sub-agent cannot acknowledge the task that it received: its parent decides.",
      promptSnippet: "Acknowledge a failed task that you do not retry",
      parameters: Type.Object({
        id: ID("The failed task."),
        reason: Type.String({ description: "Why you do not retry the task." }),
      }),
      run: async (session, params) =>
        change(session, (list, ctx) => {
          const task = acknowledgeTask(list, ctx, String(params.id), String(params.reason));
          return `Acknowledged ${task.id}. It stays failed, and the default views do not show it.`;
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

function sendSpec(): ToolSpec {
  return {
    name: "tau_send",
    label: "tau send",
    description: [
      "Send a message to a different agent: a sub-agent that you started (or one of its sub-agents), your parent agent, or a sibling (an agent with the same parent).",
      'Priority "steer": the recipient gets it after its current tool call. Use it to change the work now.',
      'Priority "info": the recipient gets it at its next tau tool call, or at the end of its turn.',
      "A message also stops a tau_wait call of the recipient. Use tau_note for findings that other agents can need later.",
    ].join("\n"),
    promptSnippet: "Send a message to a different agent",
    parameters: Type.Object({
      to: Type.String({ description: 'The agent name, for example "lead" or "tau-t2-1".' }),
      priority: StringEnum(PRIORITIES, 'The priority: "steer" or "info".'),
      text: Type.String({ description: "The message, in Markdown.", minLength: 1 }),
    }),
    run: async (session, params) => {
      if (session.inbox === undefined) {
        throw new TauError("invalid_state", "tau cannot send messages in this session.");
      }
      const to = String(params.to).replace(/^@/u, "");
      const priority = String(params.priority);
      if (!(PRIORITIES as readonly string[]).includes(priority)) {
        throw new TauError("invalid_argument", `${JSON.stringify(priority)} is not a priority. Use "steer" or "info".`);
      }
      const text = checkMessageText(String(params.text));
      let recipientTask: string | undefined;
      const sender = session.actor.name;
      await session.store.sendMessage(
        { sender, recipient: to, priority: priority as Priority, text, sentAt: session.now() },
        (list) => {
          recipientTask = checkRecipient(list, sender, to);
          const senderTask = activeTask(list, sender)?.id;
          checkQuotedSize({ id: 0, sender, recipient: to, priority: priority as Priority, text, sentAt: "", ...(senderTask === undefined ? {} : { senderTask }) });
          return { senderTask };
        },
      );
      session.onChange?.();
      return `Sent to @${to}${recipientTask === undefined ? "" : ` (${recipientTask})`}, priority ${priority}.`;
    },
  };
}

/**
 * One delivery gives at most `MAX_DELIVERY_CHARS` characters, as the model
 * gets them (the header, and quote marks on each line). So a message must fit
 * alone. The size includes the sender task that the header shows.
 */
function checkQuotedSize(message: StoredMessage): void {
  const size = messagesText([message]).length + 2;
  if (size > MAX_DELIVERY_CHARS) {
    throw new TauError(
      "invalid_argument",
      `The message is too long: with its header and quote marks it has ${size} characters, and the maximum is ${MAX_DELIVERY_CHARS}. Make it shorter (for example, use fewer lines), or put the details in a task note.`,
    );
  }
}

function abortSpec(): ToolSpec {
  return {
    name: "tau_abort",
    label: "tau abort",
    description: [
      "Stop the sub-agent that owns a task, and all the sub-agents that it started. Each task that these agents own fails with the result \"aborted by @you: <reason>\", and is retryable. A task with open sub-tasks stays in progress. When its sub-tasks close, tau fails it with the result \"owner agent exited\". tau closes the panes of the stopped agents.",
      "You can abort a sub-agent that you started, or a sub-agent that one of your sub-agents started. Use this when a sub-agent does wrong or unnecessary work. To stop your own task, use tau_fail.",
    ].join("\n"),
    promptSnippet: "Stop a sub-agent and fail its tasks",
    parameters: Type.Object({
      id: ID("A task in progress that a sub-agent owns."),
      reason: Type.String({ description: "Why you stop the sub-agent. The failed tasks show it.", minLength: 1 }),
    }),
    run: async (session, params) => {
      const stopAgents = session.stopAgents;
      if (stopAgents === undefined) {
        throw new TauError("invalid_state", "tau cannot stop sub-agents in this session.");
      }
      const ctx: RuleContext = { actor: session.actor, now: session.now(), taskTypes: Object.keys(session.taskTypes) };
      const { result: abort } = await session.store.mutate((list) => abortTask(list, ctx, String(params.id), String(params.reason)));
      session.onChange?.();
      const pending = await stopAgents(abort.stopped);
      return abortText(String(params.id), abort, pending);
    },
  };
}

/** A short text about an abort, for the model. */
export function abortText(id: string, abort: Abort, unclosed: readonly UnclosedPane[] = []): string {
  const others = abort.stopped.filter((agent) => agent.name !== abort.owner.name);
  const lines = [
    `Aborted ${id}: tau ended @${abort.owner.name}${
      others.length === 0 ? "" : ` and ${others.length} of its sub-agents (${others.map((agent) => `@${agent.name}`).join(", ")})`
    }${unclosed.length === 0 ? `, and closed ${others.length === 0 ? "its pane" : "their panes"}` : ""}.`,
  ];
  if (abort.failed.length > 0) {
    lines.push(`Failed (retryable): ${abort.failed.map((task) => task.id).join(", ")}.`);
  }
  if (abort.blocked.length > 0) {
    lines.push(
      `These tasks stay in progress, because they have open sub-tasks: ${abort.blocked.map((task) => task.id).join(", ")}. When the sub-tasks close (or you cancel them), tau fails these tasks with the result "owner agent exited".`,
    );
  }
  const pending = unclosed.filter((item) => item.outcome === "pending");
  const kept = unclosed.filter((item) => item.outcome === "kept");
  if (pending.length > 0) {
    lines.push(
      `tau could not close the panes of ${pending.map((item) => `@${item.agent}`).join(", ")} yet: these agents can still run. tau tries again at each liveness check.`,
    );
  }
  if (kept.length > 0) {
    lines.push(
      `tau did not close the panes ${kept.map((item) => `${item.pane} (@${item.agent})`).join(", ")}: it cannot prove that the ended agent is in them, and it does not try again. These agents can still run. Tell the user to check these panes.`,
    );
  }
  lines.push(
    "The lead decides if a failed task is tried again. To retry it, use tau_delegate (or tau_claim) with the same task ID: do not create a new task for a retry. To not retry it, acknowledge it with tau_ack.",
  );
  return lines.join("\n");
}

function askSpec(): ToolSpec {
  return {
    name: ASK_TOOL,
    label: "tau ask user",
    description: [
      "Show a question to the user, then end your turn. The next user prompt is the answer.",
      'Use this tool only when no other "ask question" tool is available. Call it alone, not with other tools in the same batch. After the call, end your turn: do not call more tools.',
    ].join("\n"),
    promptSnippet: 'Ask the user a question and end the turn, if no other "ask question" tool is available',
    promptGuidelines: ['Use tau_ask_user only when no other "ask question" tool is available.'],
    parameters: Type.Object({
      question: Type.String({
        description: "The question, in plain text. Tell the options if there are some.",
        minLength: 1,
        maxLength: MAX_QUESTION_LENGTH,
      }),
    }),
    terminate: true,
    run: async (session, params, call) => {
      const question = cleanText(String(params.question)).trim();
      if (question === "") {
        throw new TauError("invalid_argument", "Give a question.");
      }
      if ([...question].length > MAX_QUESTION_LENGTH) {
        throw new TauError("invalid_argument", `The question has more than ${MAX_QUESTION_LENGTH} characters. Make it shorter.`);
      }
      session.onAskUser?.(question, call.ctx);
      return [
        "The user sees this question:",
        ...question.split("\n").map((line) => `| ${line}`),
        "End your turn now. Do not call more tools. The next user prompt is the answer.",
      ].join("\n");
    },
  };
}

function delegationSpecs(): ToolSpec[] {
  return [
    {
      name: "tau_delegate",
      label: "tau delegate",
      description: [
        "Start a pi sub-agent in a new herdr pane, and give it a task. The sub-agent owns the task from the start, and closes it when the work is done. Delegation is the normal way to do work: give each task that can run alone to a sub-agent.",
        "Before you call this tool, select the model and the thinking level for the task type. Use the model routing rules from AGENTS.md or from skills. If no rule applies, omit model and thinking: the sub-agent then uses your model and thinking level.",
        "The task must be ready (dependencies complete) and nobody must own it: it is waiting, or failed and retryable. To retry a failed task, delegate the same task ID again; do not create a new task. At most a small number of sub-agents run at the same time; when the limit is reached, use tau_wait.",
      ].join("\n"),
      promptSnippet: "Start a sub-agent for a task",
      promptGuidelines: [
        "Delegate each task that can run alone to a sub-agent with tau_delegate. Then wait for the sub-agents with tau_wait. Do not poll.",
      ],
      parameters: Type.Object({
        id: ID("The task to give to the sub-agent."),
        model: Type.Optional(Type.String({ description: "The pi model ID, as provider/model-id. The default is your model." })),
        thinking: Type.Optional(
          StringEnum(THINKING_LEVELS, `The thinking level: ${THINKING_LEVELS.join(", ")}. The default is your thinking level.`),
        ),
        start_timeout_seconds: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_AGENT_START_TIMEOUT_MS / 1_000,
            description: `The time for the sub-agent to start, in seconds: pi is ready in the new pane, and it starts to work on its first prompt (the wait for the new shell gets at least 15 seconds, and the wait for the first work at least 10 seconds). The default is ${AGENT_START_TIMEOUT_MS / 1_000}. Use a higher value when a start timed out (for example, the computer is slow).`,
          }),
        ),
      }),
      run: async (session, params) => {
        if (session.delegation === undefined) {
          throw new TauError("invalid_state", "tau cannot start sub-agents in this session.");
        }
        const current = session.current?.() ?? { thinking: "medium" };
        const model = typeof params.model === "string" ? params.model : current.model;
        if (model === undefined) {
          throw new TauError("invalid_argument", "Give a model: tau does not know your model.");
        }
        const thinking = typeof params.thinking === "string" ? params.thinking : current.thinking;
        const seconds = params.start_timeout_seconds;
        if (seconds !== undefined && (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_AGENT_START_TIMEOUT_MS / 1_000)) {
          throw new TauError("invalid_argument", `start_timeout_seconds must be an integer from 1 to ${MAX_AGENT_START_TIMEOUT_MS / 1_000}.`);
        }
        const result = await delegate(
          { ...session.delegation, store: session.store, actor: session.actor, now: session.now },
          {
            id: String(params.id),
            model: checkModel(model),
            thinking: checkThinking(thinking),
            ...(seconds === undefined ? {} : { startTimeoutMs: seconds * 1_000 }),
          },
        );
        session.onChange?.();
        const list = await session.store.read();
        return delegationText(result, list === undefined ? undefined : findTask(list, result.task));
      },
    },
    {
      name: "tau_wait",
      label: "tau wait",
      description:
        "Wait until each task in the list is closed. The call uses no tokens while it waits. It returns at once when one task fails, when the owner of a task stopped after an error, or when a message for you arrives (the result gives the message), so that you can react. Use it to wait for sub-agents, or for tasks of other agents that your work depends on.",
      promptSnippet: "Wait for tasks to close",
      parameters: Type.Object({
        ids: Type.Array(ID("A task ID."), { description: "The tasks to wait for.", minItems: 1 }),
        timeout_seconds: Type.Optional(
          Type.Integer({ minimum: 1, description: "Return after this time, also when tasks are still open." }),
        ),
      }),
      run: async (session, params, call) => {
        const ids = [...new Set((params.ids as unknown[]).map(String))];
        for (const id of ids) {
          if (!isTaskId(id)) throw new TauError("invalid_argument", `${JSON.stringify(id)} is not a task ID.`);
        }
        const timeout = typeof params.timeout_seconds === "number" ? params.timeout_seconds * 1_000 : undefined;
        return waitForTasks(session, ids, { signal: call.signal, ...(timeout === undefined ? {} : { timeoutMs: timeout }) });
      },
    },
  ];
}

/**
 * Waits until all tasks are closed, one task fails, the time ends, or the
 * signal aborts. Returns a summary.
 */
export async function waitForTasks(
  session: TaskSession,
  ids: readonly string[],
  options: { signal?: AbortSignal | undefined; timeoutMs?: number } = {},
): Promise<string> {
  const started = Date.now();
  const deadline = options.timeoutMs === undefined ? undefined : started + options.timeoutMs;
  const poll = session.waitPollMs ?? 1_000;
  for (;;) {
    const list = await readList(session);
    for (const id of ids) getTask(list, id);
    const tasks = ids.map((id) => getTask(list, id));
    const failed = tasks.filter((task) => task.status === "failed");
    // The owner stopped after an error, and waits for a message: the wait
    // would not end (see registerErrorReport in index.ts).
    const stopped = tasks.filter((task) => ownerError(list, task) !== undefined);
    const done = tasks.every((task) => isClosed(task));
    const timedOut = deadline !== undefined && Date.now() >= deadline;
    const aborted = options.signal?.aborted === true;
    // A message for this agent stops the wait. The tool result gives it.
    const message = (await session.inbox?.hasMessages().catch(() => false)) === true;
    if (done || failed.length > 0 || stopped.length > 0 || timedOut || aborted || message) {
      const seconds = Math.round((Date.now() - started) / 1_000);
      const header = done
        ? `All ${tasks.length} tasks are closed (after ${seconds} s).`
        : failed.length > 0
          ? `${failed.map((task) => task.id).join(", ")} failed (after ${seconds} s). Other tasks can still be open.`
          : stopped.length > 0
            ? `${stopped.map((task) => `${task.id} (@${cleanLine(task.owner ?? "")})`).join(", ")}: the owner stopped after an error (after ${seconds} s). For each one: send the owner a message to continue (tau_send), or stop it (tau_abort). Do not call tau_wait for these tasks before that: it returns at once.`
            : aborted
            ? "The wait was stopped."
            : message
              ? `A message arrived (after ${seconds} s). Read it below, then call tau_wait again if necessary.`
              : `The time ended (after ${seconds} s). Some tasks are still open.`;
      const lines = tasks.map((task) => {
        const extra =
          task.status === "failed"
            ? ` (${task.retryable === true ? "retryable" : "not retryable"})`
            : task.status === "in_progress" && task.owner !== undefined
              ? ` (@${task.owner}${ownerError(list, task) === undefined ? "" : `, stopped after an error: ${cleanLine(ownerError(list, task)!)}`})`
              : "";
        return `${task.id}  ${task.status}${extra}  ${cleanTitle(task.title)}`;
      });
      const retry = failed.filter((task) => canRetry(list, task) && task.acknowledged !== true);
      const hint =
        retry.length === 0
          ? []
          : [
              `For ${retry.map((task) => task.id).join(", ")}: read the result with tau_get. To retry a retryable task, use tau_delegate with the same task ID (do not create a new task). To not retry it, use tau_ack.`,
            ];
      return [header, ...lines, "Use tau_get to read the results.", ...hint].join("\n");
    }
    await sleep(poll, options.signal);
  }
}

/** The names of all task tools. */
export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set(
  [...specs({}), ...delegationSpecs(), sendSpec(), abortSpec(), askSpec()].map((spec) => spec.name),
);

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
  // tau_ask_user is the last resort: the model does not see it when the
  // configuration names a different ask tool.
  const ask = session.askTool === undefined ? [askSpec()] : [];
  for (const spec of [...specs(session.taskTypes), ...delegationSpecs(), sendSpec(), abortSpec(), ...ask]) {
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
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        let text: string;
        try {
          text = await spec.run(session, params as Record<string, unknown>, { signal, ctx });
        } catch (error) {
          // Throwing makes a failed tool result. Give the model only the
          // message, which tells what to do.
          if (error instanceof TauError) {
            throw new Error(error.message);
          }
          throw error;
        }
        return {
          content: [{ type: "text", text }],
          details: undefined,
          ...(spec.terminate === true ? { terminate: true } : {}),
        };
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

function cleanTitle(title: string): string {
  return cleanLine(title);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
