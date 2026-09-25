import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { checkModel, checkThinking, delegate, firstPrompt, type DelegationContext } from "./delegate.ts";
import type { HerdrAgent, HerdrClient, PaneMetadata, SplitDirection } from "./herdr-client.ts";
import { checkSubAgent, resolveIdentity } from "./identity.ts";
import { agentNameFor, isAgentName } from "./names.ts";
import { TauError } from "./tasks/errors.ts";
import { findTask, rollback, seedTaskList, type TaskList } from "./tasks/model.ts";
import { taskListFile } from "./tasks/paths.ts";
import * as rules from "./tasks/rules.ts";
import { claimTask, createTask, delegateTask, liveDescendantAgents } from "./tasks/rules.ts";
import { TaskListStore } from "./tasks/store.ts";
import { OWNER_EXITED, Supervisor } from "./supervisor.ts";
import { waitForTasks, type TaskSession } from "./tools.ts";
import { DEFAULT_TASK_TYPE_DEFINITIONS } from "./tasks/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LEAD = { actor: { name: "lead" }, now: NOW };

/** A fake herdr. It records the calls, and keeps a list of live agents. */
class FakeHerdr {
  calls: string[] = [];
  agents: HerdrAgent[] = [];
  closed: string[] = [];
  metadata: Array<[string, PaneMetadata]> = [];
  failStart: Error | undefined;
  failSplit: Error | undefined;
  nextPane = 10;
  panes = new Set<string>(["w1:p1"]);
  recordSession = true;

  async splitDirection(): Promise<SplitDirection> {
    return "right";
  }
  async splitPane(from: string, options: { env: Record<string, string> }): Promise<string> {
    this.calls.push(`split ${from} ${JSON.stringify(options.env)}`);
    if (this.failSplit) throw this.failSplit;
    const pane = `w1:p${this.nextPane++}`;
    this.panes.add(pane);
    return pane;
  }
  async startPiAgent(name: string, pane: string, args: readonly string[]): Promise<void> {
    this.calls.push(`start ${name} ${pane} ${args.join(" ")}`);
    if (this.failStart) throw this.failStart;
    // As a real sub-agent does at its start: record its pi session.
    const session = `/s/2026_${name}.jsonl`;
    if (this.recordSession) await store.mutate((list) => rules.setAgentSession(list, name, session));
    this.agents.push({ name, paneId: pane, status: "idle", session });
  }
  async prompt(name: string, text: string): Promise<void> {
    this.calls.push(`prompt ${name} ${text.split("\n")[0]}`);
  }
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
  async reportMetadata(pane: string, metadata: PaneMetadata): Promise<void> {
    this.metadata.push([pane, metadata]);
  }
}

let dir: string;
let tau: string;
let store: TaskListStore;
let herdr: FakeHerdr;
let createdPanes: Set<string>;

function context(name = "lead"): DelegationContext {
  return {
    store,
    actor: { name },
    herdr: herdr as unknown as HerdrClient,
    paneId: "w1:p1",
    cwd: "/work",
    extensionPath: "/ext/tau/src/index.ts",
    now: () => NOW,
    createdPanes,
  };
}

async function read(): Promise<TaskList> {
  return (await store.read())!;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tau-delegate-"));
  tau = join(dir, "tau");
  store = new TaskListStore(taskListFile(tau, "s1"));
  await store.ensure(() => seedTaskList("s1", NOW));
  herdr = new FakeHerdr();
  createdPanes = new Set();
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("agent names", () => {
  it("makes herdr-safe names from task IDs, and adds a number for a used name", () => {
    assert.equal(agentNameFor("T2.1", new Set()), "tau-t2-1");
    assert.equal(agentNameFor("T2.1", new Set(["tau-t2-1"])), "tau-t2-1-2");
    assert.equal(isAgentName("tau-t2-1"), true);
    for (const name of ["lead", "tau-", "Tau-t1", "tau-t1;rm", `tau-${"x".repeat(29)}`]) {
      assert.equal(isAgentName(name), false, name);
    }
  });
});

describe("delegateTask", () => {
  it("gives the task to the agent, and records the agent", async () => {
    const list = await read();
    const task = delegateTask(list, LEAD, { id: "T0", agent: "tau-t0" });
    assert.equal(task.owner, "tau-t0");
    assert.equal(task.status, "in_progress");
    assert.deepEqual(list.agents, [{ name: "tau-t0", parent: "lead", task: "T0", state: "starting", startedAt: NOW }]);
  });

  it("lets a busy agent delegate (delegation is not work)", async () => {
    const list = await read();
    createTask(list, LEAD, { title: "T1", type: "code" });
    claimTask(list, LEAD, "T0");
    assert.equal(delegateTask(list, LEAD, { id: "T1", agent: "tau-t1" }).owner, "tau-t1");
  });

  it("limits the number of sub-agents that run at the same time", async () => {
    const list = await read();
    for (let i = 1; i <= 3; i++) createTask(list, LEAD, { title: `T${i}`, type: "code" });
    delegateTask(list, LEAD, { id: "T1", agent: "tau-t1", maxAgents: 2 });
    delegateTask(list, LEAD, { id: "T2", agent: "tau-t2", maxAgents: 2 });
    assert.throws(() => delegateTask(list, LEAD, { id: "T3", agent: "tau-t3", maxAgents: 2 }), /The maximum is 2\. Use tau_wait/);
  });

  it("does not delegate a sub-task of a task that a different agent owns", async () => {
    const list = await read();
    createTask(list, LEAD, { title: "Sub", type: "code", parent: "T0" });
    claimTask(list, { actor: { name: "tau-t0" }, now: NOW }, "T0");
    assert.throws(() => delegateTask(list, LEAD, { id: "T0.1", agent: "tau-t0-1" }), /@tau-t0 owns the parent task T0/);
  });

  it("applies the scope, the dependencies, and the name rules", async () => {
    const list = await read();
    createTask(list, LEAD, { title: "T1", type: "code", dependencies: ["T0"] });
    assert.throws(() => delegateTask(list, LEAD, { id: "T1", agent: "tau-t1" }), /waits for T0/);
    assert.throws(
      () => delegateTask(list, { actor: { name: "tau-t5", scope: "T5" }, now: NOW }, { id: "T0", agent: "tau-t0" }),
      /only your task T5/,
    );
    delegateTask(list, LEAD, { id: "T0", agent: "tau-x" });
    createTask(list, LEAD, { title: "T2", type: "code" });
    assert.throws(() => delegateTask(list, LEAD, { id: "T2", agent: "tau-x" }), /already used/);
  });
});

describe("delegate", () => {
  it("splits the pane with the identity, starts pi, and sends the first prompt", async () => {
    const result = await delegate(context(), { id: "T0", model: "prov/model-1", thinking: "low" });
    assert.deepEqual(result, { agent: "tau-t0", task: "T0", pane: "w1:p10" });
    assert.equal(herdr.calls.length, 3);
    const env = JSON.parse(herdr.calls[0]!.replace("split w1:p1 ", ""));
    assert.deepEqual(env, {
      TAU_TASKLIST: store.file,
      TAU_TASK_ID: "T0",
      TAU_AGENT_NAME: "tau-t0",
      TAU_PARENT_AGENT: "lead",
    });
    assert.equal(herdr.calls[1], "start tau-t0 w1:p10 --model prov/model-1 --thinking low --extension /ext/tau/src/index.ts");
    assert.match(herdr.calls[2]!, /^prompt tau-t0 You are @tau-t0, a tau sub-agent\. @lead gave you task T0: Prepare task list$/);
    const list = await read();
    assert.deepEqual(list.agents[0], {
      name: "tau-t0",
      parent: "lead",
      task: "T0",
      state: "running",
      startedAt: NOW,
      pane: "w1:p10",
      session: "/s/2026_tau-t0.jsonl",
    });
  });

  it("does not use a name that herdr already uses", async () => {
    herdr.agents.push({ name: "tau-t0", paneId: "w9:p9", status: "idle" });
    const result = await delegate(context(), { id: "T0", model: "prov/m", thinking: "low" });
    assert.equal(result.agent, "tau-t0-2");
  });

  it("fails the task (retryable) and closes the pane when pi does not start", async () => {
    herdr.failStart = new TauError("storage", "herdr agent start failed: timeout");
    await assert.rejects(delegate(context(), { id: "T0", model: "prov/m", thinking: "low" }), /could not start a sub-agent for T0.*timeout.*retry/);
    const list = await read();
    const task = findTask(list, "T0")!;
    assert.equal(task.status, "failed");
    assert.equal(task.retryable, true);
    assert.match(task.result ?? "", /The sub-agent did not start/);
    assert.equal(list.agents[0]?.state, "ended");
    assert.deepEqual(herdr.closed, ["w1:p10"]);
  });

  it("fails the task when the pane cannot be split", async () => {
    herdr.failSplit = new TauError("storage", "no space");
    await assert.rejects(delegate(context(), { id: "T0", model: "prov/m", thinking: "low" }));
    assert.equal(findTask(await read(), "T0")?.status, "failed");
    assert.deepEqual(herdr.closed, []);
  });

  it("rejects model IDs and thinking levels that are not valid", () => {
    for (const model of ["--help", "-e evil", "", "a b", "x;y"]) {
      assert.throws(() => checkModel(model), TauError, model);
    }
    assert.equal(checkModel("ai-gw-openai/openai/gpt-6-sol"), "ai-gw-openai/openai/gpt-6-sol");
    assert.throws(() => checkThinking("huge"), /not a thinking level/);
  });

  it("cleans the title in the first prompt", () => {
    assert.doesNotMatch(firstPrompt("tau-t0", "lead", "T0", "a\u001b[2Jb"), /\u001b/);
  });
});

describe("identity", () => {
  it("is the lead without TAU_TASKLIST", () => {
    const identity = resolveIdentity({}, tau, "s1");
    assert.deepEqual(identity, { role: "lead", actor: { name: "lead" }, file: taskListFile(tau, "s1") });
  });

  it("is a sub-agent with valid variables", async () => {
    const identity = resolveIdentity(
      { TAU_TASKLIST: store.file, TAU_TASK_ID: "T0", TAU_AGENT_NAME: "tau-t0", TAU_PARENT_AGENT: "lead" },
      tau,
      "other-session",
    );
    assert.equal(identity.role, "subagent");
    assert.deepEqual(identity.actor, { name: "tau-t0", scope: "T0" });
    assert.ok(identity.file.endsWith("s1.db"));
  });

  it("rejects a task list outside the tau directory", async () => {
    const outside = join(dir, "elsewhere");
    await mkdir(outside);
    await writeFile(join(outside, "s1.db"), "");
    const env = { TAU_TASKLIST: join(outside, "s1.db"), TAU_TASK_ID: "T0", TAU_AGENT_NAME: "tau-t0", TAU_PARENT_AGENT: "lead" };
    assert.throws(() => resolveIdentity(env, tau, "x"), /not in the tau directory/);
    await symlink(join(tau, "tasklists"), join(dir, "link"));
    // A symbolic link to the real directory is the same directory.
    assert.doesNotThrow(() => resolveIdentity({ ...env, TAU_TASKLIST: join(dir, "link", "s1.db") }, tau, "x"));
  });

  it("rejects variables that are not valid", () => {
    const env = { TAU_TASKLIST: store.file, TAU_TASK_ID: "T0", TAU_AGENT_NAME: "tau-t0", TAU_PARENT_AGENT: "lead" };
    assert.throws(() => resolveIdentity({ ...env, TAU_TASK_ID: "../x" }, tau, "x"), /not a task ID/);
    assert.throws(() => resolveIdentity({ ...env, TAU_AGENT_NAME: "lead" }, tau, "x"), /not a tau agent name/);
    assert.throws(() => resolveIdentity({ ...env, TAU_PARENT_AGENT: "x y" }, tau, "x"), /not a tau agent name/);
    assert.throws(() => resolveIdentity({ ...env, TAU_TASKLIST: join(tau, "tasklists", "s1.json") }, tau, "x"), /not a task list database/);
  });

  it("checks that the task list gave the task to the sub-agent", async () => {
    const env = { TAU_TASKLIST: store.file, TAU_TASK_ID: "T0", TAU_AGENT_NAME: "tau-t0", TAU_PARENT_AGENT: "lead" };
    const identity = resolveIdentity(env, tau, "x");
    assert.equal(identity.role, "subagent");
    if (identity.role !== "subagent") return;
    const before = await read();
    assert.throws(() => checkSubAgent(before, identity, "w1:p10"), /has no sub-agent @tau-t0/);
    await store.mutate((list) => {
      delegateTask(list, LEAD, { id: "T0", agent: "tau-t0" });
      rules.setAgentPane(list, "tau-t0", "w1:p10");
    });
    const list = await read();
    assert.throws(() => checkSubAgent(list, identity, "w1:p99"), /must run in pane w1:p10/);
    assert.doesNotThrow(() => checkSubAgent(list, identity, "w1:p10"));
    const wrongParent = resolveIdentity({ ...env, TAU_PARENT_AGENT: "tau-other" }, tau, "x");
    if (wrongParent.role !== "subagent") return;
    const after = await read();
    assert.throws(() => checkSubAgent(after, wrongParent, "w1:p10"), /has no sub-agent/);
  });
});

describe("Supervisor", () => {
  function supervisor(name = "lead"): Supervisor {
    return new Supervisor({ store, herdr: herdr as unknown as HerdrClient, actor: { name }, now: () => NOW, createdPanes });
  }

  it("does nothing, and calls no herdr command, without sub-agents", async () => {
    let listed = 0;
    herdr.listAgents = async () => {
      listed += 1;
      return [];
    };
    await supervisor().check();
    assert.equal(listed, 0);
  });

  it("fails the task of a sub-agent that does not exist anymore, and closes its pane", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    herdr.agents = [];
    await supervisor().check();
    const list = await read();
    const task = findTask(list, "T0")!;
    assert.equal(task.status, "failed");
    assert.equal(task.result, OWNER_EXITED);
    assert.equal(task.retryable, true);
    assert.equal(list.agents[0]?.state, "ended");
    assert.deepEqual(herdr.closed, ["w1:p10"]);
  });

  it("also fails the tasks of the sub-agents of a dead sub-agent", async () => {
    await store.mutate((list) => {
      createTask(list, LEAD, { title: "Sub", type: "code", parent: "T0" });
    });
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    await delegate(context("tau-t0"), { id: "T0.1", model: "p/m", thinking: "low" });
    assert.equal(liveDescendantAgents(await read(), "lead").length, 2);
    herdr.agents = herdr.agents.filter((agent) => agent.name !== "tau-t0");

    await supervisor().check();

    const list = await read();
    assert.equal(findTask(list, "T0.1")?.status, "failed");
    assert.equal(findTask(list, "T0")?.status, "failed");
    assert.ok(list.agents.every((agent) => agent.state === "ended"));
    assert.deepEqual(herdr.closed.sort(), ["w1:p10", "w1:p11"]);
  });

  it("keeps the pane of a sub-agent that still works on its task", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    herdr.agents[0] = { ...herdr.agents[0]!, status: "working" };
    await supervisor().check();
    assert.equal(findTask(await read(), "T0")?.status, "in_progress");
    assert.deepEqual(herdr.closed, []);
  });

  it("closes the pane when the task is closed and the sub-agent is idle", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    // The sub-agent completes its task.
    await store.mutate((list) =>
      rules.completeTask(list, { actor: { name: "tau-t0" }, now: new Date().toISOString() }, "T0", "done"),
    );
    herdr.agents[0] = { ...herdr.agents[0]!, status: "working" };
    await supervisor().check();
    assert.deepEqual(herdr.closed, [], "it waits while the sub-agent works");
    herdr.agents[0] = { ...herdr.agents[0]!, status: "idle" };
    await supervisor().check();
    assert.deepEqual(herdr.closed, ["w1:p10"]);
    assert.equal((await read()).agents[0]?.state, "ended");
    assert.equal(findTask(await read(), "T0")?.status, "completed");
  });

  it("waits for a sub-agent that is still starting", async () => {
    await store.mutate((list) => delegateTask(list, { actor: { name: "lead" }, now: new Date().toISOString() }, { id: "T0", agent: "tau-t0" }));
    await supervisor().check();
    assert.equal(findTask(await read(), "T0")?.status, "in_progress");
  });

  it("watches only its own sub-agents", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    herdr.agents = [];
    await supervisor("tau-other").check();
    assert.equal(findTask(await read(), "T0")?.status, "in_progress");
  });
});

describe("waitForTasks", () => {
  function session(): TaskSession {
    return { store, actor: { name: "lead" }, now: () => NOW, taskTypes: DEFAULT_TASK_TYPE_DEFINITIONS, waitPollMs: 10 };
  }

  it("returns when all tasks are closed", async () => {
    await store.mutate((list) => claimTask(list, LEAD, "T0"));
    const waiting = waitForTasks(session(), ["T0"]);
    setTimeout(() => {
      void store.mutate((list) => rules.completeTask(list, LEAD, "T0", "done"));
    }, 30);
    assert.match(await waiting, /^All 1 tasks are closed[\s\S]*T0  completed/);
  });

  it("returns at once when one task fails", async () => {
    await store.mutate((list) => {
      createTask(list, LEAD, { title: "T1", type: "code" });
      claimTask(list, LEAD, "T0");
      rules.failTask(list, LEAD, "T0", "x", true);
    });
    const text = await waitForTasks(session(), ["T0", "T1"]);
    assert.match(text, /^T0 failed[\s\S]*T0  failed \(retryable\)[\s\S]*T1  waiting/);
  });

  it("returns when the time ends, or when the signal aborts", async () => {
    assert.match(await waitForTasks(session(), ["T0"], { timeoutMs: 30 }), /The time ended/);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    assert.match(await waitForTasks(session(), ["T0"], { signal: controller.signal }), /The wait was stopped/);
  });

  it("rejects a task that does not exist", async () => {
    await assert.rejects(waitForTasks(session(), ["T9"]), /Task T9 does not exist/);
  });
});


describe("Supervisor, more cases", () => {
  function supervisor(name = "lead"): Supervisor {
    return new Supervisor({ store, herdr: herdr as unknown as HerdrClient, actor: { name }, now: () => NOW, createdPanes });
  }

  it("records the new pane of a child that moved, and keeps its task", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    await store.mutate((list) => rules.setAgentSession(list, "tau-t0", "/s/2026_abc.jsonl"));
    herdr.agents[0] = { name: "tau-t0", paneId: "w2:p7", status: "working", session: "/s/2026_abc.jsonl" };
    await supervisor().check();
    const list = await read();
    assert.equal(list.agents[0]?.pane, "w2:p7");
    assert.equal(findTask(list, "T0")?.status, "in_progress");
    assert.deepEqual(herdr.closed, []);
  });

  it("does not close a pane that a different agent uses, or that tau did not make", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    // A wrong record: the pane of the child is the pane of the lead.
    await store.mutate((list) => rules.setAgentPane(list, "tau-t0", "w1:p1"));
    herdr.agents = [{ name: "tau-lead", paneId: "w1:p1", status: "working" }];
    await supervisor().check();
    assert.equal(findTask(await read(), "T0")?.status, "failed");
    assert.deepEqual(herdr.closed, [], "the pane of the lead stays open");

    createdPanes.clear();
    herdr.panes.add("w1:p10");
    herdr.agents = [];
    const other = new Supervisor({ store, herdr: herdr as unknown as HerdrClient, actor: { name: "lead" }, now: () => NOW });
    await store.mutate((list) => {
      rules.createTask(list, LEAD, { title: "T1", type: "code" });
      rules.delegateTask(list, LEAD, { id: "T1", agent: "tau-t1" });
      rules.setAgentPane(list, "tau-t1", "w1:p10");
    });
    await other.check();
    assert.deepEqual(herdr.closed, [], "an empty pane that this process did not make stays open");
  });

  it("tries a failed close again at the next check", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    herdr.agents = [];
    const close = herdr.closePane.bind(herdr);
    let fails = 1;
    herdr.closePane = async (pane: string) => {
      if (fails-- > 0) throw new Error("herdr is busy");
      await close(pane);
    };
    const watcher = supervisor();
    await watcher.check();
    assert.deepEqual(herdr.closed, []);
    await watcher.check();
    assert.deepEqual(herdr.closed, ["w1:p10"]);
  });

  it("ends a child whose task is closed after the grace time, also when it works", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    await store.mutate((list) => rules.completeTask(list, { actor: { name: "tau-t0" }, now: NOW }, "T0", "done"));
    herdr.agents[0] = { ...herdr.agents[0]!, status: "working" };
    await supervisor().check();
    assert.equal((await read()).agents[0]?.state, "ended");
    assert.deepEqual(herdr.closed, ["w1:p10"]);
  });

  it("does not end a child that still has live sub-agents", async () => {
    await store.mutate((list) => rules.createTask(list, LEAD, { title: "Sub", type: "code", parent: "T0" }));
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    await delegate(context("tau-t0"), { id: "T0.1", model: "p/m", thinking: "low" });
    await store.mutate((list) => {
      rules.completeTask(list, { actor: { name: "tau-t0-1" }, now: NOW }, "T0.1", "done");
      rules.completeTask(list, { actor: { name: "tau-t0" }, now: NOW }, "T0", "done");
    });
    await supervisor().check();
    const record = (await read()).agents.find((agent) => agent.name === "tau-t0");
    assert.notEqual(record?.state, "ended", "the child waits for its own sub-agent to end");
    await supervisor("tau-t0").check();
    await supervisor().check();
    assert.ok((await read()).agents.every((agent) => agent.state === "ended"));
  });

  it("fails a child that did not start in the grace time", async () => {
    await store.mutate((list) => delegateTask(list, LEAD, { id: "T0", agent: "tau-t0" }));
    await supervisor().check();
    assert.equal(findTask(await read(), "T0")?.status, "failed");
  });

  it("fails the task of an ended owner when its open sub-tasks close", async () => {
    await store.mutate((list) => rules.createTask(list, LEAD, { title: "Sub", type: "code", parent: "T0" }));
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    herdr.agents = [];
    await supervisor().check();
    assert.equal(findTask(await read(), "T0")?.status, "in_progress", "T0.1 is still waiting");
    await store.mutate((list) => rules.cancelTask(list, LEAD, "T0.1", "not needed"));
    await supervisor().check();
    assert.equal(findTask(await read(), "T0")?.status, "failed");
  });

  it("continues after a herdr error", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    const list = herdr.listAgents.bind(herdr);
    let fails = 1;
    herdr.listAgents = async () => {
      if (fails-- > 0) throw new Error("herdr is down");
      return list();
    };
    herdr.agents = [];
    await supervisor().check();
    assert.equal(findTask(await read(), "T0")?.status, "in_progress");
    await supervisor().check();
    assert.equal(findTask(await read(), "T0")?.status, "failed");
  });

  it("does not write the task list when nothing changed", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    herdr.agents[0] = { ...herdr.agents[0]!, status: "working" };
    const before = (await read()).revision;
    let writes = 0;
    const mutate = store.mutate.bind(store);
    store.mutate = (async (change: never) => {
      writes += 1;
      return mutate(change);
    }) as typeof store.mutate;
    await supervisor().check();
    assert.equal(writes, 0);
    assert.equal((await read()).revision, before);
  });
});

describe("delegation, more cases", () => {
  function supervisor(name = "lead"): Supervisor {
    return new Supervisor({ store, herdr: herdr as unknown as HerdrClient, actor: { name }, now: () => NOW, createdPanes });
  }

  it("rejects a claim by an ended sub-agent", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    await store.mutate((list) => {
      rules.failTask(list, { actor: { name: "tau-t0" }, now: NOW }, "T0", "x", true);
      rules.endAgent(list, "tau-t0", NOW);
    });
    await assert.rejects(
      store.mutate((list) => rules.claimTask(list, { actor: { name: "tau-t0" }, now: NOW }, "T0")),
      /ended\. It cannot claim/,
    );
  });

  it("gives a retry a new name", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    await store.mutate((list) => {
      rules.failTask(list, { actor: { name: "tau-t0" }, now: NOW }, "T0", "x", true);
      rules.endAgent(list, "tau-t0", NOW);
    });
    const retry = await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    assert.equal(retry.agent, "tau-t0-2");
    const task = findTask(await read(), "T0")!;
    assert.equal(task.owner, "tau-t0-2");
    assert.equal("result" in task, false);
  });

  it("reserves at most the limit when many delegations run at the same time", async () => {
    await store.mutate((list) => {
      for (let i = 1; i <= 5; i++) rules.createTask(list, LEAD, { title: `T${i}`, type: "code" });
    });
    const results = await Promise.allSettled(
      ["T1", "T2", "T3", "T4", "T5"].map((id) =>
        delegate({ ...context(), store: new TaskListStore(store.file) }, { id, model: "p/m", thinking: "low" }),
      ),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 4);
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(rejected.length, 1);
    assert.match(String((rejected[0] as PromiseRejectedResult).reason), /The maximum is 4/);
    assert.equal(herdr.calls.filter((call) => call.startsWith("split")).length, 4);
  });

  it("fails the task and closes the pane when the prompt fails", async () => {
    herdr.prompt = async () => {
      throw new TauError("storage", "herdr agent prompt failed: agent_blocked");
    };
    await assert.rejects(delegate(context(), { id: "T0", model: "p/m", thinking: "low" }), /agent_blocked/);
    assert.equal(findTask(await read(), "T0")?.status, "failed");
    assert.deepEqual(herdr.closed, ["w1:p10"]);
  });

  it("uses a short hash name for a deep task ID", () => {
    const name = agentNameFor("T12.34.56.78.90.12.34.56.78", new Set());
    assert.match(name ?? "", /^tau-h[0-9a-f]{8}$/);
    assert.equal(isAgentName(name ?? ""), true);
  });

  it("keeps only the agents that got their task before the rollback revision", async () => {
    const list = await read();
    delegateTask(list, LEAD, { id: "T0", agent: "tau-t0" });
    const afterFirst = list.revision;
    createTask(list, LEAD, { title: "T1", type: "code" });
    delegateTask(list, LEAD, { id: "T1", agent: "tau-t1" });
    assert.deepEqual(rollback(list, afterFirst).agents.map((agent) => agent.name), ["tau-t0"]);
    assert.deepEqual(rollback(list, afterFirst - 1).agents, [], "T0 exists, but its agent came later");
  });

  it("does not take a different agent with the same name as the child", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    await store.mutate((list) => rules.setAgentSession(list, "tau-t0", "/s/2026_child.jsonl"));
    // The child stopped. A different agent now has its name, in a different pane.
    herdr.agents = [{ name: "tau-t0", paneId: "w3:p1", status: "idle", session: "/s/2026_other.jsonl" }];
    herdr.panes.add("w3:p1");
    await supervisor().check();
    const list = await read();
    assert.equal(findTask(list, "T0")?.status, "failed");
    assert.equal(list.agents[0]?.pane, "w1:p10", "tau does not adopt the pane of the other agent");
    assert.ok(!herdr.closed.includes("w3:p1"));
  });

  it("does not close the pane of a different agent with the same name in the same pane", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    await store.mutate((list) => rules.setAgentSession(list, "tau-t0", "/s/2026_child.jsonl"));
    herdr.agents = [{ name: "tau-t0", paneId: "w1:p10", status: "idle", session: "/s/2026_other.jsonl" }];
    await supervisor().check();
    assert.equal(findTask(await read(), "T0")?.status, "failed");
    assert.deepEqual(herdr.closed, [], "the other agent keeps its pane");
  });

  it("fails a sub-agent that did not record its session in the grace time", async () => {
    herdr.recordSession = false;
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    // The record is old (NOW is in the past), and it has no session.
    await supervisor().check();
    assert.equal(findTask(await read(), "T0")?.status, "failed");
  });

  it("measures the finish grace from the close, not from a later note", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    await store.mutate((list) => {
      rules.completeTask(list, { actor: { name: "tau-t0" }, now: NOW }, "T0", "done");
      rules.addNote(list, { actor: { name: "lead" }, now: new Date().toISOString() }, "T0", "a late note");
    });
    herdr.agents[0] = { ...herdr.agents[0]!, status: "working" };
    await supervisor().check();
    assert.equal((await read()).agents[0]?.state, "ended");
  });

  it("asks the supervisor to close the pane later when the close fails", async () => {
    herdr.failStart = new TauError("storage", "boom");
    herdr.closePane = async () => {
      throw new Error("herdr is busy");
    };
    const later: string[] = [];
    await assert.rejects(
      delegate({ ...context(), closeLater: (pane) => later.push(pane) }, { id: "T0", model: "p/m", thinking: "low" }),
      /The pane w1:p10 is still open; tau tries to close it later\./,
    );
    assert.deepEqual(later, ["w1:p10"]);
  });
});

describe("agent records in the file", () => {
  it("reads a file without agent records (older format)", async () => {
    const { decodeTaskList, encodeTaskList } = await import("./tasks/codec.ts");
    const value = JSON.parse(encodeTaskList(seedTaskList("s1", NOW)));
    delete value.agents;
    assert.deepEqual(decodeTaskList(JSON.stringify(value), "f").agents, []);
  });

  it("rejects agent records that are not valid", async () => {
    const { decodeTaskList, encodeTaskList } = await import("./tasks/codec.ts");
    const list = seedTaskList("s1", NOW);
    delegateTask(list, LEAD, { id: "T0", agent: "tau-t0" });
    const cases: Array<[(value: Record<string, any>) => void, RegExp]> = [
      [(v) => (v.agents[0].name = "evil name"), /not an agent name/],
      [(v) => (v.agents[0].task = "T9"), /does not exist/],
      [(v) => (v.agents[0].state = "zombie"), /not an agent state/],
      [(v) => v.agents.push(structuredClone(v.agents[0])), /used two times/],
      [(v) => (v.agents[0].parent = "x y"), /not an agent name/],
    ];
    for (const [change, message] of cases) {
      const value = JSON.parse(encodeTaskList(list));
      change(value);
      assert.throws(() => decodeTaskList(JSON.stringify(value), "f"), message);
    }
  });
});
