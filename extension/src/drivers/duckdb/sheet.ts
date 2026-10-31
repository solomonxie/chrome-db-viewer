// Local data files as VisiData-style sheets (design/DESIGN.md §3.11): format detection,
// reader SQL, and the SQL behind the sheet commands. Pure functions, no engine.

import { duckdbDialect } from "@core/sql";

/** Every file connection exposes its data as this one table (or view). */
export const FILE_SHEET_TABLE = "sheet";

/** Files under this size are copied into an in-memory table on open; bigger ones stay a view. */
export const MATERIALIZE_LIMIT_BYTES = 500 * 1024 * 1024;

/** Remote CSV/JSON bigger than this needs `options.allowLarge` (the viewer asks first). */
export const REMOTE_WARN_BYTES = 1024 * 1024 * 1024;

export type FileFormat = "csv" | "tsv" | "psv" | "jsonl" | "json" | "parquet" | "arrow";
export type Compression = "gzip" | "zstd" | null;

export interface DetectedFormat {
  format: FileFormat;
  compression: Compression;
  /** The extension as written, e.g. "csv.gz", for display. */
  ext: string;
}

const EXT_FORMAT: Record<string, FileFormat> = {
  csv: "csv",
  tsv: "tsv",
  tab: "tsv",
  psv: "psv",
  jsonl: "jsonl",
  ndjson: "jsonl",
  json: "json",
  parquet: "parquet",
  pq: "parquet",
  arrow: "arrow",
  feather: "arrow",
  ipc: "arrow",
};

const EXT_COMPRESSION: Record<string, Compression> = { gz: "gzip", gzip: "gzip", zst: "zstd", zstd: "zstd" };

/** File name from a URL or path: last path segment, without query or hash, URL-decoded. */
export function fileNameOf(src: string): string {
  const path = src.split(/[?#]/)[0] ?? src;
  const last = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * Format from a file name or URL, including double extensions like `.csv.gz` and
 * `.jsonl.zst`. Returns null for anything unsupported.
 */
export function detectFormat(nameOrUrl: string): DetectedFormat | null {
  const parts = fileNameOf(nameOrUrl).toLowerCase().split(".");
  if (parts.length < 2) return null;
  let last = parts[parts.length - 1]!;
  let compression: Compression = null;
  if (last in EXT_COMPRESSION) {
    compression = EXT_COMPRESSION[last]!;
    if (parts.length < 3) return null;
    last = parts[parts.length - 2]!;
  }
  const format = EXT_FORMAT[last];
  if (!format) return null;
  // Parquet and Arrow carry their own compression; a .gz around them isn't readable in place.
  if (compression && (format === "parquet" || format === "arrow")) return null;
  return { format, compression, ext: compression ? `${last}.${parts[parts.length - 1]}` : last };
}

export function formatLabel(f: DetectedFormat): string {
  const base = f.format === "jsonl" ? "JSONL" : f.format.toUpperCase();
  return f.compression ? `${base} (${f.compression})` : base;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Table function call that reads a registered file, e.g. `read_csv_auto('f1_orders.csv')`. */
export function readerSql(path: string, f: DetectedFormat): string {
  const p = lit(path);
  const comp = f.compression ? `, compression = ${lit(f.compression)}` : "";
  switch (f.format) {
    case "csv":
      return `read_csv_auto(${p}${comp})`;
    case "tsv":
      return `read_csv_auto(${p}, delim = '\\t'${comp})`;
    case "psv":
      return `read_csv_auto(${p}, delim = '|'${comp})`;
    case "jsonl":
      return `read_json_auto(${p}, format = 'newline_delimited'${comp})`;
    case "json":
      return `read_json_auto(${p}${comp})`;
    case "parquet":
      return `read_parquet(${p})`;
    case "arrow":
      throw new Error("Arrow files are loaded through Arrow IPC, not a table function");
  }
}

// --- Sheet commands --------------------------------------------------------------------

export interface OrderBy {
  column: string;
  dir?: "asc" | "desc";
}

const q = (name: string) => duckdbDialect.quoteIdent(name);
const table = (t: string) => q(t);

function whereClause(where?: string | string[]): string {
  const list = (Array.isArray(where) ? where : where ? [where] : []).map((w) => w.trim()).filter(Boolean);
  if (!list.length) return "";
  return ` WHERE ${list.length === 1 ? list[0] : list.map((w) => `(${w})`).join(" AND ")}`;
}

function orderClause(orderBy?: string | OrderBy[]): string {
  if (!orderBy || (Array.isArray(orderBy) && !orderBy.length)) return "";
  if (typeof orderBy === "string") return orderBy.trim() ? ` ORDER BY ${orderBy}` : "";
  return ` ORDER BY ${orderBy.map((o) => `${q(o.column)} ${o.dir === "desc" ? "DESC" : "ASC"}`).join(", ")}`;
}

/** Column summary (DuckDB SUMMARIZE): type, min, max, unique, nulls, mean, quartiles. */
export function summarize(where?: string | string[], from: string = FILE_SHEET_TABLE): string {
  const w = whereClause(where);
  return w ? `SUMMARIZE SELECT * FROM ${table(from)}${w}` : `SUMMARIZE ${table(from)}`;
}

/**
 * The sheet with filters and sort applied. `where` is SQL (string or list, ANDed);
 * `orderBy` is SQL text or a list of {column, dir}.
 */
export function sortedFiltered(
  where?: string | string[],
  orderBy?: string | OrderBy[],
  opts: { from?: string; limit?: number; offset?: number } = {},
): string {
  const limit = opts.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(opts.limit))}` : "";
  const offset = opts.offset ? ` OFFSET ${Math.max(0, Math.floor(opts.offset))}` : "";
  return `SELECT * FROM ${table(opts.from ?? FILE_SHEET_TABLE)}${whereClause(where)}${orderClause(orderBy)}${limit}${offset}`;
}

/** Row count with filters applied. */
export function countRows(where?: string | string[], from: string = FILE_SHEET_TABLE): string {
  return `SELECT count(*) AS "count" FROM ${table(from)}${whereClause(where)}`;
}

// --- Save as ----------------------------------------------------------------------------

export type SaveFormat = "csv" | "tsv" | "jsonl" | "json" | "parquet";

/**
 * COPY into `target` in `format`. `from` is a quoted table name or a parenthesised query.
 * `use_tmp_file false` makes COPY write straight into the registered buffer.
 */
export function copyToSql(target: string, format: SaveFormat, from: string = table(FILE_SHEET_TABLE)): string {
  const opts: Record<SaveFormat, string> = {
    csv: "FORMAT csv, HEADER true",
    tsv: "FORMAT csv, HEADER true, DELIMITER '\\t'",
    jsonl: "FORMAT json",
    json: "FORMAT json, ARRAY true",
    parquet: "FORMAT parquet",
  };
  return `COPY ${from} TO ${lit(target)} (${opts[format]}, use_tmp_file false)`;
}

/** Save format for a file name (the format the file was opened as, when it can be written). */
export function saveFormatFor(name: string): SaveFormat | null {
  const f = detectFormat(name);
  if (!f || f.compression) return null;
  if (f.format === "psv" || f.format === "arrow") return null;
  return f.format;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}
