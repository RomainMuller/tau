/**
 * The link of one pi process to the stickies nearby: it finds them, keeps a
 * connection to each, and sends them the record of the agent of the process.
 *
 * - It connects to the stickies of the device cache (with their identifier:
 *   this works also when a different process is connected already), and it
 *   scans for the sticky service.
 * - It uses only a device with the protocol version 1. It ignores a
 *   different device for some time.
 * - For each sticky, it sends the metadata, then the state. When the record
 *   changes during a write, it sends the new values after that write (the
 *   writes of one agent go one after the other).
 * - From time to time (`refreshMs`), it sends the full record again: the
 *   sticky keeps the agents only while its Agents app is open.
 *
 * Errors never go to the caller: Bluetooth is only for display. The `log`
 * option gets one line for each problem.
 */

import type { StickyCentral, StickyConnection } from "./central.ts";
import type { DeviceCache } from "./devices.ts";
import {
  AGENT_METADATA_UUID,
  AGENT_STATE_UUID,
  type AgentState,
  decodeMetadataKeys,
  decodeProtocolVersion,
  encodeMetadata,
  encodeState,
  METADATA_KEYS_UUID,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_UUID,
  SERVICE_UUID,
} from "./protocol.ts";

/** What tau sends for one agent. A metadata value `""` removes the key. */
export interface AgentRecord {
  readonly sessionId: string;
  readonly state: AgentState;
  /** The metadata, in the order of the writes. */
  readonly metadata: ReadonlyArray<readonly [string, string]>;
}

export interface StickyLinkOptions {
  readonly central: StickyCentral;
  readonly cache: Pick<DeviceCache, "read" | "add">;
  readonly log?: (message: string) => void;
  /** The time between two full sends (and two searches). */
  readonly refreshMs?: number;
  /** The maximum time of one connection attempt. */
  readonly connectMs?: number;
  /** The time before tau writes again after an error. */
  readonly retryMs?: number;
  /** The time that tau ignores a device that is not a sticky (or that it cannot identify). */
  readonly ignoreMs?: number;
  /** The current time, in milliseconds. */
  readonly now?: () => number;
}

export const DEFAULT_REFRESH_MS = 30_000;
const DEFAULT_CONNECT_MS = 20_000;
const DEFAULT_RETRY_MS = 1_000;
const DEFAULT_IGNORE_MS = 60_000;
/** Errors in sequence before tau stops the writes to a sticky until the next refresh. */
const MAX_FAILURES = 3;
/** The maximum number of connection attempts at the same time. */
const MAX_CONNECTING = 4;
/** The maximum number of devices that wait for a connection attempt. */
const MAX_PENDING = 32;
/** The maximum time of the disconnections at the close. */
const DISCONNECT_MS = 1_000;
/** The time to wait for Bluetooth at the start. */
const POWER_ON_MS = 10_000;

interface Device {
  readonly connection: StickyConnection;
  readonly keys: ReadonlySet<string>;
  metadataDirty: boolean;
  stateDirty: boolean;
  failures: number;
  pumping: Promise<void> | undefined;
}

export class StickyLink {
  readonly #central: StickyCentral;
  readonly #cache: Pick<DeviceCache, "read" | "add">;
  readonly #log: (message: string) => void;
  readonly #refreshMs: number;
  readonly #connectMs: number;
  readonly #retryMs: number;
  readonly #ignoreMs: number;
  readonly #now: () => number;

  #record: AgentRecord | undefined;
  readonly #devices = new Map<string, Device>();
  readonly #connecting = new Set<string>();
  /** The devices that wait for a connection attempt (see `MAX_CONNECTING`). */
  readonly #pending = new Set<string>();
  /** The identifiers of the device cache at the last tick. */
  #known: ReadonlySet<string> = new Set();
  readonly #ignored = new Map<string, number>();
  #timer: NodeJS.Timeout | undefined;
  #started = false;
  #stopped = false;
  #poweredOn = false;
  #scanning = false;
  #ticking: Promise<void> | undefined;

  constructor(options: StickyLinkOptions) {
    this.#central = options.central;
    this.#cache = options.cache;
    this.#log = options.log ?? (() => undefined);
    this.#refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
    this.#connectMs = options.connectMs ?? DEFAULT_CONNECT_MS;
    this.#retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.#ignoreMs = options.ignoreMs ?? DEFAULT_IGNORE_MS;
    this.#now = options.now ?? Date.now;
  }

  /** The identifiers of the connected stickies. Only for tests and logs. */
  get devices(): string[] {
    return [...this.#devices.keys()];
  }

  /** Starts the search. Call it one time. */
  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#central.onPowerChange((on) => {
      if (this.#stopped) return;
      this.#poweredOn = on;
      if (on) {
        void this.tick();
      } else {
        // CoreBluetooth closes all connections when Bluetooth goes off.
        this.#devices.clear();
        this.#scanning = false;
      }
    });
    void this.#central.waitForPoweredOn(POWER_ON_MS).then((on) => {
      if (!on || this.#stopped) return;
      this.#poweredOn = true;
      return this.tick();
    });
    this.#timer = setInterval(() => void this.tick(), this.#refreshMs);
    this.#timer.unref?.();
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
    const metadataChanged = previous === undefined || !sameMetadata(previous, record);
    const stateChanged = previous === undefined || previous.state !== record.state || previous.sessionId !== record.sessionId;
    for (const device of this.#devices.values()) {
      if (metadataChanged) device.metadataDirty = true;
      if (stateChanged) device.stateDirty = true;
      void this.#pump(device);
    }
  }

  /**
   * Sends the full record again to each sticky, connects to the known
   * stickies, and starts the scan again. The timer calls it.
   */
  tick(): Promise<void> {
    this.#ticking ??= this.#tick().finally(() => {
      this.#ticking = undefined;
    });
    return this.#ticking;
  }

  async #tick(): Promise<void> {
    if (this.#stopped || !this.#poweredOn) return;
    const now = this.#now();
    for (const [id, until] of this.#ignored) {
      if (until <= now) this.#ignored.delete(id);
    }
    for (const device of this.#devices.values()) {
      device.metadataDirty = true;
      device.stateDirty = true;
      device.failures = 0;
      void this.#pump(device);
    }
    const known = await this.#cache.read();
    this.#known = new Set(known);
    for (const id of known) void this.#connect(id);
    // A different process can remove an identifier (see `DeviceCache.add`).
    for (const id of this.#devices.keys()) {
      if (!known.includes(id)) void this.#cache.add(id);
    }
    if (this.#stopped) return;
    try {
      // Scan again also with a connected sticky (there can be more than one
      // sticky). A scan reports each device one time only: start it again.
      if (this.#scanning) await this.#central.stopScan();
      if (this.#stopped) return;
      this.#scanning = true;
      await this.#central.startScan(SERVICE_UUID, (id) => void this.#connect(id));
    } catch (error) {
      this.#scanning = false;
      this.#log(`scan: ${message(error)}`);
    }
  }

  /** Waits until the record is on all connected stickies, at most `timeoutMs`. Never throws. */
  async flush(timeoutMs: number): Promise<void> {
    if (this.#stopped) return;
    await waitAtMost(Promise.allSettled([...this.#devices.values()].map((device) => this.#pump(device))), timeoutMs);
  }

  /**
   * Sends the record to all stickies (wait at most `timeoutMs`), then stops
   * all Bluetooth work. Never throws.
   */
  async close(timeoutMs: number): Promise<void> {
    if (this.#stopped) return;
    const flush = Promise.allSettled([...this.#devices.values()].map((device) => this.#pump(device)));
    await waitAtMost(flush, timeoutMs);
    this.#stopped = true;
    this.#pending.clear();
    if (this.#timer !== undefined) clearInterval(this.#timer);
    const devices = [...this.#devices.values()];
    this.#devices.clear();
    // This process only: CoreBluetooth keeps the link while other processes use it.
    await waitAtMost(
      Promise.allSettled(devices.map((device) => device.connection.disconnect())),
      Math.min(timeoutMs, DISCONNECT_MS),
    );
    try {
      this.#central.stop();
    } catch (error) {
      this.#log(`stop: ${message(error)}`);
    }
  }

  async #connect(id: string): Promise<void> {
    if (this.#stopped || !this.#poweredOn || this.#devices.has(id) || this.#connecting.has(id)) return;
    // A limit for many devices that advertise the service. The others wait
    // in a queue (first in, first out): a device that does not answer cannot
    // stop the attempts for the next devices.
    if (this.#connecting.size >= MAX_CONNECTING) {
      if (this.#pending.size < MAX_PENDING) this.#pending.add(id);
      return;
    }
    this.#pending.delete(id);
    const ignoredUntil = this.#ignored.get(id);
    if (ignoredUntil !== undefined && ignoredUntil > this.#now()) return;
    this.#connecting.add(id);
    let connection: StickyConnection | undefined;
    let lost = false;
    let device: Device | undefined;
    try {
      connection = await this.#central.connect(id, this.#connectMs);
      // At once: the device can disconnect during the identification.
      connection.onDisconnect(() => {
        lost = true;
        if (device === undefined || this.#devices.get(id) !== device) return;
        this.#devices.delete(id);
        this.#log(`${id}: disconnected.`);
        // Connect again soon (CoreBluetooth waits until the device is available).
        void this.tick();
      });
      if (this.#stopped) {
        await connection.disconnect().catch(() => undefined);
        return;
      }
      const version = decodeProtocolVersion(await connection.read(PROTOCOL_VERSION_UUID));
      if (version !== PROTOCOL_VERSION) {
        this.#log(`${id}: protocol version ${version ?? "?"} is not known. tau ignores the device.`);
        this.#ignore(id);
        await connection.disconnect().catch(() => undefined);
        return;
      }
      const keys = decodeMetadataKeys(await connection.read(METADATA_KEYS_UUID));
      if (this.#stopped || lost) {
        // After a disconnection, the next tick connects again.
        await connection.disconnect().catch(() => undefined);
        return;
      }
      device = { connection, keys, metadataDirty: true, stateDirty: true, failures: 0, pumping: undefined };
      this.#devices.set(id, device);
      this.#log(`${id}: connected.`);
      void this.#cache.add(id);
      // The first write must come soon: outside pair mode, the sticky
      // disconnects a link that is not encrypted after about 5 seconds, and
      // a protected write starts the encryption.
      void this.#pump(device);
    } catch (error) {
      this.#log(`${id}: ${message(error)}`);
      if (connection !== undefined && !lost) {
        // Connected, but not identified.
        this.#ignore(id);
        await connection.disconnect().catch(() => undefined);
      } else if (connection === undefined && !this.#known.has(id)) {
        // A device that is not a known sticky, and that does not answer:
        // give the attempts to other devices for some time.
        this.#ignore(id);
      }
    } finally {
      this.#connecting.delete(id);
      this.#startPending();
    }
  }

  #startPending(): void {
    for (const id of this.#pending) {
      if (this.#stopped || this.#connecting.size >= MAX_CONNECTING) return;
      this.#pending.delete(id);
      void this.#connect(id);
    }
  }

  #ignore(id: string): void {
    this.#ignored.set(id, this.#now() + this.#ignoreMs);
  }

  /** Writes the dirty parts of the record to one sticky, until nothing is dirty. One pump for each device. */
  #pump(device: Device): Promise<void> {
    device.pumping ??= this.#writeAll(device).finally(() => {
      device.pumping = undefined;
    });
    return device.pumping;
  }

  async #writeAll(device: Device): Promise<void> {
    const id = device.connection.id;
    while (this.#devices.get(id) === device && device.failures < MAX_FAILURES) {
      const record = this.#record;
      if (record === undefined || (!device.metadataDirty && !device.stateDirty)) return;
      // Take the flags before the first await: a publish during a write sets
      // them again, and the next loop sends the new values.
      const sendMetadata = device.metadataDirty && record.state !== "terminated";
      const sendState = device.stateDirty;
      device.metadataDirty = false;
      device.stateDirty = false;
      try {
        if (sendMetadata) {
          // Only the keys that the sticky knows (else the write fails).
          const entries = record.metadata.filter(([key]) => device.keys.has(key));
          for (const value of encodeMetadata(record.sessionId, entries)) {
            await device.connection.write(AGENT_METADATA_UUID, value);
          }
        }
        // The latest state: a publish during the metadata writes can change it.
        const latest = this.#record ?? record;
        if (sendState || device.stateDirty) {
          device.stateDirty = false;
          await device.connection.write(AGENT_STATE_UUID, encodeState(latest.sessionId, latest.state));
        }
        device.failures = 0;
      } catch (error) {
        // Send all again: the sticky can have a part of the changes only.
        device.metadataDirty = true;
        device.stateDirty = true;
        device.failures += 1;
        this.#log(`${id}: write: ${message(error)}`);
        // For example "Busy" (ATT error 0x80): wait a short time.
        await sleep(this.#retryMs);
      }
    }
  }
}

function sameMetadata(a: AgentRecord, b: AgentRecord): boolean {
  return a.sessionId === b.sessionId && JSON.stringify(a.metadata) === JSON.stringify(b.metadata);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}
