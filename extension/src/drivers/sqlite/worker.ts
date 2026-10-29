// SQLite worker: hosts SqliteEngine on @sqlite.org/sqlite-wasm. The WASM file is bundled by
// Vite (?url import), never fetched from a CDN.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import wasmUrl from "@sqlite.org/sqlite-wasm/sqlite3.wasm?url";
import { SqliteEngine, SqliteError } from "./engine";
import type { WorkerRequest, WorkerResponse } from "./protocol";

let engine: SqliteEngine | null = null;

async function getEngine(): Promise<SqliteEngine> {
  if (!engine) {
    const init = sqlite3InitModule as unknown as (opts: { locateFile: (f: string) => string; print?: () => void; printErr?: () => void }) => Promise<unknown>;
    const sqlite3 = await init({ locateFile: (f) => (f.endsWith(".wasm") ? wasmUrl : f), print: () => undefined, printErr: () => undefined });
    engine = new SqliteEngine(sqlite3);
  }
  return engine;
}

async function handle(req: WorkerRequest): Promise<unknown> {
  const e = await getEngine();
  switch (req.op) {
    case "init":
      if (req.interruptBuffer) e.setInterruptFlag(new Int32Array(req.interruptBuffer));
      return { version: e.version };
    case "open":
      e.open(req.args);
      return { version: e.version };
    case "query":
      return e.query(req.sql, req.params);
    case "next":
      return e.next(req.cursor, req.max);
    case "closeCursor":
      return e.closeCursor(req.cursor);
    case "all":
      return e.all(req.sql, req.params);
    case "transaction":
      return e.transaction(req.statements);
    case "close":
      return e.close();
  }
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  let res: WorkerResponse;
  try {
    res = { id: req.id, ok: true, result: await handle(req) };
  } catch (err) {
    res = { id: req.id, ok: false, error: (err as Error).message ?? String(err), code: err instanceof SqliteError ? err.code : undefined };
  }
  (self as unknown as Worker).postMessage(res);
};
