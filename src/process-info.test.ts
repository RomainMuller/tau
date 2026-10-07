import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  composeMachine,
  isZombie,
  MAX_PS_PIDS,
  parseMachineId,
  parseProcStat,
  parsePsOutput,
  systemProbe,
  type SystemProbeOptions,
} from "./process-info.ts";
import type { ProcessRecord } from "./tasks/model.ts";

const NOW = "2026-01-01T00:00:00.000Z";

/** A stat line with a command name that has spaces and `)`. Field 22 (starttime) is 4242. */
const STAT = "123 (my (odd) cmd) S 1 123 123 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 4242 1000 50";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/**
 * A probe on "macOS" with fake processes: PID to lstart text (undefined: no
 * such process). A text that starts with `Z ` is a zombie.
 */
function macProbe(processes: Record<number, string | undefined>, extra: Partial<SystemProbeOptions> = {}) {
  const psCalls: number[][] = [];
  const probe = systemProbe({
    now: () => NOW,
    pid: 100,
    platform: "darwin",
    hostname: () => "host",
    token: () => "me",
    kill: (pid) => {
      if (processes[pid] === undefined) throw errno("ESRCH");
    },
    ps: async (pids) => {
      psCalls.push([...pids]);
      return pids
        .filter((pid) => processes[pid] !== undefined)
        .map((pid) => (processes[pid]!.startsWith("Z ") ? `  ${pid} ${processes[pid]}` : `  ${pid} Ss  ${processes[pid]}`))
        .join("\n");
    },
    ...extra,
  });
  return { probe, psCalls };
}

const record = (fields: Partial<ProcessRecord> = {}): ProcessRecord => ({
  pid: 200,
  start: "ps:Tue Oct 7 09:25:38 2026",
  machine: "host",
  token: "other",
  attachedAt: NOW,
  ...fields,
});

describe("parseProcStat", () => {
  it("reads field 3 (the state) and field 22 after the last ')'", () => {
    assert.deepEqual(parseProcStat(STAT), { state: "S", ticks: "4242" });
    assert.deepEqual(parseProcStat(STAT.replace(") S ", ") Z ")), { state: "Z", ticks: "4242" });
  });

  it("rejects text without the fields", () => {
    assert.equal(parseProcStat("123 (cmd) S 1 2"), undefined);
    assert.equal(parseProcStat("no parenthesis"), undefined);
    assert.equal(parseProcStat(STAT.replace(") S ", ") SS ")), undefined);
  });
});

describe("parsePsOutput", () => {
  it("reads more than one PID, with the state and extra spaces", () => {
    const result = parsePsOutput("  12 Ss   Tue Oct  7 09:25:38 2026\n345 Z+  Wed Oct 8 10:00:00 2026  \n\ngarbage\n");
    assert.deepEqual([...result], [
      [12, { state: "Ss", start: "Tue Oct 7 09:25:38 2026" }],
      [345, { state: "Z+", start: "Wed Oct 8 10:00:00 2026" }],
    ]);
  });
});

describe("isZombie", () => {
  it("is true only for Z and X", () => {
    assert.deepEqual(["Z", "Z+", "X", "S", "Ss", "R+", "D", ""].map(isZombie), [true, true, true, false, false, false, false, false]);
  });
});

describe("machine", () => {
  it("parses a machine ID", () => {
    assert.equal(parseMachineId("0123456789ABCDEF0123456789abcdef\n"), "0123456789abcdef0123456789abcdef");
    assert.equal(parseMachineId("00000000000000000000000000000000"), undefined, "not set");
    assert.equal(parseMachineId("uninitialized\n"), undefined);
    assert.equal(parseMachineId(""), undefined);
  });

  it("composes the machine text", () => {
    assert.equal(composeMachine("host"), "host");
    assert.equal(composeMachine("", undefined, "pid:[1]"), "unknown|pid:[1]");
    assert.equal(composeMachine("host", "abc", "pid:[1]"), "host|abc|pid:[1]");
    assert.equal(composeMachine("h".repeat(300)).length, 200);
    // A long host name does not remove the machine ID or the namespace.
    const long = composeMachine("h".repeat(300), "a".repeat(32), "pid:[1]");
    assert.equal(long.length, 200);
    assert.ok(long.endsWith(`|${"a".repeat(32)}|pid:[1]`));
    assert.notEqual(long, composeMachine("h".repeat(300), "b".repeat(32), "pid:[1]"));
  });
});

describe("systemProbe", () => {
  it("makes the record of this runtime one time", async () => {
    const { probe, psCalls } = macProbe({ 100: "Mon Oct  6 08:00:00 2026" });
    const self = await probe.self();
    assert.deepEqual(self, { pid: 100, start: "ps:Mon Oct 6 08:00:00 2026", machine: "host", token: "me", attachedAt: NOW });
    assert.equal(await probe.self(), self);
    assert.deepEqual(psCalls, [[100]]);
  });

  it("makes a record with no start time when ps cannot run", async () => {
    const { probe } = macProbe({ 100: "x" }, { ps: async () => undefined });
    assert.equal((await probe.self()).start, undefined);
  });

  it("reads the start time and the machine on Linux", async () => {
    const files: Record<string, string> = {
      "/proc/sys/kernel/random/boot_id": "b00t-1\n",
      "/proc/100/stat": STAT,
    };
    const probe = systemProbe({
      now: () => NOW,
      pid: 100,
      platform: "linux",
      hostname: () => "host",
      token: () => "me",
      readFile: async (path) => {
        if (files[path] === undefined) throw errno("ENOENT");
        return files[path];
      },
      readlink: async () => "pid:[4026531836]",
      ps: async () => assert.fail("no ps on Linux with /proc"),
    });
    const self = await probe.self();
    assert.equal(self.start, "linux:b00t-1:4242");
    assert.equal(self.machine, "host|pid:[4026531836]");
  });

  it("adds the machine ID on Linux, and finds a zombie in /proc", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const files: Record<string, string> = {
      "/proc/sys/kernel/random/boot_id": "b00t-1\n",
      "/var/lib/dbus/machine-id": `${id}\n`,
      "/proc/100/stat": STAT,
      "/proc/200/stat": STAT.replace(") S ", ") Z "),
      "/proc/300/stat": STAT,
    };
    const probe = systemProbe({
      now: () => NOW,
      pid: 100,
      platform: "linux",
      hostname: () => "host",
      token: () => "me",
      kill: () => undefined,
      readFile: async (path) => {
        if (files[path] === undefined) throw errno("ENOENT");
        return files[path];
      },
      readlink: async () => "pid:[4026531836]",
      ps: async () => assert.fail("no ps on Linux with /proc"),
    });
    const self = await probe.self();
    assert.equal(self.machine, `host|${id}|pid:[4026531836]`);
    const zombie = record({ pid: 200, start: "linux:b00t-1:4242", machine: self.machine });
    const live = record({ pid: 300, start: "linux:b00t-1:4242", machine: self.machine });
    const result = await probe.probe([zombie, live]);
    assert.equal(result.get(zombie), "dead");
    assert.equal(result.get(live), "alive");
  });

  it("uses ps on Linux when /proc cannot be read", async () => {
    const probe = systemProbe({
      now: () => NOW,
      pid: 100,
      platform: "linux",
      hostname: () => "host",
      readFile: async () => {
        throw errno("ENOENT");
      },
      readlink: async () => {
        throw errno("ENOENT");
      },
      ps: async () => "100 Ss Mon Oct 6 08:00:00 2026",
    });
    const self = await probe.self();
    assert.equal(self.start, "ps:Mon Oct 6 08:00:00 2026");
    assert.equal(self.machine, "host");
  });

  it("has no start time on Windows", async () => {
    const probe = systemProbe({ now: () => NOW, platform: "win32", hostname: () => "host", ps: async () => assert.fail("no ps") });
    assert.equal((await probe.self()).start, undefined);
  });

  describe("probe rules", () => {
    const processes = { 100: "Mon Oct 6 08:00:00 2026", 200: "Tue Oct 7 09:25:38 2026" };

    it("gives each result in one ps call", async () => {
      const { probe, psCalls } = macProbe(processes);
      const self = await probe.self();
      psCalls.length = 0;
      const items = {
        otherMachine: record({ machine: "different" }),
        detached: record({ detachedAt: NOW }),
        own: { ...self },
        missing: record({ pid: 300 }),
        noStart: (({ start: _start, ...rest }) => rest)(record()),
        sameStart: record(),
        sameStart2: record({ token: "x" }),
        otherStart: record({ start: "ps:Wed Oct 8 00:00:00 2026" }),
        otherScheme: record({ start: "linux:b:1" }),
      };
      const result = await probe.probe(Object.values(items));
      const by = Object.fromEntries(Object.entries(items).map(([key, value]) => [key, result.get(value)]));
      assert.deepEqual(by, {
        otherMachine: "unknown",
        detached: "dead",
        own: "alive",
        missing: "dead",
        noStart: "unknown",
        sameStart: "alive",
        sameStart2: "alive",
        otherStart: "dead",
        otherScheme: "unknown",
      });
      // One ps call, for the PIDs that exist and need a start time.
      assert.deepEqual(psCalls, [[200]]);
    });

    it("continues after EPERM, and gives unknown for a different error", async () => {
      let code = "EPERM";
      const { probe } = macProbe(processes, {
        kill: () => {
          throw errno(code);
        },
      });
      const item = record();
      assert.equal((await probe.probe([item])).get(item), "alive");
      code = "EINVAL";
      assert.equal((await probe.probe([item])).get(item), "unknown");
    });

    it("gives unknown when the start time cannot be read now", async () => {
      const failing = systemProbe({
        now: () => NOW,
        pid: 100,
        platform: "darwin",
        hostname: () => "host",
        kill: () => undefined,
        ps: async (pids) => (pids.includes(100) ? "100 Ss Mon Oct 6 08:00:00 2026" : undefined),
      });
      const item = record();
      assert.equal((await failing.probe([item])).get(item), "unknown");
    });

    it("gives dead for a zombie with the same start time (ps)", async () => {
      const { probe } = macProbe({ ...processes, 200: "Z Tue Oct 7 09:25:38 2026" });
      const item = record();
      assert.equal((await probe.probe([item])).get(item), "dead");
    });

    it("gives at most MAX_PS_PIDS PIDs to one ps call", async () => {
      const many: Record<number, string> = { 100: "Mon Oct 6 08:00:00 2026" };
      for (let pid = 1000; pid < 1000 + 2 * MAX_PS_PIDS + 50; pid++) many[pid] = "Tue Oct 7 09:25:38 2026";
      const { probe, psCalls } = macProbe(many);
      await probe.self();
      psCalls.length = 0;
      const items = Object.keys(many)
        .map(Number)
        .filter((pid) => pid !== 100)
        .map((pid) => record({ pid }));
      const result = await probe.probe(items);
      assert.deepEqual(psCalls.map((pids) => pids.length), [MAX_PS_PIDS, MAX_PS_PIDS, 50]);
      assert.equal(items.every((item) => result.get(item) === "alive"), true);
    });

    it("quickProbe uses only kill", async () => {
      const { probe, psCalls } = macProbe(processes);
      assert.equal(probe.quickProbe(record()), "unknown", "before self()");
      await probe.self();
      psCalls.length = 0;
      assert.equal(probe.quickProbe(undefined), "unknown");
      assert.equal(probe.quickProbe(record({ machine: "x" })), "unknown");
      assert.equal(probe.quickProbe(record({ detachedAt: NOW })), "dead");
      assert.equal(probe.quickProbe(record({ pid: 300 })), "dead");
      // A different start time is not checked: the PID exists.
      assert.equal(probe.quickProbe(record({ start: "ps:other" })), "alive");
      assert.deepEqual(psCalls, []);
    });
  });

  it("makes a record for the real process", async () => {
    const probe = systemProbe();
    const self = await probe.self();
    assert.equal(self.pid, process.pid);
    assert.ok(self.machine.length > 0);
    assert.ok(self.token.length > 0);
    // The start time can be absent (for example, when ps cannot run here).
    assert.equal((await probe.probe([self])).get(self), "alive");
  });
});
