/**
 * The layout of the panes of sub-agents in herdr.
 *
 * The lead pane stays on the left, at full height. All sub-agents (also the
 * sub-agents of sub-agents) go in one column on the right of the lead. Each
 * pane in the column gets the same height:
 *
 * ```text
 * +------+------+
 * |      | t1   |
 * |      +------+
 * | lead | t2   |
 * |      +------+
 * |      | t3   |
 * +------+------+
 * ```
 *
 * - The first sub-agent splits the lead pane to the right: the lead and the
 *   column get one half of the width each.
 * - Each next sub-agent splits the lowest pane of the column down.
 * - After a pane opens or closes, tau gives the same height to each pane of
 *   the column (`balanceColumn`).
 *
 * The column is the stack of panes that touch the right edge of the lead
 * pane. tau changes it only when all its panes are panes of tau agents. When
 * tau cannot find the lead pane (for example, the pane moved to a different
 * tab, or the lead stopped), the caller uses the old rule: it splits its own
 * pane.
 *
 * The layout is only for display: an error here never stops a delegation.
 */

import type { HerdrClient, PaneLayout, Rect } from "./herdr-client.ts";
import { isAgentSession, isSubAgentIn } from "./sessions.ts";
import type { TaskListStore } from "./tasks/store.ts";

/** The share of the width that the lead keeps when the column opens. */
export const LEAD_WIDTH_RATIO = 0.5;

/** The herdr commands that the layout uses. */
export type LayoutHerdr = Pick<HerdrClient, "layout" | "resizePane" | "listAgents">;

/**
 * The panes of the column on the right of `lead`, from top to bottom: the
 * panes that touch the right edge of the lead pane, and that are in the
 * rows of the lead. `undefined` when the layout has no lead pane.
 */
export function columnPanes(layout: PaneLayout, lead: string): string[] | undefined {
  const leadRect = layout.panes.get(lead);
  if (leadRect === undefined) return undefined;
  const edge = leadRect.x + leadRect.width;
  return [...layout.panes]
    .filter(
      ([id, rect]) =>
        id !== lead && rect.x === edge && rect.y >= leadRect.y && rect.y + rect.height <= leadRect.y + leadRect.height,
    )
    .sort(([, a], [, b]) => a.y - b.y)
    .map(([id]) => id);
}

/**
 * The width of the column: from the right edge of the lead pane to the right
 * edge of the `right` split that has the lead pane on its left. `undefined`
 * when the layout has no such split.
 */
function columnWidth(layout: PaneLayout, lead: string): number | undefined {
  const leadRect = layout.panes.get(lead)!;
  const edge = leadRect.x + leadRect.width;
  let best: { width: number; distance: number } | undefined;
  for (const split of layout.splits) {
    if (split.direction !== "right") continue;
    const rect = split.rect;
    if (rect.x > leadRect.x || rect.y > leadRect.y || rect.y + rect.height < leadRect.y + leadRect.height) continue;
    const distance = Math.abs(rect.x + split.ratio * rect.width - edge);
    const width = rect.x + rect.width - edge;
    if (distance <= 1 && width > 0 && (best === undefined || distance < best.distance)) best = { width, distance };
  }
  return best?.width;
}

/** Where a new pane goes: the pane to split, the direction, and the share of the old pane. */
export interface Placement {
  readonly pane: string;
  readonly direction: "right" | "down";
  readonly ratio: number;
}

/**
 * Where the pane of a new sub-agent goes (see the module comment).
 * `isTauPane` tells if a pane is a pane of a tau agent (see
 * `layoutOwnership`). `self` is the pane of the agent that delegates: it
 * must be in the tab of the lead. `undefined` when tau cannot find the lead
 * pane in the tab of `self`: then the caller uses the old rule.
 */
export async function placeNewPane(
  herdr: Pick<LayoutHerdr, "layout">,
  lead: string,
  self: string,
  isTauPane: (pane: string) => boolean,
): Promise<Placement | undefined> {
  const layout = await herdr.layout(lead).catch(() => undefined);
  if (layout === undefined || !layout.panes.has(self)) return undefined;
  const column = columnPanes(layout, lead);
  if (column === undefined) return undefined;
  // A pane of the column that you split to the right is narrower: do not
  // split it again.
  const width = columnWidth(layout, lead) ?? Math.max(0, ...column.map((id) => layout.panes.get(id)!.width));
  const lowest = column.filter((id) => isTauPane(id) && layout.panes.get(id)!.width === width).at(-1);
  if (lowest === undefined) return { pane: lead, direction: "right", ratio: LEAD_WIDTH_RATIO };
  return { pane: lowest, direction: "down", ratio: 0.5 };
}

/** The maximum number of resize steps of one `balanceColumn`. */
const MAX_STEPS = 64;

/**
 * Gives the same height to each pane of the column on the right of `lead`.
 * Does nothing when a pane of the column is not a pane of a tau agent, or
 * when the column is not one stack of panes with the same width.
 *
 * herdr resizes a pane by moving one of its edges: `down` moves the bottom
 * edge of a pane down, `up` moves the top edge of a pane up. The amount is a
 * share of the split that has the edge. tau moves each edge from the top,
 * and reads the layout again after each step. It stops when the heights
 * come back to an earlier state (herdr rounds the rows), and after
 * `MAX_STEPS` steps.
 */
export async function balanceColumn(
  herdr: Pick<LayoutHerdr, "layout" | "resizePane">,
  lead: string,
  isTauPane: (pane: string) => boolean,
): Promise<void> {
  const seen = new Set<string>();
  for (let step = 0; step < MAX_STEPS; step++) {
    const layout = await herdr.layout(lead).catch(() => undefined);
    if (layout === undefined) return;
    const state = [...layout.panes].map(([id, rect]) => `${id}:${rect.y}:${rect.height}`).join(",");
    if (seen.has(state)) return;
    seen.add(state);
    const move = nextMove(layout, lead, isTauPane);
    if (move === undefined) return;
    try {
      await herdr.resizePane(move.pane, move.direction, move.amount);
    } catch {
      return;
    }
  }
}

/** The smallest resize that tau asks for (herdr gets 4 decimals). */
const MIN_AMOUNT = 0.0005;

/** The next resize that `balanceColumn` does, or `undefined` when the column is balanced (or tau must not change it). */
export function nextMove(
  layout: PaneLayout,
  lead: string,
  isTauPane: (pane: string) => boolean,
): { pane: string; direction: "up" | "down"; amount: number } | undefined {
  const column = columnPanes(layout, lead);
  if (column === undefined || column.length < 2 || !column.every(isTauPane)) return undefined;
  const rects = column.map((id) => layout.panes.get(id)!);
  const first = rects[0]!;
  // One stack: the same x and width, each pane below the one before it.
  for (let i = 1; i < rects.length; i++) {
    const above = rects[i - 1]!;
    const rect = rects[i]!;
    if (rect.width !== first.width || rect.y !== above.y + above.height) return undefined;
  }
  const top = first.y;
  const height = rects.at(-1)!.y + rects.at(-1)!.height - top;
  for (let i = 0; i < rects.length - 1; i++) {
    const rect = rects[i]!;
    const edge = rect.y + rect.height;
    const target = top + Math.round(((i + 1) * height) / rects.length);
    if (Math.abs(target - edge) < 1) continue;
    const split = splitAt(layout, rect, edge);
    if (split === undefined) return undefined;
    // Move the ratio of the split to the target row, not the rounded edge:
    // a step of rows can jump over the target when herdr rounds.
    const wanted = (target - split.rect.y) / split.rect.height;
    const amount = Math.abs(wanted - split.ratio);
    if (amount < MIN_AMOUNT) continue;
    return wanted > split.ratio
      ? { pane: column[i]!, direction: "down", amount }
      : { pane: column[i + 1]!, direction: "up", amount };
  }
  return undefined;
}

/** The `down` split whose edge is at row `edge`, below `pane`. */
function splitAt(layout: PaneLayout, pane: Rect, edge: number): { rect: Rect; ratio: number } | undefined {
  let best: { rect: Rect; ratio: number; distance: number } | undefined;
  for (const split of layout.splits) {
    if (split.direction !== "down") continue;
    const rect = split.rect;
    if (rect.x > pane.x || rect.x + rect.width < pane.x + pane.width) continue;
    if (rect.y > pane.y || rect.y + rect.height < edge || rect.height <= 0) continue;
    const distance = Math.abs(rect.y + split.ratio * rect.height - edge);
    if (distance <= 1 && (best === undefined || distance < best.distance)) best = { rect, ratio: split.ratio, distance };
  }
  return best;
}

/** The last layout change of each herdr client: one change at a time in a process. */
const queues = new WeakMap<object, Promise<unknown>>();

/**
 * Runs `change` after the layout changes that run now for the same herdr
 * client. Two delegations at the same time must not split and resize the
 * column at the same time. Errors do not stop the next change.
 */
export function serialized<T>(key: object, change: () => Promise<T>): Promise<T> {
  const before = queues.get(key) ?? Promise.resolve();
  const run = before.then(change, change);
  queues.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

/** True for a herdr pane ID that tau can give to a sub-agent (`TAU_LEAD_PANE`). */
export function isPaneId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/.test(value);
}

/**
 * The test for the panes that tau can change, or `undefined` when tau must
 * not change the layout:
 *
 * - The lead pane must have the lead in it: herdr shows an agent there with
 *   the session of the task list (its recorded session file, else its
 *   session ID). So a wrong `TAU_LEAD_PANE` cannot make tau change a
 *   different pane.
 * - A pane of a sub-agent is a pane of an agent record that did not end.
 *   When herdr shows an agent in it, it must be that sub-agent: its
 *   recorded session (see `isSubAgentIn`), or its name while it starts. A
 *   pane that you use now is not a tau pane.
 */
export async function layoutOwnership(
  herdr: Pick<LayoutHerdr, "listAgents">,
  store: TaskListStore,
  lead: string,
): Promise<((pane: string) => boolean) | undefined> {
  const list = await store.read().catch(() => undefined);
  const agents = await herdr.listAgents().catch(() => undefined);
  if (list === undefined || agents === undefined) return undefined;
  const leadAgent = agents.find((agent) => agent.paneId === lead);
  if (leadAgent === undefined || !isAgentSession(leadAgent, list.sessionFile ?? list.sessionId)) return undefined;
  const panes = new Set<string>([lead]);
  for (const record of list.agents) {
    if (record.state === "ended" || record.pane === undefined) continue;
    const occupant = agents.find((agent) => agent.paneId === record.pane);
    // With a recorded session, the occupant must have it (a herdr name can
    // be used again). Before that (a sub-agent that starts), its name.
    const owned =
      occupant === undefined ||
      (record.session === undefined
        ? record.state === "starting" && occupant.name === record.name
        : isSubAgentIn(occupant, record.name, record.session, true));
    if (owned) panes.add(record.pane);
  }
  return (pane) => panes.has(pane);
}

/**
 * Gives the same height to each pane of the column of sub-agents (see
 * the module comment). Only for display: it never fails.
 */
export async function rebalance(herdr: LayoutHerdr, store: TaskListStore, lead: string | undefined): Promise<void> {
  if (lead === undefined) return;
  await serialized(herdr, async () => {
    const isTauPane = await layoutOwnership(herdr, store, lead);
    if (isTauPane !== undefined) await balanceColumn(herdr, lead, isTauPane);
  }).catch(() => undefined);
}
