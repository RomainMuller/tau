/**
 * The orphan reaper: a lead ends the sub-agents of a different lead that
 * stopped.
 *
 * Only the parent process watches its sub-agents (`supervisor.ts`). When the
 * pi process of a lead stops, nobody watches its sub-agents. So each lead
 * (with herdr) also checks the task lists of the other sessions, about every
 * minute:
 *
 * 1. It lists the files in `tasklists/`, and skips its own list. It skips a
 *    list that has no WAL and SHM files: no process has the list open
 *    (SQLite removes these files when the last connection closes), so no
 *    sub-agent of it runs.
 * 2. It reads only the lead process and the number of live agent records,
 *    with one read-only SQL statement (`peekLiveness`). It keeps the result
 *    while the database and WAL files do not change. It does not keep a
 *    failed read: it reads the file again at the next sweep.
 * 3. It checks the process record of the lead (`process-info.ts`). When the
 *    lead is `dead` in the checks for `ORPHAN_GRACE_MS` or more, the list is
 *    an orphan list.
 * 4. In one transaction, it checks that the lead process did not change
 *    (the lead did not start again), then ends the sub-agents of the list,
 *    deepest first: their `in_progress` tasks fail (`owner agent exited`,
 *    retryable), and their records end. The actor is `tau`. It ends only
 *    the agents whose pane close it can keep in its queue
 *    (`MAX_CLOSE_QUEUE`). The other agents stay live, and a later sweep
 *    ends them.
 * 5. It closes the pane of each agent that its own transaction ended, only
 *    when herdr shows that agent (name and pi session) in the pane (see
 *    `pane-closer.ts`). It did not make the panes, so it never closes an
 *    empty pane.
 *
 * `unknown` is always "alive": a list with no process record (from an older
 * tau), a record of a different machine, or a record with no start time is
 * never changed while its PID exists.
 *
 * A dead sub-agent always has a parent. When a parent is alive, its
 * supervisor ends the tree of its dead child. The reaper acts only when the
 * lead is dead: then nobody watches the tree, and the reaper ends it all.
 */

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { HerdrAgent, HerdrClient } from "./herdr-client.ts";
import { PaneCloser } from "./pane-closer.ts";
import { ORPHAN_GRACE_MS, type ProcessProbe } from "./process-info.ts";
import { OWNER_EXITED } from "./supervisor.ts";
import { SYSTEM_ACTOR, type AgentRecord, type ProcessRecord, type TaskList } from "./tasks/model.ts";
import { taskListFile } from "./tasks/paths.ts";
import { endAgentTree } from "./tasks/rules.ts";
import { noWrite, peekLiveness, TaskListStore, type Liveness } from "./tasks/store.ts";

/** The average time between two sweeps, in milliseconds. Each sweep adds ± 25 %. */
export const REAP_MS = 60_000;
/** The minimum time before the first sweep, in milliseconds. A random time of 0 to the same time is added. */
export const FIRST_REAP_MS = 15_000;
/** The maximum number of files that a sweep opens to peek. The others wait for the next sweep. */
export const MAX_PEEKS_PER_SWEEP = 25;
/** The maximum number of orphan lists that a sweep changes. */
export const MAX_REAPS_PER_SWEEP = 5;
/**
 * The maximum number of orphan lists that a sweep opens to end agents, also
 * when the transaction changes nothing (for example, the close queue is
 * full).
 */
export const MAX_REAP_TRIES_PER_SWEEP = 25;
/** The maximum number of `closePane` calls in a sweep. */
export const MAX_CLOSES_PER_SWEEP = 20;
/**
 * The maximum number of panes that wait for a close. A sweep ends only the
 * agents whose pane fits in the queue.
 */
export const MAX_CLOSE_QUEUE = 100;

const DB_SUFFIX = ".db";

/** What a sweep did for one orphan list. */
export interface ReapReport {
  /** The session ID of the list. */
  readonly session: string;
  /** The number of sub-agents that tau ended. */
  readonly ended: number;
  /** The number of panes that tau closed in the same sweep. */
  readonly closed: number;
}

export interface ReaperOptions {
  /** The tau directory (see `tauDir`). */
  readonly tauDirectory: string;
  /** The session ID of this lead. The reaper never changes its list. */
  readonly ownSession: string;
  readonly probe: Pick<ProcessProbe, "probe">;
  readonly herdr: Pick<HerdrClient, "listAgents" | "listPanes" | "closePane">;
  /** The current time, as an ISO 8601 text (for the task history). */
  readonly now: () => string;
  /** The current time, in milliseconds. The default is `Date.now`. */
  readonly clock?: () => number;
  /** A random number from 0 to 1. The default is `Math.random`. */
  readonly random?: () => number;
  /** The average time between two sweeps. The default is `REAP_MS`. */
  readonly intervalMs?: number;
  /** The minimum time before the first sweep. The default is `FIRST_REAP_MS`. */
  readonly firstDelayMs?: number;
  /** Called for each orphan list that a sweep changed. */
  readonly onReap?: (report: ReapReport) => void;
  /** The lock timeout of the store (see `StoreOptions`). */
  readonly lockTimeoutMs?: number;
  /** Reads the liveness of a file. The default is `peekLiveness`. Only for tests. */
  readonly peek?: (file: string) => Promise<Liveness | undefined>;
}

/** A file in the cache of the reaper. */
interface CacheEntry {
  /** The identity, size, and time of the database and WAL files. */
  readonly signature: string;
  /** The result of the peek. `undefined`: skip the file (not valid, or for a different session). */
  readonly peek: Liveness | undefined;
}

export class OrphanReaper {
  readonly #options: ReaperOptions;
  readonly #clock: () => number;
  readonly #random: () => number;
  readonly #closer: PaneCloser;
  /** The peek results, by file. */
  readonly #cache = new Map<string, CacheEntry>();
  /**
   * The first time that a sweep found the lead dead, by file. The token
   * identifies the process record of the lead.
   */
  readonly #firstDead = new Map<string, { readonly token: string; readonly since: number }>();
  /** The session of each close request that waits, by the key of the request (see `closeKey`). */
  readonly #paneSession = new Map<string, string>();
  /** The file name where the next sweep starts to peek (round robin). */
  #cursor: string | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;
  /** The number of sweeps. The ready lists start at a different list each sweep. */
  #sweeps = 0;

  constructor(options: ReaperOptions) {
    this.#options = options;
    this.#clock = options.clock ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#closer = new PaneCloser({ herdr: options.herdr });
  }

  /** Starts the sweeps: the first one after `firstDelayMs` and a random time. */
  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    const first = this.#options.firstDelayMs ?? FIRST_REAP_MS;
    this.#schedule(first + this.#random() * first);
  }

  /** Stops the sweeps. After this, `sweep` starts no new sweep. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  get running(): boolean {
    return this.#timer !== undefined;
  }

  /** Waits for the sweep that runs now, if one runs. */
  async drain(): Promise<void> {
    await this.#running;
  }

  /** Runs one sweep. Two calls at the same time share one sweep. */
  sweep(): Promise<void> {
    if (this.#stopped) return this.#running ?? Promise.resolve();
    this.#running ??= this.#sweep()
      .catch(() => {
        // The next sweep tries again.
      })
      .finally(() => {
        this.#running = undefined;
      });
    return this.#running;
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.sweep().finally(() => {
        const interval = this.#options.intervalMs ?? REAP_MS;
        this.#schedule(interval * (0.75 + this.#random() * 0.5));
      });
    }, delayMs);
    this.#timer.unref?.();
  }

  async #sweep(): Promise<void> {
    const { candidates, pending } = await this.#discover();
    // Probe the leads of all candidates in one call.
    const results = candidates.length === 0 ? new Map() : await this.#options.probe.probe(candidates.map((item) => item.lead));
    const nowMs = this.#clock();
    const seen = new Set<string>();
    const ready: Candidate[] = [];
    for (const candidate of candidates) {
      if (results.get(candidate.lead) !== "dead") continue;
      seen.add(candidate.file);
      let dead = this.#firstDead.get(candidate.file);
      // A different token: the lead attached again, and the grace time
      // starts again.
      if (dead?.token !== candidate.lead.token) {
        dead = { token: candidate.lead.token, since: nowMs };
        this.#firstDead.set(candidate.file, dead);
      }
      if (nowMs - dead.since >= ORPHAN_GRACE_MS) ready.push(candidate);
    }
    // A lead that is alive (or unknown), or a list that is not open anymore
    // or not in the directory, starts the grace time again. A file that this
    // sweep did not read (`pending`) keeps its time.
    for (const file of this.#firstDead.keys()) {
      if (!seen.has(file) && !pending.has(file)) this.#firstDead.delete(file);
    }
    const ended = new Map<string, number>();
    // Start at a different list each sweep, and count only the lists that
    // changed: lists that cannot change now (a full close queue) do not
    // block the lists after them.
    const start = ready.length === 0 ? 0 : this.#sweeps++ % ready.length;
    const order = [...ready.slice(start), ...ready.slice(0, start)].slice(0, MAX_REAP_TRIES_PER_SWEEP);
    let changed = 0;
    for (const candidate of order) {
      if (changed >= MAX_REAPS_PER_SWEEP) break;
      if (this.#stopped) return;
      // Never end an agent whose pane close cannot wait in the queue: its
      // record is the only data that tells which pane to close. With no
      // room, a list can still end its agents that have no pane.
      const room = Math.max(0, MAX_CLOSE_QUEUE - this.#closer.size);
      const outcome = await this.#reap(candidate, room).catch(() => undefined);
      if (outcome === undefined) continue;
      // When agents stay live (no room in the queue), the next sweep ends
      // more of them, with no new grace time.
      if (outcome.remaining === 0) this.#firstDead.delete(candidate.file);
      if (outcome.ended.length === 0) continue;
      changed += 1;
      ended.set(candidate.session, (ended.get(candidate.session) ?? 0) + outcome.ended.length);
      for (const agent of outcome.ended) {
        if (agent.pane === undefined) continue;
        const key = closeKey(candidate.session, agent.name);
        this.#closer.schedule(agent.pane, agent.name, agent.session, key);
        this.#paneSession.set(key, candidate.session);
      }
    }
    const closed = await this.#closePanes();
    for (const [session, count] of ended) {
      this.#options.onReap?.({ session, ended: count, closed: closed.get(session) ?? 0 });
    }
  }

  /** Closes the panes that wait, when it is safe. Returns the number of closes, by session. */
  async #closePanes(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (this.#closer.size === 0) return counts;
    const agents: HerdrAgent[] | undefined = await this.#options.herdr.listAgents().catch(() => undefined);
    if (agents === undefined) return counts;
    const { closed } = await this.#closer.closePanes(agents, MAX_CLOSES_PER_SWEEP);
    for (const key of closed) {
      const session = this.#paneSession.get(key);
      if (session !== undefined) counts.set(session, (counts.get(session) ?? 0) + 1);
    }
    for (const key of this.#paneSession.keys()) {
      if (this.#closer.outcome(key) !== "pending") this.#paneSession.delete(key);
    }
    return counts;
  }

  /**
   * The task lists of other sessions that have live agent records and a
   * lead process. See the module comment (steps 1 and 2). `pending` has the
   * files that changed, but that this sweep could not read (the peek limit,
   * or a failed read).
   */
  async #discover(): Promise<{ candidates: Candidate[]; pending: Set<string> }> {
    const { tauDirectory, ownSession } = this.#options;
    const directory = join(tauDirectory, "tasklists");
    const info = await lstat(directory).catch(() => undefined);
    // tau does not use a task list directory that is a symbolic link.
    if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
      this.#cache.clear();
      return { candidates: [], pending: new Set() };
    }
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(DB_SUFFIX))
      .map((entry) => entry.name)
      .sort();
    // Start at the cursor, so that each file gets a peek in turn when there
    // are more than `MAX_PEEKS_PER_SWEEP` new files.
    const start = this.#cursor === undefined ? 0 : Math.max(0, entries.findIndex((name) => name >= this.#cursor!));
    const ordered = [...entries.slice(start), ...entries.slice(0, start)];
    this.#cursor = undefined;
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    const pending = new Set<string>();
    let peeks = 0;
    for (const name of ordered) {
      if (this.#stopped) break;
      const id = name.slice(0, -DB_SUFFIX.length);
      if (id === ownSession) continue;
      let file: string;
      try {
        file = taskListFile(tauDirectory, id);
      } catch {
        continue; // Not a file name of tau.
      }
      seen.add(file);
      // The reads of SQLite are synchronous: let pi work between two files.
      await new Promise((resolve) => setImmediate(resolve));
      const signature = await signatureOf(file);
      if (signature === undefined) {
        // No process has the list open, or the files are not safe.
        this.#cache.delete(file);
        continue;
      }
      let entry = this.#cache.get(file);
      if (entry?.signature !== signature) {
        if (peeks >= MAX_PEEKS_PER_SWEEP) {
          this.#cursor ??= name;
          pending.add(file);
          continue;
        }
        peeks += 1;
        let peek: Liveness | undefined;
        try {
          peek = await (this.#options.peek ?? peekLiveness)(file);
        } catch {
          // For example, SQLite is busy for a short time. Do not keep the
          // failure: read the file again at the next sweep.
          this.#cache.delete(file);
          pending.add(file);
          continue;
        }
        entry = { signature, peek: peek?.session === id ? peek : undefined };
        this.#cache.set(file, entry);
      }
      const peek = entry.peek;
      if (peek === undefined || peek.lead === undefined || peek.live === 0) continue;
      candidates.push({ file, session: id, lead: peek.lead });
    }
    for (const file of this.#cache.keys()) {
      if (!seen.has(file)) this.#cache.delete(file);
    }
    return { candidates, pending };
  }

  /**
   * Ends the sub-agents of an orphan list, deepest first, in one
   * transaction (step 4). It ends at most `room` agents that have a pane.
   * Returns the agents that this transaction ended (none when the lead
   * attached again, or when a different process ended them first), and the
   * number of live agents that stay.
   */
  async #reap(candidate: Candidate, room: number): Promise<{ ended: AgentRecord[]; remaining: number }> {
    const store = new TaskListStore(candidate.file, {
      ...(this.#options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: this.#options.lockTimeoutMs }),
    });
    try {
      const { result } = await store.update(
        (current) => {
          const none = { ended: [], remaining: 0 };
          if (current === undefined || current.sessionId !== candidate.session) return noWrite(none);
          // The lead did not attach again (a resume), and nothing changed
          // its record since the peek.
          if (!sameProcess(current.leadProcess, candidate.lead)) return noWrite(none);
          const agents = liveAgentsDeepestFirst(current);
          const batch = fitInQueue(agents, room, current);
          const remaining = agents.length - batch.length;
          if (batch.length === 0) return noWrite({ ended: [], remaining });
          const ctx = { actor: { name: SYSTEM_ACTOR }, now: this.#options.now() };
          endAgentTree(current, ctx, batch, OWNER_EXITED);
          return { list: current, result: { ended: batch.map((agent) => ({ ...agent })), remaining } };
        },
        { create: false },
      );
      return result;
    } finally {
      store.close();
    }
  }
}

interface Candidate {
  readonly file: string;
  readonly session: string;
  readonly lead: ProcessRecord;
}

/**
 * The identity, size, and modification time of the database and WAL files.
 * `undefined` when the WAL or the SHM file does not exist (no process has
 * the list open), or when a file is not a regular file.
 */
async function signatureOf(file: string): Promise<string | undefined> {
  const parts: string[] = [];
  for (const path of [file, `${file}-wal`, `${file}-shm`]) {
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined || info.isSymbolicLink() || !info.isFile()) return undefined;
    // A reader can change the SHM file: it is not part of the signature.
    if (path !== `${file}-shm`) parts.push(`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`);
  }
  return parts.join("|");
}

/**
 * The key of a close request: the session of the list and the agent name.
 * Agents of two lists can have the same recorded pane, so the pane is not a
 * key.
 */
function closeKey(session: string, agent: string): string {
  return `${session}\n${agent}`;
}

/**
 * The agents of `agents` (deepest first) to end now: at most `room` of them
 * have a pane. An agent with no pane needs no room. An agent stays live when
 * it has a pane and no room is left, or when one of its sub-agents (at
 * any depth, also through an ended record) stays live. So the sub-agents of
 * each agent in the result are also in it (or ended before).
 */
function fitInQueue(agents: readonly AgentRecord[], room: number, list: TaskList): AgentRecord[] {
  const parents = new Map(list.agents.map((agent) => [agent.name, agent.parent]));
  const result: AgentRecord[] = [];
  // The ancestors of the agents that stay live.
  const blocked = new Set<string>();
  let panes = 0;
  for (const agent of agents) {
    // Deepest first: the live sub-agents of `agent` were done before it.
    if (blocked.has(agent.name) || (agent.pane !== undefined && panes >= room)) {
      for (let up = parents.get(agent.name); up !== undefined && !blocked.has(up); up = parents.get(up)) {
        blocked.add(up);
      }
      continue;
    }
    if (agent.pane !== undefined) panes += 1;
    result.push(agent);
  }
  return result;
}

/** True when two process records are the same record. */
export function sameProcess(a: ProcessRecord | undefined, b: ProcessRecord | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.pid === b.pid &&
    a.start === b.start &&
    a.machine === b.machine &&
    a.token === b.token &&
    a.attachedAt === b.attachedAt &&
    a.detachedAt === b.detachedAt
  );
}

/**
 * All agent records that did not end, deepest first (a parent task can
 * close only after its sub-tasks). Also an agent whose parent ended: the
 * lead is dead, so nobody watches it.
 */
function liveAgentsDeepestFirst(list: TaskList): AgentRecord[] {
  const parents = new Map(list.agents.map((agent) => [agent.name, agent.parent]));
  const depth = (name: string): number => {
    let result = 0;
    const seen = new Set<string>();
    for (let current = parents.get(name); current !== undefined && !seen.has(current); current = parents.get(current)) {
      seen.add(current);
      result += 1;
    }
    return result;
  };
  return list.agents
    .filter((agent) => agent.state !== "ended")
    .map((agent) => ({ agent, depth: depth(agent.name) }))
    .sort((a, b) => b.depth - a.depth)
    .map((item) => item.agent);
}
