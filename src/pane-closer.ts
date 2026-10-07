/**
 * The close of the panes of ended sub-agents, when it is safe.
 *
 * tau closes a pane only when herdr shows the sub-agent in it (see
 * `isSubAgentIn`), or when this process made the pane (`createdPanes`) and
 * herdr shows no agent in it. When herdr shows the sub-agent (by its name
 * and pi session) in a different pane (the pane moved), tau closes that pane.
 *
 * This protects against old records and errors. It is not a security
 * boundary: a program of the same user can write a false name and session
 * in the task list. Then tau can close the pane of the agent with that name
 * and session. So a wrong agent record cannot close a different pane (for
 * example the pane of the lead). When a close fails, tau tries again at the
 * next call.
 *
 * The supervisor (`supervisor.ts`) and the reaper (`reaper.ts`) use it.
 */

import type { HerdrAgent, HerdrClient } from "./herdr-client.ts";
import { isAgentSession, isSubAgentIn } from "./sessions.ts";

/** A pane that tau must close when it is safe. */
interface PaneToClose {
  /** The key of the request (see `schedule`). */
  readonly key: string;
  readonly pane: string;
  /** The agent that must be in the pane, if an agent is in it. */
  readonly agent: string;
  /** The pi session of that agent, when it is known. */
  readonly session?: string | undefined;
}

/** The maximum number of requests in `kept`. */
const MAX_KEPT = 100;

export interface PaneCloserOptions {
  readonly herdr: Pick<HerdrClient, "listPanes" | "closePane">;
  /** The panes that this process made. tau can close them when they are empty. */
  readonly createdPanes?: Set<string>;
}

export class PaneCloser {
  readonly #herdr: Pick<HerdrClient, "listPanes" | "closePane">;
  readonly #createdPanes: Set<string>;
  /** Panes to close, by the key of the request. A failed close stays here for the next call. */
  #toClose = new Map<string, PaneToClose>();
  /** The keys of requests that tau did not close, because it was not safe (at most the last 100). */
  #kept = new Set<string>();

  constructor(options: PaneCloserOptions) {
    this.#herdr = options.herdr;
    this.#createdPanes = options.createdPanes ?? new Set();
  }

  /** The number of requests that wait. */
  get size(): number {
    return this.#toClose.size;
  }

  /**
   * Closes the pane of an agent at the next `closePanes`, when it is safe.
   * `key` identifies the request (the default is the pane). A new request
   * with the same key replaces the old request. Use a key that is unique
   * for each agent when the panes can be the same (for example, agents of
   * different task lists can have the same recorded pane).
   */
  schedule(pane: string, agent: string, session?: string, key: string = pane): void {
    this.#kept.delete(key);
    this.#toClose.set(key, { key, pane, agent, session });
  }

  /**
   * What occurred to a close that `schedule` asked for (by the key of the
   * request):
   *
   * - `closed`: tau closed the pane, or the pane does not exist.
   * - `pending`: the close did not occur yet, or it failed. tau tries again
   *   at the next call.
   * - `kept`: tau did not close the pane, because this is not safe (a
   *   different agent is in it, or tau cannot prove whose pane it is).
   */
  outcome(key: string): "closed" | "pending" | "kept" {
    if (this.#toClose.has(key)) return "pending";
    return this.#kept.has(key) ? "kept" : "closed";
  }

  /**
   * Closes the scheduled panes when it is safe. `agents` is the agent list
   * of herdr. Makes at most `maxCloses` `closePane` calls: the other
   * requests wait for the next call.
   *
   * Returns the keys of the requests that tau closed (`closePane`), and
   * true in `changed` when a pane closed or does not exist anymore (then the
   * caller can balance the layout).
   */
  async closePanes(
    agents: readonly HerdrAgent[],
    maxCloses = Number.POSITIVE_INFINITY,
  ): Promise<{ readonly closed: string[]; readonly changed: boolean }> {
    const closed: string[] = [];
    if (this.#toClose.size === 0) return { closed, changed: false };
    const panes = await this.#herdr.listPanes().catch(() => undefined);
    if (panes === undefined) return { closed, changed: false };
    let changed = false;
    let calls = 0;
    for (const scheduled of [...this.#toClose.values()]) {
      // herdr knows the agent by its name and pi session. When it is in a
      // different pane (the pane moved after the last record), close its
      // current pane.
      // A nameless agent in a different pane is not proof: tau does not
      // follow it.
      const found =
        scheduled.session === undefined
          ? undefined
          : agents.find((agent) => agent.name === scheduled.agent && isAgentSession(agent, scheduled.session));
      const item = found === undefined ? scheduled : { ...scheduled, pane: found.paneId };
      if (!panes.has(item.pane)) {
        // The pane does not exist. When the agent list showed the agent, it
        // moved between the two lists: keep the request, and find its pane
        // again at the next call.
        if (found === undefined) {
          this.#toClose.delete(scheduled.key);
          // The pane closed (for example, you closed it).
          changed = true;
        }
        continue;
      }
      const occupant = agents.find((agent) => agent.paneId === item.pane);
      // An agent in the pane must be the same agent. See `isSubAgentIn`.
      const safe =
        occupant === undefined
          ? this.#createdPanes.has(item.pane)
          : isSubAgentIn(occupant, item.agent, item.session, this.#createdPanes.has(item.pane));
      if (!safe) {
        // A different agent is in the pane, or tau did not make it: keep it.
        this.#toClose.delete(scheduled.key);
        this.#kept.add(scheduled.key);
        if (this.#kept.size > MAX_KEPT) this.#kept.delete(this.#kept.values().next().value!);
        continue;
      }
      if (calls >= maxCloses) continue;
      calls += 1;
      try {
        await this.#herdr.closePane(item.pane);
        this.#toClose.delete(scheduled.key);
        this.#createdPanes.delete(item.pane);
        closed.push(scheduled.key);
        changed = true;
      } catch {
        // Try again at the next call.
      }
    }
    return { closed, changed };
  }
}
