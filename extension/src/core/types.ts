// Shared contracts between the UI and every driver. See design/DESIGN.md §3.5.
// Drivers live in src/drivers/<name>/ and must only import from src/core.

export type StoreKind = "relational" | "keyvalue" | "warehouse" | "file";

export type DriverId = "duckdb" | "sqlite" | "bigquery" | "clickhouse" | "postgres" | "redis" | "file";

export type Env = "local" | "dev" | "staging" | "production";

export interface Capabilities {
  kind: StoreKind;
  transactions: boolean;
  editableRows: boolean;
  costEstimate: boolean;
  cancel: boolean;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  driver: DriverId;
  env: Env;
  readOnly: boolean;
  /** Driver-specific settings: host, port, database, url, file handle id, auth method … */
  options: Record<string, unknown>;
  /** Key for the secret in SecretStore; never the secret itself. */
  secretRef?: string;
}

/** Path of an object in the sidebar tree, outermost first, e.g. ["public", "tables", "orders"]. */
export type ObjectPath = string[];

export type ObjectType =
  | "database" | "schema" | "group" | "table" | "view" | "materialized_view"
  | "function" | "dictionary" | "dataset" | "key" | "file";

export interface ObjectNode {
  path: ObjectPath;
  name: string;
  type: ObjectType;
  hasChildren: boolean;
  /** Short right-aligned hint in the tree: row count, size, key type … */
  meta?: string;
}

export interface Column {
  name: string;
  /** Type name as the source reports it (int8, jsonb, UInt64, STRING …). */
  type: string;
  nullable: boolean;
  primaryKey?: boolean;
  default?: string | null;
  /** "table.column" this column references. */
  references?: string;
  /** Allowed values for enum-like columns, used by the Details pane. */
  enumValues?: string[];
}

export interface Index {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  definition?: string;
}

export interface TableSchema {
  path: ObjectPath;
  columns: Column[];
  indexes: Index[];
  ddl?: string;
  /** Free-form facts shown in the Structure tab: engine, partition key, TTL, size … */
  info?: Record<string, string>;
}

/**
 * Cell values crossing the driver boundary. 64-bit integers, decimals and timestamps are
 * strings so they never lose precision; JSON columns are parsed values.
 */
export type Cell = string | number | boolean | null | unknown[] | { [k: string]: unknown };

export interface ResultPage {
  /** Present on the first page of a result set. */
  columns?: Column[];
  rows: Cell[][];
  /** 0-based page number within this result set. */
  seq: number;
}

export interface ExecuteSummary {
  rowCount: number;
  ms: number;
  /** For statements that don't return rows. */
  affectedRows?: number;
  bytesProcessed?: number;
  message?: string;
}

export interface Statement {
  sql: string;
  params?: Cell[];
  pageSize?: number;
  /** Driver-specific: query_id for ClickHouse, maximumBytesBilled for BigQuery … */
  options?: Record<string, unknown>;
}

export interface CostEstimate {
  bytes: number;
  usd?: number;
  note?: string;
}

/** A pending edit. Rows are identified by their primary-key values. */
export type Change =
  | { type: "update"; table: ObjectPath; key: Record<string, Cell>; column: string; value: Cell; old: Cell }
  | { type: "insert"; table: ObjectPath; values: Record<string, Cell> }
  | { type: "delete"; table: ObjectPath; key: Record<string, Cell> };

export interface ChangeSet {
  changes: Change[];
}

export interface ApplyResult {
  applied: number;
  ms: number;
  /** Statements that ran, for the history log. */
  statements: string[];
}

export class DriverError extends Error {
  constructor(message: string, public code?: string, public detail?: unknown) {
    super(message);
    this.name = "DriverError";
  }
}

export interface Driver {
  readonly id: DriverId;
  capabilities(): Capabilities;
  connect(cfg: ConnectionConfig, signal?: AbortSignal): Promise<{ serverVersion?: string }>;
  disconnect(): Promise<void>;
  listObjects(parent: ObjectPath, signal?: AbortSignal): Promise<ObjectNode[]>;
  describe(path: ObjectPath, signal?: AbortSignal): Promise<TableSchema>;
  /**
   * Streams result pages. The generator's return value is the summary.
   * Aborting the signal must stop the work on the server, not just the stream.
   */
  execute(stmt: Statement, signal?: AbortSignal): AsyncGenerator<ResultPage, ExecuteSummary, void>;
  estimate?(stmt: Statement, signal?: AbortSignal): Promise<CostEstimate>;
  apply(changes: ChangeSet, signal?: AbortSignal): Promise<ApplyResult>;
  /** SQL dialect used by the editor and the ChangeSet → SQL preview. */
  readonly dialect: SqlDialect;
}

export interface SqlDialect {
  name: "postgres" | "sqlite" | "duckdb" | "clickhouse" | "bigquery" | "redis";
  quoteIdent(name: string): string;
  /** Literal for display in previews only. Drivers must use parameters when executing. */
  literal(value: Cell): string;
}

/** Drains a driver's execute() into memory. For tests and small results only. */
export async function collect(
  gen: AsyncGenerator<ResultPage, ExecuteSummary, void>,
): Promise<{ columns: Column[]; rows: Cell[][]; summary: ExecuteSummary }> {
  let columns: Column[] = [];
  const rows: Cell[][] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { columns, rows, summary: next.value };
    if (next.value.columns) columns = next.value.columns;
    rows.push(...next.value.rows);
  }
}
