// SqliteBackend implementations: the worker proxy (browser) and an in-process engine (tests).

import type { Cell } from "@core/types";
import { SqliteEngine, type OpenArgs, type QueryResult, type StepResult, type Sqlite3 } from "./engine";
import type { SqliteBackend, WorkerRequest, WorkerResponse } from "./protocol";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/**
 * Talks to worker.ts. Cancel: with cross-origin isolation (manifest COOP/COEP) a shared
 * interrupt flag stops the running step through SQLite's progress handler. Without
 * SharedArrayBuffer, the worker is terminated and transparently restarted on next use,
 * reopening the same database.
 */
export class WorkerBackend implements SqliteBackend {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private flag: Int32Array | null = null;
  private lastOpen: OpenArgs | null = null;
  private busy = 0;
  private ready: Promise<void> | null = null;

  constructor(private readonly makeWorker: () => Worker = () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const w = this.makeWorker();
    this.worker = w;
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const res = ev.data;
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res.result);
      else p.reject(Object.assign(new Error(res.error), { code: res.code }));
    };
    w.onerror = (ev) => {
      const err = new Error(ev.message || "SQLite worker failed");
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    const sab = typeof SharedArrayBuffer !== "undefined" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    const buf = sab ? new SharedArrayBuffer(4) : undefined;
    this.flag = buf ? new Int32Array(buf) : null;
    this.ready = this.send({ op: "init", interruptBuffer: buf }, true).then(async () => {
      if (this.lastOpen) await this.send({ op: "open", args: this.lastOpen }, true);
    });
    return this.ready;
  }

  private async send<T>(msg: DistributiveOmit<WorkerRequest, "id">, skipStart = false): Promise<T> {
    if (!skipStart) await this.start();
    const id = ++this.seq;
    this.busy++;
    try {
      return await new Promise<T>((resolve, reject) => {
        this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        this.worker!.postMessage({ ...msg, id });
      });
    } finally {
      this.busy--;
    }
  }

  async open(args: OpenArgs): Promise<{ version: string }> {
    // Copy so a restart can reopen; the bytes are transferred by structured clone.
    this.lastOpen = args;
    await this.start();
    return this.send({ op: "open", args });
  }
  query(sql: string, params?: Cell[]): Promise<QueryResult> {
    return this.send({ op: "query", sql, params });
  }
  next(cursor: number, max: number): Promise<StepResult> {
    return this.send({ op: "next", cursor, max });
  }
  async closeCursor(cursor: number): Promise<void> {
    await this.send({ op: "closeCursor", cursor });
  }
  all(sql: string, params?: Cell[]): Promise<Record<string, Cell>[]> {
    return this.send({ op: "all", sql, params });
  }
  transaction(statements: { sql: string; params: Cell[] }[]): Promise<number> {
    return this.send({ op: "transaction", statements });
  }

  interrupt(): void {
    if (this.busy === 0) return;
    if (this.flag) {
      Atomics.store(this.flag, 0, 1);
      return;
    }
    // No shared memory: kill the worker. Pending calls reject; the next call restarts it.
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    const err = Object.assign(new Error("interrupted"), { code: 9 });
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  async close(): Promise<void> {
    if (this.worker) {
      await this.send({ op: "close" }).catch(() => undefined);
      this.worker.terminate();
    }
    this.worker = null;
    this.ready = null;
    this.lastOpen = null;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Runs the engine on the calling thread. Used by tests (Node) and anywhere a worker isn't wanted. */
export class InProcessBackend implements SqliteBackend {
  readonly engine: SqliteEngine;
  constructor(sqlite3: Sqlite3) {
    this.engine = new SqliteEngine(sqlite3);
  }
  async open(args: OpenArgs) {
    this.engine.open(args);
    return { version: this.engine.version };
  }
  async query(sql: string, params?: Cell[]) {
    return this.engine.query(sql, params);
  }
  async next(cursor: number, max: number) {
    return this.engine.next(cursor, max);
  }
  async closeCursor(cursor: number) {
    this.engine.closeCursor(cursor);
  }
  async all(sql: string, params?: Cell[]) {
    return this.engine.all(sql, params);
  }
  async transaction(statements: { sql: string; params: Cell[] }[]) {
    return this.engine.transaction(statements);
  }
  interrupt(): void {
    this.engine.interrupt();
  }
  async close() {
    this.engine.close();
  }
}
