/**
 * Liveness of sub-agents. Each tau process watches the sub-agents that it
 * started (its children):
 *
 * - herdr knows each live sub-agent by its name. When a child moved to a
 *   different pane, tau records the new pane.
 * - When a child does not exist in herdr anymore (its pane closed, or pi
 *   stopped in it), tau fails the tasks that the child owned, with the
 *   result `owner agent exited`. It does the same for the sub-agents of the
 *   child, at all depths, because nobody watches them now.
 * - When herdr shows a child, but the process record of the child (see
 *   `process-info.ts`) shows that its process is dead for
 *   `ORPHAN_GRACE_MS`, the child is not live: tau does the same as above.
 *   At each check, tau uses `kill(pid, 0)` (`quickProbe`). At most one time
 *   in `FULL_PROBE_MS`, it also reads the start times and states of the
 *   children (`probe`, one `ps` call on macOS): a new process with the same
 *   PID, or a zombie, is dead.
 * - When the task of a child is closed, the child has no live sub-agents,
 *   and the child is idle (or `FINISH_GRACE_MS` went by), the child ends.
 *
 * tau closes the pane of an ended child only when this is safe (see
 * `pane-closer.ts`).
 *
 * A task that has open sub-tasks cannot close (rule 7). Such a task stays in
 * progress, and tau tries again at each check.
 */

import type { HerdrAgent, HerdrClient } from "./herdr-client.ts";
import { rebalance } from "./layout.ts";
import { PaneCloser } from "./pane-closer.ts";
import { ORPHAN_GRACE_MS, type ProcessProbe } from "./process-info.ts";
import { isAgentSession } from "./sessions.ts";
export { isAgentSession, isSubAgentIn, sameSession } from "./sessions.ts";
import { findTask, type AgentRecord, type TaskList } from "./tasks/model.ts";
import {
  endAgent,
  failTasksOfAgent,
  isAgentUnder,
  liveChildAgents,
  liveDescendantAgents,
  setAgentPane,
  type Actor,
} from "./tasks/rules.ts";
import type { TaskListStore } from "./tasks/store.ts";

/** The time between two checks, in milliseconds. */
export const SUPERVISE_MS = 5_000;
/** A child that is still `starting` after this time did not start, in milliseconds. */
export const START_GRACE_MS = 120_000;
/**
 * A child whose task is closed ends after this time, also when it is not
 * idle, in milliseconds. It has no work to do anymore, and it holds a place
 * of the sub-agent limit.
 */
export const FINISH_GRACE_MS = 120_000;
/** The minimum time between two full probes of the children (with the start time), in milliseconds. */
export const FULL_PROBE_MS = 30_000;
/** The result of a task whose owner does not exist anymore. */
export const OWNER_EXITED = "owner agent exited";

/** herdr statuses of an agent that waits for input. */
const IDLE_STATUSES = new Set(["idle", "done"]);

export interface SupervisorOptions {
  readonly store: TaskListStore;
  readonly herdr: HerdrClient;
  readonly actor: Actor;
  readonly now: () => string;
  /** The panes that this process made. tau can close them when they are empty. */
  readonly createdPanes?: Set<string>;
  /**
   * The sub-agents that a delegation of this process starts now. The
   * liveness check does not check them (see `delegate.ts`).
   */
  readonly startingAgents?: ReadonlySet<string>;
  /** Called after the task list changed. */
  readonly onChange?: () => void;
  readonly intervalMs?: number;
  /** The herdr pane of the lead. After a close, tau balances the column of sub-agents (see `layout.ts`). */
  readonly leadPane?: string | undefined;
  /**
   * The check of the process records of the children: `quickProbe` at each
   * check, and `probe` at most one time in `FULL_PROBE_MS`. Without it, tau
   * uses only herdr.
   */
  readonly processProbe?: Pick<ProcessProbe, "quickProbe" | "probe">;
}

export class Supervisor {
  readonly #options: SupervisorOptions;
  readonly #closer: PaneCloser;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;
  /**
   * The first time that a check found the process of a child dead, by the
   * name of the child and the token of its process record.
   */
  #deadSince = new Map<string, number>();
  /** The keys (see `#deadSince`) of the children that the last full probe found dead. */
  #fullDead = new Set<string>();
  /** The time of the last full probe, in milliseconds. */
  #lastFullProbe: number | undefined;

  constructor(options: SupervisorOptions) {
    this.#options = options;
    this.#closer = new PaneCloser({
      herdr: options.herdr,
      createdPanes: options.createdPanes ?? new Set(),
    });
  }

  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = setInterval(() => void this.check(), this.#options.intervalMs ?? SUPERVISE_MS);
    this.#timer.unref?.();
  }

  /** Stops the checks. After this, `check` and `checkAgain` start no new check. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  get running(): boolean {
    return this.#timer !== undefined;
  }

  /**
   * Runs a new check after the check that runs now (if one runs). Use it
   * after `scheduleClose`: a check that started before the close was
   * scheduled can have passed its pane closes already.
   */
  async checkAgain(): Promise<void> {
    await this.#running;
    await this.check();
  }

  /**
   * What occurred to a close that `scheduleClose` asked for (by the pane of
   * the request):
   *
   * - `closed`: tau closed the pane, or the pane does not exist.
   * - `pending`: the close did not occur yet, or it failed. tau tries again
   *   at the next check.
   * - `kept`: tau did not close the pane, because this is not safe (a
   *   different agent is in it, or tau cannot prove whose pane it is).
   */
  closeOutcome(pane: string): "closed" | "pending" | "kept" {
    return this.#closer.outcome(pane);
  }

  /** Waits for the check that runs now, if one runs. */
  async drain(): Promise<void> {
    await this.#running;
  }

  /** Runs one check. Two calls at the same time share one check. */
  check(): Promise<void> {
    if (this.#stopped) return this.#running ?? Promise.resolve();
    this.#running ??= this.#check()
      .catch(() => {
        // The next check tries again. herdr or the store can fail for a
        // short time.
      })
      .finally(() => {
        this.#running = undefined;
      });
    return this.#running;
  }

  async #check(): Promise<void> {
    const { store, herdr, actor } = this.#options;
    const list = await store.read();
    if (list === undefined) return;
    const children = liveChildAgents(list, actor.name);
    const stuck = stuckAgents(list, actor.name);
    if (children.length === 0 && stuck.length === 0 && this.#closer.size === 0) {
      // No herdr call when there is nothing to watch.
      return;
    }
    const agents = await herdr.listAgents();
    const nowMs = Date.now();
    await this.#fullProbe(list, nowMs);

    // First find the changes on a copy, so that a check without changes
    // does not write the task list.
    if (this.#apply(structuredClone(list), agents, nowMs, false)) {
      await store.mutate((current) => {
        this.#apply(current, agents, nowMs, true);
      });
      this.#options.onChange?.();
    }
    await this.#closePanes(agents);
    await this.#restoreNames(agents, nowMs);
  }

  /**
   * Gives the name back to a live child that herdr shows with no name (the
   * rename after a start that timed out can fail, see `delegate.ts`).
   * Without its name, tau cannot follow the child when its pane moves.
   *
   * One rename for each check, so that a slow herdr does not delay the
   * checks. Before the rename, tau reads the agents again, and checks that
   * the child is still in the pane with no name: the list of the check can
   * be old. (herdr has no conditional rename, so a very short race stays.)
   */
  async #restoreNames(agents: readonly HerdrAgent[], nowMs: number): Promise<void> {
    const list = await this.#options.store.read().catch(() => undefined);
    if (list === undefined) return;
    const child = liveChildAgents(list, this.#options.actor.name).find((record) => {
      if (this.#options.startingAgents?.has(record.name) === true) return false;
      const live = findLive(agents, record, nowMs);
      return live !== undefined && live.name === undefined;
    });
    if (child === undefined) return;
    const now = await this.#options.herdr.listAgents().catch(() => undefined);
    const live = now === undefined ? undefined : findLive(now, child, nowMs);
    if (live === undefined || live.name !== undefined) return;
    await this.#options.herdr.renameAgent(live.paneId, child.name).catch(() => undefined);
  }

  /** Applies the liveness rules to `current`. Returns true when it changed. */
  #apply(current: TaskList, agents: readonly HerdrAgent[], nowMs: number, schedule: boolean): boolean {
    const { actor } = this.#options;
    const ctx = { actor, now: this.#options.now() };
    let changed = false;
    const watched = new Set<string>();
    for (const child of liveChildAgents(current, actor.name)) {
      // This process starts the child now: the delegation decides what
      // happens to it (see `delegate.ts`), also after the start grace time.
      if (this.#options.startingAgents?.has(child.name) === true) continue;
      const found = findLive(agents, child, nowMs);
      const live = found !== undefined && this.#processDead(child, nowMs, watched) ? undefined : found;
      if (live === undefined) {
        const age = nowMs - Date.parse(child.startedAt);
        if (child.state === "starting" && age < START_GRACE_MS) continue;
        // The child and its sub-agents: deepest first, because a task
        // closes only after its sub-tasks.
        for (const agent of [...liveDescendantAgents(current, child.name), child]) {
          failTasksOfAgent(current, ctx, agent.name, OWNER_EXITED);
          endAgent(current, agent.name, ctx.now);
          if (schedule) this.#scheduleClose(agent);
        }
        changed = true;
        continue;
      }
      if (child.pane !== live.paneId) {
        // herdr moved the pane of the child (a moved pane gets a new ID).
        // findLive found the child by its pi session, so this is the child.
        setAgentPane(current, child.name, live.paneId);
        changed = true;
      }
      if (this.#isFinished(current, child, live, nowMs)) {
        endAgent(current, child.name, ctx.now);
        if (schedule) this.#scheduleClose({ ...child, pane: live.paneId });
        changed = true;
      }
    }
    for (const name of stuckAgents(current, actor.name)) {
      if (failTasksOfAgent(current, ctx, name, OWNER_EXITED).failed.length > 0) changed = true;
    }
    for (const key of this.#deadSince.keys()) {
      if (!watched.has(key)) this.#deadSince.delete(key);
    }
    return changed;
  }

  /**
   * Reads the start times of the children (`probe`), at most one time in
   * `FULL_PROBE_MS`. `quickProbe` cannot see a new process with the same
   * PID, or a zombie.
   */
  async #fullProbe(list: TaskList, nowMs: number): Promise<void> {
    const probe = this.#options.processProbe;
    if (probe === undefined) return;
    if (this.#lastFullProbe !== undefined && nowMs - this.#lastFullProbe < FULL_PROBE_MS) return;
    const children = liveChildAgents(list, this.#options.actor.name).filter(
      (child) => child.process !== undefined && this.#options.startingAgents?.has(child.name) !== true,
    );
    if (children.length === 0) {
      this.#fullDead.clear();
      return;
    }
    this.#lastFullProbe = nowMs;
    const results = await probe.probe(children.map((child) => child.process!)).catch(() => undefined);
    if (results === undefined) return;
    this.#fullDead = new Set(
      children.filter((child) => results.get(child.process!) === "dead").map((child) => processKey(child)),
    );
  }

  /**
   * True when herdr shows the child, but its process record shows that its
   * process is dead for `ORPHAN_GRACE_MS` (for example, a different pi with
   * the same session is in the pane). A child with no process record does
   * not change. Adds the key of a dead child to `watched`.
   */
  #processDead(child: AgentRecord, nowMs: number, watched: Set<string>): boolean {
    const probe = this.#options.processProbe;
    if (probe === undefined || child.process === undefined) return false;
    const key = processKey(child);
    if (probe.quickProbe(child.process) !== "dead" && !this.#fullDead.has(key)) return false;
    watched.add(key);
    const since = this.#deadSince.get(key) ?? nowMs;
    this.#deadSince.set(key, since);
    return nowMs - since >= ORPHAN_GRACE_MS;
  }

  /**
   * True when a live child has no work anymore: its task is closed (checked
   * in the transaction, so a claim just before cannot be lost), it has no
   * live sub-agents, and it is idle or the grace time went by.
   */
  #isFinished(list: TaskList, child: AgentRecord, live: HerdrAgent, nowMs: number): boolean {
    if (list.tasks.some((task) => task.status === "in_progress" && task.owner === child.name)) return false;
    if (liveChildAgents(list, child.name).length > 0) return false;
    if (IDLE_STATUSES.has(live.status)) return true;
    // The time of the last close of the task. A note after the close does
    // not change it.
    const task = findTask(list, child.task);
    const closedAt = task?.history.findLast((event) => CLOSE_EVENTS.has(event.kind))?.at;
    return closedAt !== undefined && nowMs - Date.parse(closedAt) >= FINISH_GRACE_MS;
  }

  #scheduleClose(agent: AgentRecord): void {
    if (agent.pane !== undefined) this.scheduleClose(agent.pane, agent.name, agent.session);
  }

  /**
   * Closes the pane of an agent at the next check, when it is safe (see
   * `pane-closer.ts`).
   */
  scheduleClose(pane: string, agent: string, session?: string): void {
    this.#closer.schedule(pane, agent, session);
  }

  /** Closes the scheduled panes when it is safe. After a close, balances the column. */
  async #closePanes(agents: readonly HerdrAgent[]): Promise<void> {
    const { changed } = await this.#closer.closePanes(agents);
    if (changed) await rebalance(this.#options.herdr, this.#options.store, this.#options.leadPane);
  }
}

const CLOSE_EVENTS = new Set(["completed", "failed", "canceled"]);

/** The key of the process record of a child: its name and the token of the record. */
function processKey(child: AgentRecord): string {
  return `${child.name}\n${child.process?.token ?? ""}`;
}

/**
 * The live herdr agent of a record. When the sub-agent recorded its pi
 * session, only an agent with that session matches: a different agent with
 * the same name (after the child stopped) does not. The agent must also
 * have the name of the record, or no name and the recorded pane. Before that, the name
 * and the pane must match, and only in the start grace time.
 */
function findLive(agents: readonly HerdrAgent[], record: AgentRecord, nowMs: number): HerdrAgent | undefined {
  if (record.session !== undefined) {
    // herdr can drop the name of an agent when its start times out: then
    // the agent must be in the recorded pane. A nameless agent in a
    // different pane can be a pi that a user started with the same session.
    return agents.find(
      (agent) =>
        isAgentSession(agent, record.session) &&
        (agent.name === record.name || (agent.name === undefined && agent.paneId === record.pane)),
    );
  }
  // A sub-agent that did not record its session in the start grace time did
  // not start tau correctly: it is not a live sub-agent.
  if (nowMs - Date.parse(record.startedAt) >= START_GRACE_MS) return undefined;
  return agents.find((agent) => agent.name === record.name && agent.paneId === record.pane);
}



/**
 * The names of ended agents (started by `parent`, or by their ended
 * sub-agents) that still own a task in progress. Their tasks could not fail
 * before, because they had open sub-tasks.
 */
function stuckAgents(list: TaskList, parent: string): string[] {
  return list.agents
    .filter((agent) => agent.state === "ended" && isAgentUnder(list, agent, parent))
    .filter((agent) => list.tasks.some((task) => task.status === "in_progress" && task.owner === agent.name))
    .map((agent) => agent.name);
}
