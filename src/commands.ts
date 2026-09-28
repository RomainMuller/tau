/**
 * The `/tau` command and the key that shows or hides closed tasks.
 *
 * - `/tau` shows all tasks, with no line limit.
 * - `/tau show <id>` shows one task with all its fields.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type KeyId } from "@earendil-works/pi-tui";

import { formatTask } from "./format.ts";
import { findTask, isTaskId } from "./tasks/model.ts";
import type { TaskListStore } from "./tasks/store.ts";
import { renderTree } from "./tree.ts";
import type { TreeWidget } from "./widget.ts";

/** The default key that shows or hides closed tasks in the tree (`toggleCompletedKey`). */
export const TOGGLE_CLOSED_KEY = Key.ctrlShift("t");

export interface CommandOptions {
  /** The key that shows or hides closed tasks. The default is `TOGGLE_CLOSED_KEY`. */
  readonly toggleKey?: string;
  /** Show task IDs as pills in `/tau`. The default is true. */
  readonly pills?: boolean;
}

export function registerCommands(
  pi: ExtensionAPI,
  store: TaskListStore,
  widget: TreeWidget,
  badge: string,
  options: CommandOptions = {},
): void {
  // The configuration checks the key (see `isKeyId` in config.ts).
  pi.registerShortcut((options.toggleKey ?? TOGGLE_CLOSED_KEY) as KeyId, {
    description: "tau: show or hide completed and canceled tasks",
    handler: () => {
      widget.toggleClosed();
    },
  });

  pi.registerCommand("tau", {
    description: "Show the tau task list (/tau), or one task (/tau show <id>)",
    handler: async (args, ctx) => {
      const words = (args ?? "").trim().split(/\s+/u).filter((word) => word !== "");
      const list = await store.read().catch((error: unknown) => {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return undefined;
      });
      if (list === undefined) {
        return;
      }
      if (words.length === 0) {
        await showText(ctx, "tau: all tasks", (width) =>
          renderTree(list, { showClosed: true, maxLines: Number.MAX_SAFE_INTEGER, pills: options.pills ?? true, color: true, width, badge }),
        );
        return;
      }
      if (words[0] === "show" && words.length === 2 && isTaskId(words[1] ?? "")) {
        const task = findTask(list, words[1] ?? "");
        if (task === undefined) {
          ctx.ui.notify(`Task ${words[1]} does not exist.`, "error");
          return;
        }
        const text = formatTask(list, task, { complete: true });
        await showText(ctx, `tau: task ${task.id}`, (width) =>
          text.split("\n").flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, Math.max(1, width)))),
        );
        return;
      }
      ctx.ui.notify("Usage: /tau, or /tau show <id> (for example /tau show T2.1).", "warning");
    },
  });
}

/**
 * Shows lines in a view that takes the place of the editor. The view is at
 * most as tall as the terminal, less some lines for the rest of pi. Up,
 * Down, Page Up, Page Down, Home, and End move the lines. Esc, Enter, or q
 * closes it. Without a TUI, the lines go to the notification area.
 */
async function showText(ctx: ExtensionContext, title: string, lines: (width: number) => string[]): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify([title, ...lines(80)].join("\n"), "info");
    return;
  }
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new TextView(title, lines, () => viewHeight(tui.terminal.rows), theme, () => {
    tui.requestRender();
  }, () => done(undefined)));
}

/** The number of text lines in the view for a terminal height. */
export function viewHeight(rows: number): number {
  // Keep space for the title, the help line, and the lines of pi around the view.
  return Math.max(3, rows - 8);
}

interface ViewTheme {
  bold(text: string): string;
  fg(color: "accent" | "dim", text: string): string;
}

/** A view of lines, with a scroll position. */
export class TextView implements Component {
  readonly #title: string;
  readonly #lines: (width: number) => string[];
  readonly #height: () => number;
  readonly #theme: ViewTheme;
  readonly #redraw: () => void;
  readonly #close: () => void;
  #top = 0;
  #cache: { width: number; lines: string[] } | undefined;

  constructor(
    title: string,
    lines: (width: number) => string[],
    height: () => number,
    theme: ViewTheme,
    redraw: () => void,
    close: () => void,
  ) {
    this.#title = title;
    this.#lines = lines;
    this.#height = height;
    this.#theme = theme;
    this.#redraw = redraw;
    this.#close = close;
  }

  render(width: number): string[] {
    if (this.#cache?.width !== width) {
      this.#cache = { width, lines: this.#lines(width) };
    }
    const all = this.#cache.lines;
    const height = this.#height();
    this.#top = Math.max(0, Math.min(this.#top, all.length - height));
    const shown = all.slice(this.#top, this.#top + height);
    const position =
      all.length > height ? ` (lines ${this.#top + 1}-${this.#top + shown.length} of ${all.length})` : "";
    const help = `Esc, Enter, or q to close${all.length > height ? "; Up, Down, Page Up, Page Down, Home, End to move" : ""}`;
    return [
      truncateToWidth(this.#theme.bold(this.#theme.fg("accent", `${this.#title}${position}`)), width, "…"),
      ...shown.map((line) => truncateToWidth(line, width, "…")),
      truncateToWidth(this.#theme.fg("dim", help), width, "…"),
    ];
  }

  invalidate(): void {
    this.#cache = undefined;
  }

  handleInput(data: string): void {
    const height = this.#height();
    const total = this.#cache?.lines.length ?? 0;
    const moves: Array<[KeyId, number]> = [
      [Key.up, this.#top - 1],
      [Key.down, this.#top + 1],
      [Key.pageUp, this.#top - height],
      [Key.pageDown, this.#top + height],
      [Key.home, 0],
      [Key.end, total],
    ];
    for (const [key, top] of moves) {
      if (matchesKey(data, key)) {
        this.#top = Math.max(0, Math.min(top, Math.max(0, total - height)));
        this.#redraw();
        return;
      }
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q") {
      this.#close();
    }
  }
}
