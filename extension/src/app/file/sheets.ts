// VisiData-style sheet stack (DESIGN.md §3.11). Each sheet is a SQL query over the file's
// table; derived sheets (summary, filter, SQL) push on top of the stack.

import type { SqlDialect } from "@core/types";
import type { SortSpec } from "../lib/filters";

export type Sheet =
  | { kind: "source"; title: string; where: string[]; sort: SortSpec[] }
  | { kind: "summary"; title: string; where: string[]; sort?: SortSpec[] }
  /** Free SQL typed in the SQL bar, run as is against the file's table. */
  | { kind: "query"; title: string; sql: string; where: string[]; sort?: SortSpec[] };

export function sourceSheet(table: string): Sheet {
  return { kind: "source", title: table, where: [], sort: [] };
}

const whereSql = (w: string[]) => (w.length ? ` WHERE ${w.map((x) => (w.length > 1 ? `(${x})` : x)).join(" AND ")}` : "");

const orderSql = (sort: SortSpec[] | undefined, dialect: SqlDialect) =>
  sort?.length ? ` ORDER BY ${sort.map((s) => `${dialect.quoteIdent(s.column)} ${s.dir.toUpperCase()}`).join(", ")}` : "";

export function sheetSql(sheet: Sheet, table: string, dialect: SqlDialect, limit?: number): string {
  const t = dialect.quoteIdent(table);
  switch (sheet.kind) {
    case "source":
      return `SELECT * FROM ${t}${whereSql(sheet.where)}${orderSql(sheet.sort, dialect)}${limit ? ` LIMIT ${limit}` : ""}`;
    case "summary": {
      const base = sheet.where.length ? `SUMMARIZE SELECT * FROM ${t}${whereSql(sheet.where)}` : `SUMMARIZE ${t}`;
      return sheet.sort?.length ? `SELECT * FROM (${base})${orderSql(sheet.sort, dialect)}` : base;
    }
    case "query": {
      // Sorting a SQL sheet sorts its result: the query runs as a subquery.
      if (!sheet.sort?.length) return sheet.sql;
      return `SELECT * FROM (\n${sheet.sql.replace(/;\s*$/, "")}\n) AS q${orderSql(sheet.sort, dialect)}`;
    }
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
  // The breadcrumb shows what's after FROM "sheet" (the part that differs), or the start of the query.
  const tail = /^select\s+\*\s+from\s+"?sheet"?\s+(.+)$/i.exec(oneLine)?.[1];
  const title = tail ?? oneLine;
  return { kind: "query", title: title.length > 40 ? title.slice(0, 39) + "…" : title, sql: sql.trim(), where: [] };
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
