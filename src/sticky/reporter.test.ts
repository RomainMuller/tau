import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "./link.ts";
import { registerStickyReporter, type StickyReporter } from "./reporter.ts";

type Handler = (event: Record<string, unknown>) => unknown;

/** Each call of `flush`, with the state of the last record at that time. */
type Flushes = string[];

function setup(options: { parent?: string; flush?: () => Promise<void> } = {}): {
  emit: (event: string, data?: Record<string, unknown>) => Promise<unknown>;
  records: AgentRecord[];
  states: () => string[];
  reporter: StickyReporter;
  closed: () => boolean;
  flushes: Flushes;
} {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
  } as unknown as ExtensionAPI;
  const records: AgentRecord[] = [];
  const flushes: Flushes = [];
  let closed = false;
  const reporter = registerStickyReporter(pi, {
    link: {
      publish: (record) => void records.push(record),
      flush: async () => {
        flushes.push(records.at(-1)!.state);
        await options.flush?.();
      },
      close: async () => {
        closed = true;
      },
    },
    sessionId: "tau-x-lead",
    ...(options.parent === undefined ? {} : { parentSessionId: options.parent }),
    name: "lead",
    workspace: "/work/tau",
    model: "Opus",
    modelLabel: (model) => model.name ?? model.id,
    isAskTool: (name) => name === "ask_user_question" || name === "tau_ask_user",
  });
  return {
    emit: (event, data = {}) => Promise.all((handlers.get(event) ?? []).map((handler) => handler({ type: event, ...data }))),
    records,
    states: () => records.map((record) => record.state),
    reporter,
    closed: () => closed,
    flushes,
  };
}

const tool = (name: string, id: string) => ({ toolName: name, toolCallId: id });

describe("registerStickyReporter", () => {
  it("sends idle and the metadata at the start", () => {
    const { records } = setup({ parent: "tau-x-parent" });
    assert.deepEqual(records, [
      {
        sessionId: "tau-x-lead",
        state: "idle",
        metadata: [
          ["name", "lead"],
          ["workspace", "/work/tau"],
          ["parent", "tau-x-parent"],
          ["model", "Opus"],
        ],
      },
    ]);
  });

  it("removes the parent key of a lead (empty value)", () => {
    const { records } = setup();
    assert.deepEqual(records[0]!.metadata[2], ["parent", ""]);
  });

  it("follows a run: working, then idle", () => {
    const { emit, states } = setup();
    emit("agent_start");
    emit("turn_start");
    emit("turn_end", { toolResults: [] });
    emit("agent_before_settle", { outcome: "completed" });
    emit("agent_settled");
    assert.deepEqual(states(), ["idle", "working", "idle"]);
  });

  it("sets question before the ask tool runs, and restores the state after it", () => {
    const { emit, states, reporter, flushes } = setup();
    emit("agent_start");
    emit("tool_execution_start", tool("ask_user_question", "c1"));
    assert.equal(reporter.state, "question");
    // The handler waits for the stickies (pi waits for the handler before the tool runs).
    assert.deepEqual(flushes, ["question"]);
    emit("tool_execution_end", tool("ask_user_question", "c1"));
    assert.deepEqual(states(), ["idle", "working", "question", "working"]);
  });

  it("waits for the stickies before the ask tool runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { emit, flushes } = setup({ flush: () => gate });
    void emit("agent_start");
    let settled = false;
    const started = emit("tool_execution_start", tool("ask_user_question", "c1")).then(() => (settled = true));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "the handler waits for the flush");
    assert.deepEqual(flushes, ["question"]);
    release();
    await started;
    assert.equal(settled, true);
  });

  it("sets waiting while tau_wait runs", () => {
    const { emit, states } = setup();
    emit("agent_start");
    emit("tool_execution_start", tool("tau_wait", "w1"));
    emit("tool_execution_end", tool("tau_wait", "w1"));
    assert.deepEqual(states(), ["idle", "working", "waiting", "working"]);
  });

  it("ignores other tools", () => {
    const { emit, states, flushes } = setup();
    emit("agent_start");
    emit("tool_execution_start", tool("bash", "b1"));
    emit("tool_execution_end", tool("bash", "b1"));
    assert.deepEqual(states(), ["idle", "working"]);
    assert.deepEqual(flushes, []);
  });

  it("stays in question after tau_ask_user, until the next run", () => {
    const { emit, states } = setup();
    emit("agent_start");
    emit("turn_start");
    emit("tool_execution_start", tool("tau_ask_user", "q1"));
    emit("tool_execution_end", tool("tau_ask_user", "q1"));
    emit("turn_end", { toolResults: [{ toolName: "tau_ask_user", isError: false }] });
    emit("agent_before_settle", { outcome: "completed" });
    emit("agent_settled");
    assert.equal(states().at(-1), "question");
    emit("agent_start");
    assert.equal(states().at(-1), "working");
  });

  it("sets error after a run that ended with an error", () => {
    const { emit, states } = setup();
    emit("agent_start");
    emit("agent_before_settle", { outcome: "error" });
    emit("agent_settled");
    assert.equal(states().at(-1), "error");
    emit("agent_start");
    assert.equal(states().at(-1), "working");
  });

  it("sets error, not question, after an error in a run that asked a question", () => {
    const { emit, states } = setup();
    emit("agent_start");
    emit("turn_end", { toolResults: [{ toolName: "tau_ask_user", isError: false }] });
    emit("agent_before_settle", { outcome: "error" });
    emit("agent_settled");
    assert.equal(states().at(-1), "error");
  });

  it("restores the state after parallel ask and wait calls, in any order", () => {
    const { emit, reporter } = setup();
    emit("agent_start");
    emit("tool_execution_start", tool("tau_wait", "w1"));
    emit("tool_execution_start", tool("ask_user_question", "q1"));
    assert.equal(reporter.state, "question");
    emit("tool_execution_end", tool("tau_wait", "w1"));
    assert.equal(reporter.state, "question");
    emit("tool_execution_end", tool("ask_user_question", "q1"));
    assert.equal(reporter.state, "working");
    // An end without a start changes nothing.
    emit("tool_execution_end", tool("tau_wait", "w9"));
    assert.equal(reporter.state, "working");
  });

  it("sets idle after an aborted run, and removes the overlays of calls that did not end", () => {
    const { emit, reporter } = setup();
    emit("agent_start");
    emit("tool_execution_start", tool("tau_wait", "w1"));
    emit("agent_before_settle", { outcome: "aborted" });
    emit("agent_settled");
    assert.equal(reporter.state, "idle");
  });

  it("sets question during a UI prompt, also after the run", () => {
    const { emit, reporter } = setup();
    emit("agent_start");
    emit("ui_prompt_start", { kind: "confirm" });
    emit("ui_prompt_start", { kind: "select" });
    emit("ui_prompt_end", { kind: "select" });
    assert.equal(reporter.state, "question");
    emit("agent_before_settle", { outcome: "completed" });
    emit("agent_settled");
    assert.equal(reporter.state, "question");
    emit("ui_prompt_end", { kind: "confirm" });
    assert.equal(reporter.state, "idle");
  });

  it("sends the new model and the new name", () => {
    const { emit, records, reporter } = setup();
    emit("model_select", { model: { id: "gpt", name: "GPT" } });
    reporter.setName("fix-the-parser");
    reporter.setName("fix-the-parser");
    assert.equal(records.length, 3);
    assert.deepEqual(records.at(-1)!.metadata, [
      ["name", "fix-the-parser"],
      ["workspace", "/work/tau"],
      ["parent", ""],
      ["model", "GPT"],
    ]);
  });

  it("sends terminated at the close, then nothing", async () => {
    const { emit, states, reporter, closed } = setup();
    await reporter.close();
    await reporter.close();
    emit("agent_start");
    reporter.setName("x");
    assert.deepEqual(states(), ["idle", "terminated"]);
    assert.equal(closed(), true);
  });
});
