import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { badgeText, WIDGET_KEY, widgetLines } from "./badge.ts";

const AVAILABLE = { available: true, binary: "/opt/herdr/bin/herdr", pane: { paneId: "w1:p1", tabId: undefined, workspaceId: undefined } } as const;
const UNAVAILABLE = { available: false, reason: "HERDR_ENV is not set to 1" } as const;

describe("badge", () => {
  it("uses the widget key 'tau'", () => {
    assert.equal(WIDGET_KEY, "tau");
  });

  it("shows a green badge when herdr is available", () => {
    assert.equal(badgeText(AVAILABLE), "🟢 Herdr");
    assert.deepEqual(widgetLines(AVAILABLE), ["🟢 Herdr"]);
  });

  it("shows a red badge when herdr is not available", () => {
    assert.equal(badgeText(UNAVAILABLE), "🔴 Herdr unavailable");
    assert.deepEqual(widgetLines(UNAVAILABLE), ["🔴 Herdr unavailable"]);
  });
});
