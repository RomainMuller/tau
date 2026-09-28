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

  it("waits until the new agent works, with no key", async () => {
    const { exec, calls, options } = fakeExec([ok({})]);
    await new HerdrClient(exec, BIN).waitForWork("tau-t1");
    assert.deepEqual(calls[0]?.slice(1), [
      "agent", "wait", "tau-t1", "--until", "working", "--until", "blocked", "--until", "done", "--timeout", "10000",
    ]);
    // The process time limit is longer than the herdr wait.
    assert.ok((options[0]?.timeout ?? 0) > 10_000);
    const failed = fakeExec([fail("timeout", "timed out")]);
    await assert.rejects(new HerdrClient(failed.exec, BIN).waitForWork("tau-t1"), /herdr agent wait failed: timed out/);
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
