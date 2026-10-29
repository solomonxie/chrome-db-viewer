// ClickHouse driver over the HTTP interface, straight from the extension (design/DESIGN.md §3.9).
//
// ConnectionConfig.options:
//   url               e.g. "https://ch.example.com:8443" (the UI requests host permission for its origin)
//   user              default "default"
//   database          default database for unqualified names
//   secret            password resolved by the app from cfg.secretRef (in memory only)
//   password          fallback plain password (tests); deps.getSecret(secretRef) wins over both
//   maxExecutionTime  seconds, default 300 (sent on every query, §3.13)
//
// Statement.options:
//   queryId           override the generated query_id
//   maxResultRows     preview guard: max_result_rows + result_overflow_mode=break (§3.13)
//   settings          extra ClickHouse settings as URL params
// Statement.params bind to {p1:Type}, {p2:Type} … placeholders (ClickHouse server-side parameters).

import { clickhouseDialect } from "@core/sql";
import {
  DriverError,
  type ApplyResult,
  type Capabilities,
  type Cell,
  type ChangeSet,
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
import { exceptionToError, parseCompactStream, readLines } from "./stream";
import { convertRow, toColumn } from "./types";

export const DEFAULT_PAGE_SIZE = 2000;
export const DEFAULT_MAX_EXECUTION_TIME = 300;
const FORMAT = "JSONCompactEachRowWithNamesAndTypes";

export interface ClickHouseDeps {
  fetch?: typeof fetch;
  /** Reads the password for cfg.secretRef from the SecretStore (§3.7). */
  getSecret?: (ref: string) => Promise<string | null>;
  newQueryId?: () => string;
}

interface Settings {
  url: string;
  user: string;
  password: string;
  database?: string;
  readOnly: boolean;
  maxExecutionTime: number;
}

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

function formatCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B rows`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M rows`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K rows`;
  return `${n} rows`;
}

function objectType(engine: string): ObjectNode["type"] {
  if (engine === "View" || engine === "LiveView") return "view";
  if (engine === "MaterializedView") return "materialized_view";
  if (engine === "Dictionary") return "dictionary";
  return "table";
}

/** A ClickHouse literal for KILL QUERY; query ids are our UUIDs, but escape anyway. */
const quoteString = (s: string) => clickhouseDialect.literal(s);

export class ClickHouseDriver implements Driver {
  readonly id = "clickhouse" as const;
  readonly dialect = clickhouseDialect;
  private s: Settings | null = null;

  constructor(private readonly deps: ClickHouseDeps = {}) {}

  capabilities(): Capabilities {
    return { kind: "warehouse", transactions: false, editableRows: true, costEstimate: false, cancel: true };
  }

  async connect(cfg: ConnectionConfig, signal?: AbortSignal): Promise<{ serverVersion?: string }> {
    const o = cfg.options;
    const url = String(o.url ?? "").replace(/\/+$/, "");
    if (!/^https?:\/\//.test(url)) throw new DriverError("Set the ClickHouse URL, e.g. https://host:8443", "bad_options");
    // The app passes the resolved secret as options.secret (src/app/lib/connections.ts withSecret).
    let password = typeof o.secret === "string" ? o.secret : typeof o.password === "string" ? o.password : "";
    if (cfg.secretRef && this.deps.getSecret) password = (await this.deps.getSecret(cfg.secretRef)) ?? password;
    this.s = {
      url,
      user: String(o.user ?? "default"),
      password,
      database: o.database ? String(o.database) : undefined,
      readOnly: cfg.readOnly,
      maxExecutionTime: Number(o.maxExecutionTime ?? DEFAULT_MAX_EXECUTION_TIME),
    };
    const rows = await this.queryRows("SELECT version()", {}, signal);
    return { serverVersion: rows[0]?.[0] != null ? `ClickHouse ${rows[0][0]}` : undefined };
  }

  async disconnect(): Promise<void> {
    this.s = null;
  }

  private settings(): Settings {
    if (!this.s) throw new DriverError("Not connected", "not_connected");
    return this.s;
  }

  // --- HTTP -------------------------------------------------------------------------------

  /** Sends one statement. Throws DriverError with the server's message on HTTP errors. */
  private async post(
    sql: string,
    params: Record<string, string>,
    signal?: AbortSignal,
    opts: { readOnly?: boolean; body?: string } = {},
  ): Promise<Response> {
    const s = this.settings();
    const url = new URL(s.url + "/");
    const q = url.searchParams;
    if (s.database) q.set("database", s.database);
    q.set("default_format", FORMAT);
    q.set("max_execution_time", String(s.maxExecutionTime));
    q.set("output_format_json_quote_64bit_integers", "1");
    q.set("output_format_json_quote_decimals", "1");
    q.set("output_format_json_quote_denormals", "1");
    if (opts.readOnly ?? s.readOnly) q.set("readonly", "1");
    for (const [k, v] of Object.entries(params)) q.set(k, v);
    // With a body (INSERT … FORMAT), the SQL goes in the URL and the data in the body.
    if (opts.body !== undefined) q.set("query", sql);
    const doFetch = this.deps.fetch ?? ((...a) => globalThis.fetch(...a));
    const res = await doFetch(url.toString(), {
      method: "POST",
      headers: { "X-ClickHouse-User": s.user, "X-ClickHouse-Key": s.password, "Content-Type": "text/plain; charset=utf-8" },
      body: opts.body ?? sql,
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403 || /AUTHENTICATION_FAILED|REQUIRED_PASSWORD/.test(text)) {
        throw new DriverError(text.trim() || `ClickHouse authentication failed (HTTP ${res.status})`, "auth_failed");
      }
      throw text ? exceptionToError(text) : new DriverError(`ClickHouse HTTP ${res.status}`, String(res.status));
    }
    return res;
  }

  /** Small internal queries (sidebar, describe): drains all rows as converted cells. */
  private async queryRows(sql: string, params: Record<string, string>, signal?: AbortSignal): Promise<Cell[][]> {
    const res = await this.post(sql, params, signal, { readOnly: true });
    if (!res.body) return [];
    const rows: Cell[][] = [];
    let types: string[] = [];
    for await (const ev of parseCompactStream(readLines(res.body), DEFAULT_PAGE_SIZE)) {
      if (ev.kind === "header") types = ev.types;
      else for (const r of ev.rows) rows.push(convertRow(types, r));
    }
    return rows;
  }

  private async killQuery(queryId: string): Promise<void> {
    try {
      const res = await this.post(`KILL QUERY WHERE query_id = ${quoteString(queryId)} ASYNC`, {}, undefined, { readOnly: false });
      await res.body?.cancel();
    } catch {
      // Best effort: the query may have finished, or the user may lack KILL QUERY rights.
    }
  }

  // --- Sidebar ----------------------------------------------------------------------------

  async listObjects(parent: ObjectPath, signal?: AbortSignal): Promise<ObjectNode[]> {
    if (parent.length === 0) {
      const rows = await this.queryRows("SELECT name, engine FROM system.databases ORDER BY name", {}, signal);
      return rows.map(([name, engine]) => ({
        path: [String(name)],
        name: String(name),
        type: "database" as const,
        hasChildren: true,
        meta: engine && engine !== "Atomic" ? String(engine) : undefined,
      }));
    }
    if (parent.length !== 1) return [];
    const db = parent[0]!;
    const tables = await this.queryRows(
      "SELECT name, engine, total_rows, total_bytes FROM system.tables WHERE database = {db:String} AND NOT is_temporary ORDER BY name",
      { param_db: db },
      signal,
    );
    const seen = new Set<string>();
    const out: ObjectNode[] = tables.map(([name, engine, rows, bytes]) => {
      seen.add(String(name));
      const meta = [rows != null ? formatCount(Number(rows)) : undefined, bytes != null && Number(bytes) > 0 ? formatBytes(Number(bytes)) : undefined]
        .filter(Boolean)
        .join(" · ");
      return { path: [db, String(name)], name: String(name), type: objectType(String(engine)), hasChildren: false, meta: meta || String(engine) };
    });
    // XML-configured dictionaries don't appear in system.tables.
    const dicts = await this.queryRows(
      "SELECT name, status, element_count FROM system.dictionaries WHERE database = {db:String} ORDER BY name",
      { param_db: db },
      signal,
    ).catch((e) => {
      if (signal?.aborted) throw e;
      return [] as Cell[][];
    });
    for (const [name, status, count] of dicts) {
      if (seen.has(String(name))) continue;
      out.push({ path: [db, String(name)], name: String(name), type: "dictionary", hasChildren: false, meta: count ? formatCount(Number(count)) : String(status) });
    }
    return out;
  }

  async describe(path: ObjectPath, signal?: AbortSignal): Promise<TableSchema> {
    const [db, table] = path.length >= 2 ? [path[0]!, path[path.length - 1]!] : [this.s?.database ?? "default", path[0]!];
    if (!table) throw new DriverError("describe needs [database, table]", "bad_path");
    const p = { param_db: db, param_t: table };
    const [cols, meta, ddlRows] = await Promise.all([
      this.queryRows(
        "SELECT name, type, default_kind, default_expression, is_in_primary_key, is_in_sorting_key, comment FROM system.columns WHERE database = {db:String} AND table = {t:String} ORDER BY position",
        p,
        signal,
      ),
      this.queryRows(
        "SELECT engine, partition_key, sorting_key, primary_key, sampling_key, total_rows, total_bytes, comment FROM system.tables WHERE database = {db:String} AND name = {t:String}",
        p,
        signal,
      ),
      this.queryRows(`SHOW CREATE TABLE ${clickhouseDialect.quoteIdent(db)}.${clickhouseDialect.quoteIdent(table)}`, {}, signal).catch((e) => {
        if (signal?.aborted) throw e;
        return [] as Cell[][];
      }),
    ]);
    const columns = cols.map(([name, type, defaultKind, defaultExpr, inPk]) => {
      const c = toColumn(String(name), String(type));
      if (inPk === 1 || inPk === true || inPk === "1") c.primaryKey = true;
      if (defaultKind) c.default = `${defaultKind} ${defaultExpr}`;
      return c;
    });
    const ddl = ddlRows[0]?.[0] != null ? String(ddlRows[0][0]) : undefined;
    const info: Record<string, string> = {};
    const m = meta[0];
    if (m) {
      const [engine, partitionKey, sortingKey, primaryKey, samplingKey, rows, bytes, comment] = m;
      if (engine) info.engine = String(engine);
      if (partitionKey) info["partition key"] = String(partitionKey);
      if (sortingKey) info["order by"] = String(sortingKey);
      if (primaryKey && primaryKey !== sortingKey) info["primary key"] = String(primaryKey);
      if (samplingKey) info["sample by"] = String(samplingKey);
      if (rows != null) info.rows = String(rows);
      if (bytes != null) info.size = `${formatBytes(Number(bytes))} compressed`;
      if (comment) info.comment = String(comment);
    }
    const ttl = ddl ? extractTtl(ddl) : undefined;
    if (ttl) info.ttl = ttl;
    const sorting = m?.[2] ? String(m[2]) : "";
    const indexes: Index[] = sorting
      ? [{ name: "ORDER BY", columns: sorting.split(",").map((x) => x.trim()), unique: false, primary: true, definition: `ORDER BY (${sorting})` }]
      : [];
    if (ddl) {
      for (const idx of ddl.matchAll(/^\s*INDEX\s+(\S+)\s+(.+?)\s+TYPE\s+(.+?)\s+GRANULARITY\s+(\d+)/gm)) {
        indexes.push({ name: idx[1]!.replace(/`/g, ""), columns: [idx[2]!], unique: false, primary: false, definition: idx[0].trim() });
      }
    }
    return { path, columns, indexes, ddl, info };
  }

  // --- Queries ----------------------------------------------------------------------------

  async *execute(stmt: Statement, signal?: AbortSignal): AsyncGenerator<ResultPage, ExecuteSummary, void> {
    signal?.throwIfAborted();
    const started = Date.now();
    const pageSize = stmt.pageSize ?? DEFAULT_PAGE_SIZE;
    const queryId = String(stmt.options?.queryId ?? (this.deps.newQueryId ?? (() => crypto.randomUUID()))());
    const params: Record<string, string> = { query_id: queryId };
    const maxRows = stmt.options?.maxResultRows;
    if (maxRows) {
      params.max_result_rows = String(maxRows);
      params.result_overflow_mode = "break";
    }
    for (const [k, v] of Object.entries((stmt.options?.settings as Record<string, unknown>) ?? {})) params[k] = String(v);
    (stmt.params ?? []).forEach((v, i) => {
      params[`param_p${i + 1}`] = v === null ? "\\N" : typeof v === "object" ? JSON.stringify(v) : String(v);
    });

    // Our own controller so the stream stops on abort; the server is stopped with KILL QUERY.
    const ctrl = new AbortController();
    let killed = false;
    const onAbort = () => {
      ctrl.abort(signal?.reason);
      if (!killed) {
        killed = true;
        void this.killQuery(queryId);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let rowCount = 0;
    let seq = 0;
    let complete = false;
    try {
      const res = await this.post(stmt.sql, params, ctrl.signal);
      const summary = parseSummary(res.headers.get("X-ClickHouse-Summary"));
      let columns = null as ReturnType<typeof toColumn>[] | null;
      let types: string[] = [];
      if (res.body) {
        for await (const ev of parseCompactStream(readLines(res.body), pageSize)) {
          if (ev.kind === "header") {
            types = ev.types;
            columns = ev.names.map((n, i) => toColumn(n, types[i] ?? "String"));
            continue;
          }
          const rows = ev.rows.map((r) => convertRow(types, r));
          rowCount += rows.length;
          yield seq === 0 && columns ? { columns, rows, seq: seq++ } : { rows, seq: seq++ };
        }
      }
      if (seq === 0 && columns) yield { columns, rows: [], seq: seq++ };
      const out: ExecuteSummary = { rowCount, ms: Date.now() - started };
      if (!columns && summary) {
        if (summary.written_rows) out.affectedRows = Number(summary.written_rows);
      }
      if (summary?.read_bytes) out.bytesProcessed = Number(summary.read_bytes);
      complete = true;
      return out;
    } catch (e) {
      if (signal?.aborted) throw new DriverError("Query cancelled", "cancelled", { queryId });
      throw e;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      // The consumer stopped early (break / return() / error): stop the stream and the server.
      if (!complete && !killed) {
        killed = true;
        ctrl.abort();
        void this.killQuery(queryId);
      }
    }
  }

  // --- Edits: inserts only (§3.6) -------------------------------------------------------

  async apply(changes: ChangeSet, signal?: AbortSignal): Promise<ApplyResult> {
    const s = this.settings();
    const started = Date.now();
    const bad = changes.changes.find((c) => c.type !== "insert");
    if (bad) {
      throw new DriverError(
        `ClickHouse grid edits are inserts only. ${bad.type === "update" ? "Updates" : "Deletes"} are mutations that rewrite data parts; run ALTER TABLE … ${bad.type === "update" ? "UPDATE" : "DELETE"} from the editor instead.`,
        "unsupported_change",
      );
    }
    if (s.readOnly) throw new DriverError("This connection is read-only", "read_only");
    // One INSERT per table, rows as JSONEachRow. ClickHouse has no multi-statement transaction.
    const byTable = new Map<string, Record<string, Cell>[]>();
    for (const c of changes.changes) {
      if (c.type !== "insert") continue;
      const name = c.table.map((p) => clickhouseDialect.quoteIdent(p)).join(".");
      const list = byTable.get(name) ?? [];
      list.push(c.values);
      byTable.set(name, list);
    }
    const statements: string[] = [];
    let applied = 0;
    for (const [table, rows] of byTable) {
      const sql = `INSERT INTO ${table} FORMAT JSONEachRow`;
      const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
      const res = await this.post(sql, {}, signal, { body, readOnly: false });
      await res.text();
      statements.push(`${sql} -- ${rows.length} row${rows.length === 1 ? "" : "s"}`);
      applied += rows.length;
    }
    return { applied, ms: Date.now() - started, statements };
  }
}

function parseSummary(h: string | null): Record<string, string> | null {
  if (!h) return null;
  try {
    return JSON.parse(h) as Record<string, string>;
  } catch {
    return null;
  }
}

/** Pulls the TTL clause out of SHOW CREATE TABLE output. */
export function extractTtl(ddl: string): string | undefined {
  const m = /^TTL\s+([\s\S]+?)(?=^\s*(?:SETTINGS|COMMENT)\b|$(?![\s\S]))/m.exec(ddl);
  return m ? m[1]!.trim().replace(/\s+/g, " ") : undefined;
}

export function createDriver(deps?: ClickHouseDeps): Driver {
  return new ClickHouseDriver(deps);
}
