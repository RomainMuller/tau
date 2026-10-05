/**
 * The identifiers of the stickies that tau found, in a directory of the tau
 * directory (`sticky-devices/`): one empty file for each sticky, with the
 * identifier as its name. The time of the last change of a file tells when
 * tau last saw the sticky. All the pi processes of the user share the
 * directory.
 *
 * A sticky does not advertise while a device is connected to it. On macOS, a
 * process can still connect to it with its identifier (CoreBluetooth shares
 * the link). Thus a sub-agent that starts while its lead is connected finds
 * the sticky in this directory, not with a scan.
 *
 * One file for each sticky: two processes that add different stickies at
 * the same time write different files, so no identifier gets lost (a single
 * file needs a read, a change, and a write, and the last writer wins).
 *
 * The directory is only a hint: problems give an empty list. The identifiers
 * are CoreBluetooth identifiers, as noble gives them (32 hexadecimal digits).
 */

import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEVICES_DIR = "sticky-devices";
/** The maximum number of identifiers. The newest stay. */
export const MAX_DEVICES = 16;
const DEVICE_ID = /^[0-9a-f]{32}$/;

export function isDeviceId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID.test(value);
}

export class DeviceCache {
  readonly #dir: string;

  constructor(tauDirectory: string) {
    this.#dir = join(tauDirectory, DEVICES_DIR);
  }

  /** The identifiers, the newest last. Never throws. */
  async read(): Promise<string[]> {
    return (await this.#entries()).slice(-MAX_DEVICES).map((entry) => entry.id);
  }

  /** Adds an identifier, or marks it as the newest. Never throws. */
  async add(id: string): Promise<void> {
    if (!isDeviceId(id)) return;
    try {
      await mkdir(this.#dir, { recursive: true, mode: 0o700 });
      // A new write changes the time of the file: the identifier is the newest.
      await writeFile(join(this.#dir, id), "", { mode: 0o600 });
    } catch {
      return;
    }
    // Remove the oldest identifiers.
    const entries = await this.#entries();
    for (const entry of entries.slice(0, Math.max(0, entries.length - MAX_DEVICES))) {
      await rm(join(this.#dir, entry.id), { force: true }).catch(() => undefined);
    }
  }

  /** The valid entries, the oldest first. */
  async #entries(): Promise<Array<{ id: string; time: number }>> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return [];
    }
    const entries: Array<{ id: string; time: number }> = [];
    for (const name of names) {
      if (!isDeviceId(name)) continue;
      try {
        const info = await lstat(join(this.#dir, name));
        if (info.isFile()) entries.push({ id: name, time: info.mtimeMs });
      } catch {
        // Removed by a different process.
      }
    }
    return entries.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  }
}
