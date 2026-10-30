// Chain dependency graph (DESIGN.md §3.15): edges come from ref("x") in step SQL, step names
// in set-vars/assert functions (count("x")), inputs.x in scripts, variables a set-vars step
// produces, and explicit dependsOn. Steps are sorted into levels; one level runs in parallel.

import type { Chain, ChainStep } from "../collections/model";

export class ChainGraphError extends Error {
  constructor(
    message: string,
    public readonly kind: "cycle" | "missing" | "duplicate" | "invalid",
    /** The steps involved: the loop for a cycle, [from, missing] for a missing ref. */
    public readonly names: string[],
  ) {
    super(message);
    this.name = "ChainGraphError";
  }
}

export interface ChainGraph {
  steps: Map<string, ChainStep>;
  /** Step name → the step names it reads, in first-mention order. */
  inputs: Map<string, string[]>;
  /** Step name → the steps that read it. */
  dependents: Map<string, string[]>;
  /** Topological levels; steps in one level don't depend on each other. */
  levels: string[][];
  /** levels flattened. */
  order: string[];
}

export interface GraphOptions {
  /** Template text of a query step that points at a named query (step.queryId). */
  resolveSql?: (step: ChainStep) => string | undefined;
  /** True when ref("x") names a query in the collection library rather than a chain step. */
  isLibraryRef?: (name: string) => boolean;
}

const REF_RE = /\bref\(\s*(["'])((?:(?!\1).)+)\1\s*\)/g;
/** Functions of the set-vars/assert expression language whose first argument is a step name. */
export const STEP_FUNCTIONS = ["column", "first", "max", "min", "count", "nulls", "sum", "avg", "distinct"] as const;
const STEP_FN_RE = new RegExp(String.raw`\b(?:${STEP_FUNCTIONS.join("|")})\(\s*(["'])((?:(?!\1).)+)\1`, "g");
const INPUTS_RE = /\binputs\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(["'])((?:(?!\2).)+)\2\s*\])/g;
const JINJA_BLOCK_RE = /\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}/g;

/** Names passed to ref("…") in a template, in order, without duplicates. */
export function findRefs(text: string | undefined): string[] {
  return unique(matchAll(text, REF_RE, (m) => m[2]!));
}

/** Identifiers used inside {{ … }} / {% … %} blocks, outside string literals. */
export function templateIdentifiers(text: string | undefined): string[] {
  const out: string[] = [];
  for (const block of matchAll(text, JINJA_BLOCK_RE, (m) => m[1] ?? m[2] ?? "")) {
    const code = block.replace(/(["'])(?:(?!\1)[^\\]|\\.)*\1/g, " ");
    for (const id of code.match(/[A-Za-z_]\w*/g) ?? []) out.push(id);
  }
  return unique(out);
}

/** Template text a step renders: inline SQL, or the named query's text. */
export function stepTemplate(step: ChainStep, opts: GraphOptions = {}): string {
  if (step.kind === "query" && step.queryId) return opts.resolveSql?.(step) ?? step.sql ?? "";
  return step.sql ?? "";
}

/** Step names a step mentions (before checking they exist), with where they came from. */
export function mentionedSteps(step: ChainStep, opts: GraphOptions = {}): { refs: string[]; named: string[] } {
  const refs: string[] = [];
  const named: string[] = [];
  const tpl = stepTemplate(step, opts);
  if (step.kind === "query" || step.kind === "transform-sql" || step.kind === "export") refs.push(...findRefs(tpl));
  if (step.kind === "set-vars") for (const e of Object.values(step.assignments ?? {})) named.push(...matchAll(e, STEP_FN_RE, (m) => m[2]!));
  if (step.kind === "assert") {
    named.push(...matchAll(step.condition, STEP_FN_RE, (m) => m[2]!));
    named.push(...matchAll(step.condition, INPUTS_RE, (m) => m[1] ?? m[3]!));
  }
  if (step.kind === "transform-script") named.push(...matchAll(step.script, INPUTS_RE, (m) => m[1] ?? m[3]!));
  named.push(...(step.dependsOn ?? []));
  return { refs: unique(refs), named: unique(named) };
}

/**
 * Builds the graph and its levels. Throws ChainGraphError naming the steps for duplicate
 * names, refs to steps that don't exist, and cycles.
 */
export function buildGraph(chain: Pick<Chain, "steps">, opts: GraphOptions = {}): ChainGraph {
  const steps = new Map<string, ChainStep>();
  for (const s of chain.steps) {
    if (!s.name.trim()) throw new ChainGraphError("Every step needs a name", "invalid", []);
    if (!/^[A-Za-z_][\w]*$/.test(s.name)) {
      throw new ChainGraphError(`Step name "${s.name}" must start with a letter or _ and use only letters, digits and _`, "invalid", [s.name]);
    }
    if (steps.has(s.name)) throw new ChainGraphError(`Two steps are named "${s.name}"`, "duplicate", [s.name]);
    steps.set(s.name, s);
  }

  // Variables produced by set-vars steps (assignments) → producing step.
  const producers = new Map<string, string>();
  for (const s of chain.steps) if (s.kind === "set-vars") for (const v of Object.keys(s.assignments ?? {})) producers.set(v, s.name);

  const inputs = new Map<string, string[]>();
  for (const s of chain.steps) {
    const { refs, named } = mentionedSteps(s, opts);
    const list: string[] = [];
    for (const r of refs) {
      if (steps.has(r)) list.push(r);
      else if (!opts.isLibraryRef?.(r)) throw missing(s.name, r);
    }
    for (const n of named) {
      if (steps.has(n)) list.push(n);
      else throw missing(s.name, n);
    }
    const tpl = s.kind === "query" || s.kind === "transform-sql" || s.kind === "export" ? stepTemplate(s, opts) : "";
    for (const id of templateIdentifiers(tpl)) {
      const p = producers.get(id);
      if (p && p !== s.name) list.push(p);
    }
    inputs.set(s.name, unique(list));
  }

  const dependents = new Map<string, string[]>([...steps.keys()].map((n) => [n, []]));
  for (const [n, ins] of inputs) for (const i of ins) dependents.get(i)!.push(n);

  // Kahn's algorithm, level by level, keeping chain order inside a level.
  const indeg = new Map([...inputs].map(([n, ins]) => [n, ins.length]));
  const levels: string[][] = [];
  let ready = chain.steps.map((s) => s.name).filter((n) => indeg.get(n) === 0);
  const done = new Set<string>();
  while (ready.length) {
    levels.push(ready);
    for (const n of ready) done.add(n);
    const next = new Set<string>();
    for (const n of ready) {
      for (const d of dependents.get(n)!) {
        indeg.set(d, indeg.get(d)! - 1);
        if (indeg.get(d) === 0) next.add(d);
      }
    }
    ready = chain.steps.map((s) => s.name).filter((n) => next.has(n));
  }
  if (done.size < steps.size) {
    const loop = findCycle(inputs, [...steps.keys()].filter((n) => !done.has(n)));
    throw new ChainGraphError(`Steps form a cycle: ${loop.join(" → ")}`, "cycle", loop);
  }
  return { steps, inputs, dependents, levels, order: levels.flat() };
}

function missing(from: string, name: string): ChainGraphError {
  return new ChainGraphError(`Step "${from}" refers to "${name}", which is not a step in this chain`, "missing", [from, name]);
}

/** A closed path a → b → … → a among the unsorted steps. */
function findCycle(inputs: Map<string, string[]>, remaining: string[]): string[] {
  const left = new Set(remaining);
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const i of inputs.get(n) ?? []) {
      if (!left.has(i)) continue;
      if (state.get(i) === 1) return [...stack.slice(stack.indexOf(i)), i];
      if (!state.has(i)) {
        const c = visit(i);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of remaining) {
    if (state.has(n)) continue;
    const c = visit(n);
    // inputs point upstream; show the loop in run order.
    if (c) return c.reverse();
  }
  return remaining;
}

/** Every step that reads `name`, directly or not. */
export function descendants(g: ChainGraph, name: string): Set<string> {
  return walk(name, (n) => g.dependents.get(n) ?? []);
}

/** Every step `name` reads, directly or not. */
export function ancestors(g: ChainGraph, name: string): Set<string> {
  return walk(name, (n) => g.inputs.get(n) ?? []);
}

function walk(start: string, next: (n: string) => string[]): Set<string> {
  const seen = new Set<string>();
  const todo = [...next(start)];
  while (todo.length) {
    const n = todo.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    todo.push(...next(n));
  }
  return seen;
}

function matchAll<T>(text: string | undefined, re: RegExp, pick: (m: RegExpExecArray) => T): T[] {
  if (!text) return [];
  const out: T[] = [];
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (let m = r.exec(text); m; m = r.exec(text)) out.push(pick(m));
  return out;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
