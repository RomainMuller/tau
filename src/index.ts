import { fileURLToPath } from "node:url";

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { badgeText, WIDGET_KEY, widgetLines } from "./badge.ts";
import { Inbox } from "./inbox.ts";
import { MESSAGE_TYPE, messagesText } from "./messages.ts";
import { registerCommands } from "./commands.ts";
import { checkGate } from "./gate.ts";
import { HerdrClient } from "./herdr-client.ts";
import { detectHerdr, type Exec, type HerdrStatus } from "./herdr.ts";
import { checkSubAgent, resolveIdentity, type Identity } from "./identity.ts";
import { Supervisor } from "./supervisor.ts";
import { TauError } from "./tasks/errors.ts";
import { seedTaskList } from "./tasks/model.ts";
import { tauDir } from "./tasks/paths.ts";
import { ASK_TOOL, CONTINUE_MESSAGE_TYPE, PROMPT_SECTION, promptSection, StopGuard } from "./stop.ts";
import { setAgentSession, type Actor } from "./tasks/rules.ts";
import { TaskListStore } from "./tasks/store.ts";
import { DEFAULT_TASK_TYPE_DEFINITIONS } from "./tasks/types.ts";
import { conflictingTools, registerTaskTools, TASK_TOOL_NAMES, type TaskSession } from "./tools.ts";
import { cleanLine } from "./text.ts";
import { TreeWidget } from "./widget.ts";

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
  let identity: Identity | undefined;
  let herdrClient: HerdrClient | undefined;
  let paneOfThisAgent: string | undefined;
  /** The metadata report of session_start. Shutdown waits for it, then clears the metadata. */
  let reporting: Promise<void> | undefined;
  /** True after session_shutdown. A session_start that still waits then stops. */
  let shutDown = false;

  pi.on("session_start", async (_event, ctx) => {
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
    if (!status.available || session !== undefined) {
      return;
    }
    const conflicts = conflictingTools(pi);
    if (conflicts.length > 0) {
      report(
        ctx,
        `A different extension has tools with the names of tau tools (${conflicts.join(", ")}). tau does not register its tools or its work gate.`,
      );
      return;
    }
    const opened = await openTaskList(ctx, deps, status.pane.paneId);
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
      return;
    }
    identity = opened!.identity;
    const herdr = new HerdrClient(exec, status.binary);
    herdrClient = herdr;
    paneOfThisAgent = status.pane.paneId;
    const createdPanes = new Set<string>();
    const tree = new TreeWidget(store, { badge: badgeLabel(status, identity) });
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
      actor: identity.actor,
      read: () => store.read(),
      askToolActive: () => pi.getActiveTools().includes(ASK_TOOL),
    });
    session = {
      store,
      actor: identity.actor,
      now: deps.now,
      taskTypes: DEFAULT_TASK_TYPE_DEFINITIONS,
      onChange: () => void tree.refresh(),
      delegation: {
        herdr,
        paneId: status.pane.paneId,
        cwd: ctx.cwd,
        extensionPath: EXTENSION_PATH,
        createdPanes,
        closeLater: (pane, agent, session) => watcher.scheduleClose(pane, agent, session),
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
    registerMessageDelivery(pi, inbox, guard, () => continuationPending());
    registerStopRule(pi, guard, identity.actor);
    continuationPending = registerContinuationTracker(pi);
    registerCommands(pi, store, tree, badgeLabel(status, identity));
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
    // A poll can run now: wait for it before the store closes.
    await messageInbox?.drain();
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
    if (TASK_TOOL_NAMES.has(event.toolName)) {
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
  let settledNormally = false;
  pi.on("turn_end", () => {
    settledNormally = false;
    return undefined;
  });
  pi.on("agent_before_settle", async (event) => {
    settledNormally = event.outcome === "completed";
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

/** The maximum number of continuations for messages between two user inputs. */
export const MAX_MESSAGE_CONTINUATIONS = 5;

/**
 * The "do not stop" rule. See `stop.ts`. Each input from the user starts
 * the rule again (also a steer or follow-up message in a run). At the end of a run,
 * tau adds a continuation message when the agent has open work, and asks pi
 * for one more model request.
 */
function registerStopRule(pi: ExtensionAPI, guard: StopGuard, actor: Actor): void {
  pi.on("before_agent_start", (event) => {
    const askToolActive = event.systemPromptOptions.selectedTools.includes(ASK_TOOL);
    event.systemPromptOptions.sections[PROMPT_SECTION] = promptSection(actor, askToolActive);
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
): Promise<{ store: TaskListStore; identity: Identity } | undefined> {
  let store: TaskListStore | undefined;
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    const identity = resolveIdentity(deps.env ?? process.env, tauDir(deps.agentDir()), sessionId);
    store = new TaskListStore(identity.file);
    if (identity.role === "lead") {
      await store.ensure(() => seedTaskList(sessionId, deps.now()));
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

/** Shows an error. Without a UI (print or JSON mode), writes it to stderr. */
function report(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, "error");
  } else {
    console.error(`tau: ${message}`);
  }
}
