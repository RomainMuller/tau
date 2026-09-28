/**
 * The inbox of the agent of this process: it gives new messages (see
 * `messages.ts`) to the model.
 *
 * While the agent works, the inbox does not take messages. `index.ts` gives
 * them at points where pi writes them into the session, so that no message
 * gets lost:
 *
 * - In each tool result (pi `tool_result` event): the `steer` messages, and
 *   for a `tau_*` tool, all messages. (`tau_wait` returns when a message
 *   arrives, so the message comes with its result.)
 * - At the end of the run (pi `agent_before_settle` event): all messages.
 *
 * While the agent is idle, a poll gives all messages, and starts a turn. The
 * poll does not do this:
 *
 * - After a run that did not end normally (for example, the user pressed
 *   `Esc`), until the next input of the user. Exception: a sub-agent after
 *   an error (its parent can tell it to continue; see `index.ts`).
 * - While the agent waits for an answer of the user (`tau_ask_user`).
 * - More than one time in `MIN_TURN_GAP_MS`, so that many messages do not
 *   start many turns.
 */

import { messagesText } from "./messages.ts";
import type { StoredMessage, TaskListStore } from "./tasks/store.ts";

/** The time between two polls, in milliseconds. */
export const INBOX_POLL_MS = 1_000;
/** The minimum time between two turns that the inbox starts, in milliseconds. */
export const MIN_TURN_GAP_MS = 5_000;

export interface InboxOptions {
  readonly store: TaskListStore;
  /** The name of the agent of this process. */
  readonly agent: string;
  readonly now: () => string;
  /** True while pi does not run the agent (and does not compact the session). */
  readonly isIdle: () => boolean;
  /** Gives messages to the model of an idle agent: pi starts a turn. Throws when this fails. */
  readonly deliver: (text: string) => void;
  /** Called after messages were taken (the `✉` counts changed). */
  readonly onChange?: () => void;
  readonly intervalMs?: number;
  readonly minTurnGapMs?: number;
  /** The time, in milliseconds. Tests replace it. */
  readonly clock?: () => number;
}

export class Inbox {
  readonly #options: InboxOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling: Promise<void> | undefined;
  #paused = false;
  #stopped = false;
  #lastTurn = Number.NEGATIVE_INFINITY;

  constructor(options: InboxOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = setInterval(() => void this.poll(), this.#options.intervalMs ?? INBOX_POLL_MS);
    this.#timer.unref?.();
  }

  /** Stops the polls. Wait for `drain` before the store closes. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Waits for the poll that runs now, if one runs. */
  async drain(): Promise<void> {
    await this.#polling;
  }

  /** Do not start turns until `resume` (a run did not end normally, or the agent waits for the user). */
  pause(): void {
    this.#paused = true;
  }

  /** Input from the user: the poll can start turns again. */
  resume(): void {
    this.#paused = false;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** True when the agent has messages that it did not read. */
  async hasMessages(): Promise<boolean> {
    return ((await this.#options.store.unreadCounts()).get(this.#options.agent) ?? 0) > 0;
  }

  /**
   * Takes the messages that the agent did not read (all, or only `steer`),
   * and marks them as read. The caller must give them to the model.
   */
  async take(priority?: "steer"): Promise<StoredMessage[]> {
    if (this.#stopped) return [];
    const messages = await this.#options.store.takeMessages(
      this.#options.agent,
      this.#options.now(),
      priority,
      // The text as the model gets it, and the blank line between messages.
      (message) => messagesText([message]).length + 2,
    );
    if (messages.length > 0) this.#options.onChange?.();
    return messages;
  }

  /** Runs one poll. Two calls at the same time share one poll. Errors do not throw. */
  poll(): Promise<void> {
    this.#polling ??= this.#poll()
      .catch(() => {
        // The next poll tries again. The store can fail for a short time.
      })
      .finally(() => {
        this.#polling = undefined;
      });
    return this.#polling;
  }

  async #poll(): Promise<void> {
    const { store, isIdle, deliver } = this.#options;
    const clock = this.#options.clock ?? Date.now;
    const ready = () =>
      !this.#stopped &&
      !this.#paused &&
      isIdle() &&
      clock() - this.#lastTurn >= (this.#options.minTurnGapMs ?? MIN_TURN_GAP_MS);
    if (!ready() || !(await this.hasMessages())) return;
    const messages = await this.take();
    if (messages.length === 0) return;
    // The state can change while tau takes the messages. Then give them back:
    // the next delivery point gives them.
    if (!ready()) {
      await store.untakeMessages(messages.map((message) => message.id));
      this.#options.onChange?.();
      return;
    }
    try {
      deliver(messagesText(messages));
      this.#lastTurn = clock();
    } catch (error) {
      await store.untakeMessages(messages.map((message) => message.id));
      this.#options.onChange?.();
      throw error;
    }
  }
}
