// BigQuery REST row format (f/v) → Cells, and table schema → Columns.
// Precision rule (core/types.ts): INT64, NUMERIC, BIGNUMERIC and TIMESTAMP stay strings.

import type { Cell, Column } from "@core/types";

export interface BqField {
  name: string;
  type: string;
  mode?: "NULLABLE" | "REQUIRED" | "REPEATED";
  fields?: BqField[];
  description?: string;
  defaultValueExpression?: string;
  rangeElementType?: { type: string };
}

export interface BqSchema {
  fields?: BqField[];
}

type BqValue = string | null | { f: { v: BqValue }[] } | { v: BqValue }[];

/** Type label as shown in the grid header, e.g. ARRAY<STRUCT<a INT64>>. */
export function typeLabel(field: BqField): string {
  let base = field.type;
  if ((base === "RECORD" || base === "STRUCT") && field.fields) {
    base = `STRUCT<${field.fields.map((f) => `${f.name} ${typeLabel(f)}`).join(", ")}>`;
  } else if (base === "RANGE" && field.rangeElementType) {
    base = `RANGE<${field.rangeElementType.type}>`;
  }
  return field.mode === "REPEATED" ? `ARRAY<${base}>` : base;
}

export function toColumns(schema: BqSchema | undefined): Column[] {
  return (schema?.fields ?? []).map((f) => ({
    name: f.name,
    type: typeLabel(f),
    nullable: f.mode !== "REQUIRED",
    default: f.defaultValueExpression ?? null,
  }));
}

/**
 * TIMESTAMP with formatOptions.useInt64Timestamp=true arrives as microseconds since epoch.
 * Returns ISO 8601 with microseconds: 2023-11-14T22:13:20.123456Z.
 */
export function microsToIso(micros: string): string {
  const n = BigInt(micros);
  let secs = n / 1_000_000n;
  let frac = n % 1_000_000n;
  if (frac < 0n) {
    frac += 1_000_000n;
    secs -= 1n;
  }
  const iso = new Date(Number(secs) * 1000).toISOString(); // ...T..:..:..000Z
  return `${iso.slice(0, 19)}.${frac.toString().padStart(6, "0")}Z`;
}

/** Legacy float-seconds TIMESTAMP ("1.700000000123456E9"), in case useInt64Timestamp is ignored. */
function floatSecondsToIso(text: string): string {
  const [intPart, fracPart = ""] = Number(text).toFixed(6).split(".");
  return microsToIso(`${intPart}${fracPart.padEnd(6, "0")}`);
}

function scalar(type: string, v: string): Cell {
  switch (type) {
    case "INTEGER":
    case "INT64":
    case "NUMERIC":
    case "BIGNUMERIC":
      return v;
    case "FLOAT":
    case "FLOAT64":
      return Number(v);
    case "BOOLEAN":
    case "BOOL":
      return v === "true";
    case "TIMESTAMP":
      return /^-?\d+$/.test(v) ? microsToIso(v) : floatSecondsToIso(v);
    case "JSON":
      try {
        return JSON.parse(v) as Cell;
      } catch {
        return v;
      }
    default:
      // STRING, BYTES (base64), DATE, TIME, DATETIME, GEOGRAPHY, INTERVAL, RANGE
      return v;
  }
}

export function convertValue(field: BqField, v: BqValue): Cell {
  if (v === null || v === undefined) return field.mode === "REPEATED" ? [] : null;
  if (field.mode === "REPEATED") {
    const inner: BqField = { ...field, mode: "NULLABLE" };
    return (v as { v: BqValue }[]).map((item) => convertValue(inner, item.v));
  }
  if (field.type === "RECORD" || field.type === "STRUCT") {
    const cells = (v as { f: { v: BqValue }[] }).f;
    const out: Record<string, unknown> = {};
    (field.fields ?? []).forEach((sub, i) => {
      out[sub.name] = convertValue(sub, cells[i]?.v ?? null);
    });
    return out;
  }
  return scalar(field.type, v as string);
}

export function convertRows(schema: BqSchema | undefined, rows: { f: { v: BqValue }[] }[] | undefined): Cell[][] {
  const fields = schema?.fields ?? [];
  return (rows ?? []).map((row) => fields.map((field, i) => convertValue(field, row.f[i]?.v ?? null)));
}

/** Positional query parameter for jobs.query (parameterMode POSITIONAL). */
export function toQueryParameter(value: Cell): { parameterType: unknown; parameterValue: unknown } {
  if (value === null) return { parameterType: { type: "STRING" }, parameterValue: {} };
  if (typeof value === "boolean") return { parameterType: { type: "BOOL" }, parameterValue: { value: String(value) } };
  if (typeof value === "number") {
    const type = Number.isInteger(value) ? "INT64" : "FLOAT64";
    return { parameterType: { type }, parameterValue: { value: String(value) } };
  }
  if (typeof value === "object") return { parameterType: { type: "JSON" }, parameterValue: { value: JSON.stringify(value) } };
  return { parameterType: { type: "STRING" }, parameterValue: { value } };
}
