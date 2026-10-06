/**
 * A client of `sticky server` (the server of the `sticky` command of the
 * sticky repository). The server keeps the Bluetooth connections to the
 * stickies. tau sends it requests on its UNIX domain socket: one JSON line
 * for each connection, then one JSON line back (server protocol version 2).
 * See the README of `tools/sticky-cli`, section "The server protocol".
 *
 * tau does not start a server. When the socket is not there (or it is not a
 * socket of the current user), a request fails with `ServerAbsentError`, and
 * tau tries again later.
 */

import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { SERVICE_UUID } from "./protocol.ts";

/** The variable that sets the socket path (the same as for the `sticky` command). */
export const ENV_STICKY_SOCKET = "STICKY_SOCKET";
/** The version of the server protocol (not the Bluetooth protocol). */
export const SERVER_PROTOCOL_VERSION = 2;
/** The maximum time of one request. The server can wait 10 s for a sticky, then 30 s for the writes. */
export const REQUEST_MS = 60_000;
/** The maximum length of a response line. A write response is small: this is only a limit. */
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** The maximum number of stickies that tau reads in one response (the server uses 8 at most). */
export const MAX_DEVICES = 16;

/** The socket path: `STICKY_SOCKET`, else the default path on macOS. `undefined` when there is none. */
export function stickySocketPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | undefined {
  const fromEnv = env[ENV_STICKY_SOCKET];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (platform !== "darwin") return undefined;
  return join(homedir(), "Library", "Caches", "sticky", "S.sticky");
}

/** No server listens on the socket (no socket file, the connection is refused, or the file is not safe). */
export class ServerAbsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerAbsentError";
  }
}

/**
 * The server answered with an `error` response (for example, when no sticky
 * is near). The server runs: this is not `ServerAbsentError`.
 */
export class ServerResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerResponseError";
  }
}

/** The result of a write on one sticky. `error` is `null` when the sticky accepted the value. */
export interface DeviceWrite {
  readonly identifier: string;
  readonly error: string | null;
}

/** The operations of the server that tau uses. The tests use a fake. */
export interface StickyServer {
  /**
   * Writes `value` to a characteristic of the sticky service, on each ready
   * sticky (a Write Request). Resolves with one item for each sticky.
   * Rejects with `ServerAbsentError` when no server runs, with
   * `ServerResponseError` for an `error` response, and with an `Error`
   * for a different problem.
   */
  write(characteristicUuid: string, value: Buffer): Promise<DeviceWrite[]>;
  /** Stops the requests that run now (they reject). */
  close(): void;
}

export interface SocketStickyServerOptions {
  readonly path: string;
  /**
   * True when tau made the path (not `STICKY_SOCKET`). Then the directory
   * must be private (as the `sticky` command makes it). Else other users
   * must not be able to replace the socket in the directory.
   */
  readonly defaultPath: boolean;
  readonly requestMs?: number;
  /** The user ID of this process. The default is `process.getuid()`. */
  readonly uid?: number;
}

/** The `StickyServer` of `sticky server`, on its UNIX socket. */
export class SocketStickyServer implements StickyServer {
  readonly #path: string;
  readonly #defaultPath: boolean;
  readonly #requestMs: number;
  readonly #uid: number | undefined;
  readonly #open = new Set<Socket>();
  #closed = false;

  constructor(options: SocketStickyServerOptions) {
    this.#path = options.path;
    this.#defaultPath = options.defaultPath;
    this.#requestMs = options.requestMs ?? REQUEST_MS;
    this.#uid = options.uid ?? process.getuid?.();
  }

  async write(characteristicUuid: string, value: Buffer): Promise<DeviceWrite[]> {
    if (this.#closed) throw new Error("the client is closed");
    const socketPath = await this.#checkSocket();
    // close() can come during the checks: then do not connect.
    if (this.#closed) throw new Error("the client is closed");
    const request = {
      version: SERVER_PROTOCOL_VERSION,
      command: { write: { attribute: { service: SERVICE_UUID, characteristic: characteristicUuid }, value: [...value] } },
    };
    return parseWriteResponse(await this.#request(socketPath, JSON.stringify(request)));
  }

  close(): void {
    this.#closed = true;
    for (const socket of this.#open) socket.destroy();
    this.#open.clear();
  }

  /**
   * Connect only to a socket of the current user. Node cannot read the user
   * of the peer of a UNIX socket, thus tau checks the path too: other users
   * must not be able to replace the socket, or a directory of its path,
   * after this check. Returns the path to connect to (without symbolic
   * links).
   *
   * - The default directory must be a real directory of the current user,
   *   with no access for other users (the `sticky` command makes it so).
   * - Each directory of the real path (also for `STICKY_SOCKET`) must
   *   belong to the current user or to root, and other users must not be
   *   able to write to it, except with the sticky bit (as `/tmp`).
   */
  async #checkSocket(): Promise<string> {
    const dirPath = dirname(this.#path);
    if (this.#defaultPath) {
      const dir = await lstatOrAbsent(dirPath);
      if (!dir.isDirectory() || !this.#owned(dir.uid, false) || (dir.mode & 0o077) !== 0) {
        throw new ServerAbsentError(`${dirPath} is not a private directory of the current user`);
      }
    }
    // Connect through the real path: a symbolic link in the path can change
    // after the checks.
    const realDir = await realpath(dirPath).catch((error: unknown) => {
      throw isCode(error, "ENOENT") || isCode(error, "ENOTDIR") ? new ServerAbsentError(`no directory ${dirPath}`) : error;
    });
    for (let current = realDir; ; current = dirname(current)) {
      const dir = await lstatOrAbsent(current);
      const othersWrite = (dir.mode & 0o022) !== 0 && (dir.mode & 0o1000) === 0;
      if (!dir.isDirectory() || !this.#owned(dir.uid, true) || othersWrite) {
        throw new ServerAbsentError(`other users can replace the socket in ${current}`);
      }
      if (dirname(current) === current) break;
    }
    const socketPath = join(realDir, basename(this.#path));
    const info = await lstatOrAbsent(socketPath);
    if (!info.isSocket()) throw new ServerAbsentError(`${socketPath} is not a socket`);
    if (!this.#owned(info.uid, false)) throw new ServerAbsentError(`${socketPath} belongs to a different user`);
    return socketPath;
  }

  #owned(uid: number, rootToo: boolean): boolean {
    return this.#uid === undefined || uid === this.#uid || (rootToo && uid === 0);
  }

  #request(socketPath: string, line: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      this.#open.add(socket);
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (error: Error | undefined, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#open.delete(socket);
        socket.destroy();
        if (error === undefined) resolve(value);
        else reject(error);
      };
      const timer = setTimeout(() => finish(new Error(`no response in ${this.#requestMs} ms`)), this.#requestMs);
      timer.unref?.();
      socket.on("connect", () => socket.write(`${line}\n`));
      socket.on("data", (chunk: Buffer) => {
        const end = chunk.indexOf(0x0a);
        const part = end === -1 ? chunk : chunk.subarray(0, end);
        size += part.length;
        if (size > MAX_RESPONSE_BYTES) {
          finish(new Error("the response is too long"));
          return;
        }
        chunks.push(part);
        if (end === -1) return;
        try {
          finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          finish(new Error("the response is not JSON"));
        }
      });
      socket.on("error", (error) => {
        // The socket file can go away, or stay after the server stopped.
        if (isCode(error, "ENOENT") || isCode(error, "ECONNREFUSED")) finish(new ServerAbsentError(error.message));
        else finish(error);
      });
      socket.on("close", () => finish(new Error("the server closed the connection before the response")));
    });
  }
}

/** Reads a `write` response (the first `MAX_DEVICES` stickies only). Exported for the tests. */
export function parseWriteResponse(response: unknown): DeviceWrite[] {
  if (isObject(response)) {
    const write = response["write"];
    if (isObject(write) && Array.isArray(write["devices"])) {
      return write["devices"].slice(0, MAX_DEVICES).map((item: unknown) => {
        const identifier = isObject(item) && typeof item["identifier"] === "string" ? item["identifier"] : "?";
        const error = isObject(item) ? item["error"] : "not an object";
        return { identifier, error: error === null ? null : typeof error === "string" ? error : "not known" };
      });
    }
    const error = response["error"];
    if (isObject(error) && typeof error["message"] === "string") throw new ServerResponseError(error["message"]);
  }
  throw new Error("the response is not a write response");
}

/** Makes the `StickyServer` for the environment. `undefined` when there is no socket path (not macOS). */
export function socketStickyServer(env: NodeJS.ProcessEnv): StickyServer | undefined {
  const fromEnv = env[ENV_STICKY_SOCKET];
  const path = stickySocketPath(env);
  if (path === undefined) return undefined;
  return new SocketStickyServer({ path, defaultPath: fromEnv === undefined || fromEnv === "" });
}

/** `lstat`, with `ServerAbsentError` when the file is not there. */
async function lstatOrAbsent(path: string): Promise<Stats> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) throw new ServerAbsentError(`no socket at ${path}`);
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
