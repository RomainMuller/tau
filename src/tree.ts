/**
 * The task tree under the herdr badge. See the README section "The task tree
 * widget".
 *
 * `renderTree` is a pure function: it gets the task list and the options,
 * and returns the lines. Each line fits in `width` terminal columns.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { activeTask, childrenOf, findTask, parentId, type Task, type TaskList, type TaskStatus } from "./tasks/model.ts";
import { cleanLine } from "./text.ts";

export interface TreeOptions {
  /** Show `completed` and `canceled` tasks, and all dependencies. */
  readonly showClosed: boolean;
  /** The maximum number of task lines. */
  readonly maxLines: number;
  /** Show task IDs as colored powerline pills. */
  readonly pills: boolean;
  /** Use ANSI colors. Tests set this to false. */
  readonly color: boolean;
  /** The width of the widget, in terminal columns. */
  readonly width: number;
  /** The text of the badge, for example `🟢 Herdr`. */
  readonly badge: string;
  /** The number of messages that each agent did not read. Shows as `✉n` on its active task. */
  readonly unread?: ReadonlyMap<string, number>;
}

export const DEFAULT_MAX_TREE_LINES = 6;

const MARKS: Readonly<Record<TaskStatus, string>> = {
  waiting: "○",
  in_progress: "◐",
  completed: "✔",
  failed: "✖",
  canceled: "⊘",
};

/** The 256-color palette index of the pill for each status. */
const PILL_COLORS: Readonly<Record<TaskStatus, number>> = {
  waiting: 244, // gray
  in_progress: 33, // blue
  completed: 34, // green
  failed: 160, // red
  canceled: 208, // orange
};

const PILL_LEFT = "\ue0b6";
const PILL_RIGHT = "\ue0b4";

const COUNT_LABELS: ReadonlyArray<[TaskStatus, string]> = [
  ["waiting", "waiting"],
  ["in_progress", "running"],
  ["completed", "done"],
  ["failed", "failed"],
  ["canceled", "canceled"],
];

/** The minimum number of columns for a title. */
const MIN_TITLE_WIDTH = 12;
/** The maximum number of columns of a failure result in the tree. */
const MAX_REASON_WIDTH = 32;

interface Row {
  readonly task: Task;
  /** The tree characters before the mark, for example `│  ├─ `. */
  readonly prefix: string;
}

export function renderTree(list: TaskList | undefined, options: TreeOptions): string[] {
  const header = headerLine(list, options);
  if (list === undefined) {
    return [fit(header, options.width)];
  }
  const rows = visibleRows(list, options.showClosed);
  const shown = rows.slice(0, options.maxLines);
  const more = rows.length - shown.length;

  const idWidth = Math.max(0, ...shown.map((row) => row.task.id.length));
  const extras = shown.map((row) => extrasText(list, row.task, options));
  const leftWidth = (row: Row) => visibleWidth(row.prefix) + 2 + idWidth + 2;
  const maxLeft = Math.max(0, ...shown.map(leftWidth));
  const maxExtras = Math.max(0, ...extras.map((text) => visibleWidth(text)));
  const longestTitle = Math.max(0, ...shown.map((row) => visibleWidth(cleanLine(row.task.title))));
  const titleWidth = Math.max(MIN_TITLE_WIDTH, Math.min(longestTitle, options.width - maxLeft - maxExtras - 2));

  const lines = [fit(header, options.width)];
  shown.forEach((row, index) => {
    const id = idText(row.task, idWidth, options);
    // Deeper rows have less space for the title, so that the extras of all
    // rows start in the same column.
    const width = titleWidth + maxLeft - leftWidth(row);
    const title = padTo(truncateToWidth(cleanLine(row.task.title), width, "…"), width);
    const tail = extras[index] === "" ? "" : `  ${extras[index]}`;
    const mark = options.pills ? "" : `${style(MARKS[row.task.status], markColor(row.task.status), options)} `;
    const text = `${dimTree(row.prefix, options)}${mark}${id}  ${title}${tail}`;
    lines.push(fit(text.trimEnd(), options.width));
  });
  if (more > 0) {
    lines.push(fit(`${dimTree("└─ ", options)}${dim(`… ${more} more (/tau to see all)`, options)}`, options.width));
  }
  return lines;
}

/** The header: the badge and the number of tasks for each status. Counts of 0 do not show. */
function headerLine(list: TaskList | undefined, options: TreeOptions): string {
  if (list === undefined || list.tasks.length === 0) {
    return options.badge;
  }
  const counts = COUNT_LABELS.map(([status, label]) => {
    const count = list.tasks.filter((task) => task.status === status).length;
    return count === 0 ? undefined : `${count} ${label}`;
  }).filter((item) => item !== undefined);
  // An agent with unread messages and no active task: its count cannot show
  // on a task line, so it shows here.
  const mail = [...(options.unread ?? new Map<string, number>())]
    .filter(([agent, count]) => count > 0 && activeTask(list, agent) === undefined)
    .map(([agent, count]) => style(`@${cleanLine(agent)} ✉${count}`, "accent", options));
  return `${options.badge} ${dim("─", options)} ${[...counts, ...mail].join(dim(" · ", options))}`;
}

/**
 * The tasks to show, in tree order, with their tree characters. When
 * `showClosed` is false, a closed task shows only if it has a sub-task that
 * shows.
 */
function visibleRows(list: TaskList, showClosed: boolean): Row[] {
  const visible = new Map<string, boolean>();
  const isVisible = (task: Task): boolean => {
    const known = visible.get(task.id);
    if (known !== undefined) return known;
    const own = showClosed || (task.status !== "completed" && task.status !== "canceled");
    const result = own || childrenOf(list, task.id).some(isVisible);
    visible.set(task.id, result);
    return result;
  };

  const rows: Row[] = [];
  const walk = (tasks: Task[], indent: string): void => {
    const shown = tasks.filter(isVisible);
    shown.forEach((task, index) => {
      const last = index === shown.length - 1;
      rows.push({ task, prefix: `${indent}${last ? "└─ " : "├─ "}` });
      walk(childrenOf(list, task.id), `${indent}${last ? "   " : "│  "}`);
    });
  };
  walk(
    list.tasks.filter((task) => parentId(task.id) === undefined),
    "",
  );
  return rows;
}

function extrasText(list: TaskList, task: Task, options: TreeOptions): string {
  const parts: string[] = [];
  if (task.owner !== undefined && task.status !== "waiting" && task.status !== "canceled") {
    const unread = options.unread?.get(task.owner) ?? 0;
    const mail = unread > 0 && activeTask(list, task.owner)?.id === task.id ? ` ✉${unread}` : "";
    parts.push(style(`@${cleanLine(task.owner)}${mail}`, "accent", options));
  }
  const shownDependencies = options.showClosed
    ? task.dependencies
    : task.status === "waiting"
      ? task.dependencies.filter((id) => findTask(list, id)?.status !== "completed")
      : [];
  if (shownDependencies.length > 0) {
    const ids = shownDependencies.map((id) => dependencyText(list, id, options));
    parts.push(`${dim("⧗", options)} ${ids.join(" ")}`);
  }
  let text = parts.join("  ");
  if (task.status === "failed" && task.result !== undefined) {
    const reason = truncateToWidth(cleanLine(task.result), MAX_REASON_WIDTH, "…");
    text += `${text === "" ? "" : " "}${style(`· ${reason}`, "error", options)}`;
  }
  if (task.status === "canceled") {
    text += `${text === "" ? "" : " "}${dim("canceled", options)}`;
  }
  return text;
}

function idText(task: Task, width: number, options: TreeOptions): string {
  if (!options.pills) {
    return task.id.padEnd(width);
  }
  return `${pillText(task.id, task.status, options)}${" ".repeat(width - task.id.length)}`;
}

/**
 * A dependency ID. With pills, the pill color shows the status of the
 * dependency. Without pills, a complete dependency has a `✔`.
 */
function dependencyText(list: TaskList, id: string, options: TreeOptions): string {
  const status = findTask(list, id)?.status ?? "waiting";
  if (options.pills) {
    return pillText(id, status, options);
  }
  return dim(status === "completed" ? `${id}✔` : id, options);
}

function pillText(id: string, status: TaskStatus, options: TreeOptions): string {
  if (!options.color) {
    return `${PILL_LEFT}${id}${PILL_RIGHT}`;
  }
  const color = PILL_COLORS[status];
  const strike = status === "canceled" ? "\u001b[9m" : "";
  const cap = (glyph: string) => `\u001b[38;5;${color}m${glyph}\u001b[39m`;
  const body = `\u001b[48;5;${color}m\u001b[38;5;15m${strike}${id}\u001b[29m\u001b[39m\u001b[49m`;
  return `${cap(PILL_LEFT)}${body}${cap(PILL_RIGHT)}`;
}

type Tone = "accent" | "error" | "success" | "muted" | "warning";

const TONES: Readonly<Record<Tone, string>> = {
  accent: "\u001b[36m",
  error: "\u001b[31m",
  success: "\u001b[32m",
  muted: "\u001b[90m",
  warning: "\u001b[33m",
};

function markColor(status: TaskStatus): Tone {
  switch (status) {
    case "in_progress":
      return "accent";
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "canceled":
      return "warning";
    case "waiting":
      return "muted";
  }
}

function style(text: string, tone: Tone, options: TreeOptions): string {
  return options.color ? `${TONES[tone]}${text}\u001b[39m` : text;
}

function dim(text: string, options: TreeOptions): string {
  return style(text, "muted", options);
}

function dimTree(text: string, options: TreeOptions): string {
  return text === "" ? "" : dim(text, options);
}

function padTo(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function fit(text: string, width: number): string {
  return truncateToWidth(text, Math.max(1, width), "…");
}
