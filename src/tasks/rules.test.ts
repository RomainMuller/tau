import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { TauError, type TauErrorCode } from "./errors.ts";
import { activeTask, getTask, rollback, seedTaskList, type ProcessRecord, type TaskList } from "./model.ts";
import { formatTask } from "../format.ts";
import {
  acknowledgeTask,
  addNote,
  canRetry,
  cancelTask,
  claimTask,
  completeTask,
  createTask,
  failTask,
  delegateTask,
  detachProcess,
  endAgentTree,
  failTasksOfAgent,
  isAgentUnder,
  liveDescendantAgents,
  MAX_EVENTS,
  MAX_NOTES,
  MAX_TASKS,
  MAX_TEXT_LENGTH,
  readyTasks,
  releaseTaskOfAgent,
  setAgentProcess,
  setLeadProcess,
  updateTask,
  type Actor,
  type RuleContext,
} from "./rules.ts";

const LEAD: Actor = { name: "lead" };

let clock = 0;
function ctx(actor: Actor = LEAD): RuleContext {
  clock += 1;
  return { actor, now: new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString() };
}

function throwsTau(fn: () => unknown, code: TauErrorCode, message?: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof TauError, `expected TauError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}

function statuses(list: TaskList): Record<string, string> {
  return Object.fromEntries(list.tasks.map((task) => [task.id, task.status]));
}

let list: TaskList;

beforeEach(() => {
  clock = 0;
  list = seedTaskList("s1", ctx().now);
});

describe("seedTaskList", () => {
  it("makes one waiting plan task T0", () => {
    assert.equal(list.tasks.length, 1);
    const t0 = getTask(list, "T0");
    assert.equal(t0.title, "Prepare task list");
    assert.equal(t0.type, "plan");
    assert.equal(t0.status, "waiting");
    assert.equal(t0.history.length, 1);
  });

  it("gives T0 to an owner when one is set", () => {
    const owned = seedTaskList("s1", ctx().now, "lead");
    const t0 = getTask(owned, "T0");
    assert.equal(t0.status, "in_progress");
    assert.equal(t0.owner, "lead");
    assert.deepEqual(t0.history.map((event) => [event.kind, event.actor, event.seq]), [["created", "tau", 1], ["claimed", "lead", 2]]);
    assert.equal(owned.revision, 2);
    assert.equal(activeTask(owned, "lead")?.id, "T0");
    // The lead cannot claim a different root task before it closes T0.
    createTask(owned, ctx(), { title: "Other", type: "code" });
    throwsTau(() => claimTask(owned, ctx(), "T1"), "busy", /You work on task T0/);
  });
});

describe("createTask", () => {
  it("gives sequential root IDs and per-parent sub-task IDs", () => {
    const t1 = createTask(list, ctx(), { title: "Root one", type: "code" });
    const t2 = createTask(list, ctx(), { title: "Root two", type: "code" });
    const a = createTask(list, ctx(), { title: "Sub A", type: "code", parent: "T2" });
    const b = createTask(list, ctx(), { title: "Sub B", type: "code", parent: "T2" });
    const c = createTask(list, ctx(), { title: "Sub C", type: "code", parent: "T1" });
    const d = createTask(list, ctx(), { title: "Sub D", type: "code", parent: "T2.2" });
    assert.deepEqual([t1.id, t2.id, a.id, b.id, c.id, d.id], ["T1", "T2", "T2.1", "T2.2", "T1.1", "T2.2.1"]);
  });

  it("trims the title and drops an empty description", () => {
    const task = createTask(list, ctx(), { title: "  Title  ", type: "docs", description: "   " });
    assert.equal(task.title, "Title");
    assert.equal("description" in task, false);
  });

  it("rejects bad titles and types", () => {
    throwsTau(() => createTask(list, ctx(), { title: " ", type: "code" }), "invalid_argument", /title is empty/);
    throwsTau(() => createTask(list, ctx(), { title: "a\nb", type: "code" }), "invalid_argument", /one line/);
    throwsTau(() => createTask(list, ctx(), { title: "x".repeat(121), type: "code" }), "invalid_argument");
    throwsTau(() => createTask(list, ctx(), { title: "T", type: "implementation" }), "invalid_argument", /code/);
  });

  it("uses the task types of the context", () => {
    const custom = { ...ctx(), taskTypes: ["spike"] };
    assert.equal(createTask(list, custom, { title: "T", type: "spike" }).type, "spike");
    throwsTau(() => createTask(list, custom, { title: "T", type: "code" }), "invalid_argument");
  });

  it("rejects a parent that does not exist or is closed", () => {
    throwsTau(() => createTask(list, ctx(), { title: "T", type: "code", parent: "T9" }), "not_found");
    createTask(list, ctx(), { title: "T1", type: "code" });
    cancelTask(list, ctx(), "T1", "not needed");
    throwsTau(() => createTask(list, ctx(), { title: "T", type: "code", parent: "T1" }), "invalid_state");
  });

  it("lets only the owner add sub-tasks to a task in progress", () => {
    claimTask(list, ctx(), "T0");
    throwsTau(
      () => createTask(list, ctx({ name: "other" }), { title: "T", type: "code", parent: "T0" }),
      "permission_denied",
    );
    assert.equal(createTask(list, ctx(), { title: "T", type: "code", parent: "T0" }).id, "T0.1");
  });

  it("does not let a scoped agent create root tasks or tasks outside its scope", () => {
    createTask(list, ctx(), { title: "T1", type: "code" });
    const sub = { name: "tau-t1", scope: "T1" };
    throwsTau(() => createTask(list, ctx(sub), { title: "T", type: "code" }), "permission_denied", /under your task T1/);
    throwsTau(() => createTask(list, ctx(sub), { title: "T", type: "code", parent: "T0" }), "permission_denied");
    assert.equal(createTask(list, ctx(sub), { title: "T", type: "code", parent: "T1" }).id, "T1.1");
  });

  it("checks dependencies", () => {
    createTask(list, ctx(), { title: "T1", type: "code" });
    throwsTau(() => createTask(list, ctx(), { title: "T", type: "code", dependencies: ["T7"] }), "not_found");
    throwsTau(() => createTask(list, ctx(), { title: "T", type: "code", dependencies: ["x"] }), "invalid_argument");
    throwsTau(
      () => createTask(list, ctx(), { title: "T", type: "code", parent: "T1", dependencies: ["T1"] }),
      "invalid_argument",
      /parent/,
    );
    const task = createTask(list, ctx(), { title: "T", type: "code", dependencies: ["T1", "T0", "T1"] });
    assert.deepEqual(task.dependencies, ["T1", "T0"]);
  });

  it("does not change the list when a rule fails", () => {
    const before = structuredClone(list);
    throwsTau(() => createTask(list, ctx(), { title: "T", type: "code", dependencies: ["T5"] }), "not_found");
    assert.deepEqual(list, before);
  });
});

describe("updateTask", () => {
  beforeEach(() => {
    createTask(list, ctx(), { title: "T1", type: "code" });
    createTask(list, ctx(), { title: "T2", type: "code" });
  });

  it("changes fields of a waiting task and records only changed fields", () => {
    const task = updateTask(list, ctx(), "T1", { title: "New", type: "code", description: "Details" });
    assert.equal(task.title, "New");
    assert.equal(task.description, "Details");
    assert.deepEqual(task.history.at(-1), {
      kind: "updated",
      at: task.history.at(-1)?.at,
      actor: "lead",
      changes: { title: "New", description: "Details" },
      seq: list.revision,
    });
  });

  it("clears the description with an empty text", () => {
    updateTask(list, ctx(), "T1", { description: "Details" });
    const task = updateTask(list, ctx(), "T1", { description: "" });
    assert.equal("description" in task, false);
  });

  it("rejects changes that change nothing", () => {
    throwsTau(() => updateTask(list, ctx(), "T1", { title: "T1" }), "invalid_argument");
  });

  it("rejects a dependency cycle", () => {
    updateTask(list, ctx(), "T1", { dependencies: ["T2"] });
    throwsTau(() => updateTask(list, ctx(), "T2", { dependencies: ["T1"] }), "invalid_argument", /cycle.*: T2 → T1 → T2/);
  });

  it("lets only the owner change a task in progress, and not its dependencies", () => {
    claimTask(list, ctx(), "T1");
    throwsTau(() => updateTask(list, ctx({ name: "other" }), "T1", { title: "X" }), "permission_denied");
    assert.equal(updateTask(list, ctx(), "T1", { title: "X" }).title, "X");
    throwsTau(() => updateTask(list, ctx(), "T1", { dependencies: ["T2"] }), "invalid_state", /only while a task is waiting/);
  });

  it("rejects changes to closed tasks", () => {
    cancelTask(list, ctx(), "T2", "no");
    throwsTau(() => updateTask(list, ctx(), "T2", { title: "X" }), "invalid_state");
  });

  it("does not let a scoped agent change tasks outside its scope", () => {
    throwsTau(() => updateTask(list, ctx({ name: "s", scope: "T1" }), "T2", { title: "X" }), "permission_denied");
  });
});

describe("claimTask", () => {
  it("claims a waiting task with complete dependencies", () => {
    const task = claimTask(list, ctx(), "T0");
    assert.equal(task.status, "in_progress");
    assert.equal(task.owner, "lead");
    assert.equal(activeTask(list, "lead")?.id, "T0");
  });

  it("rejects a task with open dependencies", () => {
    createTask(list, ctx(), { title: "T1", type: "code", dependencies: ["T0"] });
    throwsTau(() => claimTask(list, ctx(), "T1"), "dependencies_not_complete", /waits for T0/);
  });

  it("rejects a task with a canceled dependency", () => {
    createTask(list, ctx(), { title: "T1", type: "code" });
    createTask(list, ctx(), { title: "T2", type: "code", dependencies: ["T1"] });
    cancelTask(list, ctx(), "T1", "no");
    throwsTau(() => claimTask(list, ctx(), "T2"), "dependencies_not_complete");
  });

  it("allows one active task, and sub-tasks of it at any depth (claim stack)", () => {
    createTask(list, ctx(), { title: "T1", type: "code" });
    createTask(list, ctx(), { title: "T0.1", type: "code", parent: "T0" });
    claimTask(list, ctx(), "T0");
    createTask(list, ctx(), { title: "T0.1.1", type: "code", parent: "T0.1" });
    throwsTau(() => claimTask(list, ctx(), "T1"), "busy", /You work on task T0/);
    claimTask(list, ctx(), "T0.1");
    claimTask(list, ctx(), "T0.1.1");
    assert.equal(activeTask(list, "lead")?.id, "T0.1.1");
    completeTask(list, ctx(), "T0.1.1", "done");
    assert.equal(activeTask(list, "lead")?.id, "T0.1");
    completeTask(list, ctx(), "T0.1", "done");
    assert.equal(activeTask(list, "lead")?.id, "T0");
  });

  it("rejects a task in progress and closed tasks", () => {
    claimTask(list, ctx(), "T0");
    throwsTau(() => claimTask(list, ctx({ name: "x" }), "T0"), "invalid_state", /@lead owns it/);
    completeTask(list, ctx(), "T0", "done");
    throwsTau(() => claimTask(list, ctx(), "T0"), "invalid_state");
  });

  it("claims a retryable failed task again, and clears the old result", () => {
    claimTask(list, ctx(), "T0");
    failTask(list, ctx(), "T0", "timeout", true);
    const task = claimTask(list, ctx({ name: "other" }), "T0");
    assert.equal(task.owner, "other");
    assert.equal("result" in task, false);
    assert.equal("retryable" in task, false);
  });

  it("rejects a failed task that is not retryable", () => {
    claimTask(list, ctx(), "T0");
    failTask(list, ctx(), "T0", "bad idea", false);
    throwsTau(() => claimTask(list, ctx(), "T0"), "invalid_state", /not retryable/);
  });

  it("rejects a sub-task of a closed parent", () => {
    createTask(list, ctx(), { title: "Sub", type: "code", parent: "T0" });
    claimTask(list, ctx(), "T0");
    claimTask(list, ctx(), "T0.1");
    failTask(list, ctx(), "T0.1", "x", true);
    completeTask(list, ctx(), "T0", "done anyway");
    throwsTau(() => claimTask(list, ctx(), "T0.1"), "invalid_state", /parent task T0 is completed/);
  });

  it("does not let a scoped agent claim outside its scope", () => {
    createTask(list, ctx(), { title: "T1", type: "code" });
    throwsTau(() => claimTask(list, ctx({ name: "s", scope: "T1" }), "T0"), "permission_denied");
  });
});

describe("completeTask and failTask", () => {
  beforeEach(() => {
    createTask(list, ctx(), { title: "Sub", type: "code", parent: "T0" });
    claimTask(list, ctx(), "T0");
  });

  it("need the owner and a result", () => {
    throwsTau(() => completeTask(list, ctx({ name: "x" }), "T0", "done"), "permission_denied");
    throwsTau(() => completeTask(list, ctx(), "T0", " "), "invalid_argument");
    throwsTau(() => failTask(list, ctx(), "T0", "", true), "invalid_argument");
  });

  it("need all sub-tasks closed", () => {
    throwsTau(() => completeTask(list, ctx(), "T0", "done"), "invalid_state", /T0.1 \(waiting\)/);
    throwsTau(() => failTask(list, ctx(), "T0", "x", true), "invalid_state");
    cancelTask(list, ctx(), "T0.1", "not needed");
    assert.equal(completeTask(list, ctx(), "T0", "done").status, "completed");
  });

  it("record the result and retryable flag", () => {
    cancelTask(list, ctx(), "T0.1", "not needed");
    const task = failTask(list, ctx(), "T0", "tests fail", true);
    assert.equal(task.result, "tests fail");
    assert.equal(task.retryable, true);
  });

  it("reject a task that is not in progress", () => {
    throwsTau(() => completeTask(list, ctx(), "T0.1", "x"), "invalid_state");
  });
});

describe("acknowledgeTask", () => {
  beforeEach(() => {
    claimTask(list, ctx(), "T0");
    failTask(list, ctx(), "T0", "no", true);
  });

  it("marks a failed task, keeps it failed, and a claim removes the mark", () => {
    const task = acknowledgeTask(list, ctx(), "T0", "not now");
    assert.equal(task.status, "failed");
    assert.equal(task.acknowledged, true);
    assert.equal(task.retryable, true);
    assert.equal(task.history.at(-1)?.kind, "acknowledged");
    claimTask(list, ctx(), "T0");
    assert.equal(getTask(list, "T0").acknowledged, undefined);
  });

  it("rejects a task that is not failed, a second acknowledgment, an empty reason, and a task out of scope", () => {
    createTask(list, ctx(), { title: "T1", type: "code" });
    throwsTau(() => acknowledgeTask(list, ctx(), "T1", "x"), "invalid_state", /only a failed task/);
    throwsTau(() => acknowledgeTask(list, ctx(), "T0", ""), "invalid_argument");
    acknowledgeTask(list, ctx(), "T0", "x");
    throwsTau(() => acknowledgeTask(list, ctx(), "T0", "x"), "invalid_state", /already acknowledged/);
    claimTask(list, ctx(), "T1");
    failTask(list, ctx(), "T1", "no", false);
    throwsTau(() => acknowledgeTask(list, ctx({ name: "tau-t5", scope: "T5" }), "T1", "x"), "permission_denied");
  });

  it("does not let a sub-agent acknowledge the task that it received, but its failed sub-tasks", () => {
    createTask(list, ctx(), { title: "T1", type: "code" });
    delegateTask(list, ctx(), { id: "T1", agent: "tau-t1" });
    const sub = { name: "tau-t1", scope: "T1" };
    createTask(list, ctx(sub), { title: "Part", type: "code", parent: "T1" });
    claimTask(list, ctx(sub), "T1.1");
    failTask(list, ctx(sub), "T1.1", "no", true);
    acknowledgeTask(list, ctx(sub), "T1.1", "not needed");
    failTask(list, ctx(sub), "T1", "no", true);
    throwsTau(() => acknowledgeTask(list, ctx(sub), "T1", "x"), "permission_denied", /Your parent decides/);
    acknowledgeTask(list, ctx(), "T1", "the lead decides");
  });

  it("acknowledges a failed task at the event limit", () => {
    createTask(list, ctx(), { title: "T1", type: "code" });
    for (let i = getTask(list, "T1").history.length; i < MAX_EVENTS - 1; i++) updateTask(list, ctx(), "T1", { title: `T1 ${i}` });
    claimTask(list, ctx(), "T1");
    failTask(list, ctx(), "T1", "no", true);
    throwsTau(() => claimTask(list, ctx(), "T1"), "invalid_state", /maximum/);
    // No retry hint for a claim that cannot work.
    assert.equal(canRetry(list, getTask(list, "T1")), false);
    assert.match(formatTask(list, getTask(list, "T1")), /Retryable: yes \(but the task has the maximum number of changes/);
    assert.equal(acknowledgeTask(list, ctx(), "T1", "too many changes").acknowledged, true);
  });
});

describe("updateTask of a failed task", () => {
  beforeEach(() => {
    createTask(list, ctx(), { title: "T1", type: "code" });
    claimTask(list, ctx(), "T0");
    failTask(list, ctx(), "T0", "no", true);
  });

  it("changes a retryable failed task before a retry, and keeps it failed", () => {
    const task = updateTask(list, ctx(), "T0", { title: "Better", type: "research", description: "Try X", dependencies: ["T1"] });
    assert.equal(task.status, "failed");
    assert.equal(task.retryable, true);
    assert.equal(task.title, "Better");
    assert.equal(task.type, "research");
    assert.equal(task.description, "Try X");
    assert.deepEqual(task.dependencies, ["T1"]);
    // The new dependency applies to the retry.
    throwsTau(() => claimTask(list, ctx(), "T0"), "dependencies_not_complete", /T1/);
  });

  it("rejects changes of a failed task that is not retryable", () => {
    claimTask(list, ctx(), "T1");
    failTask(list, ctx(), "T1", "no", false);
    throwsTau(() => updateTask(list, ctx(), "T1", { title: "x" }), "invalid_state", /failed and not retryable/);
  });
});

describe("cancelTask", () => {
  it("cancels a waiting task and its waiting sub-tasks", () => {
    createTask(list, ctx(), { title: "T1", type: "code" });
    createTask(list, ctx(), { title: "A", type: "code", parent: "T1" });
    createTask(list, ctx(), { title: "B", type: "code", parent: "T1.1" });
    const canceled = cancelTask(list, ctx(), "T1", "scope cut");
    assert.deepEqual(canceled.map((task) => task.id), ["T1", "T1.1", "T1.1.1"]);
    assert.equal(getTask(list, "T1").result, "scope cut");
    assert.match(getTask(list, "T1.1.1").result ?? "", /Parent task T1 was canceled/);
  });

  it("rejects when a sub-task is in progress, and changes nothing", () => {
    createTask(list, ctx(), { title: "T1", type: "code" });
    createTask(list, ctx(), { title: "A", type: "code", parent: "T1" });
    createTask(list, ctx(), { title: "B", type: "code", parent: "T1" });
    claimTask(list, ctx({ name: "w" }), "T1.1");
    const before = structuredClone(list);
    throwsTau(() => cancelTask(list, ctx(), "T1", "x"), "invalid_state", /T1.1/);
    assert.deepEqual(list, before);
  });

  it("needs a reason and a waiting task", () => {
    throwsTau(() => cancelTask(list, ctx(), "T0", " "), "invalid_argument");
    claimTask(list, ctx(), "T0");
    throwsTau(() => cancelTask(list, ctx(), "T0", "x"), "invalid_state");
  });
});

describe("addNote", () => {
  it("lets any agent add a note to any task", () => {
    createTask(list, ctx(), { title: "T1", type: "code" });
    const task = addNote(list, ctx({ name: "s", scope: "T1" }), "T0", "cookie is set in session.ts:88");
    assert.deepEqual(task.notes.map((note) => [note.author, note.text]), [["s", "cookie is set in session.ts:88"]]);
    assert.equal(task.status, "waiting");
  });
});

describe("failTasksOfAgent", () => {
  it("fails all tasks in progress of the agent, deepest first, as retryable", () => {
    createTask(list, ctx(), { title: "Sub", type: "code", parent: "T0" });
    createTask(list, ctx(), { title: "T1", type: "code" });
    claimTask(list, ctx({ name: "w" }), "T0");
    claimTask(list, ctx({ name: "w" }), "T0.1");
    claimTask(list, ctx({ name: "v" }), "T1");
    const { failed, blocked } = failTasksOfAgent(list, ctx({ name: "tau" }), "w", "owner agent exited");
    assert.deepEqual(failed.map((task) => task.id), ["T0.1", "T0"]);
    assert.deepEqual(blocked, []);
    assert.deepEqual(statuses(list), { T0: "failed", "T0.1": "failed", T1: "in_progress" });
    assert.equal(getTask(list, "T0").retryable, true);
    assert.equal(getTask(list, "T0").history.at(-1)?.actor, "tau");
  });
});

describe("failTasksOfAgent with sub-agents", () => {
  it("does not close a task while a sub-task of a different agent is in progress", () => {
    createTask(list, ctx(), { title: "Sub", type: "code", parent: "T0" });
    claimTask(list, ctx({ name: "parent" }), "T0");
    claimTask(list, ctx({ name: "child" }), "T0.1");
    const { failed, blocked } = failTasksOfAgent(list, ctx({ name: "tau" }), "parent", "owner agent exited");
    assert.deepEqual(failed, []);
    assert.deepEqual(blocked.map((task) => task.id), ["T0"]);
    assert.deepEqual(statuses(list), { T0: "in_progress", "T0.1": "in_progress" });

    failTasksOfAgent(list, ctx({ name: "tau" }), "child", "aborted");
    const again = failTasksOfAgent(list, ctx({ name: "tau" }), "parent", "owner agent exited");
    assert.deepEqual(again.failed.map((task) => task.id), ["T0"]);
  });
});

describe("failTasksOfAgent with waiting sub-tasks", () => {
  it("keeps the task in progress until its waiting sub-tasks close", () => {
    claimTask(list, ctx({ name: "parent" }), "T0");
    createTask(list, ctx({ name: "parent" }), { title: "Sub", type: "code", parent: "T0" });
    const first = failTasksOfAgent(list, ctx({ name: "tau" }), "parent", "owner agent exited");
    assert.deepEqual(first.blocked.map((task) => task.id), ["T0"]);

    // The lead finishes the waiting sub-task. Then tau can fail the parent.
    claimTask(list, ctx(), "T0.1");
    completeTask(list, ctx(), "T0.1", "done by lead");
    const second = failTasksOfAgent(list, ctx({ name: "tau" }), "parent", "owner agent exited");
    assert.deepEqual(second.failed.map((task) => task.id), ["T0"]);
  });
});

describe("readyTasks", () => {
  it("lists claimable tasks with complete dependencies", () => {
    createTask(list, ctx(), { title: "T1", type: "code", dependencies: ["T0"] });
    createTask(list, ctx(), { title: "T2", type: "code" });
    createTask(list, ctx(), { title: "Sub", type: "code", parent: "T2" });
    assert.deepEqual(readyTasks(list).map((task) => task.id), ["T0", "T2", "T2.1"]);
    assert.deepEqual(readyTasks(list, "T2").map((task) => task.id), ["T2", "T2.1"]);
  });
});

describe("rollback", () => {
  function buildHistory(): number[] {
    // Returns the revision after each step.
    const marks: number[] = [];
    const mark = () => marks.push(list.revision);
    createTask(list, ctx(), { title: "T1", type: "code", description: "d" }); mark();
    createTask(list, ctx(), { title: "Sub", type: "code", parent: "T0", dependencies: ["T1"] }); mark();
    claimTask(list, ctx(), "T0"); mark();
    updateTask(list, ctx(), "T0", { title: "Plan it", description: "x" }); mark();
    addNote(list, ctx(), "T1", "note"); mark();
    cancelTask(list, ctx(), "T0.1", "no"); mark();
    failTask(list, ctx(), "T0", "x", true); mark();
    claimTask(list, ctx({ name: "b" }), "T0"); mark();
    completeTask(list, ctx({ name: "b" }), "T0", "ok"); mark();
    updateTask(list, ctx(), "T1", { description: "" }); mark();
    return marks;
  }

  it("gives the same list at the last revision", () => {
    buildHistory();
    assert.deepEqual(rollback(list, list.revision), list);
    assert.deepEqual(rollback(list, list.revision + 100), list);
  });

  it("gives the exact state after each event, for all event kinds", () => {
    const snapshots: TaskList[] = [structuredClone(list)];
    const marks: number[] = [list.revision];
    const steps: Array<() => unknown> = [
      () => createTask(list, ctx(), { title: "T1", type: "code", description: "d" }),
      () => createTask(list, ctx(), { title: "Sub", type: "code", parent: "T0", dependencies: ["T1"] }),
      () => claimTask(list, ctx(), "T0"),
      () => updateTask(list, ctx(), "T0", { title: "Plan it", description: "x" }),
      () => addNote(list, ctx(), "T1", "note"),
      () => cancelTask(list, ctx(), "T0.1", "no"),
      () => failTask(list, ctx(), "T0", "x", true),
      () => claimTask(list, ctx({ name: "b" }), "T0"),
      () => completeTask(list, ctx({ name: "b" }), "T0", "ok"),
      () => updateTask(list, ctx(), "T1", { description: "" }),
      () => delegateTask(list, ctx(), { id: "T1", agent: "tau-t1" }),
      () => releaseTaskOfAgent(list, ctx(), "tau-t1", "T1", "The sub-agent did not start"),
      () => claimTask(list, ctx({ name: "c" }), "T1"),
      () => failTask(list, ctx({ name: "c" }), "T1", "no", true),
      () => acknowledgeTask(list, ctx(), "T1", "later"),
    ];
    for (const step of steps) {
      step();
      snapshots.push(structuredClone(list));
      marks.push(list.revision);
    }
    marks.forEach((revision, index) => {
      assert.deepEqual(rollback(list, revision), snapshots[index], `revision ${revision}`);
    });
  });

  it("separates events with the same time", () => {
    const fixed = { actor: LEAD, now: "2026-01-01T00:00:00.000Z" };
    createTask(list, fixed, { title: "T1", type: "code" });
    const fork = list.revision;
    claimTask(list, fixed, "T1");
    assert.equal(getTask(rollback(list, fork), "T1").status, "waiting");
  });

  it("gives each event a unique revision in order", () => {
    buildHistory();
    const seqs = list.tasks.flatMap((task) => task.history.map((event) => event.seq)).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: list.revision }, (_, i) => i + 1));
  });

  it("rejects a revision that is not valid", () => {
    throwsTau(() => rollback(list, -1), "invalid_argument");
    throwsTau(() => rollback(list, 1.5), "invalid_argument");
  });
});

describe("dependency cycles through sub-tasks", () => {
  it("rejects a dependency that waits for the parent of the task", () => {
    // T1 depends on T2. T2 can close only after T2.1. So T2.1 cannot depend on T1.
    createTask(list, ctx(), { title: "T1", type: "code" });
    createTask(list, ctx(), { title: "T2", type: "code" });
    updateTask(list, ctx(), "T1", { dependencies: ["T2"] });
    throwsTau(
      () => createTask(list, ctx(), { title: "Sub", type: "code", parent: "T2", dependencies: ["T1"] }),
      "invalid_argument",
      /cycle.*T2\.1 → T1 → T2/,
    );
  });

  it("rejects an update that makes the same cycle", () => {
    createTask(list, ctx(), { title: "T1", type: "code" });
    createTask(list, ctx(), { title: "T2", type: "code" });
    createTask(list, ctx(), { title: "Sub", type: "code", parent: "T2", dependencies: ["T1"] });
    throwsTau(() => updateTask(list, ctx(), "T1", { dependencies: ["T2"] }), "invalid_argument", /cycle/);
  });

  it("allows a task to depend on its own sub-task", () => {
    createTask(list, ctx(), { title: "T1", type: "code" });
    createTask(list, ctx(), { title: "Sub", type: "code", parent: "T1" });
    assert.deepEqual(updateTask(list, ctx(), "T1", { dependencies: ["T1.1"] }).dependencies, ["T1.1"]);
  });
});

describe("limits", () => {
  it("rejects control characters in titles", () => {
    throwsTau(() => createTask(list, ctx(), { title: "a\u001b[31mred", type: "code" }), "invalid_argument");
    throwsTau(() => createTask(list, ctx(), { title: "a\rb", type: "code" }), "invalid_argument");
  });

  it("limits the number of tasks and notes", () => {
    for (let i = list.tasks.length; i < MAX_TASKS; i++) {
      list.tasks.push({ ...structuredClone(getTask(list, "T0")), id: `T${i}` });
    }
    throwsTau(() => createTask(list, ctx(), { title: "one more", type: "code" }), "invalid_state", /maximum/);
    const task = getTask(list, "T0");
    for (let i = 0; i < MAX_NOTES; i++) addNote(list, ctx(), "T0", `n${i}`);
    throwsTau(() => addNote(list, ctx(), "T0", "one more"), "invalid_state");
    assert.equal(task.notes.length, MAX_NOTES);
  });

  it("limits the number of changes of one task", () => {
    const task = getTask(list, "T0");
    for (let i = 0; task.history.length < MAX_EVENTS; i++) {
      updateTask(list, ctx(), "T0", { title: `Title ${i}` });
    }
    throwsTau(() => updateTask(list, ctx(), "T0", { title: "one more" }), "invalid_state", /maximum/);
    assert.equal(task.history.length, MAX_EVENTS);
  });

  it("always accepts a close of a task at the change limit", () => {
    createTask(list, ctx(), { title: "Sub", type: "code", parent: "T0" });
    const sub = getTask(list, "T0.1");
    for (let i = 0; sub.history.length < MAX_EVENTS; i++) {
      updateTask(list, ctx(), "T0.1", { title: `Title ${i}` });
    }
    assert.equal(cancelTask(list, ctx(), "T0.1", "too many changes")[0]?.status, "canceled");

    const t0 = getTask(list, "T0");
    for (let i = 0; t0.history.length < MAX_EVENTS - 1; i++) {
      updateTask(list, ctx(), "T0", { title: `Title ${i}` });
    }
    claimTask(list, ctx(), "T0");
    assert.equal(completeTask(list, ctx(), "T0", "done").status, "completed");
  });

  it("rejects a text that is too long", () => {
    throwsTau(() => addNote(list, ctx(), "T0", "x".repeat(MAX_TEXT_LENGTH + 1)), "invalid_argument");
  });
});

describe("agent tree", () => {
  it("walks each agent one time, also with a cycle of parents", () => {
    delegateTask(list, ctx(), { id: "T0", agent: "tau-a" });
    list.agents.push({ name: "tau-b", parent: "tau-a", task: "T0", state: "running", startedAt: ctx().now });
    // A cycle that the codec rejects: tau-a started by tau-b.
    (list.agents[0] as { parent: string }).parent = "tau-b";
    assert.deepEqual(
      liveDescendantAgents(list, "tau-a").map((agent) => agent.name),
      ["tau-b"],
    );
    assert.equal(isAgentUnder(list, list.agents[0]!, "lead"), false);
  });
});

describe("endAgentTree", () => {
  it("fails the tasks deepest first, tries the blocked tasks again, and ends the records", () => {
    // lead -> tau-a (T1) -> tau-b (T1.1, a sub-task that tau-b owns under T1)
    createTask(list, ctx(), { title: "A", type: "code" });
    delegateTask(list, ctx(), { id: "T1", agent: "tau-a" });
    const a: Actor = { name: "tau-a", scope: "T1" };
    createTask(list, ctx(a), { title: "B", type: "code", parent: "T1" });
    delegateTask(list, ctx(a), { id: "T1.1", agent: "tau-b" });
    const b: Actor = { name: "tau-b", scope: "T1.1" };
    createTask(list, ctx(b), { title: "C", type: "code", parent: "T1.1" });
    claimTask(list, ctx(b), "T1.1.1");
    // The wrong order (parent first): T1 is blocked, then tried again.
    const agents = [list.agents.find((item) => item.name === "tau-a")!, list.agents.find((item) => item.name === "tau-b")!];
    const result = endAgentTree(list, ctx({ name: "tau" }), agents, "owner agent exited");
    assert.deepEqual(result.failed.map((task) => task.id).sort(), ["T1", "T1.1", "T1.1.1"]);
    assert.deepEqual(result.blocked, []);
    assert.deepEqual(list.agents.map((agent) => agent.state), ["ended", "ended"]);
    for (const id of ["T1", "T1.1", "T1.1.1"]) {
      const task = getTask(list, id);
      assert.equal(task.result, "owner agent exited");
      assert.equal(task.retryable, true);
      assert.equal(task.history.at(-1)?.actor, "tau");
    }
  });

  it("keeps a task with an open sub-task of the lead in progress", () => {
    delegateTask(list, ctx(), { id: "T0", agent: "tau-a" });
    const a: Actor = { name: "tau-a", scope: "T0" };
    createTask(list, ctx(a), { title: "B", type: "code", parent: "T0" });
    claimTask(list, ctx(), "T0.1");
    const result = endAgentTree(list, ctx({ name: "tau" }), [list.agents[0]!], "owner agent exited");
    assert.deepEqual(result.blocked.map((task) => task.id), ["T0"]);
    assert.equal(getTask(list, "T0.1").status, "in_progress");
    assert.equal(list.agents[0]?.state, "ended");
  });
});

describe("process records", () => {
  const record = { pid: 42, machine: "m", token: "t1", attachedAt: "a" };

  it("sets the lead and agent records", () => {
    setLeadProcess(list, record);
    assert.deepEqual(list.leadProcess, record);
    delegateTask(list, ctx(), { id: "T0", agent: "tau-a" });
    setAgentProcess(list, "tau-a", record);
    assert.deepEqual(list.agents[0]?.process, record);
    assert.notEqual(list.agents[0]?.process, record);
  });

  it("detaches only with the same token, and one time", () => {
    const item: ProcessRecord = { ...record };
    assert.equal(detachProcess(undefined, "t1", "now"), false);
    assert.equal(detachProcess(item, "t2", "now"), false);
    assert.equal(item.detachedAt, undefined);
    assert.equal(detachProcess(item, "t1", "now"), true);
    assert.equal(detachProcess(item, "t1", "later"), false);
    assert.equal(item.detachedAt, "now");
  });
});
