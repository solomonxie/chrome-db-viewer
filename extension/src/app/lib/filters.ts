// Filter rows (DESIGN.md §4.2) → WHERE clause, and the SELECT the data grid runs.
// Values are inlined with the dialect's literal(): the filter bar is the user writing their
// own query, like the editor, and the same text is shown verbatim by the "SQL" button.

import type { Column, ObjectPath, SqlDialect } from "@core/types";
import { isBoolType, isNumericType, isTextType, NUMBER_LITERAL } from "./coltypes";

export const RAW_SQL = "__raw__";

export type FilterOp =
  | "=" | "!=" | "<" | ">" | "<=" | ">="
  | "contains" | "starts_with" | "in" | "between" | "is_null" | "is_not_null";

export const FILTER_OPS: { op: FilterOp; label: string }[] = [
  { op: "=", label: "=" },
  { op: "!=", label: "≠" },
  { op: "<", label: "<" },
  { op: ">", label: ">" },
  { op: "<=", label: "≤" },
  { op: ">=", label: "≥" },
  { op: "contains", label: "contains" },
  { op: "starts_with", label: "starts with" },
  { op: "in", label: "in" },
  { op: "between", label: "between" },
  { op: "is_null", label: "is null" },
  { op: "is_not_null", label: "is not null" },
];

export interface FilterRow {
  id: number;
  enabled: boolean;
  /** Column name, or RAW_SQL for a free WHERE expression in `value`. */
  column: string;
  op: FilterOp;
  value: string;
  /** Upper bound for "between". */
  value2?: string;
}

export type Joiner = "AND" | "OR";

export const opNeedsValue = (op: FilterOp) => op !== "is_null" && op !== "is_not_null";

/** Literal for a typed-in value, using the column type to decide between number, bool and string. */
export function valueLiteral(raw: string, col: Column | undefined, dialect: SqlDialect): string {
  const v = raw.trim();
  if (/^null$/i.test(v)) return "NULL";
  if (col && isNumericType(col.type) && NUMBER_LITERAL.test(v)) return v;
  if (col && isBoolType(col.type) && /^(true|false)$/i.test(v)) return v.toUpperCase();
  return dialect.literal(raw);
}

function asText(ident: string, col: Column | undefined, dialect: SqlDialect): string {
  if (!col || isTextType(col.type)) return ident;
  switch (dialect.name) {
    case "clickhouse":
      return `toString(${ident})`;
    case "bigquery":
      return `CAST(${ident} AS STRING)`;
    default:
      return `CAST(${ident} AS TEXT)`;
  }
}

function likePattern(raw: string, prefixOnly: boolean, dialect: SqlDialect): string {
  const escaped = raw.replace(/[\\%_]/g, (c) => "\\" + c);
  const lit = dialect.literal(prefixOnly ? `${escaped}%` : `%${escaped}%`);
  // DuckDB and SQLite have no default LIKE escape character.
  return dialect.name === "duckdb" || dialect.name === "sqlite" ? `${lit} ESCAPE '\\'` : lit;
}

/** One condition, or null when the row is incomplete. */
export function compileFilter(row: FilterRow, columns: Column[], dialect: SqlDialect): string | null {
  if (row.column === RAW_SQL) {
    const expr = row.value.trim();
    return expr ? `(${expr})` : null;
  }
  if (!row.column) return null;
  const col = columns.find((c) => c.name === row.column);
  const id = dialect.quoteIdent(row.column);
  const lit = (v: string) => valueLiteral(v, col, dialect);

  if (opNeedsValue(row.op) && row.value.trim() === "" && !(col && isTextType(col.type) && row.op === "=")) {
    return null;
  }

  switch (row.op) {
    case "=":
    case "<":
    case ">":
    case "<=":
    case ">=":
      if (lit(row.value) === "NULL") return row.op === "=" ? `${id} IS NULL` : null;
      return `${id} ${row.op} ${lit(row.value)}`;
    case "!=":
      if (lit(row.value) === "NULL") return `${id} IS NOT NULL`;
      return `${id} <> ${lit(row.value)}`;
    case "contains":
      return `${asText(id, col, dialect)} LIKE ${likePattern(row.value, false, dialect)}`;
    case "starts_with":
      return `${asText(id, col, dialect)} LIKE ${likePattern(row.value, true, dialect)}`;
    case "in": {
      const items = splitList(row.value);
      if (items.length === 0) return null;
      return `${id} IN (${items.map(lit).join(", ")})`;
    }
    case "between": {
      let lo = row.value;
      let hi = row.value2 ?? "";
      if (!hi.trim()) {
        // Accept "1 and 5" or "1, 5" typed in one box.
        const parts = row.value.split(/\s+and\s+|,/i);
        if (parts.length !== 2) return null;
        [lo, hi] = [parts[0]!, parts[1]!];
      }
      if (!lo.trim() || !hi.trim()) return null;
      return `${id} BETWEEN ${lit(lo)} AND ${lit(hi)}`;
    }
    case "is_null":
      return `${id} IS NULL`;
    case "is_not_null":
      return `${id} IS NOT NULL`;
  }
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((s) => s.replace(/^'(.*)'$/, "$1"));
}

/** Enabled, complete rows joined with AND/OR; empty string when nothing applies. */
export function compileWhere(rows: FilterRow[], columns: Column[], dialect: SqlDialect, joiner: Joiner = "AND"): string {
  const parts = rows
    .filter((r) => r.enabled)
    .map((r) => compileFilter(r, columns, dialect))
    .filter((p): p is string => p !== null);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0]!;
  return parts.join(` ${joiner} `);
}

export interface SortSpec {
  column: string;
  dir: "asc" | "desc";
}

export interface SelectSpec {
  table: string;
  where?: string;
  sort?: SortSpec[];
  limit?: number;
  offset?: number;
}

export function buildSelect(spec: SelectSpec, dialect: SqlDialect): string {
  let sql = `SELECT * FROM ${spec.table}`;
  if (spec.where) sql += ` WHERE ${spec.where}`;
  if (spec.sort && spec.sort.length > 0) {
    sql += ` ORDER BY ${spec.sort.map((s) => `${dialect.quoteIdent(s.column)} ${s.dir === "desc" ? "DESC" : "ASC"}`).join(", ")}`;
  }
  if (spec.limit !== undefined) sql += ` LIMIT ${spec.limit}`;
  if (spec.offset) sql += ` OFFSET ${spec.offset}`;
  return sql;
}

/**
 * Tree paths can hold grouping nodes ("tables", "views") that aren't part of the SQL name.
 * The caller passes the types it saw while expanding the tree.
 */
export function tableRef(path: ObjectPath, groupIndexes: number[], dialect: SqlDialect): string {
  return path
    .filter((_, i) => !groupIndexes.includes(i))
    .map((p) => dialect.quoteIdent(p))
    .join(".");
}

/** Filter that opens the row a foreign-key cell points at. */
export function parseReference(ref: string): { table: string; column: string } | null {
  const i = ref.lastIndexOf(".");
  if (i <= 0 || i === ref.length - 1) return null;
  return { table: ref.slice(0, i), column: ref.slice(i + 1) };
}
