// Workflows (code name: chains) in the "chains" store, one row per workflow. Workflows and
// collections are separate: a workflow's query steps can use named queries from any collection.

import type { Chain, ChainStep, ChainStepKind, NamedQuery } from "../../collections/model";
import { getChainRow, trashChain, listChainRows, putChainRow, uniqueName } from "../../collections/store";
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
  const row = await getChainRow(id);
  if (!row) return row;
  const moved = varsToInputsStep(row);
  if (moved !== row) await putChainRow(moved);
  return moved;
}

/**
 * Workflows used to keep inputs in a separate "Workflow variables" list. They are a Set variables
 * step at the top now: each value becomes a literal assignment in a first step named "inputs".
 * Secret variables stay where they were (their values live in the secret store). Returns the
 * same object when there is nothing to move.
 */
export function varsToInputsStep(c: Chain): Chain {
  const plain = c.vars.filter((v) => !v.secret);
  if (!plain.length) return c;
  const assignments = Object.fromEntries(plain.map((v) => [v.name, literalExpr(v.value)]));
  const step: ChainStep = { id: uid("st_"), name: freshStepName(c.steps, "inputs"), kind: "set-vars", assignments };
  const notes = plain.filter((v) => v.description).map((v) => `${v.name}: ${v.description}`);
  if (notes.length) step.description = notes.join("\n");
  return { ...c, vars: c.vars.filter((v) => v.secret), steps: [step, ...c.steps] };
}

/** A value as an expression the Set variables step evaluates back to the same value. */
export function literalExpr(v: unknown): string {
  return v === undefined ? '""' : JSON.stringify(v);
}

export async function saveChain(c: Chain): Promise<Chain> {
  const row = { ...c, updatedAt: Date.now() };
  await putChainRow(row);
  return row;
}

/** Moves a workflow to the Trash; the returned function puts it back (Undo). */
export async function deleteChain(id: string): Promise<() => Promise<void>> {
  return trashChain(id);
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
      // The first step usually holds inputs (a fixed value); later ones take values from a result.
      s.assignments = prev ? { ids: `column("${prev}", "id")` } : { value: '""' };
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
