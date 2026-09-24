import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ancestorIds, isDescendant, isInSubtree, isTaskId, parentId } from "./model.ts";

describe("task IDs", () => {
  for (const id of ["T0", "T1", "T12", "T0.1", "T2.10.3"]) {
    it(`accepts ${id}`, () => assert.equal(isTaskId(id), true));
  }
  for (const id of ["", "T", "t1", "T01", "T1.0", "T1.", "T.1", "T1..2", "T-1", "T1 ", "../T1"]) {
    it(`rejects ${JSON.stringify(id)}`, () => assert.equal(isTaskId(id), false));
  }

  it("finds parents and ancestors", () => {
    assert.equal(parentId("T1"), undefined);
    assert.equal(parentId("T1.2.3"), "T1.2");
    assert.deepEqual(ancestorIds("T1.2.3"), ["T1.2", "T1"]);
  });

  it("does not take T1 as a descendant of T12 or the reverse", () => {
    assert.equal(isDescendant("T12", "T1"), false);
    assert.equal(isDescendant("T1.2", "T1"), true);
    assert.equal(isDescendant("T1", "T1"), false);
    assert.equal(isInSubtree("T1", "T1"), true);
    assert.equal(isInSubtree("T10.1", "T1"), false);
  });
});
