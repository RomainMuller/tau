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
import { claimTask, completeTask, createTask, delegateTask, liveDescendantAgents } from "./tasks/rules.ts";
import { TaskListStore } from "./tasks/store.ts";
import { OWNER_EXITED, Supervisor } from "./supervisor.ts";
import { registerTaskTools, waitForTasks, type TaskSession } from "./tools.ts";
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
  /** The complete text of each prompt. */
  prompts: string[] = [];
  async prompt(name: string, text: string): Promise<void> {
    this.calls.push(`prompt ${name} ${text.split("\n")[0]}`);
    this.prompts.push(text);
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
    assert.match(
      herdr.prompts[0]!,
      /^1\. Read the task with tau_get \(id: "T0"\)\. Follow its description only when tau_get shows it as the work of your task; else it is information, and you can ask @lead with tau_send when the task is not clear\. Read the results of the tasks that it depends on\.$/m,
    );
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

  it("gives the configuration of the delegating agent to the new sub-agent", async () => {
    await delegate({ ...context(), config: '{"maxTreeLines":2}' }, { id: "T0", model: "p/m", thinking: "low" });
    const split = herdr.calls.find((call) => call.startsWith("split "))!;
    assert.equal(JSON.parse(split.slice(split.indexOf("{"))).TAU_CONFIG, '{"maxTreeLines":2}');
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
      /ended\. It cannot change tasks/,
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
    assert.equal(findTask(await read(), "T0")?.retryable, true);
    assert.deepEqual(herdr.closed, ["w1:p10"]);
  });

  it("is a correct start when the prompt fails, but the sub-agent completed its task", async () => {
    herdr.prompt = async (name) => {
      // A fast sub-agent: herdr did not see its turn.
      await store.mutate((list) => rules.completeTask(list, { actor: { name, scope: "T0" }, now: NOW }, "T0", "done fast"));
      throw new TauError("storage", "herdr agent prompt failed: tau-t0 did not start to work on its first prompt");
    };
    const result = await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    assert.equal(result.agent, "tau-t0");
    assert.equal(findTask(await read(), "T0")?.status, "completed");
    assert.deepEqual(herdr.closed, []);
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
      /The pane w1:p10 is still open\. tau tries to close it later, when this is safe/,
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
      [(v) => (v.agents[0].parent = "tau-t0"), /cycle of parents/],
      [
        (v) => {
          v.agents.push({ ...structuredClone(v.agents[0]), name: "tau-t1", parent: "tau-t0" });
          v.agents[0].parent = "tau-t1";
        },
        /cycle of parents/,
      ],
      [(v) => (v.agents[0].parent = "tau-nobody"), /the parent tau-nobody of agent tau-t0 does not exist/],
    ];
    for (const [change, message] of cases) {
      const value = JSON.parse(encodeTaskList(list));
      change(value);
      assert.throws(() => decodeTaskList(JSON.stringify(value), "f"), message);
    }
  });
});

describe("tau_abort", () => {
  type Tool = { execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }> };

  /** The tools of an agent, with a supervisor that closes the panes of aborted agents. */
  /**
   * The tools of an agent process. Each process has its own set of panes
   * that it made (the default is none: the panes of the sub-agents were made
   * by other processes, as in a real tree).
   */
  function toolsOf(
    name: string,
    scope?: string,
    panes: Set<string> = new Set(),
    stop = true,
  ): { tools: Map<string, Tool>; supervisor: Supervisor } {
    const supervisor = new Supervisor({ store, herdr: herdr as unknown as HerdrClient, actor: { name }, now: () => NOW, createdPanes: panes });
    const session: TaskSession = {
      store,
      actor: scope === undefined ? { name } : { name, scope },
      now: () => NOW,
      taskTypes: DEFAULT_TASK_TYPE_DEFINITIONS,
      ...(stop
        ? {
            stopAgents: async (agents) => {
              for (const agent of agents) {
                if (agent.pane !== undefined) supervisor.scheduleClose(agent.pane, agent.name, agent.session);
              }
              await supervisor.checkAgain();
              return agents.flatMap((agent) => {
                if (agent.pane === undefined) return [];
                const outcome = supervisor.closeOutcome(agent.pane);
                return outcome === "closed" ? [] : [{ agent: agent.name, pane: agent.pane, outcome }];
              });
            },
          }
        : {}),
    };
    const tools = new Map<string, Tool>();
    registerTaskTools({ registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool) } as never, session);
    return { tools, supervisor };
  }

  async function abort(tools: Map<string, Tool>, params: Record<string, unknown>): Promise<string> {
    const result = await tools.get("tau_abort")!.execute("1", params);
    return result.content.map((item) => item.text).join("\n");
  }

  /** T0 delegated to tau-t0, which delegated its sub-task T0.1 to tau-t0-1. */
  async function twoLevels(): Promise<void> {
    await store.mutate((list) => {
      createTask(list, LEAD, { title: "Sub", type: "code", parent: "T0" });
    });
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    await delegate(context("tau-t0"), { id: "T0.1", model: "p/m", thinking: "low" });
  }

  it("stops the sub-agent and its sub-agents, fails their tasks, and closes their panes", async () => {
    await twoLevels();
    const text = await abort(toolsOf("lead").tools, { id: "T0", reason: "wrong approach" });

    assert.match(text, /^Aborted T0: tau ended @tau-t0 and 1 of its sub-agents \(@tau-t0-1\), and closed their panes\./);
    assert.match(text, /Failed \(retryable\): T0\.1, T0\./);
    const list = await read();
    for (const id of ["T0", "T0.1"]) {
      const task = findTask(list, id)!;
      assert.equal(task.status, "failed", id);
      assert.equal(task.result, "aborted by @lead: wrong approach", id);
      assert.equal(task.retryable, true, id);
    }
    assert.ok(list.agents.every((agent) => agent.state === "ended"));
    assert.deepEqual(herdr.closed.sort(), ["w1:p10", "w1:p11"]);
  });

  it("lets an agent abort a sub-agent of its sub-agent", async () => {
    await twoLevels();
    await abort(toolsOf("lead").tools, { id: "T0.1", reason: "not necessary" });
    const list = await read();
    assert.equal(findTask(list, "T0.1")?.status, "failed");
    assert.equal(findTask(list, "T0")?.status, "in_progress");
    assert.equal(list.agents.find((agent) => agent.name === "tau-t0")?.state, "running");
    assert.deepEqual(herdr.closed, ["w1:p11"]);
  });

  it("refuses an agent that did not start the owner, a task of the agent, and a task that is not in progress", async () => {
    await twoLevels();
    await store.mutate((list) => {
      createTask(list, LEAD, { title: "Other", type: "code" });
    });
    // tau-t0-1 did not start tau-t0 (its parent).
    await assert.rejects(abort(toolsOf("tau-t0-1", "T0.1").tools, { id: "T0", reason: "x" }), /you did not start it/);
    await assert.rejects(abort(toolsOf("tau-t0", "T0").tools, { id: "T0", reason: "x" }), /You own task T0\. .*tau_fail/);
    await assert.rejects(abort(toolsOf("lead").tools, { id: "T1", reason: "x" }), /Task T1 is waiting\. You can abort only a task in progress/);
    await assert.rejects(abort(toolsOf("lead").tools, { id: "T0", reason: " " }), /The reason is empty/);
    assert.deepEqual(herdr.closed, []);
    assert.equal(findTask(await read(), "T0")?.status, "in_progress");
  });

  it("refuses a task that the lead owns", async () => {
    await store.mutate((list) => {
      claimTask(list, LEAD, "T0");
    });
    await assert.rejects(abort(toolsOf("tau-x").tools, { id: "T0", reason: "x" }), /@lead owns task T0, and you did not start it/);
  });

  it("keeps a task with open sub-tasks in progress, tells it, and refuses a second abort", async () => {
    await store.mutate((list) => {
      createTask(list, LEAD, { title: "Sub", type: "code", parent: "T0" });
    });
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    const text = await abort(toolsOf("lead").tools, { id: "T0", reason: "stop" });
    assert.match(text, /^Aborted T0: tau ended @tau-t0/);
    assert.match(text, /These tasks stay in progress, because they have open sub-tasks: T0\./);
    assert.equal(findTask(await read(), "T0")?.status, "in_progress");
    assert.equal((await read()).agents[0]?.state, "ended");
    // The owner ended: a second abort cannot stop it again.
    await assert.rejects(abort(toolsOf("lead").tools, { id: "T0", reason: "again" }), /@tau-t0 ended already/);
  });

  it("fails a task whose sub-task an agent later in the order owns", async () => {
    // tau-t0 owns T0 and claims T0.1.1 (a sub-task of its active task);
    // tau-t0-1 owns T0.1. T0.1 can close only after T0.1.1.
    await store.mutate((list) => {
      createTask(list, LEAD, { title: "Sub", type: "code", parent: "T0" });
      createTask(list, LEAD, { title: "Sub sub", type: "code", parent: "T0.1" });
    });
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    await delegate(context("tau-t0"), { id: "T0.1", model: "p/m", thinking: "low" });
    await store.mutate((list) => {
      claimTask(list, { actor: { name: "tau-t0", scope: "T0" }, now: NOW }, "T0.1.1");
    });
    const text = await abort(toolsOf("lead").tools, { id: "T0", reason: "stop" });
    assert.doesNotMatch(text, /stay in progress/);
    const list = await read();
    for (const id of ["T0", "T0.1", "T0.1.1"]) assert.equal(findTask(list, id)?.status, "failed", id);
  });

  it("stops a delegation that an abort ends while the sub-agent starts", async () => {
    const { tools } = toolsOf("lead");
    const original = herdr.splitPane.bind(herdr);
    herdr.splitPane = async (from, options) => {
      const pane = await original(from, options);
      // A different agent aborts the new sub-agent now.
      await abort(tools, { id: "T0", reason: "changed plan" });
      return pane;
    };
    await assert.rejects(delegate(context(), { id: "T0", model: "p/m", thinking: "low" }), /ended while it started/);
    const list = await read();
    assert.equal(findTask(list, "T0")?.result, "aborted by @lead: changed plan");
    assert.deepEqual(herdr.closed, ["w1:p10"]);
    assert.ok(!herdr.calls.some((call) => call.startsWith("start ")));
  });
  it("lets a sub-agent abort its own sub-agent, but not a sibling", async () => {
    await twoLevels();
    await store.mutate((list) => {
      createTask(list, LEAD, { title: "Other", type: "code" });
    });
    await delegate(context(), { id: "T1", model: "p/m", thinking: "low" });
    const child = toolsOf("tau-t0", "T0").tools;
    await assert.rejects(abort(child, { id: "T1", reason: "x" }), /@tau-t1 owns task T1, and you did not start it/);
    assert.equal(findTask(await read(), "T1")?.status, "in_progress");
    assert.match(await abort(child, { id: "T0.1", reason: "x" }), /^Aborted T0\.1: tau ended @tau-t0-1, and closed its pane\./);
    assert.equal(findTask(await read(), "T0.1")?.result, "aborted by @tau-t0: x");
  });

  it("closes the current pane of a sub-agent that moved", async () => {
    await twoLevels();
    // herdr moved tau-t0-1 to a new pane (a moved pane gets a new ID).
    herdr.panes.delete("w1:p11");
    herdr.panes.add("w1:p99");
    herdr.agents = herdr.agents.map((agent) => (agent.name === "tau-t0-1" ? { ...agent, paneId: "w1:p99" } : agent));
    await abort(toolsOf("lead").tools, { id: "T0.1", reason: "x" });
    assert.deepEqual(herdr.closed, ["w1:p99"]);
  });

  it("does not close a pane where a different agent with the same name runs", async () => {
    await twoLevels();
    herdr.agents = herdr.agents.map((agent) =>
      agent.name === "tau-t0-1" ? { ...agent, session: "/s/2026_someone-else.jsonl" } : agent,
    );
    await abort(toolsOf("lead").tools, { id: "T0.1", reason: "x" });
    assert.deepEqual(herdr.closed, []);
  });

  it("does not close a pane from the name alone, when the pane is not its own", async () => {
    herdr.recordSession = false;
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    // No session is recorded: the name is not proof. This process did not make the pane.
    await abort(toolsOf("lead").tools, { id: "T0", reason: "x" });
    assert.deepEqual(herdr.closed, []);
  });

  it("does not close an occupied pane without a known session, also when this process made it, and tells it", async () => {
    herdr.recordSession = false;
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    const text = await abort(toolsOf("lead", undefined, createdPanes).tools, { id: "T0", reason: "x" });
    assert.deepEqual(herdr.closed, []);
    assert.match(text, /tau did not close the panes w1:p10 \(@tau-t0\): it cannot prove that the ended agent is in them, and it does not try again\./);
  });

  it("tells when herdr fails and the pane is not closed yet", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    herdr.listAgents = async () => {
      throw new Error("herdr is busy");
    };
    const text = await abort(toolsOf("lead").tools, { id: "T0", reason: "x" });
    assert.match(text, /could not close the panes of @tau-t0 yet/);
    assert.equal(findTask(await read(), "T0")?.status, "failed");
  });

  it("runs a new check when a check runs while tau_abort schedules the close", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    const lead = toolsOf("lead", undefined, new Set(["w1:p50"]));
    herdr.panes.add("w1:p50");
    // A check that runs now, and waits in the close of a different pane.
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const inClose = new Promise<void>((resolve) => (reached = resolve));
    const close = herdr.closePane.bind(herdr);
    herdr.closePane = async (pane) => {
      if (pane === "w1:p50") {
        reached();
        await blocked;
      }
      await close(pane);
    };
    lead.supervisor.scheduleClose("w1:p50", "tau-old");
    const running = lead.supervisor.check();
    // The check passed its list of closes, and waits in the close of w1:p50.
    await inClose;
    const aborting = abort(lead.tools, { id: "T0", reason: "x" });
    // tau_abort changes the list, then schedules its close and waits.
    for (let i = 0; i < 100 && lead.supervisor.closeOutcome("w1:p10") !== "pending"; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(lead.supervisor.closeOutcome("w1:p10"), "pending");
    release();
    await running;
    const text = await aborting;
    assert.deepEqual(herdr.closed, ["w1:p50", "w1:p10"]);
    assert.doesNotMatch(text, /could not close/);
  });

  it("keeps a close request when the agent moved again before the pane list", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    const lead = toolsOf("lead");
    const agents = herdr.agents;
    // herdr shows the agent in w1:p98, but the pane list (a moment later) has w1:p99.
    herdr.agents = agents.map((agent) => ({ ...agent, paneId: "w1:p98" }));
    herdr.panes.delete("w1:p10");
    herdr.panes.add("w1:p99");
    const text = await abort(lead.tools, { id: "T0", reason: "x" });
    assert.match(text, /could not close the panes of @tau-t0 yet/);
    assert.equal(lead.supervisor.closeOutcome("w1:p10"), "pending");
    // The next check finds the agent in its current pane.
    herdr.agents = agents.map((agent) => ({ ...agent, paneId: "w1:p99" }));
    await lead.supervisor.check();
    assert.deepEqual(herdr.closed, ["w1:p99"]);
    assert.equal(lead.supervisor.closeOutcome("w1:p10"), "closed");
  });

  it("stops a delegation that an abort ends after pi started, and sends no prompt", async () => {
    const { tools } = toolsOf("lead", undefined, createdPanes);
    const original = herdr.startPiAgent.bind(herdr);
    herdr.startPiAgent = async (name, pane, args) => {
      await original(name, pane, args);
      await abort(tools, { id: "T0", reason: "changed plan" });
    };
    await assert.rejects(delegate(context(), { id: "T0", model: "p/m", thinking: "low" }), /ended while it started/);
    assert.equal(findTask(await read(), "T0")?.result, "aborted by @lead: changed plan");
    assert.ok(!herdr.calls.some((call) => call.startsWith("prompt ")));
    assert.deepEqual(herdr.closed, ["w1:p10"]);
  });

  it("does not report a start when an abort comes while the first prompt is sent", async () => {
    const { tools } = toolsOf("lead", undefined, createdPanes);
    const original = herdr.prompt.bind(herdr);
    herdr.prompt = async (name, text) => {
      await original(name, text);
      await abort(tools, { id: "T0", reason: "late" });
    };
    await assert.rejects(delegate(context(), { id: "T0", model: "p/m", thinking: "low" }), /ended while it started/);
    assert.equal(findTask(await read(), "T0")?.result, "aborted by @lead: late");
  });

  it("keeps the abort result when a stopped agent tries to close its blocked task", async () => {
    // T0 is delegated to tau-t0. The lead claimed the sub-task T0.1 itself.
    await store.mutate((list) => {
      createTask(list, LEAD, { title: "Sub", type: "code", parent: "T0" });
    });
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    await store.mutate((list) => {
      claimTask(list, LEAD, "T0.1");
    });
    const lead = toolsOf("lead");
    const text = await abort(lead.tools, { id: "T0", reason: "stop" });
    assert.match(text, /These tasks stay in progress, because they have open sub-tasks: T0\./);
    assert.equal(findTask(await read(), "T0.1")?.owner, "lead");

    // The stopped process still runs for a short time. It cannot close T0.
    const stopped = toolsOf("tau-t0", "T0").tools;
    await assert.rejects(
      stopped.get("tau_complete")!.execute("1", { id: "T0", result: "finished anyway" }),
      /ended\. It cannot change tasks/,
    );
    // When the lead closes T0.1, the liveness check fails T0.
    await store.mutate((list) => {
      completeTask(list, LEAD, "T0.1", "done");
    });
    await lead.supervisor.check();
    const task = findTask(await read(), "T0")!;
    assert.equal(task.status, "failed");
    assert.equal(task.result, OWNER_EXITED);
    assert.equal(task.retryable, true);
  });

  it("changes nothing when the session cannot stop agents", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    await assert.rejects(abort(toolsOf("lead", undefined, new Set(), false).tools, { id: "T0", reason: "x" }), /cannot stop sub-agents/);
    assert.equal(findTask(await read(), "T0")?.status, "in_progress");
  });

  it("refuses a reason that makes the result too long, and changes nothing", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    await assert.rejects(abort(toolsOf("lead").tools, { id: "T0", reason: "x".repeat(19_995) }), /The reason has \d+ characters/);
    assert.equal(findTask(await read(), "T0")?.status, "in_progress");
    assert.equal((await read()).agents[0]?.state, "running");
  });
  it("does not close the new pane in the cleanup when herdr cannot list the agents", async () => {
    const later: string[] = [];
    let lists = 0;
    herdr.listAgents = async () => {
      lists += 1;
      if (lists > 1) throw new Error("herdr is busy");
      return [];
    };
    herdr.failStart = new Error("no pi");
    await assert.rejects(
      delegate({ ...context(), closeLater: (pane) => later.push(pane) }, { id: "T0", model: "p/m", thinking: "low" }),
      /The pane w1:p10 is still open\. tau tries to close it later, when this is safe/,
    );
    assert.deepEqual(herdr.closed, []);
    assert.deepEqual(later, ["w1:p10"]);
  });

  it("does not close the new pane in the cleanup when a different agent with the same name is in it", async () => {
    const later: string[] = [];
    herdr.startPiAgent = async (name, pane) => {
      await store.mutate((list) => rules.setAgentSession(list, name, "/s/2026_mine.jsonl"));
      herdr.agents.push({ name, paneId: pane, status: "idle", session: "/s/2026_other.jsonl" });
      throw new Error("no pi");
    };
    await assert.rejects(delegate({ ...context(), closeLater: (pane) => later.push(pane) }, { id: "T0", model: "p/m", thinking: "low" }));
    assert.deepEqual(herdr.closed, []);
    assert.deepEqual(later, ["w1:p10"]);
  });

  it("closes the new pane in the cleanup when the new sub-agent is in it", async () => {
    herdr.startPiAgent = async (name, pane) => {
      await store.mutate((list) => rules.setAgentSession(list, name, "/s/2026_mine.jsonl"));
      herdr.agents.push({ name, paneId: pane, status: "idle", session: "/s/2026_mine.jsonl" });
      throw new Error("no pi");
    };
    await assert.rejects(delegate(context(), { id: "T0", model: "p/m", thinking: "low" }), /The task failed \(retryable: yes\)/);
    assert.deepEqual(herdr.closed, ["w1:p10"]);
  });

  it("reports a correct start when a fast sub-agent completed its task before the check", async () => {
    const original = herdr.prompt.bind(herdr);
    herdr.prompt = async (name, text) => {
      await original(name, text);
      // The sub-agent completes T0, and its parent ends it.
      await store.mutate((list) => {
        completeTask(list, { actor: { name, scope: "T0" }, now: NOW }, "T0", "fast");
        rules.endAgent(list, name, NOW);
      });
    };
    const result = await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    assert.equal(result.agent, "tau-t0");
  });

  it("keeps a blocked task of an aborted start in progress, also when its sub-task closes before the cleanup", async () => {
    await store.mutate((list) => {
      createTask(list, LEAD, { title: "Sub", type: "code", parent: "T0" });
    });
    const { tools } = toolsOf("lead", undefined, createdPanes);
    const original = herdr.startPiAgent.bind(herdr);
    herdr.startPiAgent = async (name, pane, args) => {
      await original(name, pane, args);
      await abort(tools, { id: "T0", reason: "changed plan" });
      // The lead cancels the waiting sub-task before the start cleanup runs.
      await store.mutate((list) => {
        rules.cancelTask(list, LEAD, "T0.1", "not needed");
      });
    };
    await assert.rejects(
      delegate(context(), { id: "T0", model: "p/m", thinking: "low" }),
      /The task stays in progress until its sub-tasks close\. Then tau fails it\./,
    );
    const task = findTask(await read(), "T0")!;
    assert.equal(task.status, "in_progress");
    assert.ok(!task.history.some((event) => event.kind === "failed"));
  });

  it("refuses all task changes of a stopped agent, and permits notes", async () => {
    await store.mutate((list) => {
      createTask(list, LEAD, { title: "Sub", type: "code", parent: "T0" });
    });
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    await abort(toolsOf("lead").tools, { id: "T0", reason: "stop" });
    const stopped = toolsOf("tau-t0", "T0").tools;
    const call = (name: string, params: Record<string, unknown>) => stopped.get(name)!.execute("1", params);
    for (const [name, params] of [
      ["tau_create", { title: "More", type: "code", parent: "T0" }],
      ["tau_update", { id: "T0.1", title: "Changed" }],
      ["tau_cancel", { id: "T0.1", reason: "x" }],
      ["tau_fail", { id: "T0", result: "x", retryable: true }],
      ["tau_claim", { id: "T0.1" }],
    ] as const) {
      await assert.rejects(call(name, params), /ended\. It cannot change tasks/, name);
    }
    await call("tau_note", { task: "T0", text: "a finding" });
    const list = await read();
    assert.equal(findTask(list, "T0.1")?.status, "waiting");
    assert.equal(findTask(list, "T0.1")?.title, "Sub");
    assert.equal(findTask(list, "T0")?.notes.length, 1);
  });
  it("keeps a close request when the agent moves between the agent list and the pane list", async () => {
    await delegate(context(), { id: "T0", model: "p/m", thinking: "low" });
    const lead = toolsOf("lead");
    // The agent list shows the agent in its recorded pane w1:p10; then herdr
    // moves it to w1:p99 before the pane list.
    herdr.listPanes = async () => new Set(["w1:p1", "w1:p99"]);
    const text = await abort(lead.tools, { id: "T0", reason: "x" });
    assert.match(text, /could not close the panes of @tau-t0 yet/);
    herdr.agents = herdr.agents.map((agent) => ({ ...agent, paneId: "w1:p99" }));
    await lead.supervisor.check();
    assert.deepEqual(herdr.closed, ["w1:p99"]);
  });

  it("asks the supervisor to close the current pane of a new sub-agent that moved before the cleanup", async () => {
    const later: Array<[string, string, string | undefined]> = [];
    herdr.startPiAgent = async (name, pane) => {
      await store.mutate((list) => rules.setAgentSession(list, name, "/s/2026_mine.jsonl"));
      // The new pi runs, then herdr moves its pane.
      herdr.panes.delete(pane);
      herdr.panes.add("w1:p77");
      herdr.agents.push({ name, paneId: "w1:p77", status: "idle", session: "/s/2026_mine.jsonl" });
      throw new Error("no pi");
    };
    await assert.rejects(
      delegate({ ...context(), closeLater: (pane, agent, session) => later.push([pane, agent, session]) }, {
        id: "T0",
        model: "p/m",
        thinking: "low",
      }),
      /is still open/,
    );
    assert.deepEqual(later, [["w1:p10", "tau-t0", "/s/2026_mine.jsonl"]]);
    // The supervisor finds the agent by its session, and closes its current pane.
    const supervisor = new Supervisor({ store, herdr: herdr as unknown as HerdrClient, actor: { name: "lead" }, now: () => NOW, createdPanes });
    const [pane, agent, session] = later[0]!;
    supervisor.scheduleClose(pane, agent, session);
    await supervisor.check();
    assert.deepEqual(herdr.closed, ["w1:p77"]);
  });

  it("does not report a start when a different agent completed a retry of the task", async () => {
    const original = herdr.prompt.bind(herdr);
    herdr.prompt = async (name, text) => {
      await original(name, text);
      // An abort, then a retry by a different agent that completes at once.
      await store.mutate((list) => {
        rules.abortTask(list, LEAD, "T0", "restart");
        rules.delegateTask(list, LEAD, { id: "T0", agent: "tau-t0-2" });
        completeTask(list, { actor: { name: "tau-t0-2", scope: "T0" }, now: NOW }, "T0", "done by the retry");
      });
    };
    await assert.rejects(delegate(context(), { id: "T0", model: "p/m", thinking: "low" }), /ended while it started/);
    assert.equal(findTask(await read(), "T0")?.result, "done by the retry");
  });
});
