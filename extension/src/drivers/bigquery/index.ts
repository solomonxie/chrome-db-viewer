// BigQuery driver: REST v2 over fetch, no runner (design/DESIGN.md §3.8, §3.13).
//
// ConnectionConfig.options:
//   projectId          project that runs (and is billed for) query jobs; defaults to the first listed
//   location           job location, e.g. "US", "EU" (optional; BigQuery infers it otherwise)
//   auth               { method: GoogleAuthMethod, options: {...} }, see src/auth/google
//   maximumBytesBilled cost guard per job, bytes (default DEFAULT_MAX_BYTES_BILLED)
//   pricePerTiB        USD per TiB for estimates (default ON_DEMAND_USD_PER_TIB)
//
// Statement.options: maximumBytesBilled (bytes; overrides the connection's, e.g. after "Run anyway"),
//   timeoutMs, location.

import { createTokenProvider, type GoogleAuthDeps, type GoogleAuthMethod, type TokenProvider } from "../../auth/google";
import { bigqueryDialect } from "@core/sql";
import {
  DriverError,
  type ApplyResult,
  type Capabilities,
  type ConnectionConfig,
  type CostEstimate,
  type Driver,
  type ExecuteSummary,
  type ObjectNode,
  type ObjectPath,
  type ResultPage,
  type Statement,
  type TableSchema,
} from "@core/types";
import { readHandleText } from "../sqlite/handles";
import { convertRows, toColumns, toQueryParameter, type BqSchema } from "./convert";

export const API_ROOT = "https://bigquery.googleapis.com/bigquery/v2";
/**
 * On-demand analysis price, USD per TiB scanned (US multi-region list price since July 2023).
 * Ignores the monthly free tier and regional differences; the UI labels it as an estimate.
 */
export const ON_DEMAND_USD_PER_TIB = 6.25;
/** Default per-job cap, matching the 10 GB cost-guard default in §3.13. */
export const DEFAULT_MAX_BYTES_BILLED = 10 * 1024 ** 3;
const DEFAULT_PAGE_SIZE = 1000;
/** How long one jobs.query / getQueryResults call waits before returning jobComplete=false. */
const POLL_TIMEOUT_MS = 10_000;

export interface BigQueryDeps {
  fetch?: typeof fetch;
  /** Use this provider instead of building one from options.auth. */
  tokenProvider?: TokenProvider;
  /** Passed to createTokenProvider (secret store, file reader, chrome.identity). */
  authDeps?: GoogleAuthDeps;
}

interface BqErrorBody {
  error?: { code?: number; message?: string; status?: string; errors?: { reason?: string; message?: string }[] };
}

type JobRef = { projectId: string; jobId: string; location?: string };

interface QueryResponse {
  jobReference?: JobRef;
  jobComplete?: boolean;
  schema?: BqSchema;
  rows?: { f: { v: never }[] }[];
  pageToken?: string;
  totalRows?: string;
  totalBytesProcessed?: string;
  numDmlAffectedRows?: string;
  cacheHit?: boolean;
  errors?: { reason?: string; message?: string }[];
}

type Partitioning = {
  timePartitioning?: { type?: string; field?: string; expirationMs?: string; requirePartitionFilter?: boolean };
  rangePartitioning?: { field?: string; range?: { start?: string; end?: string; interval?: string } };
};

interface TableResource extends Partitioning {
  type?: string;
  schema?: BqSchema;
  numBytes?: string;
  numLongTermBytes?: string;
  numRows?: string;
  requirePartitionFilter?: boolean;
  clustering?: { fields?: string[] };
  view?: { query?: string };
  materializedView?: { query?: string };
  location?: string;
  creationTime?: string;
  lastModifiedTime?: string;
  expirationTime?: string;
  description?: string;
  tableConstraints?: {
    primaryKey?: { columns?: string[] };
    foreignKeys?: { referencedTable?: { tableId?: string }; columnReferences?: { referencingColumn: string; referencedColumn: string }[] }[];
  };
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

export function bytesToUsd(bytes: number, pricePerTiB = ON_DEMAND_USD_PER_TIB): number {
  return (bytes / 1024 ** 4) * pricePerTiB;
}

function tableType(t?: string): ObjectNode["type"] {
  if (t === "VIEW") return "view";
  if (t === "MATERIALIZED_VIEW") return "materialized_view";
  return "table";
}

function partitionLabel(t: Partitioning): string | undefined {
  if (t.timePartitioning) return `${t.timePartitioning.field ?? "_PARTITIONTIME"} by ${t.timePartitioning.type ?? "DAY"}`;
  if (t.rangePartitioning) return `${t.rangePartitioning.field} by range`;
  return undefined;
}

export class BigQueryDriver implements Driver {
  readonly id = "bigquery" as const;
  readonly dialect = bigqueryDialect;
  private cfg: ConnectionConfig | null = null;
  private tokens: TokenProvider | null = null;
  private projectId = "";

  constructor(private readonly deps: BigQueryDeps = {}) {}

  capabilities(): Capabilities {
    return { kind: "warehouse", transactions: false, editableRows: false, costEstimate: true, cancel: true };
  }

  async connect(cfg: ConnectionConfig, signal?: AbortSignal): Promise<{ serverVersion?: string }> {
    this.cfg = cfg;
    if (this.deps.tokenProvider) {
      this.tokens = this.deps.tokenProvider;
    } else {
      const auth = cfg.options.auth as { method?: GoogleAuthMethod; options?: Record<string, unknown> } | undefined;
      const method = auth?.method ?? "chrome-profile";
      const authOptions: Record<string, unknown> = { ...(auth?.options ?? {}) };
      // A pasted token arrives as the connection's secret (options.secret, set by the app).
      if (method === "access-token" && !authOptions.token && typeof cfg.options.secret === "string") authOptions.token = cfg.options.secret;
      this.tokens = createTokenProvider(method, authOptions as never, { ...defaultAuthDeps(), ...this.deps.authDeps });
    }
    this.projectId = String(cfg.options.projectId ?? "");
    if (!this.projectId) {
      const first = (await this.listProjects(signal))[0];
      if (!first) throw new DriverError("No BigQuery projects are visible to this account. Set a project id.", "no_project");
      this.projectId = first.name;
    } else {
      await this.tokens.getToken(signal); // fail fast on bad credentials
    }
    return { serverVersion: "BigQuery v2" };
  }

  async disconnect(): Promise<void> {
    this.cfg = null;
    this.tokens = null;
  }

  // --- HTTP -------------------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (!this.tokens) throw new DriverError("Not connected", "not_connected");
    const url = new URL(API_ROOT + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const doFetch = this.deps.fetch ?? ((...a) => globalThis.fetch(...a));
    for (let attempt = 0; ; attempt++) {
      opts.signal?.throwIfAborted();
      const { token } = await this.tokens.getToken(opts.signal);
      const res = await doFetch(url.toString(), {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
      });
      // A token revoked early: drop it and retry once with a fresh one.
      if (res.status === 401 && attempt === 0 && this.tokens.invalidate) {
        await this.tokens.invalidate();
        continue;
      }
      const text = await res.text();
      let body = {} as T & BqErrorBody;
      if (text) {
        try {
          body = JSON.parse(text) as T & BqErrorBody;
        } catch {
          if (res.ok) throw new DriverError("BigQuery returned a non-JSON response", "bad_response", text.slice(0, 500));
        }
      }
      if (!res.ok) throw toDriverError(body, res.status);
      return body;
    }
  }

  private loc(stmt?: Statement): string | undefined {
    return (stmt?.options?.location as string | undefined) ?? (this.cfg?.options.location as string | undefined);
  }

  // --- Sidebar: projects → datasets → tables -----------------------------------------------

  private async listPaged<T>(path: string, key: string, signal?: AbortSignal): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.request<Record<string, unknown> & { nextPageToken?: string }>("GET", path, {
        query: { pageToken, maxResults: "1000" },
        signal,
      });
      out.push(...((page[key] as T[] | undefined) ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  private async listProjects(signal?: AbortSignal): Promise<ObjectNode[]> {
    type P = { projectReference: { projectId: string }; friendlyName?: string };
    const projects = await this.listPaged<P>("/projects", "projects", signal);
    return projects.map((p) => {
      const id = p.projectReference.projectId;
      return { path: [id], name: id, type: "database", hasChildren: true, meta: p.friendlyName && p.friendlyName !== id ? p.friendlyName : undefined };
    });
  }

  async listObjects(parent: ObjectPath, signal?: AbortSignal): Promise<ObjectNode[]> {
    if (parent.length === 0) return this.listProjects(signal);
    const [project, dataset] = parent as [string, string | undefined];
    if (parent.length === 1) {
      type D = { datasetReference: { datasetId: string }; location?: string };
      const datasets = await this.listPaged<D>(`/projects/${enc(project)}/datasets`, "datasets", signal);
      return datasets.map((d) => {
        const id = d.datasetReference.datasetId;
        return { path: [project, id], name: id, type: "dataset", hasChildren: true, meta: d.location };
      });
    }
    if (parent.length === 2 && dataset) {
      type T = Partitioning & { tableReference: { tableId: string }; type?: string };
      const tables = await this.listPaged<T>(`/projects/${enc(project)}/datasets/${enc(dataset)}/tables`, "tables", signal);
      const sizes = await this.tableSizes(project, dataset, signal);
      return tables.map((t) => {
        const id = t.tableReference.tableId;
        const size = sizes.get(id);
        const meta = [size !== undefined ? formatBytes(size) : undefined, partitionLabel(t) ? "partitioned" : undefined]
          .filter(Boolean)
          .join(" · ");
        return { path: [project, dataset, id], name: id, type: tableType(t.type), hasChildren: false, meta: meta || undefined };
      });
    }
    return [];
  }

  /** tables.list has no sizes; the __TABLES__ meta-table has them and costs nothing to query. Best effort. */
  private async tableSizes(project: string, dataset: string, signal?: AbortSignal): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    try {
      const res = await this.request<QueryResponse>("POST", `/projects/${enc(this.projectId || project)}/queries`, {
        body: {
          query: `SELECT table_id, size_bytes FROM ${bigqueryDialect.quoteIdent(`${project}.${dataset}.__TABLES__`)}`,
          useLegacySql: false,
          timeoutMs: POLL_TIMEOUT_MS,
          maxResults: 10000,
        },
        signal,
      });
      for (const [id, size] of convertRows(res.schema, res.rows)) sizes.set(String(id), Number(size));
    } catch (e) {
      if (signal?.aborted) throw e;
    }
    return sizes;
  }

  async describe(path: ObjectPath, signal?: AbortSignal): Promise<TableSchema> {
    const [project, dataset, table] = path;
    if (!project || !dataset || !table) throw new DriverError("describe needs [project, dataset, table]", "bad_path");
    const t = await this.request<TableResource>("GET", `/projects/${enc(project)}/datasets/${enc(dataset)}/tables/${enc(table)}`, { signal });
    const columns = toColumns(t.schema);
    const pk = new Set(t.tableConstraints?.primaryKey?.columns ?? []);
    const refs = new Map<string, string>();
    for (const fk of t.tableConstraints?.foreignKeys ?? []) {
      for (const c of fk.columnReferences ?? []) refs.set(c.referencingColumn, `${fk.referencedTable?.tableId}.${c.referencedColumn}`);
    }
    for (const c of columns) {
      if (pk.has(c.name)) c.primaryKey = true;
      const ref = refs.get(c.name);
      if (ref) c.references = ref;
    }
    const info: Record<string, string> = {};
    if (t.type) info.type = t.type;
    if (t.numRows !== undefined) info.rows = t.numRows;
    if (t.numBytes !== undefined) info.size = `${formatBytes(Number(t.numBytes))} (${t.numBytes} bytes)`;
    if (t.numLongTermBytes && t.numLongTermBytes !== "0") info["long-term storage"] = formatBytes(Number(t.numLongTermBytes));
    const part = partitionLabel(t);
    if (part) info.partitioning = part;
    if (t.timePartitioning?.expirationMs) info["partition expiration"] = `${Number(t.timePartitioning.expirationMs) / 86_400_000} days`;
    if (t.requirePartitionFilter || t.timePartitioning?.requirePartitionFilter) info["require partition filter"] = "true";
    if (t.clustering?.fields?.length) info.clustering = t.clustering.fields.join(", ");
    if (t.location) info.location = t.location;
    if (t.creationTime) info.created = new Date(Number(t.creationTime)).toISOString();
    if (t.lastModifiedTime) info.modified = new Date(Number(t.lastModifiedTime)).toISOString();
    if (t.expirationTime) info.expires = new Date(Number(t.expirationTime)).toISOString();
    if (t.description) info.description = t.description;
    return {
      path,
      columns,
      indexes: pk.size ? [{ name: "PRIMARY KEY (NOT ENFORCED)", columns: [...pk], unique: true, primary: true }] : [],
      ddl: t.view?.query ?? t.materializedView?.query,
      info,
    };
  }

  // --- Queries ----------------------------------------------------------------------------

  private queryBody(stmt: Statement, extra: Record<string, unknown>): Record<string, unknown> {
    const body: Record<string, unknown> = {
      query: stmt.sql,
      useLegacySql: false,
      location: this.loc(stmt),
      // TIMESTAMPs as int64 microseconds, so they convert to ISO strings without float rounding.
      formatOptions: { useInt64Timestamp: true },
      ...extra,
    };
    if (stmt.params?.length) {
      body.parameterMode = "POSITIONAL";
      body.queryParameters = stmt.params.map(toQueryParameter);
    }
    return body;
  }

  private maxBytesBilled(stmt: Statement): string {
    return String(stmt.options?.maximumBytesBilled ?? this.cfg?.options.maximumBytesBilled ?? DEFAULT_MAX_BYTES_BILLED);
  }

  async estimate(stmt: Statement, signal?: AbortSignal): Promise<CostEstimate> {
    const res = await this.request<QueryResponse>("POST", `/projects/${enc(this.projectId)}/queries`, {
      body: this.queryBody(stmt, { dryRun: true }),
      signal,
    });
    const bytes = Number(res.totalBytesProcessed ?? 0);
    const price = Number(this.cfg?.options.pricePerTiB ?? ON_DEMAND_USD_PER_TIB);
    return { bytes, usd: bytesToUsd(bytes, price), note: `On-demand estimate at $${price}/TiB; ignores the free tier` };
  }

  async *execute(stmt: Statement, signal?: AbortSignal): AsyncGenerator<ResultPage, ExecuteSummary, void> {
    signal?.throwIfAborted();
    const started = Date.now();
    const pageSize = stmt.pageSize ?? DEFAULT_PAGE_SIZE;
    const timeoutMs = Number(stmt.options?.timeoutMs ?? POLL_TIMEOUT_MS);

    // The first call isn't given `signal`: its jobReference is what jobs.cancel needs. If the user
    // aborts while it's in flight, we reject right away and cancel once the reference arrives.
    const first = await raceAbort(
      this.request<QueryResponse>("POST", `/projects/${enc(this.projectId)}/queries`, {
        body: this.queryBody(stmt, { maximumBytesBilled: this.maxBytesBilled(stmt), timeoutMs, maxResults: pageSize }),
      }),
      signal,
      (r) => this.cancelJob(r.jobReference),
    );
    const job = first.jobReference;
    const onAbort = () => void this.cancelJob(job);
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const results = (pageToken?: string) => {
        if (!job) throw new DriverError("BigQuery returned no job reference", "no_job");
        return this.request<QueryResponse>("GET", `/projects/${enc(job.projectId)}/queries/${enc(job.jobId)}`, {
          query: {
            location: job.location,
            pageToken,
            maxResults: String(pageSize),
            timeoutMs: String(timeoutMs),
            "formatOptions.useInt64Timestamp": "true",
          },
          signal,
        });
      };

      let res = first;
      while (!res.jobComplete) res = await results();
      if (res.errors?.length) throw new DriverError(res.errors.map((e) => e.message).join("; "), res.errors[0]?.reason, res.errors);

      const schema = res.schema;
      const columns = toColumns(schema);
      let seq = 0;
      let rowCount = 0;
      for (;;) {
        const rows = convertRows(schema, res.rows);
        rowCount += rows.length;
        if (columns.length && (rows.length || seq === 0)) {
          yield seq === 0 ? { columns, rows, seq } : { rows, seq };
          seq++;
        }
        if (!res.pageToken) break;
        signal?.throwIfAborted();
        res = await results(res.pageToken);
      }

      const summary: ExecuteSummary = { rowCount, ms: Date.now() - started };
      const bytes = first.totalBytesProcessed ?? res.totalBytesProcessed;
      if (bytes !== undefined) summary.bytesProcessed = Number(bytes);
      const dml = first.numDmlAffectedRows ?? res.numDmlAffectedRows;
      if (dml !== undefined) summary.affectedRows = Number(dml);
      if (first.cacheHit) summary.message = "Served from cache";
      return summary;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async cancelJob(job?: JobRef): Promise<void> {
    if (!job) return;
    try {
      await this.request("POST", `/projects/${enc(job.projectId)}/jobs/${enc(job.jobId)}/cancel`, { query: { location: job.location } });
    } catch {
      // The job may already be done; cancel is best effort.
    }
  }

  async apply(): Promise<ApplyResult> {
    throw new DriverError("BigQuery tables are read-only in the grid. Run DML from the editor.", "read_only");
  }
}

/** Browser defaults: picked key files from the IndexedDB handle store, refresh tokens in chrome.storage.local. */
function defaultAuthDeps(): GoogleAuthDeps {
  const deps: GoogleAuthDeps = { readFile: readHandleText };
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    // Same key scheme as the app's LocalSecretStore (src/app/store/secrets.ts).
    const key = (ref: string) => `secret:${ref}`;
    deps.secrets = {
      get: async (ref) => {
        const got = await chrome.storage.local.get(key(ref));
        const v = got[key(ref)];
        return typeof v === "string" ? v : null;
      },
      set: (ref, value) => chrome.storage.local.set({ [key(ref)]: value }),
      delete: (ref) => chrome.storage.local.remove(key(ref)),
    };
  }
  return deps;
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

/** Resolves like `p`, but rejects with the abort reason when `signal` fires, then runs `late` on p's result. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined, late: (v: T) => unknown): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      p.then(late, () => undefined);
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export function toDriverError(body: BqErrorBody, status: number): DriverError {
  const err = body.error;
  const reason = err?.errors?.[0]?.reason;
  const message = err?.message ?? `BigQuery HTTP ${status}`;
  if (reason === "bytesBilledLimitExceeded") {
    return new DriverError(`${message} Raise the limit or use "Run anyway".`, "bytes_billed_limit", err);
  }
  return new DriverError(message, reason ?? err?.status ?? String(status), err);
}

export function createDriver(deps?: BigQueryDeps): Driver {
  return new BigQueryDriver(deps);
}
