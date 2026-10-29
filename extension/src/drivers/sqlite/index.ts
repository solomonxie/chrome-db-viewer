// SQLite driver: @sqlite.org/sqlite-wasm in a Web Worker (design/DESIGN.md §2, §3.13).
//
// ConnectionConfig.options:
//   fileHandleId  id of a picked file in IndexedDB "dbui"/"handles". The bytes are loaded into
//                 memory; picked files are read-only by default (PRAGMA query_only).
//   opfsPath      a database in the origin private file system (scratch DBs), read-write.
// With neither, an empty in-memory database.
// cfg.readOnly forces PRAGMA query_only on any source.
//
// Note: edits to a picked file live in the in-memory copy; writing back to disk through the
// file handle is not wired yet (needs createWritable + engine.export()).

import { buildChangeSet, sqliteDialect } from "@core/sql";
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
import { WorkerBackend } from "./backend";
import type { OpenArgs } from "./engine";
import { readHandleBytes } from "./handles";
import type { SqliteBackend } from "./protocol";

export const DEFAULT_PAGE_SIZE = 2000;

export interface SqliteDeps {
  backend?: SqliteBackend;
  /** Reads a picked file's bytes from its handle id (default: IndexedDB handles store). */
  readFile?: (handleId: string) => Promise<Uint8Array>;
}

const GROUPS: { type: "table" | "view"; label: string }[] = [
  { type: "table", label: "tables" },
  { type: "view", label: "views" },
];

function toDriverError(e: unknown): DriverError {
  if (e instanceof DriverError) return e;
  const err = e as { message?: string; code?: number };
  const code = err.code === 9 ? "cancelled" : err.code !== undefined ? `SQLITE_${err.code}` : undefined;
  return new DriverError(err.message ?? String(e), code);
}

export class SqliteDriver implements Driver {
  readonly id = "sqlite" as const;
  readonly dialect = sqliteDialect;
  private backend: SqliteBackend;
  private readOnly = true;
  private opened = false;

  constructor(private readonly deps: SqliteDeps = {}) {
    this.backend = deps.backend ?? new WorkerBackend();
  }

  capabilities(): Capabilities {
    return { kind: "relational", transactions: true, editableRows: !this.readOnly, costEstimate: false, cancel: true };
  }

  async connect(cfg: ConnectionConfig, signal?: AbortSignal): Promise<{ serverVersion?: string }> {
    const o = cfg.options;
    let args: OpenArgs;
    if (typeof o.fileHandleId === "string" && o.fileHandleId) {
      const read = this.deps.readFile ?? (async (id: string) => (await readHandleBytes(id)).bytes);
      // Picked files are read-only unless the user turned it off explicitly.
      const readOnly = cfg.readOnly || o.writable !== true;
      args = { bytes: await read(o.fileHandleId), readOnly };
    } else if (typeof o.opfsPath === "string" && o.opfsPath) {
      args = { opfsPath: o.opfsPath, readOnly: cfg.readOnly };
    } else {
      args = { readOnly: cfg.readOnly };
    }
    signal?.throwIfAborted();
    this.readOnly = args.readOnly;
    try {
      const { version } = await this.backend.open(args);
      this.opened = true;
      return { serverVersion: `SQLite ${version}` };
    } catch (e) {
      throw toDriverError(e);
    }
  }

  async disconnect(): Promise<void> {
    this.opened = false;
    await this.backend.close();
  }

  private ensureOpen(): void {
    if (!this.opened) throw new DriverError("Not connected", "not_connected");
  }

  private async all(sql: string, params: Cell[] = []): Promise<Record<string, Cell>[]> {
    this.ensureOpen();
    try {
      return await this.backend.all(sql, params);
    } catch (e) {
      throw toDriverError(e);
    }
  }

  // --- Sidebar: tables / views groups → objects -------------------------------------------

  async listObjects(parent: ObjectPath): Promise<ObjectNode[]> {
    if (parent.length === 0) {
      const counts = await this.all("SELECT type, count(*) AS n FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' GROUP BY type");
      const byType = new Map(counts.map((r) => [String(r.type), Number(r.n)]));
      return GROUPS.map((g) => ({ path: [g.label], name: g.label, type: "group" as const, hasChildren: (byType.get(g.type) ?? 0) > 0, meta: String(byType.get(g.type) ?? 0) }));
    }
    const group = GROUPS.find((g) => g.label === parent[0]);
    if (!group || parent.length !== 1) return [];
    const rows = await this.all("SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name COLLATE NOCASE", [group.type]);
    return rows.map((r) => ({ path: [group.label, String(r.name)], name: String(r.name), type: group.type, hasChildren: false }));
  }

  /** Accepts ["tables", "orders"] (tree path) or ["orders"]. */
  private tableName(path: ObjectPath): string {
    const name = path[path.length - 1];
    if (!name) throw new DriverError("Empty object path", "bad_path");
    return name;
  }

  async describe(path: ObjectPath): Promise<TableSchema> {
    const table = this.tableName(path);
    const [meta] = await this.all("SELECT type, sql FROM sqlite_schema WHERE name = ? AND type IN ('table','view')", [table]);
    if (!meta) throw new DriverError(`No table or view named ${table}`, "not_found");
    const cols = await this.all('SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid', [table]);
    const fks = await this.all('SELECT "from", "table", "to" FROM pragma_foreign_key_list(?)', [table]);
    const refs = new Map(fks.map((f) => [String(f.from), `${f.table}.${f.to ?? ""}`]));
    const columns: Column[] = cols.map((c) => {
      const col: Column = { name: String(c.name), type: String(c.type ?? ""), nullable: Number(c.notnull) === 0 && Number(c.pk) === 0, default: c.dflt_value == null ? null : String(c.dflt_value) };
      if (Number(c.pk) > 0) col.primaryKey = true;
      const ref = refs.get(col.name);
      if (ref) col.references = ref;
      return col;
    });
    // Composite primary keys report their position in pk; keep it for the index.
    const pkCols = cols.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => String(c.name));

    const indexes: Index[] = [];
    const list = await this.all('SELECT name, "unique", origin FROM pragma_index_list(?)', [table]);
    for (const ix of list) {
      const name = String(ix.name);
      const icols = await this.all("SELECT name FROM pragma_index_info(?) ORDER BY seqno", [name]);
      const [def] = await this.all("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?", [name]);
      indexes.push({
        name,
        columns: icols.map((r) => String(r.name ?? "<expr>")),
        unique: Number(ix.unique) === 1,
        primary: ix.origin === "pk",
        definition: def?.sql ? String(def.sql) : undefined,
      });
    }
    // INTEGER PRIMARY KEY (rowid alias) has no entry in index_list.
    if (pkCols.length && !indexes.some((i) => i.primary)) indexes.unshift({ name: "PRIMARY KEY", columns: pkCols, unique: true, primary: true });

    const info: Record<string, string> = { type: String(meta.type) };
    if (meta.type === "table") {
      const [cnt] = await this.all(`SELECT count(*) AS n FROM ${sqliteDialect.quoteIdent(table)}`).catch(() => [undefined]);
      if (cnt) info.rows = String(cnt.n);
      if (/WITHOUT\s+ROWID/i.test(String(meta.sql ?? ""))) info["without rowid"] = "true";
      if (/\)\s*STRICT\b/i.test(String(meta.sql ?? ""))) info.strict = "true";
    }
    return { path, columns, indexes, ddl: meta.sql ? String(meta.sql) : undefined, info };
  }

  // --- Queries ----------------------------------------------------------------------------

  async *execute(stmt: Statement, signal?: AbortSignal): AsyncGenerator<ResultPage, ExecuteSummary, void> {
    this.ensureOpen();
    signal?.throwIfAborted();
    const started = Date.now();
    const pageSize = stmt.pageSize ?? DEFAULT_PAGE_SIZE;
    const onAbort = () => this.backend.interrupt();
    signal?.addEventListener("abort", onAbort, { once: true });
    let cursor: number | null = null;
    let rowCount = 0;
    try {
      const q = await this.backend.query(stmt.sql, stmt.params ?? []);
      cursor = q.cursor;
      let seq = 0;
      for (;;) {
        signal?.throwIfAborted();
        const step = await this.backend.next(cursor, pageSize);
        rowCount += step.rows.length;
        if (q.columns && (step.rows.length || seq === 0)) {
          yield seq === 0 ? { columns: q.columns, rows: step.rows, seq } : { rows: step.rows, seq };
          seq++;
        }
        if (step.done) {
          cursor = null;
          const summary: ExecuteSummary = { rowCount, ms: Date.now() - started };
          if (!q.columns && step.changes !== undefined) summary.affectedRows = step.changes;
          return summary;
        }
      }
    } catch (e) {
      if (signal?.aborted) throw new DriverError("Query cancelled", "cancelled");
      throw toDriverError(e);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (cursor !== null) await this.backend.closeCursor(cursor).catch(() => undefined);
    }
  }

  async apply(changes: ChangeSet, signal?: AbortSignal): Promise<ApplyResult> {
    this.ensureOpen();
    if (this.readOnly) throw new DriverError("This SQLite file is open read-only", "read_only");
    signal?.throwIfAborted();
    const started = Date.now();
    // Tree paths are ["tables", name]; SQLite has one schema, so only the table name matters.
    const statements = buildChangeSet(changes, sqliteDialect, "question", (p) => sqliteDialect.quoteIdent(this.tableName(p)));
    try {
      await this.backend.transaction(statements);
    } catch (e) {
      throw toDriverError(e);
    }
    return { applied: statements.length, ms: Date.now() - started, statements: statements.map((s) => s.sql) };
  }
}

export function createDriver(deps?: SqliteDeps): Driver {
  return new SqliteDriver(deps);
}
