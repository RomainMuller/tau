import { createHash } from "node:crypto";

/**
 * The names of sub-agents. herdr accepts agent names that match
 * `[a-z][a-z0-9_-]{0,31}`. tau uses names that start with `tau-`, and makes
 * them from the task ID: the agent for `T2.1` is `tau-t2-1`.
 */

const AGENT_NAME = /^tau-[a-z0-9-]{1,28}$/;

export function isAgentName(value: string): boolean {
  return AGENT_NAME.test(value);
}

/**
 * The agent name for a task. When `taken` has the name already (for example
 * for a retry), a number is added: `tau-t2-1-2`, `tau-t2-1-3`, and so on.
 * Returns `undefined` when no name is free.
 */
export function agentNameFor(taskId: string, taken: ReadonlySet<string>): string | undefined {
  const readable = `tau-${taskId.toLowerCase().replaceAll(".", "-")}`;
  // A deep task ID makes a name that is too long. Then use a short hash.
  const base = readable.length <= 26 ? readable : `tau-h${hash(taskId, 8)}`;
  for (let attempt = 1; attempt <= 99; attempt++) {
    const name = attempt === 1 ? base : `${base}-${attempt}`;
    if (isAgentName(name) && !taken.has(name)) {
      return name;
    }
  }
  // Many attempts for one task: use a hash of the attempt too.
  for (let attempt = 100; attempt < 1_100; attempt++) {
    const name = `tau-h${hash(`${taskId}#${attempt}`, 12)}`;
    if (!taken.has(name)) return name;
  }
  return undefined;
}

function hash(text: string, length: number): string {
  return createHash("sha256").update(text).digest("hex").slice(0, length);
}

/** The maximum length of a `titleSlug`. */
export const MAX_SLUG_CHARS = 28;

/**
 * A short label for a task title, for the herdr side bar: lower-case letters
 * and digits, with `-` between words, at most `MAX_SLUG_CHARS` characters
 * (tau cuts it after a full word when it can). For example
 * "Review: tests and validation" gives `review-tests-and-validation`.
 * Returns `undefined` when the title has no letter or digit.
 */
export function titleSlug(title: string, max = MAX_SLUG_CHARS): string | undefined {
  const words = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
  if (words.length === 0) return undefined;
  let slug = "";
  for (const word of words) {
    const next = slug === "" ? word : `${slug}-${word}`;
    if (next.length > max) break;
    slug = next;
  }
  // The first word alone is too long: cut it.
  return slug === "" ? words[0]!.slice(0, max) : slug;
}
