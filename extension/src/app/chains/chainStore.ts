// Workflows (code name: chains) in the "chains" store, one row per workflow. Each has a home
// collection (collectionId) for its variables and named queries; the UI shows it as a tag.

import type { Chain, ChainStep, ChainStepKind, Collection, NamedQuery } from "../../collections/model";
import { chainRowsFor, createCollection, deleteChainRow, getChainRow, listChainRows, listCollections, putChainRow, uniqueName } from "../../collections/store";
import { uid } from "../store/db";

export const STEP_KINDS: { kind: ChainStepKind; label: string; hint: string }[] = [
  { kind: "query", label: "Query", hint: "Runs a named query or inline SQL on a connection" },
  { kind: "transform-sql", label: "Transform: SQL", hint: "SQL over earlier results, locally in DuckDB" },
  { kind: "transform-script", label: "Transform: script", hint: "JavaScript over earlier results, in the sandbox" },
  { kind: "set-vars", label: "Set variables", hint: "Picks values out of a result for later steps" },
  { kind: "export", label: "Export", hint: "Writes a result to a CSV, JSONL or Parquet file" },
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

export async function chainsFor(collectionId: string): Promise<Chain[]> {
  const rows = await chainRowsFor(collectionId);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function allChains(): Promise<Chain[]> {
  const rows = await listChainRows();
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createChain(collectionId: string, name = "New workflow"): Promise<Chain> {
  const c: Chain = { id: uid("ch_"), collectionId, name, steps: [], vars: [], updatedAt: Date.now() };
  await putChainRow(c);
  return c;
}

/** A copy with a fresh id and "name copy", in the same collection. */
export async function duplicateChain(c: Chain): Promise<Chain> {
  const names = (await listChainRows()).map((x) => x.name);
  const copy: Chain = { ...structuredClone(c), id: uid("ch_"), name: uniqueName(`${c.name} copy`, names), updatedAt: Date.now() };
  delete copy.lastRun;
  await putChainRow(copy);
  return copy;
}

/** Moves a workflow to another home collection. Steps that use named queries keep their ids. */
export async function moveChain(c: Chain, collectionId: string): Promise<Chain> {
  return saveChain({ ...c, collectionId });
}

export const WORKFLOWS_COLLECTION = "Workflows";

/**
 * The collection "New workflow" picks when the user doesn't choose: the only collection, or a
 * "Workflows" collection (created on demand) when there are none or several.
 */
export async function defaultWorkflowCollection(cols?: Collection[]): Promise<Collection> {
  const list = cols ?? (await listCollections());
  if (list.length === 1) return list[0]!;
  return list.find((c) => c.name === WORKFLOWS_COLLECTION) ?? (await createCollection(WORKFLOWS_COLLECTION));
}

/** Collection ids a workflow's query steps use: the home collection for its named queries, plus any query found elsewhere. */
export function collectionsUsed(c: Chain, queries: Pick<NamedQuery, "id" | "collectionId">[]): string[] {
  const byId = new Map(queries.map((q) => [q.id, q.collectionId]));
  const out = new Set<string>();
  for (const s of c.steps) {
    if (s.kind !== "query" || !s.queryId) continue;
    out.add(byId.get(s.queryId) ?? c.collectionId);
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
      s.assignments = prev ? { ids: `column("${prev}", "id")` } : { value: "1" };
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
