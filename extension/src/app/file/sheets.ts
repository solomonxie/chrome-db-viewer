// VisiData-style sheet stack (DESIGN.md §3.11). Each sheet is a SQL query over the file's
// table; derived sheets (frequency, summary, filter) push on top of the stack.

import type { SqlDialect } from "@core/types";
import type { SortSpec } from "../lib/filters";

export type Sheet =
  | { kind: "source"; title: string; where: string[]; sort: SortSpec[] }
  | { kind: "frequency"; title: string; column: string; where: string[] }
  | { kind: "summary"; title: string; where: string[] };

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
    case "frequency": {
      const c = dialect.quoteIdent(sheet.column);
      return `SELECT ${c}, count(*) AS "count" FROM ${t}${whereSql(sheet.where)} GROUP BY ${c} ORDER BY "count" DESC`;
    }
    case "summary":
      return sheet.where.length ? `SUMMARIZE SELECT * FROM ${t}${whereSql(sheet.where)}` : `SUMMARIZE ${t}`;
  }
}

/** Condition for "Enter on a frequency row": filter the source to that value. */
export function equalsCondition(column: string, value: unknown, dialect: SqlDialect): string {
  const c = dialect.quoteIdent(column);
  if (value === null || value === undefined) return `${c} IS NULL`;
  if (typeof value === "number" || typeof value === "boolean") return `${c} = ${dialect.literal(value)}`;
  return `${c} = ${dialect.literal(typeof value === "object" ? JSON.stringify(value) : String(value))}`;
}

export function frequencySheet(parent: Sheet, column: string): Sheet {
  return { kind: "frequency", title: `${column} frequency`, column, where: parent.where };
}

export function summarySheet(parent: Sheet): Sheet {
  return { kind: "summary", title: "summary", where: parent.where };
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
