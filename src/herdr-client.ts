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
/** The time for an agent to start to work on a prompt. Less than COMMAND_TIMEOUT_MS. */
const PROMPT_START_TIMEOUT_MS = 10_000;
/** The herdr codes of a prompt that the agent did not start to work on. */
const STALLED_CODES: ReadonlySet<string> = new Set(["agent_prompt_stalled", "timeout"]);
/** The herdr states of an agent that works on a prompt, or did. */
const STARTED_STATES: ReadonlySet<string> = new Set(["working", "blocked", "done"]);
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
   * Sends a prompt to an agent, and checks that the agent starts to work on
   * it. Does not wait for the answer.
   *
   * pi can lose the Enter key of the prompt while it starts: then the text
   * stays in its editor, and the agent stays idle. herdr tells this
   * (`agent_prompt_stalled`). Then tau reads the state of the agent: when
   * it is `working`, `blocked` (for example, it asks the user a question:
   * an Enter key would select an answer), or `done`, the agent started.
   * When it is `idle`, tau sends one Enter key, and checks again (an Enter
   * key in an empty editor does nothing). In all other cases (for example
   * `unknown`, or herdr does not show the agent), tau sends no key, and the
   * prompt fails. Each wait takes at most `PROMPT_START_TIMEOUT_MS`.
   */
  async prompt(name: string, text: string): Promise<void> {
    const timeout = ["--timeout", String(PROMPT_START_TIMEOUT_MS)];
    try {
      await this.#run(["agent", "prompt", name, text, "--wait", "--until", "working", "--until", "blocked", ...timeout]);
      return;
    } catch (error) {
      if (!(error instanceof HerdrError) || !STALLED_CODES.has(error.herdrCode ?? "")) throw error;
    }
    const agent = (await this.listAgents()).find((item) => item.name === name);
    if (agent !== undefined && STARTED_STATES.has(agent.status)) return;
    if (agent?.status !== "idle") {
      throw new HerdrError(
        `herdr agent prompt failed: ${name} did not start to work on its first prompt, and its state is ${agent === undefined ? "not known to herdr" : JSON.stringify(agent.status)}.`,
        "agent_prompt_stalled",
      );
    }
    await this.#run(["agent", "send-keys", name, "Enter"]);
    try {
      // "done": the agent did its turn already.
      await this.#run(["agent", "wait", name, "--until", "working", "--until", "blocked", "--until", "done", ...timeout]);
    } catch (error) {
      if (!(error instanceof HerdrError) || !STALLED_CODES.has(error.herdrCode ?? "")) throw error;
      throw new HerdrError(
        `herdr agent prompt failed: ${name} did not start to work on its first prompt (also after one more Enter key).`,
        error.herdrCode,
      );
    }
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
