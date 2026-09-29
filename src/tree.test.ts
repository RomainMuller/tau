import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { seedTaskList, type TaskList } from "./tasks/model.ts";
import { cancelTask, claimTask, completeTask, createTask, failTask, type Actor, type RuleContext } from "./tasks/rules.ts";
import { renderTree, type TreeOptions } from "./tree.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const ctx = (name = "lead"): RuleContext => ({ actor: { name } as Actor, now: NOW });

const PLAIN: TreeOptions = {
  showClosed: false,
  maxLines: 6,
  pills: false,
  color: false,
  width: 100,
  badge: "🟢 Herdr",
};

let list: TaskList;

/** The README example: T0, T1 done; T2 running with T2.1 running and T2.2 waiting; T3 waiting; T4 failed; T5 canceled. */
function readmeExample(): TaskList {
  const l = seedTaskList("s1", NOW);
  createTask(l, ctx(), { title: "Map the current login flow", type: "research" });
  createTask(l, ctx(), { title: "Add magic-link login endpoint", type: "code", dependencies: ["T1"] });
  createTask(l, ctx(), { title: "Update login page", type: "code", dependencies: ["T2"] });
  createTask(l, ctx(), { title: "Security review of token storage", type: "review" });
  createTask(l, ctx(), { title: "Add SMS login", type: "code" });
  claimTask(l, ctx(), "T0");
  completeTask(l, ctx(), "T0", "planned");
  claimTask(l, ctx("tau-t1"), "T1");
  completeTask(l, ctx("tau-t1"), "T1", "mapped");
  claimTask(l, ctx(), "T2");
  createTask(l, ctx(), { title: "Create login_tokens table", type: "code", parent: "T2", dependencies: ["T1"] });
  createTask(l, ctx(), { title: "Write endpoint tests", type: "test", parent: "T2", dependencies: ["T1", "T2.1"] });
  claimTask(l, ctx("tau-t2-1"), "T2.1");
  claimTask(l, ctx("tau-t4"), "T4");
  failTask(l, ctx("tau-t4"), "T4", "agent exited", true);
  cancelTask(l, ctx(), "T5", "not needed");
  return l;
}

beforeEach(() => {
  list = readmeExample();
});

describe("renderTree", () => {
  it("shows the badge alone when there is no task list", () => {
    assert.deepEqual(renderTree(undefined, PLAIN), ["🟢 Herdr"]);
  });

  it("hides completed and canceled tasks, and shows only open dependencies", () => {
    const lines = renderTree(list, PLAIN);
    assert.equal(lines[0], "🟢 Herdr ─ 2 waiting · 2 running · 2 done · 1 failed · 1 canceled");
    const rows = lines.slice(1).map((line) => line.replace(/ +/g, " "));
    assert.deepEqual(rows, [
      "├─ ◐ T2 Add magic-link login endpoint @lead",
      "│ ├─ ◐ T2.1 Create login_tokens table @tau-t2-1",
      "│ └─ ○ T2.2 Write endpoint tests ⧗ T2.1",
      "├─ ○ T3 Update login page ⧗ T2",
      "└─ ✖ T4 Security review of token storage @tau-t4 · agent exited",
    ]);
  });

  it("shows all tasks and all dependencies when closed tasks show", () => {
    const rows = renderTree(list, { ...PLAIN, showClosed: true, maxLines: 20 })
      .slice(1)
      .map((line) => line.replace(/ +/g, " "));
    assert.deepEqual(rows, [
      "├─ ✔ T0 Prepare task list @lead",
      "├─ ✔ T1 Map the current login flow @tau-t1",
      "├─ ◐ T2 Add magic-link login endpoint @lead ⧗ T1✔",
      "│ ├─ ◐ T2.1 Create login_tokens table @tau-t2-1 ⧗ T1✔",
      "│ └─ ○ T2.2 Write endpoint tests ⧗ T1✔ T2.1",
      "├─ ○ T3 Update login page ⧗ T2",
      "├─ ✖ T4 Security review of token storage @tau-t4 · agent exited",
      "└─ ⊘ T5 Add SMS login canceled",
    ]);
  });

  it("aligns the extras of all rows in one column", () => {
    const rows = renderTree(list, PLAIN).slice(1);
    const columns = rows.map((row) => visibleWidth(row.slice(0, row.search(/[@⧗]/u))));
    assert.equal(new Set(columns).size, 1, rows.join("\n"));
    assert.ok(rows.every((row) => visibleWidth(row) <= PLAIN.width));
  });

  it("omits counts of 0 in the header", () => {
    const fresh = seedTaskList("s1", NOW);
    assert.equal(renderTree(fresh, PLAIN)[0], "🟢 Herdr ─ 1 waiting");
  });

  it("shows at most maxLines tasks, then tells how many more", () => {
    const big = seedTaskList("s1", NOW);
    for (let i = 1; i <= 12; i++) createTask(big, ctx(), { title: `Task ${i}`, type: "code" });
    const lines = renderTree(big, PLAIN);
    assert.equal(lines.length, 1 + 6 + 1);
    assert.equal(lines.at(-1), "└─ … 7 more (/tau to see all)");
  });

  it("hides a completed parent and its failed sub-tasks", () => {
    const l = seedTaskList("s1", NOW);
    createTask(l, ctx(), { title: "Sub", type: "code", parent: "T0" });
    claimTask(l, ctx(), "T0");
    claimTask(l, ctx(), "T0.1");
    failTask(l, ctx(), "T0.1", "broken", true);
    completeTask(l, ctx(), "T0", "done anyway");
    const rows = renderTree(l, PLAIN).slice(1).map((line) => line.replace(/ +/g, " "));
    assert.deepEqual(rows, []);
    const all = renderTree(l, { ...PLAIN, showClosed: true }).slice(1).map((line) => line.replace(/ +/g, " "));
    assert.deepEqual(all, ["└─ ✔ T0 Prepare task list @lead", " └─ ✖ T0.1 Sub @lead · broken"]);
  });

  it("fits each line in a narrow width", () => {
    for (const width of [20, 40, 60]) {
      for (const line of renderTree(list, { ...PLAIN, width, pills: true, color: true })) {
        assert.ok(visibleWidth(line) <= width, `width ${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`);
      }
    }
  });

  it("counts nested rows in the line limit", () => {
    const rows = renderTree(list, { ...PLAIN, maxLines: 2 }).slice(1);
    assert.deepEqual(
      rows.map((line) => line.replace(/ +/g, " ")),
      ["├─ ◐ T2 Add magic-link login endpoint @lead", "│ ├─ ◐ T2.1 Create login_tokens table @tau-t2-1", "└─ … 3 more (/tau to see all)"],
    );
  });

  it("shows dependency IDs as pills too", () => {
    const text = renderTree(list, { ...PLAIN, pills: true, showClosed: true, maxLines: 20 }).join("\n");
    assert.match(text, /⧗ \ue0b6T1\ue0b4 \ue0b6T2\.1\ue0b4/);
    assert.doesNotMatch(text, /✔/);
  });

  it("aligns the extras with pills in a narrow width", () => {
    const rows = renderTree(list, { ...PLAIN, pills: true, width: 60 }).slice(1);
    const columns = rows.map((row) => visibleWidth(row.slice(0, row.search(/[@⧗]/u))));
    assert.equal(new Set(columns).size, 1, rows.join("\n"));
    assert.ok(rows.every((row) => visibleWidth(row) <= 60));
  });

  it("shows IDs as pills, without the status mark", () => {
    const rows = renderTree(list, { ...PLAIN, pills: true }).slice(1);
    assert.match(rows[0] ?? "", /^├─ \ue0b6T2\ue0b4 +Add magic-link/);
    assert.doesNotMatch(rows.join("\n"), /[◐○✖✔⊘]/);
  });

  it("colors pills by status, with strikethrough for canceled tasks", () => {
    const rows = renderTree(list, { ...PLAIN, pills: true, color: true, showClosed: true, maxLines: 20 }).slice(1);
    const pill = (id: string) => rows.find((row) => row.includes(`${id}\u001b[29m`)) ?? "";
    assert.match(pill("T2"), /\u001b\[48;5;33m/); // blue: in progress
    assert.match(pill("T3"), /\u001b\[48;5;244m/); // gray: waiting
    assert.match(pill("T0"), /\u001b\[48;5;34m/); // green: completed
    assert.match(pill("T4"), /\u001b\[48;5;160m/); // red: failed
    assert.match(pill("T5"), /\u001b\[48;5;208m\u001b\[38;5;15m\u001b\[9m/); // orange, strikethrough
  });

  it("shows only the root task and its sub-tasks when root is set", () => {
    const lines = renderTree(list, { ...PLAIN, root: "T2" });
    assert.equal(lines[0], "🟢 Herdr ─ 1 waiting · 2 running");
    assert.deepEqual(
      lines.slice(1).map((line) => line.replace(/ +/g, " ")),
      [
        "└─ ◐ T2 Add magic-link login endpoint @lead",
        " ├─ ◐ T2.1 Create login_tokens table @tau-t2-1",
        " └─ ○ T2.2 Write endpoint tests ⧗ T2.1",
      ],
    );
  });

  it("does not take tasks with a similar ID prefix into the root scope", () => {
    const l = seedTaskList("s1", NOW);
    for (let i = 1; i <= 12; i++) createTask(l, ctx(), { title: `Task ${i}`, type: "code" });
    createTask(l, ctx(), { title: "Sub of T1", type: "code", parent: "T1" });
    const rows = renderTree(l, { ...PLAIN, root: "T1" }).slice(1).map((line) => line.replace(/ +/g, " "));
    assert.deepEqual(rows, ["└─ ○ T1 Task 1", " └─ ○ T1.1 Sub of T1"]);
  });

  it("shows the root task also when it is closed", () => {
    const rows = renderTree(list, { ...PLAIN, root: "T1" }).slice(1).map((line) => line.replace(/ +/g, " "));
    assert.deepEqual(rows, ["└─ ✔ T1 Map the current login flow @tau-t1"]);
  });

  it("hides the sub-tasks of a completed root, but shows the root", () => {
    const l = seedTaskList("s1", NOW);
    createTask(l, ctx(), { title: "Sub", type: "code", parent: "T0" });
    claimTask(l, ctx(), "T0");
    claimTask(l, ctx(), "T0.1");
    failTask(l, ctx(), "T0.1", "broken", true);
    completeTask(l, ctx(), "T0", "done anyway");
    const rows = renderTree(l, { ...PLAIN, root: "T0" }).slice(1).map((line) => line.replace(/ +/g, " "));
    assert.deepEqual(rows, ["└─ ✔ T0 Prepare task list @lead"]);
    const all = renderTree(l, { ...PLAIN, root: "T0", showClosed: true }).slice(1).map((line) => line.replace(/ +/g, " "));
    assert.deepEqual(all, ["└─ ✔ T0 Prepare task list @lead", " └─ ✖ T0.1 Sub @lead · broken"]);
  });

  it("shows a canceled root with its visible sub-tasks", () => {
    const l = seedTaskList("s1", NOW);
    createTask(l, ctx(), { title: "Sub", type: "code", parent: "T0" });
    createTask(l, ctx(), { title: "Done sub", type: "code", parent: "T0" });
    claimTask(l, ctx("tau-a"), "T0.1");
    failTask(l, ctx("tau-a"), "T0.1", "broken", true);
    claimTask(l, ctx("tau-b"), "T0.2");
    completeTask(l, ctx("tau-b"), "T0.2", "ok");
    cancelTask(l, ctx(), "T0", "not needed");
    const rows = renderTree(l, { ...PLAIN, root: "T0" }).slice(1).map((line) => line.replace(/ +/g, " "));
    assert.deepEqual(rows, ["└─ ⊘ T0 Prepare task list canceled", " └─ ✖ T0.1 Sub @tau-a · broken"]);
  });

  it("shows a nested root without its siblings or parent", () => {
    const lines = renderTree(list, { ...PLAIN, root: "T2.1" });
    assert.equal(lines[0], "🟢 Herdr ─ 1 running");
    assert.deepEqual(
      lines.slice(1).map((line) => line.replace(/ +/g, " ")),
      ["└─ ◐ T2.1 Create login_tokens table @tau-t2-1"],
    );
  });

  it("counts only the tasks of the root scope in the line limit", () => {
    const l = seedTaskList("s1", NOW);
    for (let i = 1; i <= 5; i++) createTask(l, ctx(), { title: `Top ${i}`, type: "code" });
    for (let i = 1; i <= 8; i++) createTask(l, ctx(), { title: `Sub ${i}`, type: "code", parent: "T1" });
    const lines = renderTree(l, { ...PLAIN, root: "T1" });
    assert.equal(lines[0], "🟢 Herdr ─ 9 waiting");
    assert.equal(lines.length, 1 + 6 + 1);
    assert.equal(lines.at(-1), "└─ … 3 more (/tau to see all)");
  });

  it("shows mail on a task line in the root scope", () => {
    const lines = renderTree(list, { ...PLAIN, root: "T2", unread: new Map([["tau-t2-1", 4]]) });
    assert.equal(lines[0], "🟢 Herdr ─ 1 waiting · 2 running");
    assert.match(lines[2] ?? "", /T2\.1 .*@tau-t2-1 ✉4/);
  });

  it("shows mail in the header for an owner in scope whose active task is out of scope", () => {
    const l = seedTaskList("s1", NOW);
    createTask(l, ctx(), { title: "Sub", type: "code", parent: "T0" });
    createTask(l, ctx(), { title: "Elsewhere", type: "code" });
    claimTask(l, ctx("tau-t0"), "T0");
    claimTask(l, ctx("lead"), "T0.1");
    completeTask(l, ctx("lead"), "T0.1", "ok");
    claimTask(l, ctx("lead"), "T1");
    const header = renderTree(l, { ...PLAIN, root: "T0", unread: new Map([["lead", 2]]) })[0];
    assert.equal(header, "🟢 Herdr ─ 1 running · 1 done · @lead ✉2");
    // Without a root, the mail shows on the line of T1, not in the header.
    assert.doesNotMatch(renderTree(l, { ...PLAIN, unread: new Map([["lead", 2]]) })[0] ?? "", /✉/);
  });

  it("shows only the badge when the root task does not exist", () => {
    assert.deepEqual(renderTree(list, { ...PLAIN, root: "T9" }), ["🟢 Herdr"]);
  });

  it("shows header mail only for the agents of the root scope", () => {
    const unread = new Map([
      ["tau-t1", 2],
      ["tau-t4", 3],
    ]);
    assert.match(renderTree(list, { ...PLAIN, unread })[0] ?? "", /@tau-t1 ✉2 · @tau-t4 ✉3/);
    const scoped = renderTree(list, { ...PLAIN, unread, root: "T1" })[0] ?? "";
    assert.match(scoped, /@tau-t1 ✉2/);
    assert.doesNotMatch(scoped, /tau-t4/);
  });

  it("removes control characters from titles, owners, and results", () => {
    const l = seedTaskList("s1", NOW);
    claimTask(l, ctx("evil\u001b[2J"), "T0");
    failTask(l, ctx("evil\u001b[2J"), "T0", "boom\u001b]0;title\u0007!", true);
    const text = renderTree(l, PLAIN).join("\n");
    assert.doesNotMatch(text, /\u001b|\u0007/u);
    assert.match(text, /@evil · boom!/);
  });
});
