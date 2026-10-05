/**
 * The sticky state of one agent: a base state, and overlays of tools that
 * run now.
 *
 * - The base state comes from the run of the agent: `working` while it runs,
 *   `idle` after it, `error` after a run that ended with an error, and
 *   `question` while the agent waits for the answer of the user after the
 *   run (`tau_ask_user`).
 * - An overlay comes from one tool call (or one UI prompt): `question` while
 *   the "ask question" tool runs, `waiting` while `tau_wait` runs. When the
 *   call ends, tau removes its overlay: the state is then again the state
 *   before the call.
 *
 * The effective state is `question` when an overlay is `question`, else
 * `waiting` when an overlay is `waiting`, else the base state. Thus parallel
 * calls do not hide a question.
 */

import type { AgentState } from "./protocol.ts";

export type BaseState = "idle" | "working" | "question" | "error";
export type OverlayState = "question" | "waiting";

export class AgentStatus {
  #base: BaseState = "idle";
  readonly #overlays = new Map<string, OverlayState>();
  #last: AgentState;
  readonly #onChange: (state: AgentState) => void;

  constructor(onChange: (state: AgentState) => void) {
    this.#onChange = onChange;
    this.#last = this.state;
  }

  /** The effective state. */
  get state(): AgentState {
    let waiting = false;
    for (const overlay of this.#overlays.values()) {
      if (overlay === "question") return "question";
      waiting = true;
    }
    return waiting ? "waiting" : this.#base;
  }

  setBase(state: BaseState): void {
    this.#base = state;
    this.#notify();
  }

  /** Adds the overlay of a call. A second overlay with the same key replaces the first. */
  push(key: string, state: OverlayState): void {
    this.#overlays.set(key, state);
    this.#notify();
  }

  /** Removes the overlay of a call. Does nothing for a key that has no overlay. */
  pop(key: string): void {
    if (this.#overlays.delete(key)) this.#notify();
  }

  /** Removes all overlays (for example at the end of a run: no tool runs then). */
  clearOverlays(): void {
    if (this.#overlays.size === 0) return;
    this.#overlays.clear();
    this.#notify();
  }

  #notify(): void {
    const state = this.state;
    if (state === this.#last) return;
    this.#last = state;
    this.#onChange(state);
  }
}
