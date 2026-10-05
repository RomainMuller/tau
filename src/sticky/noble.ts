/**
 * The `StickyCentral` of macOS: `@stoprocent/noble` with its CoreBluetooth
 * bindings.
 *
 * CoreBluetooth shares one link to a device between all the processes of
 * the Mac, and it uses the bonds of macOS. Thus each pi process (the lead
 * and each sub-agent) can connect to a sticky, also while a different
 * process (for example `sticky server`) is connected to it.
 *
 * The module is an optional dependency with a native part. tau loads it
 * only on macOS, when the first session starts. When it cannot load,
 * `loadNobleCentral` returns `undefined`, and tau does not use stickies.
 */

import { createRequire } from "node:module";

import { type StickyCentral, type StickyConnection, withTimeout } from "./central.ts";
import { SERVICE_UUID } from "./protocol.ts";

/** The parts of noble that tau uses. */
export interface NobleCharacteristic {
  readonly uuid: string;
  readAsync(): Promise<Buffer>;
  writeAsync(data: Buffer, withoutResponse: boolean): Promise<void>;
}
export interface NoblePeripheral {
  readonly id: string;
  readonly state: string;
  discoverSomeServicesAndCharacteristicsAsync(
    serviceUuids: string[],
    characteristicUuids: string[],
  ): Promise<{ characteristics: NobleCharacteristic[] }>;
  disconnectAsync(): Promise<void>;
  once(event: "disconnect", listener: () => void): unknown;
}
export interface Noble {
  readonly state: string;
  on(event: "stateChange", listener: (state: string) => void): unknown;
  on(event: "discover", listener: (peripheral: NoblePeripheral) => void): unknown;
  removeAllListeners(event: string): unknown;
  on(event: "warning", listener: (message: string) => void): unknown;
  startScanningAsync(serviceUuids: string[], allowDuplicates: boolean): Promise<void>;
  stopScanningAsync(): Promise<void>;
  connectAsync(id: string): Promise<NoblePeripheral>;
  cancelConnect(id: string): void;
  stop(): void;
}

/** The time to discover the services of a new connection. */
const DISCOVERY_MS = 10_000;
/** The time of one read or one write. */
const OPERATION_MS = 15_000;

/** Loads noble with the CoreBluetooth bindings. Returns `undefined` when this is not possible. */
export function loadNobleCentral(
  platform: NodeJS.Platform = process.platform,
  load: () => Noble = loadMacNoble,
): StickyCentral | undefined {
  if (platform !== "darwin") return undefined;
  let noble: Noble;
  try {
    noble = load();
  } catch {
    return undefined;
  }
  // noble writes its warnings to the console: that breaks the TUI.
  noble.removeAllListeners("warning");
  noble.on("warning", () => undefined);
  return new NobleCentral(noble);
}

function loadMacNoble(): Noble {
  const require = createRequire(import.meta.url);
  // Not the main module: it makes a noble with the default bindings at
  // once. tau makes only one, with the macOS bindings.
  const withBindings = require("@stoprocent/noble/lib/resolve-bindings.js") as (type: string) => Noble;
  return withBindings("mac");
}

class NobleCentral implements StickyCentral {
  readonly #noble: Noble;
  readonly #powerListeners: Array<(poweredOn: boolean) => void> = [];
  #onFound: ((id: string) => void) | undefined;

  constructor(noble: Noble) {
    this.#noble = noble;
    // The first stateChange listener starts the bindings.
    noble.on("stateChange", (state) => {
      for (const listener of this.#powerListeners) listener(state === "poweredOn");
    });
    noble.on("discover", (peripheral) => this.#onFound?.(peripheral.id));
  }

  waitForPoweredOn(timeoutMs: number): Promise<boolean> {
    if (this.#noble.state === "poweredOn") return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(false), timeoutMs);
      timer.unref?.();
      let settled = false;
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      this.#powerListeners.push((on) => {
        if (on) done(true);
      });
    });
  }

  onPowerChange(listener: (poweredOn: boolean) => void): void {
    this.#powerListeners.push(listener);
  }

  async startScan(serviceUuid: string, onFound: (id: string) => void): Promise<void> {
    this.#onFound = onFound;
    await this.#noble.startScanningAsync([serviceUuid], false);
  }

  async stopScan(): Promise<void> {
    this.#onFound = undefined;
    await this.#noble.stopScanningAsync();
  }

  async connect(id: string, timeoutMs: number): Promise<StickyConnection> {
    // CoreBluetooth waits without a limit for a device that is not
    // available: cancel the connection after the time.
    const peripheral = await withTimeout(this.#noble.connectAsync(id), timeoutMs, "connect", () => this.#noble.cancelConnect(id));
    try {
      const { characteristics } = await withTimeout(
        peripheral.discoverSomeServicesAndCharacteristicsAsync([SERVICE_UUID], []),
        DISCOVERY_MS,
        "service discovery",
      );
      return new NobleConnection(peripheral, characteristics);
    } catch (error) {
      await peripheral.disconnectAsync().catch(() => undefined);
      throw error;
    }
  }

  stop(): void {
    this.#onFound = undefined;
    this.#noble.stop();
  }
}

class NobleConnection implements StickyConnection {
  readonly #peripheral: NoblePeripheral;
  readonly #characteristics: ReadonlyMap<string, NobleCharacteristic>;

  constructor(peripheral: NoblePeripheral, characteristics: readonly NobleCharacteristic[]) {
    this.#peripheral = peripheral;
    this.#characteristics = new Map(characteristics.map((item) => [normalUuid(item.uuid), item]));
  }

  get id(): string {
    return this.#peripheral.id;
  }

  async read(characteristicUuid: string): Promise<Buffer> {
    return await withTimeout(this.#characteristic(characteristicUuid).readAsync(), OPERATION_MS, "read");
  }

  async write(characteristicUuid: string, value: Buffer): Promise<void> {
    // withoutResponse = false: a Write Request. CoreBluetooth does a long
    // write when the value does not fit in one request.
    await withTimeout(this.#characteristic(characteristicUuid).writeAsync(value, false), OPERATION_MS, "write");
  }

  onDisconnect(listener: () => void): void {
    this.#peripheral.once("disconnect", listener);
  }

  async disconnect(): Promise<void> {
    await withTimeout(this.#peripheral.disconnectAsync(), OPERATION_MS, "disconnect");
  }

  #characteristic(uuid: string): NobleCharacteristic {
    const item = this.#characteristics.get(normalUuid(uuid));
    if (item === undefined) throw new Error(`The sticky has no characteristic ${uuid}.`);
    return item;
  }
}

function normalUuid(uuid: string): string {
  return uuid.toLowerCase().replaceAll("-", "");
}
