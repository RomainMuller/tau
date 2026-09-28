import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { forkRevision, forkTaskList, OWNER_IN_OTHER_SESSION, REVISION_ENTRY, sessionIdOf } from "./fork.ts";
import { decodeTaskList, encodeTaskList } from "./tasks/codec.ts";
import { findTask, seedTaskList, type TaskList } from "./tasks/model.ts";
import { claimTask, completeTask, createTask, delegateTask, type RuleContext } from "./tasks/rules.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LEAD: RuleContext = { actor: { name: "lead" }, now: NOW };
const as = (name: string, scope: string): RuleContext => ({ actor: { name, scope }, now: NOW });

const revisionEntry = (revision: unknown) => ({ type: "custom", customType: REVISION_ENTRY, data: { revision } });

describe("forkRevision", () => {
  it("takes the last valid revision entry of the branch", () => {
    assert.equal(
      forkRevision([
        revisionEntry(2),
        { type: "message" },
        revisionEntry(5),
        { type: "custom", customType: "other", data: { revision: 9 } },
        revisionEntry("7"),
        revisionEntry(-1),
      ]),
      5,
    );
  });

  it("is undefined when the branch has no revision entry", () => {
    assert.equal(forkRevision([{ type: "message" }, { type: "custom", customType: "other" }]), undefined);
  });
});

/**
 * The old list: T0 done by the lead; T1 delegated to tau-t1, which delegated
 * T1.1 to tau-t1-1; T2 claimed by the lead. Returns the list and the
 * revision after T2 was claimed.
 */
function oldList(): { list: TaskList; revision: number } {
  const list = seedTaskList("old", NOW);
  claimTask(list, LEAD, "T0");
  createTask(list, LEAD, { title: "Delegated", type: "code" });
  createTask(list, LEAD, { title: "Mine", type: "code" });
  createTask(list, LEAD, { title: "Sub", type: "code", parent: "T1" });
  completeTask(list, LEAD, "T0", "planned");
  delegateTask(list, LEAD, { id: "T1", agent: "tau-t1" });
  delegateTask(list, as("tau-t1", "T1"), { id: "T1.1", agent: "tau-t1-1" });
  claimTask(list, LEAD, "T2");
  const revision = list.revision;
  // After the fork point.
  createTask(list, LEAD, { title: "Later", type: "code" });
  return { list, revision };
}

describe("forkTaskList", () => {
  it("is a new list with T0 when there is no fork point", () => {
    const forked = forkTaskList(oldList().list, undefined, "new", NOW);
    assert.equal(forked.sessionId, "new");
    assert.deepEqual(forked.tasks.map((task) => task.id), ["T0"]);
  });

  it("rolls back to the fork point, and fails the tasks of the sub-agents of the old session", () => {
    const { list, revision } = oldList();
    const forked = forkTaskList(list, revision, "new", NOW);
    assert.equal(forked.sessionId, "new");
    // "Later" was made after the fork point.
    assert.deepEqual(forked.tasks.map((task) => task.id), ["T0", "T1", "T2", "T1.1"]);
    for (const id of ["T1", "T1.1"]) {
      const task = findTask(forked, id)!;
      assert.equal(task.status, "failed", id);
      assert.equal(task.result, OWNER_IN_OTHER_SESSION, id);
      assert.equal(task.retryable, true, id);
    }
    // The lead works in the fork: its task stays in progress.
    assert.equal(findTask(forked, "T2")?.status, "in_progress");
    assert.equal(findTask(forked, "T2")?.owner, "lead");
    assert.ok(forked.agents.every((agent) => agent.state === "ended"));
    // The old list does not change.
    assert.equal(findTask(list, "T1")?.status, "in_progress");
  });

  it("cancels the waiting sub-tasks of a sub-agent task, then fails it, at all depths", () => {
    const list = seedTaskList("old", NOW);
    claimTask(list, LEAD, "T0");
    createTask(list, LEAD, { title: "A", type: "code" });
    completeTask(list, LEAD, "T0", "planned");
    delegateTask(list, LEAD, { id: "T1", agent: "tau-t1" });
    const child = as("tau-t1", "T1");
    createTask(list, child, { title: "Deep", type: "code", parent: "T1" });
    createTask(list, child, { title: "Waiting", type: "code", parent: "T1" });
    delegateTask(list, child, { id: "T1.1", agent: "tau-t1-1" });
    createTask(list, as("tau-t1-1", "T1.1"), { title: "Deeper waiting", type: "code", parent: "T1.1" });
    const snapshot = structuredClone(list);
    const forked = forkTaskList(list, list.revision, "new", NOW);
    assert.deepEqual(
      forked.tasks.map((task) => [task.id, task.status]),
      [
        ["T0", "completed"],
        ["T1", "failed"],
        ["T1.1", "failed"],
        ["T1.2", "canceled"],
        ["T1.1.1", "canceled"],
      ],
    );
    for (const id of ["T1.2", "T1.1.1"]) {
      const event = findTask(forked, id)!.history.at(-1) as { kind: string; reason?: string };
      assert.equal(event.kind, "canceled", id);
      assert.equal(event.reason, OWNER_IN_OTHER_SESSION, id);
    }
    assert.deepEqual(
      forked.agents.map((agent) => [agent.name, agent.state, agent.endedAt]),
      [
        ["tau-t1", "ended", NOW],
        ["tau-t1-1", "ended", NOW],
      ],
    );
    // The old list does not change.
    assert.deepEqual(list, snapshot);
    assert.deepEqual(decodeTaskList(encodeTaskList(forked), "f"), forked);
  });

  it("keeps a sub-agent task in progress when the lead owns one of its sub-tasks", () => {
    const list = seedTaskList("old", NOW);
    createTask(list, LEAD, { title: "A", type: "code" });
    createTask(list, LEAD, { title: "Lead part", type: "code", parent: "T1" });
    delegateTask(list, LEAD, { id: "T1", agent: "tau-t1" });
    claimTask(list, LEAD, "T1.1");
    const forked = forkTaskList(list, list.revision, "new", NOW);
    assert.equal(findTask(forked, "T1.1")?.status, "in_progress");
    assert.equal(findTask(forked, "T1")?.status, "in_progress");
    assert.equal(forked.agents[0]?.state, "ended");
  });

  it("keeps a waiting sub-task that has a task of the lead under it (the lead closes or cancels it)", () => {
    const list = seedTaskList("old", NOW);
    createTask(list, LEAD, { title: "A", type: "code" });
    createTask(list, LEAD, { title: "Waiting", type: "code", parent: "T1" });
    createTask(list, LEAD, { title: "Lead part", type: "code", parent: "T1.1" });
    delegateTask(list, LEAD, { id: "T1", agent: "tau-t1" });
    claimTask(list, LEAD, "T1.1.1");
    const forked = forkTaskList(list, list.revision, "new", NOW);
    assert.deepEqual(
      forked.tasks.map((task) => [task.id, task.status]),
      [
        ["T0", "waiting"],
        ["T1", "in_progress"],
        ["T1.1", "waiting"],
        ["T1.1.1", "in_progress"],
      ],
    );
    assert.equal(forked.agents[0]?.state, "ended");
  });

  it("makes a list that the codec accepts", () => {
    const { list, revision } = oldList();
    const forked = forkTaskList(list, revision, "new", NOW);
    assert.deepEqual(decodeTaskList(encodeTaskList(forked), "f"), forked);
  });
});

describe("sessionIdOf", () => {
  it("reads the ID in the header of a session file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tau-fork-"));
    try {
      const file = join(dir, "s.jsonl");
      await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: "abc-1", timestamp: NOW, cwd: "/" })}\n{"type":"message"}\n`);
      assert.equal(await sessionIdOf(file), "abc-1");
      await writeFile(file, '{"type":"message","id":"x"}\n');
      assert.equal(await sessionIdOf(file), undefined);
      await writeFile(file, "not json");
      assert.equal(await sessionIdOf(file), undefined);
      assert.equal(await sessionIdOf(join(dir, "missing.jsonl")), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
