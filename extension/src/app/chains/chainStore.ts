// Workflows (code name: chains) in the "chains" store, one row per workflow. Workflows and
// collections are separate: a workflow's query steps can use named queries from any collection.

import type { Chain, ChainStep, ChainStepKind, NamedQuery } from "../../collections/model";
import { deleteChainRow, getChainRow, listChainRows, putChainRow, uniqueName } from "../../collections/store";
import { uid } from "../store/db";

export const STEP_KINDS: { kind: ChainStepKind; label: string; hint: string }[] = [
  { kind: "query", label: "Query", hint: "Runs a named query or inline SQL on a connection" },
  { kind: "transform-sql", label: "Transform: DuckDB", hint: "DuckDB SQL over earlier results, on this machine. Joins results from different databases." },
  { kind: "transform-script", label: "Transform: JavaScript", hint: "A JavaScript function over earlier results, in the sandbox" },
  { kind: "set-vars", label: "Set variables", hint: "Takes values out of a result (a list of ids, a date) for later queries" },
  { kind: "export", label: "Export", hint: "Saves a result as CSV, JSON Lines or Parquet with DuckDB" },
  { kind: "assert", label: "Assert", hint: "Fails the workflow when a check isn't met" },
];

export const kindLabel = (k: ChainStepKind) => STEP_KINDS.find((s) => s.kind === k)?.label ?? k;

export async function loadChain(id: string): Promise<Chain | undefined> {
  return getChainRow(id);
}

export async function saveChain(c: Chain): Promise<Chain> {
  const row = { ...c, updatedAt: Date.now() };
  await putChainRow(row);
  return row;
}

/** Deletes a workflow; the returned function puts it back (Undo). */
export async function deleteChain(id: string): Promise<() => Promise<void>> {
  const row = await getChainRow(id);
  await deleteChainRow(id);
  return async () => {
    if (row) await putChainRow(row);
  };
}

export async function allChains(): Promise<Chain[]> {
  const rows = await listChainRows();
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createChain(name = "New workflow"): Promise<Chain> {
  const c: Chain = { id: uid("ch_"), name, steps: [], vars: [], updatedAt: Date.now() };
  await putChainRow(c);
  return c;
}

/** A copy with a fresh id and "name copy". */
export async function duplicateChain(c: Chain): Promise<Chain> {
  const names = (await listChainRows()).map((x) => x.name);
  const copy: Chain = { ...structuredClone(c), id: uid("ch_"), name: uniqueName(`${c.name} copy`, names), updatedAt: Date.now() };
  delete copy.lastRun;
  await putChainRow(copy);
  return copy;
}

/** Collection ids of the named queries a workflow's query steps use, in step order. */
export function collectionsUsed(c: Chain, queries: Pick<NamedQuery, "id" | "collectionId">[]): string[] {
  const byId = new Map(queries.map((q) => [q.id, q.collectionId]));
  const out = new Set<string>();
  for (const s of c.steps) {
    if (s.kind !== "query" || !s.queryId) continue;
    const col = byId.get(s.queryId);
    if (col) out.add(col);
  }
  return [...out];
}

/** A step name not used yet: base, base_2, base_3 … */
export function freshStepName(steps: ChainStep[], base: string): string {
  const taken = new Set(steps.map((s) => s.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

const BASE_NAME: Record<ChainStepKind, string> = {
  query: "query",
  "transform-sql": "transform",
  "transform-script": "script",
  "set-vars": "vars",
  export: "export",
  assert: "check",
};

export function newStep(kind: ChainStepKind, steps: ChainStep[], defaultConnectionId?: string): ChainStep {
  const prev = steps[steps.length - 1]?.name;
  const s: ChainStep = { id: uid("st_"), name: freshStepName(steps, BASE_NAME[kind]), kind };
  switch (kind) {
    case "query":
      s.sql = "SELECT 1";
      if (defaultConnectionId) s.connectionId = defaultConnectionId;
      break;
    case "transform-sql":
      s.sql = prev ? `SELECT *\nFROM {{ ref("${prev}") }}` : "SELECT 1";
      break;
    case "transform-script":
      s.script = prev
        ? `// inputs.<step>: { columns: string[], rows: object[], rowCount, column(name) }\nreturn inputs.${prev}.rows.map((r) => ({ ...r }));`
        : "return [];";
      break;
    case "set-vars":
      s.assignments = { ids: `column("${prev ?? "step"}", "id")` };
      break;
    case "export":
      s.format = "csv";
      if (prev) s.sql = `SELECT * FROM {{ ref("${prev}") }}`;
      break;
    case "assert":
      s.condition = prev ? `count("${prev}") > 0` : "true";
      break;
  }
  return s;
}
