/**
 * Messages between agents.
 *
 * An agent can send a message to a different agent of its part of the agent
 * tree:
 *
 * - A sub-agent that it started, or a sub-agent of that sub-agent (any
 *   depth).
 * - The agent that started it (its parent).
 * - A sibling: an agent with the same parent.
 *
 * Each message has a priority:
 *
 * - `steer`: the recipient model gets it with the result of its current tool
 *   call.
 * - `info`: the recipient model gets it with the result of its next `tau_*`
 *   tool call, or at the end of its turn.
 *
 * When the recipient is idle, a message starts a turn. A message also stops
 * a `tau_wait` call of the recipient. tau marks a message as read when it
 * adds the message to the conversation of the recipient. See `inbox.ts`.
 *
 * The text of a message is text that an agent wrote. The recipient gets it as
 * quoted data, with a header that tells who sent it.
 */

import { TauError } from "./tasks/errors.ts";
import { activeTask, LEAD_AGENT, type TaskList } from "./tasks/model.ts";
import { isAgentUnder, MAX_TEXT_LENGTH } from "./tasks/rules.ts";
import type { StoredMessage } from "./tasks/store.ts";
import { cleanText } from "./text.ts";

export type Priority = "steer" | "info";
export const PRIORITIES: readonly Priority[] = ["steer", "info"];

/** The custom message type of a message in the conversation of the recipient. */
export const MESSAGE_TYPE = "tau-message";

/**
 * Checks that `sender` can send a message to `recipient`. Returns the task
 * of the recipient (for the reply text), if it has one. Throws a `TauError`
 * that tells what to do when the send is not permitted.
 */
export function checkRecipient(list: TaskList, sender: string, recipient: string): string | undefined {
  if (recipient === sender) {
    throw new TauError("invalid_argument", "You cannot send a message to yourself. Use tau_note to record a finding.");
  }
  const senderRecord = list.agents.find((agent) => agent.name === sender);
  if (sender !== LEAD_AGENT && (senderRecord === undefined || senderRecord.state === "ended")) {
    throw new TauError("permission_denied", `The sub-agent @${sender} ended. It cannot send messages. Stop now.`);
  }
  const notPermitted = () =>
    new TauError(
      "permission_denied",
      `You can send messages only to your sub-agents (any depth), to your parent, and to your siblings. @${recipient} is not one of them.${
        sender === LEAD_AGENT ? "" : " Send the message to your parent, which can forward it."
      }`,
    );
  if (recipient === LEAD_AGENT) {
    // Only the children of the lead have the lead as parent. The lead has no siblings.
    if (senderRecord?.parent !== LEAD_AGENT) throw notPermitted();
    return activeTask(list, LEAD_AGENT)?.id;
  }
  const recipientRecord = list.agents.find((agent) => agent.name === recipient);
  if (recipientRecord === undefined) {
    throw new TauError("not_found", `The agent @${recipient} does not exist in the task list.`);
  }
  if (recipientRecord.state === "ended") {
    throw new TauError("invalid_state", `The sub-agent @${recipient} ended. It cannot get messages.`);
  }
  const permitted =
    isAgentUnder(list, recipientRecord, sender) ||
    senderRecord?.parent === recipient ||
    (senderRecord !== undefined && senderRecord.parent === recipientRecord.parent);
  if (!permitted) throw notPermitted();
  return recipientRecord.task;
}

/** Checks the text of a message. Returns the text without spaces at the start and end. */
export function checkMessageText(text: string): string {
  const value = text.trim();
  if (value === "") throw new TauError("invalid_argument", "The message is empty.");
  if (value.length > MAX_TEXT_LENGTH) {
    throw new TauError("invalid_argument", `The message has ${value.length} characters. The maximum is ${MAX_TEXT_LENGTH}.`);
  }
  return value;
}

/**
 * The text of messages for the model of the recipient. For example:
 *
 * ```text
 * ✉ steer from @lead (T2). This message is from a different agent, not from the user:
 * | The tokens table must use the column name `expires_at`.
 * ```
 */
export function messagesText(messages: readonly StoredMessage[]): string {
  return messages
    .map((message) =>
      [
        `✉ ${message.priority} from @${message.sender}${message.senderTask === undefined ? "" : ` (${message.senderTask})`}. This message is from a different agent, not from the user:`,
        ...cleanText(message.text)
          .split("\n")
          .map((line) => `| ${line}`),
      ].join("\n"),
    )
    .join("\n\n");
}
