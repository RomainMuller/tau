import type { HerdrStatus } from "./herdr.ts";

/** The key of the tau widget above the editor. */
export const WIDGET_KEY = "tau";

/** The text of the badge for a herdr status. */
export function badgeText(status: HerdrStatus): string {
  return status.available ? "🟢 Herdr" : "🔴 Herdr unavailable";
}

/** The lines of the tau widget. Later steps add the task tree here. */
export function widgetLines(status: HerdrStatus): string[] {
  return [badgeText(status)];
}
