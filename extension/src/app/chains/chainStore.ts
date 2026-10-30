// Chains in IndexedDB (the "chains" store, one row per chain, looked up by collection).

import type { Chain, ChainStep, ChainStepKind } from "../../collections/model";
import * as db from "../store/db";

export const STEP_KINDS: { kind: ChainStepKind; label: string; hint: string }[] = [
  { kind: "query", label: "Query", hint: "Runs a named query or inline SQL on a connection" },
  { kind: "transform-sql", label: "Transform: SQL", hint: "SQL over earlier results, locally in DuckDB" },
  { kind: "transform-script", label: "Transform: script", hint: "JavaScript over earlier results, in the sandbox" },
  { kind: "set-vars", label: "Set variables", hint: "Picks values out of a result for later steps" },
  { kind: "export", label: "Export", hint: "Writes a result to a CSV, JSONL or Parquet file" },
  { kind: "assert", label: "Assert", hint: "Fails the chain when a check isn't met" },
];

export const kindLabel = (k: ChainStepKind) => STEP_KINDS.find((s) => s.kind === k)?.label ?? k;

export async function loadChain(id: string): Promise<Chain | undefined> {
  return db.get("chains", id);
}

export async function saveChain(c: Chain): Promise<Chain> {
  const row = { ...c, updatedAt: Date.now() };
  await db.put("chains", row);
  return row;
}

export async function deleteChain(id: string): Promise<void> {
  await db.del("chains", id);
}

export async function chainsFor(collectionId: string): Promise<Chain[]> {
  const rows = await db.byCollection("chains", collectionId);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function allChains(): Promise<Chain[]> {
  const rows = await db.getAll("chains");
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createChain(collectionId: string, name = "New chain"): Promise<Chain> {
  const c: Chain = { id: db.uid("ch_"), collectionId, name, steps: [], vars: [], updatedAt: Date.now() };
  await db.put("chains", c);
  return c;
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
  const s: ChainStep = { id: db.uid("st_"), name: freshStepName(steps, BASE_NAME[kind]), kind };
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
