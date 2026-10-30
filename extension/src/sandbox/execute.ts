// Pure script executor for the sandbox (DESIGN.md §3.14 pre/post scripts, §3.15 transform steps).
// It builds the `db` object, runs user code with `new Function` and normalises the result.
// The sandbox worker (worker.ts) calls it inside sandbox.html; tests call it directly in Node.
// It does not enforce the time limit: a busy loop can't be interrupted from inside, so the
// client (client.ts) kills the worker or the frame instead.

import type { Cell, Column } from "@core/types";
import type { ResultTable, SandboxRequest, SandboxResponse } from "../collections/model";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_ROWS = 1_000_000;
export const MAX_LOG_LINES = 1_000;

/** Globals user code must not reach. Shadowed as parameters and removed from the worker scope. */
export const BLOCKED_GLOBALS = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "WebTransport",
  "EventSource",
  "importScripts",
  "indexedDB",
  "caches",
  "Worker",
  "SharedWorker",
  "BroadcastChannel",
  "chrome",
  "browser",
] as const;

export interface ExecuteOptions {
  /** Cap on transform output rows. Default 1,000,000. */
  maxRows?: number;
  /** Clock for the date helpers; tests pin it. */
  now?: () => Date;
}

/** Table view handed to scripts: db.result in post scripts, inputs.x in transforms. */
export interface ScriptTable {
  /** Column names. */
  columns: string[];
  /** Full column metadata (name, type, nullable). */
  schema: Column[];
  /** Rows as objects keyed by column name. */
  rows: Record<string, Cell>[];
  /** Rows as arrays, in column order, as they came from the driver. */
  arrays: Cell[][];
  rowCount: number;
  /** All values of one column, in row order. Throws on an unknown column. */
  column(name: string): Cell[];
}

class FailSignal extends Error {}

/** Remove or neuter network and storage globals on a scope (the worker's self, or the sandbox window). */
export function hardenGlobals(scope: Record<string, unknown>, names: readonly string[] = BLOCKED_GLOBALS): void {
  for (const name of names) {
    // Web APIs like fetch live on the prototype chain (WorkerGlobalScope.prototype …); remove them there too.
    for (let o: object | null = scope; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      try {
        if (Object.prototype.hasOwnProperty.call(o, name)) delete (o as Record<string, unknown>)[name];
      } catch {
        // non-configurable: shadow below
      }
    }
    if (name in scope && scope[name] !== undefined) {
      try {
        Object.defineProperty(scope, name, { value: undefined, writable: false, configurable: false });
      } catch {
        // best effort; CSP connect-src 'none' still blocks the network
      }
    }
  }
  const nav = scope.navigator as Record<string, unknown> | undefined;
  if (nav && "sendBeacon" in nav) {
    try {
      Object.defineProperty(nav, "sendBeacon", { value: undefined, writable: false, configurable: false });
    } catch {
      // ignore
    }
  }
}

export function makeTable(t: ResultTable): ScriptTable {
  const names = t.columns.map((c) => c.name);
  let objects: Record<string, Cell>[] | undefined;
  return {
    columns: names,
    schema: t.columns,
    get rows() {
      if (!objects) {
        objects = t.rows.map((r) => {
          const o: Record<string, Cell> = {};
          names.forEach((n, i) => {
            o[n] = r[i] ?? null;
          });
          return o;
        });
      }
      return objects;
    },
    arrays: t.rows,
    rowCount: t.rows.length,
    column(name: string) {
      const i = names.indexOf(name);
      if (i < 0) throw new Error(`No column "${name}". Columns: ${names.join(", ")}`);
      return t.rows.map((r) => r[i] ?? null);
    },
  };
}

// ---- date helpers ----

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function ymd(d: unknown): [number, number, number] {
  if (typeof d === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    d = new Date(d);
  } else if (typeof d === "number") {
    d = new Date(d);
  }
  if (d instanceof Date && !Number.isNaN(d.getTime())) return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
  throw new Error(`Not a date: ${String(d)}`);
}

function fmt(y: number, m: number, day: number): string {
  return `${pad(y, 4)}-${pad(m)}-${pad(day)}`;
}

function makeDate(now: () => Date) {
  return {
    /** Today's local date as YYYY-MM-DD. */
    today: () => fmt(...ymd(now())),
    /** d (Date, YYYY-MM-DD string or epoch ms) plus n days, as YYYY-MM-DD. */
    addDays: (d: unknown, n: number) => {
      const [y, m, day] = ymd(d);
      const t = new Date(Date.UTC(y, m - 1, day + Math.trunc(Number(n))));
      return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    },
    /** Any date as YYYY-MM-DD. */
    format: (d: unknown) => fmt(...ymd(d)),
  };
}

// ---- logging ----

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "undefined";
  if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
  if (typeof v === "bigint") return `${v}n`;
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)) ?? String(v);
  } catch {
    return String(v);
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return stringify(e);
}

/** Make a value safe for postMessage: functions and other uncloneables become JSON or text. */
function cloneable(v: unknown): unknown {
  if (typeof structuredClone !== "function") return v;
  try {
    structuredClone(v);
    return v;
  } catch {
    try {
      return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
    } catch {
      return String(v);
    }
  }
}

// ---- transform output ----

function cellOf(v: unknown): Cell {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "function" || typeof v === "symbol") return String(v);
  return cloneable(v) as Cell;
}

function typeOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return "TIMESTAMP";
  if (typeof v === "bigint") return "BIGINT";
  if (typeof v === "number") return Number.isInteger(v) ? "BIGINT" : "DOUBLE";
  if (typeof v === "boolean") return "BOOLEAN";
  if (typeof v === "string") return "VARCHAR";
  return "JSON";
}

function mergeType(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null || a === b) return a;
  if ((a === "BIGINT" && b === "DOUBLE") || (a === "DOUBLE" && b === "BIGINT")) return "DOUBLE";
  return "VARCHAR";
}

/** Turn whatever a transform returned into a ResultTable plus any vars it returned. */
export function normaliseOutput(
  out: unknown,
  maxRows = DEFAULT_MAX_ROWS,
): { table: ResultTable; vars?: Record<string, unknown> } {
  let rows: unknown;
  let cols: unknown;
  let vars: Record<string, unknown> | undefined;
  if (Array.isArray(out)) {
    rows = out;
  } else if (out && typeof out === "object") {
    const o = out as Record<string, unknown>;
    rows = o.rows ?? [];
    cols = o.columns;
    if (o.vars !== undefined) {
      if (!o.vars || typeof o.vars !== "object" || Array.isArray(o.vars)) throw new Error("`vars` must be an object");
      vars = o.vars as Record<string, unknown>;
    }
  } else if (out === undefined || out === null) {
    rows = [];
  } else {
    throw new Error("A transform must return an array of rows or { rows, columns?, vars? }");
  }
  if (!Array.isArray(rows)) throw new Error("`rows` must be an array");
  if (rows.length > maxRows) throw new Error(`Script returned ${rows.length} rows; the limit is ${maxRows}`);

  // Given column names or Column objects.
  let given: { name: string; type?: string }[] | undefined;
  if (cols !== undefined) {
    if (!Array.isArray(cols)) throw new Error("`columns` must be an array");
    given = cols.map((c, i) => {
      if (typeof c === "string") return { name: c };
      if (c && typeof c === "object" && typeof (c as Column).name === "string") return c as Column;
      throw new Error(`columns[${i}] must be a name or { name, type }`);
    });
  }

  const allArrays = rows.length > 0 && rows.every((r) => Array.isArray(r));
  let names: string[];
  let raw: unknown[][];
  if (allArrays) {
    const width = Math.max(given?.length ?? 0, ...rows.map((r) => (r as unknown[]).length));
    names = given ? given.map((c) => c.name) : [];
    for (let i = names.length; i < width; i++) names.push(`column_${i + 1}`);
    raw = rows.map((r) => names.map((_n, i) => (r as unknown[])[i]));
  } else {
    names = given ? given.map((c) => c.name) : [];
    const seen = new Set(names);
    rows.forEach((r, i) => {
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        throw new Error(`Row ${i} is not an object; return all objects or all arrays`);
      }
      if (given) return;
      for (const k of Object.keys(r)) {
        if (!seen.has(k)) {
          seen.add(k);
          names.push(k);
        }
      }
    });
    raw = rows.map((r) => names.map((n) => (r as Record<string, unknown>)[n]));
  }

  const types: (string | null)[] = names.map(() => null);
  const nullable: boolean[] = names.map(() => false);
  for (const r of raw) {
    r.forEach((v, i) => {
      if (v === null || v === undefined) nullable[i] = true;
      else types[i] = mergeType(types[i] ?? null, typeOf(v));
    });
  }
  const cells: Cell[][] = raw.map((r) => r.map(cellOf));
  const columns: Column[] = names.map((name, i) => ({
    name,
    type: given?.[i]?.type ?? types[i] ?? "VARCHAR",
    nullable: nullable[i] ?? false,
  }));
  return { table: { columns, rows: cells }, vars };
}

// ---- executor ----

export async function executeScript(req: SandboxRequest, opts: ExecuteOptions = {}): Promise<SandboxResponse> {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const now = opts.now ?? (() => new Date());

  const varChanges: Record<string, unknown> = {};
  const envChanges: Record<string, unknown> = {};
  const tests: { name: string; passed: boolean }[] = [];
  const logs: string[] = [];
  const pendingTests: Promise<void>[] = [];
  let failMessage: string | undefined;

  const currentVars: Record<string, unknown> = { ...req.vars };
  const env: Record<string, unknown> = req.kind === "transform" ? {} : { ...req.env };

  const pushLog = (line: string) => {
    if (logs.length < MAX_LOG_LINES - 1) logs.push(line);
    else if (logs.length === MAX_LOG_LINES - 1) logs.push(`… log truncated at ${MAX_LOG_LINES} lines`);
  };
  const log = (...args: unknown[]) => pushLog(args.map(stringify).join(" "));
  const prefixed =
    (p: string) =>
    (...args: unknown[]) =>
      pushLog(`${p}${args.map(stringify).join(" ")}`);

  const db = {
    vars: {
      get: (name: string) => currentVars[name],
      set: (name: string, value: unknown) => {
        currentVars[name] = value;
        varChanges[name] = value === undefined ? null : value;
      },
      unset: (name: string) => {
        delete currentVars[name];
        varChanges[name] = null;
      },
      has: (name: string) => name in currentVars,
      toObject: () => ({ ...currentVars }),
    },
    env: {
      get: (name: string) => env[name],
      /** Recorded in envChanges; the UI asks before applying it. */
      set: (name: string, value: unknown) => {
        env[name] = value;
        envChanges[name] = value === undefined ? null : value;
      },
    },
    result: req.kind === "post" && req.result ? makeTable(req.result) : undefined,
    /** Every statement's result, in order, for a query with several statements; [result] otherwise. */
    results: req.kind === "post" ? (req.results ?? (req.result ? [req.result] : [])).map(makeTable) : undefined,
    test: (name: string, cond: unknown) => {
      const record = (passed: boolean): void => {
        tests.push({ name: String(name), passed });
      };
      if (typeof cond !== "function") {
        record(Boolean(cond));
        return;
      }
      try {
        const r = (cond as () => unknown)();
        if (r && typeof (r as Promise<unknown>).then === "function") {
          pendingTests.push(
            (r as Promise<unknown>).then(
              (v) => record(v !== false),
              (e) => {
                record(false);
                log(`Test "${name}" failed: ${errorMessage(e)}`);
              },
            ),
          );
        } else {
          record(r !== false);
        }
      } catch (e) {
        if (e instanceof FailSignal) throw e;
        record(false);
        log(`Test "${name}" failed: ${errorMessage(e)}`);
      }
    },
    fail: (msg?: unknown): never => {
      failMessage = msg === undefined ? "Script failed" : stringify(msg);
      throw new FailSignal(failMessage);
    },
    log,
    date: makeDate(now),
  };

  const console = { log, info: log, debug: log, warn: prefixed("[warn] "), error: prefixed("[error] ") };
  const shadowNames = [...BLOCKED_GLOBALS, "console"];
  const shadowValues = [...BLOCKED_GLOBALS.map(() => undefined), console];

  const respond = (ok: boolean, extra: Partial<SandboxResponse> = {}): SandboxResponse => ({
    id: req.id,
    ok,
    varChanges: cloneable(varChanges) as Record<string, unknown>,
    envChanges: cloneable(envChanges) as Record<string, unknown>,
    tests,
    logs,
    ...extra,
  });

  let fn: (...args: unknown[]) => Promise<unknown>;
  try {
    const params = req.kind === "transform" ? ["inputs", "vars", "db"] : ["db"];
    fn = new Function(...params, ...shadowNames, `"use strict";\nreturn (async () => {\n${req.code}\n})();`) as typeof fn;
  } catch (e) {
    return respond(false, { error: `Syntax error: ${errorMessage(e)}` });
  }

  try {
    let out: unknown;
    if (req.kind === "transform") {
      const inputs: Record<string, ScriptTable> = {};
      for (const [k, t] of Object.entries(req.inputs)) inputs[k] = makeTable(t);
      out = await fn(inputs, { ...req.vars }, db, ...shadowValues);
    } else {
      out = await fn(db, ...shadowValues);
    }
    await Promise.all(pendingTests);
    if (failMessage !== undefined) return respond(false, { error: failMessage });
    if (req.kind !== "transform") return respond(true);

    const { table, vars } = normaliseOutput(out, maxRows);
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        currentVars[k] = v;
        varChanges[k] = v === undefined ? null : v;
      }
    }
    return respond(true, { result: table });
  } catch (e) {
    await Promise.allSettled(pendingTests);
    return respond(false, { error: failMessage ?? errorMessage(e) });
  }
}
