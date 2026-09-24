import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { decodeTaskList, encodeTaskList } from "./codec.ts";
import { TauError } from "./errors.ts";
import { seedTaskList } from "./model.ts";
import { taskListFile, tauDir } from "./paths.ts";
import { createTask } from "./rules.ts";
import { MAX_FILE_BYTES, TaskListStore } from "./store.ts";
import { DatabaseSync } from "node:sqlite";

const NOW = "2026-01-01T00:00:00.000Z";
const LEAD = { actor: { name: "lead" }, now: NOW };

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tau-store-"));
  file = join(dir, "tasklists", "s1.db");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("paths", () => {
  it("puts the tau directory next to the agent directory", () => {
    assert.equal(tauDir("/home/u/.pi/agent"), "/home/u/.pi/tau");
    assert.equal(taskListFile("/home/u/.pi/tau", "abc_1-2.x"), "/home/u/.pi/tau/tasklists/abc_1-2.x.db");
  });

  for (const id of ["", "../x", "a/b", "a\\b", ".hidden", "a..b", "x".repeat(129)]) {
    it(`rejects the session ID ${JSON.stringify(id)}`, () => {
      assert.throws(() => taskListFile("/t", id), TauError);
    });
  }
});

describe("TaskListStore", () => {
  it("returns undefined when the file does not exist", async () => {
    assert.equal(await new TaskListStore(file).read(), undefined);
  });

  it("makes the file with the seed, and does not seed again", async () => {
    const store = new TaskListStore(file);
    const first = await store.ensure(() => seedTaskList("s1", NOW));
    const second = await store.ensure(() => assert.fail("must not seed again"));
    assert.deepEqual(second, first);
    assert.deepEqual(await store.read(), first);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  });

  it("writes a change and returns the result", async () => {
    const store = new TaskListStore(file);
    await store.ensure(() => seedTaskList("s1", NOW));
    const { result } = await store.mutate((list) => createTask(list, LEAD, { title: "T1", type: "code" }).id);
    assert.equal(result, "T1");
    assert.deepEqual((await store.read())?.tasks.map((task) => task.id), ["T0", "T1"]);
  });

  it("does not change the list it gave to a failed change", async () => {
    const store = new TaskListStore(file);
    await store.ensure(() => seedTaskList("s1", NOW));
    await assert.rejects(
      store.mutate((list) => {
        list.tasks.length = 0;
        throw new Error("stop");
      }),
    );
    assert.equal((await store.read())?.tasks.length, 1);
  });

  it("fails mutate when the file does not exist", async () => {
    await assert.rejects(new TaskListStore(file).mutate(() => undefined), { code: "storage" });
  });

  it("runs many changes of one process without loss", async () => {
    const store = new TaskListStore(file);
    await store.ensure(() => seedTaskList("s1", NOW));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.mutate((list) => createTask(list, LEAD, { title: `Task ${i}`, type: "code" })),
      ),
    );
    assert.equal((await store.read())?.tasks.length, 21);
  });

  it("runs changes of many stores (like many processes) without loss", async () => {
    await new TaskListStore(file).ensure(() => seedTaskList("s1", NOW));
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        new TaskListStore(file).mutate((list) => createTask(list, LEAD, { title: `Task ${i}`, type: "code" })),
      ),
    );
    const list = await new TaskListStore(file).read();
    assert.equal(list?.tasks.length, 11);
    assert.equal(new Set(list?.tasks.map((task) => task.id)).size, 11);
  });

  it("runs changes of many real processes without loss", async () => {
    await new TaskListStore(file).ensure(() => seedTaskList("s1", NOW));
    const script = `
      import { TaskListStore } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
      import { createTask } from ${JSON.stringify(new URL("./rules.ts", import.meta.url).href)};
      const store = new TaskListStore(process.argv[1]);
      for (let i = 0; i < 5; i++) {
        await store.mutate((list) => createTask(list, { actor: { name: "p" }, now: "${NOW}" }, { title: "x", type: "code" }));
      }
    `;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, ["--input-type=module", "-e", script, file], { stdio: "inherit" });
          child.on("error", reject);
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        }),
      ),
    );
    assert.equal((await new TaskListStore(file).read())?.tasks.length, 21);
  });
});

describe("TaskListStore safety", () => {
  it("seeds only one time when many stores ensure at the same time", async () => {
    let seeds = 0;
    const lists = await Promise.all(
      Array.from({ length: 5 }, () =>
        new TaskListStore(file).ensure(() => {
          seeds += 1;
          return seedTaskList("s1", NOW);
        }),
      ),
    );
    assert.equal(seeds, 1);
    for (const list of lists) assert.deepEqual(list, lists[0]);
  });

  it("does not use a task list file that is a symbolic link", async () => {
    await mkdir(join(dir, "tasklists"), { recursive: true });
    const target = join(dir, "elsewhere.json");
    await writeFile(target, encodeTaskList(seedTaskList("s1", NOW)));
    await symlink(target, file);
    await assert.rejects(new TaskListStore(file).read(), /not a regular file/);
  });

  it("does not use a directory that is a symbolic link", async () => {
    const real = join(dir, "real");
    await mkdir(real);
    await symlink(real, join(dir, "tasklists"));
    await assert.rejects(new TaskListStore(file).ensure(() => seedTaskList("s1", NOW)), /not a directory/);
  });

  it("removes access for other users from the directory", async () => {
    await mkdir(join(dir, "tasklists"), { mode: 0o755 });
    await chmod(join(dir, "tasklists"), 0o755);
    await new TaskListStore(file).ensure(() => seedTaskList("s1", NOW));
    assert.equal((await stat(join(dir, "tasklists"))).mode & 0o777, 0o700);
  });
});

describe("TaskListStore transactions", () => {
  it("does not write when the change throws", async () => {
    const store = new TaskListStore(file);
    await store.ensure(() => seedTaskList("s1", NOW));
    const before = await store.read();
    await assert.rejects(
      store.mutate((list) => createTask(list, LEAD, { title: "", type: "code" })),
      TauError,
    );
    assert.deepEqual(await store.read(), before);
  });

  it("waits while a different connection has a transaction, then fails with a clear error", async () => {
    const store = new TaskListStore(file, { lockTimeoutMs: 150 });
    await store.ensure(() => seedTaskList("s1", NOW));
    const other = new DatabaseSync(file);
    other.exec("BEGIN IMMEDIATE");
    try {
      const started = Date.now();
      await assert.rejects(store.mutate(() => undefined), /A different process changes the task list/);
      assert.ok(Date.now() - started >= 140);
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
    await store.mutate(() => undefined);
  });

  it("does not block the event loop while it waits", async () => {
    const store = new TaskListStore(file, { lockTimeoutMs: 300 });
    await store.ensure(() => seedTaskList("s1", NOW));
    const other = new DatabaseSync(file);
    other.exec("BEGIN IMMEDIATE");
    let ranWhileWaiting = false;
    try {
      let settled = false;
      const waiting = store.mutate(() => undefined).finally(() => (settled = true));
      // This timer runs while the store still waits only if the store does
      // not block the event loop.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      ranWhileWaiting = !settled;
      await assert.rejects(waiting);
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
    assert.equal(ranWhileWaiting, true);
  });

  it("continues when a process stops in the middle of a transaction", async () => {
    await new TaskListStore(file).ensure(() => seedTaskList("s1", NOW));
    const script = `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(process.argv[1]);
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE tasklist SET json = 'broken' WHERE id = 1").run();
      process.kill(process.pid, "SIGKILL");
    `;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, file], { stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (_code, signal) => (signal === "SIGKILL" ? resolve() : reject(new Error(`exit ${signal}`))));
    });
    const store = new TaskListStore(file, { lockTimeoutMs: 1_000 });
    await store.mutate((list) => createTask(list, LEAD, { title: "T1", type: "code" }));
    assert.equal((await store.read())?.tasks.length, 2);
  });

  it("makes the database, WAL, and SHM files only for the current user", async () => {
    const store = new TaskListStore(file);
    await store.ensure(() => seedTaskList("s1", NOW));
    // Keep a connection open, so that SQLite keeps its WAL and SHM files.
    const open = new DatabaseSync(file);
    open.exec("BEGIN IMMEDIATE");
    open.prepare("UPDATE tasklist SET json = json WHERE id = 1").run();
    try {
      const names = await readdir(join(dir, "tasklists"));
      assert.ok(names.includes("s1.db-wal"), names.join(", "));
      assert.ok(names.includes("s1.db-shm"), names.join(", "));
      for (const name of names) {
        assert.equal((await stat(join(dir, "tasklists", name))).mode & 0o077, 0, name);
      }
    } finally {
      open.exec("ROLLBACK");
      open.close();
    }
  });

  it("removes access for other users from an existing database", async () => {
    const store = new TaskListStore(file);
    await store.ensure(() => seedTaskList("s1", NOW));
    await chmod(file, 0o644);
    await chmod(join(dir, "tasklists"), 0o755);
    assert.equal((await store.ensure(() => assert.fail("no seed"))).tasks.length, 1);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "tasklists"))).mode & 0o777, 0o700);
  });

  it("does not read a database in a directory that is a symbolic link", async () => {
    const real = join(dir, "real");
    await new TaskListStore(join(real, "s1.db")).ensure(() => seedTaskList("s1", NOW));
    await symlink(real, join(dir, "tasklists"));
    await assert.rejects(new TaskListStore(file).read(), /not a directory/);
  });

  it("closes the database when the setup fails", async () => {
    await mkdir(join(dir, "tasklists"), { recursive: true });
    await writeFile(file, "{ not a database");
    // With a leak, the number of open file descriptors grows.
    const openFiles = async () => (await readdir("/dev/fd")).length;
    await assert.rejects(new TaskListStore(file).read(), /not a database/);
    const before = await openFiles();
    for (let i = 0; i < 50; i++) {
      await assert.rejects(new TaskListStore(file).read(), /not a database/);
    }
    assert.ok((await openFiles()) - before < 5, "file descriptors leaked");
    await rm(file);
    await new TaskListStore(file).ensure(() => seedTaskList("s1", NOW));
  });

  it("seeds only one time when many processes ensure at the same time", async () => {
    const script = `
      import { TaskListStore } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
      import { seedTaskList } from ${JSON.stringify(new URL("./model.ts", import.meta.url).href)};
      const list = await new TaskListStore(process.argv[1]).ensure(() => seedTaskList("s1", process.argv[2]));
      console.log(list.createdAt);
    `;
    const outputs = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        new Promise<string>((resolve, reject) => {
          const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
          const child = spawn(process.execPath, ["--input-type=module", "-e", script, file, at]);
          let out = "";
          child.stdout.on("data", (chunk) => (out += chunk));
          child.on("error", reject);
          child.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`))));
        }),
      ),
    );
    // All processes see the same list: the seed of the first process.
    assert.equal(new Set(outputs).size, 1);
    assert.equal((await new TaskListStore(file).read())?.createdAt, outputs[0]);
  });

  it("does not use a file that is not a database, and does not change it", async () => {
    await mkdir(join(dir, "tasklists"), { recursive: true });
    await writeFile(file, "{ not a database");
    await assert.rejects(new TaskListStore(file).ensure(() => seedTaskList("s1", NOW)), /not a database/);
    assert.equal(await readFile(file, "utf8"), "{ not a database");
  });

  it("does not overwrite a task list that is not valid", async () => {
    const store = new TaskListStore(file);
    await store.ensure(() => seedTaskList("s1", NOW));
    const db = new DatabaseSync(file);
    db.prepare("UPDATE tasklist SET json = '{ not json' WHERE id = 1").run();
    db.close();
    await assert.rejects(store.ensure(() => seedTaskList("s1", NOW)), /not valid JSON/);
    await assert.rejects(store.mutate(() => undefined), { code: "storage" });
    const check = new DatabaseSync(file);
    assert.deepEqual({ ...(check.prepare("SELECT json FROM tasklist").get() as object) }, { json: "{ not json" });
    check.close();
  });

  it("does not read a task list that is too large", async () => {
    const store = new TaskListStore(file);
    await store.ensure(() => seedTaskList("s1", NOW));
    const db = new DatabaseSync(file);
    db.prepare("UPDATE tasklist SET json = ? WHERE id = 1").run(" ".repeat(MAX_FILE_BYTES + 1));
    db.close();
    await assert.rejects(store.read(), /maximum/);
  });
});

describe("codec", () => {
  it("reads what it writes", () => {
    const list = seedTaskList("s1", NOW);
    createTask(list, LEAD, { title: "T1", type: "code", description: "d", dependencies: ["T0"] });
    assert.deepEqual(decodeTaskList(encodeTaskList(list), "f"), list);
  });

  const bad: Array<[string, (list: Record<string, any>) => void, RegExp]> = [
    ["a wrong version", (l) => (l.version = 2), /version/],
    ["a bad task ID", (l) => (l.tasks[0].id = "../x"), /not a task ID/],
    ["a duplicate task ID", (l) => l.tasks.push(structuredClone(l.tasks[0])), /two times/],
    ["a bad status", (l) => (l.tasks[0].status = "done"), /status/],
    ["a bad event kind", (l) => (l.tasks[0].history[0].kind = "deleted"), /event kind/],
    ["a title that is not a string", (l) => (l.tasks[0].title = 3), /title/],
    ["tasks that are not an array", (l) => (l.tasks = {}), /tasks/],
    ["a task in progress with no owner", (l) => (l.tasks[0].status = "in_progress"), /result of their history/],
    ["a dependency that does not exist", (l) => (l.tasks[0].dependencies = ["T9"]), /T9/],
    ["a sub-task without its parent", (l) => (l.tasks[0].id = "T4.1"), /parent T4/],
    ["an event revision after the list revision", (l) => (l.revision = 0), /revision/],
    ["a missing revision", (l) => delete l.tasks[0].history[0].seq, /seq/],
    ["a history without a created event", (l) => (l.tasks[0].history[0].kind = "claimed"), /created/],
    ["a revision that is too high", (l) => (l.revision = Number.MAX_SAFE_INTEGER), /revision/],
    ["a gap in the revisions", (l) => ((l.tasks[0].history[0].seq = 2), (l.revision = 2)), /2 .*1 events|events/],
    [
      "too many tasks",
      (l) => {
        for (let i = 1; i <= 500; i++) l.tasks.push({ ...structuredClone(l.tasks[0]), id: `T${i}` });
      },
      /maximum/,
    ],
    [
      "too many notes",
      (l) => (l.tasks[0].notes = Array.from({ length: 101 }, () => ({ author: "a", at: NOW, text: "x" }))),
      /maximum/,
    ],
  ];
  for (const [name, change, message] of bad) {
    it(`rejects ${name}`, () => {
      const value = JSON.parse(encodeTaskList(seedTaskList("s1", NOW)));
      change(value);
      assert.throws(() => decodeTaskList(JSON.stringify(value), "f"), message);
    });
  }
});

