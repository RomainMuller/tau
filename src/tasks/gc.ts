/**
 * The garbage collection of task lists.
 *
 * A task list is for one lead session. When the transcript (the session file)
 * of that session does not exist any more, nobody can resume the session, so
 * nobody can use its task list again. The lead removes these task lists when
 * it starts (see `index.ts`).
 *
 * How tau knows the transcript of a task list:
 *
 * - `sessionFile` is a path: the transcript is this file. When this file
 *   does not exist, tau also searches the session directories (see below):
 *   the session can have a different copy of its transcript (for example, a
 *   session that you resumed from an imported copy).
 * - `sessionFile` is `null`: the session has no transcript (`--no-session`).
 * - `sessionFile` is not set (a list from before this field): tau searches
 *   the session directories for a file with the name `<time>_<id>.jsonl`.
 *
 * tau removes a task list only when all these conditions are true:
 *
 * 1. Its database and WAL files did not change for `graceMs` (the default
 *    is one day). pi makes the session file only after the first answer of
 *    the model, and a different lead can use the list now.
 * 2. tau can read the list, and the list is for the session of its file name.
 * 3. The transcript does not exist. When tau cannot know (for example, a
 *    session directory cannot be read), it keeps the list.
 *
 * Limits:
 *
 * - tau does not lock the list while it checks and removes it. A process
 *   that opens the list in that time (a lead that resumes the session from
 *   a transcript that tau did not find) can lose its changes.
 * - A lead that runs, and did not change its list for `graceMs`, loses its
 *   list when its transcript does not exist (for example `--no-session`).
 * - This is not a security boundary: a program of the same user can change
 *   the recorded path, or the directories.
 */

import { lstat, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { taskListFile } from "./paths.ts";
import { TaskListStore } from "./store.ts";

/** The default minimum age of the files of a task list before tau can remove it: one day. */
export const DEFAULT_GC_GRACE_MS = 24 * 60 * 60 * 1000;

export interface CollectOptions {
  /** The tau directory (see `tauDir`). */
  readonly tauDirectory: string;
  /**
   * The directories to search for the transcript of a list that has no
   * `sessionFile`. tau searches each directory, and its sub-directories (one
   * level).
   */
  readonly sessionRoots: readonly string[];
  /** The session ID of the current lead. tau never removes its list. */
  readonly keep: string;
  /** The current time, in milliseconds since the epoch. */
  readonly now: number;
  /** The minimum age of the files, in milliseconds. */
  readonly graceMs?: number;
}

export interface CollectResult {
  /** The session IDs of the task lists that tau removed. */
  readonly removed: string[];
  /** The number of task lists that tau could not check or remove. They stay. */
  readonly errors: number;
}

const DB_SUFFIX = ".db";

/** Removes the task lists that have no transcript. See the module comment. */
export async function collectOrphanedTaskLists(options: CollectOptions): Promise<CollectResult> {
  const graceMs = options.graceMs ?? DEFAULT_GC_GRACE_MS;
  const directory = join(options.tauDirectory, "tasklists");
  const removed: string[] = [];
  let errors = 0;

  // Without a valid time, tau cannot know the age of a list.
  if (!Number.isFinite(options.now)) return { removed, errors };
  const info = await lstat(directory).catch(() => undefined);
  // tau does not use a task list directory that is a symbolic link.
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) return { removed, errors };

  // The session IDs of the transcripts in the session directories. tau
  // searches only when a list has no `sessionFile`, and one time only.
  let known: Promise<Set<string> | undefined> | undefined;
  const knownIds = () => (known ??= transcriptIds(options.sessionRoots));

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // The reads of SQLite are synchronous: let pi work between two lists.
    await new Promise((resolve) => setImmediate(resolve));
    if (!entry.isFile() || !entry.name.endsWith(DB_SUFFIX)) continue;
    const id = entry.name.slice(0, -DB_SUFFIX.length);
    if (id === options.keep) continue;
    let file: string;
    try {
      file = taskListFile(options.tauDirectory, id);
    } catch {
      continue; // Not a file name of tau.
    }
    try {
      const changed = await lastChange(file);
      if (changed === undefined || options.now - changed < graceMs) continue;
      if (!(await isOrphan(file, id, knownIds))) continue;
      await removeFiles(file);
      removed.push(id);
    } catch {
      errors += 1;
    }
  }
  return { removed, errors };
}

/**
 * The time of the last change of the files of a task list (the database, and
 * its WAL file), in milliseconds. `undefined` when a file is not a regular
 * file.
 *
 * tau does not use the SHM file: it is an index in shared memory, and a
 * reader can change it (for example, the reaper of a different lead, see
 * `reaper.ts`). In WAL mode, a change of the task list changes the database
 * or the WAL file.
 */
async function lastChange(file: string): Promise<number | undefined> {
  let last = 0;
  for (const path of [file, `${file}-wal`]) {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && path !== file) continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) return undefined;
    last = Math.max(last, info.mtimeMs);
  }
  return last;
}

/** True when the transcript of the task list in `file` does not exist. */
async function isOrphan(file: string, id: string, knownIds: () => Promise<Set<string> | undefined>): Promise<boolean> {
  const store = new TaskListStore(file);
  let list;
  try {
    list = await store.read();
  } finally {
    store.close();
  }
  // An empty database, or a list for a different session: keep it.
  if (list === undefined || list.sessionId !== id) return false;
  if (list.sessionFile === null) return true;
  if (list.sessionFile !== undefined && (await exists(list.sessionFile))) return false;
  const ids = await knownIds();
  return ids !== undefined && !ids.has(id);
}

/**
 * True when `path` exists. Throws when tau cannot know (for example, no
 * permission): then the caller keeps the list.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * The session IDs of the transcripts in `roots`, and in their
 * sub-directories (one level). pi names a session file
 * `<time>_<session ID>.jsonl`. `undefined` when tau cannot read a directory
 * that exists: then tau does not know all transcripts.
 */
async function transcriptIds(roots: readonly string[]): Promise<Set<string> | undefined> {
  const ids = new Set<string>();
  const scan = async (directory: string, depth: number): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        // pi can use a symbolic link to a directory or to a file: follow it.
        // A link to nothing is not a transcript. When tau cannot know, it
        // does not know all transcripts.
        try {
          const target = await stat(path);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") continue;
          return false;
        }
      }
      if (isDirectory) {
        if (depth > 0 && !(await scan(path, depth - 1))) return false;
        continue;
      }
      const id = isFile ? transcriptId(entry.name) : undefined;
      if (id !== undefined) ids.add(id);
    }
    return true;
  };
  for (const root of new Set(roots)) {
    if (!(await scan(root, 1))) return undefined;
  }
  return ids;
}

/** The session ID in the name of a session file, or `undefined`. */
function transcriptId(name: string): string | undefined {
  if (!name.endsWith(".jsonl")) return undefined;
  const separator = name.indexOf("_");
  if (separator === -1) return undefined;
  const id = name.slice(separator + 1, -".jsonl".length);
  return id === "" ? undefined : id;
}

/** Removes the database file, then its WAL and SHM files. */
async function removeFiles(file: string): Promise<void> {
  for (const path of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
