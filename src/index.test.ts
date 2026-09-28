import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { DEFAULT_CONFIG } from "./config.ts";
import tau, { createTau, type TauDependencies } from "./index.ts";
import { TaskListStore } from "./tasks/store.ts";
import { seedTaskList } from "./tasks/model.ts";
import { completeTask, createTask, delegateTask, setAgentPane, setAgentSession } from "./tasks/rules.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakePi {
  readonly api: ExtensionAPI;
  readonly handlers: Map<string, Handler[]>;
  readonly execCalls: string[][];
  /** The names of all other API members that the extension used. */
  readonly otherCalls: string[];
  readonly tools: Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>;
  /** The tools that are not active (pi.getActiveTools). All registered tools are active by default. */
  readonly inactive: Set<string>;
  /** The calls of pi.sendMessage: the message and the options. */
  readonly sent: Array<[unknown, unknown]>;
  /** The keys of pi.registerShortcut. */
  readonly shortcuts: string[];
}

/**
 * A fake pi API. `on` and `exec` work. Each other member is a function that
 * records its name, so that a test can prove that the extension did not use
 * it.
 */
type Reply = { code: number; stdout: string };

function fakePi(reply: Reply | ((args: string[]) => Reply)): FakePi {
  const handlers = new Map<string, Handler[]>();
  const execCalls: string[][] = [];
  const otherCalls: string[] = [];
  const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>();
  const inactive = new Set<string>();
  const sent: Array<[unknown, unknown]> = [];
  const shortcuts: string[] = [];
  const known = {
    registerShortcut: (key: string) => void shortcuts.push(key),
    sendMessage: (message: unknown, options: unknown) => void sent.push([message, options]),
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
    getActiveTools: () => [...tools.keys()].filter((name) => !inactive.has(name)),
    registerTool(tool: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    async exec(command: string, args: string[]) {
      execCalls.push([command, ...args]);
      const answer = typeof reply === "function" ? reply(args) : reply;
      return { stdout: answer.stdout, stderr: "", code: answer.code, killed: false };
    },
  };
  const api = new Proxy(known, {
    get(target, name) {
      if (typeof name === "string" && name in target) {
        return target[name as keyof typeof target];
      }
      return (..._args: unknown[]) => {
        otherCalls.push(String(name));
      };
    },
  }) as unknown as ExtensionAPI;
  return { api, handlers, execCalls, otherCalls, tools, inactive, sent, shortcuts };
}

function fakeCtx(hasUI = true, sessionId = "session-1") {
  const widgets: Array<{ key: string; lines: unknown }> = [];
  const notices: Array<{ message: string; type: unknown }> = [];
  const shutdowns: number[] = [];
  return {
    widgets,
    notices,
    shutdowns,
    ctx: {
      hasUI,
      shutdown: () => void shutdowns.push(1),
      sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `/sessions/2026_${sessionId}.jsonl` },
      ui: {
        setWidget(key: string, lines: unknown) {
          widgets.push({ key, lines });
        },
        notify(message: string, type: unknown) {
          notices.push({ message, type });
        },
      },
    },
  };
}

/** The herdr detection calls (not the other herdr calls, such as metadata). */
function detections(pi: FakePi): string[][] {
  return pi.execCalls.filter((call) => call[1] === "pane" && call[2] === "current");
}

/** The widget calls with text lines (the badge), without the tree factory calls. */
function badges(widgets: Array<{ key: string; lines: unknown }>): Array<{ key: string; lines: unknown }> {
  return widgets.filter((widget) => typeof widget.lines !== "function");
}

async function emit(pi: FakePi, event: string, ctx: unknown): Promise<void> {
  for (const handler of pi.handlers.get(event) ?? []) {
    await handler({ type: event, reason: "startup" }, ctx);
  }
}

/**
 * Runs all handlers of a boundary event (for example agent_before_settle) as
 * pi does: each handler sees the entries and the continue flag of the handlers
 * before it. Returns undefined when no handler changed them.
 */
function chain(pi: FakePi, name: string): (event: Record<string, unknown>, ctx: unknown) => Promise<unknown> {
  return async (event, ctx) => {
    let entries = (event.entries as unknown[] | undefined) ?? [];
    let proceed = (event.continue as boolean | undefined) ?? false;
    let changed = false;
    for (const handler of pi.handlers.get(name) ?? []) {
      const result = (await handler({ ...event, entries, continue: proceed }, ctx)) as
        | { entries?: unknown[]; continue?: boolean }
        | undefined;
      if (result?.entries !== undefined) {
        entries = result.entries;
        changed = true;
      }
      if (result?.continue !== undefined) {
        proceed = result.continue;
        changed = true;
      }
    }
    return changed ? { entries, continue: proceed } : undefined;
  };
}

/** Runs all handlers of a notification event (for example input). */
function all(pi: FakePi, name: string): (event: Record<string, unknown>, ctx: unknown) => Promise<void> {
  return async (event, ctx) => {
    for (const handler of pi.handlers.get(name) ?? []) await handler(event, ctx);
  };
}

const PANE_REPLY = JSON.stringify({ result: { pane: { pane_id: "w1:p1" } } });
const ENV_NAMES = ["HERDR_ENV", "HERDR_BIN_PATH"] as const;
const HERDR_BIN = "/opt/herdr/bin/herdr";

/** Sets the environment that herdr sets in each pane. */
function enableHerdr(): void {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_BIN_PATH = HERDR_BIN;
}

/** The configuration that a lead gives to its sub-agents (the defaults). */
const LEAD_CONFIG = JSON.stringify(DEFAULT_CONFIG);

describe("tau extension", () => {
  const saved = new Map<string, string | undefined>();
  let root: string;
  let deps: TauDependencies;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tau-index-"));
    deps = { agentDir: () => join(root, "agent"), now: () => "2026-01-01T00:00:00.000Z", env: {} };
    for (const name of ENV_NAMES) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    for (const name of ENV_NAMES) {
      const value = saved.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it("adds only session_start and session_shutdown handlers in the factory", () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });

    tau(pi.api);

    assert.deepEqual([...pi.handlers.keys()], ["session_start", "session_shutdown"]);
    assert.deepEqual(pi.execCalls, []);
    assert.deepEqual(pi.otherCalls, []);
  });

  it("shows the green badge when herdr is available", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx, widgets } = fakeCtx();
    createTau(pi.api, deps);

    await emit(pi, "session_start", ctx);

    assert.deepEqual(badges(widgets), [{ key: "tau", lines: ["🟢 Herdr"] }]);
    assert.equal(typeof widgets.at(-1)?.lines, "function", "the tree widget replaces the badge");
    assert.deepEqual(detections(pi), [[HERDR_BIN, "pane", "current", "--current"]]);
  });

  it("shows the red badge and runs no command when HERDR_BIN_PATH is not set", async () => {
    process.env.HERDR_ENV = "1";
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx, widgets } = fakeCtx();
    createTau(pi.api, deps);

    await emit(pi, "session_start", ctx);

    assert.deepEqual(widgets, [{ key: "tau", lines: ["🔴 Herdr unavailable"] }]);
    assert.deepEqual(pi.execCalls, []);
    assert.deepEqual(pi.otherCalls, []);
  });

  it("shows the red badge and uses no other pi API when herdr is not available", async () => {
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx, widgets } = fakeCtx();
    createTau(pi.api, deps);

    await emit(pi, "session_start", ctx);
    await emit(pi, "session_shutdown", ctx);

    assert.deepEqual(widgets, [
      { key: "tau", lines: ["🔴 Herdr unavailable"] },
      { key: "tau", lines: undefined },
    ]);
    assert.deepEqual(pi.execCalls, []);
    assert.deepEqual(pi.otherCalls, []);
  });

  it("shows the red badge when the herdr server does not reply", async () => {
    enableHerdr();
    const pi = fakePi({ code: 1, stdout: "" });
    const { ctx, widgets } = fakeCtx();
    createTau(pi.api, deps);

    await emit(pi, "session_start", ctx);

    assert.deepEqual(widgets, [{ key: "tau", lines: ["🔴 Herdr unavailable"] }]);
  });

  it("removes the badge on session_shutdown", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx, widgets } = fakeCtx();
    createTau(pi.api, deps);

    await emit(pi, "session_start", ctx);
    await emit(pi, "session_shutdown", ctx);

    assert.deepEqual(widgets.at(-1), { key: "tau", lines: undefined });
  });

  it("does not set or remove a widget when there is no UI", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx, widgets } = fakeCtx(false);
    createTau(pi.api, deps);

    await emit(pi, "session_start", ctx);
    await emit(pi, "session_shutdown", ctx);

    assert.deepEqual(widgets, []);
  });

  it("runs the herdr check only once for sessions that start later", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const first = fakeCtx();
    const second = fakeCtx();
    createTau(pi.api, deps);

    await Promise.all([emit(pi, "session_start", first.ctx), emit(pi, "session_start", second.ctx)]);
    await emit(pi, "session_start", second.ctx);

    assert.equal(detections(pi).length, 1);
    assert.deepEqual(badges(first.widgets), [{ key: "tau", lines: ["🟢 Herdr"] }]);
    // The badge shows one time; the later start shows the tree again.
    assert.deepEqual(badges(second.widgets), [{ key: "tau", lines: ["🟢 Herdr"] }]);
    assert.equal(typeof second.widgets.at(-1)?.lines, "function");
  });

  it("runs the herdr check again after a reload", async () => {
    // A reload runs the factory again. The new runtime must not use the
    // result of the old runtime.
    enableHerdr();
    const before = fakePi({ code: 0, stdout: PANE_REPLY });
    const beforeCtx = fakeCtx();
    createTau(before.api, deps);
    await emit(before, "session_start", beforeCtx.ctx);

    delete process.env.HERDR_ENV;
    const after = fakePi({ code: 0, stdout: PANE_REPLY });
    const afterCtx = fakeCtx();
    createTau(after.api, deps);
    await emit(after, "session_start", afterCtx.ctx);
    await emit(before, "session_start", beforeCtx.ctx);

    assert.deepEqual(afterCtx.widgets, [{ key: "tau", lines: ["🔴 Herdr unavailable"] }]);
    assert.deepEqual(badges(beforeCtx.widgets), [{ key: "tau", lines: ["🟢 Herdr"] }]);
    assert.equal(typeof beforeCtx.widgets.at(-1)?.lines, "function");
  });

  it("makes the task list with T0 when herdr is available", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx, notices } = fakeCtx(true, "abc-123");
    createTau(pi.api, deps);

    await emit(pi, "session_start", ctx);

    const file = join(root, "tau", "tasklists", "abc-123.db");
    const list = (await new TaskListStore(file).read())!;
    assert.equal(list.sessionId, "abc-123");
    assert.deepEqual(
      list.tasks.map((task: { id: string; title: string; status: string }) => [task.id, task.title, task.status]),
      [["T0", "Prepare task list", "waiting"]],
    );
    assert.deepEqual(notices, []);
  });

  it("does not change an existing task list on a later session start", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx } = fakeCtx(true, "abc-123");
    createTau(pi.api, deps);
    await emit(pi, "session_start", ctx);
    const file = join(root, "tau", "tasklists", "abc-123.db");
    const before = await new TaskListStore(file).read();

    const later = { ...deps, now: () => "2027-01-01T00:00:00.000Z" };
    const again = fakePi({ code: 0, stdout: PANE_REPLY });
    createTau(again.api, later);
    await emit(again, "session_start", ctx);

    assert.deepEqual(await new TaskListStore(file).read(), before);
  });

  it("does not make a task list when herdr is not available", async () => {
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    createTau(pi.api, deps);

    await emit(pi, "session_start", fakeCtx().ctx);

    await assert.rejects(readFile(join(root, "tau", "tasklists", "session-1.db")), { code: "ENOENT" });
  });

  it("shows an error when the task list cannot be opened", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx, notices, widgets } = fakeCtx(true, "../escape");
    createTau(pi.api, deps);

    await emit(pi, "session_start", ctx);

    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.type, "error");
    assert.match(notices[0]?.message ?? "", /not safe as a file name/);
    assert.deepEqual(widgets, [{ key: "tau", lines: ["🟢 Herdr"] }]);
  });

  it("shows an error and does not overwrite a task list file that is not valid", async () => {
    enableHerdr();
    const directory = join(root, "tau", "tasklists");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "abc.db"), "{ broken");
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx, notices } = fakeCtx(true, "abc");
    createTau(pi.api, deps);

    await emit(pi, "session_start", ctx);

    assert.equal(notices.length, 1);
    assert.match(notices[0]?.message ?? "", /not a database/);
    assert.equal(await readFile(join(directory, "abc.db"), "utf8"), "{ broken");
  });

  it("registers the task tools and the work gate when herdr is available", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx } = fakeCtx(true, "gate-1");
    createTau(pi.api, deps);

    await emit(pi, "session_start", ctx);

    assert.ok(pi.tools.has("tau_claim"));
    const gate = pi.handlers.get("tool_call")?.[0];
    assert.ok(gate, "a tool_call handler is registered");
    const blocked = (await gate({ type: "tool_call", toolName: "bash", toolCallId: "1", input: {} }, ctx)) as {
      block: boolean;
      reason: string;
    };
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /no active task/);
    assert.equal(await gate({ type: "tool_call", toolName: "tau_list", toolCallId: "2", input: {} }, ctx), undefined);

    await pi.tools.get("tau_claim")!.execute("3", { id: "T0" });
    assert.equal(await gate({ type: "tool_call", toolName: "bash", toolCallId: "4", input: {} }, ctx), undefined);
  });

  it("registers the tools only one time for sessions that start later", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    createTau(pi.api, deps);

    await emit(pi, "session_start", fakeCtx(true, "once").ctx);
    await emit(pi, "session_start", fakeCtx(true, "once").ctx);

    assert.equal(pi.handlers.get("tool_call")?.length, 1);
    // The message delivery (Esc tracking) and the stop rule.
    assert.equal(pi.handlers.get("turn_end")?.length, 2);
    // The message delivery, the stop rule, and the continuation tracker.
    assert.equal(pi.handlers.get("agent_before_settle")?.length, 3);
    assert.equal(pi.handlers.get("input")?.length, 2);
    assert.equal(pi.handlers.get("before_agent_start")?.length, 1);
  });

  it("adds a continuation while tasks are open, and not after tau_ask_user", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx, notices } = fakeCtx(true, "stop-1");
    createTau(pi.api, deps);
    await emit(pi, "session_start", ctx);
    const settle = chain(pi, "agent_before_settle");
    const userMessage = () => all(pi, "input")({ type: "input", text: "x", source: "interactive" }, ctx);
    const turnEnd = (...names: string[]) =>
      all(pi, "turn_end")(
        { type: "turn_end", toolResults: names.map((toolName) => ({ role: "toolResult", toolName, isError: false })) },
        ctx,
      );
    const ask = async (...others: string[]) => {
      await pi.tools.get("tau_ask_user")!.execute("1", { question: "Which one?" });
      await turnEnd("tau_ask_user", ...others);
    };
    const earlier = { type: "custom", customType: "other-extension", data: 1 };
    const boundary = (outcome = "completed", more: Record<string, unknown> = {}) =>
      settle({ type: "agent_before_settle", outcome, entries: [earlier], continue: false, ...more }, ctx) as Promise<
        { entries: Array<{ type: string; customType: string; content: string; display: boolean }>; continue: boolean } | undefined
      >;

    // Without an active tau_ask_user, the continuation does not tell to use it.
    pi.inactive.add("tau_ask_user");
    assert.doesNotMatch((await boundary())!.entries[1]!.content, /tau_ask_user/);
    pi.inactive.delete("tau_ask_user");
    await userMessage();

    const first = await boundary();
    assert.equal(first?.continue, true);
    assert.match(first!.entries[1]!.content, /tau_ask_user/);
    // The entries of earlier handlers stay, before the continuation message.
    assert.equal(first?.entries.length, 2);
    assert.equal(first?.entries[0], earlier);
    assert.equal(first?.entries[1]?.type, "custom_message");
    assert.equal(first?.entries[1]?.customType, "tau-continue");
    assert.equal(first?.entries[1]?.display, true);
    assert.match(first!.entries[1]!.content, /1 task is open \(T0\)\. .*\n  Ready now: T0\./);

    // No continuation after an abort, or when a different extension continues.
    assert.equal(await boundary("aborted"), undefined);
    assert.equal(await boundary("completed", { continue: true }), undefined);

    await ask();
    assert.ok(notices.some((notice) => /waiting for your answer/.test(notice.message)));
    assert.equal(await boundary(), undefined);

    // The answer: the rule applies again.
    await userMessage();
    assert.equal((await boundary())?.continue, true);

    // A different tool in the same batch: the next stop is not for the question.
    // (Each case starts with a user message: the list does not change, and
    // the 3-idle limit must not apply.)
    await userMessage();
    await ask("bash");
    assert.equal((await boundary())?.continue, true);

    // A later turn after the question: the same.
    await userMessage();
    await ask();
    await turnEnd();
    assert.equal((await boundary())?.continue, true);

    // A different extension continues after the question: the same.
    await userMessage();
    await ask();
    assert.equal(await boundary("completed", { continue: true }), undefined);
    assert.equal((await boundary())?.continue, true);

    // A user message while the agent works (steer or follow-up) clears the question.
    await ask();
    await all(pi, "input")({ type: "input", text: "x", source: "rpc", streamingBehavior: "steer" }, ctx);
    assert.equal((await boundary())?.continue, true);

    // After T0 closes, the lead can stop.
    await pi.tools.get("tau_claim")!.execute("2", { id: "T0" });
    await pi.tools.get("tau_complete")!.execute("3", { result: "done" });
    assert.equal(await boundary(), undefined);
    await emit(pi, "session_shutdown", ctx);
  });

  it("tau_abort closes the pane of the stopped sub-agent through the supervisor", async () => {
    enableHerdr();
    const leadDeps = { ...deps };
    // The lead list: T0 was delegated to tau-t0, which runs in pane w1:p2.
    const file = join(root, "tau", "tasklists", "abort-1.db");
    const store = new TaskListStore(file);
    await store.ensure(() => seedTaskList("abort-1", "2026-01-01T00:00:00.000Z"));
    await store.mutate((list) => {
      delegateTask(list, { actor: { name: "lead" }, now: "2026-01-01T00:00:00.000Z" }, { id: "T0", agent: "tau-t0" });
      setAgentPane(list, "tau-t0", "w1:p2");
      setAgentSession(list, "tau-t0", "/s/2026_sub.jsonl");
    });
    store.close();
    let closed = false;
    const pi = fakePi((args) => {
      if (args[0] === "agent" && args[1] === "list") {
        const agents = closed ? [] : [{ name: "tau-t0", pane_id: "w1:p2", agent_status: "working", agent_session: { value: "/s/2026_sub.jsonl" } }];
        return { code: 0, stdout: JSON.stringify({ result: { agents } }) };
      }
      if (args[0] === "pane" && args[1] === "list") {
        return { code: 0, stdout: JSON.stringify({ result: { panes: closed ? [{ pane_id: "w1:p1" }] : [{ pane_id: "w1:p1" }, { pane_id: "w1:p2" }] } }) };
      }
      if (args[0] === "pane" && args[1] === "close") closed = true;
      return { code: 0, stdout: PANE_REPLY };
    });
    const { ctx } = fakeCtx(true, "abort-1");
    createTau(pi.api, leadDeps);
    await emit(pi, "session_start", ctx);

    const result = (await pi.tools.get("tau_abort")!.execute("1", { id: "T0", reason: "stop it" })) as {
      content: Array<{ text: string }>;
    };

    assert.match(result.content[0]!.text, /^Aborted T0: tau ended @tau-t0/);
    assert.ok(pi.execCalls.some((call) => call[1] === "pane" && call[2] === "close" && call[3] === "w1:p2"));
    const reread = new TaskListStore(file);
    const list = (await reread.read())!;
    reread.close();
    assert.equal(list.tasks[0]?.result, "aborted by @lead: stop it");
    await emit(pi, "session_shutdown", ctx);
  });

  it("gives unread messages at the end of a run, before the stop rule", async () => {
    enableHerdr();
    const file = join(root, "tau", "tasklists", "msg-1.db");
    const store = new TaskListStore(file);
    await store.ensure(() => seedTaskList("msg-1", "2026-01-01T00:00:00.000Z"));
    await store.mutate((list) => {
      delegateTask(list, { actor: { name: "lead" }, now: "2026-01-01T00:00:00.000Z" }, { id: "T0", agent: "tau-t0" });
    });
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx } = fakeCtx(true, "msg-1");
    const idleCtx = { ...ctx, isIdle: () => false };
    createTau(pi.api, deps);
    await emit(pi, "session_start", idleCtx);
    await store.sendMessage(
      { sender: "tau-t0", recipient: "lead", priority: "info", text: "Found it.", sentAt: "2026-01-01T00:00:00.000Z" },
      () => ({ senderTask: "T0" }),
    );
    store.close();
    const settle = chain(pi, "agent_before_settle");

    // After the user stops a run, the messages wait.
    assert.equal(await settle({ type: "agent_before_settle", outcome: "aborted", entries: [], continue: false }, idleCtx), undefined);

    const result = (await settle({ type: "agent_before_settle", outcome: "completed", entries: [], continue: false }, idleCtx)) as {
      entries: Array<{ customType: string; content: string }>;
      continue: boolean;
    };
    assert.equal(result.continue, true);
    // Only the message: the stop rule does nothing, because the run continues.
    assert.deepEqual(result.entries.map((entry) => entry.customType), ["tau-message"]);
    assert.match(result.entries[0]!.content, /✉ info from @tau-t0 \(T0\)[^\n]*\n\| Found it\./);
    await emit(pi, "session_shutdown", idleCtx);
  });

  describe("message delivery", () => {
    /** A lead with the sub-agent tau-t0 (T0), and a way to send it messages from tau-t0. */
    async function setup(name: string) {
      enableHerdr();
      const file = join(root, "tau", "tasklists", `${name}.db`);
      const store = new TaskListStore(file);
      await store.ensure(() => seedTaskList(name, "2026-01-01T00:00:00.000Z"));
      await store.mutate((list) => {
        delegateTask(list, { actor: { name: "lead" }, now: "2026-01-01T00:00:00.000Z" }, { id: "T0", agent: "tau-t0" });
      });
      const pi = fakePi({ code: 0, stdout: PANE_REPLY });
      let idle = false;
      const { ctx } = fakeCtx(true, name);
      const context = { ...ctx, isIdle: () => idle };
      const handle = createTau(pi.api, { ...deps, inboxMs: 60_000 });
      await emit(pi, "session_start", context);
      const send = (priority: "steer" | "info", text: string) =>
        store.sendMessage(
          { sender: "tau-t0", recipient: "lead", priority, text, sentAt: "2026-01-01T00:00:00.000Z" },
          () => ({ senderTask: "T0" }),
        );
      const toolResult = (toolName: string) =>
        pi.handlers.get("tool_result")![0]!({ type: "tool_result", toolName, content: [{ type: "text", text: "ok" }] }, context) as Promise<
          { content: Array<{ text: string }> } | undefined
        >;
      return {
        pi,
        store,
        handle,
        context,
        send,
        toolResult,
        setIdle: (value: boolean) => (idle = value),
        done: async () => {
          store.close();
          await emit(pi, "session_shutdown", context);
        },
      };
    }

    it("gives steer messages with any tool result, and all messages with a tau tool result", async () => {
      const t = await setup("deliver-1");
      await t.send("info", "later");
      await t.send("steer", "now");
      const bash = await t.toolResult("bash");
      assert.equal(bash?.content[0]?.text, "ok");
      assert.match(bash!.content[1]!.text, /^\n\nNew messages:\n\n✉ steer from @tau-t0 \(T0\)[^\n]*\n\| now$/);
      const list = await t.toolResult("tau_list");
      assert.match(list!.content[1]!.text, /✉ info from @tau-t0 \(T0\)[^\n]*\n\| later$/);
      assert.equal(await t.toolResult("tau_list"), undefined);
      await t.done();
    });

    it("starts a turn for an idle agent with triggerTurn", async () => {
      const t = await setup("deliver-2");
      t.setIdle(true);
      await t.send("info", "hello");
      await t.handle.inbox!.poll();
      assert.equal(t.pi.sent.length, 1);
      const [message, options] = t.pi.sent[0] as [{ customType: string; content: string; display: boolean }, unknown];
      assert.equal(message.customType, "tau-message");
      assert.equal(message.display, true);
      assert.match(message.content, /\| hello$/);
      assert.deepEqual(options, { triggerTurn: true });
      await t.done();
    });

    it("does not start turns after a run that did not reach the settle boundary (Esc), until user input", async () => {
      const t = await setup("deliver-3");
      // pi skips agent_before_settle after an abort, then emits agent_settled.
      await all(t.pi, "agent_settled")({ type: "agent_settled" }, t.context);
      t.setIdle(true);
      await t.send("info", "wait");
      await t.handle.inbox!.poll();
      assert.deepEqual(t.pi.sent, []);
      await all(t.pi, "input")({ type: "input", text: "go on", source: "interactive" }, t.context);
      await t.handle.inbox!.poll();
      assert.equal(t.pi.sent.length, 1);
      await t.done();
    });

    it("does not take messages for a successful tau_ask_user result", async () => {
      const t = await setup("deliver-5");
      await t.send("info", "after the answer");
      const result = await t.pi.handlers.get("tool_result")![0]!(
        { type: "tool_result", toolName: "tau_ask_user", isError: false, content: [{ type: "text", text: "asked" }] },
        t.context,
      );
      assert.equal(result, undefined);
      assert.equal((await t.store.unreadCounts()).get("lead"), 1);
      await t.done();
    });

    it("pauses after an Esc that comes after a completed settle boundary", async () => {
      const t = await setup("deliver-6");
      const settle = chain(t.pi, "agent_before_settle");
      await settle({ type: "agent_before_settle", outcome: "completed", entries: [], continue: false }, t.context);
      // The continuation turn is aborted: pi skips the next boundary.
      await all(t.pi, "turn_end")({ type: "turn_end", toolResults: [] }, t.context);
      await all(t.pi, "agent_settled")({ type: "agent_settled" }, t.context);
      assert.equal(t.handle.inbox!.paused, true);
      await t.done();
    });

    it("pauses after an Esc during a settle boundary that asked to continue", async () => {
      const t = await setup("deliver-8");
      const settle = chain(t.pi, "agent_before_settle");
      // A message: the boundary asks pi to continue.
      await t.send("info", "continue with this");
      const result = (await settle({ type: "agent_before_settle", outcome: "completed", entries: [], continue: false }, t.context)) as {
        continue: boolean;
      };
      assert.equal(result.continue, true);
      // Esc during the boundary: pi does not start the continuation (no turn_start).
      await all(t.pi, "agent_settled")({ type: "agent_settled" }, t.context);
      assert.equal(t.handle.inbox!.paused, true);
      await t.done();
    });

    it("does not pause when the continuation of the boundary started", async () => {
      const t = await setup("deliver-9");
      const settle = chain(t.pi, "agent_before_settle");
      await t.send("info", "continue with this");
      await settle({ type: "agent_before_settle", outcome: "completed", entries: [], continue: false }, t.context);
      await all(t.pi, "turn_start")({ type: "turn_start" }, t.context);
      await all(t.pi, "turn_end")({ type: "turn_end", toolResults: [] }, t.context);
      // The work is done: the next boundary does not continue.
      await t.store.mutate((list) => {
        completeTask(list, { actor: { name: "tau-t0", scope: "T0" }, now: "2026-01-01T00:00:00.000Z" }, "T0", "done");
      });
      const last = await settle({ type: "agent_before_settle", outcome: "completed", entries: [], continue: false }, t.context);
      assert.equal(last, undefined);
      await all(t.pi, "agent_settled")({ type: "agent_settled" }, t.context);
      assert.equal(t.handle.inbox!.paused, false);
      await t.done();
    });

    it("stops the message continuations of one run at the limit", async () => {
      const t = await setup("deliver-7");
      const settle = chain(t.pi, "agent_before_settle");
      const results: unknown[] = [];
      for (let index = 0; index < 7; index += 1) {
        await t.send("info", `m${index}`);
        results.push(await settle({ type: "agent_before_settle", outcome: "completed", entries: [], continue: false }, t.context));
      }
      const withMessage = results.filter(
        (result) => (result as { entries?: Array<{ customType: string }> } | undefined)?.entries?.some((entry) => entry.customType === "tau-message"),
      );
      assert.equal(withMessage.length, 5);
      assert.equal((await t.store.unreadCounts()).get("lead"), 2);
      // User input starts the count again.
      await all(t.pi, "input")({ type: "input", text: "x", source: "interactive" }, t.context);
      const next = (await settle({ type: "agent_before_settle", outcome: "completed", entries: [], continue: false }, t.context)) as {
        entries: Array<{ customType: string }>;
      };
      assert.ok(next.entries.some((entry) => entry.customType === "tau-message"));
      await t.done();
    });

    it("keeps messages while the agent waits for an answer of the user", async () => {
      const t = await setup("deliver-4");
      await t.send("info", "not now");
      await all(t.pi, "turn_end")({ type: "turn_end", toolResults: [{ role: "toolResult", toolName: "tau_ask_user", isError: false }] }, t.context);
      const settle = chain(t.pi, "agent_before_settle");
      assert.equal(await settle({ type: "agent_before_settle", outcome: "completed", entries: [], continue: false }, t.context), undefined);
      await all(t.pi, "agent_settled")({ type: "agent_settled" }, t.context);
      t.setIdle(true);
      await t.handle.inbox!.poll();
      assert.deepEqual(t.pi.sent, []);
      assert.equal((await t.store.unreadCounts()).get("lead"), 1);
      await t.done();
    });
  });

  it("uses the configuration file, and warns about the fields that are not valid", async () => {
    enableHerdr();
    await mkdir(join(root, "tau"), { recursive: true });
    await writeFile(
      join(root, "tau", "config.json"),
      `{
        // Comments are permitted.
        "toggleCompletedKey": "ctrl+shift+y",
        "maxIdleContinuations": 1,
        "maxTreeLines": 2,
        "taskTypes": { "plan": { "description": "Plan." }, "spike": { "description": "Try an idea.", "readOnly": true } },
        "colour": "blue"
      }`,
    );
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx, notices } = fakeCtx(true, "config-1");
    const handle = createTau(pi.api, deps);
    await emit(pi, "session_start", ctx);

    assert.deepEqual(pi.shortcuts, ["ctrl+shift+y"]);
    assert.ok(notices.some((notice) => notice.type === "warning" && /"colour" is not a configuration field/.test(notice.message)));
    // The task types of the configuration.
    await assert.rejects(pi.tools.get("tau_create")!.execute("1", { title: "x", type: "code" }), /is not a task type/);
    await pi.tools.get("tau_create")!.execute("2", { title: "Try it", type: "spike" });
    await pi.tools.get("tau_claim")!.execute("3", { id: "T1" });
    // spike is read-only: the work gate blocks edit.
    const gate = pi.handlers.get("tool_call")![0]!;
    const blocked = (await gate({ type: "tool_call", toolName: "edit", toolCallId: "4", input: {} }, ctx)) as { reason: string };
    assert.match(blocked.reason, /"spike", which is read-only/);
    // No configured type permits changes except plan: the message tells it.
    assert.match(blocked.reason, /No configured task type other than "plan" permits file changes/);
    // maxIdleContinuations: 1 continuation, then the rule stops.
    const settle = chain(pi, "agent_before_settle");
    const boundary = () => settle({ type: "agent_before_settle", outcome: "completed", entries: [], continue: false }, ctx);
    assert.notEqual(await boundary(), undefined);
    assert.equal(await boundary(), undefined);
    // maxTreeLines: 2 lines for 4 open tasks (the last line tells the rest).
    await pi.tools.get("tau_create")!.execute("5", { title: "More", type: "plan" });
    await pi.tools.get("tau_create")!.execute("6", { title: "Even more", type: "plan" });
    // A refresh can run already (a tool started it): wait for it, then refresh.
    await handle.widget!.refresh();
    await handle.widget!.refresh();
    const lines = handle.widget!.lines(100);
    // The header, 2 task lines, and the line that tells the rest.
    assert.equal(lines.length, 1 + 2 + 1, lines.join("\n"));
    assert.match(lines[0]!, /3 waiting/);
    assert.match(lines.at(-1)!, /… 2 more/);
    await emit(pi, "session_shutdown", ctx);
  });

  it("uses idPills and maxParallelSubAgents, and gives the configuration to sub-agents", async () => {
    enableHerdr();
    await mkdir(join(root, "tau"), { recursive: true });
    await writeFile(join(root, "tau", "config.json"), '{ "idPills": false, "maxParallelSubAgents": 1 }');
    // The list of the lead: T0 was delegated to tau-t0 already (1 live sub-agent).
    const file = join(root, "tau", "tasklists", "config-2.db");
    const store = new TaskListStore(file);
    await store.ensure(() => seedTaskList("config-2", "2026-01-01T00:00:00.000Z"));
    await store.mutate((list) => {
      createTask(list, { actor: { name: "lead" }, now: "2026-01-01T00:00:00.000Z" }, { title: "Next", type: "code" });
      delegateTask(list, { actor: { name: "lead" }, now: "2026-01-01T00:00:00.000Z" }, { id: "T0", agent: "tau-t0" });
      setAgentPane(list, "tau-t0", "w1:p2");
      setAgentSession(list, "tau-t0", "/s/2026_t0.jsonl");
    });
    store.close();
    // herdr shows tau-t0 alive, so that the liveness check keeps it.
    const live = [{ name: "tau-t0", pane_id: "w1:p2", agent_status: "working", agent_session: { value: "/s/2026_t0.jsonl" } }];
    const pi = fakePi((args) =>
      args[0] === "agent" && args[1] === "list"
        ? { code: 0, stdout: JSON.stringify({ result: { agents: live } }) }
        : { code: 0, stdout: PANE_REPLY },
    );
    const { ctx } = fakeCtx(true, "config-2");
    const handle = createTau(pi.api, deps);
    await emit(pi, "session_start", ctx);
    // idPills false: the tree shows status marks, not pills.
    await handle.widget!.refresh();
    // eslint-disable-next-line no-control-regex
    assert.match(handle.widget!.lines(100).join("\n").replace(/\u001b\[[0-9;]*m/gu, ""), /○ T1  Next/);
    // maxParallelSubAgents 1: a second sub-agent is refused.
    await assert.rejects(pi.tools.get("tau_delegate")!.execute("1", { id: "T1", model: "p/m", thinking: "low" }), /The maximum is 1/);
    await emit(pi, "session_shutdown", ctx);
  });

  it("writes the configuration warnings to stderr when there is no UI", async () => {
    enableHerdr();
    await mkdir(join(root, "tau"), { recursive: true });
    await writeFile(join(root, "tau", "config.json"), '{ "colour": "blue" }');
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx } = fakeCtx(false, "config-3");
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
    try {
      createTau(pi.api, deps);
      await emit(pi, "session_start", ctx);
    } finally {
      console.error = original;
    }
    assert.ok(errors.some((line) => /"colour" is not a configuration field/.test(line)), errors.join("\n"));
    await emit(pi, "session_shutdown", ctx);
  });

  it("adds the tau section to the system prompt", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx } = fakeCtx(true, "prompt-1");
    createTau(pi.api, deps);
    await emit(pi, "session_start", ctx);
    const start = async (selectedTools: string[]) => {
      const event = { type: "before_agent_start", prompt: "x", systemPromptOptions: { selectedTools, sections: {} as Record<string, string> } };
      assert.equal(await pi.handlers.get("before_agent_start")![0]!(event, ctx), undefined);
      return event.systemPromptOptions.sections.tau ?? "";
    };
    const withAsk = await start(["read", "tau_list", "tau_ask_user"]);
    assert.match(withAsk, /^You are the lead agent\. You cannot stop/);
    assert.match(withAsk, /Do not end your turn to ask a question\./);
    assert.match(withAsk, /call tau_ask_user alone/);
    assert.doesNotMatch(await start(["read", "tau_list"]), /tau_ask_user/);
    await emit(pi, "session_shutdown", ctx);
  });

  it("writes the give-up warning to stderr when there is no UI", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx } = fakeCtx(false, "stop-3");
    createTau(pi.api, deps);
    await emit(pi, "session_start", ctx);
    const settle = chain(pi, "agent_before_settle");
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
    try {
      for (let index = 0; index < 4; index += 1) {
        await settle({ type: "agent_before_settle", outcome: "completed", entries: [], continue: false }, ctx);
      }
    } finally {
      console.error = original;
    }
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /rule is off until your next prompt/);
    await emit(pi, "session_shutdown", ctx);
  });

  it("stops the rule and tells the user after 3 continuations with no change", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx, notices } = fakeCtx(true, "stop-2");
    createTau(pi.api, deps);
    await emit(pi, "session_start", ctx);
    const settle = chain(pi, "agent_before_settle");
    const boundary = () =>
      settle({ type: "agent_before_settle", outcome: "completed", entries: [], continue: false }, ctx) as Promise<
        { continue: boolean } | undefined
      >;
    const input = all(pi, "input");
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await boundary())?.continue, true);
      // A message that an extension sends is not input from the user: it
      // does not start the rule again.
      await input({ type: "input", text: "again", source: "extension" }, ctx);
    }
    assert.equal(await boundary(), undefined);
    assert.ok(notices.some((notice) => notice.type === "warning" && /rule is off until your next prompt/.test(notice.message)));
    await emit(pi, "session_shutdown", ctx);
  });

  it("registers no tools and no gate when the task list cannot be opened", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    createTau(pi.api, deps);

    await emit(pi, "session_start", fakeCtx(true, "../bad").ctx);

    assert.equal(pi.tools.size, 0);
    assert.equal(pi.handlers.get("tool_call"), undefined);
  });

  it("blocks tools when the task list cannot be read", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx } = fakeCtx(true, "broken-later");
    createTau(pi.api, deps);
    await emit(pi, "session_start", ctx);
    await rm(join(root, "tau", "tasklists", "broken-later.db"));
    await writeFile(join(root, "tau", "tasklists", "broken-later.db"), "not a database");

    const gate = pi.handlers.get("tool_call")![0]!;
    const result = (await gate({ type: "tool_call", toolName: "bash", toolCallId: "1", input: {} }, ctx)) as {
      block: boolean;
      reason: string;
    };
    assert.equal(result.block, true);
    assert.match(result.reason, /cannot read the task list/);
  });

  it("registers no tools and no gate when a different extension uses a tau tool name", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    pi.tools.set("tau_get", { execute: async () => undefined });
    const { ctx, notices } = fakeCtx(true, "conflict");
    createTau(pi.api, deps);

    await emit(pi, "session_start", ctx);

    assert.equal(pi.handlers.get("tool_call"), undefined);
    assert.equal(pi.tools.size, 1);
    assert.match(notices[0]?.message ?? "", /tau_get/);
  });

  it("keeps the tree when a later session_start comes", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx, widgets } = fakeCtx(true, "again");
    createTau(pi.api, deps);

    await emit(pi, "session_start", ctx);
    await emit(pi, "session_start", ctx);

    assert.equal(typeof widgets.at(-1)?.lines, "function", "the last widget is the tree");
    assert.equal(badges(widgets).length, 1, "the badge shows only before the first tree");
  });

  it("draws the tree again after a tool changes the task list, and stops at shutdown", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx, widgets } = fakeCtx(true, "draw");
    const handle = createTau(pi.api, deps);
    await emit(pi, "session_start", ctx);

    let renders = 0;
    const factory = widgets.at(-1)?.lines as (tui: unknown) => { render(width: number): string[] };
    const component = factory({ requestRender: () => (renders += 1) });
    assert.equal(component.render(80).length, 2);

    await pi.tools.get("tau_create")!.execute("1", { title: "New task", type: "code" });
    await handle.widget!.refresh();
    assert.ok(renders >= 1);
    assert.match(component.render(80).join("\n"), /New task/);

    assert.equal(handle.widget?.running, true);
    await emit(pi, "session_shutdown", ctx);
    assert.equal(handle.widget?.running, false);
    assert.deepEqual(widgets.at(-1), { key: "tau", lines: undefined });
  });

  it("does not start the tree when shutdown comes while session_start waits", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx, widgets } = fakeCtx(true, "early-shutdown");
    const handle = createTau(pi.api, deps);

    const starting = emit(pi, "session_start", ctx);
    await emit(pi, "session_shutdown", ctx);
    await starting;

    assert.equal(handle.widget?.running ?? false, false);
    assert.equal(pi.handlers.get("tool_call"), undefined);
    assert.ok(widgets.every((widget) => typeof widget.lines !== "function"));
  });

  it("starts as a sub-agent with the identity from the environment", async () => {
    enableHerdr();
    const file = join(root, "tau", "tasklists", "lead-1.db");
    const lead = new TaskListStore(file);
    await lead.ensure(() => seedTaskList("lead-1", "2026-01-01T00:00:00.000Z"));
    await lead.mutate((list) => {
      delegateTask(list, { actor: { name: "lead" }, now: "2026-01-01T00:00:00.000Z" }, { id: "T0", agent: "tau-t0" });
      setAgentPane(list, "tau-t0", "w1:p1");
      createTask(list, { actor: { name: "lead" }, now: "2026-01-01T00:00:00.000Z" }, { title: "Lead work", type: "code" });
    });
    lead.close();
    const env = { TAU_TASKLIST: file, TAU_TASK_ID: "T0", TAU_AGENT_NAME: "tau-t0", TAU_PARENT_AGENT: "lead", TAU_CONFIG: LEAD_CONFIG };
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx, notices } = fakeCtx(true, "sub-session");
    const handle = createTau(pi.api, { ...deps, env });

    await emit(pi, "session_start", ctx);

    assert.deepEqual(notices, []);
    assert.deepEqual(handle.identity?.actor, { name: "tau-t0", scope: "T0" });
    assert.ok(pi.tools.has("tau_complete"));
    const reread = new TaskListStore(file);
    assert.equal((await reread.read())?.agents[0]?.session, "/sessions/2026_sub-session.jsonl");
    reread.close();
    // The sub-agent does not make a task list for its own session.
    await assert.rejects(readFile(join(root, "tau", "tasklists", "sub-session.db")), { code: "ENOENT" });
    // tau reports the metadata in the background.
    for (let i = 0; i < 50 && !pi.execCalls.some((call) => call[2] === "report-metadata"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const metadata = pi.execCalls.find((call) => call[2] === "report-metadata");
    assert.deepEqual(metadata?.slice(3), [
      "w1:p1",
      "--source",
      "tau:tau-t0",
      "--title",
      "tau-t0 · T0 Prepare task list",
      "--display-agent",
      "tau sub-agent",
      "--token",
      "tau_role=subagent",
      "--token",
      "tau_task=T0",
      "--token",
      "tau_parent=lead",
    ]);

    // The stop rule looks only at the task of the sub-agent.
    const settle = chain(pi, "agent_before_settle");
    const boundary = () =>
      settle({ type: "agent_before_settle", outcome: "completed", entries: [], continue: false }, ctx) as Promise<
        { entries: Array<{ content: string }>; continue: boolean } | undefined
      >;
    const open = await boundary();
    assert.equal(open?.continue, true);
    assert.match(open!.entries[0]!.content, /^⟳ tau: your task T0 is in progress\./);
    await pi.tools.get("tau_complete")!.execute("1", { result: "done" });
    // T1 of the lead is still open, but it is not the work of the sub-agent.
    assert.equal(await boundary(), undefined);
    await emit(pi, "session_shutdown", ctx);
  });

  it("registers nothing in a sub-agent without a valid configuration from its lead", async () => {
    enableHerdr();
    const file = join(root, "tau", "tasklists", "lead-3.db");
    const lead = new TaskListStore(file);
    await lead.ensure(() => seedTaskList("lead-3", "2026-01-01T00:00:00.000Z"));
    await lead.mutate((list) => {
      delegateTask(list, { actor: { name: "lead" }, now: "2026-01-01T00:00:00.000Z" }, { id: "T0", agent: "tau-t0" });
      setAgentPane(list, "tau-t0", "w1:p1");
    });
    lead.close();
    for (const config of [undefined, "", "{ bad", JSON.stringify({ taskTypes: { code: { description: "x" } } })]) {
      const env = {
        TAU_TASKLIST: file,
        TAU_TASK_ID: "T0",
        TAU_AGENT_NAME: "tau-t0",
        TAU_PARENT_AGENT: "lead",
        ...(config === undefined ? {} : { TAU_CONFIG: config }),
      };
      const pi = fakePi({ code: 0, stdout: PANE_REPLY });
      const { ctx, notices, shutdowns } = fakeCtx(true, "sub-bad");
      createTau(pi.api, { ...deps, env });
      await emit(pi, "session_start", ctx);
      assert.equal(pi.tools.size, 0, String(config));
      assert.match(notices[0]?.message ?? "", /did not get a valid configuration from its lead/, String(config));
      // Fail closed: one handler blocks all tools.
      const gates = pi.handlers.get("tool_call") ?? [];
      assert.equal(gates.length, 1, String(config));
      const blocked = (await gates[0]!({ type: "tool_call", toolName: "edit", toolCallId: "1", input: {} }, ctx)) as {
        block: boolean;
        reason: string;
      };
      assert.equal(blocked.block, true);
      assert.match(blocked.reason, /did not get a valid configuration from its lead.* Stop now\./);
      await emit(pi, "session_start", ctx);
      assert.equal(pi.handlers.get("tool_call")?.length, 1, "one handler, also after a later session_start");
      assert.ok(shutdowns.length >= 1, "pi stops");
    }
  });

  it("a lead reads its file, not a TAU_CONFIG of its environment", async () => {
    enableHerdr();
    await mkdir(join(root, "tau"), { recursive: true });
    await writeFile(join(root, "tau", "config.json"), '{ "toggleCompletedKey": "ctrl+shift+y" }');
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx } = fakeCtx(true, "lead-env");
    createTau(pi.api, { ...deps, env: { TAU_CONFIG: JSON.stringify({ ...DEFAULT_CONFIG, toggleCompletedKey: "ctrl+shift+u" }) } });
    await emit(pi, "session_start", ctx);
    assert.deepEqual(pi.shortcuts, ["ctrl+shift+y"]);
    await emit(pi, "session_shutdown", ctx);
  });

  it("gives its configuration to a new sub-agent (TAU_CONFIG in the new pane)", async () => {
    enableHerdr();
    await mkdir(join(root, "tau"), { recursive: true });
    await writeFile(join(root, "tau", "config.json"), '{ "maxTreeLines": 3 }');
    const pi = fakePi((args) =>
      args[0] === "agent" && args[1] === "list"
        ? { code: 0, stdout: JSON.stringify({ result: { agents: [] } }) }
        : args[0] === "pane" && args[1] === "split"
          ? { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p9" } } }) }
          : { code: 0, stdout: PANE_REPLY },
    );
    const { ctx } = fakeCtx(true, "handoff-1");
    createTau(pi.api, deps);
    await emit(pi, "session_start", ctx);
    await pi.tools.get("tau_delegate")!.execute("1", { id: "T0", model: "p/m", thinking: "low" });
    const split = pi.execCalls.find((call) => call[1] === "pane" && call[2] === "split")!;
    const value = split.find((arg) => typeof arg === "string" && arg.startsWith("TAU_CONFIG="))!.slice("TAU_CONFIG=".length);
    assert.equal(JSON.parse(value).maxTreeLines, 3);
    await emit(pi, "session_shutdown", ctx);
  });

  it("registers nothing when the sub-agent identity does not agree with the task list", async () => {
    enableHerdr();
    const file = join(root, "tau", "tasklists", "lead-2.db");
    const lead = new TaskListStore(file);
    await lead.ensure(() => seedTaskList("lead-2", "2026-01-01T00:00:00.000Z"));
    lead.close();
    const env = { TAU_TASKLIST: file, TAU_TASK_ID: "T0", TAU_AGENT_NAME: "tau-t0", TAU_PARENT_AGENT: "lead", TAU_CONFIG: LEAD_CONFIG };
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx, notices, shutdowns } = fakeCtx(true, "sub-session");
    createTau(pi.api, { ...deps, env });

    await emit(pi, "session_start", ctx);

    assert.equal(pi.tools.size, 0);
    assert.match(notices[0]?.message ?? "", /has no sub-agent @tau-t0/);
    await assertFailedClosed(pi, ctx, shutdowns, /cannot open the task list of its lead/);
  });

  it("fails closed in a sub-agent without herdr, or with a tool name conflict", async () => {
    const env = { TAU_TASKLIST: join(root, "x.db"), TAU_TASK_ID: "T0", TAU_AGENT_NAME: "tau-t0", TAU_PARENT_AGENT: "lead", TAU_CONFIG: LEAD_CONFIG };
    // No herdr: HERDR_ENV is not set.
    {
      const pi = fakePi({ code: 0, stdout: PANE_REPLY });
      const { ctx, shutdowns } = fakeCtx(true, "sub-no-herdr");
      createTau(pi.api, { ...deps, env });
      await emit(pi, "session_start", ctx);
      await assertFailedClosed(pi, ctx, shutdowns, /cannot use herdr/);
    }
    // A different extension has a tau tool name.
    enableHerdr();
    {
      const pi = fakePi({ code: 0, stdout: PANE_REPLY });
      pi.tools.set("tau_list", { execute: async () => undefined });
      const { ctx, shutdowns } = fakeCtx(true, "sub-conflict");
      createTau(pi.api, { ...deps, env });
      await emit(pi, "session_start", ctx);
      await assertFailedClosed(pi, ctx, shutdowns, /A different extension has tools with the names of tau tools/);
    }
  });
});

/** Checks that tau blocks all tools with the reason, and stopped pi, one time. */
async function assertFailedClosed(pi: FakePi, ctx: unknown, shutdowns: number[], reason: RegExp): Promise<void> {
  const gates = pi.handlers.get("tool_call") ?? [];
  assert.equal(gates.length, 1);
  const blocked = (await gates[0]!({ type: "tool_call", toolName: "bash", toolCallId: "1", input: {} }, ctx)) as {
    block: boolean;
    reason: string;
  };
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, reason);
  assert.match(blocked.reason, /Stop now\.$/);
  assert.ok(shutdowns.length >= 1, "pi stops");
}
