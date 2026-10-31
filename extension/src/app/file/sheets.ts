// VisiData-style sheet stack (DESIGN.md §3.11). Each sheet is a SQL query over the file's
// table; derived sheets (summary, filter, SQL) push on top of the stack.

import type { SqlDialect } from "@core/types";
import type { SortSpec } from "../lib/filters";

export type Sheet =
  | { kind: "source"; title: string; where: string[]; sort: SortSpec[] }
  | { kind: "summary"; title: string; where: string[] }
  /** Free SQL typed in the SQL bar, run as is against the file's table. */
  | { kind: "query"; title: string; sql: string; where: string[] };

export function sourceSheet(table: string): Sheet {
  return { kind: "source", title: table, where: [], sort: [] };
}

const whereSql = (w: string[]) => (w.length ? ` WHERE ${w.map((x) => (w.length > 1 ? `(${x})` : x)).join(" AND ")}` : "");

export function sheetSql(sheet: Sheet, table: string, dialect: SqlDialect, limit?: number): string {
  const t = dialect.quoteIdent(table);
  switch (sheet.kind) {
    case "source": {
      const order = sheet.sort.length ? ` ORDER BY ${sheet.sort.map((s) => `${dialect.quoteIdent(s.column)} ${s.dir.toUpperCase()}`).join(", ")}` : "";
      return `SELECT * FROM ${t}${whereSql(sheet.where)}${order}${limit ? ` LIMIT ${limit}` : ""}`;
    }
    case "summary":
      return sheet.where.length ? `SUMMARIZE SELECT * FROM ${t}${whereSql(sheet.where)}` : `SUMMARIZE ${t}`;
    case "query":
      return sheet.sql;
  }
}

/** Condition matching one value of a column ("open selected rows as a sheet"). */
export function equalsCondition(column: string, value: unknown, dialect: SqlDialect): string {
  const c = dialect.quoteIdent(column);
  if (value === null || value === undefined) return `${c} IS NULL`;
  if (typeof value === "number" || typeof value === "boolean") return `${c} = ${dialect.literal(value)}`;
  return `${c} = ${dialect.literal(typeof value === "object" ? JSON.stringify(value) : String(value))}`;
}

export function summarySheet(parent: Sheet): Sheet {
  return { kind: "summary", title: "summary", where: parent.where };
}

export function querySheet(sql: string): Sheet {
  const oneLine = sql.trim().replace(/\s+/g, " ");
  return { kind: "query", title: oneLine.length > 40 ? oneLine.slice(0, 39) + "…" : oneLine, sql: sql.trim(), where: [] };
}

export function filteredSheet(parent: Sheet, condition: string, label: string): Sheet {
  return { kind: "source", title: label, where: [...parent.where, condition], sort: parent.kind === "source" ? parent.sort : [] };
}

/** Next sort state for a header click: asc → desc → off; shift adds a key. */
export function cycleSort(sort: SortSpec[], column: string, additive: boolean): SortSpec[] {
  const cur = sort.find((s) => s.column === column);
  const rest = additive ? sort.filter((s) => s.column !== column) : [];
  if (!cur) return [...rest, { column, dir: "asc" }];
  if (cur.dir === "asc") return [...rest, { column, dir: "desc" }];
  return rest;
}
