/**
 * Delegation: start a pi sub-agent in a new herdr pane for a task.
 *
 * 1. Give the task to a new agent name in the task list (`delegateTask`).
 *    The sub-agent owns the task from now.
 * 2. Split the pane of the delegating agent. The new pane gets the identity
 *    of the sub-agent in its environment (see `identity.ts`).
 * 3. Start pi in the new pane with `herdr agent start`, with the model and
 *    the thinking level. herdr knows the new agent by its name.
 * 4. Send the first prompt to the sub-agent.
 *
 * If a step after step 1 fails, the task fails (retryable), the agent record
 * ends, and tau closes the new pane.
 */

import type { HerdrClient } from "./herdr-client.ts";
import { ENV_AGENT_NAME, ENV_PARENT_AGENT, ENV_TASK_ID, ENV_TASKLIST } from "./identity.ts";
import { agentNameFor } from "./names.ts";
import { TauError } from "./tasks/errors.ts";
import type { Task } from "./tasks/model.ts";
import { delegateTask, endAgent, failTasksOfAgent, markAgentRunning, setAgentPane, type Actor } from "./tasks/rules.ts";
import type { TaskListStore } from "./tasks/store.ts";
import { START_GRACE_MS } from "./supervisor.ts";
import { cleanLine } from "./text.ts";

/** The thinking levels of pi. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

export interface DelegationContext {
  readonly store: TaskListStore;
  readonly actor: Actor;
  readonly herdr: HerdrClient;
  /** The herdr pane of the delegating agent. */
  readonly paneId: string;
  readonly cwd: string;
  /** The path of the tau extension, so that the sub-agent loads it too. */
  readonly extensionPath: string;
  readonly now: () => string;
  readonly maxAgents?: number;
  /** tau adds each pane that it makes. The supervisor can close them. */
  readonly createdPanes?: Set<string>;
  /** Asks the supervisor to close a pane later, when a close now fails. */
  readonly closeLater?: (pane: string, agent: string) => void;
}

export interface DelegateRequest {
  readonly id: string;
  /** A pi model, for example `provider/model-id`. */
  readonly model: string;
  readonly thinking: ThinkingLevel;
}

export interface Delegation {
  readonly agent: string;
  readonly task: string;
  readonly pane: string;
}

export function checkModel(model: string): string {
  if (!MODEL.test(model)) {
    throw new TauError(
      "invalid_argument",
      `${JSON.stringify(model)} is not a model ID. Use the form provider/model-id, as the model list shows it.`,
    );
  }
  return model;
}

export function checkThinking(level: string): ThinkingLevel {
  if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
    throw new TauError("invalid_argument", `${JSON.stringify(level)} is not a thinking level. Use one of: ${THINKING_LEVELS.join(", ")}.`);
  }
  return level as ThinkingLevel;
}

export async function delegate(ctx: DelegationContext, request: DelegateRequest): Promise<Delegation> {
  const model = checkModel(request.model);
  const thinking = checkThinking(request.thinking);

  // Names that herdr uses now cannot be used for the new agent.
  const liveNames = new Set((await ctx.herdr.listAgents()).map((agent) => agent.name).filter((name) => name !== undefined));
  const { result: reserved } = await ctx.store.mutate((list) => {
    const taken = new Set([...liveNames, ...list.agents.map((agent) => agent.name)]);
    const agent = agentNameFor(request.id, taken);
    if (agent === undefined) {
      throw new TauError("invalid_state", `tau has no free agent name for task ${request.id}.`);
    }
    const task = delegateTask(list, { actor: ctx.actor, now: ctx.now() }, {
      id: request.id,
      agent,
      ...(ctx.maxAgents === undefined ? {} : { maxAgents: ctx.maxAgents }),
    });
    return { agent, task: task.id, title: task.title };
  });

  let pane: string | undefined;
  try {
    const direction = await ctx.herdr.splitDirection(ctx.paneId);
    pane = await ctx.herdr.splitPane(ctx.paneId, {
      direction,
      cwd: ctx.cwd,
      env: {
        [ENV_TASKLIST]: ctx.store.file,
        [ENV_TASK_ID]: reserved.task,
        [ENV_AGENT_NAME]: reserved.agent,
        [ENV_PARENT_AGENT]: ctx.actor.name,
      },
    });
    const paneId = pane;
    ctx.createdPanes?.add(paneId);
    await ctx.store.mutate((list) => setAgentPane(list, reserved.agent, paneId));
    await ctx.herdr.startPiAgent(reserved.agent, pane, [
      "--model",
      model,
      "--thinking",
      thinking,
      "--extension",
      ctx.extensionPath,
    ]);
    await ctx.store.mutate((list) => markAgentRunning(list, reserved.agent));
    await ctx.herdr.prompt(reserved.agent, firstPrompt(reserved.agent, ctx.actor.name, reserved.task, reserved.title));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const cleaned = await ctx.store
      .mutate((list) => {
        failTasksOfAgent(list, { actor: ctx.actor, now: ctx.now() }, reserved.agent, `The sub-agent did not start: ${reason}`);
        endAgent(list, reserved.agent, ctx.now());
      })
      .then(
        () => true,
        () => false,
      );
    let paneOpen = false;
    if (pane !== undefined) {
      const paneId = pane;
      paneOpen = await ctx.herdr.closePane(paneId).then(
        () => false,
        () => true,
      );
      if (paneOpen) ctx.closeLater?.(paneId, reserved.agent);
    }
    const parts = [`tau could not start a sub-agent for ${reserved.task}: ${reason}`];
    parts.push(
      cleaned
        ? "The task failed, and you can retry it."
        : `tau could not record the failure either. The liveness check fails the task when the sub-agent does not run (at most ${Math.round(START_GRACE_MS / 60_000)} minutes); then you can retry it.`,
    );
    if (paneOpen) parts.push(`The pane ${pane} is still open; tau tries to close it later.`);
    throw new TauError("storage", parts.join(" "));
  }
  return { agent: reserved.agent, task: reserved.task, pane };
}

/** The first prompt of a sub-agent. */
export function firstPrompt(agent: string, parent: string, taskId: string, title: string): string {
  return [
    `You are @${agent}, a tau sub-agent. @${parent} gave you task ${taskId}: ${cleanLine(title)}`,
    `The task is claimed for you. It is your active task.`,
    `1. Read the task with tau_get (id: "${taskId}"). Read the results of the tasks that it depends on.`,
    `2. Do the work. You can change only ${taskId} and its sub-tasks. You can create sub-tasks, and delegate them with tau_delegate.`,
    `3. When the work is done, call tau_complete with a result that tells what you did. If you cannot do the task, call tau_fail with the reason.`,
    `Do not end your turn before ${taskId} is closed.`,
  ].join("\n");
}

/** A short text about a delegation, for the model. */
export function delegationText(delegation: Delegation, task: Task | undefined): string {
  return [
    `Started @${delegation.agent} in pane ${delegation.pane} for ${delegation.task}${task === undefined ? "" : `: ${cleanLine(task.title)}`}.`,
    `@${delegation.agent} owns ${delegation.task} now. Use tau_wait with ids: ["${delegation.task}"] to wait for it.`,
  ].join("\n");
}

