import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { WIDGET_KEY, widgetLines } from "./badge.ts";
import { checkGate } from "./gate.ts";
import { detectHerdr, type Exec, type HerdrStatus } from "./herdr.ts";
import { TauError } from "./tasks/errors.ts";
import { seedTaskList } from "./tasks/model.ts";
import { taskListFile, tauDir } from "./tasks/paths.ts";
import type { Actor } from "./tasks/rules.ts";
import { TaskListStore } from "./tasks/store.ts";
import { DEFAULT_TASK_TYPE_DEFINITIONS } from "./tasks/types.ts";
import { conflictingTools, registerTaskTools, TASK_TOOL_NAMES, type TaskSession } from "./tools.ts";

/** Things that tests can replace. */
export interface TauDependencies {
  /** The pi agent directory. The default is `getAgentDir()`. */
  readonly agentDir: () => string;
  /** The current time, as an ISO 8601 text. */
  readonly now: () => string;
}

const DEFAULT_DEPENDENCIES: TauDependencies = {
  agentDir: getAgentDir,
  now: () => new Date().toISOString(),
};

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

export function createTau(pi: ExtensionAPI, deps: TauDependencies): void {
  const exec: Exec = (command, args, options) => pi.exec(command, args, options);
  let detection: Promise<HerdrStatus> | undefined;
  let session: TaskSession | undefined;

  pi.on("session_start", async (_event, ctx) => {
    // Keep the promise, not the result, so that two events that start at the
    // same time share one herdr call.
    detection ??= detectHerdr(exec);
    const status = await detection;

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
    const store = await openTaskList(ctx, deps);
    if (store === undefined || session !== undefined) {
      return;
    }
    session = {
      store,
      actor: LEAD,
      now: deps.now,
      taskTypes: DEFAULT_TASK_TYPE_DEFINITIONS,
    };
    registerTaskTools(pi, session);
    registerWorkGate(pi, session);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    session?.store.close();
    if (ctx.hasUI) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  });
}

/** The agent of the lead pi session. Sub-agents get their own name later. */
const LEAD: Actor = { name: "lead" };

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
 * Opens the task list of the current session. Makes it with the task `T0`
 * when it does not exist. Returns `undefined` when the storage fails.
 */
async function openTaskList(ctx: ExtensionContext, deps: TauDependencies): Promise<TaskListStore | undefined> {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    const store = new TaskListStore(taskListFile(tauDir(deps.agentDir()), sessionId));
    await store.ensure(() => seedTaskList(sessionId, deps.now()));
    return store;
  } catch (error) {
    report(ctx, error instanceof TauError ? error.message : `tau cannot open the task list: ${String(error)}`);
    return undefined;
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
