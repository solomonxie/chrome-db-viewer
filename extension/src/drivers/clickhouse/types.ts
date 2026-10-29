// ClickHouse type names → Column metadata and Cell values.
//
// Queries set output_format_json_quote_64bit_integers=1 and output_format_json_quote_decimals=1,
// so (U)Int64/128/256 and Decimal arrive as JSON strings and never pass through a JS number.
// DateTime/DateTime64/Date are strings in this format already. This module only normalises:
// unwraps Nullable/LowCardinality, keeps "nan"/"inf" floats as numbers, and turns any stray
// numeric big values into strings (e.g. from a server that ignored the setting).

import type { Cell, Column } from "@core/types";

export interface TypeInfo {
  /** Type with Nullable(…) and LowCardinality(…) removed. */
  base: string;
  nullable: boolean;
}

export function unwrapType(type: string): TypeInfo {
  let t = type.trim();
  let nullable = false;
  for (;;) {
    const m = /^(Nullable|LowCardinality)\((.*)\)$/.exec(t);
    if (!m) break;
    if (m[1] === "Nullable") nullable = true;
    t = m[2]!.trim();
  }
  return { base: t, nullable };
}

const BIG_INT = /^U?Int(64|128|256)$/;

/** True for types whose values must stay strings to keep precision. */
export function isPreciseType(base: string): boolean {
  return BIG_INT.test(base) || /^Decimal/.test(base) || /^DateTime64/.test(base);
}

export function enumValues(base: string): string[] | undefined {
  if (!/^Enum(8|16)?\(/.test(base)) return undefined;
  return [...base.matchAll(/'((?:[^'\\]|\\.)*)'\s*=/g)].map((m) => m[1]!.replace(/\\(.)/g, "$1"));
}

export function toColumn(name: string, type: string): Column {
  const { base, nullable } = unwrapType(type);
  const col: Column = { name, type, nullable };
  const values = enumValues(base);
  if (values) col.enumValues = values;
  return col;
}

/** Splits "a, Tuple(b, c), d" at top-level commas. */
export function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === "'") quote = false;
    } else if (ch === "'") quote = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = s.slice(start).trim();
  if (last) out.push(last);
  return out;
}

function inner(base: string, wrapper: string): string | null {
  return base.startsWith(`${wrapper}(`) && base.endsWith(")") ? base.slice(wrapper.length + 1, -1) : null;
}

/** Converts one JSON value from the stream into a Cell for the given ClickHouse type. */
export function convertValue(type: string, v: unknown): Cell {
  if (v === null || v === undefined) return null;
  const { base } = unwrapType(type);
  if (BIG_INT.test(base) || base.startsWith("Decimal")) return typeof v === "string" ? v : String(v);
  if (base.startsWith("Float") || base === "BFloat16") {
    if (typeof v === "number") return v;
    if (v === "nan") return Number.NaN;
    if (v === "inf" || v === "+inf") return Number.POSITIVE_INFINITY;
    if (v === "-inf") return Number.NEGATIVE_INFINITY;
    return Number(v);
  }
  const arr = inner(base, "Array");
  if (arr !== null && Array.isArray(v)) return v.map((x) => convertValue(arr, x));
  const map = inner(base, "Map");
  if (map !== null && v && typeof v === "object") {
    const [, valueType = "String"] = splitTopLevel(map);
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, convertValue(valueType, x)]));
  }
  const tuple = inner(base, "Tuple");
  if (tuple !== null) {
    const parts = splitTopLevel(tuple);
    // Named tuple elements are "name Type"; unnamed are just "Type".
    const typeOf = (p: string) => (/^[A-Za-z_][A-Za-z0-9_]*\s+[A-Z]/.test(p) ? p.replace(/^\S+\s+/, "") : p);
    if (Array.isArray(v)) return v.map((x, i) => convertValue(typeOf(parts[i] ?? "String"), x));
    if (v && typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>);
      return Object.fromEntries(entries.map(([k, x], i) => [k, convertValue(typeOf(parts[i] ?? "String"), x)]));
    }
  }
  if (typeof v === "number" && !Number.isSafeInteger(v) && Number.isInteger(v)) return String(v);
  return v as Cell;
}

export function convertRow(types: string[], row: unknown[]): Cell[] {
  return row.map((v, i) => convertValue(types[i] ?? "String", v));
}
