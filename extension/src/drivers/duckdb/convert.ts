// Arrow (as produced by DuckDB-WASM) → Cell and Column. See the Cell rules in
// src/core/types.ts: 64-bit integers, decimals, dates, times and timestamps become strings so
// nothing loses precision; JSON columns become parsed values; lists and structs become
// arrays and objects.
//
// Values are read straight from the Arrow buffers instead of through Vector.get(), because
// get() turns Int64 into BigInt, timestamps into lossy millisecond numbers and decimals into
// unscaled integers.

import { DataType, makeVector, type Data, type Field, type RecordBatch, type Schema, type Vector } from "apache-arrow";
import type { Cell, Column } from "@core/types";

// Arrow Type ids (apache-arrow `Type` enum). Hard-coded so this file doesn't depend on the
// const enum being inlined by the bundler.
const T = {
  Null: 1, Int: 2, Float: 3, Binary: 4, Utf8: 5, Bool: 6, Decimal: 7, Date: 8, Time: 9, Timestamp: 10,
  Interval: 11, List: 12, Struct: 13, Union: 14, FixedSizeBinary: 15, FixedSizeList: 16, Map: 17,
  Duration: 18, LargeBinary: 19, LargeUtf8: 20, Dictionary: -1,
} as const;

// TimeUnit: SECOND 0, MILLISECOND 1, MICROSECOND 2, NANOSECOND 3. DateUnit: DAY 0, MILLISECOND 1.
// IntervalUnit: YEAR_MONTH 0, DAY_TIME 1, MONTH_DAY_NANO 2. UnionMode: Sparse 0, Dense 1.
const PER_SECOND = [1n, 1_000n, 1_000_000n, 1_000_000_000n] as const;
const FRACTION_DIGITS = [0, 3, 6, 9] as const;

type Reader = (data: Data, i: number) => Cell;

interface AnyData {
  offset: number;
  values: ArrayLike<number | bigint> & { subarray(a: number, b: number): ArrayLike<number | bigint> };
  valueOffsets: ArrayLike<number | bigint>;
  children: Data[];
  typeIds: ArrayLike<number>;
  dictionary?: Vector;
  stride: number;
  type: AnyType;
  getValid(i: number): boolean;
}

interface AnyType {
  typeId: number;
  bitWidth: number;
  isSigned: boolean;
  precision: number;
  scale: number;
  unit: number;
  timezone?: string | null;
  byteWidth: number;
  listSize: number;
  children: Field[];
  mode: number;
  typeIdToChildIndex: Record<number, number>;
  dictionary: DataType;
  indices: DataType;
  name?: string;
}

const utf8 = new TextDecoder();
const num = (v: number | bigint | undefined): number => (typeof v === "bigint" ? Number(v) : (v ?? 0));
const pad = (n: number | bigint, w = 2) => String(n).padStart(w, "0");

function extensionName(field?: Field): string | undefined {
  return field?.metadata.get("ARROW:extension:name") ?? undefined;
}

/** DuckDB tags types it can't express in Arrow as `arrow.opaque` with {"type_name": …}. */
function opaqueTypeName(field?: Field): string | undefined {
  if (extensionName(field) !== "arrow.opaque") return undefined;
  try {
    const meta = JSON.parse(field?.metadata.get("ARROW:extension:metadata") ?? "{}") as { type_name?: string };
    return meta.type_name;
  } catch {
    return undefined;
  }
}

// --- Scalars ---------------------------------------------------------------------------

/** Little-endian two's-complement integer from bytes. */
export function bytesToBigInt(bytes: ArrayLike<number>, signed: boolean): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]! & 0xff);
  if (signed && bytes.length && (bytes[bytes.length - 1]! & 0x80)) v -= 1n << BigInt(bytes.length * 8);
  return v;
}

/** Formats an unscaled decimal integer with `scale` digits after the point. */
export function formatDecimal(unscaled: bigint, scale: number): string {
  if (scale <= 0) return (unscaled * 10n ** BigInt(-scale)).toString();
  const neg = unscaled < 0n;
  const digits = (neg ? -unscaled : unscaled).toString().padStart(scale + 1, "0");
  return `${neg ? "-" : ""}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function fraction(rem: bigint, unit: number): string {
  if (rem === 0n || unit === 0) return "";
  return `.${rem.toString().padStart(FRACTION_DIGITS[unit]!, "0").replace(/0+$/, "")}`;
}

const DAY_MS = 86_400_000;
// DuckDB stores ±infinity timestamps and dates as the extreme int values.
const INT64_MAX = (1n << 63n) - 1n;
const INT32_MAX = 2 ** 31 - 1;

function ymd(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const md = `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  // DuckDB prints year 0 and earlier as "0001-01-01 (BC)" (no year zero).
  return y > 0 ? `${pad(y, 4)}-${md}` : `${pad(1 - y, 4)}-${md} (BC)`;
}

/** "YYYY-MM-DD" from days since the epoch. */
export function formatDate(days: number): string {
  if (days >= INT32_MAX) return "infinity";
  if (days <= -INT32_MAX) return "-infinity";
  return ymd(days * DAY_MS);
}

/** "YYYY-MM-DD HH:MM:SS[.fff…]" from an epoch value in `unit`, with "+00" when tz-aware. */
export function formatTimestamp(value: bigint, unit: number, utc: boolean): string {
  if (value >= INT64_MAX) return "infinity";
  if (value <= -INT64_MAX) return "-infinity";
  const per = PER_SECOND[unit]!;
  let secs = value / per;
  let rem = value % per;
  if (rem < 0n) {
    rem += per;
    secs -= 1n;
  }
  const ms = Number(secs) * 1000;
  const d = new Date(ms);
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${fraction(rem, unit)}`;
  const date = ymd(ms);
  const bc = date.endsWith(" (BC)");
  const tz = utc ? "+00" : "";
  return bc ? `${date.slice(0, -5)} ${time}${tz} (BC)` : `${date} ${time}${tz}`;
}

/** "HH:MM:SS[.fff…]" from a time-of-day value in `unit`. */
export function formatTime(value: bigint, unit: number): string {
  const per = PER_SECOND[unit]!;
  const secs = value / per;
  const rem = value % per;
  const h = secs / 3600n;
  const m = (secs / 60n) % 60n;
  const s = secs % 60n;
  return `${pad(h)}:${pad(m)}:${pad(s)}${fraction(rem, unit)}`;
}

/** DuckDB-style interval text: "1 year 2 months 3 days 04:05:06.5". */
export function formatInterval(months: number, days: number, nanos: bigint): string {
  const parts: string[] = [];
  const years = Math.trunc(months / 12);
  const mons = months % 12;
  if (years) parts.push(`${years} year${Math.abs(years) === 1 ? "" : "s"}`);
  if (mons) parts.push(`${mons} month${Math.abs(mons) === 1 ? "" : "s"}`);
  if (days) parts.push(`${days} day${Math.abs(days) === 1 ? "" : "s"}`);
  if (nanos !== 0n) {
    const neg = nanos < 0n;
    const abs = neg ? -nanos : nanos;
    const micros = abs / 1000n;
    parts.push(`${neg ? "-" : ""}${formatTime(micros, 2)}`);
  }
  return parts.length ? parts.join(" ") : "00:00:00";
}

/** DuckDB BLOB text: printable ASCII as is, everything else as \xHH. */
export function formatBlob(bytes: ArrayLike<number>): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    s += b >= 0x20 && b < 0x7f && b !== 0x5c ? String.fromCharCode(b) : `\\x${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return s;
}

export function formatUuid(bytes: ArrayLike<number>): string {
  const hex = Array.from(bytes as ArrayLike<number>, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** DuckDB BIT: first byte is the number of padding bits in the second byte. */
export function formatBit(bytes: ArrayLike<number>): string {
  if (!bytes.length) return "";
  const padding = bytes[0]!;
  let s = "";
  for (let i = 1; i < bytes.length; i++) s += bytes[i]!.toString(2).padStart(8, "0");
  return s.slice(padding);
}

/**
 * DuckDB BIGNUM (VARINT): 3-byte header (sign bit + byte count), then big-endian magnitude.
 * Negative numbers store the header and magnitude bytes inverted.
 */
export function formatBignum(bytes: ArrayLike<number>): string {
  if (bytes.length < 3) return "0";
  const negative = (bytes[0]! & 0x80) === 0;
  let v = 0n;
  for (let i = 3; i < bytes.length; i++) v = (v << 8n) | BigInt((negative ? ~bytes[i]! : bytes[i]!) & 0xff);
  return (negative ? -v : v).toString();
}

// --- Readers ---------------------------------------------------------------------------

function bytesAt(d: AnyData, i: number): Uint8Array {
  const a = num(d.valueOffsets[i]);
  const b = num(d.valueOffsets[i + 1]);
  return (d.values as unknown as Uint8Array).subarray(a, b);
}

function fixedBytesAt(d: AnyData, i: number): Uint8Array {
  const w = d.type.byteWidth;
  return (d.values as unknown as Uint8Array).subarray(i * w, (i + 1) * w);
}

function binaryReader(field?: Field): Reader {
  const opaque = opaqueTypeName(field);
  if (opaque === "bit") return (d, i) => formatBit(bytesAt(d as unknown as AnyData, i));
  if (opaque === "bignum" || opaque === "varint") return (d, i) => formatBignum(bytesAt(d as unknown as AnyData, i));
  return (d, i) => formatBlob(bytesAt(d as unknown as AnyData, i));
}

function fixedBinaryReader(field?: Field): Reader {
  const opaque = opaqueTypeName(field);
  if (opaque === "hugeint" || opaque === "uhugeint") {
    const signed = opaque === "hugeint";
    return (d, i) => bytesToBigInt(fixedBytesAt(d as unknown as AnyData, i), signed).toString();
  }
  if (extensionName(field) === "arrow.uuid") return (d, i) => formatUuid(fixedBytesAt(d as unknown as AnyData, i));
  return (d, i) => formatBlob(fixedBytesAt(d as unknown as AnyData, i));
}

function parseJson(s: string): Cell {
  try {
    return JSON.parse(s) as Cell;
  } catch {
    return s;
  }
}

function makeReader(type: DataType, field?: Field): Reader {
  const t = type as unknown as AnyType;
  const f = field;
  const inner = buildReader();
  return (data, i) => ((data as unknown as AnyData).getValid(i) ? inner(data, i) : null);

  function buildReader(): Reader {
    switch (t.typeId) {
      case T.Null:
        return () => null;
      case T.Int:
        // Lossless mode sends BOOLEAN as Int8 tagged arrow.bool8.
        if (extensionName(f) === "arrow.bool8") return (d, i) => (d as unknown as AnyData).values[i] !== 0;
        if (t.bitWidth === 64) return (d, i) => String((d as unknown as AnyData).values[i]);
        return (d, i) => (d as unknown as AnyData).values[i] as number;
      case T.Float:
        // Float precision: 0 HALF, 1 SINGLE, 2 DOUBLE.
        if (t.precision === 0) return (d, i) => halfToNumber((d as unknown as AnyData).values[i] as number);
        return (d, i) => (d as unknown as AnyData).values[i] as number;
      case T.Bool:
        return (d, i) => {
          const a = d as unknown as AnyData;
          const idx = a.offset + i;
          return (((a.values[idx >> 3] as number) >> (idx % 8)) & 1) === 1;
        };
      case T.Utf8:
      case T.LargeUtf8: {
        const json = extensionName(f) === "arrow.json";
        return (d, i) => {
          const s = utf8.decode(bytesAt(d as unknown as AnyData, i));
          return json ? parseJson(s) : s;
        };
      }
      case T.Binary:
      case T.LargeBinary:
        return binaryReader(f);
      case T.FixedSizeBinary:
        return fixedBinaryReader(f);
      case T.Decimal: {
        const words = t.bitWidth / 32;
        return (d, i) => {
          const a = d as unknown as AnyData;
          const w = a.values.subarray(i * words, (i + 1) * words) as ArrayLike<number>;
          let v = 0n;
          for (let k = words - 1; k >= 0; k--) v = (v << 32n) | BigInt(w[k]! >>> 0);
          if (w[words - 1]! & 0x80000000) v -= 1n << BigInt(t.bitWidth);
          return formatDecimal(v, t.scale);
        };
      }
      case T.Date:
        if (t.unit === 0) return (d, i) => formatDate((d as unknown as AnyData).values[i] as number);
        return (d, i) => {
          const ms = Number((d as unknown as AnyData).values[i]);
          return formatDate(Math.floor(ms / DAY_MS));
        };
      case T.Timestamp: {
        const utc = !!t.timezone;
        return (d, i) => formatTimestamp(BigInt((d as unknown as AnyData).values[i]!), t.unit, utc);
      }
      case T.Time:
        return (d, i) => formatTime(BigInt((d as unknown as AnyData).values[i]!), t.unit);
      case T.Duration: {
        const suffix = ["s", "ms", "us", "ns"][t.unit] ?? "";
        return (d, i) => `${(d as unknown as AnyData).values[i]}${suffix}`;
      }
      case T.Interval:
        return intervalReader(t.unit);
      case T.List:
      case T.Map: {
        const childField = t.children[0]!;
        const child = makeReader(childField.type, childField);
        const isMap = t.typeId === T.Map;
        const kv = isMap ? (childField.type as unknown as AnyType).children : [];
        const key = isMap ? makeReader(kv[0]!.type, kv[0]) : undefined;
        const value = isMap ? makeReader(kv[1]!.type, kv[1]) : undefined;
        return (d, i) => {
          const a = d as unknown as AnyData;
          const begin = num(a.valueOffsets[i]);
          const end = num(a.valueOffsets[i + 1]);
          const c = a.children[0]!;
          if (!isMap) {
            const out: Cell[] = [];
            for (let k = begin; k < end; k++) out.push(child(c, k));
            return out;
          }
          const entries = (c as unknown as AnyData).children;
          const obj: Record<string, Cell> = {};
          for (let k = begin; k < end; k++) {
            const kk = key!(entries[0]!, k);
            obj[typeof kk === "string" ? kk : JSON.stringify(kk)] = value!(entries[1]!, k);
          }
          return obj;
        };
      }
      case T.FixedSizeList: {
        const childField = t.children[0]!;
        const child = makeReader(childField.type, childField);
        const size = t.listSize;
        return (d, i) => {
          const c = (d as unknown as AnyData).children[0]!;
          const out: Cell[] = [];
          for (let k = 0; k < size; k++) out.push(child(c, i * size + k));
          return out;
        };
      }
      case T.Struct: {
        const readers = t.children.map((cf) => makeReader(cf.type, cf));
        const names = t.children.map((cf) => cf.name);
        return (d, i) => {
          const a = d as unknown as AnyData;
          const obj: Record<string, Cell> = {};
          for (let k = 0; k < readers.length; k++) obj[names[k]!] = readers[k]!(a.children[k]!, i);
          return obj;
        };
      }
      case T.Union: {
        const readers = t.children.map((cf) => makeReader(cf.type, cf));
        const dense = t.mode === 1;
        return (d, i) => {
          const a = d as unknown as AnyData;
          const ci = t.typeIdToChildIndex[a.typeIds[i]!]!;
          return readers[ci]!(a.children[ci]!, dense ? num(a.valueOffsets[i]) : i);
        };
      }
      case T.Dictionary: {
        const valueReader = makeReader(t.dictionary);
        return (d, i) => {
          const a = d as unknown as AnyData;
          const dict = a.dictionary;
          if (!dict) return null;
          return vectorCell(dict, num(a.values[i]), valueReader);
        };
      }
      default:
        // Unknown type: fall back to Arrow's own getter, made JSON-safe.
        return (d, i) => jsonSafe(makeVector(d).get(i));
    }
  }
}

function intervalReader(unit: number): Reader {
  if (unit === 2) {
    // MONTH_DAY_NANO: int32 months, int32 days, int64 nanoseconds per value.
    return (d, i) => {
      const v = (d as unknown as AnyData).values as unknown as Int32Array;
      const o = i * 4;
      const nanos = (BigInt(v[o + 3]!) << 32n) | BigInt(v[o + 2]! >>> 0);
      return formatInterval(v[o]!, v[o + 1]!, nanos);
    };
  }
  if (unit === 1) {
    // DAY_TIME: int32 days, int32 milliseconds.
    return (d, i) => {
      const v = (d as unknown as AnyData).values as unknown as Int32Array;
      return formatInterval(0, v[i * 2]!, BigInt(v[i * 2 + 1]!) * 1_000_000n);
    };
  }
  return (d, i) => formatInterval((d as unknown as AnyData).values[i] as number, 0, 0n);
}

function vectorCell(vector: Vector, index: number, reader: Reader): Cell {
  let i = index;
  for (const chunk of vector.data) {
    if (i < chunk.length) return reader(chunk, i);
    i -= chunk.length;
  }
  return null;
}

function jsonSafe(v: unknown): Cell {
  if (v === undefined || v === null) return null;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  try {
    return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))) as Cell;
  } catch {
    return String(v);
  }
}

function halfToNumber(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

// --- Public API --------------------------------------------------------------------------

/** Converts each column of a record batch with readers built once per schema. */
export class BatchConverter {
  private readers: Reader[];
  readonly columns: Column[];

  constructor(schema: Schema) {
    this.readers = schema.fields.map((f) => makeReader(f.type, f));
    this.columns = schema.fields.map(arrowColumn);
  }

  rows(batch: RecordBatch): Cell[][] {
    const n = batch.numRows;
    const cols = batch.schema.fields.map((_, k) => batch.getChildAt(k)!.data[0]!);
    const out: Cell[][] = new Array(n);
    for (let r = 0; r < n; r++) {
      const row: Cell[] = new Array(cols.length);
      for (let c = 0; c < cols.length; c++) row[c] = this.readers[c]!(cols[c]!, r);
      out[r] = row;
    }
    return out;
  }
}

/** Converts a whole Arrow table (all batches) to rows of Cells. */
export function tableRows(table: { schema: Schema; batches: RecordBatch[] }): Cell[][] {
  const conv = new BatchConverter(table.schema);
  return table.batches.flatMap((b) => conv.rows(b));
}

/** Converts a whole Arrow table to objects keyed by column name. For catalog queries. */
export function tableObjects(table: { schema: Schema; batches: RecordBatch[] }): Record<string, Cell>[] {
  const names = table.schema.fields.map((f) => f.name);
  return tableRows(table).map((row) => Object.fromEntries(names.map((n, i) => [n, row[i] ?? null])));
}

export function arrowColumn(field: Field): Column {
  return { name: field.name, type: arrowTypeName(field.type, field), nullable: field.nullable };
}

/** DuckDB-style type name for an Arrow type as DuckDB-WASM emits it. */
export function arrowTypeName(type: DataType, field?: Field): string {
  const t = type as unknown as AnyType;
  const opaque = opaqueTypeName(field);
  if (opaque) return opaque.toUpperCase();
  switch (t.typeId) {
    case T.Null:
      return "NULL";
    case T.Int: {
      if (extensionName(field) === "arrow.bool8") return "BOOLEAN";
      const base = { 8: "TINYINT", 16: "SMALLINT", 32: "INTEGER", 64: "BIGINT" }[t.bitWidth] ?? "INTEGER";
      return t.isSigned ? base : `U${base}`;
    }
    case T.Float:
      return t.precision === 2 ? "DOUBLE" : t.precision === 1 ? "FLOAT" : "HALF";
    case T.Utf8:
    case T.LargeUtf8:
      return extensionName(field) === "arrow.json" ? "JSON" : "VARCHAR";
    case T.Binary:
    case T.LargeBinary:
      return "BLOB";
    case T.FixedSizeBinary:
      return extensionName(field) === "arrow.uuid" ? "UUID" : "BLOB";
    case T.Bool:
      return "BOOLEAN";
    case T.Decimal:
      return `DECIMAL(${t.precision},${t.scale})`;
    case T.Date:
      return "DATE";
    case T.Time:
      return t.unit === 3 ? "TIME_NS" : "TIME";
    case T.Timestamp: {
      if (t.timezone) return "TIMESTAMP WITH TIME ZONE";
      return ["TIMESTAMP_S", "TIMESTAMP_MS", "TIMESTAMP", "TIMESTAMP_NS"][t.unit] ?? "TIMESTAMP";
    }
    case T.Interval:
      return "INTERVAL";
    case T.Duration:
      return "INTERVAL";
    case T.List:
      return `${arrowTypeName(t.children[0]!.type, t.children[0])}[]`;
    case T.FixedSizeList:
      return `${arrowTypeName(t.children[0]!.type, t.children[0])}[${t.listSize}]`;
    case T.Struct:
      return `STRUCT(${t.children.map((c) => `${quoteName(c.name)} ${arrowTypeName(c.type, c)}`).join(", ")})`;
    case T.Map: {
      const kv = (t.children[0]!.type as unknown as AnyType).children;
      return `MAP(${arrowTypeName(kv[0]!.type, kv[0])}, ${arrowTypeName(kv[1]!.type, kv[1])})`;
    }
    case T.Union:
      return `UNION(${t.children.map((c) => `${quoteName(c.name)} ${arrowTypeName(c.type, c)}`).join(", ")})`;
    case T.Dictionary:
      return t.dictionary && (t.dictionary as unknown as AnyType).typeId === T.Utf8 ? "ENUM" : arrowTypeName(t.dictionary);
    default:
      return String(type);
  }
}

const quoteName = (n: string) => (/^[a-z_][a-z0-9_]*$/.test(n) ? n : `"${n.replace(/"/g, '""')}"`);

// Re-exported so callers can check instances without importing apache-arrow themselves.
export { DataType };
