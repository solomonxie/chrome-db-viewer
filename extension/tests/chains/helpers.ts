// Shared test setup for chains: fake remote drivers over fixture rows, the real DuckDB-WASM
// Node build for the local step tables, and a fake sandbox.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Capabilities, Cell, Column, ConnectionConfig, CostEstimate, Driver, DriverId, ExecuteSummary, ResultPage, Statement } from "../../src/core/types";
import type { Chain, ResultTable, SandboxResponse } from "../../src/collections/model";
import { render } from "../../src/collections/render";
import type { ChainDeps, ChainEvent, StepEvent } from "../../src/chains/runner";
import { createLocalDb } from "../../src/chains/local";
import { testEngine } from "../drivers/duckdb/engine";

const DIR = resolve(__dirname, "../fixtures/chains");
export const readFixture = (name: string) => readFileSync(resolve(DIR, name), "utf8");
export const loadChain = (name: string): Chain => JSON.parse(readFixture(name)) as Chain;
export const CONNECTIONS = JSON.parse(readFixture("connections.json")) as ConnectionConfig[];

interface FakeTable extends ResultTable {
  bytes?: number;
}

function csvTable(text: string): FakeTable {
  const [head, ...lines] = text.trim().split("\n");
  const names = head!.split(",");
  return {
    columns: names.map((n) => ({ name: n, type: "text", nullable: true })),
    rows: lines.map((l) => l.split(",")),
  };
}

export const BQ_TABLES = JSON.parse(readFixture("bq_tables.json")) as Record<string, FakeTable>;
export const PG_TABLES: Record<string, FakeTable> = { ads: csvTable(readFixture("ads.csv")) };

/** Every statement and dry run the fake drivers saw, per connection id. */
export interface DriverLog {
  executed: { conn: string; sql: string; options?: Record<string, unknown> }[];
  estimated: { conn: string; sql: string }[];
  connects: string[];
  disconnects: string[];
}

/**
 * A fake remote driver. execute() answers from the first fixture table named in the SQL;
 * `WHERE <col> IN (…)` filters it. slow_table waits until aborted.
 */
class FakeDriver implements Driver {
  readonly dialect;
  constructor(
    readonly id: DriverId,
    private readonly conn: string,
    private readonly tables: Record<string, FakeTable>,
    private readonly log: DriverLog,
  ) {
    this.dialect = {
      name: (id === "bigquery" ? "bigquery" : "postgres") as "bigquery" | "postgres",
      quoteIdent: (s: string) => `"${s}"`,
      literal: (v: Cell) => JSON.stringify(v),
    };
  }
  capabilities(): Capabilities {
    return { kind: this.id === "bigquery" ? "warehouse" : "relational", transactions: false, editableRows: false, costEstimate: this.id === "bigquery", cancel: true };
  }
  async connect() {
    this.log.connects.push(this.conn);
    return {};
  }
  async disconnect() {
    this.log.disconnects.push(this.conn);
  }
  async listObjects() {
    return [];
  }
  async describe(): Promise<never> {
    throw new Error("not used");
  }
  async apply(): Promise<never> {
    throw new Error("not used");
  }
  private pick(sql: string): FakeTable | undefined {
    const name = Object.keys(this.tables).find((t) => new RegExp(`\\b${t}\\b`).test(sql));
    return name ? this.tables[name] : undefined;
  }
  async *execute(stmt: Statement, signal?: AbortSignal): AsyncGenerator<ResultPage, ExecuteSummary, void> {
    this.log.executed.push({ conn: this.conn, sql: stmt.sql, options: stmt.options });
    if (/\bslow_table\b/.test(stmt.sql)) {
      await new Promise<void>((_res, rej) => {
        if (signal?.aborted) rej(new Error("Query cancelled"));
        signal?.addEventListener("abort", () => rej(new Error("Query cancelled")), { once: true });
      });
    }
    const t = this.pick(stmt.sql);
    if (!t) throw new Error(`fake ${this.conn}: no fixture table in: ${stmt.sql}`);
    let rows = t.rows;
    const m = /WHERE\s+(\w+)\s+IN\s+\(([^)]*)\)/i.exec(stmt.sql);
    if (m) {
      const col = t.columns.findIndex((c) => c.name === m[1]);
      const vals = new Set(m[2]!.split(",").map((s) => s.trim().replace(/^'|'$/g, "")));
      rows = rows.filter((r) => vals.has(String(r[col])));
    }
    const lim = /LIMIT\s+(\d+)/i.exec(stmt.sql);
    if (lim) rows = rows.slice(0, Number(lim[1]));
    yield { columns: t.columns as Column[], rows, seq: 0 };
    return { rowCount: rows.length, ms: 1, ...(this.id === "bigquery" ? { bytesProcessed: t.bytes ?? 0 } : {}) };
  }
  async estimate(stmt: Statement): Promise<CostEstimate> {
    this.log.estimated.push({ conn: this.conn, sql: stmt.sql });
    const bytes = Object.entries(this.tables)
      .filter(([n]) => new RegExp(`\\b${n}\\b`).test(stmt.sql))
      .reduce((a, [, t]) => a + (t.bytes ?? 0), 0);
    return { bytes };
  }
}

/** A fake sandbox: transform scripts are looked up by their exact code, never evaluated. */
export type FakeScript = (inputs: Record<string, ResultTable>, vars: Record<string, unknown>) => { rows: Record<string, Cell>[]; vars?: Record<string, unknown> };

function toTable(rows: Record<string, Cell>[]): ResultTable {
  const names = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return {
    columns: names.map((n) => ({ name: n, type: typeof rows[0]?.[n] === "number" ? "DOUBLE" : "VARCHAR", nullable: true })),
    rows: rows.map((r) => names.map((n) => r[n] ?? null)),
  };
}

export interface TestDeps extends ChainDeps {
  log: DriverLog;
  saved: { name: string; bytes: Uint8Array; format: string }[];
  scriptCalls: number;
}

export function makeDeps(opts: { scripts?: Record<string, FakeScript>; confirm?: boolean } = {}): TestDeps {
  const log: DriverLog = { executed: [], estimated: [], connects: [], disconnects: [] };
  const deps: TestDeps = {
    log,
    saved: [],
    scriptCalls: 0,
    render: (t, o) => render(t, o),
    async runScript(req): Promise<SandboxResponse> {
      deps.scriptCalls++;
      const fn = opts.scripts?.[req.code];
      if (!fn) return { id: "x", ok: false, varChanges: {}, envChanges: {}, tests: [], logs: [], error: "unknown script" };
      const out = fn(req.inputs, req.vars);
      return { id: "x", ok: true, varChanges: out.vars ?? {}, envChanges: {}, tests: [], logs: ["ran"], result: toTable(out.rows) };
    },
    async runPreScripts(_s, vars) {
      return { ok: true, vars, varChanges: {}, envChanges: {}, tests: [], logs: [] };
    },
    async runPostScripts(_s, vars) {
      return { ok: true, vars, varChanges: {}, envChanges: {}, tests: [], logs: [] };
    },
    async loadConnection(id) {
      return CONNECTIONS.find((c) => c.id === id);
    },
    async connect(cfg) {
      const d = new FakeDriver(cfg.driver, cfg.id, cfg.driver === "bigquery" ? BQ_TABLES : PG_TABLES, log);
      await d.connect();
      return d;
    },
    async saveFile(name, bytes, format) {
      deps.saved.push({ name, bytes, format });
    },
    createLocalDb: () => createLocalDb(testEngine),
    ...(opts.confirm !== undefined ? { confirmDestructive: async () => opts.confirm! } : {}),
  };
  return deps;
}

/** Last event per step from a list of events. */
export function lastByStep(events: ChainEvent[]): Record<string, StepEvent> {
  const out: Record<string, StepEvent> = {};
  for (const e of events) if (e.type === "step") out[e.step] = e;
  return out;
}
