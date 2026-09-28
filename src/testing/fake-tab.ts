/**
 * A small model of a herdr tab, for tests: a tree of splits, with integer
 * rectangles as herdr gives them. `resizePane` moves an edge as herdr 0.9
 * does (measured): `down` moves the bottom edge of the pane (the innermost
 * `down` split where the pane is in the first part), `up` moves its top edge
 * (the innermost split where it is in the second part; else its bottom
 * edge). The ratio of that split changes by the amount.
 */

import type { HerdrAgent, PaneLayout, Rect } from "../herdr-client.ts";

type Node =
  | { kind: "pane"; id: string }
  | { kind: "split"; direction: "right" | "down"; ratio: number; a: Node; b: Node };

export class FakeTab {
  root: Node;
  next = 2;
  calls: string[] = [];
  /** The agents that herdr shows. */
  agents: HerdrAgent[] = [];
  readonly width: number;
  readonly height: number;

  constructor(options: { width?: number; height?: number; root?: string; prefix?: string } = {}) {
    this.width = options.width ?? 300;
    this.height = options.height ?? 99;
    this.prefix = options.prefix ?? "p";
    this.root = { kind: "pane", id: options.root ?? "p1" };
  }

  readonly prefix: string;

  split(pane: string, direction: "right" | "down", ratio: number, id = `${this.prefix}${this.next++}`): string {
    this.root = replace(this.root, pane, (leaf) => ({ kind: "split", direction, ratio, a: leaf, b: { kind: "pane", id } }));
    return id;
  }

  close(pane: string): void {
    const remove = (node: Node): Node | undefined => {
      if (node.kind === "pane") return node.id === pane ? undefined : node;
      const a = remove(node.a);
      const b = remove(node.b);
      if (a === undefined) return b;
      if (b === undefined) return a;
      return { ...node, a, b };
    };
    this.root = remove(this.root)!;
    this.agents = this.agents.filter((agent) => agent.paneId !== pane);
  }

  has(pane: string): boolean {
    const find = (node: Node): boolean => (node.kind === "pane" ? node.id === pane : find(node.a) || find(node.b));
    return find(this.root);
  }

  async layout(_pane?: string): Promise<PaneLayout> {
    const panes = new Map<string, Rect>();
    const splits: Array<{ direction: string; ratio: number; rect: Rect }> = [];
    const walk = (node: Node, rect: Rect) => {
      if (node.kind === "pane") {
        panes.set(node.id, rect);
        return;
      }
      splits.push({ direction: node.direction, ratio: node.ratio, rect });
      if (node.direction === "right") {
        const w = Math.round(rect.width * node.ratio);
        walk(node.a, { ...rect, width: w });
        walk(node.b, { ...rect, x: rect.x + w, width: rect.width - w });
      } else {
        const h = Math.round(rect.height * node.ratio);
        walk(node.a, { ...rect, height: h });
        walk(node.b, { ...rect, y: rect.y + h, height: rect.height - h });
      }
    };
    walk(this.root, { x: 0, y: 0, width: this.width, height: this.height });
    return { panes, splits };
  }

  async resizePane(pane: string, direction: "up" | "down" | "left" | "right", amount: number): Promise<void> {
    this.calls.push(`resize ${pane} ${direction} ${amount.toFixed(4)}`);
    // herdr gets the amount with 4 decimals.
    const step = Number(amount.toFixed(4));
    const path: Array<{ node: Extract<Node, { kind: "split" }>; first: boolean }> = [];
    const find = (node: Node): boolean => {
      if (node.kind === "pane") return node.id === pane;
      if (find(node.a)) {
        path.push({ node, first: true });
        return true;
      }
      if (find(node.b)) {
        path.push({ node, first: false });
        return true;
      }
      return false;
    };
    find(this.root);
    const downs = path.filter((item) => item.node.direction === "down");
    const target =
      direction === "down"
        ? downs.find((item) => item.first)
        : (downs.find((item) => !item.first) ?? downs.find((item) => item.first));
    if (target === undefined) return;
    target.node.ratio = Math.min(0.999, Math.max(0.001, target.node.ratio + (direction === "down" ? step : -step)));
  }

  async listAgents(): Promise<HerdrAgent[]> {
    return [...this.agents];
  }

  async heights(ids: readonly string[]): Promise<number[]> {
    const layout = await this.layout();
    return ids.map((id) => layout.panes.get(id)!.height);
  }
}

function replace(node: Node, pane: string, change: (leaf: Node) => Node): Node {
  if (node.kind === "pane") return node.id === pane ? change(node) : node;
  return { ...node, a: replace(node.a, pane, change), b: replace(node.b, pane, change) };
}
