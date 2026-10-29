// Which tab a History click should use, so clicking entries doesn't pile up new tabs.

import type { WorkTab } from "./model";

export type HistoryTarget = { focus: string } | { load: string } | { open: true };

/**
 * Focus a tab that already holds this SQL; else load it into the active tab if that's an
 * empty query tab, or into the single "History" tab; only open a new tab when neither exists.
 */
export function historyTarget(tabs: WorkTab[], activeId: string | null, sql: string): HistoryTarget {
  const same = tabs.find((t) => t.kind === "query" && t.sql.trim() === sql.trim());
  if (same) return { focus: same.id };
  const active = tabs.find((t) => t.id === activeId);
  if (active?.kind === "query" && !active.sql.trim()) return { load: active.id };
  const history = tabs.find((t) => t.kind === "query" && t.title === "History");
  if (history) return { load: history.id };
  return { open: true };
}
