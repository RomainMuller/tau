import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { StickyCentral, StickyConnection } from "./central.ts";
import { DeviceCache, DEVICES_DIR, MAX_DEVICES } from "./devices.ts";
import { type AgentRecord, StickyLink } from "./link.ts";
import { AGENT_METADATA_UUID, AGENT_STATE_UUID, METADATA_KEYS_UUID, PROTOCOL_VERSION_UUID } from "./protocol.ts";

const ID_A = "13172225963b6f980024c4b7efcd9223";
const ID_B = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

class FakeDevice {
  version = Buffer.from([1, 0]);
  keys = Buffer.from("name,workspace,parent,model");
  /** The writes, as `state:<hex>` or `meta:<hex>`. */
  readonly writes: string[] = [];
  /** The number of next writes that fail. */
  failures = 0;
  /** When set, each write waits for it. */
  gate: Promise<void> | undefined;
  connected = false;
  readonly #listeners: Array<() => void> = [];

  connection(id: string): StickyConnection {
    this.connected = true;
    const self = this;
    return {
      id,
      async read(uuid) {
        if (uuid === PROTOCOL_VERSION_UUID) return self.version;
        if (uuid === METADATA_KEYS_UUID) return self.keys;
        throw new Error("no such characteristic");
      },
      async write(uuid, value) {
        await self.gate;
        if (self.failures > 0) {
          self.failures -= 1;
          throw new Error("Busy");
        }
        self.writes.push(`${uuid === AGENT_STATE_UUID ? "state" : uuid === AGENT_METADATA_UUID ? "meta" : "?"}:${value.toString("hex")}`);
      },
      onDisconnect(listener) {
        self.#listeners.push(listener);
      },
      async disconnect() {
        self.connected = false;
      },
    };
  }

  /** The device disconnects. */
  drop(): void {
    this.connected = false;
    for (const listener of this.#listeners.splice(0)) listener();
  }
}

class FakeCentral implements StickyCentral {
  readonly devices = new Map<string, FakeDevice>();
  /** The devices that advertise (a scan finds them). */
  readonly advertising = new Set<string>();
  readonly calls: string[] = [];
  stopped = false;
  #power: Array<(on: boolean) => void> = [];

  async waitForPoweredOn(): Promise<boolean> {
    return true;
  }
  onPowerChange(listener: (on: boolean) => void): void {
    this.#power.push(listener);
  }
  setPower(on: boolean): void {
    for (const listener of this.#power) listener(on);
  }
  async startScan(_uuid: string, onFound: (id: string) => void): Promise<void> {
    this.calls.push("scan");
    for (const id of this.advertising) onFound(id);
  }
  async stopScan(): Promise<void> {
    this.calls.push("stopScan");
  }
  async connect(id: string): Promise<StickyConnection> {
    this.calls.push(`connect ${id}`);
    const device = this.devices.get(id);
    if (device === undefined) throw new Error("not available");
    return device.connection(id);
  }
  stop(): void {
    this.stopped = true;
  }
}

const RECORD: AgentRecord = {
  sessionId: "s",
  state: "idle",
  metadata: [
    ["name", "n"],
    ["model", ""],
  ],
};
const META_HEX = "meta:0173" + "046e616d65016e" + "056d6f64656c00";
const state = (code: number) => `state:0173${code.toString(16).padStart(2, "0")}`;

/** Writes the device cache: the identifiers, the oldest first. */
async function seed(ids: readonly string[]): Promise<void> {
  const devices = join(dir, DEVICES_DIR);
  await rm(devices, { recursive: true, force: true });
  await mkdir(devices, { recursive: true });
  for (const [index, id] of ids.entries()) {
    await writeFile(join(devices, id), "");
    const time = new Date(Date.now() - 60_000 + index * 1_000);
    await utimes(join(devices, id), time, time);
  }
}

/** Lets the pending work run (also the retry timers of 1 ms). */
async function settle(): Promise<void> {
  for (let round = 0; round < 10; round++) {
    for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
}

let dir: string;
let central: FakeCentral;
let link: StickyLink;

function makeLink(): StickyLink {
  link = new StickyLink({ central, cache: new DeviceCache(dir), refreshMs: 3_600_000, retryMs: 1, ignoreMs: 60_000 });
  return link;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tau-sticky-"));
  central = new FakeCentral();
});

afterEach(async () => {
  await link?.close(100);
  await rm(dir, { recursive: true, force: true });
});

describe("StickyLink", () => {
  it("connects to a known sticky without a scan, and sends the metadata, then the state", async () => {
    await seed([ID_A]);
    const device = new FakeDevice();
    central.devices.set(ID_A, device);
    makeLink().publish(RECORD);
    link.start();
    await settle();
    assert.deepEqual(link.devices, [ID_A]);
    assert.deepEqual(device.writes, [META_HEX, state(1)]);
    // Each tick starts the scan again (for other stickies), but does not
    // connect again to a connected sticky.
    await link.tick();
    await settle();
    assert.deepEqual(central.calls, [`connect ${ID_A}`, "scan", "stopScan", "scan"]);
  });

  it("finds a second sticky with a scan while a first one is connected", async () => {
    const a = new FakeDevice();
    const b = new FakeDevice();
    central.devices.set(ID_A, a);
    central.devices.set(ID_B, b);
    central.advertising.add(ID_A);
    makeLink().publish(RECORD);
    link.start();
    await settle();
    assert.deepEqual(link.devices, [ID_A]);
    central.advertising.add(ID_B);
    await link.tick();
    await settle();
    assert.deepEqual(link.devices.sort(), [ID_A, ID_B]);
  });

  it("sends the new state when it changes during a metadata write (also terminated at the close)", async () => {
    const device = new FakeDevice();
    let open!: () => void;
    device.gate = new Promise((resolve) => (open = resolve));
    central.devices.set(ID_A, device);
    central.advertising.add(ID_A);
    makeLink().publish(RECORD);
    link.start();
    await settle();
    // The metadata write waits now.
    link.publish({ ...RECORD, state: "terminated" });
    open();
    await link.close(1_000);
    assert.deepEqual(device.writes, [META_HEX, state(0)]);
  });

  it("flush waits until the stickies have the record", async () => {
    const device = new FakeDevice();
    central.devices.set(ID_A, device);
    central.advertising.add(ID_A);
    makeLink().publish(RECORD);
    link.start();
    await settle();
    let open!: () => void;
    device.gate = new Promise((resolve) => (open = resolve));
    link.publish({ ...RECORD, state: "question" });
    const flushed = link.flush(1_000).then(() => device.writes.at(-1));
    open();
    assert.equal(await flushed, state(3));
  });

  it("flush stops waiting after its time when a sticky does not answer", async () => {
    const device = new FakeDevice();
    central.devices.set(ID_A, device);
    central.advertising.add(ID_A);
    makeLink().publish(RECORD);
    link.start();
    await settle();
    device.gate = new Promise(() => undefined);
    link.publish({ ...RECORD, state: "question" });
    const started = Date.now();
    await link.flush(50);
    assert.ok(Date.now() - started < 1_000);
  });

  it("connects again when the device disconnects during the identification", async () => {
    const device = new FakeDevice();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const connection = device.connection.bind(device);
    let first = true;
    device.connection = (id: string) => {
      const inner = connection(id);
      if (!first) return inner;
      first = false;
      return {
        ...inner,
        read: async (uuid: string) => {
          await gate;
          return inner.read(uuid);
        },
      };
    };
    central.devices.set(ID_A, device);
    central.advertising.add(ID_A);
    makeLink().publish(RECORD);
    link.start();
    await settle();
    device.drop();
    open();
    await settle();
    // Not used, and not ignored: the next tick connects again.
    assert.deepEqual(link.devices, []);
    await link.tick();
    await settle();
    assert.deepEqual(link.devices, [ID_A]);
  });

  it("makes at most 4 connection attempts at the same time", async () => {
    const ids = Array.from({ length: 10 }, (_, index) => index.toString(16).padStart(32, "0"));
    let pending = 0;
    let most = 0;
    central.connect = async (id: string) => {
      central.calls.push(`connect ${id}`);
      pending += 1;
      most = Math.max(most, pending);
      await new Promise((resolve) => setTimeout(resolve, 5));
      pending -= 1;
      throw new Error("not available");
    };
    for (const id of ids) central.advertising.add(id);
    makeLink().publish(RECORD);
    link.start();
    await settle();
    assert.equal(most, 4);
    // The others wait in the queue, and get their attempt.
    assert.equal(central.calls.filter((call) => call.startsWith("connect")).length, 10);
  });

  it("tries the next devices when the first attempts do not answer", async () => {
    const stale = Array.from({ length: 4 }, (_, index) => index.toString(16).padStart(32, "0"));
    await seed(stale);
    const device = new FakeDevice();
    central.devices.set(ID_A, device);
    central.advertising.add(ID_A);
    const connect = central.connect.bind(central);
    central.connect = async (id: string) => {
      if (stale.includes(id)) {
        central.calls.push(`connect ${id}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error("not available");
      }
      return connect(id);
    };
    makeLink().publish(RECORD);
    link.start();
    await settle();
    assert.deepEqual(link.devices, [ID_A]);
  });

  it("finds a sticky after many devices that do not answer (more than the queue)", async () => {
    const failing = Array.from({ length: 40 }, (_, index) => index.toString(16).padStart(32, "0"));
    for (const id of failing) central.advertising.add(id);
    central.advertising.add(ID_A);
    central.devices.set(ID_A, new FakeDevice());
    const connect = central.connect.bind(central);
    central.connect = async (id: string) => {
      if (failing.includes(id)) {
        central.calls.push(`connect ${id}`);
        await new Promise((resolve) => setTimeout(resolve, 2));
        throw new Error("not available");
      }
      return connect(id);
    };
    makeLink().publish(RECORD);
    link.start();
    for (let round = 0; round < 5 && link.devices.length === 0; round++) {
      await settle();
      await link.tick();
    }
    await settle();
    assert.deepEqual(link.devices, [ID_A]);
    // A device that does not answer gets one attempt, then waits (it is not in the device cache).
    for (const id of failing) assert.ok(central.calls.filter((call) => call === `connect ${id}`).length <= 1, id);
  });

  it("adds a connected sticky to the device cache again when a different process removed it", async () => {
    const device = new FakeDevice();
    central.devices.set(ID_A, device);
    central.advertising.add(ID_A);
    makeLink().publish(RECORD);
    link.start();
    await settle();
    await seed([ID_B]);
    await link.tick();
    await settle();
    assert.deepEqual(await new DeviceCache(dir).read(), [ID_B, ID_A]);
  });

  it("finds a sticky with a scan, and adds it to the device cache", async () => {
    const device = new FakeDevice();
    central.devices.set(ID_A, device);
    central.advertising.add(ID_A);
    makeLink().publish(RECORD);
    link.start();
    await settle();
    assert.deepEqual(link.devices, [ID_A]);
    assert.deepEqual(await new DeviceCache(dir).read(), [ID_A]);
  });

  it("ignores a device with a different protocol version", async () => {
    const device = new FakeDevice();
    device.version = Buffer.from([2, 0]);
    central.devices.set(ID_A, device);
    central.advertising.add(ID_A);
    makeLink().publish(RECORD);
    link.start();
    await settle();
    assert.deepEqual(link.devices, []);
    assert.deepEqual(device.writes, []);
    assert.equal(device.connected, false);
    // Ignored for some time: the next scan does not connect again.
    await link.tick();
    await settle();
    assert.equal(central.calls.filter((call) => call.startsWith("connect")).length, 1);
  });

  it("sends only the metadata keys that the sticky knows", async () => {
    const device = new FakeDevice();
    device.keys = Buffer.from("name");
    central.devices.set(ID_A, device);
    central.advertising.add(ID_A);
    makeLink().publish(RECORD);
    link.start();
    await settle();
    assert.deepEqual(device.writes, ["meta:0173046e616d65016e", state(1)]);
  });

  it("sends the last state after a write that was in progress (in order)", async () => {
    const device = new FakeDevice();
    central.devices.set(ID_A, device);
    central.advertising.add(ID_A);
    makeLink().publish(RECORD);
    link.start();
    await settle();
    let open!: () => void;
    device.gate = new Promise((resolve) => (open = resolve));
    link.publish({ ...RECORD, state: "working" });
    link.publish({ ...RECORD, state: "question" });
    link.publish({ ...RECORD, state: "working" });
    link.publish({ ...RECORD, state: "waiting" });
    open();
    await settle();
    assert.deepEqual(device.writes, [META_HEX, state(1), state(2), state(4)]);
  });

  it("sends the metadata again when it changes", async () => {
    const device = new FakeDevice();
    central.devices.set(ID_A, device);
    central.advertising.add(ID_A);
    makeLink().publish(RECORD);
    link.start();
    await settle();
    link.publish({ ...RECORD, metadata: [["model", "m"]] });
    await settle();
    assert.deepEqual(device.writes.slice(2), ["meta:0173056d6f64656c016d"]);
  });

  it("sends all again after a write error", async () => {
    const device = new FakeDevice();
    device.failures = 1;
    central.devices.set(ID_A, device);
    central.advertising.add(ID_A);
    makeLink().publish(RECORD);
    link.start();
    await settle();
    assert.deepEqual(device.writes, [META_HEX, state(1)]);
  });

  it("stops the writes after 3 errors, until the next refresh", async () => {
    const device = new FakeDevice();
    device.failures = 5;
    central.devices.set(ID_A, device);
    central.advertising.add(ID_A);
    makeLink().publish(RECORD);
    link.start();
    await settle();
    assert.deepEqual(device.writes, []);
    assert.equal(device.failures, 2);
    await link.tick();
    await settle();
    assert.deepEqual(device.writes, [META_HEX, state(1)]);
  });

  it("sends all again at each refresh", async () => {
    const device = new FakeDevice();
    central.devices.set(ID_A, device);
    central.advertising.add(ID_A);
    makeLink().publish(RECORD);
    link.start();
    await settle();
    await link.tick();
    await settle();
    assert.deepEqual(device.writes, [META_HEX, state(1), META_HEX, state(1)]);
  });

  it("connects again after a disconnection", async () => {
    const device = new FakeDevice();
    central.devices.set(ID_A, device);
    central.advertising.add(ID_A);
    makeLink().publish(RECORD);
    link.start();
    await settle();
    device.drop();
    assert.deepEqual(link.devices, []);
    await settle();
    assert.deepEqual(link.devices, [ID_A]);
    assert.deepEqual(device.writes, [META_HEX, state(1), META_HEX, state(1)]);
  });

  it("forgets the connections when Bluetooth goes off, and connects when it goes on", async () => {
    const device = new FakeDevice();
    central.devices.set(ID_A, device);
    central.advertising.add(ID_A);
    makeLink().publish(RECORD);
    link.start();
    await settle();
    central.setPower(false);
    assert.deepEqual(link.devices, []);
    central.setPower(true);
    await settle();
    assert.deepEqual(link.devices, [ID_A]);
  });

  it("uses all the stickies", async () => {
    await seed([ID_A, ID_B]);
    const a = new FakeDevice();
    const b = new FakeDevice();
    central.devices.set(ID_A, a);
    central.devices.set(ID_B, b);
    makeLink().publish(RECORD);
    link.start();
    await settle();
    assert.deepEqual(link.devices.sort(), [ID_A, ID_B]);
    assert.deepEqual(b.writes, a.writes);
  });

  it("sends terminated at the close (no metadata), then sends nothing, and stops", async () => {
    const device = new FakeDevice();
    central.devices.set(ID_A, device);
    central.advertising.add(ID_A);
    makeLink().publish(RECORD);
    link.start();
    await settle();
    link.publish({ ...RECORD, state: "terminated", metadata: [["name", "other"]] });
    link.publish({ ...RECORD, state: "working" });
    await link.close(1_000);
    assert.deepEqual(device.writes, [META_HEX, state(1), state(0)]);
    assert.equal(device.connected, false);
    assert.equal(central.stopped, true);
  });

  it("does nothing visible when no sticky is near", async () => {
    makeLink().publish(RECORD);
    link.start();
    await settle();
    assert.deepEqual(link.devices, []);
    await link.close(100);
    assert.equal(central.stopped, true);
  });
});

describe("DeviceCache", () => {
  it("keeps valid identifiers only, the newest last", async () => {
    await seed([ID_B, ID_A]);
    await writeFile(join(dir, DEVICES_DIR, "bad"), "");
    await mkdir(join(dir, DEVICES_DIR, "c".repeat(32)));
    const cache = new DeviceCache(dir);
    assert.deepEqual(await cache.read(), [ID_B, ID_A]);
    await cache.add(ID_B);
    assert.deepEqual(await cache.read(), [ID_A, ID_B]);
    await cache.add("../x");
    assert.deepEqual(await cache.read(), [ID_A, ID_B]);
  });

  it("keeps all identifiers of concurrent additions", async () => {
    for (let round = 0; round < 20; round++) {
      const roundDir = join(dir, `round-${round}`);
      const ids = Array.from({ length: 8 }, (_, index) => index.toString(16).repeat(32));
      await Promise.all(ids.map((id) => new DeviceCache(roundDir).add(id)));
      assert.deepEqual((await new DeviceCache(roundDir).read()).sort(), [...ids].sort(), `round ${round}`);
    }
  });

  it("keeps the newest identifiers only", async () => {
    const ids = Array.from({ length: MAX_DEVICES }, (_, index) => index.toString(16).padStart(32, "0"));
    await seed(ids);
    await new DeviceCache(dir).add(ID_A);
    assert.deepEqual(await new DeviceCache(dir).read(), [...ids.slice(1), ID_A]);
  });

  it("gives an empty list when the directory does not exist", async () => {
    assert.deepEqual(await new DeviceCache(join(dir, "missing")).read(), []);
  });
});
