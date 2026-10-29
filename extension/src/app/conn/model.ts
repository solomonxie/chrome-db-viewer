// State shapes shared by the connection tab's panes.

import type { Capabilities, Cell, Column, ConnectionConfig, Driver, ObjectPath, ObjectType, TableSchema } from "@core/types";
import type { FilterRow, Joiner, SortSpec } from "../lib/filters";
import type { PendingState } from "../lib/changes";
import type { HistorySource } from "../store/db";

export interface TableEntry {
  /** Tree path, passed to describe(). */
  path: ObjectPath;
  filters: FilterRow[];
  joiner: Joiner;
  showFilters: boolean;
  sort: SortSpec[];
  /** Filter rows applied to the grid; compiled with the table's column types at query time. */
  applied: FilterRow[];
  appliedJoiner: Joiner;
}

export type WorkTab =
  | { id: string; kind: "table"; stack: TableEntry[]; pos: number }
  | { id: string; kind: "query"; title: string; sql: string };

/** How the grid may change rows, from capabilities and engine rules (§3.6). */
export type EditMode = "full" | "insert" | "none";

export interface ConnCtx {
  cfg: ConnectionConfig;
  driver: Driver;
  caps: Capabilities;
  readOnly: boolean;
  pending: PendingState;
  setPending: (fn: (s: PendingState) => PendingState) => void;
  /** Types seen while expanding the tree, keyed by JSON path. */
  nodeTypes: Map<string, ObjectType>;
  /** Real SQL name for a tree path (grouping nodes dropped), quoted. */
  sqlName: (path: ObjectPath) => string;
  describe: (path: ObjectPath) => Promise<TableSchema>;
  toast: (msg: string) => void;
  addHistory: (h: { sql: string; ms?: number; rows?: number; error?: string; source: HistorySource }) => void;
  /** Resolves "customers.id" to a tree path for a table, from the tree or a sibling guess. */
  resolveTable: (ref: string, from: ObjectPath) => ObjectPath;
  editMode: EditMode;
}

/** What the Details pane shows: the selected rows of the active grid. */
export interface DetailsSource {
  table: ObjectPath | null;
  columns: Column[];
  rows: { rowId: string; key: Record<string, Cell>; values: Cell[] }[];
  editable: boolean;
  onOpenFk?: (colIndex: number, value: Cell, newTab: boolean) => void;
}

export const pathKey = (p: ObjectPath) => JSON.stringify(p);

export function newEntry(path: ObjectPath, partial: Partial<TableEntry> = {}): TableEntry {
  return { path, filters: [], joiner: "AND", showFilters: false, sort: [], applied: [], appliedJoiner: "AND", ...partial };
}
