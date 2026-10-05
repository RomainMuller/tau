import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { loadNobleCentral, type Noble, type NobleCharacteristic, type NoblePeripheral } from "./noble.ts";
import { AGENT_STATE_UUID, PROTOCOL_VERSION_UUID, SERVICE_UUID } from "./protocol.ts";

class FakeCharacteristic implements NobleCharacteristic {
  readonly writes: Array<[string, boolean]> = [];
  readonly uuid: string;
  readonly value: Buffer;
  constructor(uuid: string, value = Buffer.from([1, 0])) {
    this.uuid = uuid;
    this.value = value;
  }
  async readAsync(): Promise<Buffer> {
    return this.value;
  }
  async writeAsync(data: Buffer, withoutResponse: boolean): Promise<void> {
    this.writes.push([data.toString("hex"), withoutResponse]);
  }
}

class FakePeripheral extends EventEmitter implements NoblePeripheral {
  state = "connected";
  disconnects = 0;
  discovery: Promise<{ characteristics: NobleCharacteristic[] }>;
  readonly discovered: string[][] = [];
  readonly id: string;
  constructor(id: string, characteristics: NobleCharacteristic[]) {
    super();
    this.id = id;
    this.discovery = Promise.resolve({ characteristics });
  }
  discoverSomeServicesAndCharacteristicsAsync(services: string[]) {
    this.discovered.push(services);
    return this.discovery;
  }
  async disconnectAsync(): Promise<void> {
    this.disconnects += 1;
  }
}

class FakeNoble extends EventEmitter {
  state = "unknown";
  readonly calls: string[] = [];
  peripheral: FakePeripheral | undefined;
  connectResult: Promise<NoblePeripheral> | undefined;
  async startScanningAsync(uuids: string[], duplicates: boolean): Promise<void> {
    this.calls.push(`scan ${uuids.join(",")} ${duplicates}`);
  }
  async stopScanningAsync(): Promise<void> {
    this.calls.push("stopScan");
  }
  connectAsync(id: string): Promise<NoblePeripheral> {
    this.calls.push(`connect ${id}`);
    return this.connectResult ?? Promise.resolve(this.peripheral!);
  }
  cancelConnect(id: string): void {
    this.calls.push(`cancel ${id}`);
  }
  stop(): void {
    this.calls.push("stop");
  }
}

function load(noble: FakeNoble) {
  const central = loadNobleCentral("darwin", () => noble as unknown as Noble);
  assert.ok(central !== undefined);
  return central;
}

describe("loadNobleCentral", () => {
  it("does nothing on other platforms, and when the module does not load", () => {
    let loads = 0;
    const fake = () => {
      loads += 1;
      return new FakeNoble() as unknown as Noble;
    };
    assert.equal(loadNobleCentral("linux", fake), undefined);
    assert.equal(loads, 0);
    const broken = () => {
      throw new Error("no native module");
    };
    assert.equal(loadNobleCentral("darwin", broken), undefined);
  });

  it("removes the console warnings of noble", () => {
    const noble = new FakeNoble();
    let printed = 0;
    noble.on("warning", () => (printed += 1));
    load(noble);
    noble.emit("warning", "unknown peripheral");
    assert.equal(printed, 0);
  });

  it("tells the power changes, and waits for the power", async () => {
    const noble = new FakeNoble();
    const central = load(noble);
    const changes: boolean[] = [];
    central.onPowerChange((on) => changes.push(on));
    const waiting = central.waitForPoweredOn(1_000);
    noble.emit("stateChange", "poweredOff");
    noble.emit("stateChange", "poweredOn");
    assert.equal(await waiting, true);
    assert.deepEqual(changes, [false, true]);
    assert.equal(await load(new FakeNoble()).waitForPoweredOn(10), false);
  });

  it("scans for the service, and gives the identifiers", async () => {
    const noble = new FakeNoble();
    const central = load(noble);
    const found: string[] = [];
    await central.startScan(SERVICE_UUID, (id) => found.push(id));
    noble.emit("discover", { id: "abc" });
    await central.stopScan();
    noble.emit("discover", { id: "def" });
    assert.deepEqual(found, ["abc"]);
    assert.deepEqual(noble.calls, [`scan ${SERVICE_UUID} false`, "stopScan"]);
  });

  it("cancels a connection that takes too long", async () => {
    const noble = new FakeNoble();
    noble.connectResult = new Promise(() => undefined);
    const central = load(noble);
    await assert.rejects(central.connect("abc", 10), /connect: no answer/);
    assert.deepEqual(noble.calls, ["connect abc", "cancel abc"]);
  });

  it("reads, and writes with response, with UUIDs in any form", async () => {
    const noble = new FakeNoble();
    const version = new FakeCharacteristic("CE3D0001-1DAA-4212-AEEC-87A954240112");
    const agentState = new FakeCharacteristic(AGENT_STATE_UUID);
    const peripheral = new FakePeripheral("abc", [version, agentState]);
    noble.peripheral = peripheral;
    const central = load(noble);
    const connection = await central.connect("abc", 1_000);
    assert.deepEqual(peripheral.discovered, [[SERVICE_UUID]]);
    assert.deepEqual(await connection.read(PROTOCOL_VERSION_UUID), Buffer.from([1, 0]));
    await connection.write(AGENT_STATE_UUID, Buffer.from([1, 0x73, 2]));
    // withoutResponse = false: a Write Request (the sticky ignores Write Commands).
    assert.deepEqual(agentState.writes, [["017302", false]]);
    await assert.rejects(connection.read("ce3d00091daa4212aeec87a954240112"), /no characteristic/);
    let disconnected = 0;
    connection.onDisconnect(() => (disconnected += 1));
    peripheral.emit("disconnect");
    peripheral.emit("disconnect");
    assert.equal(disconnected, 1);
  });

  it("disconnects when the service discovery fails", async () => {
    const noble = new FakeNoble();
    const peripheral = new FakePeripheral("abc", []);
    peripheral.discovery = Promise.reject(new Error("no services"));
    noble.peripheral = peripheral;
    const central = load(noble);
    await assert.rejects(central.connect("abc", 1_000), /no services/);
    assert.equal(peripheral.disconnects, 1);
  });
});
