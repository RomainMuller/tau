import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { HerdrAgent, HerdrClient } from "./herdr-client.ts";
import { ORPHAN_GRACE_MS, systemProbe, type ProbeResult, type ProcessProbe } from "./process-info.ts";
import { FULL_PROBE_MS, OWNER_EXITED, Supervisor } from "./supervisor.ts";
import { findTask, seedTaskList, type ProcessRecord, type TaskList } from "./tasks/model.ts";
import { taskListFile } from "./tasks/paths.ts";
import { createTask, delegateTask, setAgentPane, setAgentProcess, setAgentSession } from "./tasks/rules.ts";
import { TaskListStore } from "./tasks/store.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LEAD = { actor: { name: "lead" }, now: NOW };
const SESSION = "/s/2026_child.jsonl";
const RECORD: ProcessRecord = { pid: 4242, start: "ps:x", machine: "host", token: "child-1", attachedAt: NOW };

class FakeHerdr {
  agents: HerdrAgent[] = [{ name: "tau-t0", paneId: "p2", status: "working", session: SESSION }];
  panes = new Set(["p1", "p2"]);
  closed: string[] = [];
  async listAgents(): Promise<HerdrAgent[]> {
    return [...this.agents];
  }
  async listPanes(): Promise<Set<string>> {
    return new Set(this.panes);
  }
  async closePane(pane: string): Promise<void> {
    this.closed.push(pane);
    this.panes.delete(pane);
    this.agents = this.agents.filter((agent) => agent.paneId !== pane);
  }
  async renameAgent(): Promise<void> {}
}

let dir: string;
let store: TaskListStore;
let herdr: FakeHerdr;
let result: ProbeResult;
let probed: Array<ProcessRecord | undefined>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tau-supervisor-"));
  store = new TaskListStore(taskListFile(join(dir, "tau"), "s1"));
  herdr = new FakeHerdr();
  result = "dead";
  probed = [];
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

/** A list where `tau-t0` runs T0 in pane p2, with its session, and (with `record`) its process record. */
async function makeList(record: ProcessRecord | null = RECORD): Promise<void> {
  await store.ensure(() => {
    const list = seedTaskList("s1", NOW);
    delegateTask(list, LEAD, { id: "T0", agent: "tau-t0" });
    setAgentPane(list, "tau-t0", "p2");
    setAgentSession(list, "tau-t0", SESSION);
    list.agents[0]!.state = "running";
    if (record !== null) setAgentProcess(list, "tau-t0", record);
    return list;
  });
}

function supervisor(
  startingAgents: Set<string> = new Set(),
  processProbe: Pick<ProcessProbe, "quickProbe" | "probe"> = {
    quickProbe: (record) => {
      probed.push(record);
      return result;
    },
    probe: async (records) => {
      probed.push(...records);
      return new Map(records.map((record) => [record, result]));
    },
  },
): Supervisor {
  return new Supervisor({
    store,
    herdr: herdr as unknown as HerdrClient,
    actor: { name: "lead" },
    now: () => NOW,
    startingAgents,
    processProbe,
  });
}

async function read(): Promise<TaskList> {
  return (await store.read())!;
}

describe("Supervisor, process records", () => {
  it("ends a child that herdr shows, when its process is dead for the grace time", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
    await makeList();
    const watcher = supervisor();
    await watcher.check();
    t.mock.timers.tick(ORPHAN_GRACE_MS - 1);
    await watcher.check();
    assert.equal((await read()).agents[0]?.state, "running", "before the grace time");
    assert.deepEqual(herdr.closed, []);

    t.mock.timers.tick(1);
    await watcher.check();
    const list = await read();
    assert.equal(list.agents[0]?.state, "ended");
    assert.equal(findTask(list, "T0")?.status, "failed");
    assert.equal(findTask(list, "T0")?.result, OWNER_EXITED);
    assert.deepEqual(herdr.closed, ["p2"]);
    assert.deepEqual(probed[0], RECORD);
  });

  it("starts the grace time again when the process is alive in between", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
    await makeList();
    const watcher = supervisor();
    await watcher.check();
    t.mock.timers.tick(ORPHAN_GRACE_MS / 2);
    result = "alive";
    await watcher.check();
    result = "dead";
    t.mock.timers.tick(ORPHAN_GRACE_MS / 2);
    await watcher.check();
    assert.equal((await read()).agents[0]?.state, "running");
  });

  it("does not change a child with no process record", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
    await makeList(null);
    const watcher = supervisor();
    await watcher.check();
    t.mock.timers.tick(ORPHAN_GRACE_MS);
    await watcher.check();
    assert.equal((await read()).agents[0]?.state, "running");
    assert.deepEqual(probed, []);
  });

  it("ends the sub-tree of a child whose PID a new process uses, while herdr shows the child", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
    const GRANDCHILD = "/s/2026_grandchild.jsonl";
    await store.ensure(() => {
      const list = seedTaskList("s1", NOW);
      delegateTask(list, LEAD, { id: "T0", agent: "tau-t0" });
      setAgentPane(list, "tau-t0", "p2");
      setAgentSession(list, "tau-t0", SESSION);
      setAgentProcess(list, "tau-t0", RECORD);
      const child = { actor: { name: "tau-t0", scope: "T0" }, now: NOW };
      createTask(list, child, { title: "sub", type: "code", parent: "T0" });
      delegateTask(list, child, { id: "T0.1", agent: "tau-t0-1" });
      setAgentPane(list, "tau-t0-1", "p3");
      setAgentSession(list, "tau-t0-1", GRANDCHILD);
      setAgentProcess(list, "tau-t0-1", { ...RECORD, pid: 4343, token: "grandchild-1" });
      for (const agent of list.agents) agent.state = "running";
      return list;
    });
    herdr.panes.add("p3");
    herdr.agents.push({ name: "tau-t0-1", paneId: "p3", status: "working", session: GRANDCHILD });
    // The real probe on "macOS": all PIDs exist (kill succeeds), but PID
    // 4242 has a different start time now (a new process uses it).
    const psCalls: number[][] = [];
    const real = systemProbe({
      now: () => NOW,
      pid: 100,
      platform: "darwin",
      hostname: () => "host",
      token: () => "me",
      kill: () => undefined,
      ps: async (pids) => {
        psCalls.push([...pids]);
        return pids.map((pid) => `${pid} S ${pid === 4242 ? "Wed Oct 8 00:00:00 2026" : "x"}`).join("\n");
      },
    });
    await real.self();
    assert.equal(real.quickProbe(RECORD), "alive", "kill alone cannot see the new process");
    const watcher = supervisor(new Set(), real);
    await watcher.check();
    t.mock.timers.tick(ORPHAN_GRACE_MS - 1);
    await watcher.check();
    assert.equal((await read()).agents.every((agent) => agent.state === "running"), true, "before the grace time");

    t.mock.timers.tick(1);
    await watcher.check();
    const list = await read();
    assert.deepEqual(list.agents.map((agent) => [agent.name, agent.state]), [
      ["tau-t0", "ended"],
      ["tau-t0-1", "ended"],
    ]);
    assert.equal(findTask(list, "T0")?.status, "failed");
    assert.equal(findTask(list, "T0.1")?.status, "failed");
    assert.deepEqual(herdr.closed.sort(), ["p2", "p3"]);
    // The first ps call is for the self record (PID 100). Then each full
    // probe reads only the child (PID 4242), not the grandchild.
    assert.deepEqual(psCalls[0], [100]);
    assert.ok(psCalls.length > 1);
    assert.ok(psCalls.slice(1).every((pids) => pids.length === 1 && pids[0] === 4242));
  });

  it("makes at most one full probe in FULL_PROBE_MS", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
    await makeList();
    result = "alive";
    let full = 0;
    const watcher = supervisor(new Set(), {
      quickProbe: () => "alive",
      probe: async (records) => {
        full += 1;
        return new Map(records.map((record) => [record, "alive" as const]));
      },
    });
    await watcher.check();
    t.mock.timers.tick(FULL_PROBE_MS - 1);
    await watcher.check();
    assert.equal(full, 1);
    t.mock.timers.tick(1);
    await watcher.check();
    assert.equal(full, 2);
  });

  it("does not check a child that a delegation starts now", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
    await makeList();
    const watcher = supervisor(new Set(["tau-t0"]));
    await watcher.check();
    t.mock.timers.tick(ORPHAN_GRACE_MS);
    await watcher.check();
    assert.equal((await read()).agents[0]?.state, "running");
    assert.deepEqual(probed, []);
  });
});
