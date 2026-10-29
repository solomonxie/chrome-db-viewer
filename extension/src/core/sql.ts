// Generic ChangeSet → parameterised SQL, shared by the SQL drivers (design/DESIGN.md §3.6).
// Each driver passes its dialect; placeholder style differs per engine.

import type { Cell, Change, ChangeSet, ObjectPath, SqlDialect } from "./types";

export type Placeholder = "dollar" | "question";

export interface BuiltStatement {
  sql: string;
  params: Cell[];
}

export function qualified(path: ObjectPath, dialect: SqlDialect): string {
  // Tree paths may contain grouping nodes like "tables"; drivers pass the real name parts.
  return path.map((p) => dialect.quoteIdent(p)).join(".");
}

export function buildChange(
  change: Change,
  dialect: SqlDialect,
  placeholder: Placeholder,
  tableName: (path: ObjectPath) => string = (p) => qualified(p, dialect),
): BuiltStatement {
  const params: Cell[] = [];
  const ph = (v: Cell) => {
    params.push(v);
    return placeholder === "dollar" ? `$${params.length}` : "?";
  };
  const where = (key: Record<string, Cell>) =>
    Object.entries(key)
      .map(([k, v]) => (v === null ? `${dialect.quoteIdent(k)} IS NULL` : `${dialect.quoteIdent(k)} = ${ph(v)}`))
      .join(" AND ");
  const table = tableName(change.table);

  switch (change.type) {
    case "update":
      return { sql: `UPDATE ${table} SET ${dialect.quoteIdent(change.column)} = ${ph(change.value)} WHERE ${where(change.key)}`, params };
    case "delete":
      return { sql: `DELETE FROM ${table} WHERE ${where(change.key)}`, params };
    case "insert": {
      const cols = Object.keys(change.values);
      if (cols.length === 0) return { sql: `INSERT INTO ${table} DEFAULT VALUES`, params };
      const values = cols.map((c) => ph(change.values[c] ?? null));
      return { sql: `INSERT INTO ${table} (${cols.map((c) => dialect.quoteIdent(c)).join(", ")}) VALUES (${values.join(", ")})`, params };
    }
  }
}

export function buildChangeSet(
  set: ChangeSet,
  dialect: SqlDialect,
  placeholder: Placeholder,
  tableName?: (path: ObjectPath) => string,
): BuiltStatement[] {
  return set.changes.map((c) => buildChange(c, dialect, placeholder, tableName));
}

/** Human-readable preview with literals inlined, for the pending-changes drawer. Never executed. */
export function previewChangeSet(set: ChangeSet, dialect: SqlDialect, tableName?: (path: ObjectPath) => string): string {
  return buildChangeSet(set, dialect, "question", tableName)
    .map(({ sql, params }) => {
      let i = 0;
      return sql.replace(/\?/g, () => dialect.literal(params[i++] ?? null)) + ";";
    })
    .join("\n");
}

const ansiQuote = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function ansiLiteral(value: Cell): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "object") return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "''")}'`;
}

export const postgresDialect: SqlDialect = { name: "postgres", quoteIdent: ansiQuote, literal: ansiLiteral };
export const sqliteDialect: SqlDialect = { name: "sqlite", quoteIdent: ansiQuote, literal: ansiLiteral };
export const duckdbDialect: SqlDialect = { name: "duckdb", quoteIdent: ansiQuote, literal: ansiLiteral };
export const clickhouseDialect: SqlDialect = {
  name: "clickhouse",
  quoteIdent: (n) => `\`${n.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``,
  literal: (v) => (typeof v === "string" ? `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'` : ansiLiteral(v)),
};
export const bigqueryDialect: SqlDialect = {
  name: "bigquery",
  quoteIdent: (n) => `\`${n.replace(/`/g, "\\`")}\``,
  literal: (v) => (typeof v === "string" ? `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'` : ansiLiteral(v)),
};
