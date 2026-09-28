/**
 * The herdr commands that tau uses to start and watch sub-agents.
 *
 * All commands run the herdr binary from `HERDR_BIN_PATH` (see `herdr.ts`),
 * without a shell. herdr replies with JSON on stdout, and with a JSON error
 * on stderr.
 */

import type { Exec } from "./herdr.ts";
import { TauError } from "./tasks/errors.ts";

/** The maximum time for a herdr command, in milliseconds. */
const COMMAND_TIMEOUT_MS = 15_000;
/** The time for a new agent to start to work on its first prompt. Less than COMMAND_TIMEOUT_MS. */
const WORK_START_TIMEOUT_MS = 10_000;
/** The maximum time for a sub-agent to start, in milliseconds. */
export const AGENT_START_TIMEOUT_MS = 60_000;
/** The maximum time for the shell of a new pane to be ready, in milliseconds. */
const SHELL_READY_TIMEOUT_MS = 15_000;

/** A herdr command failed. `herdrCode` is the error code of herdr, if it gave one. */
export class HerdrError extends TauError {
  readonly herdrCode: string | undefined;

  constructor(message: string, herdrCode: string | undefined) {
    super("storage", message);
    this.herdrCode = herdrCode;
  }
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

export interface PaneMetadata {
  readonly source: string;
  readonly title?: string;
  readonly displayAgent?: string;
  readonly tokens?: Readonly<Record<string, string>>;
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
    options: { direction: SplitDirection; cwd: string; env: Readonly<Record<string, string>> },
  ): Promise<string> {
    const args = ["pane", "split", "--pane", paneId, "--direction", options.direction, "--cwd", options.cwd, "--no-focus"];
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
   */
  async startPiAgent(name: string, paneId: string, piArgs: readonly string[]): Promise<void> {
    const args = ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", String(AGENT_START_TIMEOUT_MS), "--", ...piArgs];
    const deadline = Date.now() + SHELL_READY_TIMEOUT_MS;
    for (;;) {
      try {
        await this.#run(args, AGENT_START_TIMEOUT_MS + COMMAND_TIMEOUT_MS);
        return;
      } catch (error) {
        if (!(error instanceof HerdrError) || error.herdrCode !== "agent_pane_busy" || Date.now() >= deadline) {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * Waits until herdr shows that the agent works on a prompt, waits for
   * the user, or did its turn (`working`, `blocked`, or `done`). Sends no
   * key. Fails after `WORK_START_TIMEOUT_MS`: for example, pi could not send
   * the first prompt to the model (no login), and it stays idle.
   */
  async waitForWork(name: string): Promise<void> {
    await this.#run([
      "agent", "wait", name, "--until", "working", "--until", "blocked", "--until", "done", "--timeout", String(WORK_START_TIMEOUT_MS),
    ]);
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
      throw new TauError("storage", `herdr ${args[0]} ${args[1]} did not reply in time.`);
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
