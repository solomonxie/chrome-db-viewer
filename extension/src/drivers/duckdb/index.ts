// DuckDB-WASM driver for `.duckdb` files and OPFS scratch databases (driver id "duckdb"), and
// for local/remote data files shown as a VisiData-style sheet (driver id "file").
// design/DESIGN.md §3.10, §3.11, §3.12.
//
// One DuckDB-WASM instance is shared by the page (browser.ts). Each connected driver gets its
// own attached catalog (`dbui_<n>`) and every connection it uses runs `USE` on it, so tabs
// don't see each other's tables.
//
// ConnectionConfig.options
//   duckdb:  fileHandleId  id from handles.ts saveHandle(); opened READ_ONLY (§3.10)
//            fileHandle    or a live FileSystemFileHandle / File
//            opfsPath      scratch database in OPFS, e.g. "scratch.duckdb"; read-write unless cfg.readOnly
//            (none)        empty in-memory database
//   file:    src           URL (browser preview); registered over HTTP so Parquet uses range requests
//            fileHandleId  id from handles.ts, or fileHandle: a live FileSystemFileHandle / File
//            fileName      name used for format detection when the URL or handle doesn't say it
//            format        force a format: csv | tsv | psv | jsonl | json | parquet | arrow
//            materialize   true/false to override the ~500 MB temp-table rule
//            allowLarge    true to read a remote CSV/JSON over ~1 GB (otherwise DriverError "too_large")

import { buildChangeSet, duckdbDialect } from "@core/sql";
import {
  DriverError,
  type ApplyResult,
  type Capabilities,
  type Cell,
  type ChangeSet,
  type Column,
  type ConnectionConfig,
  type Driver,
  type ExecuteSummary,
  type Index,
  type ObjectNode,
  type ObjectPath,
  type ResultPage,
  type Statement,
  type TableSchema,
} from "@core/types";
import { BatchConverter, tableObjects } from "./convert";
import { toDriverError, type DuckConn, type DuckEngine } from "./engine";
import { ensurePermission, readHandleFile, writeHandle } from "./handles";
import {
  FILE_SHEET_TABLE,
  MATERIALIZE_LIMIT_BYTES,
  REMOTE_WARN_BYTES,
  copyToSql,
  detectFormat,
  fileNameOf,
  formatBytes,
  formatLabel,
  readerSql,
  type DetectedFormat,
  type FileFormat,
  type SaveFormat,
} from "./sheet";

export * from "./sheet";
export { saveHandle, loadHandle, loadHandleRecord, deleteHandle, ensurePermission, readHandleFile, HANDLE_DB, HANDLE_STORE } from "./handles";

export const DEFAULT_PAGE_SIZE = 2000;

export interface DuckDeps {
  /** DuckDB engine to use (default: the page-wide DuckDB-WASM worker). */
  engine?: () => Promise<DuckEngine>;
  /** Resolves options.fileHandleId to a File (default: IndexedDB handles store). */
  readFile?: (handleId: string) => Promise<File>;
  /** fetch used for the HEAD size check on URLs and for Arrow files (default: global fetch). */
  fetch?: typeof fetch;
}

/** Facts about the opened data file, for the sheet header. */
export interface FileInfo {
  name: string;
  format: DetectedFormat;
  size?: number;
  source: "url" | "file";
  /** True when the data was copied into an in-memory table (editable, fast sorts). */
  materialized: boolean;
  rows?: number;
}

const q = duckdbDialect.quoteIdent;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

let catalogSeq = 0;
const registeredNames = new Set<string>();

/** A file name DuckDB can see: the real name when free, so `FROM 'orders.csv'` works in SQL. */
function claimFileName(name: string): string {
  const safe = name.replace(/[^\w.\-]+/g, "_") || "file";
  let candidate = safe;
  for (let i = 2; registeredNames.has(candidate); i++) candidate = `${i}_${safe}`;
  registeredNames.add(candidate);
  return candidate;
}

const defaultEngine = async () => (await import("./browser")).getBrowserEngine();

/** Cell → parameter DuckDB-WASM can serialise (no BigInt, no objects). */
function toParam(v: Cell): unknown {
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return JSON.stringify(v);
}

function str(v: Cell | undefined): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DriverError("Query cancelled", "cancelled");
}

export class DuckDriver implements Driver {
  id: "duckdb" | "file" = "duckdb";
  readonly dialect = duckdbDialect;

  private engine: DuckEngine | null = null;
  private catalog = "";
  private readOnly = true;
  private idle: DuckConn[] = [];
  private all = new Set<DuckConn>();
  private files: string[] = [];
  private fileInfo: FileInfo | null = null;
  private opfs = false;

  constructor(private readonly deps: DuckDeps = {}) {}

  capabilities(): Capabilities {
    if (this.id === "file") {
      const editable = !!this.fileInfo?.materialized;
      return { kind: "file", transactions: editable, editableRows: editable, costEstimate: false, cancel: true };
    }
    return { kind: "relational", transactions: true, editableRows: !this.readOnly, costEstimate: false, cancel: true };
  }

  /** Format, size and storage of the opened file (file connections only). */
  info(): FileInfo | null {
    return this.fileInfo;
  }

  /** The attached catalog name, e.g. "dbui_3". */
  get catalogName(): string {
    return this.catalog;
  }

  // --- Connection ------------------------------------------------------------------------

  async connect(cfg: ConnectionConfig, signal?: AbortSignal): Promise<{ serverVersion?: string }> {
    this.id = cfg.driver === "file" ? "file" : "duckdb";
    try {
      this.engine = await (this.deps.engine ?? defaultEngine)();
      aborted(signal);
      this.catalog = `dbui_${++catalogSeq}`;
      const conn = await this.engine.connect();
      this.all.add(conn);
      try {
        if (this.id === "file") await this.openFile(conn, cfg, signal);
        else await this.openDatabase(conn, cfg);
        await conn.query(`USE ${q(this.catalog)}`);
      } catch (e) {
        await conn.close().catch(() => undefined);
        this.all.delete(conn);
        throw e;
      }
      this.idle.push(conn);
      const version = tableObjects(await conn.query("SELECT version() AS v"))[0]?.v;
      return { serverVersion: `DuckDB ${str(version)} (${this.engine.label})` };
    } catch (e) {
      await this.cleanupFiles();
      throw toDriverError(e, "connect_failed");
    }
  }

  private async openDatabase(conn: DuckConn, cfg: ConnectionConfig): Promise<void> {
    const o = cfg.options;
    const engine = this.engine!;
    if ((typeof o.fileHandleId === "string" && o.fileHandleId) || o.fileHandle) {
      const file = await this.resolveFile(o);
      const name = claimFileName(file.name || "database.duckdb");
      this.files.push(name);
      await engine.registerFile(name, file);
      // The browser can't write back to a picked file, so it's always read-only (§3.10).
      this.readOnly = true;
      try {
        await conn.query(`ATTACH ${lit(name)} AS ${q(this.catalog)} (READ_ONLY)`);
      } catch (e) {
        throw new DriverError(`Could not open ${file.name} as a DuckDB database: ${toDriverError(e).message}`, "open_failed", e);
      }
    } else if (typeof o.opfsPath === "string" && o.opfsPath) {
      const path = o.opfsPath.startsWith("opfs://") ? o.opfsPath : `opfs://${o.opfsPath.replace(/^\/+/, "")}`;
      await engine.registerOPFSFile(path);
      await engine.registerOPFSFile(`${path}.wal`).catch(() => undefined);
      this.opfs = true;
      this.readOnly = cfg.readOnly;
      await conn.query(`ATTACH ${lit(path)} AS ${q(this.catalog)}${cfg.readOnly ? " (READ_ONLY)" : ""}`);
    } else {
      this.readOnly = cfg.readOnly;
      await conn.query(`ATTACH ':memory:' AS ${q(this.catalog)}`);
    }
  }

  /** Accepts options.fileHandle (FileSystemFileHandle or File) or options.fileHandleId. */
  private async resolveFile(o: Record<string, unknown>): Promise<File> {
    const live = o.fileHandle as FileSystemFileHandle | File | undefined;
    if (live && typeof File !== "undefined" && live instanceof File) return live;
    if (live && typeof (live as FileSystemFileHandle).getFile === "function") {
      const h = live as FileSystemFileHandle;
      if (!(await ensurePermission(h, "read"))) throw new DriverError(`Read access to ${h.name} was not granted`, "permission");
      return h.getFile();
    }
    const id = o.fileHandleId;
    if (typeof id !== "string" || !id) throw new DriverError("No file to open: pass options.src or options.fileHandleId", "bad_config");
    return (this.deps.readFile ?? readHandleFile)(id);
  }

  private async openFile(conn: DuckConn, cfg: ConnectionConfig, signal?: AbortSignal): Promise<void> {
    const o = cfg.options;
    const engine = this.engine!;
    this.readOnly = cfg.readOnly;
    const src = typeof o.src === "string" && o.src ? o.src : undefined;
    const givenName = typeof o.fileName === "string" && o.fileName ? o.fileName : undefined;

    let file: File | undefined;
    let name: string;
    if (src) name = givenName ?? fileNameOf(src);
    else {
      file = await this.resolveFile(o);
      name = givenName ?? file.name;
    }

    const forced = typeof o.format === "string" ? (o.format as FileFormat) : undefined;
    const detected = detectFormat(name) ?? (src ? detectFormat(src) : null);
    const format: DetectedFormat | null = forced ? { format: forced, compression: detected?.compression ?? null, ext: forced } : detected;
    if (!format) {
      throw new DriverError(
        `Can't tell the format of "${name}". Supported: .csv .tsv .psv .jsonl .ndjson .json .parquet .arrow .feather, optionally with .gz or .zst.`,
        "unsupported_format",
      );
    }

    let size: number | undefined = file?.size;
    if (src && size === undefined) size = await this.remoteSize(src);
    aborted(signal);

    const isRemoteText = !!src && format.format !== "parquet" && format.format !== "arrow";
    if (isRemoteText && size !== undefined && size > REMOTE_WARN_BYTES && o.allowLarge !== true) {
      throw new DriverError(
        `${name} is ${formatBytes(size)}. Reading a remote ${formatLabel(format)} file this big downloads all of it. Download it instead, or open it anyway.`,
        "too_large",
        { size },
      );
    }

    await conn.query(`ATTACH ':memory:' AS ${q(this.catalog)}`);
    await conn.query(`USE ${q(this.catalog)}`);
    const target = `${q(this.catalog)}.main.${q(FILE_SHEET_TABLE)}`;

    let materialized: boolean;
    try {
      if (format.format === "arrow") {
        // DuckDB-WASM has no Arrow-file table function: read the bytes and insert them as a table.
        const bytes = src ? await this.fetchBytes(src) : new Uint8Array(await file!.arrayBuffer());
        await conn.insertArrowIPC(bytes, FILE_SHEET_TABLE);
        materialized = true;
      } else {
        const regName = claimFileName(name);
        this.files.push(regName);
        if (src) await engine.registerFileURL(regName, src);
        else await engine.registerFile(regName, file!);
        materialized = typeof o.materialize === "boolean" ? o.materialize : size !== undefined && size < MATERIALIZE_LIMIT_BYTES;
        await conn.query(`CREATE ${materialized ? "TABLE" : "VIEW"} ${target} AS SELECT * FROM ${readerSql(regName, format)}`);
      }
    } catch (e) {
      const err = toDriverError(e);
      throw new DriverError(`Could not read ${name} as ${formatLabel(format)}: ${err.message}`, err.code ?? "read_failed", e);
    }

    let rows: number | undefined;
    if (materialized) {
      const r = tableObjects(await conn.query(`SELECT count(*) AS n FROM ${target}`))[0];
      rows = Number(str(r?.n));
    }
    this.fileInfo = { name, format, size, source: src ? "url" : "file", materialized, rows };
  }

  private async remoteSize(url: string): Promise<number | undefined> {
    const f = this.deps.fetch ?? globalThis.fetch;
    if (!f || !/^https?:/i.test(url)) return undefined;
    try {
      const res = await f(url, { method: "HEAD", credentials: "include" });
      if (!res.ok) return undefined;
      const len = res.headers.get("content-length");
      // With Content-Encoding this is the compressed size; still a fair hint.
      return len ? Number(len) : undefined;
    } catch {
      return undefined;
    }
  }

  private async fetchBytes(url: string): Promise<Uint8Array> {
    const f = this.deps.fetch ?? globalThis.fetch;
    const res = await f(url, { credentials: "include" });
    if (!res.ok) throw new DriverError(`GET ${url} failed: HTTP ${res.status}`, "http");
    return new Uint8Array(await res.arrayBuffer());
  }

  async disconnect(): Promise<void> {
    const conns = [...this.all];
    this.all.clear();
    this.idle = [];
    if (conns[0] && this.catalog) {
      await conns[0].query(`USE memory; DETACH DATABASE IF EXISTS ${q(this.catalog)}`).catch(() => undefined);
    }
    await Promise.all(conns.map((c) => c.close().catch(() => undefined)));
    await this.cleanupFiles();
    this.fileInfo = null;
  }

  private async cleanupFiles(): Promise<void> {
    const engine = this.engine;
    for (const f of this.files) {
      registeredNames.delete(f);
      await engine?.dropFile(f).catch(() => undefined);
    }
    this.files = [];
  }

  // --- Connection pool (one statement per DuckDB connection at a time) -------------------

  private async acquire(): Promise<DuckConn> {
    if (!this.engine || !this.catalog) throw new DriverError("Not connected", "not_connected");
    const c = this.idle.pop();
    if (c) return c;
    const conn = await this.engine.connect();
    this.all.add(conn);
    await conn.query(`USE ${q(this.catalog)}`);
    return conn;
  }

  private release(c: DuckConn): void {
    if (this.all.has(c)) this.idle.push(c);
  }

  private async rows(sql: string, params: Cell[] = []): Promise<Record<string, Cell>[]> {
    const c = await this.acquire();
    try {
      const t = params.length ? await c.queryParams(sql, params.map(toParam)) : await c.query(sql);
      return tableObjects(t);
    } catch (e) {
      throw toDriverError(e);
    } finally {
      this.release(c);
    }
  }

  // --- Sidebar ---------------------------------------------------------------------------

  async listObjects(parent: ObjectPath, signal?: AbortSignal): Promise<ObjectNode[]> {
    aborted(signal);
    if (this.id === "file") {
      if (parent.length) return [];
      return [{ path: [FILE_SHEET_TABLE], name: FILE_SHEET_TABLE, type: "table", hasChildren: false, meta: this.fileMeta() }];
    }
    if (parent.length === 0) {
      const schemas = await this.rows(
        `SELECT s.schema_name AS name,
           (SELECT count(*) FROM duckdb_tables() t WHERE t.database_name = s.database_name AND t.schema_name = s.schema_name)
           + (SELECT count(*) FROM duckdb_views() v WHERE v.database_name = s.database_name AND v.schema_name = s.schema_name AND NOT v.internal) AS n
         FROM duckdb_schemas() s WHERE s.database_name = ? AND s.schema_name NOT IN ('information_schema', 'pg_catalog')
         ORDER BY s.schema_name <> 'main', s.schema_name`,
        [this.catalog],
      );
      return schemas.map((s) => ({ path: [str(s.name)], name: str(s.name), type: "schema" as const, hasChildren: Number(str(s.n)) > 0, meta: str(s.n) }));
    }
    if (parent.length !== 1) return [];
    const schema = parent[0]!;
    const objs = await this.rows(
      `SELECT table_name AS name, 'table' AS kind, estimated_size AS n FROM duckdb_tables() WHERE database_name = ? AND schema_name = ?
       UNION ALL
       SELECT view_name, 'view', NULL FROM duckdb_views() WHERE database_name = ? AND schema_name = ? AND NOT internal
       ORDER BY kind, name`,
      [this.catalog, schema, this.catalog, schema],
    );
    return objs.map((r) => {
      const node: ObjectNode = { path: [schema, str(r.name)], name: str(r.name), type: r.kind === "view" ? "view" : "table", hasChildren: false };
      if (r.n !== null) node.meta = Number(str(r.n)).toLocaleString("en-US");
      return node;
    });
  }

  private fileMeta(): string {
    const f = this.fileInfo;
    if (!f) return "";
    const parts = [formatLabel(f.format)];
    if (f.size !== undefined) parts.push(formatBytes(f.size));
    if (f.rows !== undefined) parts.push(`${f.rows.toLocaleString("en-US")} rows`);
    if (!f.materialized) parts.push("view");
    return parts.join(" · ");
  }

  /** [schema, table] or [table] (schema main) → names. File connections always mean the sheet. */
  private splitPath(path: ObjectPath): { schema: string; table: string } {
    if (this.id === "file") return { schema: "main", table: FILE_SHEET_TABLE };
    const table = path[path.length - 1];
    if (!table) throw new DriverError("Empty object path", "bad_path");
    return { schema: path.length >= 2 ? path[path.length - 2]! : "main", table };
  }

  /** Fully qualified, quoted name in this connection's catalog. */
  sqlName(path: ObjectPath): string {
    const { schema, table } = this.splitPath(path);
    return `${q(this.catalog)}.${q(schema)}.${q(table)}`;
  }

  async describe(path: ObjectPath, signal?: AbortSignal): Promise<TableSchema> {
    aborted(signal);
    const { schema, table } = this.splitPath(path);
    const args = [this.catalog, schema, table];
    const [meta] = await this.rows(
      `SELECT 'table' AS kind, sql, estimated_size AS n, comment FROM duckdb_tables() WHERE database_name = ? AND schema_name = ? AND table_name = ?
       UNION ALL
       SELECT 'view', sql, NULL, comment FROM duckdb_views() WHERE database_name = ? AND schema_name = ? AND view_name = ?`,
      [...args, ...args],
    );
    if (!meta) throw new DriverError(`No table or view named ${schema}.${table}`, "not_found");

    const cols = await this.rows(
      `SELECT column_name, data_type, is_nullable, column_default FROM duckdb_columns()
       WHERE database_name = ? AND schema_name = ? AND table_name = ? ORDER BY column_index`,
      args,
    );
    const cons = await this.rows(
      `SELECT constraint_type, constraint_name, constraint_text, constraint_column_names AS cols, referenced_table, referenced_column_names AS ref_cols
       FROM duckdb_constraints() WHERE database_name = ? AND schema_name = ? AND table_name = ?`,
      args,
    );
    const asList = (v: Cell | undefined) => (Array.isArray(v) ? v.map((x) => str(x as Cell)) : []);
    const pk = cons.find((c) => c.constraint_type === "PRIMARY KEY");
    const pkCols = asList(pk?.cols);
    const refs = new Map<string, string>();
    for (const c of cons.filter((c) => c.constraint_type === "FOREIGN KEY")) {
      const remote = asList(c.ref_cols);
      asList(c.cols).forEach((col, i) => refs.set(col, `${str(c.referenced_table)}.${remote[i] ?? ""}`));
    }

    const enumTypes = new Map<string, string[]>();
    const columns: Column[] = [];
    for (const c of cols) {
      const name = str(c.column_name);
      const type = str(c.data_type);
      const col: Column = { name, type, nullable: c.is_nullable === true, default: c.column_default === null ? null : str(c.column_default) };
      if (pkCols.includes(name)) col.primaryKey = true;
      const ref = refs.get(name);
      if (ref) col.references = ref;
      const inline = /^ENUM\((.*)\)$/s.exec(type);
      if (inline) col.enumValues = parseQuotedList(inline[1]!);
      else if (/^[A-Za-z_]\w*$/.test(type) && !BUILTIN_TYPES.has(type.toUpperCase())) {
        // A named type (CREATE TYPE … AS ENUM): look its values up once.
        if (!enumTypes.has(type)) {
          const [t] = await this.rows(`SELECT enum_range(NULL::${q(type)})::VARCHAR[] AS v`).catch(() => [undefined]);
          enumTypes.set(type, t && Array.isArray(t.v) ? t.v.map((x) => str(x as Cell)) : []);
        }
        const vals = enumTypes.get(type)!;
        if (vals.length) col.enumValues = vals;
      }
      columns.push(col);
    }

    const indexes: Index[] = [];
    if (pk) indexes.push({ name: str(pk.constraint_name) || "PRIMARY KEY", columns: pkCols, unique: true, primary: true, definition: str(pk.constraint_text) });
    for (const u of cons.filter((c) => c.constraint_type === "UNIQUE")) {
      indexes.push({ name: str(u.constraint_name), columns: asList(u.cols), unique: true, primary: false, definition: str(u.constraint_text) });
    }
    const idx = await this.rows(
      `SELECT index_name, is_unique, is_primary, expressions, sql FROM duckdb_indexes() WHERE database_name = ? AND schema_name = ? AND table_name = ?`,
      args,
    );
    for (const i of idx) {
      indexes.push({
        name: str(i.index_name),
        columns: parseExpressions(str(i.expressions)),
        unique: i.is_unique === true,
        primary: i.is_primary === true,
        definition: str(i.sql) || undefined,
      });
    }

    const info: Record<string, string> = { type: str(meta.kind), schema };
    if (meta.kind === "table" && meta.n !== null) info["estimated rows"] = str(meta.n);
    if (meta.comment) info.comment = str(meta.comment);
    if (this.id === "file" && this.fileInfo) {
      const f = this.fileInfo;
      info.format = formatLabel(f.format);
      info.source = f.name;
      if (f.size !== undefined) info.size = formatBytes(f.size);
      info.storage = f.materialized ? "in-memory table" : "view over the file";
      if (f.rows !== undefined) info.rows = String(f.rows);
    }
    return { path, columns, indexes, ddl: str(meta.sql) || undefined, info };
  }

  // --- Queries ---------------------------------------------------------------------------

  async *execute(stmt: Statement, signal?: AbortSignal): AsyncGenerator<ResultPage, ExecuteSummary, void> {
    aborted(signal);
    const started = Date.now();
    const pageSize = Math.max(1, stmt.pageSize ?? DEFAULT_PAGE_SIZE);
    const conn = await this.acquire();
    let running = true;
    const onAbort = () => {
      if (running) void conn.cancel().catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let rowCount = 0;
    let seq = 0;
    let columns: Column[] | undefined;
    let lastRows: Cell[][] = [];
    try {
      const stream = await conn.stream(stmt.sql, stmt.params?.length ? stmt.params.map(toParam) : undefined);
      let conv: BatchConverter | undefined;
      let buf: Cell[][] = [];
      const page = (rows: Cell[][]): ResultPage => {
        lastRows = rows;
        return seq === 0 ? { columns: columns ?? [], rows, seq: seq++ } : { rows, seq: seq++ };
      };
      for await (const batch of stream) {
        aborted(signal);
        if (!conv) {
          conv = new BatchConverter(batch.schema);
          columns = conv.columns;
        }
        const rows = conv.rows(batch);
        rowCount += rows.length;
        buf = buf.length ? buf.concat(rows) : rows;
        while (buf.length >= pageSize) {
          yield page(buf.slice(0, pageSize));
          buf = buf.slice(pageSize);
        }
      }
      aborted(signal);
      if (!conv && stream.schema) columns = new BatchConverter(stream.schema).columns;
      if (buf.length || seq === 0) yield page(buf);
      running = false;

      const summary: ExecuteSummary = { rowCount, ms: Date.now() - started };
      // INSERT/UPDATE/DELETE return a single BIGINT "Count" row.
      if (rowCount === 1 && columns?.length === 1 && columns[0]!.name === "Count" && /^\s*(insert|update|delete|merge)\b/i.test(stmt.sql)) {
        const n = Number(str(lastRows[0]?.[0]));
        if (Number.isFinite(n)) {
          summary.affectedRows = n;
          summary.message = `${n} row${n === 1 ? "" : "s"} affected`;
        }
      }
      return summary;
    } catch (e) {
      if (signal?.aborted) throw new DriverError("Query cancelled", "cancelled");
      throw toDriverError(e);
    } finally {
      // Stopped early (abort, error, or the consumer broke out): interrupt DuckDB.
      if (running) await conn.cancel().catch(() => undefined);
      signal?.removeEventListener("abort", onAbort);
      this.release(conn);
    }
  }

  async apply(changes: ChangeSet, signal?: AbortSignal): Promise<ApplyResult> {
    aborted(signal);
    if (this.id === "file") {
      if (!this.fileInfo?.materialized) {
        throw new DriverError("This file is too big to load into memory, so its sheet can't be edited. Filter it and save the result instead.", "read_only");
      }
    } else if (this.readOnly) {
      throw new DriverError(
        this.opfs ? "This connection is read-only" : "DuckDB files open read-only in the browser. Copy the file into browser storage (OPFS) or use the runner to edit it.",
        "read_only",
      );
    }
    const started = Date.now();
    const statements = buildChangeSet(changes, duckdbDialect, "question", (p) => this.sqlName(p));
    if (!statements.length) return { applied: 0, ms: 0, statements: [] };
    const conn = await this.acquire();
    try {
      await conn.query("BEGIN TRANSACTION");
      try {
        for (const s of statements) {
          aborted(signal);
          if (s.params.length) await conn.queryParams(s.sql, s.params.map(toParam));
          else await conn.query(s.sql);
        }
        await conn.query("COMMIT");
      } catch (e) {
        await conn.query("ROLLBACK").catch(() => undefined);
        throw e;
      }
    } catch (e) {
      throw toDriverError(e);
    } finally {
      this.release(conn);
    }
    if (this.id === "file" && this.fileInfo) {
      const [r] = await this.rows(`SELECT count(*) AS n FROM ${this.sqlName([FILE_SHEET_TABLE])}`);
      this.fileInfo.rows = Number(str(r?.n));
    }
    return { applied: statements.length, ms: Date.now() - started, statements: statements.map((s) => s.sql) };
  }

  // --- File sheets: export / save as -----------------------------------------------------

  /**
   * Writes the sheet (or the result of `fromSql`) in `format` with COPY … TO into an
   * in-memory buffer and returns the bytes.
   */
  async exportBytes(format: SaveFormat, fromSql?: string): Promise<Uint8Array> {
    const engine = this.engine;
    if (!engine) throw new DriverError("Not connected", "not_connected");
    const from = fromSql ? `(${fromSql})` : this.id === "file" ? this.sqlName([FILE_SHEET_TABLE]) : undefined;
    if (!from) throw new DriverError("Nothing to export: pass a query", "bad_request");
    const target = claimFileName(`dbui_export.${format}`);
    const conn = await this.acquire();
    try {
      await engine.registerEmptyFileBuffer(target);
      await conn.query(copyToSql(target, format, from));
      return await engine.copyFileToBuffer(target);
    } catch (e) {
      throw toDriverError(e);
    } finally {
      this.release(conn);
      registeredNames.delete(target);
      await engine.dropFile(target).catch(() => undefined);
    }
  }

  /** Save as: writes the sheet in `format` through a file handle (asks for write permission). */
  async saveAs(format: SaveFormat, handle: FileSystemFileHandle, fromSql?: string): Promise<{ bytes: number }> {
    const bytes = await this.exportBytes(format, fromSql);
    try {
      await writeHandle(handle, bytes);
    } catch (e) {
      throw new DriverError(`Could not write ${handle.name}: ${(e as Error).message ?? e}`, "write_failed", e);
    }
    return { bytes: bytes.length };
  }
}

const BUILTIN_TYPES = new Set([
  "BIGINT", "BIT", "BLOB", "BOOLEAN", "DATE", "DOUBLE", "FLOAT", "HUGEINT", "INTEGER", "INTERVAL", "JSON", "SMALLINT", "TIME",
  "TIMESTAMP", "TIMESTAMP_S", "TIMESTAMP_MS", "TIMESTAMP_NS", "TINYINT", "UBIGINT", "UHUGEINT", "UINTEGER", "USMALLINT", "UTINYINT",
  "UUID", "VARCHAR", "VARINT", "BIGNUM", "NULL", "TIME_NS",
]);

/** "'free', 'pro'" → ["free", "pro"]. */
function parseQuotedList(s: string): string[] {
  const out: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1]!.replace(/''/g, "'"));
  return out;
}

/** duckdb_indexes().expressions, e.g. `['"name"', 'lower(email)']` → ["name", "lower(email)"]. */
function parseExpressions(s: string): string[] {
  return parseQuotedList(s).map((e) => (/^".*"$/.test(e) ? e.slice(1, -1).replace(/""/g, '"') : e));
}

/** Narrows a Driver from the registry to the DuckDB/file driver (for saveAs, info, exportBytes). */
export function asDuckDriver(driver: Driver): DuckDriver | null {
  return driver instanceof DuckDriver ? driver : null;
}

/** Save the file sheet behind `driver` as `format` into `handle`. */
export async function saveAs(driver: Driver, format: SaveFormat, handle: FileSystemFileHandle): Promise<{ bytes: number }> {
  const d = asDuckDriver(driver);
  if (!d) throw new DriverError("Save as needs a DuckDB file sheet", "unsupported");
  return d.saveAs(format, handle);
}

export function createDriver(deps?: DuckDeps): Driver {
  return new DuckDriver(deps);
}
