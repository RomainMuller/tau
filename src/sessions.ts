/** How tau knows a herdr agent: by its pi session, and its name or pane. */

import type { HerdrAgent } from "./herdr-client.ts";

/** True when the herdr agent runs the pi session `session` (a recorded session of a sub-agent). */
export function isAgentSession(agent: HerdrAgent, session: string | undefined): boolean {
  return session !== undefined && agent.session !== undefined && sameSession(agent.session, session);
}

/**
 * True when the herdr agent in a pane is the sub-agent `name`, with the
 * recorded pi session `session`. The session must be the same (the name
 * alone is not proof: herdr names can be used again), and:
 *
 * - herdr shows the agent with the name of the sub-agent, or
 * - herdr shows the agent with no name (herdr can drop the name when a start
 *   times out), and this process made the pane (`ownPane`). A pi that a
 *   user started (for example a lead) has no herdr name too: so a nameless
 *   agent in a different pane is not proof.
 */
export function isSubAgentIn(agent: HerdrAgent, name: string, session: string | undefined, ownPane: boolean): boolean {
  if (!isAgentSession(agent, session)) return false;
  return agent.name === name || (agent.name === undefined && ownPane);
}

/** herdr reports a session file path or a session ID. A file name contains the ID. */
export function sameSession(a: string, b: string): boolean {
  return a === b || a.endsWith(`_${b}.jsonl`) || b.endsWith(`_${a}.jsonl`);
}
