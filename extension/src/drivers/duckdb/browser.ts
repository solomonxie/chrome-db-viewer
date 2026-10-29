// Browser engine: AsyncDuckDB in a Web Worker, started from assets bundled with the
// extension (no CDN; MV3 forbids remote code). One instance per page, created lazily the
// first time a DuckDB connection or data file is opened.

import * as duckdb from "@duckdb/duckdb-wasm";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import coiWasm from "@duckdb/duckdb-wasm/dist/duckdb-coi.wasm?url";
import coiWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-coi.worker.js?url";
import coiPthread from "@duckdb/duckdb-wasm/dist/duckdb-browser-coi.pthread.worker.js?url";
// DuckDB extensions, one build per platform, matching the engine version (v1.5.4).
import parquetMvp from "./ext/wasm_mvp/parquet.duckdb_extension.wasm?url";
import jsonMvp from "./ext/wasm_mvp/json.duckdb_extension.wasm?url";
import parquetEh from "./ext/wasm_eh/parquet.duckdb_extension.wasm?url";
import jsonEh from "./ext/wasm_eh/json.duckdb_extension.wasm?url";
import parquetThreads from "./ext/wasm_threads/parquet.duckdb_extension.wasm?url";
import jsonThreads from "./ext/wasm_threads/json.duckdb_extension.wasm?url";
import type { RecordBatch } from "apache-arrow";
import { DriverError } from "@core/types";
import { prepareDatabase, type BatchStream, type BundledExtensions, type DuckConn, type DuckEngine } from "./engine";

const BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
  coi: { mainModule: coiWasm, mainWorker: coiWorker, pthreadWorker: coiPthread },
};

const EXTENSIONS: Record<string, BundledExtensions> = {
  mvp: { parquet: parquetMvp, json: jsonMvp },
  eh: { parquet: parquetEh, json: jsonEh },
  coi: { parquet: parquetThreads, json: jsonThreads },
};

/** Absolute URL, so the worker's synchronous XHR resolves it against the extension origin. */
const abs = (u: string) => new URL(u, globalThis.location?.href ?? "chrome-extension://invalid/").href;

class AsyncConn implements DuckConn {
  constructor(private readonly c: duckdb.AsyncDuckDBConnection) {}
  query(sql: string) {
    return this.c.query(sql);
  }
  async queryParams(sql: string, params: unknown[]) {
    const st = await this.c.prepare(sql);
    try {
      return await st.query(...params);
    } finally {
      await st.close();
    }
  }
  async stream(sql: string, params?: unknown[]): Promise<BatchStream> {
    if (params && params.length) {
      const st = await this.c.prepare(sql);
      let reader: AsyncIterable<RecordBatch> & { schema?: import("apache-arrow").Schema };
      try {
        reader = await st.send(...params);
      } catch (e) {
        await st.close();
        throw e;
      }
      return {
        get schema() {
          return reader.schema;
        },
        async *[Symbol.asyncIterator]() {
          try {
            for await (const b of reader) yield b;
          } finally {
            await st.close();
          }
        },
      };
    }
    return this.c.send(sql, true);
  }
  async cancel() {
    await this.c.cancelSent();
  }
  insertArrowIPC(bytes: Uint8Array, name: string) {
    return this.c.insertArrowFromIPCStream(bytes, { name, create: true });
  }
  close() {
    return this.c.close();
  }
}

class BrowserEngine implements DuckEngine {
  constructor(
    private readonly db: duckdb.AsyncDuckDB,
    readonly label: string,
  ) {}
  async connect() {
    return new AsyncConn(await this.db.connect());
  }
  registerFileURL(name: string, url: string) {
    // HTTP protocol: DuckDB issues HEAD + Range requests, so Parquet reads only what it needs.
    return this.db.registerFileURL(name, url, duckdb.DuckDBDataProtocol.HTTP, false);
  }
  registerFile(name: string, file: File) {
    return this.db.registerFileHandle(name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
  }
  registerFileBuffer(name: string, bytes: Uint8Array) {
    return this.db.registerFileBuffer(name, bytes);
  }
  registerEmptyFileBuffer(name: string) {
    return this.db.registerEmptyFileBuffer(name);
  }
  registerOPFSFile(path: string) {
    return this.db.registerOPFSFileName(path);
  }
  copyFileToBuffer(name: string) {
    return this.db.copyFileToBuffer(name);
  }
  async dropFile(name: string) {
    await this.db.dropFile(name);
  }
}

let enginePromise: Promise<DuckEngine> | null = null;

/** The page-wide DuckDB-WASM instance, started on first use. */
export function getBrowserEngine(): Promise<DuckEngine> {
  enginePromise ??= startEngine().catch((e) => {
    enginePromise = null;
    throw e instanceof DriverError ? e : new DriverError(`Could not start DuckDB-WASM: ${(e as Error).message ?? e}`, "engine_start", e);
  });
  return enginePromise;
}

async function startEngine(): Promise<DuckEngine> {
  // Threads need cross-origin isolation (COOP/COEP in the manifest); selectBundle checks it.
  const bundles: duckdb.DuckDBBundles = globalThis.crossOriginIsolated ? BUNDLES : { mvp: BUNDLES.mvp, eh: BUNDLES.eh };
  const bundle = await duckdb.selectBundle(bundles);
  const kind = bundle.mainModule === coiWasm ? "coi" : bundle.mainModule === ehWasm ? "eh" : "mvp";
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  await db.open({
    path: ":memory:",
    // Keeps JSON, UUID and HUGEINT recognisable in Arrow so convert.ts can format them.
    arrowLosslessConversion: true,
    filesystem: { reliableHeadRequests: true, allowFullHTTPReads: true },
  });
  const ext = EXTENSIONS[kind]!;
  const conn = await db.connect();
  try {
    await prepareDatabase(new AsyncConn(conn), { parquet: abs(ext.parquet), json: abs(ext.json) });
  } finally {
    await conn.close();
  }
  return new BrowserEngine(db, `WASM ${kind}`);
}
