import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decodeMetadataKeys,
  decodeProtocolVersion,
  encodeMetadata,
  encodeState,
  isSessionId,
  MAX_METADATA_BYTES,
  stickyText,
} from "./protocol.ts";

describe("encodeState", () => {
  it("gives the example of the protocol", () => {
    // README: the session ID `s-1` is now `working`.
    assert.equal(encodeState("s-1", "working").toString("hex"), "03732d3102");
  });

  it("has the codes of all states", () => {
    const codes = (["terminated", "idle", "working", "question", "waiting", "error"] as const).map(
      (state) => encodeState("a", state).at(-1),
    );
    assert.deepEqual(codes, [0, 1, 2, 3, 4, 5]);
  });

  it("refuses a session ID that is empty, too long, or has control characters", () => {
    assert.throws(() => encodeState("", "idle"), RangeError);
    assert.throws(() => encodeState("x".repeat(65), "idle"), RangeError);
    assert.throws(() => encodeState("a\nb", "idle"), RangeError);
    assert.equal(encodeState("x".repeat(64), "idle").length, 66);
  });
});

describe("encodeMetadata", () => {
  it("gives the example of the protocol", () => {
    // README: for `s-1`, set `name` to `Claude` and remove `model`.
    const writes = encodeMetadata("s-1", [
      ["name", "Claude"],
      ["model", ""],
    ]);
    assert.deepEqual(
      writes.map((value) => value.toString("hex")),
      ["03732d31" + "046e616d6506436c61756465" + "056d6f64656c00"],
    );
  });

  it("gives no write for no entries", () => {
    assert.deepEqual(encodeMetadata("s", []), []);
  });

  it("cuts values to 255 bytes, and a parent to 64 bytes, at a character boundary", () => {
    const [value] = encodeMetadata("s", [["name", "é".repeat(200)]]);
    // 1 + 1 (session) + 1 + 4 (key) + 1 (V) + 254 (127 × 2 bytes: one more is 256).
    assert.equal(value![7], 254);
    assert.equal(value!.length, 8 + 254);
    const [parent] = encodeMetadata("s", [["parent", "p".repeat(100)]]);
    assert.equal(parent![9], 64);
  });

  it("splits the entries into writes of 512 bytes at most", () => {
    const long = "w".repeat(255);
    const entries: Array<[string, string]> = [
      ["name", long],
      ["workspace", long],
      ["model", long],
    ];
    const writes = encodeMetadata("x".repeat(64), entries);
    // 65 + 261 + 266 > 512, and 65 + 266 + 262 > 512: one entry in each write.
    assert.equal(writes.length, 3);
    for (const value of writes) {
      assert.ok(value.length <= MAX_METADATA_BYTES, `${value.length} bytes`);
      // Each write starts with the session ID.
      assert.equal(value[0], 64);
    }
  });

  it("refuses a bad key", () => {
    assert.throws(() => encodeMetadata("s", [["", "x"]]), RangeError);
    assert.throws(() => encodeMetadata("s", [["k".repeat(17), "x"]]), RangeError);
  });
});

describe("stickyText", () => {
  it("removes the control characters (C0, DEL, and C1)", () => {
    assert.equal(stickyText("a\u0000b\tc\u007fd\u0085e", 100), "abcde");
  });

  it("does not cut a character", () => {
    assert.equal(stickyText("aé", 2), "a");
    assert.equal(stickyText("😀x", 3), "");
  });
});

describe("isSessionId", () => {
  it("checks the length in bytes", () => {
    assert.equal(isSessionId("é".repeat(32)), true);
    assert.equal(isSessionId("é".repeat(33)), false);
  });
});

describe("decoders", () => {
  it("reads the protocol version (little-endian)", () => {
    assert.equal(decodeProtocolVersion(Buffer.from([1, 0])), 1);
    assert.equal(decodeProtocolVersion(Buffer.from([0, 1])), 256);
    assert.equal(decodeProtocolVersion(Buffer.from([1])), undefined);
  });

  it("reads the metadata keys", () => {
    assert.deepEqual([...decodeMetadataKeys(Buffer.from("name,workspace,parent,model"))], ["name", "workspace", "parent", "model"]);
    assert.deepEqual([...decodeMetadataKeys(Buffer.from(""))], []);
  });
});
