// Workflow files (DESIGN.md §3.15): one workflow as a portable JSON file, so a workflow written
// somewhere else (by hand, or by Claude for one investigation) can be imported, and a workflow can
// be shared. Saved connections differ per machine, so steps name a connection by an alias, and the
// file lists each alias with its engine and a hint; import matches aliases to saved connections.
//
//   {
//     "format": "dbui-workflow", "version": 1,
//     "name": "Shop export latency",
//     "description": "…",
//     "connections": { "bq": { "driver": "bigquery", "hint": "acme-analytics" } },
//     "vars": [{ "name": "client", "value": "Acme Shop" }],
//     "steps": [{ "name": "clients", "kind": "query", "connection": "bq", "sql": "SELECT …" }]
//   }

import type { DriverId } from "@core/types";
import type { Chain, ChainStep, ChainStepKind, NamedQuery, VarDef } from "../collections/model";
import { buildGraph, ChainGraphError } from "./graph";

export const WORKFLOW_FORMAT = "dbui-workflow";

export interface WorkflowFileConnection {
  driver: DriverId;
  /** Words that identify the connection: a host, project or database name. Shown on import and used to guess. */
  hint?: string;
}

export interface WorkflowFileStep {
  name: string;
  kind: ChainStepKind;
  /** Alias from `connections` (query steps). */
  connection?: string;
  sql?: string;
  /** A named query by path ("Collection/folder/name"); `sql` is used when no such query exists. */
  query?: string;
  script?: string;
  assignments?: Record<string, string>;
  format?: "csv" | "jsonl" | "parquet";
  condition?: string;
  dependsOn?: string[];
  /** What the step is for; shown under the step's header. */
  note?: string;
}

export interface WorkflowFile {
  format: typeof WORKFLOW_FORMAT;
  version: 1;
  name: string;
  description?: string;
  connections?: Record<string, WorkflowFileConnection>;
  vars?: VarDef[];
  steps: WorkflowFileStep[];
}

const KINDS: ChainStepKind[] = ["query", "transform-sql", "transform-script", "set-vars", "export", "assert"];
const DRIVERS: DriverId[] = ["duckdb", "sqlite", "bigquery", "clickhouse", "postgres", "redis"];

/** Parses and checks a workflow file. Errors say what to fix, with the step name. */
export function parseWorkflowFile(text: string): WorkflowFile {
  let data: WorkflowFile;
  try {
    data = JSON.parse(text) as WorkflowFile;
  } catch {
    throw new Error("Not a JSON file");
  }
  if (data?.format !== WORKFLOW_FORMAT) throw new Error(`Not a workflow file (expected "format": "${WORKFLOW_FORMAT}")`);
  if (data.version !== 1) throw new Error(`Workflow file version ${String(data.version)} isn't supported`);
  if (typeof data.name !== "string" || !data.name.trim()) throw new Error("The workflow file has no name");
  if (!Array.isArray(data.steps)) throw new Error("The workflow file has no steps");
  const conns = data.connections ?? {};
  for (const [alias, c] of Object.entries(conns)) {
    if (!DRIVERS.includes(c?.driver)) throw new Error(`Connection "${alias}" has an unknown driver "${String(c?.driver)}"`);
  }
  for (const s of data.steps) {
    if (!KINDS.includes(s?.kind)) throw new Error(`Step "${s?.name}" has an unknown kind "${String(s?.kind)}" (one of ${KINDS.join(", ")})`);
    if (s.kind === "query") {
      if (!s.connection && !s.query) throw new Error(`Query step "${s.name}" needs a connection`);
      if (s.connection && !conns[s.connection]) throw new Error(`Step "${s.name}" uses connection "${s.connection}", which isn't listed under "connections"`);
      if (!s.sql?.trim() && !s.query) throw new Error(`Query step "${s.name}" has no SQL`);
    }
    if (s.kind === "set-vars" && (!s.assignments || !Object.keys(s.assignments).length)) throw new Error(`Set variables step "${s.name}" sets nothing`);
    if (s.kind === "assert" && !s.condition?.trim()) throw new Error(`Assert step "${s.name}" has no condition`);
  }
  // A ref that isn't a step must be a named query path ("Collection/name"), so a typo is caught here.
  try {
    buildGraph({ steps: data.steps.map((s, i) => toStep(s, i, {}, () => undefined)) }, { isLibraryRef: (r) => r.includes("/") });
  } catch (e) {
    if (e instanceof ChainGraphError) throw new Error(e.message);
    throw e;
  }
  return data;
}

interface ConnLike {
  id: string;
  name: string;
  driver: DriverId;
  options: Record<string, unknown>;
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * A saved connection for each alias: the same engine, scored by how many of the alias and hint
 * words appear in its name and settings. Undefined when no connection of that engine exists.
 */
export function guessConnections(file: WorkflowFile, conns: ConnLike[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [alias, want] of Object.entries(file.connections ?? {})) {
    const same = conns.filter((c) => c.driver === want.driver);
    const needles = [...new Set([...words(alias), ...words(want.hint ?? "")])];
    let best: { id: string; score: number } | undefined;
    for (const c of same) {
      const hay = [c.name, ...Object.values(c.options).filter((v) => typeof v === "string")].join(" ").toLowerCase();
      const score = needles.filter((n) => hay.includes(n)).length + (c.name.toLowerCase() === alias.toLowerCase() ? 10 : 0);
      if (!best || score > best.score) best = { id: c.id, score };
    }
    out[alias] = best?.id;
  }
  return out;
}

function toStep(s: WorkflowFileStep, i: number, mapping: Record<string, string | undefined>, queryIdFor: (path: string) => string | undefined): ChainStep {
  const step: ChainStep = { id: `st_${i + 1}_${Math.random().toString(36).slice(2, 8)}`, name: s.name, kind: s.kind };
  const queryId = s.query ? queryIdFor(s.query) : undefined;
  if (queryId) step.queryId = queryId;
  else if (s.sql !== undefined) step.sql = s.sql;
  if (s.connection) {
    const id = mapping[s.connection];
    if (id) step.connectionId = id;
  }
  if (s.script !== undefined) step.script = s.script;
  if (s.assignments) step.assignments = { ...s.assignments };
  if (s.format) step.format = s.format;
  if (s.condition !== undefined) step.condition = s.condition;
  if (s.dependsOn?.length) step.dependsOn = [...s.dependsOn];
  if (s.note?.trim()) step.description = s.note.trim();
  return step;
}

/** The workflow a file describes, with aliases replaced by the picked saved connection ids. */
export function workflowFromFile(
  file: WorkflowFile,
  mapping: Record<string, string | undefined>,
  opts: { id: string; now?: number; queryIdFor?: (path: string) => string | undefined },
): Chain {
  return {
    id: opts.id,
    name: file.name.trim(),
    ...(file.description ? { description: file.description } : {}),
    vars: (file.vars ?? []).map((v) => ({ ...v })),
    steps: file.steps.map((s, i) => toStep(s, i, mapping, opts.queryIdFor ?? (() => undefined))),
    updatedAt: opts.now ?? Date.now(),
  };
}

const aliasOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "db";

/** A workflow as a file: connection ids become aliases named after the connections; secret variables lose their values. */
export function workflowToFile(
  chain: Chain,
  conns: ConnLike[],
  named?: { query(id: string): NamedQuery | undefined; pathOf(q: NamedQuery): string },
): WorkflowFile {
  const byId = new Map(conns.map((c) => [c.id, c]));
  const aliases = new Map<string, string>();
  const connections: Record<string, WorkflowFileConnection> = {};
  const aliasFor = (id: string): string => {
    const known = aliases.get(id);
    if (known) return known;
    const c = byId.get(id);
    let a = aliasOf(c?.name ?? id);
    for (let n = 2; connections[a]; n++) a = `${aliasOf(c?.name ?? id)}_${n}`;
    aliases.set(id, a);
    connections[a] = { driver: c?.driver ?? "postgres", ...(c ? { hint: c.name } : {}) };
    return a;
  };
  const steps = chain.steps.map((s): WorkflowFileStep => {
    const out: WorkflowFileStep = { name: s.name, kind: s.kind };
    if (s.connectionId) out.connection = aliasFor(s.connectionId);
    const q = s.queryId ? named?.query(s.queryId) : undefined;
    if (q && named) {
      out.query = named.pathOf(q);
      out.sql = q.sql;
    } else if (s.sql !== undefined) out.sql = s.sql;
    if (s.script !== undefined) out.script = s.script;
    if (s.assignments) out.assignments = { ...s.assignments };
    if (s.format) out.format = s.format;
    if (s.condition !== undefined) out.condition = s.condition;
    if (s.dependsOn?.length) out.dependsOn = [...s.dependsOn];
    if (s.description) out.note = s.description;
    return out;
  });
  return {
    format: WORKFLOW_FORMAT,
    version: 1,
    name: chain.name,
    ...(chain.description ? { description: chain.description } : {}),
    connections,
    vars: chain.vars.map((v) => (v.secret ? { ...v, value: undefined } : { ...v })),
    steps,
  };
}

/** File name for an exported workflow. */
export const workflowFileName = (name: string) => `${name.replace(/[^\w.-]+/g, "_") || "workflow"}.dbui-workflow.json`;
