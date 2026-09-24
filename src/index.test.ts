import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import tau from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakePi {
  readonly api: ExtensionAPI;
  readonly handlers: Map<string, Handler[]>;
  readonly execCalls: string[][];
  /** The names of all other API members that the extension used. */
  readonly otherCalls: string[];
}

/**
 * A fake pi API. `on` and `exec` work. Each other member is a function that
 * records its name, so that a test can prove that the extension did not use
 * it.
 */
function fakePi(reply: { code: number; stdout: string }): FakePi {
  const handlers = new Map<string, Handler[]>();
  const execCalls: string[][] = [];
  const otherCalls: string[] = [];
  const known = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    async exec(command: string, args: string[]) {
      execCalls.push([command, ...args]);
      return { stdout: reply.stdout, stderr: "", code: reply.code, killed: false };
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
  return { api, handlers, execCalls, otherCalls };
}

function fakeCtx(hasUI = true) {
  const widgets: Array<{ key: string; lines: unknown }> = [];
  return {
    widgets,
    ctx: {
      hasUI,
      ui: {
        setWidget(key: string, lines: unknown) {
          widgets.push({ key, lines });
        },
      },
    },
  };
}

async function emit(pi: FakePi, event: string, ctx: unknown): Promise<void> {
  for (const handler of pi.handlers.get(event) ?? []) {
    await handler({ type: event, reason: "startup" }, ctx);
  }
}

const PANE_REPLY = JSON.stringify({ result: { pane: { pane_id: "w1:p1" } } });
const ENV_NAMES = ["HERDR_ENV", "HERDR_BIN_PATH"] as const;
const HERDR_BIN = "/opt/herdr/bin/herdr";

/** Sets the environment that herdr sets in each pane. */
function enableHerdr(): void {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_BIN_PATH = HERDR_BIN;
}

describe("tau extension", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of ENV_NAMES) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
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
    tau(pi.api);

    await emit(pi, "session_start", ctx);

    assert.deepEqual(widgets, [{ key: "tau", lines: ["🟢 Herdr"] }]);
    assert.deepEqual(pi.execCalls, [[HERDR_BIN, "pane", "current", "--current"]]);
  });

  it("shows the red badge and runs no command when HERDR_BIN_PATH is not set", async () => {
    process.env.HERDR_ENV = "1";
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx, widgets } = fakeCtx();
    tau(pi.api);

    await emit(pi, "session_start", ctx);

    assert.deepEqual(widgets, [{ key: "tau", lines: ["🔴 Herdr unavailable"] }]);
    assert.deepEqual(pi.execCalls, []);
    assert.deepEqual(pi.otherCalls, []);
  });

  it("shows the red badge and uses no other pi API when herdr is not available", async () => {
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx, widgets } = fakeCtx();
    tau(pi.api);

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
    tau(pi.api);

    await emit(pi, "session_start", ctx);

    assert.deepEqual(widgets, [{ key: "tau", lines: ["🔴 Herdr unavailable"] }]);
  });

  it("removes the badge on session_shutdown", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx, widgets } = fakeCtx();
    tau(pi.api);

    await emit(pi, "session_start", ctx);
    await emit(pi, "session_shutdown", ctx);

    assert.deepEqual(widgets.at(-1), { key: "tau", lines: undefined });
  });

  it("does not set or remove a widget when there is no UI", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const { ctx, widgets } = fakeCtx(false);
    tau(pi.api);

    await emit(pi, "session_start", ctx);
    await emit(pi, "session_shutdown", ctx);

    assert.deepEqual(widgets, []);
  });

  it("runs the herdr check only once for sessions that start later", async () => {
    enableHerdr();
    const pi = fakePi({ code: 0, stdout: PANE_REPLY });
    const first = fakeCtx();
    const second = fakeCtx();
    tau(pi.api);

    await Promise.all([emit(pi, "session_start", first.ctx), emit(pi, "session_start", second.ctx)]);
    await emit(pi, "session_start", second.ctx);

    assert.equal(pi.execCalls.length, 1);
    assert.deepEqual(first.widgets, [{ key: "tau", lines: ["🟢 Herdr"] }]);
    assert.deepEqual(second.widgets, [
      { key: "tau", lines: ["🟢 Herdr"] },
      { key: "tau", lines: ["🟢 Herdr"] },
    ]);
  });

  it("runs the herdr check again after a reload", async () => {
    // A reload runs the factory again. The new runtime must not use the
    // result of the old runtime.
    enableHerdr();
    const before = fakePi({ code: 0, stdout: PANE_REPLY });
    const beforeCtx = fakeCtx();
    tau(before.api);
    await emit(before, "session_start", beforeCtx.ctx);

    delete process.env.HERDR_ENV;
    const after = fakePi({ code: 0, stdout: PANE_REPLY });
    const afterCtx = fakeCtx();
    tau(after.api);
    await emit(after, "session_start", afterCtx.ctx);
    await emit(before, "session_start", beforeCtx.ctx);

    assert.deepEqual(afterCtx.widgets, [{ key: "tau", lines: ["🔴 Herdr unavailable"] }]);
    assert.deepEqual(beforeCtx.widgets, [
      { key: "tau", lines: ["🟢 Herdr"] },
      { key: "tau", lines: ["🟢 Herdr"] },
    ]);
  });
});
