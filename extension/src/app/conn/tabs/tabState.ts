// Pure helpers for the connection page's in-page tab strip: list operations (close, close
// others, close to the right, reorder, duplicate) and the per-connection saved tab list.

import type { ObjectPath } from "@core/types";
import { newEntry, pathKey, type TableEntry, type WorkTab } from "../model";

/** At most this many tabs are saved per connection. */
export const MAX_SAVED_TABS = 30;
/** Back/forward history kept per saved table tab. */
const MAX_SAVED_STACK = 10;

export const tabsKey = (connectionId: string) => `dbui.tabs.${connectionId}`;

/** Path shown by a table tab right now. */
export const tabPath = (t: WorkTab): ObjectPath | null => (t.kind === "table" ? t.stack[t.pos]!.path : null);

/** The open table tab whose current entry is `path`, if any. */
export function findTableTab(tabs: WorkTab[], path: ObjectPath): WorkTab | undefined {
  const k = pathKey(path);
  return tabs.find((t) => t.kind === "table" && pathKey(t.stack[t.pos]!.path) === k);
}

/** Tab to activate after removing `removed` (by id) from `before`, given the current active id. */
export function nextActive(before: WorkTab[], after: WorkTab[], activeId: string | null): string | null {
  if (activeId && after.some((t) => t.id === activeId)) return activeId;
  const kept = new Set(after.map((t) => t.id));
  const i = before.findIndex((t) => t.id === activeId);
  // The nearest surviving tab to the right (the one that slides into its place), else to the left.
  const right = before.slice(i + 1).find((t) => kept.has(t.id));
  if (right) return right.id;
  const left = before.slice(0, Math.max(0, i)).reverse().find((t) => kept.has(t.id));
  return left?.id ?? after[0]?.id ?? null;
}

export const closeIds = (tabs: WorkTab[], ids: string[]) => tabs.filter((t) => !ids.includes(t.id));
export const othersOf = (tabs: WorkTab[], id: string) => tabs.filter((t) => t.id !== id).map((t) => t.id);
export function rightOf(tabs: WorkTab[], id: string): string[] {
  const i = tabs.findIndex((t) => t.id === id);
  return i < 0 ? [] : tabs.slice(i + 1).map((t) => t.id);
}

/** Moves tab `id` so it sits at index `to` (index in the list after removal is clamped). */
export function moveTab(tabs: WorkTab[], id: string, to: number): WorkTab[] {
  const from = tabs.findIndex((t) => t.id === id);
  if (from < 0) return tabs;
  const out = tabs.slice();
  const [t] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, t!);
  return out;
}

/** A copy of `t` under a new id, inserted right after it. */
export function duplicateTab(tabs: WorkTab[], id: string, newId: string): WorkTab[] {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return tabs;
  const t = tabs[i]!;
  const copy: WorkTab = t.kind === "table" ? { ...t, id: newId, stack: t.stack.map((e) => ({ ...e })) } : { ...t, id: newId };
  return [...tabs.slice(0, i + 1), copy, ...tabs.slice(i + 1)];
}

// ---- persistence ----

type SavedTab =
  | { kind: "table"; stack: TableEntry[]; pos: number }
  | { kind: "query"; title: string; sql: string; namedQueryId?: string };

interface SavedTabs {
  v: 1;
  tabs: SavedTab[];
  active: number;
}

/** Serialises tabs (no result rows; they are never in WorkTab) for localStorage. */
export function serializeTabs(tabs: WorkTab[], activeId: string | null, bound: Record<string, string>): string {
  const kept = tabs.slice(0, MAX_SAVED_TABS);
  const out: SavedTabs = {
    v: 1,
    active: Math.max(0, kept.findIndex((t) => t.id === activeId)),
    tabs: kept.map((t): SavedTab => {
      if (t.kind === "query") return bound[t.id] ? { kind: "query", title: t.title, sql: t.sql, namedQueryId: bound[t.id] } : { kind: "query", title: t.title, sql: t.sql };
      // Keep the current entry and a few around it.
      const start = Math.max(0, Math.min(t.pos - MAX_SAVED_STACK + 1, t.stack.length - MAX_SAVED_STACK));
      const stack = t.stack.slice(start, start + MAX_SAVED_STACK);
      return { kind: "table", stack, pos: t.pos - start };
    }),
  };
  return JSON.stringify(out);
}

const isPath = (p: unknown): p is ObjectPath => Array.isArray(p) && p.length > 0 && p.every((s) => typeof s === "string");

/** Parses a saved tab list; anything malformed is dropped rather than thrown. */
export function restoreTabs(raw: string | null, makeId: () => string): { tabs: WorkTab[]; active: string | null; bound: Record<string, string> } {
  const empty = { tabs: [], active: null, bound: {} };
  if (!raw) return empty;
  let data: SavedTabs;
  try {
    data = JSON.parse(raw) as SavedTabs;
  } catch {
    return empty;
  }
  if (!data || data.v !== 1 || !Array.isArray(data.tabs)) return empty;
  const tabs: WorkTab[] = [];
  const bound: Record<string, string> = {};
  let active: string | null = null;
  data.tabs.slice(0, MAX_SAVED_TABS).forEach((s, i) => {
    if (!s || typeof s !== "object") return;
    const id = makeId();
    if (s.kind === "table" && Array.isArray(s.stack)) {
      const stack = s.stack.filter((e) => e && isPath(e.path)).map((e) => newEntry(e.path, e));
      if (stack.length === 0) return;
      const pos = Number.isInteger(s.pos) ? Math.max(0, Math.min(s.pos, stack.length - 1)) : stack.length - 1;
      tabs.push({ id, kind: "table", stack, pos });
    } else if (s.kind === "query") {
      tabs.push({ id, kind: "query", title: typeof s.title === "string" ? s.title : "Query", sql: typeof s.sql === "string" ? s.sql : "" });
      if (typeof s.namedQueryId === "string") bound[id] = s.namedQueryId;
    } else return;
    if (i === data.active) active = id;
  });
  return { tabs, active: active ?? tabs[0]?.id ?? null, bound };
}

export function loadSavedTabs(connectionId: string, makeId: () => string) {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(tabsKey(connectionId));
  } catch {
    /* storage blocked */
  }
  return restoreTabs(raw, makeId);
}

export function saveTabs(connectionId: string, tabs: WorkTab[], activeId: string | null, bound: Record<string, string>): void {
  try {
    if (tabs.length === 0) localStorage.removeItem(tabsKey(connectionId));
    else localStorage.setItem(tabsKey(connectionId), serializeTabs(tabs, activeId, bound));
  } catch {
    /* quota or blocked storage: last write wins, never crash */
  }
}
