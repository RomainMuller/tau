/**
 * The work gate. An agent must have an active task before it can use tools
 * other than the tau tools. When the type of the active task is read-only,
 * the gate also blocks the tools that change files.
 *
 * tau cannot check that a tool call is for the active task. The messages
 * tell the agent to do only the work that the active task needs.
 */

import { activeTask, type TaskList } from "./tasks/model.ts";
import type { TaskTypeDefinition } from "./tasks/types.ts";
import { cleanLine } from "./text.ts";

/** The tools that change files. The gate blocks them for read-only tasks. */
export const FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

export interface GateInput {
  readonly toolName: string;
  /** The names of the tau tools. The gate never blocks them. */
  readonly tauTools: ReadonlySet<string>;
  readonly list: TaskList;
  readonly agent: string;
  readonly taskTypes: Readonly<Record<string, TaskTypeDefinition>>;
  /**
   * The configured "ask question" tool. The gate never blocks it: an agent
   * with no active task (for example a lead that waits for its sub-agents)
   * must be able to ask the user. The tool only reads an answer.
   */
  readonly askTool?: string | undefined;
}

/** Returns the reason to block the tool call, or `undefined` to allow it. */
export function checkGate(input: GateInput): string | undefined {
  if (input.tauTools.has(input.toolName) || input.toolName === input.askTool) {
    return undefined;
  }
  const active = activeTask(input.list, input.agent);
  if (active === undefined) {
    return [
      `tau blocked ${input.toolName}: you have no active task. All work must be for a task that you own.`,
      "1. Find the task that this work is for (tau_list), and claim it (tau_claim).",
      "2. If no task is correct, create one (tau_create), then claim it.",
      "Do only the work that the active task needs.",
    ].join("\n");
  }
  // A type that the configuration does not define is read-only: this is the
  // safe choice.
  if (FILE_CHANGE_TOOLS.has(input.toolName) && input.taskTypes[active.type]?.readOnly !== false) {
    // Name a type that permits changes, from the configured types.
    const writable = Object.entries(input.taskTypes).find(([name, type]) => !type.readOnly && name !== "plan")?.[0];
    return [
      `tau blocked ${input.toolName}: your active task ${active.id} has the type "${cleanLine(active.type)}", which is read-only.`,
      writable === undefined
        ? 'Record what you found in the task result. No configured task type other than "plan" permits file changes: tell the user.'
        : `Record what you found in the task result. Create a "${writable}" task for changes.`,
    ].join("\n");
  }
  return undefined;
}
