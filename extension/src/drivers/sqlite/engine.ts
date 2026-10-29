// Synchronous SQLite engine over @sqlite.org/sqlite-wasm's C API. Runs inside the worker
// (worker.ts); also runs directly in Node for tests. No DOM or chrome.* here.
//
// Results are pulled with cursors: query() prepares and returns the columns, next() steps
// up to N rows. Between next() calls the worker is idle, so cancel can finalize the cursor;
// a long single step is stopped by the progress handler (interrupt flag) or worker termination.

import type { Cell, Column } from "@core/types";

// Only the parts of the sqlite3 module we use; avoids leaking its big types into the driver.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Sqlite3 = any;

export interface OpenArgs {
  /** Whole database file; opened in memory with sqlite3_deserialize. */
  bytes?: Uint8Array;
  /** Path in the origin private file system (worker only, needs the OPFS VFS). */
  opfsPath?: string;
  readOnly: boolean;
}

export interface QueryResult {
  cursor: number;
  columns: Column[] | null;
}

export interface StepResult {
  rows: Cell[][];
  done: boolean;
  /** Set when done: rows changed by the statement (INSERT/UPDATE/DELETE). */
  changes?: number;
}

const SQLITE_ROW = 100;
const SQLITE_DONE = 101;
const SQLITE_INTEGER = 1;
const SQLITE_FLOAT = 2;
const SQLITE_TEXT = 3;
const SQLITE_BLOB = 4;
const SQLITE_NULL = 5;

export class SqliteError extends Error {
  constructor(message: string, public code?: number) {
    super(message);
    this.name = "SqliteError";
  }
}

interface Cursor {
  stmt: number;
  columns: Column[] | null;
  readonlyStmt: boolean;
}

/** Hex string for BLOB cells, since Cell can't carry bytes: "x'0a1b…'" (SQL literal form). */
export function blobToCell(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `x'${hex}'`;
}

export class SqliteEngine {
  private db: any = null;
  private cursors = new Map<number, Cursor>();
  private nextCursor = 1;
  private interruptFlag: Int32Array | null = null;

  constructor(private readonly sqlite3: Sqlite3) {}

  get version(): string {
    return this.sqlite3.version.libVersion as string;
  }

  open(args: OpenArgs): void {
    this.close();
    const { oo1, capi, wasm } = this.sqlite3;
    if (args.bytes) {
      const db = new oo1.DB(":memory:", "c");
      const len = args.bytes.byteLength;
      // An empty file is a valid empty database.
      if (len > 0) {
        const p = wasm.allocFromTypedArray(args.bytes);
        const flags = capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE;
        const rc = capi.sqlite3_deserialize(db.pointer, "main", p, len, len, flags);
        if (rc !== 0) {
          db.close();
          throw new SqliteError(`Could not open the file as SQLite (${capi.sqlite3_errstr(rc)})`, rc);
        }
      }
      this.db = db;
    } else if (args.opfsPath) {
      if (!oo1.OpfsDb) throw new SqliteError("OPFS is not available here (needs a cross-origin isolated worker)");
      this.db = new oo1.OpfsDb(args.opfsPath, args.readOnly ? "r" : "c");
    } else {
      this.db = new oo1.DB(":memory:", "c");
    }
    try {
      // Validate the file: reading the schema fails fast on a non-SQLite file.
      this.all("SELECT count(*) FROM sqlite_schema");
    } catch (e) {
      this.close();
      throw new SqliteError(`Not a SQLite database: ${(e as Error).message}`);
    }
    if (args.readOnly) this.db.exec("PRAGMA query_only = ON");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  close(): void {
    for (const id of [...this.cursors.keys()]) this.closeCursor(id);
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /** Installs a progress handler that aborts the running step when flag[0] becomes non-zero. */
  setInterruptFlag(flag: Int32Array): void {
    this.interruptFlag = flag;
    this.installProgress();
  }

  private installProgress(): void {
    if (!this.db || !this.interruptFlag) return;
    const flag = this.interruptFlag;
    this.sqlite3.capi.sqlite3_progress_handler(this.db.pointer, 1000, () => (Atomics.load(flag, 0) ? 1 : 0), 0);
  }

  private get ptr(): number {
    if (!this.db) throw new SqliteError("No database is open");
    return this.db.pointer;
  }

  private check(rc: number): void {
    if (rc === 0 || rc === SQLITE_ROW || rc === SQLITE_DONE) return;
    const { capi } = this.sqlite3;
    throw new SqliteError(capi.sqlite3_errmsg(this.ptr) || capi.sqlite3_errstr(rc), rc);
  }

  /** Prepares each statement in `sql` in turn. Yields [stmtPtr, isLast]. Caller finalizes. */
  private *prepareAll(sql: string): Generator<[number, boolean], void, void> {
    const { capi, wasm } = this.sqlite3;
    const [pSqlStart, len] = wasm.allocCString(sql, true) as [number, number];
    const ppStmt = wasm.alloc(16);
    const pzTail = ppStmt + 8;
    try {
      let pSql = pSqlStart;
      const end = pSqlStart + len;
      while (pSql < end) {
        wasm.pokePtr(ppStmt, 0);
        wasm.pokePtr(pzTail, 0);
        this.check(capi.sqlite3_prepare_v3(this.ptr, pSql, end - pSql, 0, ppStmt, pzTail));
        const stmt = Number(wasm.peekPtr(ppStmt));
        pSql = Number(wasm.peekPtr(pzTail));
        if (!stmt) continue; // whitespace or comment
        const rest = wasm.cstrToJs(pSql) as string;
        yield [stmt, !hasStatement(rest)];
      }
    } finally {
      wasm.dealloc(ppStmt);
      wasm.dealloc(pSqlStart);
    }
  }

  private bind(stmt: number, params: Cell[]): void {
    const { capi } = this.sqlite3;
    const n = capi.sqlite3_bind_parameter_count(stmt);
    for (let i = 0; i < n; i++) {
      const v = params[i] ?? null;
      const idx = i + 1;
      let rc: number;
      if (v === null) rc = capi.sqlite3_bind_null(stmt, idx);
      else if (typeof v === "number") rc = Number.isInteger(v) ? capi.sqlite3_bind_int64(stmt, idx, BigInt(v)) : capi.sqlite3_bind_double(stmt, idx, v);
      else if (typeof v === "boolean") rc = capi.sqlite3_bind_int(stmt, idx, v ? 1 : 0);
      else if (typeof v === "string") {
        const blob = /^x'((?:[0-9a-fA-F]{2})*)'$/.exec(v);
        rc = blob ? capi.sqlite3_bind_blob(stmt, idx, hexToBytes(blob[1]!), -1, capi.SQLITE_TRANSIENT) : this.bindText(stmt, idx, v);
      } else rc = this.bindText(stmt, idx, JSON.stringify(v));
      this.check(rc);
    }
  }

  /**
   * sqlite-wasm 3.54.1's sqlite3_bind_text() wrapper throws "pMem is not defined" for JS strings,
   * so pass our own C string; SQLite frees it with SQLITE_WASM_DEALLOC.
   */
  private bindText(stmt: number, idx: number, text: string): number {
    const { capi, wasm } = this.sqlite3;
    const [p, n] = wasm.allocCString(text, true) as [number, number];
    return capi.sqlite3_bind_text(stmt, idx, p, n, capi.SQLITE_WASM_DEALLOC);
  }

  private columnsOf(stmt: number): Column[] | null {
    const { capi } = this.sqlite3;
    const n = capi.sqlite3_column_count(stmt);
    if (n === 0) return null;
    const cols: Column[] = [];
    for (let i = 0; i < n; i++) {
      cols.push({ name: capi.sqlite3_column_name(stmt, i), type: capi.sqlite3_column_decltype(stmt, i) ?? "", nullable: true });
    }
    return cols;
  }

  private row(stmt: number, n: number): Cell[] {
    const { capi, wasm } = this.sqlite3;
    const out: Cell[] = new Array(n);
    for (let i = 0; i < n; i++) {
      switch (capi.sqlite3_column_type(stmt, i)) {
        case SQLITE_INTEGER: {
          const big = capi.sqlite3_column_int64(stmt, i) as bigint;
          // 64-bit integers outside the safe range stay strings (core/types.ts precision rule).
          out[i] = big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big.toString();
          break;
        }
        case SQLITE_FLOAT:
          out[i] = capi.sqlite3_column_double(stmt, i);
          break;
        case SQLITE_TEXT:
          out[i] = capi.sqlite3_column_text(stmt, i);
          break;
        case SQLITE_BLOB: {
          const len = capi.sqlite3_column_bytes(stmt, i);
          const p = capi.sqlite3_column_blob(stmt, i);
          out[i] = blobToCell(len ? wasm.heap8u().slice(Number(p), Number(p) + len) : new Uint8Array());
          break;
        }
        case SQLITE_NULL:
        default:
          out[i] = null;
      }
    }
    return out;
  }

  /**
   * Runs every statement but the last to completion, then opens a cursor on the last one.
   * Params bind to the first statement that has placeholders.
   */
  query(sql: string, params: Cell[] = []): QueryResult {
    const { capi } = this.sqlite3;
    if (this.interruptFlag) Atomics.store(this.interruptFlag, 0, 0);
    let pending: Cell[] | null = params;
    for (const [stmt, isLast] of this.prepareAll(sql)) {
      try {
        if (pending && capi.sqlite3_bind_parameter_count(stmt) > 0) {
          this.bind(stmt, pending);
          pending = null;
        }
      } catch (e) {
        capi.sqlite3_finalize(stmt);
        throw e;
      }
      if (isLast) {
        const id = this.nextCursor++;
        this.cursors.set(id, { stmt, columns: this.columnsOf(stmt), readonlyStmt: capi.sqlite3_stmt_readonly(stmt) !== 0 });
        return { cursor: id, columns: this.cursors.get(id)!.columns };
      }
      try {
        let rc: number;
        do rc = capi.sqlite3_step(stmt);
        while (rc === SQLITE_ROW);
        this.check(rc);
      } finally {
        capi.sqlite3_finalize(stmt);
      }
    }
    // Only comments/whitespace: an empty, finished cursor.
    const id = this.nextCursor++;
    this.cursors.set(id, { stmt: 0, columns: null, readonlyStmt: true });
    return { cursor: id, columns: null };
  }

  next(cursor: number, max: number): StepResult {
    const c = this.cursors.get(cursor);
    if (!c) throw new SqliteError("Cursor is closed");
    if (!c.stmt) {
      this.cursors.delete(cursor);
      return { rows: [], done: true };
    }
    const { capi } = this.sqlite3;
    const n = c.columns?.length ?? 0;
    const rows: Cell[][] = [];
    try {
      while (rows.length < max) {
        const rc = capi.sqlite3_step(c.stmt);
        if (rc === SQLITE_ROW) {
          if (n) rows.push(this.row(c.stmt, n));
          continue;
        }
        if (rc === SQLITE_DONE) {
          const changes = c.readonlyStmt ? undefined : capi.sqlite3_changes(this.ptr);
          this.closeCursor(cursor);
          return { rows, done: true, changes };
        }
        this.check(rc);
      }
    } catch (e) {
      this.closeCursor(cursor);
      throw e;
    }
    return { rows, done: false };
  }

  closeCursor(cursor: number): void {
    const c = this.cursors.get(cursor);
    if (!c) return;
    this.cursors.delete(cursor);
    if (c.stmt) this.sqlite3.capi.sqlite3_finalize(c.stmt);
  }

  /** Small internal query: all rows as objects keyed by column name. */
  all(sql: string, params: Cell[] = []): Record<string, Cell>[] {
    const { cursor, columns } = this.query(sql, params);
    const out: Record<string, Cell>[] = [];
    for (;;) {
      const { rows, done } = this.next(cursor, 1000);
      for (const r of rows) out.push(Object.fromEntries((columns ?? []).map((c, i) => [c.name, r[i] ?? null])));
      if (done) return out;
    }
  }

  /** Runs statements in one transaction; rolls back on the first error. Returns total changes. */
  transaction(statements: { sql: string; params: Cell[] }[]): number {
    let changes = 0;
    this.db.exec("BEGIN");
    try {
      for (const s of statements) {
        const { cursor } = this.query(s.sql, s.params);
        let r: StepResult;
        do r = this.next(cursor, 1000);
        while (!r.done);
        changes += r.changes ?? 0;
      }
      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
    return changes;
  }

  /** The current database as a file image, for writing back to a picked file. */
  export(): Uint8Array {
    return this.sqlite3.capi.sqlite3_js_db_export(this.ptr);
  }

  /** In-thread interrupt, used by tests and by callers sharing the engine's thread. */
  interrupt(): void {
    if (this.db) this.sqlite3.capi.sqlite3_interrupt(this.ptr);
  }
}

/** True if `rest` contains anything other than whitespace, semicolons and comments. */
export function hasStatement(rest: string): boolean {
  const stripped = rest
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/[\s;]+/g, "");
  return stripped.length > 0;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
