import { homedir } from "node:os";
import { join } from "node:path";
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
import { checkSubAgent, ENV_LEAD_PANE, ENV_TASKLIST, resolveIdentity, type Identity } from "./identity.ts";
import { isPaneId } from "./layout.ts";
import { Supervisor } from "./supervisor.ts";
import { TauError } from "./tasks/errors.ts";
import { LEAD_AGENT, seedTaskList, type TaskList } from "./tasks/model.ts";
import { tauDir } from "./tasks/paths.ts";
import { ASK_TOOL, CONTINUE_MESSAGE_TYPE, PROMPT_SECTION, promptSection, StopGuard } from "./stop.ts";
import { setAgentError, setAgentPane, setAgentSession, type Actor } from "./tasks/rules.ts";
import { errorKind } from "./tasks/model.ts";
export { errorKind } from "./tasks/model.ts";
import { MAX_FILE_BYTES, TaskListStore } from "./tasks/store.ts";
import { conflictingTools, registerTaskTools, TASK_TOOL_NAMES, type TaskSession } from "./tools.ts";
import { cleanLine } from "./text.ts";
import { titleSlug } from "./names.ts";
import { TreeWidget } from "./widget.ts";
import { forkRevision, forkTaskList, REVISION_ENTRY, sessionIdOf } from "./fork.ts";
import { taskListFile } from "./tasks/paths.ts";
import { collectOrphanedTaskLists } from "./tasks/gc.ts";
import { encodeTaskList } from "./tasks/codec.ts";
import { startSticky } from "./sticky/index.ts";
import type { StickyReporter } from "./sticky/reporter.ts";
import { socketStickyServer, type StickyServer } from "./sticky/server.ts";

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
  /**
   * Makes the client of `sticky server` for the environment. The default
   * uses its UNIX socket. Without it (for example in tests), tau does not
   * use stickies.
   */
  readonly stickyServer?: (env: NodeJS.ProcessEnv) => StickyServer | undefined;
}

const DEFAULT_DEPENDENCIES: TauDependencies = {
  agentDir: getAgentDir,
  now: () => new Date().toISOString(),
  stickyServer: socketStickyServer,
};

/**
 * The usual name of an "ask question" tool of a different extension. Also
 * when `askTool` is not set, the stickies show `question` while it runs.
 */
const COMMON_ASK_TOOL = "ask_user_question";

/** The text of the widget line under the header while no `sticky server` runs. */
export const STICKY_NO_SERVER_NOTICE = "⚠ Sticky: no server";

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
  /** The last pane metadata report (see `reportPane`). */
  readonly reporting: Promise<void> | undefined;
  /** The removal of old task lists (see `tasks/gc.ts`). Only a lead starts it. */
  readonly collection: Promise<unknown> | undefined;
  /** The Sticky support, when it runs (see `sticky/index.ts`). */
  readonly sticky: StickyReporter | undefined;
}

export function createTau(pi: ExtensionAPI, deps: TauDependencies): TauHandle {
  const exec: Exec = (command, args, options) => pi.exec(command, args, options);
  let detection: Promise<HerdrStatus> | undefined;
  let session: TaskSession | undefined;
  let widget: TreeWidget | undefined;
  let supervisor: Supervisor | undefined;
  let messageInbox: Inbox | undefined;
  let collection: Promise<unknown> | undefined;
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
  /** The Sticky support (see `sticky/index.ts`), when it runs. */
  let sticky: StickyReporter | undefined;

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
    // A pane that herdr does not show: the pane of a sub-agent moved before
    // its pi started (see checkSubAgent). When herdr fails, tau does not
    // know: the pane counts as shown.
    const paneGone = async (pane: string | undefined) =>
      pane !== undefined &&
      !(await new HerdrClient(exec, status.binary).listPanes().then((panes) => panes.has(pane), () => true));
    const opened = await openTaskList(ctx, deps, status.pane.paneId, event, paneGone);
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
    const startingAgents = new Set<string>();
    // The pane of the lead: the column of sub-agents goes on its right (see
    // `layout.ts`). A sub-agent gets it from its parent.
    const fromEnv = env[ENV_LEAD_PANE];
    const leadPane =
      identity.role === "lead" ? status.pane.paneId : fromEnv !== undefined && isPaneId(fromEnv) ? fromEnv : undefined;
    const tree = new TreeWidget(store, {
      badge: badgeLabel(status, identity),
      maxLines: config.maxTreeLines,
      pills: config.idPills,
      // A sub-agent shows only the tree of its task.
      ...(identity.role === "subagent" ? { root: identity.actor.scope } : {}),
    });
    widget = tree;
    const watcher = new Supervisor({
      store,
      herdr,
      actor: identity.actor,
      now: deps.now,
      onChange: () => void tree.refresh(),
      createdPanes,
      startingAgents,
      leadPane,
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
        startingAgents,
        closeLater: (pane, agent, session) => watcher.scheduleClose(pane, agent, session),
        maxAgents: config.maxParallelSubAgents,
        config: JSON.stringify(config),
        leadPane,
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
    if (identity.role === "lead") {
      registerRevisionRecord(pi, store);
      collection = collectGarbage(ctx, deps, env);
    }
    registerCommands(pi, store, tree, badgeLabel(status, identity), {
      toggleKey: config.toggleCompletedKey,
      pills: config.idPills,
    });
    const stickyServer = deps.stickyServer;
    if (config.sticky && stickyServer !== undefined) {
      const self = identity;
      sticky = startSticky(pi, {
        taskListFile: self.file,
        agentName: self.actor.name,
        ...(self.role === "subagent" ? { parentAgentName: self.parent } : {}),
        // The task title gives the name of a sub-agent (see below).
        displayName: self.actor.name,
        workspace: ctx.cwd,
        model: modelLabel(ctx.model),
        modelLabel,
        isAskTool: (name) => name === ASK_TOOL || name === config.askTool || name === COMMON_ASK_TOOL,
        env,
        server: () => stickyServer(env),
        // The sticky does not show the agents while no server runs, and
        // tau does not start it: tell the user in the widget.
        onServer: (found) => tree.setNotice(found ? undefined : STICKY_NO_SERVER_NOTICE),
      });
      if (sticky !== undefined && self.role === "subagent") {
        const reporter = sticky;
        void store
          .read()
          .then((list) => {
            const task = list?.tasks.find((item) => item.id === self.actor.scope);
            const slug = task === undefined ? undefined : titleSlug(task.title);
            if (slug !== undefined) reporter.setName(slug);
          })
          .catch(() => undefined);
      }
    }
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
    const paneId = status.pane.paneId;
    const self = identity;
    reporting = reportPane(herdr, paneId, self, store, modelLabel(ctx.model));
    // Show the new model in the side bar (see `reportPane`). One report at
    // a time, in order: shutdown waits for the last one.
    pi.on("model_select", (event) => {
      if (shutDown) return;
      const previous = reporting ?? Promise.resolve();
      reporting = previous.then(() => (shutDown ? undefined : reportPane(herdr, paneId, self, store, modelLabel(event.model))));
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shutDown = true;
    // Tell the stickies first: the other steps can take some time.
    await sticky?.close();
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
        .clearMetadata(paneOfThisAgent, metadataSource(identity), ["tau_role", "tau_task", "tau_parent", MODEL_TOKEN])
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
    get reporting() {
      return reporting;
    },
    get collection() {
      return collection;
    },
    get sticky() {
      return sticky;
    },
  };
}

/**
 * Blocks tool calls that are not for an active task. See `gate.ts`. If tau
 * cannot read the task list, it blocks the call too, and tells why.
 */
function registerWorkGate(pi: ExtensionAPI, session: TaskSession): void {
  pi.on("tool_call", async (event, ctx) => {
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
              toolInput: event.input,
              cwd: ctx.cwd,
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
  pi.on("turn_start", async () => {
    pending = undefined;
    // A new turn: the sub-agent works again. Read the record (also an error
    // of a run before a /reload, which makes a new runtime). The read uses
    // the cache of the store. When the change fails, the next turn tries
    // again.
    try {
      const list = await session.store.read();
      if (list?.agents.find((agent) => agent.name === self)?.error === undefined) return;
      await session.store.mutate((current) => setAgentError(current, self, undefined));
      session.onChange?.();
    } catch {
      // The next turn_start tries again.
    }
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
      // Record the error first: the tau_wait of the parent and its
      // continuation message use it, also when the message cannot be sent.
      await session.store.mutate((list) => {
        const task = list.tasks.find((item) => item.id === scope);
        if (task?.status !== "in_progress" || task.owner !== self) {
          throw new TauError("invalid_state", `The task ${scope} is not in progress for @${self}.`);
        }
        setAgentError(list, self, kind);
      });
      session.onChange?.();
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
  paneGone: (pane: string | undefined) => Promise<boolean> = async () => false,
): Promise<{ store: TaskListStore; identity: Identity } | undefined> {
  let store: TaskListStore | undefined;
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    const identity = resolveIdentity(deps.env ?? process.env, tauDir(deps.agentDir()), sessionId);
    store = new TaskListStore(identity.file);
    if (identity.role === "lead") {
      // The transcript of this session (see `tasks/gc.ts`).
      const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
      let seed = (): TaskList => ({ ...seedTaskList(sessionId, deps.now(), LEAD_AGENT), sessionFile });
      // A fork: a copy of the task list of the old session, at the fork point.
      const source = forkSource(ctx, event);
      if (source !== undefined && (await store.read()) === undefined) {
        const forked = await forkedList(ctx, deps, sessionId, source);
        if (forked !== undefined) seed = () => ({ ...forked, sessionFile });
      }
      const list = await store.ensure(seed);
      // A list from before this field, or a session file that moved.
      if (list.sessionFile !== sessionFile) {
        await store.mutate((current) => {
          current.sessionFile = sessionFile;
        });
      }
    } else {
      const list = await store.read();
      if (list === undefined) {
        throw new TauError("storage", `The task list ${identity.file} of the lead does not exist.`);
      }
      const recordPane = list.agents.find((agent) => agent.name === identity.actor.name)?.pane;
      const gone = recordPane !== paneId && (await paneGone(recordPane));
      checkSubAgent(list, identity, paneId, gone);
      // Record the pi session, so that the parent knows this agent in herdr
      // also after a pane move. Check again in the same transaction, and
      // record the pane too: the pane can have moved before pi started (a
      // moved pane gets a new ID).
      const session = ctx.sessionManager.getSessionFile() ?? sessionId;
      await store.mutate((current) => {
        const now = current.agents.find((agent) => agent.name === identity.actor.name)?.pane;
        checkSubAgent(current, identity, paneId, gone && now === recordPane);
        const before = current.agents.find((agent) => agent.name === identity.actor.name)?.session;
        setAgentPane(current, identity.actor.name, paneId);
        setAgentSession(current, identity.actor.name, session);
        // A new pi session of this agent (a restart): an error of an old run
        // is not true now. A /reload keeps the session: the error stays until
        // the next turn.
        if (before !== undefined && before !== session) setAgentError(current, identity.actor.name, undefined);
      });
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
 * Removes the task lists whose session transcript does not exist any more
 * (see `tasks/gc.ts`). Only a lead does this, when it starts. It runs in the
 * background: the start does not wait for it, and an error does not stop
 * tau.
 */
function collectGarbage(ctx: ExtensionContext, deps: TauDependencies, env: NodeJS.ProcessEnv): Promise<unknown> {
  const agentDir = deps.agentDir();
  const roots = [join(agentDir, "sessions")];
  const fromEnv = env.PI_CODING_AGENT_SESSION_DIR;
  if (fromEnv !== undefined && fromEnv !== "") {
    roots.push(fromEnv === "~" ? homedir() : fromEnv.startsWith("~/") ? join(homedir(), fromEnv.slice(2)) : fromEnv);
  }
  const current = ctx.sessionManager.getSessionDir?.();
  if (current !== undefined && current !== "") roots.push(current);
  return collectOrphanedTaskLists({
    tauDirectory: tauDir(agentDir),
    sessionRoots: roots,
    keep: ctx.sessionManager.getSessionId(),
    now: Date.parse(deps.now()),
  }).catch(() => undefined);
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
 * The pane metadata token with the model of the agent. The herdr side bar
 * can show it: `$model` in `[ui.sidebar.agents] rows`.
 */
export const MODEL_TOKEN = "model";

/** The text of a model for the side bar: its name, else its ID. */
function modelLabel(model: { readonly id: string; readonly name?: string } | undefined): string | undefined {
  if (model === undefined) return undefined;
  const label = cleanLine(model.name !== undefined && model.name !== "" ? model.name : model.id);
  return label === "" ? undefined : [...label].slice(0, 40).join("");
}

/**
 * Tells herdr what this pane is: the title, the agent label, and tokens.
 * herdr shows this metadata. It is display-only: tau does not trust it.
 *
 * The agent label is what the herdr side bar shows as `agent`: `tau lead`
 * for the lead, and a short label of the task title for a sub-agent (see
 * `titleSlug`). The `model` token has the model of the agent.
 */
async function reportPane(
  herdr: HerdrClient,
  paneId: string,
  identity: Identity,
  store: TaskListStore,
  model: string | undefined,
): Promise<void> {
  const modelToken: Record<string, string> = model === undefined ? {} : { [MODEL_TOKEN]: model };
  // An earlier report (for example of a pi that did not stop normally) can
  // have a model token: remove it when the model is not known.
  const clearTokens = model === undefined ? [MODEL_TOKEN] : [];
  try {
    if (identity.role === "lead") {
      await herdr.reportMetadata(paneId, {
        source: metadataSource(identity),
        title: "tau lead",
        displayAgent: "tau lead",
        tokens: { tau_role: "lead", ...modelToken },
        clearTokens,
      });
      return;
    }
    const list = await store.read();
    const task = list?.tasks.find((item) => item.id === identity.actor.scope);
    const title = `${identity.actor.name} · ${identity.actor.scope}${task === undefined ? "" : ` ${cleanLine(task.title)}`}`;
    await herdr.reportMetadata(paneId, {
      source: metadataSource(identity),
      title: [...title].slice(0, 80).join(""),
      displayAgent: (task === undefined ? undefined : titleSlug(task.title)) ?? "tau sub-agent",
      tokens: { tau_role: "subagent", tau_task: identity.actor.scope, tau_parent: identity.parent, ...modelToken },
      clearTokens,
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
