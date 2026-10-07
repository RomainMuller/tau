/**
 * The process record of a tau runtime, and the check of the process record
 * of a different agent (the probe).
 *
 * Each tau process writes its process record in the task list (see
 * `ProcessRecord`): its PID, its start time, its machine, and a random token.
 * A different tau process uses the record to know if the process still runs.
 * The start time makes sure that a new process with the same PID (the
 * operating system uses PIDs again) is not the old process.
 *
 * The start time:
 *
 * - Linux: tau reads `/proc/<pid>/stat` (field 22, the start time in clock
 *   ticks after the boot), and the boot ID. The text is
 *   `linux:<boot ID>:<ticks>`.
 * - macOS and other systems: tau runs `ps -o pid=,stat=,lstart= -p <pids>`
 *   with a fixed format and time zone, for at most `MAX_PS_PIDS` PIDs in
 *   one call. The text is `ps:<lstart>`.
 * - Windows, or when the reads fail: tau does not know the start time.
 *
 * The same reads give the state of the process. A zombie (state `Z` or `X`)
 * is dead: the process stopped, and only its parent did not collect it yet.
 *
 * The machine: the host name, and on Linux also the machine ID
 * (`/etc/machine-id` or `/var/lib/dbus/machine-id`, when tau can read it)
 * and the PID namespace. On macOS and other systems, it is only the host
 * name. Two computers with the same host name (and no machine ID) have the
 * same machine text: so tau does not support a `tasklists` directory that
 * two computers share.
 *
 * When tau cannot know, the result is `unknown`, and `unknown` is always
 * "alive" for all decisions.
 */

import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { MAX_PROCESS_TEXT_CHARS, type ProcessRecord } from "./tasks/model.ts";

/** The result of a probe. */
export type ProbeResult = "alive" | "dead" | "unknown";

/**
 * A process must be `dead` for this time before a different process ends
 * its sub-agents, in milliseconds. This gives time to a lead that restarts
 * (`/reload`, a restart after an upgrade, `pi -c`).
 */
export const ORPHAN_GRACE_MS = 120_000;

/** The maximum time of one `ps` call, in milliseconds. */
const PS_TIMEOUT_MS = 2_000;
/** The maximum number of PIDs in one `ps` call. tau makes more calls for more PIDs. */
export const MAX_PS_PIDS = 100;
/** The files that can contain the machine ID on Linux, in this order. */
const MACHINE_ID_FILES = ["/etc/machine-id", "/var/lib/dbus/machine-id"];

export interface ProcessProbe {
  /** The process record of this runtime. tau reads it one time, at the first call. */
  self(): Promise<ProcessRecord>;
  /**
   * The probe of many records in one call (on macOS, one `ps` call for all
   * the PIDs that exist). The rules, in this order:
   *
   * 1. No record: `unknown`.
   * 2. A different machine: `unknown`.
   * 3. `detachedAt` is set: `dead`.
   * 4. The record of this runtime: `alive`.
   * 5. `kill(pid, 0)`: `ESRCH` is `dead`, `EPERM` continues, a different
   *    error is `unknown`.
   * 6. No start time in the record: `unknown`.
   * 7. The process with the PID is a zombie: `dead`.
   * 8. tau cannot read the start time now: `unknown`.
   * 9. A different start time: `dead` (a new process has the PID).
   * 10. Else `alive`.
   */
  probe(records: readonly ProcessRecord[]): Promise<Map<ProcessRecord, ProbeResult>>;
  /**
   * A cheap probe: only the rules that do not read the start time (no `ps`
   * call, no file read). A PID that exists is `alive`. `unknown` before the
   * first `self()` call completed.
   */
  quickProbe(record: ProcessRecord | undefined): ProbeResult;
}

/** Things that tests can replace. */
export interface SystemProbeOptions {
  /** The current time, as an ISO 8601 text. */
  readonly now?: () => string;
  /** The PID of this process. */
  readonly pid?: number;
  readonly platform?: NodeJS.Platform;
  readonly hostname?: () => string;
  /** Makes the token of this runtime. */
  readonly token?: () => string;
  /** `process.kill(pid, 0)`: throws `ESRCH` when the process does not exist. */
  readonly kill?: (pid: number) => void;
  readonly readFile?: (path: string) => Promise<string>;
  readonly readlink?: (path: string) => Promise<string>;
  /**
   * Runs `ps -o pid=,stat=,lstart= -p <pids>` with `LC_ALL=C` and `TZ=UTC0`,
   * and returns its output. `undefined` when it cannot run. tau gives it at
   * most `MAX_PS_PIDS` PIDs.
   */
  readonly ps?: (pids: readonly number[]) => Promise<string | undefined>;
}

/** The probe of the processes of this computer. */
export function systemProbe(options: SystemProbeOptions = {}): ProcessProbe {
  const now = options.now ?? (() => new Date().toISOString());
  const pid = options.pid ?? process.pid;
  const platform = options.platform ?? process.platform;
  const kill = options.kill ?? ((target: number) => void process.kill(target, 0));
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"));
  const link = options.readlink ?? ((path: string) => readlink(path));
  const ps = options.ps ?? runPs;
  const token = (options.token ?? randomUUID)();

  let bootId: Promise<string | undefined> | undefined;
  const linuxBootId = () =>
    (bootId ??= read("/proc/sys/kernel/random/boot_id").then(
      (text) => {
        const id = text.trim();
        return /^[0-9A-Za-z-]{1,64}$/u.test(id) ? id : undefined;
      },
      () => undefined,
    ));

  /** The start times and states of the processes that tau can read now, by PID. */
  const startTimes = async (pids: readonly number[]): Promise<Map<number, ProcessState>> => {
    const result = new Map<number, ProcessState>();
    if (pids.length === 0 || platform === "win32") return result;
    if (platform === "linux") {
      const boot = await linuxBootId();
      if (boot !== undefined) {
        for (const item of pids) {
          const stat = await read(`/proc/${item}/stat`).then(parseProcStat, () => undefined);
          if (stat !== undefined) result.set(item, { start: `linux:${boot}:${stat.ticks}`, zombie: isZombie(stat.state) });
        }
        return result;
      }
      // No /proc: use ps, as on macOS.
    }
    const wanted = new Set(pids);
    for (let index = 0; index < pids.length; index += MAX_PS_PIDS) {
      const output = await ps(pids.slice(index, index + MAX_PS_PIDS)).catch(() => undefined);
      if (output === undefined) continue;
      for (const [item, line] of parsePsOutput(output)) {
        if (wanted.has(item)) result.set(item, { start: `ps:${line.start}`, zombie: isZombie(line.state) });
      }
    }
    return result;
  };

  let selfValue: ProcessRecord | undefined;
  let selfRecord: Promise<ProcessRecord> | undefined;
  const self = () =>
    (selfRecord ??= (async () => {
      let machineId: string | undefined;
      let namespace: string | undefined;
      if (platform === "linux") {
        for (const path of MACHINE_ID_FILES) {
          machineId = await read(path).then(parseMachineId, () => undefined);
          if (machineId !== undefined) break;
        }
        namespace = await link("/proc/self/ns/pid").catch(() => undefined);
      }
      const machine = composeMachine(options.hostname?.() ?? hostname(), machineId, namespace);
      const start = (await startTimes([pid]).catch(() => new Map<number, ProcessState>())).get(pid)?.start;
      const record: ProcessRecord = {
        pid,
        ...(start === undefined || [...start].length > MAX_PROCESS_TEXT_CHARS ? {} : { start }),
        machine,
        token,
        attachedAt: now(),
      };
      selfValue = record;
      return record;
    })());

  /** Rules 1 to 5 (see `ProcessProbe.probe`). `check` means: the PID exists, check the start time. */
  const cheap = (record: ProcessRecord | undefined, me: ProcessRecord): ProbeResult | "check" => {
    if (record === undefined) return "unknown";
    if (record.machine !== me.machine) return "unknown";
    if (record.detachedAt !== undefined) return "dead";
    if (record.pid === me.pid && record.token === me.token) return "alive";
    try {
      kill(record.pid);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return "dead";
      // EPERM: the process exists, but belongs to a different user.
      if (code !== "EPERM") return "unknown";
    }
    return "check";
  };

  return {
    self,
    quickProbe(record) {
      if (selfValue === undefined) return "unknown";
      const result = cheap(record, selfValue);
      return result === "check" ? "alive" : result;
    },
    async probe(records) {
      const me = await self();
      const result = new Map<ProcessRecord, ProbeResult>();
      const toCheck: ProcessRecord[] = [];
      for (const record of records) {
        const outcome = cheap(record, me);
        if (outcome !== "check") result.set(record, outcome);
        else if (record.start === undefined) result.set(record, "unknown");
        else toCheck.push(record);
      }
      const states = await startTimes([...new Set(toCheck.map((record) => record.pid))]).catch(
        () => new Map<number, ProcessState>(),
      );
      for (const record of toCheck) {
        const current = states.get(record.pid);
        // A zombie is dead: also when it is the process of the record.
        if (current?.zombie === true) result.set(record, "dead");
        // A different way to read the start time (for example ps, after
        // /proc could not be read at the start) gives a different text.
        else if (current === undefined || scheme(current.start) !== scheme(record.start!)) result.set(record, "unknown");
        else result.set(record, current.start === record.start ? "alive" : "dead");
      }
      return result;
    },
  };
}

/** The start time text and the state of a process that exists now. */
interface ProcessState {
  readonly start: string;
  /** True when the process is a zombie (see `isZombie`). */
  readonly zombie: boolean;
}

function scheme(text: string): string {
  return text.slice(0, text.indexOf(":") + 1);
}

/**
 * True when the state of a process (the first letter of the `stat` field)
 * is `Z` (zombie) or `X` (dead).
 */
export function isZombie(state: string): boolean {
  return state.startsWith("Z") || state.startsWith("X");
}

/**
 * The state (field 3) and the start time (field 22, `starttime`) in the
 * text of `/proc/<pid>/stat`. The command name (field 2) is in parentheses,
 * and can contain spaces and `)`: so tau reads the fields after the last
 * `)`.
 */
export function parseProcStat(text: string): { readonly state: string; readonly ticks: string } | undefined {
  const end = text.lastIndexOf(")");
  if (end === -1) return undefined;
  // The first field after the name is field 3: field 22 is at index 19.
  const fields = text.slice(end + 1).trim().split(/\s+/u);
  const state = fields[0];
  const ticks = fields[19];
  if (state === undefined || !/^[A-Za-z]$/u.test(state)) return undefined;
  return ticks !== undefined && /^\d{1,20}$/u.test(ticks) ? { state, ticks } : undefined;
}

/**
 * The states and start times in the output of `ps -o pid=,stat=,lstart=`,
 * by PID. Each run of spaces in the start time becomes one space.
 */
export function parsePsOutput(text: string): Map<number, { readonly state: string; readonly start: string }> {
  const result = new Map<number, { readonly state: string; readonly start: string }>();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s+(\S.*?)\s*$/u.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid)) continue;
    result.set(pid, { state: match[2]!, start: match[3]!.replace(/\s+/gu, " ") });
  }
  return result;
}

/**
 * The machine ID in the text of `/etc/machine-id`: 32 hexadecimal
 * characters. `undefined` when the text is not a machine ID, or when it is
 * only zeros (not set).
 */
export function parseMachineId(text: string): string | undefined {
  const id = text.trim().toLowerCase();
  return /^[0-9a-f]{32}$/u.test(id) && !/^0+$/u.test(id) ? id : undefined;
}

/**
 * The machine text of a process record: the host name, then the machine ID
 * and the PID namespace when they are known, with `|` between them. An
 * empty host name becomes `unknown`. At most `MAX_PROCESS_TEXT_CHARS`
 * characters: tau cuts the host name, so that a long host name does not
 * remove the machine ID and the PID namespace.
 */
export function composeMachine(host: string, machineId?: string, namespace?: string): string {
  const rest = [machineId, namespace].filter((part) => part !== undefined);
  const suffix = rest.length === 0 ? "" : `|${rest.join("|")}`;
  const hostRoom = Math.max(1, MAX_PROCESS_TEXT_CHARS - [...suffix].length);
  const name = [...(host === "" ? "unknown" : host)].slice(0, hostRoom).join("");
  return [...`${name}${suffix}`].slice(0, MAX_PROCESS_TEXT_CHARS).join("");
}

/** Runs `ps` for the PIDs, with a fixed format and time zone. See `SystemProbeOptions.ps`. */
async function runPs(pids: readonly number[]): Promise<string | undefined> {
  // Absolute paths only: a different `ps` earlier in PATH must not run.
  for (const binary of ["/bin/ps", "/usr/bin/ps"]) {
    const outcome = await new Promise<{ readonly missing: boolean; readonly stdout?: string }>((resolve) => {
      execFile(
        binary,
        ["-o", "pid=,stat=,lstart=", "-p", pids.join(",")],
        { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC0" }, timeout: PS_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error === null) return resolve({ missing: false, stdout: String(stdout) });
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve({ missing: true });
          // ps fails (code 1) when a PID does not exist, but writes the others.
          if (error.killed || error.signal !== null || typeof error.code !== "number") return resolve({ missing: false });
          resolve({ missing: false, stdout: String(stdout) });
        },
      );
    });
    if (!outcome.missing) return outcome.stdout;
  }
  return undefined;
}
