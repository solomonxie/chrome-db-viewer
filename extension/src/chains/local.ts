// The chain's local DuckDB (DESIGN.md §3.15): one in-memory database per chain run, where each
// step's result is a table step_<name>. Built on the DuckDB driver (src/drivers/duckdb), so it
// uses the page's shared DuckDB-WASM in the browser and the blocking Node build in tests.

import { collect, type Cell, type Column, type Driver } from "@core/types";
import type { DuckEngine } from "../drivers/duckdb/engine";
import type { ResultTable } from "../collections/model";

export type ExportFormat = "csv" | "jsonl" | "parquet";

export interface LocalDb {
  /** Creates (or replaces) `table` from rows that came from another connection. */
  load(table: string, data: ResultTable): Promise<void>;
  /** CREATE OR REPLACE TABLE `table` AS `sql`, then reads it back. */
  createAs(table: string, sql: string, signal?: AbortSignal): Promise<ResultTable>;
  query(sql: string, signal?: AbortSignal): Promise<ResultTable>;
  hasTable(table: string): boolean;
  /** COPY (sql) TO an in-memory file in `format`, returning the bytes. */
  exportBytes(format: ExportFormat, sql: string): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Name of a step's table in the local database. */
export const stepTable = (step: string) => `step_${step}`;

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
let fileSeq = 0;

/**
 * DuckDB type for a column reported by another engine (BigQuery INT64, Postgres int8,
 * ClickHouse Nullable(UInt32) …). Unknown types stay VARCHAR.
 */
export function duckType(type: string): string {
  const t = type.trim().replace(/^Nullable\((.*)\)$/i, "$1").replace(/^LowCardinality\((.*)\)$/i, "$1");
  const u = t.toUpperCase();
  if (/^DECIMAL\(\s*\d+\s*,\s*\d+\s*\)$/.test(u)) return u.replace(/\s+/g, "");
  if (/^(U?HUGEINT|UINT64|UINT128|UINT256|INT128|INT256|UBIGINT|BIGNUMERIC|BIGDECIMAL)$/.test(u)) return "HUGEINT";
  if (/^(INT\d*|INTEGER|BIGINT|SMALLINT|TINYINT|UINT\d*|UINTEGER|USMALLINT|UTINYINT|SERIAL\d*|BIGSERIAL|SMALLSERIAL|OID)$/.test(u)) {
    return "BIGINT";
  }
  if (/^(FLOAT\d*|DOUBLE( PRECISION)?|REAL|FLOAT64)$/.test(u)) return "DOUBLE";
  if (/^(NUMERIC|DECIMAL)(\(.*\))?$/.test(u) || /^DECIMAL\d+\(.*\)$/.test(u)) return "DOUBLE";
  if (/^(BOOL|BOOLEAN)$/.test(u)) return "BOOLEAN";
  if (/^DATE(32)?$/.test(u)) return "DATE";
  if (/^(TIMESTAMPTZ|TIMESTAMP WITH TIME ZONE|TIMESTAMP_TZ)$/.test(u)) return "TIMESTAMPTZ";
  if (/^(TIMESTAMP|DATETIME|DATETIME64.*|TIMESTAMP WITHOUT TIME ZONE|TIMESTAMP_[SMN]S|TIMESTAMP\(\d\))$/.test(u)) return "TIMESTAMP";
  if (/^(TIME|TIME WITHOUT TIME ZONE)$/.test(u)) return "TIME";
  if (/^(JSON|JSONB|STRUCT.*|RECORD|ARRAY.*|MAP.*|LIST|TUPLE.*|.*\[\])$/.test(u)) return "JSON";
  return "VARCHAR";
}

/** Unique, non-empty column names (a result may have `a, a` or an unnamed expression). */
function uniqueNames(columns: Column[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((c, i) => {
    const base = c.name || `col${i + 1}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}_${n + 1}` : base;
  });
}

function jsonCell(v: Cell, type: string): unknown {
  if (v === null || v === undefined) return null;
  if (type === "JSON") return v;
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

/** Opens a fresh in-memory local database. `engine` defaults to the page's DuckDB-WASM. */
export async function createLocalDb(engine?: () => Promise<DuckEngine>): Promise<LocalDb> {
  const mod = await import("../drivers/duckdb/index");
  const getEngine = engine ?? (async () => (await import("../drivers/duckdb/browser")).getBrowserEngine());
  let eng: DuckEngine | null = null;
  const driver = mod.createDriver({
    engine: async () => {
      eng = await getEngine();
      return eng;
    },
  });
  await driver.connect({ id: "chain-local", name: "chain", driver: "duckdb", env: "local", readOnly: false, options: {} });
  const duck = mod.asDuckDriver(driver)!;
  return new DuckLocalDb(driver, () => eng!, (fmt, sql) => duck.exportBytes(fmt, sql));
}

class DuckLocalDb implements LocalDb {
  private tables = new Set<string>();
  constructor(
    private readonly driver: Driver,
    private readonly engine: () => DuckEngine,
    private readonly exporter: (format: ExportFormat, sql: string) => Promise<Uint8Array>,
  ) {}

  private async run(sql: string, signal?: AbortSignal): Promise<ResultTable> {
    const { columns, rows } = await collect(this.driver.execute({ sql, pageSize: 10_000 }, signal));
    return { columns, rows };
  }

  hasTable(table: string): boolean {
    return this.tables.has(table);
  }

  async load(table: string, data: ResultTable): Promise<void> {
    const names = uniqueNames(data.columns);
    const types = data.columns.map((c) => duckType(c.type));
    if (!names.length) {
      await this.run(`CREATE OR REPLACE TABLE ${q(table)} AS SELECT NULL AS "result" WHERE false`);
      this.tables.add(table);
      return;
    }
    if (!data.rows.length) {
      await this.run(`CREATE OR REPLACE TABLE ${q(table)} (${names.map((n, i) => `${q(n)} ${types[i]}`).join(", ")})`);
      this.tables.add(table);
      return;
    }
    // Rows go in as a JSON file (positional keys c0…cN), read with every column as text or
    // JSON, then cast to the mapped types. If a cast fails, the table keeps text columns.
    const file = `dbui_chain_${++fileSeq}_${Math.random().toString(36).slice(2, 8)}.json`;
    const raw = types.map((t) => (t === "JSON" ? "JSON" : "VARCHAR"));
    const objs = data.rows.map((r) => Object.fromEntries(names.map((_, i) => [`c${i}`, jsonCell(r[i] ?? null, raw[i]!)])));
    const engine = this.engine();
    await engine.registerFileBuffer(file, new TextEncoder().encode(JSON.stringify(objs)));
    const reader = `read_json(${lit(file)}, format = 'array', columns = {${raw.map((t, i) => `${lit(`c${i}`)}: ${lit(t)}`).join(", ")}})`;
    const select = (typed: boolean) =>
      names.map((n, i) => (typed && types[i] !== raw[i] ? `CAST(c${i} AS ${types[i]}) AS ${q(n)}` : `c${i} AS ${q(n)}`)).join(", ");
    try {
      try {
        await this.run(`CREATE OR REPLACE TABLE ${q(table)} AS SELECT ${select(true)} FROM ${reader}`);
      } catch {
        await this.run(`CREATE OR REPLACE TABLE ${q(table)} AS SELECT ${select(false)} FROM ${reader}`);
      }
    } finally {
      await engine.dropFile(file).catch(() => undefined);
    }
    this.tables.add(table);
  }

  async createAs(table: string, sql: string, signal?: AbortSignal): Promise<ResultTable> {
    const body = sql.trim().replace(/;\s*$/, "");
    await this.run(`CREATE OR REPLACE TABLE ${q(table)} AS ${body}`, signal);
    this.tables.add(table);
    return this.run(`SELECT * FROM ${q(table)}`, signal);
  }

  query(sql: string, signal?: AbortSignal): Promise<ResultTable> {
    return this.run(sql, signal);
  }

  exportBytes(format: ExportFormat, sql: string): Promise<Uint8Array> {
    return this.exporter(format, sql.trim().replace(/;\s*$/, ""));
  }

  async close(): Promise<void> {
    this.tables.clear();
    await this.driver.disconnect();
  }
}
