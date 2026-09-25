/**
 * The storage of a task list, in an SQLite database file.
 *
 * More than one pi process (the lead and its sub-agents) can change the same
 * task list. SQLite serializes the changes: each change is one
 * `BEGIN IMMEDIATE` transaction, and only one process at a time can have
 * such a transaction on a database. The lock is an operating system lock, so
 * it ends automatically when its process stops. There are no stale locks.
 *
 * The database has a table with one row, which contains the task list as
 * JSON text (see `codec.ts`), and a table of messages between agents (see
 * `messages.ts`).
 *
 * tau uses the built-in `node:sqlite` module, so it needs no dependency. Its
 * calls are synchronous. To not block the event loop while a different
 * process has the lock, tau does not use the SQLite busy timeout: when the
 * database is busy, it waits with a timer and tries again.
 */

import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { decodeTaskList, encodeTaskList } from "./codec.ts";
import { TauError } from "./errors.ts";
import type { TaskList } from "./model.ts";

export interface StoreOptions {
  /** The maximum time to wait while a different process has the lock, in milliseconds. */
  readonly lockTimeoutMs?: number;
}

export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
/** The maximum size of the task list JSON text, in bytes. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

/** The SQLite result code for "the database is locked by a different connection". */
const SQLITE_BUSY = 5;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasklist (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    sender_task TEXT,
    recipient TEXT NOT NULL,
    priority TEXT NOT NULL CHECK (priority IN ('steer', 'info')),
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    read_at TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS messages_unread ON messages (recipient, read_at);
`;

/** A message from one agent to a different agent. See `messages.ts`. */
export interface StoredMessage {
  readonly id: number;
  readonly sender: string;
  /** The active task of the sender when it sent the message. */
  readonly senderTask?: string;
  readonly recipient: string;
  readonly priority: "steer" | "info";
  readonly text: string;
  readonly sentAt: string;
}

/** The maximum number of messages that an agent did not read. */
export const MAX_UNREAD_MESSAGES = 100;
/** The maximum number of read messages in a task list. tau removes the oldest read messages. */
export const MAX_MESSAGES = 2_000;
/** The maximum number of characters of messages in one delivery. The rest waits for the next delivery. */
export const MAX_DELIVERY_CHARS = 40_000;

export class TaskListStore {
  readonly file: string;
  readonly #lockTimeoutMs: number;
  /** Operations of this process run one at a time. */
  #queue: Promise<unknown> = Promise.resolve();
  /**
   * A connection that stays open for reads, and the last list that it read.
   * SQLite increments `PRAGMA data_version` of a connection when a different
   * connection (in this process or in a different process) commits a change.
   * When the version did not change, `read` returns the cached list, and
   * does not decode the data again. The work gate reads the list before each
   * tool call, so this keeps that cheap.
   */
  #reader: DatabaseSync | undefined;
  /** The device and inode of the file that `#reader` opened. */
  #readerFile: { dev: number; ino: number } | undefined;
  #cache: { version: number; list: TaskList } | undefined;
  /** The unread message counts that `#reader` read last. */
  #counts: { version: number; counts: Map<string, number> } | undefined;

  constructor(file: string, options: StoreOptions = {}) {
    this.file = file;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  /** Reads the task list. Returns `undefined` when there is no task list. */
  async read(): Promise<TaskList | undefined> {
    return this.#enqueue(async () => {
      const reader = await this.#openReader();
      if (reader === undefined) return undefined;
      let version: number;
      let list: TaskList | undefined;
      try {
        version = Number((reader.prepare("PRAGMA data_version").get() as { data_version: number }).data_version);
        if (this.#cache?.version === version) {
          return structuredClone(this.#cache.list);
        }
        const table = reader.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'tasklist'").get();
        list = table === undefined ? undefined : readList(reader, this.file);
      } catch (error) {
        this.close();
        throw storageError(`cannot read ${this.file}`, error);
      }
      this.#cache = list === undefined ? undefined : { version, list: structuredClone(list) };
      return list;
    });
  }

  /** Closes the read connection. The next `read` opens it again. */
  close(): void {
    this.#cache = undefined;
    this.#counts = undefined;
    try {
      this.#reader?.close();
    } catch {
      // It is closed already.
    }
    this.#reader = undefined;
    this.#readerFile = undefined;
  }

  /**
   * Opens the read connection if it is not open. Checks the directory and
   * the files first. Returns `undefined` when the database does not exist.
   */
  async #openReader(): Promise<DatabaseSync | undefined> {
    if (this.#reader !== undefined) {
      // A different program can replace or remove the file. Then the open
      // connection reads the old file: open the new file.
      const now = await lstat(this.file).catch(() => undefined);
      if (now !== undefined && now.dev === this.#readerFile?.dev && now.ino === this.#readerFile.ino) {
        return this.#reader;
      }
      this.close();
    }
    if (!(await checkDirectory(dirname(this.file)))) return undefined;
    if (!(await this.#exists())) return undefined;
    await secureFiles(this.file);
    // Keep the identity of the file from before the open. If a different
    // program replaces the file after this lstat, the identity does not
    // agree with the file at the next read, and that read opens it again.
    const info = await lstat(this.file).catch(() => undefined);
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(this.file);
      db.exec("PRAGMA busy_timeout = 0");
      const opened = db;
      await this.#retryBusy(() => opened.exec("PRAGMA journal_mode = WAL"));
    } catch (error) {
      db?.close();
      throw storageError(`cannot open ${this.file}`, error);
    }
    this.#reader = db;
    this.#readerFile = info === undefined ? undefined : { dev: info.dev, ino: info.ino };
    return db;
  }

  /**
   * Reads the task list. When there is no task list, writes the list that
   * `seed` makes, and returns it.
   */
  async ensure(seed: () => TaskList): Promise<TaskList> {
    const existing = await this.read();
    if (existing !== undefined) return existing;
    const { list } = await this.update((current) => ({ list: current ?? seed(), result: undefined }));
    return list;
  }

  /**
   * Changes the task list in one transaction. `change` receives the current
   * list (a new object, so it can change it). If `change` throws, nothing
   * changes.
   *
   * When there is no task list, `change` receives `undefined` and must return
   * the new list.
   */
  async update<T>(
    change: (list: TaskList | undefined) => { list: TaskList; result: T },
  ): Promise<{ list: TaskList; result: T }> {
    return this.#enqueue(async () => {
      await this.#prepare();
      return this.#withDatabase(async (db) => {
        await this.#begin(db);
        try {
          const current = readList(db, this.file);
          const { list, result } = change(current);
          const text = encodeTaskList(list);
          if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
            throw new TauError("storage", `The task list is too large to save (more than ${MAX_FILE_BYTES} bytes).`);
          }
          db.prepare("INSERT INTO tasklist (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json").run(text);
          db.exec("COMMIT");
          return { list, result };
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw storageError(`cannot change ${this.file}`, error);
        }
      });
    });
  }

  /** Changes an existing task list in one transaction. See `update`. */
  async mutate<T>(change: (list: TaskList) => T): Promise<{ list: TaskList; result: T }> {
    return this.update((list) => {
      if (list === undefined) {
        throw new TauError("storage", `The task list ${this.file} does not exist.`);
      }
      return { list, result: change(list) };
    });
  }

  /**
   * Sends a message in one transaction. `check` receives the current task
   * list, and throws when the sender cannot send this message (for example,
   * the recipient is not in its part of the agent tree). It returns the task
   * of the sender, which the message records. Fails when the recipient has
   * `MAX_UNREAD_MESSAGES` messages that it did not read.
   */
  async sendMessage(
    input: Omit<StoredMessage, "id" | "senderTask">,
    check: (list: TaskList) => { readonly senderTask?: string | undefined },
  ): Promise<StoredMessage> {
    return this.#enqueue(async () => {
      await this.#prepare();
      return this.#withDatabase(async (db) => {
        await this.#begin(db);
        try {
          const list = readList(db, this.file);
          if (list === undefined) {
            throw new TauError("storage", `The task list ${this.file} does not exist.`);
          }
          const { senderTask } = check(list);
          const message: Omit<StoredMessage, "id"> = { ...input, ...(senderTask === undefined ? {} : { senderTask }) };
          const unread = db
            .prepare("SELECT count(*) AS n FROM messages WHERE recipient = ? AND read_at IS NULL")
            .get(message.recipient) as { n: number };
          if (Number(unread.n) >= MAX_UNREAD_MESSAGES) {
            throw new TauError(
              "busy",
              `@${message.recipient} has ${MAX_UNREAD_MESSAGES} messages that it did not read. Wait, then send again.`,
            );
          }
          const result = db
            .prepare(
              "INSERT INTO messages (sender, sender_task, recipient, priority, text, sent_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(message.sender, message.senderTask ?? null, message.recipient, message.priority, message.text, message.sentAt);
          // Messages to agents that ended cannot be read: remove them.
          const ended = list.agents.filter((agent) => agent.state === "ended").map((agent) => agent.name);
          if (ended.length > 0) {
            db.prepare("DELETE FROM messages WHERE read_at IS NULL AND recipient IN (SELECT value FROM json_each(?))").run(
              JSON.stringify(ended),
            );
          }
          // Keep the table small: remove the oldest messages that were read.
          // Keep the messages that were read in the last minute: a delivery
          // can still give them back (see `untakeMessages`).
          const sent = Date.parse(message.sentAt);
          const cutoff = Number.isNaN(sent) ? message.sentAt : new Date(sent - 60_000).toISOString();
          db.prepare(
            `DELETE FROM messages WHERE read_at IS NOT NULL AND read_at < ? AND id IN (
               SELECT id FROM messages WHERE read_at IS NOT NULL ORDER BY id DESC LIMIT -1 OFFSET ?
             )`,
          ).run(cutoff, MAX_MESSAGES);
          db.exec("COMMIT");
          return { ...message, id: Number(result.lastInsertRowid) };
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw storageError(`cannot send a message in ${this.file}`, error);
        }
      });
    });
  }

  /**
   * Takes the messages of `recipient` that it did not read, oldest first,
   * and marks them as read, in one transaction. So each message is taken
   * one time only. With `priority`, takes only the messages of that
   * priority. Takes at most `MAX_DELIVERY_CHARS` characters (as `measure`
   * counts them; but always the first message): the rest waits for the next
   * call.
   */
  async takeMessages(
    recipient: string,
    now: string,
    priority?: "steer" | "info",
    measure: (message: StoredMessage) => number = (message) => message.text.length,
  ): Promise<StoredMessage[]> {
    // Most calls find no message: check with the read connection first.
    if ((await this.unreadCounts()).get(recipient) === undefined) return [];
    return this.#enqueue(async () => {
      await this.#prepare();
      return this.#withDatabase(async (db) => {
        await this.#begin(db);
        try {
          const unread = db
            .prepare(
              `SELECT id, sender, sender_task, recipient, priority, text, sent_at FROM messages
               WHERE recipient = ? AND read_at IS NULL AND (? IS NULL OR priority = ?) ORDER BY id`,
            )
            .all(recipient, priority ?? null, priority ?? null) as Array<Record<string, unknown>>;
          const taken: StoredMessage[] = [];
          let chars = 0;
          for (const row of unread) {
            const message = toMessage(row);
            // Count the text as the model gets it (with the header and the
            // quote marks), not the stored text.
            const size = measure(message);
            if (taken.length > 0 && chars + size > MAX_DELIVERY_CHARS) break;
            taken.push(message);
            chars += size;
          }
          const mark = db.prepare("UPDATE messages SET read_at = ? WHERE id = ?");
          for (const message of taken) mark.run(now, message.id);
          db.exec("COMMIT");
          return taken;
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw storageError(`cannot read the messages in ${this.file}`, error);
        }
      });
    });
  }

  /**
   * Marks messages as not read again: tau took them, but could not give them
   * to the model. The next delivery gives them.
   */
  async untakeMessages(ids: readonly number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.#enqueue(async () => {
      await this.#prepare();
      await this.#withDatabase(async (db) => {
        await this.#begin(db);
        try {
          db.prepare("UPDATE messages SET read_at = NULL WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(ids));
          db.exec("COMMIT");
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw storageError(`cannot change the messages in ${this.file}`, error);
        }
      });
    });
  }

  /** The number of messages that each agent did not read. Agents with none are not in the map. */
  async unreadCounts(): Promise<Map<string, number>> {
    return this.#enqueue(async () => {
      const reader = await this.#openReader();
      if (reader === undefined) return new Map();
      try {
        const version = Number((reader.prepare("PRAGMA data_version").get() as { data_version: number }).data_version);
        if (this.#counts?.version === version) return new Map(this.#counts.counts);
        const table = reader.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'messages'").get();
        const counts = new Map<string, number>();
        if (table !== undefined) {
          const rows = reader
            .prepare("SELECT recipient, count(*) AS n FROM messages WHERE read_at IS NULL GROUP BY recipient")
            .all() as Array<{ recipient: string; n: number }>;
          for (const row of rows) counts.set(String(row.recipient), Number(row.n));
        }
        this.#counts = { version, counts };
        return new Map(counts);
      } catch (error) {
        this.close();
        throw storageError(`cannot read the messages in ${this.file}`, error);
      }
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Starts a write transaction. Waits while a different process has one. */
  async #begin(db: DatabaseSync): Promise<void> {
    const deadline = Date.now() + this.#lockTimeoutMs;
    for (let attempt = 0; ; attempt++) {
      try {
        db.exec("BEGIN IMMEDIATE");
        return;
      } catch (error) {
        if (!isBusy(error)) throw storageError(`cannot start a change of ${this.file}`, error);
      }
      if (Date.now() >= deadline) {
        throw new TauError("storage", `A different process changes the task list ${this.file} now. Try again later.`);
      }
      await sleep(Math.min(5 * 2 ** attempt, 100));
    }
  }

  /** True when the database file exists. Rejects files that are not safe. */
  async #exists(): Promise<boolean> {
    let info;
    try {
      info = await lstat(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw storageError(`cannot read ${this.file}`, error);
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new TauError("storage", `The task list ${this.file} is not a regular file. tau does not use it.`);
    }
    return true;
  }

  /** Makes the directory and the database file, only for the current user. */
  async #prepare(): Promise<void> {
    await prepareDirectory(dirname(this.file));
    if (await this.#exists()) {
      await secureFiles(this.file);
      return;
    }
    try {
      // Make the file before SQLite does, so that it has mode 0600. SQLite
      // gives its WAL and SHM files the same mode.
      const handle = await open(this.file, "wx", 0o600);
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw storageError(`cannot create ${this.file}`, error);
      }
      await this.#exists();
    }
  }

  async #withDatabase<T>(operation: (db: DatabaseSync) => Promise<T> | T): Promise<T> {
    let db: DatabaseSync | undefined;
    try {
      try {
        db = new DatabaseSync(this.file);
        const opened = db;
        opened.exec("PRAGMA busy_timeout = 0");
        await this.#retryBusy(() => opened.exec("PRAGMA journal_mode = WAL"));
        opened.exec("PRAGMA synchronous = FULL");
        await this.#retryBusy(() => opened.exec(SCHEMA));
      } catch (error) {
        throw storageError(`cannot open ${this.file}`, error);
      }
      return await operation(db);
    } finally {
      db?.close();
    }
  }

  async #retryBusy(operation: () => void): Promise<void> {
    const deadline = Date.now() + this.#lockTimeoutMs;
    for (let attempt = 0; ; attempt++) {
      try {
        operation();
        return;
      } catch (error) {
        if (!isBusy(error) || Date.now() >= deadline) throw error;
      }
      await sleep(Math.min(5 * 2 ** attempt, 100));
    }
  }
}

function toMessage(row: Record<string, unknown>): StoredMessage {
  const senderTask = row.sender_task;
  return {
    id: Number(row.id),
    sender: String(row.sender),
    ...(typeof senderTask === "string" ? { senderTask } : {}),
    recipient: String(row.recipient),
    priority: row.priority === "steer" ? "steer" : "info",
    text: String(row.text),
    sentAt: String(row.sent_at),
  };
}

function readList(db: DatabaseSync, file: string): TaskList | undefined {
  // One statement, so that the size and the text come from the same data.
  // SQLite does not return the text when it is too large.
  const row = db
    .prepare(
      "SELECT length(CAST(json AS BLOB)) AS size, CASE WHEN length(CAST(json AS BLOB)) <= ? THEN json END AS json FROM tasklist WHERE id = 1",
    )
    .get(MAX_FILE_BYTES) as { size: unknown; json: unknown } | undefined;
  if (row === undefined) return undefined;
  if (typeof row.size === "number" && row.size > MAX_FILE_BYTES) {
    throw new TauError(
      "storage",
      `The task list ${file} has ${row.size} bytes. The maximum is ${MAX_FILE_BYTES}. tau does not use it.`,
    );
  }
  if (typeof row.json !== "string") {
    throw new TauError("storage", `The task list ${file} is not valid. tau does not change it.`);
  }
  return decodeTaskList(row.json, file);
}

/**
 * Checks a directory that must exist already. Returns false when it does not
 * exist. See `prepareDirectory` for the checks.
 */
async function checkDirectory(directory: string): Promise<boolean> {
  try {
    await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw storageError(`cannot read the directory ${directory}`, error);
  }
  await prepareDirectory(directory);
  return true;
}

/**
 * Removes access for other users from the database file and its WAL and
 * SHM files, if they have it. An older version, or a different program, can
 * have made them.
 */
async function secureFiles(file: string): Promise<void> {
  for (const path of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new TauError("storage", `${path} is not a regular file. tau does not use it.`);
      }
      if ((info.mode & 0o077) !== 0) {
        await chmod(path, 0o600);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw storageError(`cannot check ${path}`, error);
    }
  }
}

/**
 * Makes the directory if it does not exist, and makes sure that only the
 * current user can use it: it must be a real directory (not a symbolic
 * link), and the current user must own it. tau removes access for other
 * users if the directory has it.
 */
async function prepareDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TauError("storage", `${directory} is not a directory. tau does not use it.`);
    }
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) {
      throw new TauError("storage", `${directory} belongs to a different user. tau does not use it.`);
    }
    if ((info.mode & 0o077) !== 0) {
      await chmod(directory, 0o700);
    }
  } catch (error) {
    throw storageError(`cannot prepare the directory ${directory}`, error);
  }
}

function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | undefined)?.errcode;
  // The primary result code is in the low 8 bits (for example SQLITE_BUSY_SNAPSHOT).
  return typeof code === "number" && (code & 0xff) === SQLITE_BUSY;
}

function storageError(message: string, error: unknown): TauError {
  if (error instanceof TauError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new TauError("storage", `The task list storage failed: ${message} (${detail}).`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
