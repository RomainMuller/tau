/**
 * Cleaning of text that agents wrote (titles, descriptions, results, notes).
 *
 * This text goes to the terminal and to models. Terminal control sequences
 * (for example ANSI escape codes) in it can change what the terminal shows,
 * so tau removes all control characters before it shows the text.
 */

// Complete escape sequences: CSI (for example colors), OSC (for example
// titles and links), and two-character escapes.
const ESCAPE_SEQUENCE =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/gu;
// C0 controls except tab and line feed, DEL, and C1 controls.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;
// Unicode characters that change the direction of text (bidi controls), and
// characters with no width, which can hide text.
const BIDI = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu;

// Unicode line and paragraph separators. A model or a terminal can show them
// as a new line, so tau makes them line feeds: then each quoted line gets its
// quote mark.
const LINE_SEPARATOR = /[\u2028\u2029]/gu;

/** Removes control characters. Keeps line feeds and tabs. Makes Unicode line separators line feeds. */
export function cleanText(text: string): string {
  return text.replace(ESCAPE_SEQUENCE, "").replace(CONTROL, "").replace(BIDI, "").replace(LINE_SEPARATOR, "\n");
}

/** Removes control characters, and makes the text one line. */
export function cleanLine(text: string): string {
  return cleanText(text).replace(/[\t\n]+/gu, " ");
}
