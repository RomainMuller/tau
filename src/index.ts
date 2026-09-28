import { fileURLToPath } from "node:url";

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { badgeText, WIDGET_KEY, widgetLines } from "./badge.ts";
import { Inbox } from "./inbox.ts";
import { checkRecipient, MESSAGE_TYPE, messagesText } from "./messages.ts";
import { registerCommands } from "./commands.ts";
import { configFor } from "./config.ts";
import { checkGate } from "./gate.ts";
import { HerdrClient } from "./herdr-client.ts";
import { detectHerdr, type Exec, type HerdrStatus } from "./herdr.ts";
import { checkSubAgent, ENV_TASKLIST, resolveIdentity, type Identity } from "./identity.ts";
import { Supervisor } from "./supervisor.ts";
import { TauError } from "./tasks/errors.ts";
import { seedTaskList, type TaskList } from "./tasks/model.ts";
import { tauDir } from "./tasks/paths.ts";
import { ASK_TOOL, CONTINUE_MESSAGE_TYPE, PROMPT_SECTION, promptSection, StopGuard } from "./stop.ts";
import { setAgentSession, type Actor } from "./tasks/rules.ts";
import { MAX_FILE_BYTES, TaskListStore } from "./tasks/store.ts";
import { conflictingTools, registerTaskTools, TASK_TOOL_NAMES, type TaskSession } from "./tools.ts";
import { cleanLine } from "./text.ts";
import { TreeWidget } from "./widget.ts";
import { forkRevision, forkTaskList, REVISION_ENTRY, sessionIdOf } from "./fork.ts";
import { taskListFile } from "./tasks/paths.ts";
import { encodeTaskList } from "./tasks/codec.ts";

/** Things that tests can replace. */
export interface TauDependencies {
  /** The pi agent directory. The default is `getAgentDir()`. */
  readonly agentDir: () => string;
  /** The current time, as an ISO 8601 text. */
  readonly now: () => string;
  /** The environment (for the sub-agent identity). The default is `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** The time between two liveness checks, in milliseconds. */
  readonly superviseMs?: number;
  /** The time between two polls of the inbox, in milliseconds. */
  readonly inboxMs?: number;
}

const DEFAULT_DEPENDENCIES: TauDependencies = {
  agentDir: getAgentDir,
  now: () => new Date().toISOString(),
};

/** The path of this extension. A sub-agent loads the same file. */
const EXTENSION_PATH = fileURLToPath(import.meta.url);

/**
 * The tau extension.
 *
 * The factory only adds `session_start` and `session_shutdown` handlers. It
 * does not start processes, because pi can load extensions without a session.
 * The herdr check runs in the first `session_start` event of this runtime, and
 * the result stays the same until pi reloads the extension.
 *
 * When herdr is not available, tau shows the badge and does nothing else.
 * On shutdown, tau removes the badge. The TUI does this automatically, but an
 * RPC client keeps a widget until an extension removes it.
 *
 * When herdr is available, tau opens the task list of the session, and makes
 * it with the task `T0` if it does not exist. Then it registers the task
 * tools and the work gate. If the task list cannot be opened, tau shows an
 * error and registers nothing: pi runs in its standard mode.
 */
export default function tau(pi: ExtensionAPI): void {
  createTau(pi, DEFAULT_DEPENDENCIES);
}

/** The state of a tau runtime. Only for tests. */
export interface TauHandle {
  readonly widget: TreeWidget | undefined;
  readonly supervisor: Supervisor | undefined;
  readonly identity: Identity | undefined;
  readonly inbox: Inbox | undefined;
}

export function createTau(pi: ExtensionAPI, deps: TauDependencies): TauHandle {
  const exec: Exec = (command, args, options) => pi.exec(command, args, options);
  let detection: Promise<HerdrStatus> | undefined;
  let session: TaskSession | undefined;
  let widget: TreeWidget | undefined;
  let supervisor: Supervisor | undefined;
  let messageInbox: Inbox | undefined;
  /** True after tau blocked all tools (see `failClosed`). */
  let blockedAll = false;
  const env = deps.env ?? process.env;

  /**
   * A sub-agent that cannot start tau correctly must not work: its first
   * prompt comes anyway (a pi argument), and without tau it has no work gate
   * and other rules. So tau shows the error, blocks all input and all tools,
   * and stops pi.
   * Then the pane is empty: the parent fails the task when the start grace
   * time ends, and closes the pane that it made.
   */
  const failClosed = (ctx: ExtensionContext, reason: string, show = true): void => {
    if (show) report(ctx, reason);
    if (!blockedAll) {
      blockedAll = true;
      pi.on("tool_call", () => ({ block: true, reason: `tau blocked the tool: ${reason} Stop now.` }));
      // pi sends the first prompt of a sub-agent (a pi argument) after
      // session_start: do not give it to the model.
      pi.on("input", () => ({ action: "handled" as const }));
    }
    ctx.shutdown();
  };
  let identity: Identity | undefined;
  let herdrClient: HerdrClient | undefined;
  let paneOfThisAgent: string | undefined;
  /** The metadata report of session_start. Shutdown waits for it, then clears the metadata. */
  let reporting: Promise<void> | undefined;
  /** True after session_shutdown. A session_start that still waits then stops. */
  let shutDown = false;

  pi.on("session_start", async (event, ctx) => {
    // Keep the promise, not the result, so that two events that start at the
    // same time share one herdr call.
    detection ??= detectHerdr(exec);
    const status = await detection;
    if (shutDown) return;

    if (widget !== undefined) {
      // A later session_start of the same runtime: show the tree again.
      // pi disposes the old component when a widget is set again.
      if (ctx.hasUI) {
        ctx.ui.setWidget(WIDGET_KEY, widget.factory);
      }
      return;
    }
    if (ctx.hasUI) {
      ctx.ui.setWidget(WIDGET_KEY, widgetLines(status));
    }
    if (session !== undefined) return;
    if (!status.available) {
      // A sub-agent without herdr cannot work with its lead.
      if (isSubAgent(env)) failClosed(ctx, "This sub-agent cannot use herdr.");
      return;
    }
    // Read the configuration before the task list: after the last await
    // below, the registration must run without an await (see the checks).
    const { config, file: configFile, problems, fatal } = await configFor(env, tauDir(deps.agentDir()));
    if (shutDown) return;
    if (fatal !== undefined) {
      failClosed(ctx, fatal);
      return;
    }
    // All tau names, also tau_ask_user when askTool is set: the gate and the
    // message delivery know the tau tools by name, so a tool of a different
    // extension with a tau name must not exist.
    const conflicts = conflictingTools(pi);
    if (conflicts.length > 0) {
      const message = `A different extension has tools with the names of tau tools (${conflicts.join(", ")}). tau does not register its tools or its work gate.`;
      if (isSubAgent(env)) failClosed(ctx, message);
      else report(ctx, message);
      return;
    }
    const opened = await openTaskList(ctx, deps, status.pane.paneId, event);
    const store = opened?.store;
    if (shutDown) {
      store?.close();
      return;
    }
    if (session !== undefined) {
      // A different session_start of this runtime registered tau while this
      // one waited. Show its tree, and close the second store.
      store?.close();
      // TypeScript does not see that `widget` can change during the await.
      const current = widget as TreeWidget | undefined;
      if (ctx.hasUI && current !== undefined) {
        ctx.ui.setWidget(WIDGET_KEY, current.factory);
      }
      return;
    }
    if (store === undefined) {
      // openTaskList reported the error. A sub-agent must not work without tau.
      if (isSubAgent(env)) failClosed(ctx, "This sub-agent cannot open the task list of its lead.", false);
      return;
    }
    identity = opened!.identity;
    if (problems.length > 0) {
      report(ctx, `tau configuration ${configFile}:\n${problems.map((line) => `- ${line}`).join("\n")}`, "warning");
    }
    const herdr = new HerdrClient(exec, status.binary);
    herdrClient = herdr;
    paneOfThisAgent = status.pane.paneId;
    const createdPanes = new Set<string>();
    const tree = new TreeWidget(store, {
      badge: badgeLabel(status, identity),
      maxLines: config.maxTreeLines,
      pills: config.idPills,
    });
    widget = tree;
    const watcher = new Supervisor({
      store,
      herdr,
      actor: identity.actor,
      now: deps.now,
      onChange: () => void tree.refresh(),
      createdPanes,
      ...(deps.superviseMs === undefined ? {} : { intervalMs: deps.superviseMs }),
    });
    supervisor = watcher;
    const inbox = new Inbox({
      store,
      agent: identity.actor.name,
      now: deps.now,
      isIdle: () => ctx.isIdle(),
      deliver: (text) => pi.sendMessage({ customType: MESSAGE_TYPE, content: text, display: true }, { triggerTurn: true }),
      onChange: () => void tree.refresh(),
      ...(deps.inboxMs === undefined ? {} : { intervalMs: deps.inboxMs }),
    });
    messageInbox = inbox;
    const guard = new StopGuard({
      maxIdleContinuations: config.maxIdleContinuations,
      actor: identity.actor,
      read: () => store.read(),
      askTool: () => activeAskTool(config.askTool, pi.getActiveTools()),
    });
    session = {
      store,
      actor: identity.actor,
      now: deps.now,
      taskTypes: config.taskTypes,
      askTool: config.askTool,
      onChange: () => void tree.refresh(),
      delegation: {
        herdr,
        paneId: status.pane.paneId,
        cwd: ctx.cwd,
        extensionPath: EXTENSION_PATH,
        createdPanes,
        closeLater: (pane, agent, session) => watcher.scheduleClose(pane, agent, session),
        maxAgents: config.maxParallelSubAgents,
        config: JSON.stringify(config),
      },
      current: () => ({
        ...(ctx.model === undefined ? {} : { model: `${ctx.model.provider}/${ctx.model.id}` }),
        thinking: pi.getThinkingLevel(),
      }),
      stopAgents: async (agents) => {
        for (const agent of agents) {
          if (agent.pane !== undefined) watcher.scheduleClose(agent.pane, agent.name, agent.session);
        }
        await watcher.checkAgain();
        return agents.flatMap((agent) => {
          if (agent.pane === undefined) return [];
          const outcome = watcher.closeOutcome(agent.pane);
          return outcome === "closed" ? [] : [{ agent: agent.name, pane: agent.pane, outcome }];
        });
      },
      inbox,
      onAskUser: (_question, toolCtx) => {
        const target = toolCtx ?? ctx;
        if (target.hasUI) {
          target.ui.notify("⏸ tau: waiting for your answer. Type it as your next prompt.", "info");
        }
      },
    };
    registerTaskTools(pi, session);
    registerWorkGate(pi, session);
    // The tracker must see the final decision of the settle boundary, but
    // the delivery reads it in agent_settled: register the tracker last, and
    // give the delivery a function that reads its state.
    let continuationPending: () => boolean = () => false;
    registerMessageDelivery(pi, inbox, guard, () => continuationPending(), identity.role === "subagent");
    registerStopRule(pi, guard, identity.actor, config.askTool);
    continuationPending = registerContinuationTracker(pi);
    // After the tracker: the report needs the final decision of the boundary.
    if (identity.role === "subagent") registerErrorReport(pi, session, identity.parent);
    if (identity.role === "lead") registerRevisionRecord(pi, store);
    registerCommands(pi, store, tree, badgeLabel(status, identity), {
      toggleKey: config.toggleCompletedKey,
      pills: config.idPills,
    });
    await tree.refresh();
    if (shutDown) {
      store.close();
      return;
    }
    if (ctx.hasUI) {
      ctx.ui.setWidget(WIDGET_KEY, tree.factory);
    }
    tree.start();
    watcher.start();
    inbox.start();
    void watcher.check();
    reporting = reportPane(herdr, status.pane.paneId, identity, store);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shutDown = true;
    widget?.stop();
    supervisor?.stop();
    messageInbox?.stop();
    // A poll, a check, or a refresh can run now: wait for them before the
    // store closes. The inbox and the supervisor can start a refresh of the
    // tree when they end: so wait for the tree last.
    await Promise.all([messageInbox?.drain(), supervisor?.drain()]);
    await widget?.drain();
    session?.store.close();
    if (herdrClient !== undefined && paneOfThisAgent !== undefined && identity !== undefined) {
      // The pane can stay open after pi stops: remove the tau metadata. Wait
      // for the report first, so that it cannot set the metadata again.
      await reporting;
      await herdrClient
        .clearMetadata(paneOfThisAgent, metadataSource(identity), ["tau_role", "tau_task", "tau_parent"])
        .catch(() => undefined);
    }
    if (ctx.hasUI) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  });

  return {
    get widget() {
      return widget;
    },
    get supervisor() {
      return supervisor;
    },
    get identity() {
      return identity;
    },
    get inbox() {
      return messageInbox;
    },
  };
}

/**
 * Blocks tool calls that are not for an active task. See `gate.ts`. If tau
 * cannot read the task list, it blocks the call too, and tells why.
 */
function registerWorkGate(pi: ExtensionAPI, session: TaskSession): void {
  pi.on("tool_call", async (event) => {
    // The ask tool only reads an answer of the user: also when tau cannot
    // read the task list, the agent can ask the user what to do.
    if (TASK_TOOL_NAMES.has(event.toolName) || event.toolName === session.askTool) {
      return undefined;
    }
    let reason: string | undefined;
    try {
      const list = await session.store.read();
      reason =
        list === undefined
          ? "tau blocked the tool: the task list does not exist. Restart the pi session."
          : checkGate({
              toolName: event.toolName,
              tauTools: TASK_TOOL_NAMES,
              list,
              agent: session.actor.name,
              taskTypes: session.taskTypes,
              askTool: session.askTool,
            });
    } catch (error) {
      reason = `tau blocked the tool: it cannot read the task list (${error instanceof Error ? error.message : String(error)}).`;
    }
    return reason === undefined ? undefined : { block: true, reason };
  });
}

/**
 * The delivery of messages while the agent works (see `inbox.ts`):
 *
 * - Each tool result gets the `steer` messages; a `tau_*` tool result gets
 *   all messages.
 * - At the end of a run, tau adds all messages to the conversation, and asks
 *   pi for one more model request. This handler runs before the stop rule,
 *   which then does nothing (the run continues). When the agent waits for an
 *   answer of the user, the messages wait too.
 *
 * pi writes these into the session, so the messages reach the model. After a
 * run that did not end normally (for example `Esc`), and while the agent
 * waits for an answer, the inbox does not start turns until the next input
 * of the user.
 */
function registerMessageDelivery(
  pi: ExtensionAPI,
  inbox: Inbox,
  guard: StopGuard,
  continuationPending: () => boolean,
  /** True for a sub-agent: after an error, a message starts a new turn (see `registerErrorReport`). */
  resumeAfterError: boolean,
): void {
  /** Continuations for messages since the last user input. See `MAX_MESSAGE_CONTINUATIONS`. */
  let continuations = 0;
  pi.on("input", (event) => {
    if (event.source !== "extension") {
      inbox.resume();
      continuations = 0;
    }
    return undefined;
  });
  pi.on("tool_result", async (event) => {
    // A successful tau_ask_user ends the turn: the model sees nothing more
    // before the answer of the user. The messages wait.
    if (event.toolName === ASK_TOOL && !event.isError) return undefined;
    const messages = await inbox.take(TASK_TOOL_NAMES.has(event.toolName) ? undefined : "steer").catch(() => []);
    if (messages.length === 0) return undefined;
    return { content: [...event.content, { type: "text", text: `\n\nNew messages:\n\n${messagesText(messages)}` }] };
  });
  // True after a settle boundary with the outcome `completed`, until the next
  // turn ends. pi skips the boundary after an abort: then this stays false.
  // For a sub-agent, also after an error: its parent gets a report, and a
  // message of the parent (for example "continue") starts a new turn. The
  // lead stays paused after an error, until the next input of the user.
  let settledNormally = false;
  pi.on("turn_end", () => {
    settledNormally = false;
    return undefined;
  });
  pi.on("agent_before_settle", async (event) => {
    settledNormally = event.outcome === "completed" || (resumeAfterError && event.outcome === "error");
    if (event.outcome !== "completed" || event.continue) return undefined;
    if (guard.awaitingAnswer) {
      inbox.pause();
      return undefined;
    }
    // Many messages must not make many model requests in one run: after the
    // limit, the idle inbox gives the rest (at most one turn in its gap).
    if (continuations >= MAX_MESSAGE_CONTINUATIONS) return undefined;
    const messages = await inbox.take().catch(() => []);
    if (messages.length === 0) return undefined;
    continuations += 1;
    return {
      entries: [...event.entries, { type: "custom_message", customType: MESSAGE_TYPE, content: messagesText(messages), display: true }],
      continue: true,
    };
  });
  pi.on("agent_settled", () => {
    if (!settledNormally || continuationPending()) inbox.pause();
    settledNormally = false;
  });
}

/**
 * Records if the last settle boundary asked pi to continue the run. Register
 * it after all other `agent_before_settle` handlers of tau, so that it sees
 * the final decision. When the run settles and the continuation did not start
 * (no `turn_start` after the boundary), the user stopped the run during the
 * boundary (Esc). pi emits no event for that abort.
 */
function registerContinuationTracker(pi: ExtensionAPI): () => boolean {
  let pending = false;
  pi.on("agent_before_settle", (event) => {
    pending = event.continue;
    return undefined;
  });
  pi.on("turn_start", () => {
    pending = false;
  });
  pi.on("agent_settled", () => {
    // After the other agent_settled handlers of tau (they run in the order
    // of registration).
    pending = false;
  });
  return () => pending;
}

/**
 * The kind of a model provider error, for the parent. The raw error text
 * comes from outside (the provider): it can have instructions, request IDs,
 * or tokens, so the parent gets only this fixed text (the pane of the
 * sub-agent shows the raw error).
 */
export function errorKind(error: string): string {
  const status = /\b([45]\d\d)\b/u.exec(error)?.[1];
  const withStatus = (kind: string) => (status === undefined ? kind : `${kind} (HTTP ${status})`);
  if (status === "429" || /rate.?limit/iu.test(error)) return withStatus("rate limit");
  if (status === "401" || status === "403" || /unauthori[sz]ed|forbidden|api key|credential/iu.test(error)) {
    return withStatus("authentication or permission error");
  }
  if (status === "404" || /not.?found/iu.test(error)) return withStatus("not found (for example, the model does not exist: delegate with a different model)");
  if (/timed? ?out/iu.test(error)) return withStatus("timeout");
  if (/connection|network|econn|fetch failed|socket/iu.test(error)) return withStatus("connection error");
  if (status?.startsWith("5") === true || /overloaded|unavailable/iu.test(error)) return withStatus("provider error");
  return withStatus("other error");
}

/**
 * Tells the parent of a sub-agent when a run of the sub-agent ends with an
 * error, and its task is still in progress: else the sub-agent stays idle,
 * and nobody fails its task (it is alive). The task stays in progress. The
 * parent decides: it sends a message to continue (a message starts a turn
 * of the idle sub-agent, see `registerMessageDelivery`), or it stops the
 * sub-agent with tau_abort.
 *
 * tau sends the report in `agent_settled`: pi fires it after all retries and
 * continuations. Register this after all other `agent_before_settle`
 * handlers of tau. When a different extension continues the run, the next
 * `turn_start` clears the report.
 */
function registerErrorReport(pi: ExtensionAPI, session: TaskSession, parent: string): void {
  const self = session.actor.name;
  const scope = session.actor.scope;
  let lastError: string | undefined;
  /** The error kind of a boundary with the outcome `error` that did not continue. */
  let pending: string | undefined;
  pi.on("turn_start", () => {
    pending = undefined;
  });
  pi.on("turn_end", (event) => {
    const message = event.message as { readonly role?: string; readonly stopReason?: string; readonly errorMessage?: unknown } | undefined;
    if (message?.role === "assistant") {
      lastError = message.stopReason === "error" ? String(message.errorMessage ?? "") : undefined;
    }
    return undefined;
  });
  pi.on("agent_before_settle", (event) => {
    pending = event.outcome === "error" && !event.continue ? errorKind(lastError ?? "") : undefined;
    return undefined;
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const kind = pending;
    pending = undefined;
    if (kind === undefined || scope === undefined) return;
    const text = [
      `tau: the run of @${self} ended with an error, and pi does not try again. Its task ${scope} stays in progress, and @${self} waits.`,
      `To continue, send @${self} a message with tau_send (for example "continue"): the message starts a new turn.`,
      `To stop it, use tau_abort for ${scope}, then delegate ${scope} again if necessary.`,
      `The kind of error: ${kind}.`,
    ].join("\n");
    try {
      await session.store.sendMessage({ sender: self, recipient: parent, priority: "steer", text, sentAt: session.now() }, (list) => {
        const task = list.tasks.find((item) => item.id === scope);
        if (task?.status !== "in_progress" || task.owner !== self) {
          throw new TauError("invalid_state", `The task ${scope} is not in progress for @${self}.`);
        }
        checkRecipient(list, self, parent);
        return { senderTask: scope };
      });
      session.onChange?.();
    } catch (error) {
      if (!(error instanceof TauError && error.code === "invalid_state")) {
        report(ctx, `tau could not tell @${parent} about the error (${error instanceof Error ? cleanLine(error.message) : String(error)}).`, "warning");
      }
    }
  });
}

/** The maximum number of continuations for messages between two user inputs. */
export const MAX_MESSAGE_CONTINUATIONS = 5;

/**
 * The "do not stop" rule. See `stop.ts`. Each input from the user starts
 * the rule again (also a steer or follow-up message in a run). At the end of a run,
 * tau adds a continuation message when the agent has open work, and asks pi
 * for one more model request.
 */
function registerStopRule(pi: ExtensionAPI, guard: StopGuard, actor: Actor, configuredAskTool: string | undefined): void {
  let warned = false;
  pi.on("before_agent_start", (event, ctx) => {
    const askTool = activeAskTool(configuredAskTool, event.systemPromptOptions.selectedTools);
    event.systemPromptOptions.sections[PROMPT_SECTION] = promptSection(actor, askTool);
    if (configuredAskTool !== undefined && askTool === undefined && !warned) {
      // Tell it one time for each load of tau (a /reload tells it again).
      warned = true;
      report(
        ctx,
        `The ask tool ${configuredAskTool} (askTool in the configuration) is not an active tool. The agent cannot use it, and tau_ask_user is not available. Install the extension of this tool, or change askTool.`,
        "warning",
      );
    }
    return undefined;
  });
  // Input from the user (in the terminal, or from an RPC client) starts the
  // rule again, also a steer or follow-up message while the agent works.
  // Messages that extensions send do not: else an extension that sends
  // messages again and again stops the limit of idle continuations.
  pi.on("input", (event) => {
    if (event.source !== "extension") guard.userPrompt();
    return undefined;
  });
  // Decide after the complete tool batch, not from the order of the calls:
  // the work gate can block a call before other tool_call handlers run.
  pi.on("turn_end", (event) => {
    guard.turnEnded(event.toolResults);
    return undefined;
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.continue) {
      // A different extension continues the run: the agent does not stop.
      guard.continued();
      return undefined;
    }
    const decision = await guard.settle(event.outcome);
    if (decision.kind === "stop") return undefined;
    if (decision.kind === "give_up" || decision.kind === "warn") {
      if (ctx.hasUI) {
        ctx.ui.notify(decision.text, "warning");
      } else {
        console.error(decision.text);
      }
      return undefined;
    }
    return {
      entries: [...event.entries, { type: "custom_message", customType: CONTINUE_MESSAGE_TYPE, content: decision.text, display: true }],
      continue: true,
    };
  });
}

/**
 * Opens the task list of this process. A lead opens the list of its session,
 * and makes it with the task `T0` if it does not exist. A sub-agent opens the
 * list of its lead, and checks that the list gave it its task. Returns
 * `undefined` when this fails.
 */
async function openTaskList(
  ctx: ExtensionContext,
  deps: TauDependencies,
  paneId: string,
  event: { readonly reason?: string; readonly previousSessionFile?: string | undefined } = {},
): Promise<{ store: TaskListStore; identity: Identity } | undefined> {
  let store: TaskListStore | undefined;
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    const identity = resolveIdentity(deps.env ?? process.env, tauDir(deps.agentDir()), sessionId);
    store = new TaskListStore(identity.file);
    if (identity.role === "lead") {
      let seed = () => seedTaskList(sessionId, deps.now());
      // A fork: a copy of the task list of the old session, at the fork point.
      const source = forkSource(ctx, event);
      if (source !== undefined && (await store.read()) === undefined) {
        const forked = await forkedList(ctx, deps, sessionId, source);
        if (forked !== undefined) seed = () => forked;
      }
      await store.ensure(seed);
    } else {
      const list = await store.read();
      if (list === undefined) {
        throw new TauError("storage", `The task list ${identity.file} of the lead does not exist.`);
      }
      checkSubAgent(list, identity, paneId);
      // Record the pi session, so that the parent knows this agent in herdr
      // also after a pane move.
      const session = ctx.sessionManager.getSessionFile() ?? sessionId;
      await store.mutate((current) => setAgentSession(current, identity.actor.name, session));
    }
    return { store, identity };
  } catch (error) {
    store?.close();
    report(ctx, error instanceof TauError ? error.message : `tau cannot open the task list: ${String(error)}`);
    return undefined;
  }
}

/**
 * The session file that this session is a fork of, or `undefined` when it is
 * not a fork:
 *
 * - `/fork` and `/clone` give the reason `fork`, with the old session file.
 * - `pi --fork <session>` starts a new process: the reason is `startup`, and
 *   the header of the new session tells the old session file.
 *
 * The caller copies the list only when this session has no list yet: so a
 * later start of a forked session does not copy the list again.
 */
function forkSource(
  ctx: ExtensionContext,
  event: { readonly reason?: string; readonly previousSessionFile?: string | undefined },
): string | undefined {
  if (event.reason === "fork") return event.previousSessionFile;
  if (event.reason !== "startup") return undefined;
  const parent = ctx.sessionManager.getHeader?.()?.parentSession;
  if (typeof parent !== "string" || parent === "") return undefined;
  // pi also sets parentSession for a new session (/new), which is not a
  // fork. A fork has a copy of the entries of its old session, with the
  // revision records of tau.
  return forkRevision(ctx.sessionManager.getBranch()) === undefined ? undefined : parent;
}

/**
 * The task list of a forked session: the list of the old session, rolled back
 * to the fork point (see `fork.ts`). `undefined` when the old session has no
 * task list. When tau cannot read it, it tells the user, and the fork gets a
 * new list.
 */
async function forkedList(
  ctx: ExtensionContext,
  deps: TauDependencies,
  sessionId: string,
  previousSessionFile: string,
): Promise<TaskList | undefined> {
  const oldId = await sessionIdOf(previousSessionFile);
  if (oldId === undefined || oldId === sessionId) return undefined;
  let old: TaskListStore | undefined;
  try {
    old = new TaskListStore(taskListFile(tauDir(deps.agentDir()), oldId));
    const list = await old.read();
    if (list === undefined) return undefined;
    const warn = (reason: string) => {
      report(ctx, `tau does not copy the task list of the old session: ${reason} The fork gets a new task list.`, "warning");
      return undefined;
    };
    if (list.sessionId !== oldId) return warn("its task list belongs to a different session.");
    const revision = forkRevision(ctx.sessionManager.getBranch());
    if (revision === undefined) return warn("tau cannot find the fork point (the session has no revision record before it).");
    if (revision < 1 || revision > list.revision) return warn(`the fork point (revision ${revision}) is not in its task list.`);
    const forked = forkTaskList(list, revision, sessionId, deps.now());
    // The copy has more events (the failed tasks): it must fit in the store.
    if (Buffer.byteLength(encodeTaskList(forked)) > MAX_FILE_BYTES) return warn("the copy is too large.");
    return forked;
  } catch (error) {
    report(
      ctx,
      `tau cannot copy the task list of the old session (${error instanceof Error ? cleanLine(error.message) : String(error)}). The fork gets a new task list.`,
      "warning",
    );
    return undefined;
  } finally {
    old?.close();
  }
}

/**
 * Writes the revision of the task list into the session of the lead when it
 * changed (see `fork.ts`). So a fork knows the state of the list at its fork
 * point.
 *
 * tau does this in `message_end`, for each message (the user prompt, the
 * answers of the model, and the tool results): pi runs this event before it
 * writes the message into the session. So the revision entry comes before
 * each message entry, and a fork at any message has the changes up to it
 * (also the changes of sub-agents while the lead was idle).
 */
function registerRevisionRecord(pi: ExtensionAPI, store: TaskListStore): void {
  let recorded: number | undefined;
  const record = async (): Promise<undefined> => {
    const list = await store.read().catch(() => undefined);
    if (list === undefined || list.revision === recorded) return undefined;
    try {
      pi.appendEntry(REVISION_ENTRY, { revision: list.revision });
      recorded = list.revision;
    } catch {
      // The next message tries again.
    }
    return undefined;
  };
  pi.on("message_end", record);
  // A compaction entry has no message_end: record before it too (a clone at
  // the compaction entry must have the changes up to it).
  pi.on("session_before_compact", record);
}

/**
 * The name of the tool that asks the user a question, when it is one of the
 * `active` tools: the configured ask tool, else `tau_ask_user`.
 */
function activeAskTool(configured: string | undefined, active: readonly string[]): string | undefined {
  const name = configured ?? ASK_TOOL;
  return active.includes(name) ? name : undefined;
}

/** True when this process is a tau sub-agent (its parent set `TAU_TASKLIST`). */
function isSubAgent(env: NodeJS.ProcessEnv): boolean {
  return env[ENV_TASKLIST] !== undefined && env[ENV_TASKLIST] !== "";
}

/** The text of the badge: for a sub-agent, it tells its name and its task. */
function badgeLabel(status: HerdrStatus, identity: Identity): string {
  const badge = badgeText(status);
  return identity.role === "lead" ? badge : `${badge} @${identity.actor.name} (${identity.actor.scope})`;
}

/** The herdr metadata source of this agent. */
function metadataSource(identity: Identity): string {
  return identity.role === "lead" ? "tau:lead" : `tau:${identity.actor.name}`;
}

/**
 * Tells herdr what this pane is: the title, the agent label, and tokens.
 * herdr shows this metadata. It is display-only: tau does not trust it.
 */
async function reportPane(herdr: HerdrClient, paneId: string, identity: Identity, store: TaskListStore): Promise<void> {
  try {
    if (identity.role === "lead") {
      await herdr.reportMetadata(paneId, {
        source: metadataSource(identity),
        title: "tau lead",
        displayAgent: "tau lead",
        tokens: { tau_role: "lead" },
      });
      return;
    }
    const list = await store.read();
    const task = list?.tasks.find((item) => item.id === identity.actor.scope);
    const title = `${identity.actor.name} · ${identity.actor.scope}${task === undefined ? "" : ` ${cleanLine(task.title)}`}`;
    await herdr.reportMetadata(paneId, {
      source: metadataSource(identity),
      title: [...title].slice(0, 80).join(""),
      displayAgent: "tau sub-agent",
      tokens: { tau_role: "subagent", tau_task: identity.actor.scope, tau_parent: identity.parent },
    });
  } catch {
    // The metadata is only for display.
  }
}

/** Shows an error (or a warning). Without a UI (print or JSON mode), writes it to stderr. */
function report(ctx: ExtensionContext, message: string, type: "error" | "warning" = "error"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type);
  } else {
    console.error(`tau: ${message}`);
  }
}
