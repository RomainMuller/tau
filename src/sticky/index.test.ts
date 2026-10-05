import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isSessionId } from "./protocol.ts";
import { stickySessionId } from "./index.ts";

describe("stickySessionId", () => {
  it("is the same for the path of the lead and the real path of a sub-agent", () => {
    // The lead can have a path with a symbolic link; a sub-agent gets the real path.
    assert.equal(
      stickySessionId("/Users/me/.pi/tau/tasklists/session-1.db", "lead"),
      stickySessionId("/Volumes/data/pi/tau/tasklists/session-1.db", "lead"),
    );
  });

  it("is different for different task lists and agents", () => {
    const ids = new Set([
      stickySessionId("/t/session-1.db", "lead"),
      stickySessionId("/t/session-2.db", "lead"),
      stickySessionId("/t/session-1.db", "tau-t1"),
    ]);
    assert.equal(ids.size, 3);
  });

  it("is a valid sticky session ID for the longest agent name", () => {
    const id = stickySessionId("/t/session-1.db", `tau-${"x".repeat(28)}`);
    assert.equal(id.length, 49);
    assert.equal(isSessionId(id), true);
  });
});
