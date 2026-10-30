// Shared contracts for Collections (DESIGN.md §3.14), scripts and Chains (§3.15).
// The template engine, the script sandbox and the chain runner all code against these.

import type { Cell, Column } from "@core/types";

export type VarType = "string" | "number" | "date" | "boolean" | "list" | "json";

export interface VarDef {
  name: string;
  type?: VarType;
  /** Default value; for type "list" an array. */
  value?: unknown;
  /** Kept in the SecretStore, never exported. */
  secret?: boolean;
  description?: string;
}

export interface Scripts {
  /** JavaScript run in the sandbox before render (§3.14 pre-run). */
  pre?: string;
  /** JavaScript run in the sandbox after the result arrives (§3.14 post-run). */
  post?: string;
}

export interface Environment {
  id: string;
  name: string;
  values: Record<string, unknown>;
}

export interface Collection {
  id: string;
  name: string;
  description?: string;
  /** Saved connection id used by queries that don't set their own. */
  defaultConnectionId?: string;
  vars: VarDef[];
  environments: Environment[];
  activeEnvironmentId?: string;
  scripts?: Scripts;
  createdAt: number;
  updatedAt: number;
}

export interface Folder {
  id: string;
  collectionId: string;
  /** Parent folder id; undefined for top level. */
  parentId?: string;
  name: string;
  scripts?: Scripts;
}

export interface NamedQuery {
  id: string;
  collectionId: string;
  folderId?: string;
  /** Unique within its folder; path "Folder/Sub/name" is what include/ref use. */
  name: string;
  description?: string;
  /** Jinja template. */
  sql: string;
  connectionId?: string;
  vars: VarDef[];
  scripts?: Scripts;
  updatedAt: number;
}

export type ChainStepKind = "query" | "transform-sql" | "transform-script" | "set-vars" | "export" | "assert";

export interface ChainStep {
  id: string;
  /** Unique within the chain; ref("name") points at this step's output. */
  name: string;
  kind: ChainStepKind;
  /** query: a NamedQuery id, or inline SQL with a connection. */
  queryId?: string;
  sql?: string;
  connectionId?: string;
  /** transform-script: JS body of (inputs, vars, db) => rows | { rows, vars }. */
  script?: string;
  /** set-vars: name → expression over earlier step outputs, e.g. column("top_ads", "ad_hash"). */
  assignments?: Record<string, string>;
  /** export: target format. */
  format?: "csv" | "jsonl" | "parquet";
  /** assert: JS boolean expression over inputs, e.g. inputs.sales.rowCount > 0 */
  condition?: string;
  /** Step names this step reads, beyond those found by ref() in its SQL. */
  dependsOn?: string[];
}

export interface Chain {
  id: string;
  collectionId: string;
  name: string;
  description?: string;
  steps: ChainStep[];
  vars: VarDef[];
  updatedAt: number;
  /** Outcome of the last run from the workflow view, for the Workflows list. */
  lastRun?: { status: "done" | "failed" | "cancelled" | "blocked"; at: number };
}

/** A result table passed between scripts and chain steps. */
export interface ResultTable {
  columns: Column[];
  rows: Cell[][];
}

/** Everything a template render needs to resolve include/ref by path. */
export interface TemplateLibrary {
  /** Template text for a query path like "Base/sales_metrics", or undefined. */
  resolve(path: string): string | undefined;
}

export interface RenderOptions {
  dialect: "postgres" | "sqlite" | "duckdb" | "clickhouse" | "bigquery" | "redis";
  vars: Record<string, unknown>;
  library?: TemplateLibrary;
  /**
   * How ref("x") renders. Default: inline the referenced query as a CTE-ready subquery
   * `(…rendered SQL…)`. Chains pass a function returning a local table name instead.
   */
  ref?: (name: string) => string;
}

export interface RenderResult {
  sql: string;
  /** Variables the template (and its includes) used, in first-use order. */
  usedVars: string[];
  /** Paths pulled in by include, for display. */
  includes: string[];
  refs: string[];
  /** Raw {{ x }} without a sql/ident filter in a value position, for the amber underline. */
  warnings: { message: string; varName?: string }[];
}

/** Message contract with the script sandbox page (src/sandbox/). */
export type SandboxRequest =
  | {
      id: string;
      kind: "pre" | "post";
      code: string;
      vars: Record<string, unknown>;
      env: Record<string, unknown>;
      result?: ResultTable;
      /** Post scripts of a query with several statements: every statement's result, in order (result is the last). */
      results?: ResultTable[];
      timeoutMs?: number;
    }
  | {
      id: string;
      kind: "transform";
      code: string;
      vars: Record<string, unknown>;
      inputs: Record<string, ResultTable>;
      timeoutMs?: number;
    };

export interface SandboxResponse {
  id: string;
  ok: boolean;
  /** Variable changes: value set, or null to unset. */
  varChanges: Record<string, unknown>;
  /** Environment writes the script asked for; the UI confirms before applying. */
  envChanges: Record<string, unknown>;
  tests: { name: string; passed: boolean }[];
  logs: string[];
  /** transform: the output table. */
  result?: ResultTable;
  /** db.fail(msg), a thrown error, or a timeout. */
  error?: string;
}
