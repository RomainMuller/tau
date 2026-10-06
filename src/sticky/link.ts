/**
 * The link of one pi process to the stickies, through `sticky server` (see
 * `server.ts`): it sends the record of the agent of the process.
 *
 * - The server keeps the Bluetooth connections, and sends each write to all
 *   the ready stickies. tau does not use Bluetooth itself.
 * - tau does not start a server: when no server runs, tau sends nothing,
 *   and tries again at the next refresh.
 * - tau sends the metadata, then the state. It waits for the response of
 *   each write before the next one (the writes of one agent go one after
 *   the other). When the record changes during a write, tau sends the new
 *   values after that write.
 * - From time to time (`refreshMs`), tau sends the full record again: the
 *   sticky keeps the agents only while its Agents app is open.
 *
 * Errors never go to the caller: the stickies are only for display. The
 * `log` option gets one line for each problem.
 */

import {
  AGENT_METADATA_UUID,
  AGENT_STATE_UUID,
  type AgentState,
  encodeMetadata,
  encodeState,
  type MetadataKey,
} from "./protocol.ts";
import { ServerAbsentError, ServerResponseError, type StickyServer } from "./server.ts";

/** What tau sends for one agent. A metadata value `""` removes the key. */
export interface AgentRecord {
  readonly sessionId: string;
  readonly state: AgentState;
  /** The metadata, in the order of the writes. */
  readonly metadata: ReadonlyArray<readonly [MetadataKey, string]>;
}

export interface StickyLinkOptions {
  readonly server: StickyServer;
  readonly log?: (message: string) => void;
  /**
   * Gets `false` when a request finds no server, and `true` when a request
   * finds the server again. It gets only the changes (not each request).
   * Errors of this function do not go to the link.
   */
  readonly onServer?: (found: boolean) => void;
  /** The time between two full sends. */
  readonly refreshMs?: number;
  /** The time before tau writes again after a "Busy" error of a sticky. */
  readonly retryMs?: number;
}

export const DEFAULT_REFRESH_MS = 30_000;
const DEFAULT_RETRY_MS = 1_000;
/** "Busy" errors in sequence before tau stops the writes until the next change or refresh. */
const MAX_BUSY = 3;
/** The maximum number of log lines for the results of one write. */
const MAX_LOG_LINES = 8;
/** The text of the "Busy" ATT error of the sticky in a write result. */
const BUSY = "(ATT error 0x80)";

export class StickyLink {
  readonly #server: StickyServer;
  readonly #log: (message: string) => void;
  readonly #onServer: (found: boolean) => void;
  readonly #refreshMs: number;
  readonly #retryMs: number;

  #record: AgentRecord | undefined;
  #metadataDirty = false;
  #stateDirty = false;
  #pumping: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #started = false;
  #stopped = false;
  /** True after the last request found no server: log only the change. */
  #absent = false;

  constructor(options: StickyLinkOptions) {
    this.#server = options.server;
    this.#log = options.log ?? (() => undefined);
    this.#onServer = options.onServer ?? (() => undefined);
    this.#refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
    this.#retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  }

  /** Starts the refresh timer, and sends the record. Call it one time. */
  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#timer = setInterval(() => this.refresh(), this.#refreshMs);
    this.#timer.unref?.();
    void this.#pump();
  }

  /**
   * Sets the record of the agent, and sends the changes. After a record with
   * the state `terminated`, tau sends no other record.
   */
  publish(record: AgentRecord): void {
    if (this.#stopped) return;
    const previous = this.#record;
    if (previous?.state === "terminated") return;
    this.#record = record;
    if (previous === undefined || !sameMetadata(previous, record)) this.#metadataDirty = true;
    if (previous === undefined || previous.state !== record.state || previous.sessionId !== record.sessionId) {
      this.#stateDirty = true;
    }
    if (this.#started) void this.#pump();
  }

  /** Sends the full record again. The timer calls it. */
  refresh(): void {
    if (this.#stopped || this.#record === undefined) return;
    this.#metadataDirty = true;
    this.#stateDirty = true;
    void this.#pump();
  }

  /** Waits until the record is sent, at most `timeoutMs`. Never throws. */
  async flush(timeoutMs: number): Promise<void> {
    if (this.#stopped || this.#pumping === undefined) return;
    await waitAtMost(this.#pumping, timeoutMs);
  }

  /** Sends the record (wait at most `timeoutMs`), then stops. Never throws. */
  async close(timeoutMs: number): Promise<void> {
    if (this.#stopped) return;
    if (this.#started) {
      const pumping = this.#pump();
      await waitAtMost(pumping, timeoutMs);
    }
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    try {
      this.#server.close();
    } catch (error) {
      this.#log(`close: ${message(error)}`);
    }
  }

  /** One pump at a time: the writes go one after the other. */
  #pump(): Promise<void> {
    this.#pumping ??= this.#writeAll().finally(() => {
      this.#pumping = undefined;
    });
    return this.#pumping;
  }

  async #writeAll(): Promise<void> {
    let busy = 0;
    while (!this.#stopped) {
      const record = this.#record;
      if (record === undefined || (!this.#metadataDirty && !this.#stateDirty)) return;
      let ok = true;
      try {
        // The metadata first: the sticky must not show a new state with old
        // metadata. A publish during a metadata write sets the flag again:
        // then send the new metadata before the state.
        while (this.#metadataDirty && !this.#stopped) {
          this.#metadataDirty = false;
          const latest = this.#record ?? record;
          // The sticky removes the metadata of a terminated agent.
          if (latest.state === "terminated") break;
          for (const value of encodeMetadata(latest.sessionId, latest.metadata)) {
            ok = (await this.#write("metadata", AGENT_METADATA_UUID, value)) && ok;
            if (this.#stopped) return;
          }
        }
        if (this.#stateDirty && !this.#stopped) {
          // The latest state: a publish during the metadata writes can change it.
          this.#stateDirty = false;
          const latest = this.#record ?? record;
          ok = (await this.#write("state", AGENT_STATE_UUID, encodeState(latest.sessionId, latest.state))) && ok;
        }
      } catch (error) {
        if (this.#stopped) {
          // A late answer after the close: nothing to log.
        } else if (error instanceof ServerAbsentError) {
          if (!this.#absent) {
            this.#absent = true;
            this.#log(`no server: ${message(error)}`);
            this.#tellServer(false);
          }
        } else {
          // An `error` response comes from the server: thus it runs.
          if (error instanceof ServerResponseError) this.#found();
          this.#log(`write: ${message(error)}`);
        }
        // Not sent: the next change or the next refresh sends all again.
        // Do not loop here: a server without a sticky answers after 10 s.
        this.#metadataDirty = true;
        this.#stateDirty = true;
        return;
      }
      if (ok) {
        busy = 0;
        continue;
      }
      // A sticky was busy: send all again soon (the same values give the same result).
      this.#metadataDirty = true;
      this.#stateDirty = true;
      busy += 1;
      if (busy >= MAX_BUSY) return;
      await sleep(this.#retryMs);
    }
  }

  /** A response came from the server. */
  #found(): void {
    if (!this.#absent) return;
    this.#absent = false;
    this.#log("server found.");
    this.#tellServer(true);
  }

  #tellServer(found: boolean): void {
    try {
      this.#onServer(found);
    } catch (error) {
      this.#log(`onServer: ${message(error)}`);
    }
  }

  /** Sends one write. Returns false when a sticky was busy. Throws when the request failed. */
  async #write(what: string, characteristic: string, value: Buffer): Promise<boolean> {
    const devices = await this.#server.write(characteristic, value);
    if (this.#stopped) return true;
    this.#found();
    let ok = true;
    let logged = 0;
    for (const device of devices) {
      if (device.error === null) continue;
      if (device.error.endsWith(BUSY)) ok = false;
      // A limit for a bad server: few lines for one write.
      if (logged < MAX_LOG_LINES) this.#log(`${clean(device.identifier)}: ${what}: ${clean(device.error)}`);
      logged += 1;
    }
    if (logged > MAX_LOG_LINES) this.#log(`${what}: ${logged - MAX_LOG_LINES} more errors`);
    return ok;
  }
}

function sameMetadata(a: AgentRecord, b: AgentRecord): boolean {
  return a.sessionId === b.sessionId && JSON.stringify(a.metadata) === JSON.stringify(b.metadata);
}

function message(error: unknown): string {
  return clean(error instanceof Error ? error.message : String(error));
}

/** The server can send text of a sticky: no control characters in the log. */
function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      // Not unref: close() must keep the process until the last write
      // (or the time). The time is short.
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}
