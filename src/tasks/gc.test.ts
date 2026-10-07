import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { decodeTaskList, encodeTaskList } from "./codec.ts";
import { collectOrphanedTaskLists, DEFAULT_GC_GRACE_MS } from "./gc.ts";
import { seedTaskList } from "./model.ts";
import { taskListFile } from "./paths.ts";
import { TaskListStore } from "./store.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;

let root: string;
let tau: string;
let sessions: string;
/** The current time of the collection: two days after the files changed. */
let now: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tau-gc-"));
  tau = join(root, "tau");
  sessions = join(root, "agent", "sessions");
  await mkdir(join(sessions, "--cwd--"), { recursive: true });
  now = Date.now() + 2 * DAY;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Makes the task list of `id`. `sessionFile` is the recorded transcript (omit: no field). */
async function makeList(id: string, sessionFile?: string | null): Promise<string> {
  const file = taskListFile(tau, id);
  const store = new TaskListStore(file);
  await store.ensure(() => {
    const list = seedTaskList(id, NOW);
    if (sessionFile !== undefined) list.sessionFile = sessionFile;
    return list;
  });
  store.close();
  return file;
}

async function makeTranscript(id: string, directory = join(sessions, "--cwd--")): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  await writeFile(file, "{}\n");
  return file;
}

async function remaining(): Promise<string[]> {
  return (await readdir(join(tau, "tasklists"))).filter((name) => name.endsWith(".db")).sort();
}

function collect(extra: Partial<Parameters<typeof collectOrphanedTaskLists>[0]> = {}) {
  return collectOrphanedTaskLists({ tauDirectory: tau, sessionRoots: [sessions], keep: "current", now, ...extra });
}

describe("collectOrphanedTaskLists", () => {
  it("removes a list whose recorded transcript does not exist, with its WAL and SHM files", async () => {
    const kept = await makeTranscript("alive");
    await makeList("alive", kept);
    await makeList("gone", join(sessions, "--cwd--", "2026_gone.jsonl"));
    await writeFile(`${taskListFile(tau, "gone")}-wal`, "");
    await writeFile(`${taskListFile(tau, "gone")}-shm`, "");
    const result = await collect();
    assert.deepEqual(result, { removed: ["gone"], errors: 0 });
    assert.deepEqual(await remaining(), ["alive.db"]);
    const names = await readdir(join(tau, "tasklists"));
    assert.equal(names.some((name) => name.startsWith("gone.db")), false);
  });

  it("uses the recorded path, also outside the session roots", async () => {
    const custom = await makeTranscript("custom", join(root, "custom-sessions"));
    await makeList("custom", custom);
    assert.deepEqual((await collect()).removed, []);
  });

  it("removes a list of a session without a transcript (null)", async () => {
    await makeList("ephemeral", null);
    assert.deepEqual((await collect()).removed, ["ephemeral"]);
  });

  it("searches the session roots for a list without the field", async () => {
    await makeTranscript("legacy-alive");
    await makeTranscript("flat", sessions);
    await makeList("legacy-alive");
    await makeList("flat");
    await makeList("legacy-gone");
    assert.deepEqual((await collect()).removed, ["legacy-gone"]);
    assert.deepEqual(await remaining(), ["flat.db", "legacy-alive.db"]);
  });

  it("treats a missing session root as empty", async () => {
    await makeList("legacy");
    assert.deepEqual((await collect({ sessionRoots: [join(root, "nothing")] })).removed, ["legacy"]);
  });

  it("keeps a list that changed in the grace period", async () => {
    await makeList("young", null);
    const result = await collect({ now: Date.now() + DEFAULT_GC_GRACE_MS / 2 });
    assert.deepEqual(result.removed, []);
    assert.deepEqual(await remaining(), ["young.db"]);
  });

  it("uses the newest file of a list for its age", async () => {
    const file = await makeList("wal", null);
    const old = new Date(Date.now() - 10 * DAY);
    await utimes(file, old, old);
    await writeFile(`${file}-wal`, "");
    assert.deepEqual((await collect({ now: Date.now() + DEFAULT_GC_GRACE_MS / 2 })).removed, []);
  });

  it("does not use the SHM file for the age (a reader can change it)", async () => {
    const file = await makeList("shm", null);
    const old = new Date(Date.now() - 10 * DAY);
    await utimes(file, old, old);
    await writeFile(`${file}-shm`, "");
    assert.deepEqual((await collect({ now: Date.now() + DEFAULT_GC_GRACE_MS / 2 })).removed, ["shm"]);
  });

  it("never removes the list of the current session", async () => {
    await makeList("current", null);
    assert.deepEqual((await collect()).removed, []);
  });

  it("keeps a list for a different session than its file name", async () => {
    const file = taskListFile(tau, "renamed");
    const store = new TaskListStore(file);
    await store.ensure(() => ({ ...seedTaskList("other", NOW), sessionFile: null }));
    store.close();
    assert.deepEqual((await collect()).removed, []);
  });

  it("keeps a list that it cannot read, and counts the error", async () => {
    await mkdir(join(tau, "tasklists"), { recursive: true, mode: 0o700 });
    await writeFile(taskListFile(tau, "broken"), "not a database");
    const result = await collect();
    assert.deepEqual(result, { removed: [], errors: 1 });
    assert.deepEqual(await remaining(), ["broken.db"]);
  });

  it("does not follow a symbolic link", async () => {
    // The target is a list for the session "link": only the link stops the removal.
    const target = join(root, "elsewhere.db");
    const store = new TaskListStore(taskListFile(tau, "link"));
    await store.ensure(() => ({ ...seedTaskList("link", NOW), sessionFile: null }));
    store.close();
    await rename(taskListFile(tau, "link"), target);
    await symlink(target, taskListFile(tau, "link"));
    const result = await collect();
    assert.deepEqual(result.removed, []);
    assert.equal((await lstat(taskListFile(tau, "link"))).isSymbolicLink(), true);
    assert.equal((await lstat(target)).isFile(), true);
  });

  it("keeps a list when the recorded path is gone, but a copy of the transcript is in a session root", async () => {
    await makeTranscript("moved");
    await makeList("moved", join(root, "imported", "2026_moved.jsonl"));
    assert.deepEqual((await collect()).removed, []);
  });

  it("searches sub-directories that are symbolic links", async () => {
    const real = join(root, "real-project");
    await makeTranscript("linked", real);
    await symlink(real, join(sessions, "--linked--"));
    await makeList("linked");
    assert.deepEqual((await collect()).removed, []);
  });

  it("keeps lists when tau cannot follow a symbolic link in a session root", { skip: process.getuid?.() === 0 }, async () => {
    const parent = join(root, "hidden");
    await makeTranscript("behind", join(parent, "project"));
    await symlink(join(parent, "project"), join(sessions, "--behind--"));
    await makeList("behind");
    await chmod(parent, 0o000);
    try {
      assert.deepEqual((await collect()).removed, []);
    } finally {
      await chmod(parent, 0o700);
    }
    assert.deepEqual(await remaining(), ["behind.db"]);
  });

  it("does not count a symbolic link to nothing as a transcript", async () => {
    await symlink(join(root, "nothing.jsonl"), join(sessions, "--cwd--", "2026_dangling.jsonl"));
    await makeList("dangling");
    assert.deepEqual((await collect()).removed, ["dangling"]);
  });

  it("keeps a list when tau cannot check its recorded transcript", { skip: process.getuid?.() === 0 }, async () => {
    const locked = join(root, "locked");
    await mkdir(locked);
    await makeList("locked", join(locked, "2026_locked.jsonl"));
    await chmod(locked, 0o000);
    try {
      const result = await collect({ sessionRoots: [] });
      assert.deepEqual(result, { removed: [], errors: 1 });
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it("keeps lists without a found transcript when a session root cannot be read", { skip: process.getuid?.() === 0 }, async () => {
    await makeList("legacy");
    await makeList("gone", join(root, "gone.jsonl"));
    await chmod(join(sessions, "--cwd--"), 0o000);
    try {
      assert.deepEqual((await collect()).removed, []);
    } finally {
      await chmod(join(sessions, "--cwd--"), 0o700);
    }
  });

  it("does nothing without a task list directory, or without a valid time", async () => {
    assert.deepEqual(await collect(), { removed: [], errors: 0 });
    await makeList("gone", null);
    assert.deepEqual(await collect({ now: Number.NaN }), { removed: [], errors: 0 });
  });
});

describe("sessionFile in the codec", () => {
  it("keeps a path and null, and accepts a list without the field", () => {
    for (const sessionFile of ["/s/a.jsonl", null] as const) {
      const list = { ...seedTaskList("s", NOW), sessionFile };
      assert.equal(decodeTaskList(encodeTaskList(list), "x").sessionFile, sessionFile);
    }
    assert.equal("sessionFile" in decodeTaskList(encodeTaskList(seedTaskList("s", NOW)), "x"), false);
  });

  it("rejects a sessionFile that is not a string or null", () => {
    const text = encodeTaskList({ ...seedTaskList("s", NOW), sessionFile: 3 as unknown as string });
    assert.throws(() => decodeTaskList(text, "x"));
  });
});
