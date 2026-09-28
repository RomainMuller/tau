import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { balanceColumn, columnPanes, isPaneId, layoutOwnership, nextMove, placeNewPane, serialized } from "./layout.ts";
import { seedTaskList } from "./tasks/model.ts";
import { taskListFile } from "./tasks/paths.ts";
import { delegateTask, endAgent, setAgentPane, setAgentSession } from "./tasks/rules.ts";
import { TaskListStore } from "./tasks/store.ts";
import { FakeTab } from "./testing/fake-tab.ts";

const all = () => true;
const NOW = "2026-01-01T00:00:00.000Z";

/** Adds a sub-agent pane as tau does: place, split, balance. */
async function addSubAgent(tab: FakeTab, isTauPane: (pane: string) => boolean = all): Promise<string> {
  const placement = (await placeNewPane(tab, "p1", "p1", isTauPane))!;
  const id = tab.split(placement.pane, placement.direction, placement.ratio);
  await balanceColumn(tab, "p1", isTauPane);
  return id;
}

async function assertBalanced(tab: FakeTab, ids: readonly string[], label: string): Promise<void> {
  const heights = await tab.heights(ids);
  assert.ok(Math.max(...heights) - Math.min(...heights) <= 1, `${label}: heights ${heights.join(", ")}`);
  assert.deepEqual(nextMove(await tab.layout(), "p1", all), undefined, `${label}: no move left`);
}

describe("layout of sub-agent panes", () => {
  it("puts the first sub-agent on the right of the lead, at half of the width", async () => {
    const tab = new FakeTab();
    assert.deepEqual(await placeNewPane(tab, "p1", "p1", all), { pane: "p1", direction: "right", ratio: 0.5 });
    const t1 = await addSubAgent(tab);
    const layout = await tab.layout();
    assert.deepEqual(layout.panes.get("p1"), { x: 0, y: 0, width: 150, height: 99 });
    assert.deepEqual(layout.panes.get(t1), { x: 150, y: 0, width: 150, height: 99 });
  });

  for (const height of [85, 99, 100]) {
    it(`keeps the lead at full height, and the column balanced after each new sub-agent (${height} rows, up to 12)`, async () => {
      const tab = new FakeTab({ height });
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        ids.push(await addSubAgent(tab));
        const layout = await tab.layout();
        assert.deepEqual(layout.panes.get("p1"), { x: 0, y: 0, width: 150, height });
        assert.deepEqual(columnPanes(layout, "p1"), ids);
        await assertBalanced(tab, ids, `${ids.length} panes`);
      }
    });
  }

  it("balances the column again after closes, in many orders", async () => {
    // A small fixed pseudo-random sequence: the test is the same at each run.
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let run = 0; run < 30; run++) {
      const tab = new FakeTab({ height: 80 + (run % 21) });
      const ids: string[] = [];
      for (let step = 0; step < 14; step++) {
        if (ids.length > 1 && random() < 0.4) {
          const [gone] = ids.splice(Math.floor(random() * ids.length), 1);
          tab.close(gone!);
          await balanceColumn(tab, "p1", all);
        } else {
          ids.push(await addSubAgent(tab));
        }
        if (ids.length > 1) await assertBalanced(tab, ids, `run ${run} step ${step}`);
      }
    }
  });

  it("does not change a column with a pane that is not a tau pane", async () => {
    const tab = new FakeTab();
    const t1 = await addSubAgent(tab);
    const user = tab.split(t1, "down", 0.8);
    tab.calls = [];
    const isTauPane = (pane: string) => pane !== user;
    await balanceColumn(tab, "p1", isTauPane);
    assert.deepEqual(tab.calls, []);
    // A new sub-agent splits the lowest tau pane, not the pane of the user.
    assert.deepEqual(await placeNewPane(tab, "p1", "p1", isTauPane), { pane: t1, direction: "down", ratio: 0.5 });
  });

  it("does not split a pane of the column that you split to the right", async () => {
    const tab = new FakeTab();
    const t1 = await addSubAgent(tab);
    const t2 = await addSubAgent(tab);
    tab.split(t2, "right", 0.5, "narrow");
    assert.deepEqual(await placeNewPane(tab, "p1", "p1", all), { pane: t1, direction: "down", ratio: 0.5 });
  });

  it("does not split the only tau pane of the column when you split it to the right", async () => {
    const tab = new FakeTab();
    const t1 = await addSubAgent(tab);
    tab.split(t1, "right", 0.5, "user");
    assert.deepEqual(await placeNewPane(tab, "p1", "p1", (pane) => pane !== "user"), { pane: "p1", direction: "right", ratio: 0.5 });
  });

  it("opens a new column when the panes on the right of the lead are not tau panes", async () => {
    const tab = new FakeTab();
    tab.split("p1", "right", 0.5);
    assert.deepEqual(await placeNewPane(tab, "p1", "p1", (pane) => pane === "p1"), { pane: "p1", direction: "right", ratio: 0.5 });
  });

  it("gives no placement when the lead pane or the agent that delegates is not in the layout, or herdr fails", async () => {
    const tab = new FakeTab();
    assert.equal(await placeNewPane(tab, "p9", "p1", all), undefined);
    assert.equal(await placeNewPane(tab, "p1", "w2:p1", all), undefined, "a different tab");
    const failing = { layout: async () => Promise.reject(new Error("no herdr")), resizePane: async () => undefined };
    assert.equal(await placeNewPane(failing, "p1", "p1", all), undefined);
    await balanceColumn(failing, "p1", all);
  });

  it("stops when a resize fails, when the heights come back, and after a bounded number of steps", async () => {
    const tab = new FakeTab();
    for (let i = 0; i < 3; i++) await addSubAgent(tab);
    await tab.resizePane("p2", "down", 0.2);
    // A resize that does nothing: the same heights come back at once.
    let steps = 0;
    await balanceColumn({ layout: () => tab.layout(), resizePane: async () => void (steps += 1) }, "p1", all);
    assert.equal(steps, 1);
    let failed = 0;
    const failing = {
      layout: () => tab.layout(),
      resizePane: async () => {
        failed += 1;
        throw new Error("herdr is busy");
      },
    };
    await balanceColumn(failing, "p1", all);
    assert.equal(failed, 1);
  });

  it("runs layout changes one at a time", async () => {
    const key = {};
    const order: string[] = [];
    let release!: () => void;
    const first = serialized(key, async () => {
      await new Promise<void>((resolve) => (release = resolve));
      order.push("first");
    });
    const second = serialized(key, async () => {
      order.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(order, []);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first", "second"]);
    // An error does not stop the next change.
    await assert.rejects(serialized(key, async () => Promise.reject(new Error("x"))));
    assert.equal(await serialized(key, async () => 1), 1);
  });

  it("accepts only pane IDs in TAU_LEAD_PANE", () => {
    assert.equal(isPaneId("w19:p1"), true);
    for (const value of ["", "-x", "w1 p1", "a".repeat(65), "w1;rm"]) assert.equal(isPaneId(value), false, value);
  });
});

describe("layoutOwnership", () => {
  let dir: string;
  let store: TaskListStore;
  const lead = { name: undefined, paneId: "p1", status: "working", session: "/s/2026_lead.jsonl" };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tau-layout-"));
    store = new TaskListStore(taskListFile(join(dir, "tau"), "lead"));
    await store.ensure(() => ({ ...seedTaskList("lead", NOW), sessionFile: "/s/2026_lead.jsonl" }));
    await store.mutate((list) => {
      delegateTask(list, { actor: { name: "lead" }, now: NOW }, { id: "T0", agent: "tau-t0" });
      setAgentPane(list, "tau-t0", "p2");
      setAgentSession(list, "tau-t0", "/s/2026_t0.jsonl");
    });
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts the lead pane and the panes of live sub-agents", async () => {
    const tab = new FakeTab();
    tab.agents = [lead, { name: "tau-t0", paneId: "p2", status: "working", session: "/s/2026_t0.jsonl" }];
    const isTauPane = (await layoutOwnership(tab, store, "p1"))!;
    assert.equal(isTauPane("p1"), true);
    assert.equal(isTauPane("p2"), true);
    assert.equal(isTauPane("p3"), false);
  });

  it("refuses a lead pane that does not have the lead in it", async () => {
    const tab = new FakeTab();
    tab.agents = [{ ...lead, session: "/s/2026_other.jsonl" }];
    assert.equal(await layoutOwnership(tab, store, "p1"), undefined);
    tab.agents = [];
    assert.equal(await layoutOwnership(tab, store, "p1"), undefined);
  });

  it("refuses a pane where an agent with the name of the sub-agent has a different session", async () => {
    const tab = new FakeTab();
    tab.agents = [lead, { name: "tau-t0", paneId: "p2", status: "working", session: "/s/2026_new.jsonl" }];
    assert.equal((await layoutOwnership(tab, store, "p1"))!("p2"), false);
    tab.agents = [lead, { name: "tau-t0", paneId: "p2", status: "working", session: undefined }];
    assert.equal((await layoutOwnership(tab, store, "p1"))!("p2"), false);
  });

  it("accepts the pane of a starting sub-agent by its name, before it records its session", async () => {
    const tab = new FakeTab();
    const record = { name: "tau-t0" };
    // A new record with no session yet.
    const fresh = new TaskListStore(taskListFile(join(dir, "tau"), "lead2"));
    await fresh.ensure(() => ({ ...seedTaskList("lead2", NOW), sessionFile: "/s/2026_lead2.jsonl" }));
    await fresh.mutate((next) => {
      delegateTask(next, { actor: { name: "lead" }, now: NOW }, { id: "T0", agent: record.name });
      setAgentPane(next, record.name, "p2");
    });
    const lead2 = { ...lead, session: "/s/2026_lead2.jsonl" };
    tab.agents = [lead2, { name: record.name, paneId: "p2", status: "idle", session: undefined }];
    assert.equal((await layoutOwnership(tab, fresh, "p1"))!("p2"), true);
    tab.agents = [lead2, { name: "other", paneId: "p2", status: "idle", session: undefined }];
    assert.equal((await layoutOwnership(tab, fresh, "p1"))!("p2"), false);
    fresh.close();
  });

  it("refuses the pane of an ended sub-agent, and a pane with a different agent in it", async () => {
    const tab = new FakeTab();
    tab.agents = [lead, { name: "user-agent", paneId: "p2", status: "working", session: "/s/2026_user.jsonl" }];
    assert.equal((await layoutOwnership(tab, store, "p1"))!("p2"), false);
    tab.agents = [lead];
    await store.mutate((list) => endAgent(list, "tau-t0", NOW));
    assert.equal((await layoutOwnership(tab, store, "p1"))!("p2"), false);
  });
});
