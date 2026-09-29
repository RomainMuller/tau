/**
 * The tau widget above the editor: the herdr badge and the task tree.
 *
 * The widget reads the task list from the store. It reads it again after
 * each change of a tau tool, and every `POLL_MS` for the changes of other
 * processes (sub-agents). The store makes these reads cheap: it decodes the
 * list only when the SQLite data changed.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";

import type { TaskList } from "./tasks/model.ts";
import type { TaskListStore } from "./tasks/store.ts";
import { DEFAULT_MAX_TREE_LINES, renderTree } from "./tree.ts";

/** The time between two reads of the task list, in milliseconds. */
export const POLL_MS = 1_000;

export interface TreeWidgetOptions {
  readonly badge: string;
  readonly maxLines?: number;
  readonly pills?: boolean;
  readonly color?: boolean;
  /** The time between two reads, in milliseconds. The default is `POLL_MS`. */
  readonly pollMs?: number;
  /** Show only this task and its sub-tasks. A sub-agent sets it to its task. */
  readonly root?: string;
}

export class TreeWidget {
  readonly #store: TaskListStore;
  readonly #options: Required<Omit<TreeWidgetOptions, "root">> & Pick<TreeWidgetOptions, "root">;
  #list: TaskList | undefined;
  #unread: ReadonlyMap<string, number> = new Map();
  #showClosed = false;
  #tui: TUI | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #refreshing: Promise<void> | undefined;
  #stopped = false;

  constructor(store: TaskListStore, options: TreeWidgetOptions) {
    this.#store = store;
    this.#options = {
      badge: options.badge,
      maxLines: options.maxLines ?? DEFAULT_MAX_TREE_LINES,
      pills: options.pills ?? true,
      color: options.color ?? true,
      pollMs: options.pollMs ?? POLL_MS,
      ...(options.root === undefined ? {} : { root: options.root }),
    };
  }

  get showClosed(): boolean {
    return this.#showClosed;
  }

  /** The lines of the widget for a width. */
  lines(width: number): string[] {
    return renderTree(this.#list, {
      showClosed: this.#showClosed,
      maxLines: this.#options.maxLines,
      pills: this.#options.pills,
      color: this.#options.color,
      width,
      badge: this.#options.badge,
      unread: this.#unread,
      ...(this.#options.root === undefined ? {} : { root: this.#options.root }),
    });
  }

  /** The component factory for `ctx.ui.setWidget`. */
  readonly factory = (tui: TUI): Component & { dispose(): void } => {
    this.#tui = tui;
    return {
      render: (width: number) => this.lines(width),
      invalidate: () => undefined,
      dispose: () => {
        if (this.#tui === tui) this.#tui = undefined;
      },
    };
  };

  /** Shows or hides the closed tasks. */
  toggleClosed(): void {
    this.#showClosed = !this.#showClosed;
    this.#tui?.requestRender();
  }

  /**
   * Reads the task list again, and draws the widget again if it changed.
   * Errors do not throw: the widget keeps the last list that it read.
   */
  refresh(): Promise<void> {
    // After stop (the session ends), start no new read of the store.
    if (this.#stopped) return this.#refreshing ?? Promise.resolve();
    this.#refreshing ??= (async () => {
      try {
        const list = await this.#store.read();
        const unread = await this.#store.unreadCounts().catch(() => this.#unread);
        const unreadChanged =
          unread.size !== this.#unread.size || [...unread].some(([agent, count]) => this.#unread.get(agent) !== count);
        if (list?.revision !== this.#list?.revision || list?.sessionId !== this.#list?.sessionId || unreadChanged) {
          this.#list = list;
          this.#unread = unread;
          this.#tui?.requestRender();
        }
      } catch {
        // The work gate and the tools report storage errors. The widget
        // shows the last list that it could read.
      } finally {
        this.#refreshing = undefined;
      }
    })();
    return this.#refreshing;
  }

  /** Waits for the refresh that runs now, if one runs. */
  async drain(): Promise<void> {
    await this.#refreshing;
  }

  /** Starts to read the task list at an interval (`pollMs`). */
  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = setInterval(() => void this.refresh(), this.#options.pollMs);
    this.#timer.unref?.();
  }

  get running(): boolean {
    return this.#timer !== undefined;
  }

  /** Stops the reads. After this, `refresh` starts no new read. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
