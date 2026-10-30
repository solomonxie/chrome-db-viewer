// Chain runner (DESIGN.md §3.15). Runs a chain's steps in dependency order, level by level
// (steps in one level run in parallel), and reports per-step events.
//
// Data flow:
// - Every step's result can be read as table step_<name> in the run's local DuckDB.
// - A Query step that refs a Query step on the same SQL connection inlines it as a CTE, so
//   the warehouse does the work. An upstream step whose only readers inline it isn't run on
//   its own.
// - Across connections, values travel as variables (Set variables → {{ ids | sql_list }}),
//   up to a cap. Ref'ing another connection's table in a remote query is an error.
//
// Everything outside the chain (template engine, script sandbox, connections, files) comes
// in through ChainDeps, so the runner is testable with fakes.

import { collect, type Cell, type Column, type ConnectionConfig, type Driver, type DriverId, type Statement } from "@core/types";
import type { Chain, ChainStep, NamedQuery, RenderOptions, RenderResult, ResultTable, SandboxResponse } from "../collections/model";
import { findDestructive, isWriteStatement, type Destructive } from "../app/lib/safety";
import { chainCache, hashString, hashTable, hashValue, stableJson, type CacheEntry } from "./cache";
import { evaluate, exprVariables } from "./expr";
import { ancestors, buildGraph, descendants, findRefs, type ChainGraph } from "./graph";
import { EMPTY_LIBRARY, type ChainLibrary } from "./library";
import { createLocalDb, stepTable, type ExportFormat, type LocalDb } from "./local";
import { sqlIdent } from "./miniRender";
import { splitStatementsRaw } from "../collections/split";

export const DEFAULT_VALUE_CAP = 10_000;
export const DEFAULT_PREVIEW_ROWS = 200;
/** BigQuery's default cost guard (10 GiB), used when a connection doesn't set one. */
export const DEFAULT_MAX_BYTES = 10 * 1024 ** 3;

export const CROSS_CONNECTION_ERROR = "use a Transform: SQL step to combine results from different connections";

export type StepStatus = "queued" | "running" | "done" | "failed" | "skipped";

export interface StepEvent {
  type: "step";
  step: string;
  status: StepStatus;
  rowCount?: number;
  ms?: number;
  bytesBilled?: number;
  renderedSql?: string;
  columns?: Column[];
  preview?: Cell[][];
  tests?: { name: string; passed: boolean }[];
  logs?: string[];
  /** Variables this step set (Set variables, scripts). */
  vars?: Record<string, unknown>;
  error?: string;
  /** Result came from the session cache. */
  cached?: boolean;
  /** Not run on its own: inlined as a CTE into these steps. */
  inlinedInto?: string[];
  /** Export: the file name handed to saveFile. */
  file?: string;
  /** Why the step was skipped. */
  reason?: string;
}

export interface ChainStartEvent {
  type: "start";
  levels: string[][];
  /** Steps this run touches, in run order. */
  steps: string[];
}

export type ChainRunStatus = "done" | "failed" | "cancelled" | "blocked";

export interface ChainEndEvent {
  type: "end";
  status: ChainRunStatus;
  error?: string;
  failedStep?: string;
  /** Chain variables after the run. */
  vars: Record<string, unknown>;
  /** The combined dry run, when the run was blocked by a cost guard. */
  estimate?: ChainEstimate;
}

export type ChainEvent = ChainStartEvent | StepEvent | ChainEndEvent;

export interface ChainRunSummary extends Omit<ChainEndEvent, "type"> {
  /** Last event per step. */
  steps: Record<string, StepEvent>;
}

export interface RunOptions {
  /** all (default), from: `step` and everything downstream, only: just `step` (upstream from cache or run). */
  mode?: "all" | "from" | "only";
  step?: string;
  /** Chain variable values set in the UI; override defaults. */
  vars?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Run even when a step's estimate is over its connection's cost guard. */
  allowOverLimit?: boolean;
  /** Ignore cached results for these steps. Default: the step(s) picked by from/only. */
  force?: string[];
  /** Largest list a variable may carry into a query (default 10,000). */
  valueCap?: number;
  previewRows?: number;
}

export interface ScriptChainResult {
  ok: boolean;
  vars: Record<string, unknown>;
  varChanges: Record<string, unknown>;
  envChanges: Record<string, unknown>;
  tests: { name: string; passed: boolean }[];
  logs: string[];
  error?: string;
}

export interface ChainDeps {
  render(template: string, opts: RenderOptions): RenderResult;
  runScript(req: { kind: "transform"; code: string; vars: Record<string, unknown>; inputs: Record<string, ResultTable>; timeoutMs?: number }): Promise<SandboxResponse>;
  runPreScripts(scripts: string[], vars: Record<string, unknown>, env: Record<string, unknown>): Promise<ScriptChainResult>;
  /** `results` is every statement's result when the named query has several (result is the last). */
  runPostScripts(scripts: string[], vars: Record<string, unknown>, env: Record<string, unknown>, result: ResultTable, results?: ResultTable[]): Promise<ScriptChainResult>;
  /** Saved connection settings (no secret). */
  loadConnection(id: string): Promise<ConnectionConfig | undefined>;
  /** A connected driver for the connection; the runner calls disconnect at the end of the run. */
  connect(cfg: ConnectionConfig, signal?: AbortSignal): Promise<Driver>;
  library?: ChainLibrary;
  /** Export steps hand their bytes here (file picker / download in the app). */
  saveFile?(name: string, bytes: Uint8Array, format: ExportFormat): Promise<void>;
  /** The run's local DuckDB (default: a fresh in-memory database on the page's DuckDB-WASM). */
  createLocalDb?(): Promise<LocalDb>;
  /**
   * A destructive statement on a production connection (§3.13). Return true to run it.
   * Without this hook such statements are refused.
   */
  confirmDestructive?(info: { step: string; connection: ConnectionConfig; statement: Destructive }): Promise<boolean>;
}

/** Drivers whose SQL can take another query of the same connection as a CTE. */
const SQL_DRIVERS = new Set<DriverId>(["bigquery", "clickhouse", "postgres", "sqlite", "duckdb"]);

export function dialectOf(driver: DriverId): RenderOptions["dialect"] {
  return driver === "file" ? "duckdb" : driver;
}

// ---------------------------------------------------------------------------------------
// Shared run context

interface Rendered {
  /** Final SQL sent to the driver (CTE prefix included); every statement when there are several. */
  sql: string;
  /**
   * The statements in run order. A named query with several statements runs the earlier ones as
   * setup; the last one (with the CTE prefix) is the step's output.
   */
  statements: string[];
  /** The step's own SQL, without the WITH prefix from inlined upstream steps. */
  body: string;
  /** Inlined upstream steps in dependency order: [name, body]. */
  ctes: [string, string][];
  usedVars: string[];
}

class StepError extends Error {
  constructor(
    message: string,
    public readonly extra: Partial<StepEvent> = {},
  ) {
    super(message);
  }
}

interface Ctx {
  chain: Chain;
  deps: ChainDeps;
  lib: ChainLibrary;
  graph: ChainGraph;
  vars: Record<string, unknown>;
  cap: number;
  connCfg: Map<string, Promise<ConnectionConfig>>;
  drivers: Map<string, Promise<Driver>>;
  rendered: Map<string, Rendered>;
  signal?: AbortSignal;
}

function namedQuery(ctx: Pick<Ctx, "lib">, step: ChainStep): NamedQuery | undefined {
  if (step.kind !== "query" || !step.queryId) return undefined;
  const q = ctx.lib.query(step.queryId);
  if (!q) throw new StepError(`Step "${step.name}" uses a named query that no longer exists`);
  return q;
}

function stepConnectionId(ctx: Pick<Ctx, "lib">, step: ChainStep): string | undefined {
  const q = step.kind === "query" && step.queryId ? ctx.lib.query(step.queryId) : undefined;
  return step.connectionId || q?.connectionId || ctx.lib.defaultConnectionId;
}

function stepTemplateText(ctx: Pick<Ctx, "lib">, step: ChainStep): string {
  const q = namedQuery(ctx, step);
  return q ? q.sql : (step.sql ?? "");
}

async function connConfig(ctx: Ctx, id: string): Promise<ConnectionConfig> {
  let p = ctx.connCfg.get(id);
  if (!p) {
    p = ctx.deps.loadConnection(id).then((c) => {
      if (!c) throw new StepError(`Connection ${id} doesn't exist any more`);
      return c;
    });
    ctx.connCfg.set(id, p);
  }
  return p;
}

async function connDriver(ctx: Ctx, id: string): Promise<Driver> {
  let p = ctx.drivers.get(id);
  if (!p) {
    p = connConfig(ctx, id).then((cfg) => ctx.deps.connect(cfg, ctx.signal));
    ctx.drivers.set(id, p);
    // Don't leave a rejected promise around for the next step to trip over twice.
    p.catch(() => ctx.drivers.delete(id));
  }
  return p;
}

function baseVars(chain: Chain, lib: ChainLibrary, override?: Record<string, unknown>): Record<string, unknown> {
  const vars: Record<string, unknown> = { ...lib.vars };
  for (const v of chain.vars) if (v.value !== undefined) vars[v.name] = v.value;
  return { ...vars, ...(override ?? {}) };
}

function graphFor(chain: Chain, lib: ChainLibrary): ChainGraph {
  return buildGraph(chain, {
    resolveSql: (s) => (s.queryId ? lib.query(s.queryId)?.sql : undefined),
    isLibraryRef: (name) => lib.templates.resolve(name) !== undefined,
  });
}

/** True when `up` can be inlined as a CTE into query step `down`. */
async function canInline(ctx: Ctx, down: ChainStep, up: ChainStep): Promise<boolean> {
  if (down.kind !== "query" || up.kind !== "query") return false;
  const a = stepConnectionId(ctx, down);
  const b = stepConnectionId(ctx, up);
  if (!a || a !== b) return false;
  // A step with setup statements must run them itself, so it can't become a CTE.
  if (splitStatementsRaw(stepTemplateText(ctx, up)).length > 1) return false;
  return SQL_DRIVERS.has((await connConfig(ctx, a)).driver);
}

function checkValueCap(name: string, v: unknown, cap: number): void {
  if (Array.isArray(v) && v.length > cap) {
    throw new StepError(
      `"${name}" holds ${v.length.toLocaleString("en-US")} values, over the limit of ${cap.toLocaleString("en-US")}. ` +
        `Pass the table with a Transform: SQL step instead.`,
    );
  }
}

/** Renders a query step: ref to same-connection query steps → CTE, other refs → error. */
async function renderQuery(ctx: Ctx, step: ChainStep, vars: Record<string, unknown>): Promise<Rendered> {
  const connId = stepConnectionId(ctx, step);
  if (!connId) throw new StepError(`Step "${step.name}" has no connection`);
  const cfg = await connConfig(ctx, connId);
  const dialect = dialectOf(cfg.driver);
  const q = namedQuery(ctx, step);
  const template = stepTemplateText(ctx, step);
  if (!template.trim()) throw new StepError(`Step "${step.name}" has no SQL`);

  // Decide each ref up front (render's ref callback is synchronous).
  const inline = new Map<string, boolean>();
  for (const r of findRefs(template)) {
    const up = ctx.graph.steps.get(r);
    if (up) inline.set(r, await canInline(ctx, step, up));
  }
  const ctes: [string, string][] = [];
  const addCte = (name: string, body: string) => {
    if (!ctes.some(([n]) => n === name)) ctes.push([name, body]);
  };
  const ref = (name: string): string => {
    const up = ctx.graph.steps.get(name);
    if (!up) {
      // A query of the collection, not a workflow step: inline it as a subquery.
      const t = ctx.lib.templates.resolve(name);
      if (t === undefined) throw new StepError(`ref("${name}"): no step or query with that name`);
      return `(${ctx.deps.render(t, { dialect, vars, library: ctx.lib.templates, ref }).sql})`;
    }
    if (!inline.get(name)) {
      throw new StepError(`Step "${step.name}" refs "${name}" from another connection: ${CROSS_CONNECTION_ERROR}`);
    }
    const r = ctx.rendered.get(name);
    if (!r) throw new StepError(`Step "${name}" must be rendered before "${step.name}"`);
    for (const [n, b] of r.ctes) addCte(n, b);
    addCte(name, r.body);
    return sqlIdent(name, dialect);
  };

  let res: RenderResult;
  try {
    res = ctx.deps.render(template, { dialect, vars: { ...varDefaults(q), ...vars }, library: ctx.lib.templates, ref });
  } catch (e) {
    if (e instanceof StepError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(CROSS_CONNECTION_ERROR)) throw new StepError(msg);
    throw new StepError(`Could not render step "${step.name}": ${msg}`);
  }
  for (const v of res.usedVars) checkValueCap(v, vars[v], ctx.cap);
  const parts = splitStatementsRaw(res.sql);
  const body = parts.length ? parts[parts.length - 1]! : res.sql.trim().replace(/;\s*$/, "");
  const statements = [...parts.slice(0, -1), withCtes(ctes, body, dialect)];
  return { sql: statements.join(";\n\n"), statements, body, ctes, usedVars: res.usedVars };
}

function varDefaults(q: NamedQuery | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const v of q?.vars ?? []) if (v.value !== undefined) out[v.name] = v.value;
  return out;
}

/** WITH a AS (…), b AS (…) <body>; merges into the body's own WITH when it has one. */
export function withCtes(ctes: [string, string][], body: string, dialect: RenderOptions["dialect"]): string {
  if (!ctes.length) return body;
  const defs = ctes.map(([n, b]) => `${sqlIdent(n, dialect)} AS (\n${b}\n)`).join(",\n");
  const m = /^\s*WITH\s+(RECURSIVE\s+)?/i.exec(body);
  if (m) return `WITH ${m[1] ?? ""}${defs},\n${body.slice(m[0].length)}`;
  return `WITH ${defs}\n${body}`;
}

// ---------------------------------------------------------------------------------------
// Combined dry run

export interface StepEstimate {
  step: string;
  connectionId: string;
  bytes?: number;
  usd?: number;
  /** The connection's cost guard (options.maximumBytesBilled). */
  limit?: number;
  overLimit: boolean;
  renderedSql?: string;
  /** Why there's no estimate (unsupported driver, variables set during the run, error). */
  note?: string;
}

export interface ChainEstimate {
  steps: StepEstimate[];
  totalBytes: number;
  totalUsd?: number;
  /** Steps over their connection's cost guard. */
  overLimit: string[];
}

export interface EstimateOptions {
  vars?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Only these steps (default: every query step). */
  steps?: string[];
}

export function costLimit(cfg: ConnectionConfig): number {
  const v = Number(cfg.options.maximumBytesBilled ?? DEFAULT_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_BYTES;
}

/**
 * Dry-runs every query step on a driver that can estimate (BigQuery), rendering with the
 * variables known before the run. Steps whose SQL needs variables set during the run get a note.
 */
export async function estimateChain(chain: Chain, deps: ChainDeps, opts: EstimateOptions = {}): Promise<ChainEstimate> {
  const ctx = newCtx(chain, deps, opts.vars, opts.signal);
  try {
    return await estimateWith(ctx, opts.steps);
  } finally {
    await closeDrivers(ctx);
  }
}

async function estimateWith(ctx: Ctx, only?: string[]): Promise<ChainEstimate> {
  const out: ChainEstimate = { steps: [], totalBytes: 0, overLimit: [] };
  const want = only ? new Set(only) : null;
  for (const name of ctx.graph.order) {
    const step = ctx.graph.steps.get(name)!;
    if (step.kind !== "query") continue;
    // Render every query step (in order) so CTE inlining works for later ones.
    let rendered: Rendered | undefined;
    let renderErr: string | undefined;
    try {
      rendered = await renderQuery(ctx, step, ctx.vars);
      ctx.rendered.set(name, rendered);
    } catch (e) {
      renderErr = (e as Error).message;
    }
    if (want && !want.has(name)) continue;
    const connectionId = stepConnectionId(ctx, step) ?? "";
    const est: StepEstimate = { step: name, connectionId, overLimit: false, renderedSql: rendered?.sql };
    out.steps.push(est);
    if (!rendered) {
      est.note = setDuringRun(ctx, step) ? "Needs variables set during the run; estimated when it runs" : renderErr;
      continue;
    }
    try {
      const cfg = await connConfig(ctx, connectionId);
      const driver = await connDriver(ctx, connectionId);
      if (!driver.capabilities().costEstimate || !driver.estimate) {
        est.note = "No cost estimate for this connection";
        continue;
      }
      // Several statements: each is dry-run on its own and the bytes add up.
      const e = { bytes: 0, usd: undefined as number | undefined };
      for (const sql of rendered.statements) {
        const one = await driver.estimate({ sql }, ctx.signal);
        e.bytes += one.bytes;
        if (one.usd !== undefined) e.usd = (e.usd ?? 0) + one.usd;
      }
      est.bytes = e.bytes;
      est.usd = e.usd;
      est.limit = costLimit(cfg);
      est.overLimit = e.bytes > est.limit;
      out.totalBytes += e.bytes;
      if (e.usd !== undefined) out.totalUsd = (out.totalUsd ?? 0) + e.usd;
      if (est.overLimit) out.overLimit.push(name);
    } catch (e) {
      est.note = (e as Error).message;
    }
  }
  return out;
}

/** True when a step reads variables that a set-vars or script step produces. */
function setDuringRun(ctx: Ctx, step: ChainStep): boolean {
  return [...ancestors(ctx.graph, step.name)].some((a) => {
    const k = ctx.graph.steps.get(a)!.kind;
    return k === "set-vars" || k === "transform-script";
  });
}

// ---------------------------------------------------------------------------------------
// Running

function newCtx(chain: Chain, deps: ChainDeps, vars?: Record<string, unknown>, signal?: AbortSignal, cap = DEFAULT_VALUE_CAP): Ctx {
  const lib = deps.library ?? EMPTY_LIBRARY;
  return {
    chain,
    deps,
    lib,
    graph: graphFor(chain, lib),
    vars: baseVars(chain, lib, vars),
    cap,
    connCfg: new Map(),
    drivers: new Map(),
    rendered: new Map(),
    signal,
  };
}

async function closeDrivers(ctx: Ctx): Promise<void> {
  const all = [...ctx.drivers.values()];
  ctx.drivers.clear();
  await Promise.all(all.map((p) => p.then((d) => d.disconnect(), () => undefined).catch(() => undefined)));
}

/** A tiny unbounded async queue so parallel steps can report events to one generator. */
class Channel<T> {
  private items: T[] = [];
  private waiting: ((v: IteratorResult<T>) => void) | null = null;
  private closed = false;
  push(v: T) {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: v, done: false });
    } else this.items.push(v);
  }
  close() {
    this.closed = true;
    if (this.waiting) this.waiting({ value: undefined as never, done: true });
    this.waiting = null;
  }
  next(): Promise<IteratorResult<T>> {
    const v = this.items.shift();
    if (v !== undefined) return Promise.resolve({ value: v, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((r) => (this.waiting = r));
  }
}

/**
 * Runs a chain and yields step events as they happen. The generator's return value is the
 * summary. Stops at the first failed step and marks the steps after it skipped.
 */
export async function* runChain(chain: Chain, opts: RunOptions, deps: ChainDeps): AsyncGenerator<ChainEvent, ChainRunSummary, void> {
  const ch = new Channel<ChainEvent>();
  const last: Record<string, StepEvent> = {};
  let end: ChainEndEvent | undefined;
  const emit = (e: ChainEvent) => {
    if (e.type === "step") last[e.step] = e;
    if (e.type === "end") end = e;
    ch.push(e);
  };
  const work = execute(chain, opts, deps, emit).then(
    () => ch.close(),
    (e) => {
      emit({ type: "end", status: "failed", error: (e as Error).message ?? String(e), vars: {} });
      ch.close();
    },
  );
  for (;;) {
    const n = await ch.next();
    if (n.done) break;
    yield n.value;
  }
  await work;
  const { type: _t, ...rest } = end ?? { type: "end", status: "failed" as const, error: "Run ended without a result", vars: {} };
  return { ...rest, steps: last };
}

/** Runs a chain to the end and returns the summary (events go to `onEvent`). */
export async function runChainToEnd(chain: Chain, opts: RunOptions, deps: ChainDeps, onEvent?: (e: ChainEvent) => void): Promise<ChainRunSummary> {
  const gen = runChain(chain, opts, deps);
  for (;;) {
    const n = await gen.next();
    if (n.done) return n.value;
    onEvent?.(n.value);
  }
}

interface StepOutcome {
  event: Omit<StepEvent, "type" | "step" | "status">;
  result?: ResultTable;
  resultHash: string;
  varChanges?: Record<string, unknown>;
}

async function execute(chain: Chain, opts: RunOptions, deps: ChainDeps, emitOut: (e: ChainEvent) => void): Promise<void> {
  const statusOf = new Map<string, StepStatus>();
  const emit = (e: ChainEvent) => {
    if (e.type === "step") statusOf.set(e.step, e.status);
    emitOut(e);
  };
  let ctx: Ctx;
  try {
    ctx = newCtx(chain, deps, opts.vars, opts.signal, opts.valueCap ?? DEFAULT_VALUE_CAP);
  } catch (e) {
    emit({ type: "end", status: "failed", error: (e as Error).message, vars: {} });
    return;
  }
  const { graph } = ctx;
  const mode = opts.mode ?? "all";
  if (mode !== "all" && (!opts.step || !graph.steps.has(opts.step))) {
    emit({ type: "end", status: "failed", error: `No step named "${opts.step ?? ""}"`, vars: ctx.vars });
    return;
  }

  // Which steps run, and which must ignore the cache.
  const targets = new Set<string>(mode === "all" ? graph.order : mode === "from" ? [opts.step!, ...descendants(graph, opts.step!)] : [opts.step!]);
  const runSet = new Set(targets);
  for (const t of targets) for (const a of ancestors(graph, t)) runSet.add(a);
  const force = new Set(opts.force ?? (mode === "all" ? [] : mode === "from" ? [...targets] : [opts.step!]));
  const levels = graph.levels.map((l) => l.filter((n) => runSet.has(n))).filter((l) => l.length);
  const order = levels.flat();

  // Upstream query steps whose every reader inlines them as a CTE aren't run on their own.
  const inlinedInto = new Map<string, string[]>();
  try {
    for (const name of order) {
      const step = graph.steps.get(name)!;
      if (step.kind !== "query" || (mode === "only" && name === opts.step)) continue;
      const readers = graph.dependents.get(name)!.filter((d) => runSet.has(d));
      if (!readers.length) continue;
      if (namedQuery(ctx, step) && ctx.lib.scripts(namedQuery(ctx, step)!).post.length) continue;
      let all = true;
      for (const r of readers) {
        const down = graph.steps.get(r)!;
        if (!findRefs(stepTemplateText(ctx, down)).includes(name) || !(await canInline(ctx, down, step))) all = false;
      }
      if (all) inlinedInto.set(name, readers);
    }
  } catch {
    /* the step itself reports the problem */
  }

  emit({ type: "start", levels, steps: order });
  for (const n of order) emit({ type: "step", step: n, status: "queued" });

  // Combined dry run before anything starts.
  if (!opts.allowOverLimit) {
    const est = await estimateWith(newCtxShared(ctx), order.filter((n) => !inlinedInto.has(n)));
    if (est.overLimit.length) {
      const names = est.overLimit.map((n) => `"${n}"`).join(", ");
      for (const n of order) emit({ type: "step", step: n, status: "skipped", reason: "Blocked by the cost guard" });
      emit({ type: "end", status: "blocked", error: `Over the connection's cost guard: ${names}. Run anyway to allow it.`, estimate: est, vars: ctx.vars });
      await closeDrivers(ctx);
      return;
    }
  }

  const cache = chainCache(chain.id);
  const results = new Map<string, ResultTable>();
  const hashes = new Map<string, string>();
  let local: Promise<LocalDb> | undefined;
  const getLocal = () => (local ??= (deps.createLocalDb ?? (() => createLocalDb()))());
  const ensureLoaded = async (name: string) => {
    const db = await getLocal();
    if (db.hasTable(stepTable(name))) return db;
    const t = results.get(name);
    if (!t) throw new StepError(`Step "${name}" has no result table`);
    await db.load(stepTable(name), t);
    return db;
  };

  let failed: { step: string; error: string } | undefined;
  let cancelled = false;
  const finished = new Set<string>();

  const runOne = async (name: string): Promise<void> => {
    const step = graph.steps.get(name)!;
    const started = Date.now();
    emit({ type: "step", step: name, status: "running" });
    const varsAtStart = { ...ctx.vars };
    try {
      const out = await runStep(step, varsAtStart);
      // Also on cache hits: the cap may be lower than when the values were cached.
      if (step.kind === "set-vars" || step.kind === "transform-script") {
        for (const [k, v] of Object.entries(out.varChanges ?? {})) checkValueCap(k, v, ctx.cap);
      }
      hashes.set(name, out.resultHash);
      if (out.result) results.set(name, out.result);
      if (out.varChanges) {
        for (const [k, v] of Object.entries(out.varChanges)) {
          if (v === null) delete ctx.vars[k];
          else ctx.vars[k] = v;
        }
      }
      finished.add(name);
      emit({ type: "step", step: name, status: "done", ms: Date.now() - started, ...out.event });
    } catch (e) {
      const aborted = ctx.signal?.aborted;
      const error = aborted ? "Cancelled" : e instanceof Error ? e.message : String(e);
      if (aborted) cancelled = true;
      failed ??= { step: name, error };
      emit({ type: "step", step: name, status: "failed", ms: Date.now() - started, error, ...(e instanceof StepError ? e.extra : {}) });
    }
  };

  const preview = (t: ResultTable) => ({ columns: t.columns, preview: t.rows.slice(0, opts.previewRows ?? DEFAULT_PREVIEW_ROWS), rowCount: t.rows.length });
  const fromCache = (c: CacheEntry): StepOutcome => ({
    event: {
      cached: true,
      renderedSql: c.renderedSql,
      bytesBilled: c.bytesBilled,
      tests: c.tests,
      logs: c.logs,
      ...(c.result ? preview(c.result) : { rowCount: c.rowCount }),
      ...(c.varChanges && Object.keys(c.varChanges).length ? { vars: c.varChanges } : {}),
    },
    result: c.result,
    resultHash: c.resultHash,
    varChanges: c.varChanges,
  });
  const keyFor = (step: ChainStep, parts: Record<string, unknown>) =>
    hashValue({ def: { ...step, id: undefined }, inputs: graph.inputs.get(step.name)!.map((i) => [i, hashes.get(i) ?? ""]), ...parts });
  const lookup = (step: ChainStep, key: string): CacheEntry | undefined => {
    if (force.has(step.name)) return undefined;
    const c = cache.get(step.name);
    return c && c.key === key ? c : undefined;
  };
  const store = (step: ChainStep, key: string, out: StepOutcome, ms: number) => {
    cache.set(step.name, {
      key,
      result: out.result,
      resultHash: out.resultHash,
      renderedSql: out.event.renderedSql,
      varChanges: out.varChanges,
      rowCount: out.result?.rows.length ?? 0,
      ms,
      bytesBilled: out.event.bytesBilled,
      tests: out.event.tests,
      logs: out.event.logs,
      at: Date.now(),
    });
  };
  const inputTables = (step: ChainStep): Record<string, ResultTable> => {
    const out: Record<string, ResultTable> = {};
    for (const i of graph.inputs.get(step.name)!) {
      const t = results.get(i);
      if (t) out[i] = t;
    }
    return out;
  };

  const runStep = async (step: ChainStep, vars: Record<string, unknown>): Promise<StepOutcome> => {
    const t0 = Date.now();
    switch (step.kind) {
      case "query": {
        const q = namedQuery(ctx, step);
        const scripts = q ? ctx.lib.scripts(q) : { pre: [], post: [] };
        let runVars = vars;
        let preChanges: Record<string, unknown> = {};
        const logs: string[] = [];
        const tests: { name: string; passed: boolean }[] = [];
        if (scripts.pre.length) {
          const pre = await deps.runPreScripts(scripts.pre, vars, ctx.lib.env);
          logs.push(...pre.logs);
          tests.push(...pre.tests);
          if (!pre.ok) throw new StepError(`Pre-run script failed: ${pre.error ?? "error"}`, { logs, tests });
          runVars = pre.vars;
          preChanges = pre.varChanges;
        }
        const r = await renderQuery(ctx, step, runVars);
        ctx.rendered.set(step.name, r);
        const inlined = inlinedInto.get(step.name);
        if (inlined) {
          return { event: { renderedSql: r.sql, inlinedInto: inlined }, resultHash: hashString(r.sql), varChanges: preChanges };
        }
        const connId = stepConnectionId(ctx, step)!;
        const cfg = await connConfig(ctx, connId);
        if (cfg.readOnly && isWriteStatement(r.sql)) {
          throw new StepError(`"${cfg.name}" is read-only: step "${step.name}" contains a write statement`, { renderedSql: r.sql });
        }
        if (cfg.env === "production") {
          const d = findDestructive(r.sql)[0];
          if (d && !(await deps.confirmDestructive?.({ step: step.name, connection: cfg, statement: d }))) {
            throw new StepError(`Step "${step.name}" would ${d.kind.replace("_", " ")} ${d.target} on production; not confirmed`, { renderedSql: r.sql });
          }
        }
        const usedVals = Object.fromEntries(r.usedVars.map((v) => [v, runVars[v]]));
        const key = keyFor(step, { sql: r.sql, conn: connId, vars: usedVals, pre: preChanges });
        const hit = lookup(step, key);
        if (hit) {
          const out = fromCache(hit);
          return { ...out, varChanges: { ...preChanges, ...(hit.varChanges ?? {}) } };
        }
        const driver = await connDriver(ctx, connId);
        const finalSql = r.statements[r.statements.length - 1]!;
        const stmt: Statement = { sql: finalSql, pageSize: 10_000 };
        if (driver.capabilities().costEstimate && driver.estimate) {
          // Steps whose SQL wasn't known before the run (variables set by earlier steps) get their dry run here.
          let bytes = 0;
          for (const sql of r.statements) bytes += (await driver.estimate({ sql }, ctx.signal)).bytes;
          const est = { bytes };
          const limit = costLimit(cfg);
          if (est.bytes > limit) {
            if (!opts.allowOverLimit) {
              throw new StepError(`Step "${step.name}" would scan ${est.bytes.toLocaleString("en-US")} bytes, over the connection's cost guard`, { renderedSql: r.sql });
            }
            stmt.options = { maximumBytesBilled: String(Math.ceil(est.bytes * 1.1)) };
          }
        }
        // Setup statements of a multi-statement named query run first; the last one is the output.
        let setupBytes = 0;
        const setupTables: ResultTable[] = [];
        for (const [i, sql] of r.statements.slice(0, -1).entries()) {
          try {
            const s = await collect(driver.execute({ sql, pageSize: 10_000, ...(stmt.options ? { options: stmt.options } : {}) }, ctx.signal));
            setupBytes += s.summary.bytesProcessed ?? 0;
            setupTables.push({ columns: s.columns, rows: s.rows });
          } catch (e) {
            throw new StepError(`Statement ${i + 1} of step "${step.name}" failed: ${(e as Error).message}`, { renderedSql: r.sql });
          }
        }
        const res = await collect(driver.execute(stmt, ctx.signal));
        if (setupBytes && res.summary.bytesProcessed !== undefined) res.summary.bytesProcessed += setupBytes;
        const table: ResultTable = { columns: res.columns, rows: res.rows };
        let postChanges: Record<string, unknown> = {};
        if (scripts.post.length) {
          const post = setupTables.length
            ? await deps.runPostScripts(scripts.post, runVars, ctx.lib.env, table, [...setupTables, table])
            : await deps.runPostScripts(scripts.post, runVars, ctx.lib.env, table);
          logs.push(...post.logs);
          tests.push(...post.tests);
          if (!post.ok) throw new StepError(`Post-run script failed: ${post.error ?? "error"}`, { logs, tests, renderedSql: r.sql, ...preview(table) });
          postChanges = post.varChanges;
        }
        const out: StepOutcome = {
          event: {
            renderedSql: r.sql,
            bytesBilled: res.summary.bytesProcessed,
            ...(tests.length ? { tests } : {}),
            ...(logs.length ? { logs } : {}),
            ...(Object.keys(postChanges).length ? { vars: postChanges } : {}),
            ...preview(table),
          },
          result: table,
          resultHash: hashTable(table),
          varChanges: { ...preChanges, ...postChanges },
        };
        store(step, key, { ...out, varChanges: postChanges }, Date.now() - t0);
        return out;
      }

      case "transform-sql": {
        if (!step.sql?.trim()) throw new StepError(`Step "${step.name}" has no SQL`);
        const r = renderLocal(step.sql, vars, step);
        const key = keyFor(step, { sql: r.sql, vars: Object.fromEntries(r.usedVars.map((v) => [v, vars[v]])) });
        const hit = lookup(step, key);
        if (hit) return fromCache(hit);
        let db: LocalDb | undefined;
        for (const i of graph.inputs.get(step.name)!) if (results.has(i)) db = await ensureLoaded(i);
        db ??= await getLocal();
        const table = await db.createAs(stepTable(step.name), r.sql, ctx.signal);
        const out: StepOutcome = { event: { renderedSql: r.sql, ...preview(table) }, result: table, resultHash: hashTable(table) };
        store(step, key, out, Date.now() - t0);
        return out;
      }

      case "transform-script": {
        if (!step.script?.trim()) throw new StepError(`Step "${step.name}" has no script`);
        const inputs = inputTables(step);
        const key = keyFor(step, { vars });
        const hit = lookup(step, key);
        if (hit) return fromCache(hit);
        const res = await deps.runScript({ kind: "transform", code: step.script, vars, inputs });
        if (!res.ok) throw new StepError(res.error ?? "Script failed", { logs: res.logs, tests: res.tests });
        const changes = res.varChanges ?? {};
        for (const [k, v] of Object.entries(changes)) checkValueCap(k, v, ctx.cap);
        const table = res.result;
        const out: StepOutcome = {
          event: {
            ...(res.logs.length ? { logs: res.logs } : {}),
            ...(res.tests.length ? { tests: res.tests } : {}),
            ...(Object.keys(changes).length ? { vars: changes } : {}),
            ...(table ? preview(table) : { rowCount: 0 }),
          },
          result: table,
          resultHash: table ? hashTable(table) : hashValue(changes),
          varChanges: changes,
        };
        store(step, key, out, Date.now() - t0);
        return out;
      }

      case "set-vars": {
        const assignments = Object.entries(step.assignments ?? {});
        if (!assignments.length) throw new StepError(`Step "${step.name}" sets no variables`);
        const used = [...new Set(assignments.flatMap(([, e]) => exprVariables(e)))];
        const key = keyFor(step, { vars: Object.fromEntries(used.map((v) => [v, vars[v]])) });
        const hit = lookup(step, key);
        if (hit) return fromCache(hit);
        const exprCtx = { table: (n: string) => results.get(n), vars: { ...vars } };
        const set: Record<string, unknown> = {};
        for (const [name, expr] of assignments) {
          if (!/^[A-Za-z_]\w*$/.test(name)) throw new StepError(`"${name}" is not a valid variable name`);
          let v: unknown;
          try {
            v = evaluate(expr, exprCtx);
          } catch (e) {
            throw new StepError(`${name} = ${expr}: ${(e as Error).message}`);
          }
          checkValueCap(name, v, ctx.cap);
          set[name] = v ?? null;
          exprCtx.vars[name] = v;
        }
        const table: ResultTable = {
          columns: [
            { name: "variable", type: "VARCHAR", nullable: false },
            { name: "value", type: "JSON", nullable: true },
          ],
          rows: Object.entries(set).map(([k, v]) => [k, v as Cell]),
        };
        const out: StepOutcome = { event: { vars: set, ...preview(table) }, result: table, resultHash: hashValue(set), varChanges: set };
        store(step, key, out, Date.now() - t0);
        return out;
      }

      case "export": {
        const format = step.format ?? "csv";
        if (!deps.saveFile) throw new StepError("Exports aren't available here");
        let sql: string;
        if (step.sql?.trim()) sql = renderLocal(step.sql, vars, step).sql;
        else {
          const ins = graph.inputs.get(step.name)!.filter((i) => results.has(i));
          if (ins.length !== 1) throw new StepError(`Export step "${step.name}" needs SQL, or exactly one input step (dependsOn)`);
          sql = `SELECT * FROM ${sqlIdent(stepTable(ins[0]!), "duckdb")}`;
        }
        for (const i of graph.inputs.get(step.name)!) if (results.has(i)) await ensureLoaded(i);
        const db = await getLocal();
        const bytes = await db.exportBytes(format, sql);
        const file = `${safeFileName(ctx.chain.name)}_${step.name}.${format}`;
        await deps.saveFile(file, bytes, format);
        return { event: { renderedSql: sql, file, rowCount: undefined }, resultHash: hashString(sql + bytes.length) };
      }

      case "assert": {
        const cond = step.condition?.trim();
        if (!cond) throw new StepError(`Assert step "${step.name}" has no condition`);
        let v: unknown;
        try {
          v = evaluate(cond, { table: (n) => results.get(n), vars });
        } catch (e) {
          throw new StepError(`Assertion ${cond}: ${(e as Error).message}`);
        }
        const passed = Array.isArray(v) ? v.length > 0 : !!v;
        const tests = [{ name: cond, passed }];
        if (!passed) throw new StepError(`Assertion failed: ${cond}`, { tests });
        return { event: { tests }, resultHash: hashValue([cond, true]) };
      }
    }
  };

  const renderLocal = (template: string, vars: Record<string, unknown>, step: ChainStep) => {
    try {
      const r = deps.render(template, {
        dialect: "duckdb",
        vars,
        library: ctx.lib.templates,
        ref: (name) => {
          if (!graph.steps.has(name)) throw new StepError(`ref("${name}") in step "${step.name}" must name a step of this workflow`);
          return sqlIdent(stepTable(name), "duckdb");
        },
      });
      for (const v of r.usedVars) checkValueCap(v, vars[v], ctx.cap);
      return r;
    } catch (e) {
      if (e instanceof StepError) throw e;
      throw new StepError(`Could not render step "${step.name}": ${(e as Error).message}`);
    }
  };

  try {
    for (const level of levels) {
      if (ctx.signal?.aborted) {
        cancelled = true;
        break;
      }
      await Promise.all(level.map(runOne));
      if (failed) break;
    }
  } finally {
    for (const n of order) {
      if (!finished.has(n) && statusOf.get(n) !== "failed") {
        emit({ type: "step", step: n, status: "skipped", reason: failed ? `Stopped after "${failed.step}" failed` : "Cancelled" });
      }
    }
    await closeDrivers(ctx);
    if (local) await local.then((d) => d.close()).catch(() => undefined);
  }
  if (cancelled || ctx.signal?.aborted) emit({ type: "end", status: "cancelled", error: "Cancelled", failedStep: failed?.step, vars: ctx.vars });
  else if (failed) emit({ type: "end", status: "failed", error: failed.error, failedStep: failed.step, vars: ctx.vars });
  else emit({ type: "end", status: "done", vars: ctx.vars });
}

/** A copy of the context sharing connections, so the pre-run estimate renders independently. */
function newCtxShared(ctx: Ctx): Ctx {
  return { ...ctx, rendered: new Map(), vars: { ...ctx.vars } };
}

function safeFileName(s: string): string {
  return s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "workflow";
}

export { clearCache, cachedResult } from "./cache";
export { stableJson };
