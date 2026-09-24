import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_DETECT_TIMEOUT_MS,
  detectHerdr,
  herdrBinary,
  parsePaneCurrent,
  type Exec,
  type ExecResult,
} from "./herdr.ts";

const PANE_REPLY = JSON.stringify({
  id: "cli:pane:current",
  result: {
    pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent: "pi" },
    type: "pane_current",
  },
});

const HERDR_BIN = "/opt/herdr/bin/herdr";
const HERDR_ENV = { HERDR_ENV: "1", HERDR_BIN_PATH: HERDR_BIN };

interface Call {
  readonly command: string;
  readonly args: string[];
  readonly options: { timeout?: number; signal?: AbortSignal } | undefined;
}

function fakeExec(result: Partial<ExecResult> | Error): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (command, args, options) => {
    calls.push({ command, args, options });
    if (result instanceof Error) {
      throw result;
    }
    return { stdout: "", stderr: "", code: 0, killed: false, ...result };
  };
  return { exec, calls };
}

describe("detectHerdr", () => {
  it("is available when HERDR_ENV is 1 and herdr identifies the pane", async () => {
    const { exec, calls } = fakeExec({ stdout: PANE_REPLY });

    const status = await detectHerdr(exec, { env: HERDR_ENV });

    assert.deepEqual(status, {
      available: true,
      binary: HERDR_BIN,
      pane: { paneId: "w1:p2", tabId: "w1:t1", workspaceId: "w1" },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, HERDR_BIN);
    assert.deepEqual(calls[0]?.args, ["pane", "current", "--current"]);
    assert.equal(calls[0]?.options?.timeout, DEFAULT_DETECT_TIMEOUT_MS);
  });

  for (const value of [undefined, "", "0", "true", " 1"]) {
    it(`is not available and runs no command when HERDR_ENV is ${JSON.stringify(value)}`, async () => {
      const { exec, calls } = fakeExec({ stdout: PANE_REPLY });
      const env = value === undefined ? {} : { HERDR_ENV: value };

      const status = await detectHerdr(exec, { env });

      assert.deepEqual(status, { available: false, reason: "HERDR_ENV is not set to 1" });
      assert.equal(calls.length, 0);
    });
  }

  it("uses the given timeout and signal", async () => {
    const { exec, calls } = fakeExec({ stdout: PANE_REPLY });
    const signal = new AbortController().signal;

    await detectHerdr(exec, { env: HERDR_ENV, timeoutMs: 50, signal });

    assert.equal(calls[0]?.options?.timeout, 50);
    assert.equal(calls[0]?.options?.signal, signal);
  });

  it("reports the herdr error message when herdr fails", async () => {
    const { exec } = fakeExec({
      code: 1,
      stderr: JSON.stringify({
        id: "cli:pane:current",
        error: { code: "server_not_running", message: "no herdr server is running" },
      }),
    });

    const status = await detectHerdr(exec, { env: HERDR_ENV });

    assert.deepEqual(status, { available: false, reason: "no herdr server is running" });
  });

  it("reports the exit code when herdr fails without a JSON error", async () => {
    const { exec } = fakeExec({ code: 2, stderr: "usage: herdr ..." });

    const status = await detectHerdr(exec, { env: HERDR_ENV });

    assert.deepEqual(status, { available: false, reason: "herdr exited with code 2" });
  });

  it("is not available when herdr does not reply in time", async () => {
    const { exec } = fakeExec({ code: 143, killed: true });

    const status = await detectHerdr(exec, { env: HERDR_ENV });

    assert.deepEqual(status, { available: false, reason: "herdr did not reply in time" });
  });

  it("is not available when the herdr binary does not exist", async () => {
    // pi.exec does not throw for a missing binary. It resolves with code 1 and
    // no output.
    const { exec } = fakeExec({ code: 1 });

    const status = await detectHerdr(exec, { env: HERDR_ENV });

    assert.deepEqual(status, { available: false, reason: "herdr exited with code 1" });
  });

  it("is not available when exec throws", async () => {
    const { exec } = fakeExec(new Error("spawn herdr EACCES"));

    const status = await detectHerdr(exec, { env: HERDR_ENV });

    assert.deepEqual(status, {
      available: false,
      reason: "cannot run herdr: spawn herdr EACCES",
    });
  });

  it("reports a herdr error message that is on stdout", async () => {
    const { exec } = fakeExec({
      code: 1,
      stdout: JSON.stringify({ error: { message: "pane not found" } }),
    });

    const status = await detectHerdr(exec, { env: HERDR_ENV });

    assert.deepEqual(status, { available: false, reason: "pane not found" });
  });

  it("is not available when herdr exits with 0 but the reply is not JSON", async () => {
    const { exec } = fakeExec({ stdout: "herdr 0.9.1" });

    const status = await detectHerdr(exec, { env: HERDR_ENV });

    assert.deepEqual(status, { available: false, reason: "herdr returned an unexpected reply" });
  });

  for (const value of [undefined, "", "herdr", "./bin/herdr"]) {
    it(`is not available and runs no command when HERDR_BIN_PATH is ${JSON.stringify(value)}`, async () => {
      const { exec, calls } = fakeExec({ stdout: PANE_REPLY });
      const env = value === undefined ? { HERDR_ENV: "1" } : { HERDR_ENV: "1", HERDR_BIN_PATH: value };

      const status = await detectHerdr(exec, { env });

      assert.deepEqual(status, {
        available: false,
        reason: "HERDR_BIN_PATH is not an absolute path",
      });
      assert.equal(calls.length, 0);
    });
  }

  it("is not available when herdr returns a reply without a pane", async () => {
    const { exec } = fakeExec({ stdout: JSON.stringify({ result: {} }) });

    const status = await detectHerdr(exec, { env: HERDR_ENV });

    assert.deepEqual(status, { available: false, reason: "herdr returned an unexpected reply" });
  });
});

describe("parsePaneCurrent", () => {
  it("reads the pane, tab, and workspace IDs", () => {
    assert.deepEqual(parsePaneCurrent(PANE_REPLY), {
      paneId: "w1:p2",
      tabId: "w1:t1",
      workspaceId: "w1",
    });
  });

  it("accepts a reply without tab and workspace IDs", () => {
    const reply = JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } });

    assert.deepEqual(parsePaneCurrent(reply), {
      paneId: "w1:p2",
      tabId: undefined,
      workspaceId: undefined,
    });
  });

  for (const [name, text] of [
    ["empty text", ""],
    ["text that is not JSON", "not json"],
    ["JSON null", "null"],
    ["a JSON array", "[]"],
    ["an error reply", JSON.stringify({ error: { message: "x" } })],
    ["a pane without an ID", JSON.stringify({ result: { pane: {} } })],
    ["an empty pane ID", JSON.stringify({ result: { pane: { pane_id: "" } } })],
    ["a pane ID that is not a string", JSON.stringify({ result: { pane: { pane_id: 3 } } })],
  ] as const) {
    it(`returns undefined for ${name}`, () => {
      assert.equal(parsePaneCurrent(text), undefined);
    });
  }
});

describe("herdrBinary", () => {
  it("uses HERDR_BIN_PATH when it is an absolute path", () => {
    assert.equal(herdrBinary({ HERDR_BIN_PATH: "/usr/local/bin/herdr" }), "/usr/local/bin/herdr");
  });

  for (const value of [undefined, "", "herdr", "./bin/herdr", "node_modules/.bin/herdr"]) {
    it(`returns undefined when HERDR_BIN_PATH is ${JSON.stringify(value)}`, () => {
      const env = value === undefined ? {} : { HERDR_BIN_PATH: value };
      assert.equal(herdrBinary(env), undefined);
    });
  }
});
