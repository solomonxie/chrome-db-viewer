// Engine abstraction over DuckDB-WASM. The browser uses AsyncDuckDB in a Web Worker
// (browser.ts); tests use the blocking Node build through BlockingEngine. The driver only
// talks to these interfaces, so both run the same driver code.

import type { RecordBatch, Schema, Table } from "apache-arrow";
import { DriverError } from "@core/types";

/** One DuckDB connection. Session state (USE, transactions) lives here. */
export interface DuckConn {
  /** Runs SQL and returns the whole result. For catalog queries and small results. */
  query(sql: string): Promise<Table>;
  /** Runs one prepared statement with parameters and returns the whole result. */
  queryParams(sql: string, params: unknown[]): Promise<Table>;
  /** Runs SQL (prepared when params are given) and streams Arrow record batches. */
  stream(sql: string, params?: unknown[]): Promise<BatchStream>;
  /** Interrupts the statement currently running on this connection. */
  cancel(): Promise<void>;
  /** Creates (or appends to) table `name` in the current catalog from Arrow IPC bytes (stream or file). */
  insertArrowIPC(bytes: Uint8Array, name: string): Promise<void>;
  close(): Promise<void>;
}

export interface BatchStream extends AsyncIterable<RecordBatch> {
  /** Result schema, when the reader exposes it before (or after) the first batch. */
  readonly schema?: Schema;
}

/** One DuckDB database instance, shared by every driver on the page. */
export interface DuckEngine {
  connect(): Promise<DuckConn>;
  /** Exposes a remote URL to DuckDB. Browser: HTTP protocol, so Parquet uses range requests. */
  registerFileURL(name: string, url: string): Promise<void>;
  /** Exposes a local File (from a FileSystemFileHandle) to DuckDB without copying it. */
  registerFile(name: string, file: File): Promise<void>;
  registerFileBuffer(name: string, bytes: Uint8Array): Promise<void>;
  /** Registers an empty in-memory file that COPY … TO can write into. */
  registerEmptyFileBuffer(name: string): Promise<void>;
  /** Prepares an OPFS path (opfs://…) so ATTACH can open it read-write. */
  registerOPFSFile(path: string): Promise<void>;
  copyFileToBuffer(name: string): Promise<Uint8Array>;
  dropFile(name: string): Promise<void>;
  /** Short label for the build, e.g. "WASM eh". */
  readonly label: string;
}

/** URLs of the DuckDB extensions bundled with the extension (MV3 forbids loading them from the network). */
export interface BundledExtensions {
  parquet: string;
  json: string;
}

/**
 * Loads the bundled extensions and makes sure nothing is ever fetched from
 * extensions.duckdb.org: autoinstall/autoload off, repositories pointed nowhere, and the
 * configuration locked so a typed `SET` or `INSTALL` can't turn them back on.
 */
export async function prepareDatabase(conn: DuckConn, ext: BundledExtensions): Promise<void> {
  await conn.query(
    "SET autoinstall_known_extensions = false; SET autoload_known_extensions = false; " +
      "SET custom_extension_repository = 'bundled-only'; SET autoinstall_extension_repository = 'bundled-only'",
  );
  for (const [name, url] of Object.entries(ext)) {
    try {
      await conn.query(`LOAD '${url.replace(/'/g, "''")}'`);
    } catch (e) {
      throw new DriverError(`Could not load the bundled DuckDB ${name} extension: ${errorMessage(e)}`, "extension_load", e);
    }
  }
  await conn.query("SET lock_configuration = true");
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

/** DuckDB errors look like "Catalog Error: Table with name x does not exist!". */
export function toDriverError(e: unknown, fallbackCode?: string): DriverError {
  if (e instanceof DriverError) return e;
  const message = errorMessage(e).trim();
  const m = /^([A-Za-z ]+?) Error:/.exec(message);
  const code = m ? m[1]!.trim().toLowerCase().replace(/\s+/g, "_") : fallbackCode;
  if (/interrupt|cancel/i.test(message)) return new DriverError("Query cancelled", "cancelled", e);
  return new DriverError(message || "DuckDB error", code, e);
}

// ---------------------------------------------------------------------------------------
// Blocking engine (Node tests, or any synchronous DuckDBBindings).

/** The subset of @duckdb/duckdb-wasm's synchronous DuckDBBindings used here. */
export interface BlockingBindings {
  connect(): BlockingConnection;
  registerFileBuffer(name: string, buffer: Uint8Array): void;
  copyFileToBuffer(name: string): Uint8Array;
  dropFile(name: string): void;
}

interface BlockingPrepared {
  query(...params: unknown[]): Table;
  send(...params: unknown[]): Iterable<RecordBatch> & { schema?: Schema };
  close(): void;
}

export interface BlockingConnection {
  query(text: string): Table;
  send(text: string, allowStreamResult?: boolean): Promise<Iterable<RecordBatch> & { schema?: Schema }>;
  cancelSent(): boolean;
  prepare(text: string): BlockingPrepared;
  insertArrowFromIPCStream(buffer: Uint8Array, options: { name: string; create?: boolean }): void;
  close(): void;
}

function toAsync(it: Iterable<RecordBatch> & { schema?: Schema }, onDone?: () => void): BatchStream {
  return {
    get schema() {
      return it.schema;
    },
    async *[Symbol.asyncIterator]() {
      try {
        for (const b of it) yield b;
      } finally {
        onDone?.();
      }
    },
  };
}

class BlockingConn implements DuckConn {
  constructor(private readonly c: BlockingConnection) {}
  async query(sql: string) {
    return this.c.query(sql);
  }
  async queryParams(sql: string, params: unknown[]) {
    const st = this.c.prepare(sql);
    try {
      return st.query(...params);
    } finally {
      st.close();
    }
  }
  async stream(sql: string, params?: unknown[]): Promise<BatchStream> {
    if (params && params.length) {
      const st = this.c.prepare(sql);
      try {
        return toAsync(st.send(...params), () => st.close());
      } catch (e) {
        st.close();
        throw e;
      }
    }
    return toAsync(await this.c.send(sql, true));
  }
  async cancel() {
    this.c.cancelSent();
  }
  async insertArrowIPC(bytes: Uint8Array, name: string) {
    this.c.insertArrowFromIPCStream(bytes, { name, create: true });
  }
  async close() {
    this.c.close();
  }
}

/**
 * Wraps the synchronous bindings (e.g. `duckdb-node-blocking`). That build can't read HTTP
 * or browser files itself, so URLs and Files are read into memory buffers first.
 */
export class BlockingEngine implements DuckEngine {
  readonly label = "WASM blocking";
  constructor(private readonly db: BlockingBindings) {}
  async connect(): Promise<DuckConn> {
    return new BlockingConn(this.db.connect());
  }
  async registerFileURL(name: string, url: string) {
    const res = await fetch(url);
    if (!res.ok) throw new DriverError(`GET ${url} failed: HTTP ${res.status}`, "http");
    this.db.registerFileBuffer(name, new Uint8Array(await res.arrayBuffer()));
  }
  async registerFile(name: string, file: File) {
    this.db.registerFileBuffer(name, new Uint8Array(await file.arrayBuffer()));
  }
  async registerFileBuffer(name: string, bytes: Uint8Array) {
    this.db.registerFileBuffer(name, bytes);
  }
  async registerEmptyFileBuffer(name: string) {
    this.db.registerFileBuffer(name, new Uint8Array(0));
  }
  async registerOPFSFile(): Promise<void> {
    throw new DriverError("OPFS is only available in the browser", "unsupported");
  }
  async copyFileToBuffer(name: string) {
    return this.db.copyFileToBuffer(name);
  }
  async dropFile(name: string) {
    this.db.dropFile(name);
  }
}
