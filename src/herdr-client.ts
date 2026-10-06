/**
 * The herdr commands that tau uses to start and watch sub-agents.
 *
 * All commands run the herdr binary from `HERDR_BIN_PATH` (see `herdr.ts`),
 * without a shell. herdr replies with JSON on stdout, and with a JSON error
 * on stderr.
 */

import type { Exec } from "./herdr.ts";
import { TauError } from "./tasks/errors.ts";
import { cleanLine } from "./text.ts";

/** The maximum time for a herdr command, in milliseconds. */
const COMMAND_TIMEOUT_MS = 15_000;
/** The minimum time for a new agent to start to work on its first prompt. */
export const WORK_START_TIMEOUT_MS = 10_000;
/** The default maximum time for a sub-agent to start, in milliseconds. */
export const AGENT_START_TIMEOUT_MS = 60_000;
/** The maximum value of the start timeout: the maximum of `herdr agent start --timeout`. */
export const MAX_AGENT_START_TIMEOUT_MS = 300_000;
/** The maximum time for the shell of a new pane to be ready, in milliseconds. */
const SHELL_READY_TIMEOUT_MS = 15_000;

/**
 * A herdr command failed. `herdrCode` is the error code of herdr, if it gave
 * one. `timedOut` is true when tau stopped the command because it did not
 * reply in time.
 */
export class HerdrError extends TauError {
  readonly herdrCode: string | undefined;
  readonly timedOut: boolean;

  constructor(message: string, herdrCode: string | undefined, timedOut = false) {
    super("storage", message);
    this.herdrCode = herdrCode;
    this.timedOut = timedOut;
  }
}

/** The maximum number of characters of a herdr error text in a `StartTimeoutError`. */
const MAX_CAUSE_CHARS = 500;

/**
 * The start of a sub-agent timed out: pi was not ready in its pane
 * (`ready`), or it did not start to work on its first prompt (`work`).
 */
export class StartTimeoutError extends TauError {
  readonly timeoutMs: number;
  readonly phase: "ready" | "work";

  constructor(phase: "ready" | "work", timeoutMs: number, cause: string) {
    const what = phase === "ready" ? "pi was not ready in the new pane" : "pi did not start to work on its first prompt";
    const short = [...cleanLine(cause)].slice(0, MAX_CAUSE_CHARS).join("");
    super(
      "storage",
      `The start timed out: ${what} in ${Math.ceil(timeoutMs / 1_000)} seconds (${short}). ` +
        `The computer can be slow now (for example, a high CPU load). ` +
        `Try again with a higher start_timeout_seconds (the default is ${AGENT_START_TIMEOUT_MS / 1_000}, the maximum is ${MAX_AGENT_START_TIMEOUT_MS / 1_000}).`,
    );
    this.timeoutMs = timeoutMs;
    this.phase = phase;
  }
}

/** True when a herdr error tells that a herdr command or its wait timed out. */
function isTimeout(error: unknown): boolean {
  if (!(error instanceof HerdrError)) return false;
  if (error.timedOut) return true;
  return /time[ds]?[ _-]?out/iu.test(`${error.herdrCode ?? ""} ${error.message}`);
}

export type SplitDirection = "right" | "down";

/** A live agent that herdr knows. */
export interface HerdrAgent {
  readonly name: string | undefined;
  readonly paneId: string;
  /** `idle`, `working`, `blocked`, `done`, or `unknown`. */
  readonly status: string;
  /**
   * The pi session of the agent, as the herdr pi integration reports it (a
   * session file path or a session ID). It stays the same when the pane
   * moves or the agent gets a different name.
   */
  readonly session?: string | undefined;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The layout of the tab of a pane: the rectangle of each pane, and the splits. */
export interface PaneLayout {
  readonly panes: ReadonlyMap<string, Rect>;
  readonly splits: ReadonlyArray<{ readonly direction: string; readonly ratio: number; readonly rect: Rect }>;
}

export interface PaneMetadata {
  readonly source: string;
  readonly title?: string;
  readonly displayAgent?: string;
  readonly tokens?: Readonly<Record<string, string>>;
  /** Tokens to remove (for example a token of an earlier report). */
  readonly clearTokens?: readonly string[];
}

export class HerdrClient {
  readonly #exec: Exec;
  readonly #binary: string;

  constructor(exec: Exec, binary: string) {
    this.#exec = exec;
    this.#binary = binary;
  }

  /**
   * The direction to split a pane: `right` for a wide pane, `down` for a
   * narrow or tall pane. A terminal cell is about two times as tall as it is
   * wide.
   */
  async splitDirection(paneId: string): Promise<SplitDirection> {
    try {
      const reply = await this.#run(["pane", "layout", "--pane", paneId]);
      const panes = field(field(field(reply, "result"), "layout"), "panes");
      const pane = Array.isArray(panes) ? panes.find((item) => field(item, "pane_id") === paneId) : undefined;
      const rect = field(pane, "rect");
      const width = Number(field(rect, "width"));
      const height = Number(field(rect, "height"));
      if (Number.isFinite(width) && Number.isFinite(height) && height > 0) {
        return width >= height * 2 ? "right" : "down";
      }
    } catch {
      // Use the default below.
    }
    return "right";
  }

  /**
   * Splits a pane and returns the ID of the new pane. The new pane does not
   * get the focus. `env` goes to the shell of the new pane, and from there to
   * the programs that it starts.
   */
  async splitPane(
    paneId: string,
    options: { direction: SplitDirection; cwd: string; env: Readonly<Record<string, string>>; ratio?: number },
  ): Promise<string> {
    const args = ["pane", "split", "--pane", paneId, "--direction", options.direction, "--cwd", options.cwd, "--no-focus"];
    // The share of the old pane.
    if (options.ratio !== undefined) args.push("--ratio", String(options.ratio));
    for (const [key, value] of Object.entries(options.env)) {
      args.push("--env", `${key}=${value}`);
    }
    const reply = await this.#run(args);
    const id = field(field(field(reply, "result"), "pane"), "pane_id");
    if (typeof id !== "string" || id === "") {
      throw new TauError("storage", "herdr split the pane, but its reply has no pane ID.");
    }
    return id;
  }

  /**
   * Starts a pi agent in a pane. Returns when the agent is ready for input.
   * A new pane needs some time before its shell is ready: while herdr
   * replies `agent_pane_busy`, this function waits and tries again.
   * `timeoutMs` is the time that herdr waits for pi to be ready. When it
   * ends, this function throws a `StartTimeoutError`.
   */
  async startPiAgent(name: string, paneId: string, piArgs: readonly string[], timeoutMs = AGENT_START_TIMEOUT_MS): Promise<void> {
    const timeout = checkStartTimeout(timeoutMs);
    // The start timeout is also for the time while the shell is not ready
    // (but that time is at least SHELL_READY_TIMEOUT_MS). Each try gets the
    // time that is left.
    const deadline = Date.now() + Math.max(timeout, SHELL_READY_TIMEOUT_MS);
    for (;;) {
      const left = Math.max(1, Math.min(timeout, deadline - Date.now()));
      const args = ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", String(left), "--", ...piArgs];
      try {
        await this.#run(args, left + COMMAND_TIMEOUT_MS);
        return;
      } catch (error) {
        if (isTimeout(error)) {
          throw new StartTimeoutError("ready", timeout, (error as HerdrError).message);
        }
        if (!(error instanceof HerdrError) || error.herdrCode !== "agent_pane_busy") throw error;
        if (Date.now() >= deadline) {
          throw new StartTimeoutError("ready", timeout, `the shell of the new pane was not ready: ${error.message}`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * Waits until herdr shows that the agent works on a prompt, waits for
   * the user, or did its turn (`working`, `blocked`, or `done`). Sends no
   * key. Fails after `timeoutMs` (at least `WORK_START_TIMEOUT_MS`): for
   * example, pi could not send the first prompt to the model (no login),
   * and it stays idle. When the time ends, throws a `StartTimeoutError`.
   */
  async waitForWork(name: string, timeoutMs = WORK_START_TIMEOUT_MS): Promise<void> {
    const timeout = Math.max(WORK_START_TIMEOUT_MS, Math.min(Math.ceil(timeoutMs), MAX_AGENT_START_TIMEOUT_MS));
    try {
      await this.#run(
        ["agent", "wait", name, "--until", "working", "--until", "blocked", "--until", "done", "--timeout", String(timeout)],
        timeout + COMMAND_TIMEOUT_MS,
      );
    } catch (error) {
      if (isTimeout(error)) throw new StartTimeoutError("work", timeout, (error as HerdrError).message);
      throw error;
    }
  }

  /** The layout of the tab of a pane. */
  async layout(paneId: string): Promise<PaneLayout> {
    const reply = await this.#run(["pane", "layout", "--pane", paneId]);
    const layout = field(field(reply, "result"), "layout");
    const panes = field(layout, "panes");
    const splits = field(layout, "splits");
    if (!Array.isArray(panes) || !Array.isArray(splits)) {
      throw new TauError("storage", "herdr replied to `pane layout` without panes and splits.");
    }
    const result = new Map<string, Rect>();
    for (const pane of panes) {
      const id = field(pane, "pane_id");
      const rect = toRect(field(pane, "rect"));
      if (typeof id === "string" && rect !== undefined) result.set(id, rect);
    }
    return {
      panes: result,
      splits: splits.flatMap((split) => {
        const direction = field(split, "direction");
        const ratio = field(split, "ratio");
        const rect = toRect(field(split, "rect"));
        return typeof direction === "string" && typeof ratio === "number" && Number.isFinite(ratio) && rect !== undefined
          ? [{ direction, ratio, rect }]
          : [];
      }),
    };
  }

  /**
   * Moves an edge of a pane: `down` moves its bottom edge down, `up` moves
   * its top edge up (or its bottom edge, for the top pane). `amount` is a
   * share of the split that has the edge.
   */
  async resizePane(paneId: string, direction: "up" | "down" | "left" | "right", amount: number): Promise<void> {
    await this.#run(["pane", "resize", "--pane", paneId, "--direction", direction, "--amount", amount.toFixed(4)]);
  }

  /** The live agents that herdr knows. */
  async listAgents(): Promise<HerdrAgent[]> {
    const reply = await this.#run(["agent", "list"]);
    const agents = field(field(reply, "result"), "agents");
    if (!Array.isArray(agents)) {
      throw new TauError("storage", "herdr replied to `agent list` without a list of agents.");
    }
    return agents.flatMap((agent) => {
      const paneId = field(agent, "pane_id");
      if (typeof paneId !== "string") return [];
      const name = field(agent, "name");
      const status = field(agent, "agent_status");
      const session = field(field(agent, "agent_session"), "value");
      return [
        {
          name: typeof name === "string" ? name : undefined,
          paneId,
          status: typeof status === "string" ? status : "unknown",
          session: typeof session === "string" && session !== "" ? session : undefined,
        },
      ];
    });
  }

  /** The IDs of all panes of the herdr session. */
  async listPanes(): Promise<Set<string>> {
    const reply = await this.#run(["pane", "list"]);
    const panes = field(field(reply, "result"), "panes");
    if (!Array.isArray(panes)) {
      throw new TauError("storage", "herdr replied to `pane list` without a list of panes.");
    }
    return new Set(panes.map((pane) => field(pane, "pane_id")).filter((id): id is string => typeof id === "string"));
  }

  /** Gives a new herdr name to the agent in a pane (or with a name). */
  async renameAgent(target: string, name: string): Promise<void> {
    await this.#run(["agent", "rename", target, name]);
  }

  async closePane(paneId: string): Promise<void> {
    await this.#run(["pane", "close", paneId]);
  }

  /** Sets display-only metadata of a pane (title, agent label, tokens). */
  async reportMetadata(paneId: string, metadata: PaneMetadata): Promise<void> {
    const args = ["pane", "report-metadata", paneId, "--source", metadata.source];
    if (metadata.title !== undefined) args.push("--title", metadata.title);
    if (metadata.displayAgent !== undefined) args.push("--display-agent", metadata.displayAgent);
    for (const [name, value] of Object.entries(metadata.tokens ?? {})) {
      args.push("--token", `${name}=${value}`);
    }
    for (const name of metadata.clearTokens ?? []) {
      args.push("--clear-token", name);
    }
    await this.#run(args);
  }

  /** Removes the metadata that `reportMetadata` set for a source. */
  async clearMetadata(paneId: string, source: string, tokens: readonly string[] = []): Promise<void> {
    const args = ["pane", "report-metadata", paneId, "--source", source, "--clear-title", "--clear-display-agent"];
    for (const token of tokens) args.push("--clear-token", token);
    await this.#run(args);
  }

  async #run(args: string[], timeout = COMMAND_TIMEOUT_MS): Promise<unknown> {
    let result;
    try {
      result = await this.#exec(this.#binary, args, { timeout });
    } catch (error) {
      throw new TauError("storage", `herdr ${args[0]} ${args[1]} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (result.killed) {
      throw new HerdrError(`herdr ${args[0]} ${args[1]} did not reply in time`, undefined, true);
    }
    if (result.code !== 0) {
      const error = field(parseJson(result.stderr) ?? parseJson(result.stdout), "error");
      const message = field(error, "message");
      const code = field(error, "code");
      throw new HerdrError(
        `herdr ${args[0]} ${args[1]} failed: ${typeof message === "string" ? message : `exit code ${result.code}`}`,
        typeof code === "string" ? code : undefined,
      );
    }
    return parseJson(result.stdout);
  }
}

/** Checks a start timeout: an integer from 1 to `MAX_AGENT_START_TIMEOUT_MS` milliseconds. */
export function checkStartTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_AGENT_START_TIMEOUT_MS) {
    throw new TauError(
      "invalid_argument",
      `The start timeout must be from 1 to ${MAX_AGENT_START_TIMEOUT_MS / 1_000} seconds.`,
    );
  }
  return timeoutMs;
}

function toRect(value: unknown): Rect | undefined {
  const [x, y, width, height] = ["x", "y", "width", "height"].map((name) => field(value, name));
  const numbers = [x, y, width, height];
  if (!numbers.every((item) => typeof item === "number" && Number.isFinite(item))) return undefined;
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function field(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[name];
}
