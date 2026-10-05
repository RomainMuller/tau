import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { type AgentRecord, StickyLink } from "./link.ts";
import { AGENT_METADATA_UUID, AGENT_STATE_UUID, encodeMetadata, encodeState } from "./protocol.ts";
import { type DeviceWrite, ServerAbsentError, type StickyServer } from "./server.ts";

const execFileAsync = promisify(execFile);

/** A fake `sticky server`. */
class FakeServer implements StickyServer {
  /** The writes, as `state:<hex>` or `meta:<hex>`. */
  readonly writes: string[] = [];
  /** True: each write fails with `ServerAbsentError`. */
  absent = false;
  /** The results of the next writes (the default is one sticky that accepts). */
  readonly results: Array<DeviceWrite[] | Error> = [];
  /** When set, each write waits for it. */
  gate: Promise<void> | undefined;
  calls = 0;
  closed = false;

  async write(uuid: string, value: Buffer): Promise<DeviceWrite[]> {
    this.calls += 1;
    await this.gate;
    if (this.absent) throw new ServerAbsentError("no socket");
    const result = this.results.shift() ?? [{ identifier: "A", error: null }];
    if (result instanceof Error) throw result;
    if (result.every((device) => device.error === null)) {
      this.writes.push(`${uuid === AGENT_STATE_UUID ? "state" : uuid === AGENT_METADATA_UUID ? "meta" : "?"}:${value.toString("hex")}`);
    }
    return result;
  }

  close(): void {
    this.closed = true;
  }
}

function record(state: AgentRecord["state"], name = "lead"): AgentRecord {
  return {
    sessionId: "tau-1-lead",
    state,
    metadata: [
      ["name", name],
      ["workspace", "/w"],
      ["parent", ""],
      ["model", "m"],
    ],
  };
}

const meta = (r: AgentRecord) => encodeMetadata(r.sessionId, r.metadata).map((value) => `meta:${value.toString("hex")}`);
const state = (r: AgentRecord) => `state:${encodeState(r.sessionId, r.state).toString("hex")}`;

function makeLink(server: FakeServer, logs: string[] = []): StickyLink {
  return new StickyLink({ server, refreshMs: 60_000, retryMs: 1, log: (line) => void logs.push(line) });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("StickyLink", () => {
  it("sends the metadata, then the state, at the start", async () => {
    const server = new FakeServer();
    const link = makeLink(server);
    link.publish(record("idle"));
    link.start();
    await link.flush(1_000);
    assert.deepEqual(server.writes, [...meta(record("idle")), state(record("idle"))]);
    await link.close(100);
  });

  it("sends nothing before the start", async () => {
    const server = new FakeServer();
    const link = makeLink(server);
    link.publish(record("idle"));
    await settle();
    assert.equal(server.calls, 0);
    await link.close(100);
  });

  it("sends only the state when only the state changes", async () => {
    const server = new FakeServer();
    const link = makeLink(server);
    link.publish(record("idle"));
    link.start();
    await link.flush(1_000);
    server.writes.length = 0;
    link.publish(record("working"));
    await link.flush(1_000);
    assert.deepEqual(server.writes, [state(record("working"))]);
    await link.close(100);
  });

  it("sends the metadata again when it changes", async () => {
    const server = new FakeServer();
    const link = makeLink(server);
    link.publish(record("idle"));
    link.start();
    await link.flush(1_000);
    server.writes.length = 0;
    link.publish(record("idle", "other"));
    await link.flush(1_000);
    assert.deepEqual(server.writes, meta(record("idle", "other")));
    await link.close(100);
  });

  it("sends the last state after a write that was in progress (in order)", async () => {
    const server = new FakeServer();
    const link = makeLink(server);
    link.publish(record("idle"));
    link.start();
    await link.flush(1_000);
    server.writes.length = 0;
    let open!: () => void;
    server.gate = new Promise((resolve) => (open = resolve));
    link.publish(record("working"));
    link.publish(record("waiting"));
    link.publish(record("question"));
    open();
    await link.flush(1_000);
    // The first write took "working"; then only the last state.
    assert.deepEqual(server.writes, [state(record("working")), state(record("question"))]);
    await link.close(100);
  });

  it("sends new metadata before the state when the metadata changes during a metadata write", async () => {
    const server = new FakeServer();
    const link = makeLink(server);
    let open!: () => void;
    server.gate = new Promise((resolve) => (open = resolve));
    link.publish(record("idle"));
    link.start();
    await settle();
    link.publish(record("working", "other"));
    open();
    await link.flush(1_000);
    assert.deepEqual(server.writes, [...meta(record("idle")), ...meta(record("working", "other")), state(record("working", "other"))]);
    await link.close(100);
  });

  it("does not send the state after the close when the close comes during a metadata write", async () => {
    const server = new FakeServer();
    const link = makeLink(server);
    let open!: () => void;
    server.gate = new Promise((resolve) => (open = resolve));
    link.publish(record("idle"));
    link.start();
    await settle();
    await link.close(10);
    open();
    await settle();
    assert.equal(server.calls, 1, "only the metadata write that was in progress");
  });

  it("logs nothing for a late answer after the close", async () => {
    const server = new FakeServer();
    const logs: string[] = [];
    const link = makeLink(server, logs);
    let open!: () => void;
    server.gate = new Promise((resolve) => (open = resolve));
    server.absent = true;
    link.publish(record("idle"));
    link.start();
    await settle();
    await link.close(10);
    open();
    await settle();
    assert.deepEqual(logs, []);
  });

  it("keeps the process until a busy terminated write is sent at the close", async () => {
    // A child process: with unref timers only, Node can exit before the retry.
    const code = `
      import { StickyLink } from ${JSON.stringify(new URL("./link.ts", import.meta.url).href)};
      let calls = 0;
      const server = {
        async write() {
          calls += 1;
          return calls === 1 ? [{ identifier: "A", error: "busy (ATT error 0x80)" }] : [{ identifier: "A", error: null }];
        },
        close() { console.log("closed after " + calls + " writes"); },
      };
      const link = new StickyLink({ server, retryMs: 200 });
      link.publish({ sessionId: "s", state: "terminated", metadata: [] });
      link.start();
      await link.close(3000);
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", code]);
    assert.equal(stdout.trim(), "closed after 2 writes");
  });

  it("logs a limited number of lines for the results of one write", async () => {
    const server = new FakeServer();
    server.results.push(Array.from({ length: 12 }, (_, i) => ({ identifier: `D${i}`, error: "refused (ATT error 0x05)" })));
    const logs: string[] = [];
    const link = makeLink(server, logs);
    link.publish(record("idle"));
    link.start();
    await link.flush(1_000);
    assert.equal(logs.length, 9);
    assert.equal(logs.at(-1), "metadata: 4 more errors");
    await link.close(100);
  });

  it("flush stops waiting after its time when the server does not answer", async () => {
    const server = new FakeServer();
    server.gate = new Promise(() => undefined);
    const link = makeLink(server);
    link.publish(record("idle"));
    link.start();
    const started = Date.now();
    await link.flush(50);
    assert.ok(Date.now() - started < 1_000);
    await link.close(10);
    assert.equal(server.closed, true);
  });

  it("does not try again at once when no server runs, but sends all at the next change", async () => {
    const server = new FakeServer();
    server.absent = true;
    const logs: string[] = [];
    const link = makeLink(server, logs);
    link.publish(record("idle"));
    link.start();
    await link.flush(1_000);
    assert.equal(server.calls, 1);
    server.absent = false;
    link.publish(record("working"));
    await link.flush(1_000);
    assert.deepEqual(server.writes, [...meta(record("working")), state(record("working"))]);
    assert.deepEqual(logs, ["no server: no socket", "server found."]);
    await link.close(100);
  });

  it("logs the no-server problem one time only", async () => {
    const server = new FakeServer();
    server.absent = true;
    const logs: string[] = [];
    const link = makeLink(server, logs);
    link.publish(record("idle"));
    link.start();
    await link.flush(1_000);
    link.refresh();
    await link.flush(1_000);
    assert.deepEqual(logs, ["no server: no socket"]);
    await link.close(100);
  });

  it("does not try again at once after an error response (for example no sticky)", async () => {
    const server = new FakeServer();
    server.results.push(new Error("found no sticky in 10 s"));
    const logs: string[] = [];
    const link = makeLink(server, logs);
    link.publish(record("idle"));
    link.start();
    await link.flush(1_000);
    assert.equal(server.calls, 1);
    assert.deepEqual(logs, ["write: found no sticky in 10 s"]);
    link.refresh();
    await link.flush(1_000);
    assert.deepEqual(server.writes, [...meta(record("idle")), state(record("idle"))]);
    await link.close(100);
  });

  it("sends all again soon when a sticky is busy, 3 times at most", async () => {
    const server = new FakeServer();
    const busy = [{ identifier: "A", error: "cannot write: Unknown ATT error. (ATT error 0x80)" }];
    server.results.push(busy, busy, busy, busy, busy, busy);
    const link = makeLink(server);
    link.publish(record("idle"));
    link.start();
    await link.flush(1_000);
    // 3 rounds of 2 writes (metadata and state), all busy: then it stops.
    assert.equal(server.calls, 6);
    assert.deepEqual(server.writes, []);
    link.refresh();
    await link.flush(1_000);
    assert.deepEqual(server.writes, [...meta(record("idle")), state(record("idle"))]);
    await link.close(100);
  });

  it("does not send again for a refused write that is not busy (it logs it)", async () => {
    const server = new FakeServer();
    server.results.push([{ identifier: "A\u0007", error: "cannot write (ATT error 0x05)" }]);
    const logs: string[] = [];
    const link = makeLink(server, logs);
    link.publish(record("idle"));
    link.start();
    await link.flush(1_000);
    assert.equal(server.calls, 2);
    assert.deepEqual(logs, ["A?: metadata: cannot write (ATT error 0x05)"]);
    await link.close(100);
  });

  it("sends all again at each refresh", async () => {
    const server = new FakeServer();
    const link = makeLink(server);
    link.publish(record("idle"));
    link.start();
    await link.flush(1_000);
    server.writes.length = 0;
    link.refresh();
    await link.flush(1_000);
    assert.deepEqual(server.writes, [...meta(record("idle")), state(record("idle"))]);
    await link.close(100);
  });

  it("sends terminated at the close (no metadata), then sends nothing, and stops", async () => {
    const server = new FakeServer();
    const link = makeLink(server);
    link.publish(record("idle"));
    link.start();
    await link.flush(1_000);
    server.writes.length = 0;
    link.publish(record("terminated"));
    await link.close(1_000);
    assert.deepEqual(server.writes, [state(record("terminated"))]);
    assert.equal(server.closed, true);
    link.publish(record("working"));
    link.refresh();
    await settle();
    assert.deepEqual(server.writes, [state(record("terminated"))]);
  });

  it("sends no other record after terminated", async () => {
    const server = new FakeServer();
    const link = makeLink(server);
    link.publish(record("terminated"));
    link.publish(record("working"));
    link.start();
    await link.flush(1_000);
    assert.deepEqual(server.writes, [state(record("terminated"))]);
    await link.close(100);
  });
});
