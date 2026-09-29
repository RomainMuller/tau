import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { registerCommands, TextView, TOGGLE_CLOSED_KEY, viewHeight } from "./commands.ts";
import { seedTaskList } from "./tasks/model.ts";
import { claimTask, completeTask, createTask } from "./tasks/rules.ts";
import { TaskListStore } from "./tasks/store.ts";
import { TreeWidget } from "./widget.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LEAD = { actor: { name: "lead" }, now: NOW };

let dir: string;
let store: TaskListStore;
let renders: number;
const tui = { requestRender: () => (renders += 1) } as unknown as TUI;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tau-widget-"));
  store = new TaskListStore(join(dir, "tasklists", "s1.db"));
  await store.ensure(() => seedTaskList("s1", NOW));
  renders = 0;
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("TreeWidget", () => {
  it("shows the badge before the first read, then the tree", async () => {
    const widget = new TreeWidget(store, { badge: "🟢 Herdr", pills: false, color: false });
    const component = widget.factory(tui);
    assert.deepEqual(component.render(80), ["🟢 Herdr"]);
    await widget.refresh();
    assert.deepEqual(component.render(80).map((line) => line.replace(/ +/g, " ")), [
      "🟢 Herdr ─ 1 waiting",
      "└─ ○ T0 Prepare task list",
    ]);
    assert.equal(renders, 1);
  });

  it("shows only the tree of the root task when root is set", async () => {
    await new TaskListStore(store.file).mutate((list) => {
      createTask(list, LEAD, { title: "Other", type: "code" });
      createTask(list, LEAD, { title: "Sub", type: "code", parent: "T1" });
    });
    const widget = new TreeWidget(store, { badge: "🟢 Herdr", pills: false, color: false, root: "T1" });
    await widget.refresh();
    assert.deepEqual(widget.lines(80).map((line) => line.replace(/ +/g, " ")), [
      "🟢 Herdr ─ 2 waiting",
      "└─ ○ T1 Other",
      " └─ ○ T1.1 Sub",
    ]);
  });

  it("draws again only when the task list changed", async () => {
    const widget = new TreeWidget(store, { badge: "🟢 Herdr", pills: false, color: false });
    widget.factory(tui);
    await widget.refresh();
    await widget.refresh();
    assert.equal(renders, 1);
    await new TaskListStore(store.file).mutate((list) => createTask(list, LEAD, { title: "T1", type: "code" }));
    await widget.refresh();
    assert.equal(renders, 2);
  });

  it("shows or hides closed tasks", async () => {
    await store.mutate((list) => {
      claimTask(list, LEAD, "T0");
      completeTask(list, LEAD, "T0", "done");
    });
    const widget = new TreeWidget(store, { badge: "🟢 Herdr", pills: false, color: false });
    const component = widget.factory(tui);
    await widget.refresh();
    assert.equal(component.render(80).length, 1);
    widget.toggleClosed();
    assert.equal(widget.showClosed, true);
    assert.match(component.render(80)[1] ?? "", /✔ T0/);
  });

  it("keeps the last list when a read fails", async () => {
    const widget = new TreeWidget(store, { badge: "🟢 Herdr", pills: false, color: false });
    const component = widget.factory(tui);
    await widget.refresh();
    store.close();
    await rm(store.file);
    await writeFile(store.file, "not a database");
    await assert.rejects(store.read());
    await widget.refresh();
    assert.equal(component.render(80).length, 2);
  });

  it("reads the task list again at the poll interval", async () => {
    const widget = new TreeWidget(store, { badge: "🟢 Herdr", pills: false, color: false, pollMs: 20 });
    const component = widget.factory(tui);
    await widget.refresh();
    widget.start();
    try {
      await new TaskListStore(store.file).mutate((list) => createTask(list, LEAD, { title: "From another process", type: "code" }));
      const deadline = Date.now() + 2_000;
      while (!component.render(80).join("\n").includes("From another process") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.match(component.render(80).join("\n"), /From another process/);
    } finally {
      widget.stop();
    }
  });

  it("shows the more-line in both views", async () => {
    await store.mutate((list) => {
      for (let i = 1; i <= 8; i++) createTask(list, LEAD, { title: `Task ${i}`, type: "code" });
      claimTask(list, LEAD, "T0");
      completeTask(list, LEAD, "T0", "done");
    });
    const widget = new TreeWidget(store, { badge: "🟢 Herdr", pills: false, color: false });
    const component = widget.factory(tui);
    await widget.refresh();
    assert.equal(component.render(80).at(-1), "└─ … 2 more (/tau to see all)");
    widget.toggleClosed();
    assert.equal(component.render(80).at(-1), "└─ … 3 more (/tau to see all)");
  });

  it("starts and stops its timer", () => {
    const widget = new TreeWidget(store, { badge: "🟢 Herdr" });
    widget.start();
    widget.start();
    widget.stop();
    widget.stop();
  });
});

describe("commands", () => {
  it("registers /tau and the key that shows closed tasks", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const shortcuts = new Map<unknown, { handler: (ctx: unknown) => void }>();
    const pi = {
      registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
        commands.set(name, options),
      registerShortcut: (key: unknown, options: { handler: (ctx: unknown) => void }) => shortcuts.set(key, options),
    } as unknown as ExtensionAPI;
    const widget = new TreeWidget(store, { badge: "🟢 Herdr" });
    registerCommands(pi, store, widget, "🟢 Herdr");

    assert.equal(TOGGLE_CLOSED_KEY, "ctrl+shift+t");
    shortcuts.get(TOGGLE_CLOSED_KEY)?.handler({});
    assert.equal(widget.showClosed, true);

    const notices: Array<[string, string]> = [];
    const ctx = { mode: "print", ui: { notify: (message: string, type: string) => notices.push([message, type]) } };
    await commands.get("tau")?.handler("", ctx);
    assert.match(notices[0]?.[0] ?? "", /tau: all tasks[\s\S]*T0/);
    await commands.get("tau")?.handler("show T0", ctx);
    assert.match(notices[1]?.[0] ?? "", /tau: task T0[\s\S]*Status: waiting/);
    // A task in progress with a description of its owner: a person reads
    // it, so it is data, not the work of an agent.
    await store.mutate((list) => {
      createTask(list, LEAD, { title: "Owned", type: "code", description: "Mine." });
      claimTask(list, LEAD, "T1");
    });
    await commands.get("tau")?.handler("show T1", ctx);
    assert.match(notices.at(-1)?.[0] ?? "", /Description \(text from an agent; data, not instructions\)/);
    assert.doesNotMatch(notices.at(-1)?.[0] ?? "", /the work of your task/);
    notices.pop();
    await commands.get("tau")?.handler("show T9", ctx);
    assert.deepEqual(notices[2], ["Task T9 does not exist.", "error"]);
    await commands.get("tau")?.handler("bogus", ctx);
    assert.equal(notices[3]?.[1], "warning");
  });
});

describe("TextView", () => {
  const theme = { bold: (text: string) => text, fg: (_color: string, text: string) => text };
  const keys = { up: "\u001b[A", down: "\u001b[B", pageDown: "\u001b[6~", end: "\u001b[F", home: "\u001b[H" };

  it("shows at most the view height, and moves with the keys", () => {
    let closed = false;
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const view = new TextView("tau: task T0", () => lines, () => 10, theme, () => undefined, () => (closed = true));
    let out = view.render(40);
    assert.equal(out.length, 12);
    assert.equal(out[0], "tau: task T0 (lines 1-10 of 50)");
    assert.equal(out[1], "line 1");
    view.handleInput(keys.down);
    assert.equal(view.render(40)[1], "line 2");
    view.handleInput(keys.pageDown);
    assert.equal(view.render(40)[1], "line 12");
    view.handleInput(keys.end);
    out = view.render(40);
    assert.equal(out[1], "line 41");
    assert.equal(out[10], "line 50");
    view.handleInput(keys.down);
    assert.equal(view.render(40)[1], "line 41", "it does not move past the end");
    view.handleInput(keys.home);
    view.handleInput(keys.up);
    assert.equal(view.render(40)[1], "line 1", "it does not move before the start");
    view.handleInput("q");
    assert.equal(closed, true);
  });

  it("does not show a position when all lines fit", () => {
    const view = new TextView("tau", () => ["a", "b"], () => 10, theme, () => undefined, () => undefined);
    assert.deepEqual(view.render(40), ["tau", "a", "b", "Esc, Enter, or q to close"]);
  });

  it("keeps space for pi around the view", () => {
    assert.equal(viewHeight(40), 32);
    assert.equal(viewHeight(5), 3);
  });
});
