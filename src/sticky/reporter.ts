/**
 * Sends the lifecycle of the agent of this pi process to the stickies (see
 * `link.ts`):
 *
 * | pi event                                     | Sticky state                         |
 * |----------------------------------------------|--------------------------------------|
 * | start of the reporter (session start)        | `idle`, and the metadata             |
 * | `agent_start`, `turn_start`                  | `working`                            |
 * | an "ask question" tool runs (see below)      | `question`, then the state before it |
 * | an extension UI prompt (`ui_prompt_start`)   | `question`, then the state before it |
 * | `tau_wait` runs                              | `waiting`, then the state before it  |
 * | `agent_settled` after an error               | `error`                              |
 * | `agent_settled` after `tau_ask_user`         | `question` (until the next run)      |
 * | `agent_settled` (other)                      | `idle`                               |
 * | `model_select`                               | the new `model` metadata             |
 * | `close` (session shutdown)                   | `terminated`                         |
 *
 * Before an "ask question" tool or `tau_wait` runs, the handler waits until
 * the stickies have the new state (at most `FLUSH_MS`).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "./link.ts";
import type { AgentState } from "./protocol.ts";
import { AgentStatus } from "./status.ts";

/** The tool that makes the state `waiting`. */
export const WAIT_TOOL = "tau_wait";
/** The fallback "ask" tool of tau: it ends the turn, and the agent waits for the next input. */
const TAU_ASK_TOOL = "tau_ask_user";
/** The key of the overlay of the UI prompts. */
const UI_PROMPT_KEY = "\u0000ui-prompt";
/** The maximum time that a tool waits for the stickies before it runs. */
const FLUSH_MS = 2_000;
/** The time that the shutdown waits for the last writes. */
const CLOSE_MS = 3_000;

export interface StickyReporterOptions {
  readonly link: {
    publish(record: AgentRecord): void;
    flush(timeoutMs: number): Promise<void>;
    close(timeoutMs: number): Promise<void>;
  };
  readonly sessionId: string;
  /** The sticky session ID of the parent agent (for a sub-agent). */
  readonly parentSessionId?: string;
  readonly name: string;
  readonly workspace: string;
  readonly model: string | undefined;
  /** The text of a model for the `model` metadata. */
  readonly modelLabel: (model: { readonly id: string; readonly name?: string }) => string | undefined;
  /** True when the tool asks the user a question (the configured "ask question" tool, or `tau_ask_user`). */
  readonly isAskTool: (toolName: string) => boolean;
}

export interface StickyReporter {
  /** The current state. Only for tests. */
  readonly state: AgentState;
  /** Changes the `name` metadata. */
  setName(name: string): void;
  /** Sends `terminated`, then stops the link. Never throws. */
  close(): Promise<void>;
}

export function registerStickyReporter(pi: ExtensionAPI, options: StickyReporterOptions): StickyReporter {
  let model = options.model;
  let name = options.name;
  let closed = false;
  const record = (state: AgentState): AgentRecord => ({
    sessionId: options.sessionId,
    state,
    metadata: [
      ["name", name],
      ["workspace", options.workspace],
      ["parent", options.parentSessionId ?? ""],
      ["model", model ?? ""],
    ],
  });
  const status = new AgentStatus((state) => {
    if (!closed) options.link.publish(record(state));
  });
  options.link.publish(record(status.state));

  let uiPrompts = 0;
  /** True when the last turn was only a successful `tau_ask_user` call. */
  let asked = false;
  let outcome: string | undefined;

  pi.on("agent_start", () => {
    if (closed) return;
    outcome = undefined;
    status.setBase("working");
  });
  pi.on("turn_start", () => {
    if (closed) return;
    asked = false;
    status.setBase("working");
  });
  pi.on("turn_end", (event) => {
    const only = event.toolResults.length === 1 ? event.toolResults[0] : undefined;
    asked = only !== undefined && only.toolName === TAU_ASK_TOOL && !only.isError;
    return undefined;
  });
  pi.on("tool_execution_start", async (event) => {
    if (closed) return;
    if (options.isAskTool(event.toolName)) status.push(event.toolCallId, "question");
    else if (event.toolName === WAIT_TOOL) status.push(event.toolCallId, "waiting");
    else return;
    // pi waits for this handler before the tool runs: thus the stickies show
    // the new state before the question (at most FLUSH_MS later, when a
    // sticky does not answer).
    await options.link.flush(FLUSH_MS);
  });
  pi.on("tool_execution_end", (event) => {
    if (closed) return;
    status.pop(event.toolCallId);
  });
  // pi does not wait for this handler before it shows the prompt: the
  // stickies get the state a short time later.
  pi.on("ui_prompt_start", () => {
    if (closed) return;
    uiPrompts += 1;
    status.push(UI_PROMPT_KEY, "question");
  });
  pi.on("ui_prompt_end", () => {
    if (closed) return;
    uiPrompts = Math.max(0, uiPrompts - 1);
    if (uiPrompts === 0) status.pop(UI_PROMPT_KEY);
  });
  pi.on("agent_before_settle", (event) => {
    outcome = event.outcome;
    return undefined;
  });
  pi.on("agent_settled", () => {
    if (closed) return;
    // No tool runs after the run: remove the overlays of calls that did not
    // end normally. A UI prompt can still be open (for example a command).
    status.clearOverlays();
    if (uiPrompts > 0) status.push(UI_PROMPT_KEY, "question");
    status.setBase(outcome === "error" ? "error" : asked ? "question" : "idle");
  });
  pi.on("model_select", (event) => {
    if (closed) return;
    model = options.modelLabel(event.model);
    options.link.publish(record(status.state));
  });

  return {
    get state() {
      return status.state;
    },
    setName(value) {
      if (closed || value === name) return;
      name = value;
      options.link.publish(record(status.state));
    },
    async close() {
      if (closed) return;
      closed = true;
      options.link.publish(record("terminated"));
      try {
        await options.link.close(CLOSE_MS);
      } catch {
        // Only for display.
      }
    },
  };
}
