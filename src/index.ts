import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { WIDGET_KEY, widgetLines } from "./badge.ts";
import { detectHerdr, type Exec, type HerdrStatus } from "./herdr.ts";
import { TauError } from "./tasks/errors.ts";
import { seedTaskList } from "./tasks/model.ts";
import { taskListFile, tauDir } from "./tasks/paths.ts";
import { TaskListStore } from "./tasks/store.ts";

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
 * it with the task `T0` if it does not exist.
 */
export default function tau(pi: ExtensionAPI): void {
  createTau(pi, DEFAULT_DEPENDENCIES);
}

export function createTau(pi: ExtensionAPI, deps: TauDependencies): void {
  const exec: Exec = (command, args, options) => pi.exec(command, args, options);
  let detection: Promise<HerdrStatus> | undefined;

  pi.on("session_start", async (_event, ctx) => {
    // Keep the promise, not the result, so that two events that start at the
    // same time share one herdr call.
    detection ??= detectHerdr(exec);
    const status = await detection;

    if (ctx.hasUI) {
      ctx.ui.setWidget(WIDGET_KEY, widgetLines(status));
    }
    if (status.available) {
      await openTaskList(ctx, deps);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
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
    const message = error instanceof TauError ? error.message : `tau cannot open the task list: ${String(error)}`;
    if (ctx.hasUI) {
      ctx.ui.notify(message, "error");
    } else {
      // There is no UI (print or JSON mode). Write the error to stderr, so
      // that it is not lost.
      console.error(`tau: ${message}`);
    }
    return undefined;
  }
}
