// Real DuckDB-WASM for tests: the blocking Node build, in-process, with the same bundled
// parquet/json extensions the browser build loads. Nothing is fetched from the network:
// the extension loader's synchronous XMLHttpRequest is served from the files in
// src/drivers/duckdb/ext/ while they load.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { BlockingEngine, prepareDatabase, type BlockingBindings, type DuckEngine } from "../../../src/drivers/duckdb/engine";

const require = createRequire(import.meta.url);
const EXT_DIR = resolve(__dirname, "../../../src/drivers/duckdb/ext/wasm_eh");
export const FIXTURES = resolve(__dirname, "../../fixtures/files");

export const fixture = (name: string) => new Uint8Array(readFileSync(resolve(FIXTURES, name)));
export const fixtureFile = (name: string) => new File([fixture(name)], name);

interface NodeDuckDB extends BlockingBindings {
  instantiate(): Promise<unknown>;
  open(cfg: object): void;
}

class FileXHR {
  status = 0;
  response: ArrayBuffer | null = null;
  responseType = "";
  private url = "";
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  send() {
    const b = readFileSync(this.url);
    this.response = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    this.status = 200;
  }
}

let shared: Promise<DuckEngine> | null = null;

/** One engine per test file (vitest isolates files), like the one instance per page in the browser. */
export function testEngine(): Promise<DuckEngine> {
  shared ??= (async () => {
    const duckdb = require("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs");
    const dist = dirname(require.resolve("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs"));
    const bundles = {
      mvp: { mainModule: `${dist}/duckdb-mvp.wasm`, mainWorker: `${dist}/duckdb-node-mvp.worker.cjs` },
      eh: { mainModule: `${dist}/duckdb-eh.wasm`, mainWorker: `${dist}/duckdb-node-eh.worker.cjs` },
    };
    const db = (await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME)) as NodeDuckDB;
    await db.instantiate();
    db.open({ path: ":memory:", arrowLosslessConversion: true });
    const engine = new BlockingEngine(db);
    const conn = await engine.connect();
    const g = globalThis as { XMLHttpRequest?: unknown };
    const saved = g.XMLHttpRequest;
    g.XMLHttpRequest = FileXHR;
    try {
      await prepareDatabase(conn, { parquet: `${EXT_DIR}/parquet.duckdb_extension.wasm`, json: `${EXT_DIR}/json.duckdb_extension.wasm` });
    } finally {
      g.XMLHttpRequest = saved;
      await conn.close();
    }
    return engine;
  })();
  return shared;
}
