import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentState } from "./protocol.ts";
import { AgentStatus } from "./status.ts";

function tracked(): { status: AgentStatus; changes: AgentState[] } {
  const changes: AgentState[] = [];
  return { status: new AgentStatus((state) => changes.push(state)), changes };
}

describe("AgentStatus", () => {
  it("starts idle, and tells only real changes", () => {
    const { status, changes } = tracked();
    assert.equal(status.state, "idle");
    status.setBase("idle");
    status.setBase("working");
    status.setBase("working");
    assert.deepEqual(changes, ["working"]);
  });

  it("restores the state before a call when the call ends", () => {
    const { status, changes } = tracked();
    status.setBase("working");
    status.push("ask-1", "question");
    status.pop("ask-1");
    status.push("wait-1", "waiting");
    status.pop("wait-1");
    assert.deepEqual(changes, ["working", "question", "working", "waiting", "working"]);
  });

  it("keeps the base state that changed during a call", () => {
    const { status } = tracked();
    status.setBase("working");
    status.push("wait-1", "waiting");
    status.setBase("error");
    assert.equal(status.state, "waiting");
    status.pop("wait-1");
    assert.equal(status.state, "error");
  });

  it("gives priority to a question over a wait (parallel calls)", () => {
    const { status } = tracked();
    status.push("wait-1", "waiting");
    status.push("ask-1", "question");
    assert.equal(status.state, "question");
    status.pop("ask-1");
    assert.equal(status.state, "waiting");
    status.pop("wait-1");
    assert.equal(status.state, "idle");
  });

  it("ignores the end of an unknown call, and clears all overlays", () => {
    const { status, changes } = tracked();
    status.pop("nothing");
    status.push("a", "waiting");
    status.push("b", "question");
    status.clearOverlays();
    status.clearOverlays();
    assert.equal(status.state, "idle");
    assert.deepEqual(changes, ["waiting", "question", "idle"]);
  });
});
