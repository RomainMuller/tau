import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { HerdrAgent } from "./herdr-client.ts";
import type { ProbeResult } from "./process-info.ts";
import {
  MAX_CLOSE_QUEUE,
  MAX_CLOSES_PER_SWEEP,
  MAX_PEEKS_PER_SWEEP,
  MAX_REAPS_PER_SWEEP,
  OrphanReaper,
  sameProcess,
  type ReapReport,
} from "./reaper.ts";
import { OWNER_EXITED } from "./supervisor.ts";
import { findTask, seedTaskList, type ProcessRecord, type TaskList } from "./tasks/model.ts";
import { taskListFile } from "./tasks/paths.ts";
import { addNote, createTask, delegateTask, endAgent, setAgentPane, setAgentSession, setLeadProcess } from "./tasks/rules.ts";
import { peekLiveness, TaskListStore } from "./tasks/store.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LEAD = { actor: { name: "lead" }, now: NOW };
const GRACE = 120_000;

/** A fake herdr: the agents and panes that it shows, and the closes. */
class FakeHerdr {
  agents: HerdrAgent[] = [];
  panes = new Set<string>();
  closed: string[] = [];
  calls: string[] = [];
  failClose = false;
  async listAgents(): Promise<HerdrAgent[]> {
    this.calls.push("listAgents");
    return [...this.agents];
  }
  async listPanes(): Promise<Set<string>> {
    this.calls.push("listPanes");
    return new Set(this.panes);
  }
  async closePane(pane: string): Promise<void> {
    this.calls.push(`close ${pane}`);
    if (this.failClose) throw new Error("herdr failed");
    this.closed.push(pane);
    this.panes.delete(pane);
    this.agents = this.agents.filter((agent) => agent.paneId !== pane);
  }
}

/** A fake probe: the result for each token (the default is `unknown`). */
class FakeProbe {
  results = new Map<string, ProbeResult>();
  calls: ProcessRecord[][] = [];
  async probe(records: readonly ProcessRecord[]): Promise<Map<ProcessRecord, ProbeResult>> {
    this.calls.push([...records]);
    return new Map(records.map((record) => [record, this.results.get(record.token) ?? "unknown"]));
  }
}

let root: string;
let tau: string;
let herdr: FakeHerdr;
let probe: FakeProbe;
let clock: number;
let reports: ReapReport[];
/** Stores that stay open, as live sub-agents keep a read connection open. */
let open: TaskListStore[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tau-reaper-"));
  tau = join(root, "tau");
  herdr = new FakeHerdr();
  probe = new FakeProbe();
  clock = 1_000_000;
  reports = [];
  open = [];
});

afterEach(async () => {
  for (const store of open) store.close();
  await rm(root, { recursive: true, force: true });
});

function reaper(extra: Partial<ConstructorParameters<typeof OrphanReaper>[0]> = {}): OrphanReaper {
  return new OrphanReaper({
    tauDirectory: tau,
    ownSession: "mine",
    probe,
    herdr,
    now: () => NOW,
    clock: () => clock,
    onReap: (report) => void reports.push(report),
    ...extra,
  });
}

function lead(token = "lead-1"): ProcessRecord {
  return { pid: 4242, start: "ps:x", machine: "host", token, attachedAt: NOW };
}

/**
 * Makes the task list `id`: the lead owns T0, `tau-a` owns T1 and `tau-b`
 * (a sub-agent of `tau-a`) owns T1.1. Each sub-agent has a pane and a
 * session, and herdr shows it. A store stays open (the WAL and SHM files
 * stay). With `record` null, the list has no lead process.
 */
async function makeList(
  id: string,
  record: ProcessRecord | null = lead(),
  withPanes: readonly string[] = ["tau-a", "tau-b"],
): Promise<string> {
  const file = taskListFile(tau, id);
  const store = new TaskListStore(file);
  await store.ensure(() => {
    const list = seedTaskList(id, NOW, "lead");
    if (record !== null) setLeadProcess(list, record);
    createTask(list, LEAD, { title: "A", type: "code" });
    delegateTask(list, LEAD, { id: "T1", agent: "tau-a" });
    const a = { actor: { name: "tau-a", scope: "T1" }, now: NOW };
    createTask(list, a, { title: "B", type: "code", parent: "T1" });
    delegateTask(list, a, { id: "T1.1", agent: "tau-b" });
    for (const name of ["tau-a", "tau-b"]) {
      const pane = `${id}:${name}`;
      setAgentSession(list, name, `/s/2026_${id}-${name}.jsonl`);
      if (!withPanes.includes(name)) continue;
      setAgentPane(list, name, pane);
      herdr.panes.add(pane);
      herdr.agents.push({ name, paneId: pane, status: "working", session: `/s/2026_${id}-${name}.jsonl` });
    }
    return list;
  });
  await store.read();
  open.push(store);
  return file;
}

/**
 * Makes the task list `id` with `count` sub-agents of the lead (`tau-0`,
 * `tau-1`, ...), each in its pane (`<id>:p<n>`), and herdr shows them.
 */
async function makeWideList(id: string, count: number, withPane: (index: number) => boolean = () => true): Promise<string> {
  const file = taskListFile(tau, id);
  const store = new TaskListStore(file);
  await store.ensure(() => {
    const list = seedTaskList(id, NOW, "lead");
    setLeadProcess(list, lead());
    for (let i = 0; i < count; i++) {
      const task = createTask(list, LEAD, { title: `W${i}`, type: "code" });
      const name = `tau-${i}`;
      delegateTask(list, LEAD, { id: task.id, agent: name, maxAgents: count });
      const session = `/s/2026_${id}-${name}.jsonl`;
      setAgentSession(list, name, session);
      if (!withPane(i)) continue;
      const pane = `${id}:p${i}`;
      setAgentPane(list, name, pane);
      herdr.panes.add(pane);
      herdr.agents.push({ name, paneId: pane, status: "working", session });
    }
    return list;
  });
  await store.read();
  open.push(store);
  return file;
}

/** Changes the database file of a list (so its signature changes), but not its liveness. */
async function touch(file: string, text: string): Promise<void> {
  const store = new TaskListStore(file);
  try {
    await store.mutate((list) => addNote(list, LEAD, list.tasks[0]!.id, text));
  } finally {
    store.close();
  }
}

async function read(file: string): Promise<TaskList> {
  const store = new TaskListStore(file);
  try {
    return (await store.read())!;
  } finally {
    store.close();
  }
}

describe("OrphanReaper", () => {
  it("does nothing when the lead is alive, and calls no herdr", async () => {
    const file = await makeList("other");
    probe.results.set("lead-1", "alive");
    const watcher = reaper();
    for (let i = 0; i < 4; i++) {
      await watcher.sweep();
      clock += GRACE;
    }
    assert.equal((await read(file)).agents.every((agent) => agent.state !== "ended"), true);
    assert.deepEqual(herdr.calls, []);
    assert.equal(probe.calls.length, 4);
  });

  it("does nothing when the lead is unknown", async () => {
    const file = await makeList("other");
    const watcher = reaper();
    for (let i = 0; i < 3; i++) {
      await watcher.sweep();
      clock += GRACE;
    }
    assert.equal((await read(file)).agents.every((agent) => agent.state !== "ended"), true);
  });

  it("does not probe a list without a lead process", async () => {
    await makeList("old", null);
    const watcher = reaper();
    await watcher.sweep();
    clock += GRACE;
    await watcher.sweep();
    assert.deepEqual(probe.calls, []);
  });

  it("does not open a list that has no SHM file", async () => {
    const file = await makeList("closed");
    for (const store of open) store.close();
    open = [];
    // The last connection closed: SQLite removed the WAL and SHM files.
    await assert.rejects(stat(`${file}-shm`), { code: "ENOENT" });
    probe.results.set("lead-1", "dead");
    const peeks: string[] = [];
    const watcher = reaper({ peek: (path) => (peeks.push(path), peekLiveness(path)) });
    await watcher.sweep();
    clock += GRACE;
    await watcher.sweep();
    assert.deepEqual(probe.calls, []);
    assert.deepEqual(peeks, []);
    await assert.rejects(stat(`${file}-shm`), { code: "ENOENT" });
  });

  it("ends all sub-agents after the grace time, and closes their panes", async () => {
    const file = await makeList("other");
    probe.results.set("lead-1", "dead");
    const watcher = reaper();
    await watcher.sweep();
    clock += GRACE - 1;
    await watcher.sweep();
    assert.equal((await read(file)).agents.every((agent) => agent.state !== "ended"), true, "before the grace time");
    assert.deepEqual(herdr.calls, []);

    clock += 1;
    await watcher.sweep();
    const list = await read(file);
    assert.deepEqual(list.agents.map((agent) => agent.state), ["ended", "ended"]);
    for (const id of ["T1", "T1.1"]) {
      const task = findTask(list, id)!;
      assert.equal(task.status, "failed", id);
      assert.equal(task.result, OWNER_EXITED);
      assert.equal(task.retryable, true);
      assert.equal(task.history.at(-1)?.actor, "tau");
    }
    // The task of the lead stays: the lead works on it again when you resume it.
    assert.equal(findTask(list, "T0")?.status, "in_progress");
    // Deepest first.
    assert.deepEqual(herdr.closed, ["other:tau-b", "other:tau-a"]);
    assert.deepEqual(reports, [{ session: "other", ended: 2, closed: 2 }]);

    // The next sweep does nothing.
    herdr.calls = [];
    clock += GRACE;
    await watcher.sweep();
    assert.deepEqual(herdr.calls, []);
    assert.equal(reports.length, 1);
  });

  it("starts the grace time again when the lead is alive in between", async () => {
    const file = await makeList("other");
    probe.results.set("lead-1", "dead");
    const watcher = reaper();
    await watcher.sweep();
    clock += GRACE / 2;
    probe.results.set("lead-1", "unknown");
    await watcher.sweep();
    probe.results.set("lead-1", "dead");
    clock += GRACE / 2;
    await watcher.sweep();
    assert.equal((await read(file)).agents.every((agent) => agent.state !== "ended"), true);
  });

  it("does not change the list when the lead attached again after the peek", async () => {
    const file = await makeList("other");
    probe.results.set("lead-1", "dead");
    const watcher = reaper();
    await watcher.sweep();
    clock += GRACE;
    // The lead resumes in the probe of the next sweep (after the peek).
    const original = probe.probe.bind(probe);
    probe.probe = async (records) => {
      const store = new TaskListStore(file);
      await store.mutate((list) => setLeadProcess(list, lead("lead-2")));
      store.close();
      return original(records);
    };
    await watcher.sweep();
    const list = await read(file);
    assert.equal(list.agents.every((agent) => agent.state !== "ended"), true);
    assert.equal(list.leadProcess?.token, "lead-2");
    assert.deepEqual(herdr.closed, []);
  });

  it("writes one time and closes each pane one time with two reapers", async () => {
    const file = await makeList("other");
    probe.results.set("lead-1", "dead");
    const first = reaper();
    const second = reaper({ ownSession: "mine-2" });
    await Promise.all([first.sweep(), second.sweep()]);
    clock += GRACE;
    await Promise.all([first.sweep(), second.sweep()]);
    const list = await read(file);
    assert.deepEqual(list.agents.map((agent) => agent.state), ["ended", "ended"]);
    // Two tasks failed one time each.
    assert.equal(list.tasks.flatMap((task) => task.history).filter((event) => event.kind === "failed").length, 2);
    assert.deepEqual(herdr.closed.sort(), ["other:tau-a", "other:tau-b"]);
    assert.equal(reports.length, 1);
  });

  describe("pane close safety", () => {
    async function reapWith(change: () => void): Promise<OrphanReaper> {
      await makeList("other");
      change();
      probe.results.set("lead-1", "dead");
      const watcher = reaper();
      await watcher.sweep();
      clock += GRACE;
      await watcher.sweep();
      return watcher;
    }

    it("closes the new pane of an agent that moved", async () => {
      await reapWith(() => {
        const moved = herdr.agents.find((agent) => agent.name === "tau-a")!;
        herdr.panes.delete(moved.paneId);
        herdr.panes.add("moved");
        herdr.agents = herdr.agents.map((agent) => (agent === moved ? { ...agent, paneId: "moved" } : agent));
      });
      assert.deepEqual(herdr.closed.sort(), ["moved", "other:tau-b"]);
    });

    it("keeps a pane with a nameless agent, a different agent, or no agent", async () => {
      await reapWith(() => {
        herdr.agents = [
          { name: undefined, paneId: "other:tau-a", status: "idle", session: "/s/2026_other-tau-a.jsonl" },
          { name: "tau-b", paneId: "other:tau-b", status: "idle", session: "/s/2026_different.jsonl" },
        ];
      });
      assert.deepEqual(herdr.closed, []);
      herdr.agents = [];
      clock += GRACE;
      const watcher = reaper();
      await watcher.sweep();
      assert.deepEqual(herdr.closed, []);
    });

    it("keeps the pane of an agent with no session", async () => {
      const file = taskListFile(tau, "nosession");
      const store = new TaskListStore(file);
      await store.ensure(() => {
        const list = seedTaskList("nosession", NOW, "lead");
        setLeadProcess(list, lead());
        createTask(list, LEAD, { title: "A", type: "code" });
        delegateTask(list, LEAD, { id: "T1", agent: "tau-a" });
        setAgentPane(list, "tau-a", "p9");
        return list;
      });
      await store.read();
      open.push(store);
      herdr.panes.add("p9");
      probe.results.set("lead-1", "dead");
      const watcher = reaper();
      await watcher.sweep();
      clock += GRACE;
      await watcher.sweep();
      assert.equal((await read(file)).agents[0]?.state, "ended");
      assert.deepEqual(herdr.closed, []);
    });

    it("closes the panes of two agents of two lists with the same recorded pane", async () => {
      for (const id of ["one", "two"]) {
        const file = taskListFile(tau, id);
        const store = new TaskListStore(file);
        await store.ensure(() => {
          const list = seedTaskList(id, NOW, "lead");
          setLeadProcess(list, lead());
          createTask(list, LEAD, { title: "A", type: "code" });
          delegateTask(list, LEAD, { id: "T1", agent: "tau-a" });
          // The same old pane ID in both lists: the panes moved since.
          setAgentPane(list, "tau-a", "same");
          setAgentSession(list, "tau-a", `/s/2026_${id}.jsonl`);
          return list;
        });
        await store.read();
        open.push(store);
        herdr.panes.add(`moved-${id}`);
        herdr.agents.push({ name: "tau-a", paneId: `moved-${id}`, status: "working", session: `/s/2026_${id}.jsonl` });
      }
      probe.results.set("lead-1", "dead");
      const watcher = reaper();
      await watcher.sweep();
      clock += GRACE;
      await watcher.sweep();
      assert.deepEqual(herdr.closed.sort(), ["moved-one", "moved-two"]);
      assert.deepEqual(reports.sort((a, b) => a.session.localeCompare(b.session)), [
        { session: "one", ended: 1, closed: 1 },
        { session: "two", ended: 1, closed: 1 },
      ]);
    });

    it("ends only the agents whose close fits in the queue, and the others later", async () => {
      const count = MAX_CLOSE_QUEUE + 5;
      const file = await makeWideList("wide", count);
      herdr.failClose = true;
      probe.results.set("lead-1", "dead");
      const watcher = reaper();
      const states = async () => {
        const agents = (await read(file)).agents;
        return { ended: agents.filter((agent) => agent.state === "ended").length, live: agents.filter((agent) => agent.state !== "ended").length };
      };
      await watcher.sweep();
      clock += GRACE;
      await watcher.sweep();
      assert.deepEqual(await states(), { ended: MAX_CLOSE_QUEUE, live: 5 });
      // The queue is full (all closes fail): the next sweeps end no agent,
      // and the 5 agents stay live, so that their panes are not lost.
      for (let i = 0; i < 3; i++) {
        clock += GRACE;
        await watcher.sweep();
      }
      assert.deepEqual(await states(), { ended: MAX_CLOSE_QUEUE, live: 5 });
      assert.deepEqual(herdr.closed, []);

      // herdr works again: the sweeps close the panes, and end the others.
      herdr.failClose = false;
      const sweeps = Math.ceil(count / MAX_CLOSES_PER_SWEEP) + 2;
      for (let i = 0; i < sweeps; i++) {
        clock += 60_000;
        await watcher.sweep();
      }
      assert.deepEqual(await states(), { ended: count, live: 0 });
      assert.equal(new Set(herdr.closed).size, count);
      assert.equal(herdr.closed.length, count);
      assert.equal(reports.reduce((sum, report) => sum + report.ended, 0), count);
    });

    it("ends the agents with no pane, also when the close queue is full", async () => {
      const wide = await makeWideList("wide", MAX_CLOSE_QUEUE);
      herdr.failClose = true;
      probe.results.set("lead-1", "dead");
      const watcher = reaper();
      const live = async (file: string) => (await read(file)).agents.filter((agent) => agent.state !== "ended").length;
      await watcher.sweep();
      clock += GRACE;
      await watcher.sweep();
      // All closes fail: the queue is full with the panes of "wide".
      assert.equal(await live(wide), 0);
      const bare = await makeWideList("bare", 3, () => false);
      await watcher.sweep();
      clock += GRACE;
      await watcher.sweep();
      assert.equal(await live(bare), 0);
      assert.deepEqual(herdr.closed, []);
    });

    describe("with a full close queue", () => {
      let watcher: OrphanReaper;
      const states = async (file: string) =>
        Object.fromEntries((await read(file)).agents.map((agent) => [agent.name, agent.state === "ended" ? "ended" : "live"]));
      /** Ends the agents of a list after the grace time. */
      const reapAll = async () => {
        await watcher.sweep();
        clock += GRACE;
        await watcher.sweep();
      };

      beforeEach(async () => {
        await makeWideList("full", MAX_CLOSE_QUEUE);
        herdr.failClose = true;
        probe.results.set("lead-1", "dead");
        watcher = reaper();
        await reapAll();
      });

      it("ends a sibling with no pane after a sibling with a pane", async () => {
        const file = await makeWideList("mixed", 2, (index) => index === 0);
        await reapAll();
        assert.deepEqual(await states(file), { "tau-0": "live", "tau-1": "ended" });
      });

      it("ends a child with no pane, and keeps its parent with a pane", async () => {
        const file = await makeList("pc", lead(), ["tau-a"]);
        await reapAll();
        assert.deepEqual(await states(file), { "tau-a": "live", "tau-b": "ended" });
      });

      it("keeps a parent with no pane while its child with a pane stays live", async () => {
        const file = await makeList("cp", lead(), ["tau-b"]);
        await reapAll();
        assert.deepEqual(await states(file), { "tau-a": "live", "tau-b": "live" });
      });

      it("keeps a grandparent with no pane while its grandchild with a pane stays live, through an ended parent", async () => {
        // tau-a (live, no pane) -> tau-b (ended) -> tau-c (live, pane).
        const file = taskListFile(tau, "deep");
        const store = new TaskListStore(file);
        await store.ensure(() => {
          const list = seedTaskList("deep", NOW, "lead");
          setLeadProcess(list, lead());
          createTask(list, LEAD, { title: "A", type: "code" });
          delegateTask(list, LEAD, { id: "T1", agent: "tau-a" });
          const a = { actor: { name: "tau-a", scope: "T1" }, now: NOW };
          createTask(list, a, { title: "B", type: "code", parent: "T1" });
          delegateTask(list, a, { id: "T1.1", agent: "tau-b" });
          const b = { actor: { name: "tau-b", scope: "T1.1" }, now: NOW };
          createTask(list, b, { title: "C", type: "code", parent: "T1.1" });
          delegateTask(list, b, { id: "T1.1.1", agent: "tau-c" });
          for (const name of ["tau-a", "tau-b", "tau-c"]) setAgentSession(list, name, `/s/2026_deep-${name}.jsonl`);
          setAgentPane(list, "tau-c", "deep:tau-c");
          herdr.panes.add("deep:tau-c");
          herdr.agents.push({ name: "tau-c", paneId: "deep:tau-c", status: "working", session: "/s/2026_deep-tau-c.jsonl" });
          endAgent(list, "tau-b", NOW);
          return list;
        });
        await store.read();
        open.push(store);
        await reapAll();
        assert.deepEqual(await states(file), { "tau-a": "live", "tau-b": "ended", "tau-c": "live" });
      });

      it("ends a list with no panes after more blocked lists than MAX_REAPS_PER_SWEEP", async () => {
        for (let i = 0; i <= MAX_REAPS_PER_SWEEP; i++) await makeWideList(`blocked-${i}`, 1);
        const bare = await makeWideList("zz-bare", 2, () => false);
        await reapAll();
        assert.deepEqual(await states(bare), { "tau-0": "ended", "tau-1": "ended" });
        assert.deepEqual(herdr.closed, []);
      });
    });

    it("tries a failed close again at the next sweep", async () => {
      const watcher = await reapWith(() => {
        herdr.failClose = true;
      });
      assert.deepEqual(herdr.closed, []);
      assert.deepEqual(reports, [{ session: "other", ended: 2, closed: 0 }]);
      herdr.failClose = false;
      await watcher.sweep();
      assert.deepEqual(herdr.closed.sort(), ["other:tau-a", "other:tau-b"]);
    });
  });

  it("reads a file again after a failed peek, also when the file did not change", async () => {
    const file = await makeList("other");
    probe.results.set("lead-1", "dead");
    const peeks: string[] = [];
    let fail = true;
    const watcher = reaper({
      peek: async (path) => {
        peeks.push(path);
        if (fail) {
          fail = false;
          throw new Error("database is locked");
        }
        return peekLiveness(path);
      },
    });
    await watcher.sweep();
    assert.deepEqual(probe.calls, [], "no candidate after the failed peek");
    await watcher.sweep();
    clock += GRACE;
    await watcher.sweep();
    assert.deepEqual(peeks, [file, file]);
    assert.deepEqual((await read(file)).agents.map((agent) => agent.state), ["ended", "ended"]);
    assert.deepEqual(herdr.closed.sort(), ["other:tau-a", "other:tau-b"]);
  });

  it("keeps the grace time of a list that the peek limit skipped", async () => {
    // Twice the limit: each list gets a peek only at every second sweep,
    // because all lists change at each sweep.
    const files: string[] = [];
    for (let i = 0; i < 2 * MAX_PEEKS_PER_SWEEP; i++) files.push(await makeList(`list-${String(i).padStart(2, "0")}`));
    probe.results.set("lead-1", "dead");
    const watcher = reaper();
    const live = async () => (await Promise.all(files.map(read))).filter((list) => list.agents.some((agent) => agent.state !== "ended")).length;
    for (let sweep = 0; sweep < 40 && (await live()) > 0; sweep++) {
      for (const file of files) await touch(file, `sweep ${sweep}`);
      await watcher.sweep();
      clock += GRACE / 4;
    }
    assert.equal(await live(), 0);
  });

  it("does not peek an unchanged file again, and peeks a changed file", async () => {
    const file = await makeList("other");
    probe.results.set("lead-1", "alive");
    const peeks: string[] = [];
    const watcher = reaper({ peek: (path) => (peeks.push(path), peekLiveness(path)) });
    await watcher.sweep();
    await watcher.sweep();
    assert.deepEqual(peeks, [file]);
    assert.equal(probe.calls.length, 2, "the cached peek gives the candidate");
    const store = new TaskListStore(file);
    await store.mutate((list) => {
      for (const agent of list.agents) agent.state = "ended";
    });
    store.close();
    await watcher.sweep();
    assert.deepEqual(peeks, [file, file]);
    assert.equal(probe.calls.length, 2, "the new peek finds no live agent");
  });

  it("peeks at most MAX_PEEKS_PER_SWEEP files in one sweep", async () => {
    for (let i = 0; i < MAX_PEEKS_PER_SWEEP + 3; i++) await makeList(`list-${String(i).padStart(2, "0")}`);
    probe.results.set("lead-1", "alive");
    const watcher = reaper();
    await watcher.sweep();
    assert.equal(probe.calls[0]?.length, MAX_PEEKS_PER_SWEEP);
    await watcher.sweep();
    assert.equal(probe.calls[1]?.length, MAX_PEEKS_PER_SWEEP + 3);
  });

  it("never changes the list of its own session", async () => {
    const file = await makeList("mine");
    probe.results.set("lead-1", "dead");
    const watcher = reaper();
    await watcher.sweep();
    clock += GRACE;
    await watcher.sweep();
    assert.deepEqual(probe.calls, []);
    assert.equal((await read(file)).agents.every((agent) => agent.state !== "ended"), true);
  });

  it("runs no sweep after stop", async () => {
    await makeList("other");
    const watcher = reaper({ intervalMs: 1, firstDelayMs: 1 });
    watcher.start();
    assert.equal(watcher.running, true);
    watcher.stop();
    await watcher.drain();
    assert.equal(watcher.running, false);
    await watcher.sweep();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(probe.calls, []);
  });

  it("sweeps on its timer", async () => {
    await makeList("other");
    const watcher = reaper({ intervalMs: 1, firstDelayMs: 1 });
    watcher.start();
    for (let i = 0; i < 100 && probe.calls.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    watcher.stop();
    await watcher.drain();
    assert.ok(probe.calls.length >= 2);
  });
});

describe("sameProcess", () => {
  it("compares all fields", () => {
    assert.equal(sameProcess(lead(), lead()), true);
    assert.equal(sameProcess(undefined, undefined), true);
    assert.equal(sameProcess(lead(), undefined), false);
    assert.equal(sameProcess(lead(), { ...lead(), detachedAt: NOW }), false);
    assert.equal(sameProcess(lead(), { ...lead(), attachedAt: "x" }), false);
    assert.equal(sameProcess(lead(), lead("other")), false);
  });
});
