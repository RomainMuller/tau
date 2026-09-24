import { isAbsolute } from "node:path";

/**
 * Detection of the herdr terminal multiplexer.
 *
 * tau works only when herdr controls the pane of the current pi process. The
 * check has two parts:
 *
 * 1. The environment variable `HERDR_ENV` is `1`. Herdr sets it in each pane
 *    that it manages.
 * 2. The command `herdr pane current --current` succeeds, and its output
 *    identifies a pane. This proves that the herdr server is running and
 *    that the CLI can reach it.
 *
 * Herdr also sets `HERDR_BIN_PATH` to the absolute path of its binary. tau
 * runs only that path. It does not search `PATH`, because a different
 * `herdr` program earlier in `PATH` can run with the permissions of pi. When
 * `HERDR_BIN_PATH` is not an absolute path, herdr is not available.
 */

/** The result of a command. This is the shape that `pi.exec` returns. */
export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly killed: boolean;
}

/** Runs a command without a shell. This is the signature of `pi.exec`. */
export type Exec = (
  command: string,
  args: string[],
  options?: { timeout?: number; signal?: AbortSignal },
) => Promise<ExecResult>;

/** Information about the herdr pane that contains the current pi process. */
export interface HerdrPane {
  readonly paneId: string;
  readonly tabId: string | undefined;
  readonly workspaceId: string | undefined;
}

export type HerdrStatus =
  | {
      readonly available: true;
      /** The herdr binary to use for all later herdr commands. */
      readonly binary: string;
      readonly pane: HerdrPane;
    }
  | { readonly available: false; readonly reason: string };

export interface DetectOptions {
  /** The environment to check. The default is `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** The maximum time for the herdr CLI call, in milliseconds. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** The default maximum time for the herdr CLI call, in milliseconds. */
export const DEFAULT_DETECT_TIMEOUT_MS = 3_000;

/**
 * Gets the herdr binary to run: `HERDR_BIN_PATH` when it is an absolute path.
 * Returns `undefined` for all other values.
 */
export function herdrBinary(env: NodeJS.ProcessEnv): string | undefined {
  const binPath = env.HERDR_BIN_PATH;
  return binPath !== undefined && isAbsolute(binPath) ? binPath : undefined;
}

/**
 * Checks if herdr controls the current pane.
 *
 * This function does not throw. All problems give `available: false` with a
 * reason that a person can read. The reason can contain text from herdr, so
 * clean it before you show it in the terminal or give it to a model.
 */
export async function detectHerdr(
  exec: Exec,
  options: DetectOptions = {},
): Promise<HerdrStatus> {
  const env = options.env ?? process.env;
  if (env.HERDR_ENV !== "1") {
    return { available: false, reason: "HERDR_ENV is not set to 1" };
  }

  const binary = herdrBinary(env);
  if (binary === undefined) {
    return { available: false, reason: "HERDR_BIN_PATH is not an absolute path" };
  }

  let result: ExecResult;
  try {
    result = await exec(binary, ["pane", "current", "--current"], {
      timeout: options.timeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    return {
      available: false,
      reason: `cannot run herdr: ${errorMessage(error)}`,
    };
  }

  if (result.killed) {
    return { available: false, reason: "herdr did not reply in time" };
  }
  if (result.code !== 0) {
    return {
      available: false,
      reason: herdrErrorMessage(result) ?? `herdr exited with code ${result.code}`,
    };
  }

  const pane = parsePaneCurrent(result.stdout);
  if (pane === undefined) {
    return { available: false, reason: "herdr returned an unexpected reply" };
  }
  return { available: true, binary, pane };
}

/**
 * Reads the reply of `herdr pane current`. Returns `undefined` if the reply
 * does not identify a pane.
 */
export function parsePaneCurrent(stdout: string): HerdrPane | undefined {
  const reply = parseJson(stdout);
  const pane = field(field(reply, "result"), "pane");
  const paneId = field(pane, "pane_id");
  if (typeof paneId !== "string" || paneId === "") {
    return undefined;
  }
  return {
    paneId,
    tabId: stringOrUndefined(field(pane, "tab_id")),
    workspaceId: stringOrUndefined(field(pane, "workspace_id")),
  };
}

/** Gets the error message from a herdr JSON error reply, if there is one. */
function herdrErrorMessage(result: ExecResult): string | undefined {
  for (const text of [result.stderr, result.stdout]) {
    const message = field(field(parseJson(text), "error"), "message");
    if (typeof message === "string" && message !== "") {
      return message;
    }
  }
  return undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function field(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[name];
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
