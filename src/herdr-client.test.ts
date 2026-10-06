import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { checkStartTimeout, HerdrClient, HerdrError, StartTimeoutError } from "./herdr-client.ts";
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

  it("waits until the new agent works, with no key", async () => {
    const { exec, calls, options } = fakeExec([ok({})]);
    await new HerdrClient(exec, BIN).waitForWork("tau-t1");
    assert.deepEqual(calls[0]?.slice(1), [
      "agent", "wait", "tau-t1", "--until", "working", "--until", "blocked", "--until", "done", "--timeout", "10000",
    ]);
    // The process time limit is longer than the herdr wait.
    assert.ok((options[0]?.timeout ?? 0) > 10_000);
    const failed = fakeExec([fail("timeout", "timed out waiting for agent status")]);
    await assert.rejects(new HerdrClient(failed.exec, BIN).waitForWork("tau-t1"), (error: unknown) => {
      assert.ok(error instanceof StartTimeoutError);
      assert.equal(error.phase, "work");
      assert.match(error.message, /^The start timed out: pi did not start to work on its first prompt in 10 seconds \(herdr agent wait failed: timed out waiting for agent status\)\./);
      assert.match(error.message, /Try again with a higher start_timeout_seconds/);
      return true;
    });
    const other = fakeExec([fail("agent_not_found", "no agent")]);
    await assert.rejects(new HerdrClient(other.exec, BIN).waitForWork("tau-t1"), (error: unknown) => !(error instanceof StartTimeoutError));
  });

  it("waits for work for the given time, at least 10 seconds, and at most 300 seconds", async () => {
    const { exec, calls, options } = fakeExec([ok({}), ok({}), ok({})]);
    const client = new HerdrClient(exec, BIN);
    await client.waitForWork("tau-t1", 45_000);
    await client.waitForWork("tau-t1", 1);
    await client.waitForWork("tau-t1", 900_000);
    assert.deepEqual(calls.map((call) => call.at(-1)), ["45000", "10000", "300000"]);
    assert.ok((options[0]?.timeout ?? 0) > 45_000);
  });

  it("cuts a long herdr error text in a start timeout, and removes control characters", () => {
    const error = new StartTimeoutError("ready", 60_000, `timed out \u001b[31m${"x".repeat(5_000)}`);
    assert.ok(error.message.length < 1_000, String(error.message.length));
    assert.doesNotMatch(error.message, /\u001b/);
  });

  it("starts pi, and tries again while the new pane is busy", async () => {
    const { exec, calls } = fakeExec([fail("agent_pane_busy", "not a shell"), ok({ agent: {} })]);
    await new HerdrClient(exec, BIN).startPiAgent("tau-t1", "w1:p9", ["--model", "p/m"]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]?.slice(1), [
      "agent", "start", "tau-t1", "--kind", "pi", "--pane", "w1:p9", "--timeout", "60000", "--", "--model", "p/m",
    ]);
    // The second try gets the time that is left of the start timeout.
    const left = Number(calls[1]?.[calls[1].indexOf("--timeout") + 1]);
    assert.ok(left > 55_000 && left <= 60_000, String(left));
  });

  it("starts pi with a given start timeout, and a longer process time limit", async () => {
    const { exec, calls, options } = fakeExec([ok({ agent: {} })]);
    await new HerdrClient(exec, BIN).startPiAgent("tau-t1", "w1:p9", [], 180_000);
    assert.deepEqual(calls[0]?.slice(1, 9), ["agent", "start", "tau-t1", "--kind", "pi", "--pane", "w1:p9", "--timeout"]);
    assert.equal(calls[0]?.[9], "180000");
    assert.ok((options[0]?.timeout ?? 0) > 180_000);
  });

  it("reports a start timeout of herdr, or of the process, with a hint to use a higher timeout", async () => {
    for (const reply of [fail("timeout", "timed out waiting for agent startup"), { killed: true, code: 143 }]) {
      const { exec, calls } = fakeExec([reply]);
      await assert.rejects(new HerdrClient(exec, BIN).startPiAgent("tau-t1", "w1:p9", [], 90_000), (error: unknown) => {
        assert.ok(error instanceof StartTimeoutError);
        assert.equal(error.timeoutMs, 90_000);
        assert.equal(error.phase, "ready");
        assert.match(error.message, /^The start timed out: pi was not ready in the new pane in 90 seconds \(herdr agent start /);
        assert.match(error.message, /Try again with a higher start_timeout_seconds \(the default is 60, the maximum is 300\)\.$/);
        return true;
      });
      assert.equal(calls.length, 1);
    }
  });

  it("uses the start timeout also while the shell is not ready, and then reports a start timeout", async () => {
    let now = 1_000_000;
    const clock = mock.method(Date, "now", () => now);
    try {
      const busy = fail("agent_pane_busy", "the pane shell is not ready");
      const { exec, calls } = fakeExec([busy, busy, busy]);
      const wrapped: typeof exec = async (command, args, option) => {
        const reply = await exec(command, args, option);
        now += 40_000;
        return reply;
      };
      await assert.rejects(new HerdrClient(wrapped, BIN).startPiAgent("tau-t1", "w1:p9", [], 100_000), (error: unknown) => {
        assert.ok(error instanceof StartTimeoutError);
        assert.match(error.message, /the shell of the new pane was not ready/);
        assert.match(error.message, /Try again with a higher start_timeout_seconds/);
        return true;
      });
      // Each try gets the time that is left.
      assert.deepEqual(calls.map((call) => call[call.indexOf("--timeout") + 1]), ["100000", "60000", "20000"]);
    } finally {
      clock.mock.restore();
    }
  });

  it("rejects a start timeout that is not valid, before it runs herdr", async () => {
    for (const value of [0, -5, 1.5, 300_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => checkStartTimeout(value), /from 1 to 300 seconds/);
      const { exec, calls } = fakeExec([]);
      await assert.rejects(new HerdrClient(exec, BIN).startPiAgent("tau-t1", "w1:p9", [], value), /from 1 to 300 seconds/);
      assert.equal(calls.length, 0);
    }
    assert.equal(checkStartTimeout(300_000), 300_000);
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

  it("removes tokens in a report, and renames an agent", async () => {
    const { exec, calls } = fakeExec([{}, {}]);
    const client = new HerdrClient(exec, BIN);
    await client.reportMetadata("w1:p2", { source: "tau:x", tokens: { a: "1" }, clearTokens: ["model"] });
    await client.renameAgent("w1:p2", "tau-t1");
    assert.deepEqual(calls[0]?.slice(1), ["pane", "report-metadata", "w1:p2", "--source", "tau:x", "--token", "a=1", "--clear-token", "model"]);
    assert.deepEqual(calls[1]?.slice(1), ["agent", "rename", "w1:p2", "tau-t1"]);
  });
});
