/**
 * The Bluetooth LE protocol of the Sticky devices (protocol version 1). See
 * the README of `tools/sticky-cli` in the sticky repository, section "The
 * Bluetooth protocol".
 *
 * All the functions here are pure: they only make and check byte values.
 */

/** The sticky service. The characteristics change the `0000` part. */
export const SERVICE_UUID = "ce3d00001daa4212aeec87a954240112";
export const PROTOCOL_VERSION_UUID = "ce3d00011daa4212aeec87a954240112";
export const METADATA_KEYS_UUID = "ce3d00021daa4212aeec87a954240112";
export const AGENT_STATE_UUID = "ce3d00031daa4212aeec87a954240112";
export const AGENT_METADATA_UUID = "ce3d00041daa4212aeec87a954240112";

/** The only protocol version that tau knows. */
export const PROTOCOL_VERSION = 1;

/** The states of an agent, and their codes. */
export const STATE_CODES = {
  terminated: 0,
  idle: 1,
  working: 2,
  question: 3,
  waiting: 4,
  error: 5,
} as const;

export type AgentState = keyof typeof STATE_CODES;

/** The metadata keys of version 1. A sticky tells its own list (`Metadata Keys`). */
export type MetadataKey = "name" | "workspace" | "parent" | "model";

export const MAX_SESSION_ID_BYTES = 64;
export const MAX_VALUE_BYTES = 255;
export const MAX_METADATA_BYTES = 512;

/**
 * Makes a value that the sticky accepts as UTF-8 text: removes the control
 * characters (Unicode category `Cc`), and cuts the value to `maxBytes` bytes
 * of UTF-8, at the end of a full character.
 */
export function stickyText(value: string, maxBytes: number): string {
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  let bytes = 0;
  let result = "";
  for (const char of clean) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    result += char;
  }
  return result;
}

/** True when `id` is a session ID that the sticky accepts: 1 to 64 bytes of UTF-8 text. */
export function isSessionId(id: string): boolean {
  const size = Buffer.byteLength(id, "utf8");
  return size >= 1 && size <= MAX_SESSION_ID_BYTES && stickyText(id, MAX_SESSION_ID_BYTES) === id;
}

function sessionPrefix(sessionId: string): Buffer {
  if (!isSessionId(sessionId)) throw new RangeError(`Not a sticky session ID: ${JSON.stringify(sessionId)}`);
  const id = Buffer.from(sessionId, "utf8");
  return Buffer.concat([Buffer.from([id.length]), id]);
}

/** The value of an Agent State write: `L`, the session ID, the state code. */
export function encodeState(sessionId: string, state: AgentState): Buffer {
  return Buffer.concat([sessionPrefix(sessionId), Buffer.from([STATE_CODES[state]])]);
}

/**
 * The values of the Agent Metadata writes for the entries. An empty value
 * removes the key. Values are cut to their limits (see `stickyText`).
 *
 * One write has 512 bytes at most. When the entries do not fit in one write,
 * the result has more writes (each entry is complete in one write).
 * Returns no write for no entries.
 */
export function encodeMetadata(sessionId: string, entries: ReadonlyArray<readonly [string, string]>): Buffer[] {
  const prefix = sessionPrefix(sessionId);
  const writes: Buffer[] = [];
  let current: Buffer[] = [];
  let size = prefix.length;
  for (const [key, value] of entries) {
    const keyBytes = Buffer.from(key, "utf8");
    if (keyBytes.length < 1 || keyBytes.length > 16) throw new RangeError(`Not a metadata key: ${JSON.stringify(key)}`);
    const limit = key === "parent" ? MAX_SESSION_ID_BYTES : MAX_VALUE_BYTES;
    const valueBytes = Buffer.from(stickyText(value, limit), "utf8");
    const entry = Buffer.concat([Buffer.from([keyBytes.length]), keyBytes, Buffer.from([valueBytes.length]), valueBytes]);
    // 1 + 64 + 1 + 16 + 1 + 255 < 512: one entry always fits in one write.
    if (current.length > 0 && size + entry.length > MAX_METADATA_BYTES) {
      writes.push(Buffer.concat([prefix, ...current]));
      current = [];
      size = prefix.length;
    }
    current.push(entry);
    size += entry.length;
  }
  if (current.length > 0) writes.push(Buffer.concat([prefix, ...current]));
  return writes;
}

/** Reads the Protocol Version value (an unsigned 16-bit integer, little-endian). */
export function decodeProtocolVersion(value: Buffer): number | undefined {
  return value.length === 2 ? value.readUInt16LE(0) : undefined;
}

/** Reads the Metadata Keys value: keys separated by commas. */
export function decodeMetadataKeys(value: Buffer): ReadonlySet<string> {
  return new Set(
    value
      .toString("utf8")
      .split(",")
      .filter((key) => key !== ""),
  );
}
