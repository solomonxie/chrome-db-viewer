// Pending edits for one connection tab (DESIGN.md §3.6). Immutable: every operation returns
// a new state and pushes the old items on the undo stack.
// `table` is the tree path (ObjectPath), as Change.table expects; previews pass a tableName
// mapper to drop grouping nodes like "tables".

import type { Cell, Change, ChangeSet, ObjectPath } from "@core/types";

export type PendingItem =
  | { type: "update"; table: ObjectPath; rowId: string; key: Record<string, Cell>; column: string; value: Cell; old: Cell }
  | { type: "insert"; table: ObjectPath; rowId: string; values: Record<string, Cell> }
  | { type: "delete"; table: ObjectPath; rowId: string; key: Record<string, Cell> };

export interface PendingState {
  items: PendingItem[];
  past: PendingItem[][];
}

export const emptyPending: PendingState = { items: [], past: [] };

export type CellStatus = "edit" | "add" | "del" | null;

export function rowIdFor(table: ObjectPath, key: Record<string, Cell>): string {
  const entries = Object.keys(key)
    .sort()
    .map((k) => [k, key[k]]);
  return JSON.stringify([table, entries]);
}

let insertSeq = 0;
export const newInsertId = () => `new:${Date.now().toString(36)}:${++insertSeq}`;
export const isInsertId = (rowId: string) => rowId.startsWith("new:");

export function cellsEqual(a: Cell, b: Cell): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function push(state: PendingState, items: PendingItem[]): PendingState {
  return { items, past: [...state.past, state.items] };
}

export function editCell(
  state: PendingState,
  table: ObjectPath,
  rowId: string,
  key: Record<string, Cell>,
  column: string,
  value: Cell,
  old: Cell,
): PendingState {
  // Editing a not-yet-inserted row changes its INSERT values.
  const insertIdx = state.items.findIndex((i) => i.type === "insert" && i.rowId === rowId);
  if (insertIdx >= 0) {
    const ins = state.items[insertIdx] as Extract<PendingItem, { type: "insert" }>;
    const items = state.items.slice();
    items[insertIdx] = { ...ins, values: { ...ins.values, [column]: value } };
    return push(state, items);
  }
  if (state.items.some((i) => i.type === "delete" && i.rowId === rowId)) return state;

  const idx = state.items.findIndex((i) => i.type === "update" && i.rowId === rowId && i.column === column);
  const original = idx >= 0 ? (state.items[idx] as Extract<PendingItem, { type: "update" }>).old : old;
  const items = state.items.slice();
  if (cellsEqual(value, original)) {
    if (idx < 0) return state;
    items.splice(idx, 1);
  } else if (idx >= 0) {
    items[idx] = { ...(items[idx] as Extract<PendingItem, { type: "update" }>), value };
  } else {
    items.push({ type: "update", table, rowId, key, column, value, old: original });
  }
  return push(state, items);
}

export function insertRow(state: PendingState, table: ObjectPath, values: Record<string, Cell> = {}, rowId = newInsertId()): PendingState {
  return push(state, [...state.items, { type: "insert", table, rowId, values }]);
}

export function deleteRow(state: PendingState, table: ObjectPath, rowId: string, key: Record<string, Cell>): PendingState {
  if (state.items.some((i) => i.type === "delete" && i.rowId === rowId)) return state;
  // Deleting a pending insert just drops it; deleting a row drops its pending updates.
  if (state.items.some((i) => i.type === "insert" && i.rowId === rowId)) {
    return push(state, state.items.filter((i) => i.rowId !== rowId));
  }
  return push(state, [...state.items.filter((i) => i.rowId !== rowId), { type: "delete", table, rowId, key }]);
}

/** Toggles a pending delete off again. */
export function restoreRow(state: PendingState, rowId: string): PendingState {
  if (!state.items.some((i) => i.type === "delete" && i.rowId === rowId)) return state;
  return push(state, state.items.filter((i) => !(i.type === "delete" && i.rowId === rowId)));
}

export function undo(state: PendingState): PendingState {
  if (state.past.length === 0) return state;
  return { items: state.past[state.past.length - 1]!, past: state.past.slice(0, -1) };
}

export function discard(state: PendingState): PendingState {
  return state.items.length === 0 ? state : push(state, []);
}

/** Drops the changes for `table` after a successful apply. Undo history is cleared. */
export function clearTable(state: PendingState, table: ObjectPath): PendingState {
  const t = JSON.stringify(table);
  return { items: state.items.filter((i) => JSON.stringify(i.table) !== t), past: [] };
}

export function cellStatus(state: PendingState, rowId: string, column?: string): CellStatus {
  for (const i of state.items) {
    if (i.rowId !== rowId) continue;
    if (i.type === "delete") return "del";
    if (i.type === "insert") return "add";
    if (column !== undefined && i.type === "update" && i.column === column) return "edit";
  }
  return null;
}

/** Value to show for a cell: the pending one if edited. */
export function pendingValue(state: PendingState, rowId: string, column: string, fallback: Cell): Cell {
  for (const i of state.items) {
    if (i.rowId !== rowId) continue;
    if (i.type === "update" && i.column === column) return i.value;
    if (i.type === "insert") return column in i.values ? (i.values[column] ?? null) : fallback;
  }
  return fallback;
}

export function pendingInserts(state: PendingState, table: ObjectPath): Extract<PendingItem, { type: "insert" }>[] {
  const t = JSON.stringify(table);
  return state.items.filter((i): i is Extract<PendingItem, { type: "insert" }> => i.type === "insert" && JSON.stringify(i.table) === t);
}

export function toChangeSet(state: PendingState, table?: ObjectPath): ChangeSet {
  const t = table ? JSON.stringify(table) : null;
  const changes: Change[] = [];
  for (const i of state.items) {
    if (t && JSON.stringify(i.table) !== t) continue;
    switch (i.type) {
      case "update":
        changes.push({ type: "update", table: i.table, key: i.key, column: i.column, value: i.value, old: i.old });
        break;
      case "insert":
        changes.push({ type: "insert", table: i.table, values: i.values });
        break;
      case "delete":
        changes.push({ type: "delete", table: i.table, key: i.key });
        break;
    }
  }
  return { changes };
}

export function pendingCount(state: PendingState): number {
  return state.items.length;
}
