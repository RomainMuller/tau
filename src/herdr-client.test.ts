import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HerdrClient, HerdrError } from "./herdr-client.ts";
import type { Exec, ExecResult } from "./herdr.ts";

type Reply = Partial<ExecResult> | Error;

/** A fake exec. Each call takes the next reply. */
function fakeExec(replies: Reply[]): { exec: Exec; calls: string[][]; options: Array<{ timeout?: number } | undefined> } {
  const calls: string[][] = [];
  const options: Array<{ timeout?: number } | undefined> = [];
  const exec: Exec = async (command, args, option) => {
    calls.push([command, ...args]);
    options.push(option);
    const reply = replies.shift() ?? {};
    if (reply instanceof Error) throw reply;
    return { stdout: "", stderr: "", code: 0, killed: false, ...reply };
  };
  return { exec, calls, options };
}

const ok = (result: unknown): Reply => ({ stdout: JSON.stringify({ result }) });
const fail = (code: string, message: string): Reply => ({ code: 1, stderr: JSON.stringify({ error: { code, message } }) });
const BIN = "/opt/herdr/bin/herdr";

describe("HerdrClient", () => {
  it("splits right for a wide pane, down for a narrow pane, and right when it cannot tell", async () => {
    const layout = (width: number, height: number) =>
      ok({ layout: { panes: [{ pane_id: "w1:p1", rect: { width, height } }] } });
    const { exec, calls } = fakeExec([layout(200, 50), layout(80, 60), { code: 1 }]);
    const client = new HerdrClient(exec, BIN);
    assert.equal(await client.splitDirection("w1:p1"), "right");
    assert.equal(await client.splitDirection("w1:p1"), "down");
    assert.equal(await client.splitDirection("w1:p1"), "right");
    assert.deepEqual(calls[0], [BIN, "pane", "layout", "--pane", "w1:p1"]);
  });

  it("splits a pane with the cwd, without focus, and with each environment variable", async () => {
    const { exec, calls } = fakeExec([ok({ pane: { pane_id: "w1:p9" } })]);
    const pane = await new HerdrClient(exec, BIN).splitPane("w1:p1", {
      direction: "down",
      cwd: "/work dir",
      env: { A: "1", B: "x=y" },
    });
    assert.equal(pane, "w1:p9");
    assert.deepEqual(calls[0], [
      BIN, "pane", "split", "--pane", "w1:p1", "--direction", "down", "--cwd", "/work dir", "--no-focus",
      "--env", "A=1", "--env", "B=x=y",
    ]);
  });

  it("fails when a split reply has no pane ID", async () => {
    const { exec } = fakeExec([ok({})]);
    await assert.rejects(new HerdrClient(exec, BIN).splitPane("w1:p1", { direction: "right", cwd: "/", env: {} }), /no pane ID/);
  });

  it("sends a prompt, and waits until the agent works on it", async () => {
    const { exec, calls, options } = fakeExec([ok({})]);
    await new HerdrClient(exec, BIN).prompt("tau-t1", "Do T1");
    assert.ok((options[0]?.timeout ?? 0) > 10_000);
    assert.deepEqual(calls.map((call) => call.slice(1)), [
      ["agent", "prompt", "tau-t1", "Do T1", "--wait", "--until", "working", "--until", "blocked", "--timeout", "10000"],
    ]);
  });

  /** A reply of `agent list` with one agent. */
  const listed = (name: string, status: string): Reply => ok({ agents: [{ name, pane_id: "w1:p9", agent_status: status }] });

  it("sends one Enter key when the prompt stalled and the agent is idle, then waits again", async () => {
    for (const code of ["agent_prompt_stalled", "timeout"]) {
      const { exec, calls, options } = fakeExec([fail(code, "no working state"), listed("tau-t1", "idle"), ok({}), ok({})]);
      await new HerdrClient(exec, BIN).prompt("tau-t1", "Do T1");
      assert.deepEqual(calls.slice(1).map((call) => call.slice(1)), [
        ["agent", "list"],
        ["agent", "send-keys", "tau-t1", "Enter"],
        ["agent", "wait", "tau-t1", "--until", "working", "--until", "blocked", "--until", "done", "--timeout", "10000"],
      ], code);
      // The process time limit of the waits is longer than the herdr wait.
      for (const index of [0, 3]) assert.ok((options[index]?.timeout ?? 0) > 10_000, JSON.stringify(options));
    }
  });

  it("sends no Enter key when the stalled agent works, waits for the user, or is done", async () => {
    for (const status of ["working", "blocked", "done"]) {
      const { exec, calls } = fakeExec([fail("agent_prompt_stalled", "stalled"), listed("tau-t1", status)]);
      await new HerdrClient(exec, BIN).prompt("tau-t1", "Do T1");
      assert.equal(calls.length, 2, status);
    }
  });

  it("fails with no Enter key when the stalled agent is not known, or its state is unknown", async () => {
    for (const reply of [listed("tau-t1", "unknown"), listed("other", "idle"), ok({ agents: [] })]) {
      const { exec, calls } = fakeExec([fail("agent_prompt_stalled", "stalled"), reply]);
      await assert.rejects(new HerdrClient(exec, BIN).prompt("tau-t1", "Do T1"), (error: unknown) => {
        assert.ok(error instanceof HerdrError);
        assert.match(error.message, /tau-t1 did not start to work on its first prompt, and its state is/);
        return true;
      });
      assert.equal(calls.length, 2);
    }
  });

  it("fails when the agent does not work on the prompt also after the Enter key", async () => {
    const { exec, calls } = fakeExec([fail("agent_prompt_stalled", "stalled"), listed("tau-t1", "idle"), ok({}), fail("timeout", "timed out")]);
    await assert.rejects(new HerdrClient(exec, BIN).prompt("tau-t1", "Do T1"), (error: unknown) => {
      assert.ok(error instanceof HerdrError);
      assert.match(error.message, /tau-t1 did not start to work on its first prompt \(also after one more Enter key\)/);
      assert.equal(error.herdrCode, "timeout");
      return true;
    });
    assert.equal(calls.length, 4);
  });

  it("does not send an Enter key for other prompt errors", async () => {
    for (const reply of [fail("agent_blocked", "blocked"), fail("agent_not_found", "gone"), { killed: true }] as Reply[]) {
      const { exec, calls } = fakeExec([reply]);
      await assert.rejects(new HerdrClient(exec, BIN).prompt("tau-t1", "Do T1"));
      assert.equal(calls.length, 1);
    }
    // An error of the wait after the Enter key, other than a stall: as it is.
    const { exec } = fakeExec([fail("agent_prompt_stalled", "stalled"), listed("tau-t1", "idle"), ok({}), fail("agent_not_found", "gone")]);
    await assert.rejects(new HerdrClient(exec, BIN).prompt("tau-t1", "Do T1"), /herdr agent wait failed: gone/);
  });

  it("starts pi, and tries again while the new pane is busy", async () => {
    const { exec, calls } = fakeExec([fail("agent_pane_busy", "not a shell"), ok({ agent: {} })]);
    await new HerdrClient(exec, BIN).startPiAgent("tau-t1", "w1:p9", ["--model", "p/m"]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1]?.slice(1), [
      "agent", "start", "tau-t1", "--kind", "pi", "--pane", "w1:p9", "--timeout", "60000", "--", "--model", "p/m",
    ]);
  });

  it("does not try again for other errors", async () => {
    const { exec, calls } = fakeExec([fail("agent_not_ready", "blocked")]);
    await assert.rejects(new HerdrClient(exec, BIN).startPiAgent("tau-t1", "w1:p9", []), (error: unknown) => {
      assert.ok(error instanceof HerdrError);
      assert.equal(error.herdrCode, "agent_not_ready");
      assert.match(error.message, /herdr agent start failed: blocked/);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it("reads the live agents and the panes", async () => {
    const { exec } = fakeExec([
      ok({ agents: [{ name: "tau-t1", pane_id: "w1:p2", agent_status: "working" }, { pane_id: "w1:p3" }, { name: "x" }] }),
      ok({ panes: [{ pane_id: "w1:p2" }, { pane_id: 3 }, {}] }),
    ]);
    const client = new HerdrClient(exec, BIN);
    assert.deepEqual(await client.listAgents(), [
      { name: "tau-t1", paneId: "w1:p2", status: "working", session: undefined },
      { name: undefined, paneId: "w1:p3", status: "unknown", session: undefined },
    ]);
    assert.deepEqual([...(await client.listPanes())], ["w1:p2"]);
  });

  it("rejects replies without lists", async () => {
    const { exec } = fakeExec([ok({}), ok({})]);
    const client = new HerdrClient(exec, BIN);
    await assert.rejects(client.listAgents(), /without a list of agents/);
    await assert.rejects(client.listPanes(), /without a list of panes/);
  });

  it("maps thrown, killed, and failed commands to errors", async () => {
    const { exec } = fakeExec([new Error("spawn EACCES"), { killed: true, code: 143 }, { code: 2, stderr: "usage" }]);
    const client = new HerdrClient(exec, BIN);
    await assert.rejects(client.closePane("w1:p2"), /herdr pane close failed: spawn EACCES/);
    await assert.rejects(client.closePane("w1:p2"), /did not reply in time/);
    await assert.rejects(client.closePane("w1:p2"), /exit code 2/);
  });

  it("reports and clears pane metadata", async () => {
    const { exec, calls } = fakeExec([{}, {}]);
    const client = new HerdrClient(exec, BIN);
    await client.reportMetadata("w1:p2", { source: "tau:x", title: "T", displayAgent: "tau", tokens: { a: "1" } });
    await client.clearMetadata("w1:p2", "tau:x");
    assert.deepEqual(calls[0]?.slice(1), [
      "pane", "report-metadata", "w1:p2", "--source", "tau:x", "--title", "T", "--display-agent", "tau", "--token", "a=1",
    ]);
    assert.deepEqual(calls[1]?.slice(1), ["pane", "report-metadata", "w1:p2", "--source", "tau:x", "--clear-title", "--clear-display-agent"]);
  });
});
