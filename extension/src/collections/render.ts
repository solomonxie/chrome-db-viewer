// Jinja template rendering for named queries (DESIGN.md §3.14). Templates are parsed with
// @huggingface/jinja; dbui's filters (sql, sql_list, ident) and globals (var, ref) are added by
// rewriting the parsed AST, since the library has no custom-filter hook. `include` is expanded
// textually before parsing, so included text shares the caller's variables, exactly like Jinja.

import { Template } from "@huggingface/jinja";
import type { Cell, SqlDialect } from "@core/types";
import { bigqueryDialect, clickhouseDialect, duckdbDialect, postgresDialect, sqliteDialect } from "@core/sql";
import { tokenize } from "../app/lib/sqlFormat";
import type { RenderOptions, RenderResult, TemplateLibrary } from "./model";

export type DialectName = RenderOptions["dialect"];

const DIALECTS: Record<DialectName, SqlDialect> = {
  postgres: postgresDialect,
  sqlite: sqliteDialect,
  duckdb: duckdbDialect,
  clickhouse: clickhouseDialect,
  bigquery: bigqueryDialect,
  redis: { ...postgresDialect, name: "redis" },
};

export const dialectOf = (name: DialectName): SqlDialect => DIALECTS[name];

/** Dialects where a date value renders as a typed `DATE '…'` literal. */
const TYPED_DATES = new Set<DialectName>(["bigquery", "postgres", "duckdb"]);

/** Extra analysis render() returns beyond the shared RenderResult. */
export interface TemplateAnalysis extends RenderResult {
  /** Defaults given inline with var("name", default). */
  varDefaults: Record<string, unknown>;
  /** Variables whose value is output somewhere (not only tested in {% if %}): these need a value to run. */
  requiredVars: string[];
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

// ---------------------------------------------------------------------------------------------
// SQL literal helpers
// ---------------------------------------------------------------------------------------------

const DATE_MARK = "__dbui_date";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isDateMark(v: unknown): v is { [DATE_MARK]: string } {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as Record<string, unknown>)[DATE_MARK] === "string";
}

function dateText(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * One value as a SQL literal in the dialect. `as` forces a type: "date" renders `DATE '…'`
 * (bigquery/postgres/duckdb) for an ISO date string, "string" always quotes.
 *
 * Plain strings that look like dates stay strings on purpose: BigQuery compares a quoted string
 * with DATE, DATETIME and TIMESTAMP columns alike, but `timestamp_col >= DATE '…'` is a type error.
 * JS Date values (e.g. set by a script) and `sql("date")` give the typed literal.
 */
export function sqlLiteral(value: unknown, dialect: DialectName, as?: string, name?: string): string {
  const d = DIALECTS[dialect];
  if (value === undefined) throw new TemplateError(`Variable ${name ? `"${name}" ` : ""}has no value`);
  if (Array.isArray(value)) throw new TemplateError(`Variable ${name ? `"${name}" ` : ""}is a list; use | sql_list for lists`);
  let date: string | null = null;
  if (value instanceof Date) date = dateText(value);
  else if (isDateMark(value)) date = value[DATE_MARK];
  else if (as === "date" && typeof value === "string" && ISO_DATE.test(value.trim())) date = value.trim();
  if (date !== null) return TYPED_DATES.has(dialect) ? `DATE ${d.literal(date)}` : d.literal(date);
  if (as === "string") return d.literal(value === null ? "" : String(value));
  if (as === "number" && typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return String(Number(value));
  if (typeof value === "number" && !Number.isFinite(value)) throw new TemplateError(`Variable ${name ? `"${name}" ` : ""}is not a finite number`);
  return d.literal(value as Cell);
}

/** A list as `(a, b, c)`. An empty list gives `(NULL)`, which is valid after IN and matches nothing. */
export function sqlList(value: unknown, dialect: DialectName, name?: string): string {
  if (value === undefined) throw new TemplateError(`Variable ${name ? `"${name}" ` : ""}has no value`);
  const items = Array.isArray(value) ? value : [value];
  if (items.length === 0) return "(NULL)";
  return "(" + items.map((v) => sqlLiteral(v, dialect, undefined, name)).join(", ") + ")";
}

export function sqlIdent(value: unknown, dialect: DialectName, name?: string): string {
  if (value === undefined || value === null || value === "") throw new TemplateError(`Variable ${name ? `"${name}" ` : ""}has no value`);
  return DIALECTS[dialect].quoteIdent(String(value));
}

// ---------------------------------------------------------------------------------------------
// include expansion
// ---------------------------------------------------------------------------------------------

const INCLUDE_RE = /\{%-?\s*include\s+(?:"([^"]+)"|'([^']+)'|(\S+?))\s*-?%\}/g;

function cycleError(kind: string, stack: string[], path: string): TemplateError {
  return new TemplateError(`${kind} cycle: ${[...stack.slice(stack.indexOf(path)), path].join(" → ")}`);
}

/** Pastes included templates in, recursively. Returns the text and every path pulled in. */
export function expandIncludes(template: string, library: TemplateLibrary | undefined, stack: string[] = [], includes: string[] = []): { text: string; includes: string[] } {
  const text = template.replace(INCLUDE_RE, (_m, dq: string | undefined, sq: string | undefined, bare: string | undefined) => {
    const path = dq ?? sq;
    if (!path) throw new TemplateError(`include needs a quoted path, e.g. {% include "Base/sales" %} (got ${bare})`);
    if (stack.includes(path)) throw cycleError("Include", stack, path);
    const body = library?.resolve(path);
    if (body === undefined) throw new TemplateError(`include "${path}": no query at that path`);
    if (!includes.includes(path)) includes.push(path);
    return expandIncludes(body.replace(/\s+$/, "").replace(/;\s*$/, ""), library, [...stack, path], includes).text;
  });
  return { text, includes };
}

// ---------------------------------------------------------------------------------------------
// AST walking
// ---------------------------------------------------------------------------------------------

interface Node {
  type: string;
  [k: string]: unknown;
}

const isNode = (v: unknown): v is Node => !!v && typeof v === "object" && typeof (v as Node).type === "string";

const GLOBALS = new Set([
  "var", "ref", "true", "false", "none", "True", "False", "None", "range", "raise_exception",
  "strftime_now", "namespace", "loop", "caller", "varargs", "kwargs", "__dbui_filter",
]);
const OUR_FILTERS = new Set(["sql", "sql_list", "ident"]);

function children(node: Node): unknown[] {
  return Object.entries(node)
    .filter(([k]) => k !== "type")
    .map(([, v]) => v);
}

function stringArg(call: Node): string | undefined {
  const a = (call.args as Node[] | undefined)?.[0];
  return a && a.type === "StringLiteral" ? (a.value as string) : undefined;
}

function literalValue(n: Node | undefined): unknown {
  if (!n) return undefined;
  if (n.type === "StringLiteral" || n.type === "IntegerLiteral" || n.type === "FloatLiteral") return n.value;
  if (n.type === "Identifier" && ["true", "True"].includes(n.value as string)) return true;
  if (n.type === "Identifier" && ["false", "False"].includes(n.value as string)) return false;
  if (n.type === "ArrayLiteral" || n.type === "TupleLiteral") return (n.value as Node[]).map(literalValue);
  if (n.type === "UnaryExpression" && (n.operator as { value: string }).value === "-") {
    const v = literalValue(n.argument as Node);
    return typeof v === "number" ? -v : undefined;
  }
  return undefined;
}

interface Walked {
  used: string[];
  required: string[];
  refs: string[];
  varDefaults: Record<string, unknown>;
}

/** Variables a parsed template reads (first-use order), plus ref() targets and var() defaults. */
function walk(program: Node): Walked {
  const declared = new Set<string>();
  const used: string[] = [];
  const required: string[] = [];
  const refs: string[] = [];
  const varDefaults: Record<string, unknown> = {};
  let inCond = 0;
  // Names tested by an enclosing {% if %}: using them in its body doesn't make them required.
  const guarded: string[] = [];
  const use = (name: string) => {
    if (GLOBALS.has(name) || declared.has(name)) return;
    if (!used.includes(name)) used.push(name);
    if (!inCond && !guarded.includes(name) && !required.includes(name)) required.push(name);
  };
  const namesIn = (v: unknown, acc: string[] = []): string[] => {
    if (Array.isArray(v)) v.forEach((x) => namesIn(x, acc));
    else if (isNode(v)) {
      if (v.type === "Identifier") acc.push(v.value as string);
      else children(v).forEach((x) => namesIn(x, acc));
    }
    return acc;
  };
  const cond = (v: unknown) => {
    inCond++;
    visit(v);
    inCond--;
  };
  const declare = (target: unknown) => {
    if (!isNode(target)) return;
    if (target.type === "Identifier") declared.add(target.value as string);
    else if (target.type === "TupleLiteral" || target.type === "ArrayLiteral") (target.value as unknown[]).forEach(declare);
  };
  // Pass 1: names the template declares itself, so {% set x %} … {{ x }} isn't a parameter.
  const findDecls = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(findDecls);
    if (!isNode(v)) return;
    if (v.type === "Set") declare(v.assignee);
    if (v.type === "For") declare(v.loopvar);
    if (v.type === "Macro") {
      declare(v.name);
      for (const a of v.args as Node[]) declare(a.type === "KeywordArgumentExpression" ? a.key : a);
    }
    children(v).forEach(findDecls);
  };
  findDecls(program);

  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (v instanceof Map) {
      for (const [k, val] of v) {
        visit(k);
        visit(val);
      }
      return;
    }
    if (!isNode(v)) return;
    switch (v.type) {
      case "Identifier":
        use(v.value as string);
        return;
      case "MemberExpression":
        visit(v.object);
        if (v.computed) visit(v.property);
        return;
      case "KeywordArgumentExpression":
        visit(v.value);
        return;
      case "FilterExpression": {
        visit(v.operand);
        const f = v.filter as Node;
        if (f.type === "CallExpression") visit(f.args);
        return;
      }
      case "TestExpression":
        cond(v.operand);
        return;
      case "If": {
        cond(v.test);
        const names = namesIn(v.test);
        guarded.push(...names);
        visit(v.body);
        guarded.splice(guarded.length - names.length, names.length);
        visit(v.alternate);
        return;
      }
      case "Ternary":
        cond(v.condition);
        visit(v.trueExpr);
        visit(v.falseExpr);
        return;
      case "Set":
        visit(v.value);
        visit(v.body);
        return;
      case "For":
        visit(v.iterable);
        visit(v.body);
        visit(v.defaultBlock);
        return;
      case "Macro":
        for (const a of v.args as Node[]) if (a.type === "KeywordArgumentExpression") visit(a.value);
        visit(v.body);
        return;
      case "CallExpression": {
        const callee = v.callee as Node;
        if (callee.type === "Identifier" && callee.value === "var") {
          const name = stringArg(v);
          if (name) {
            // var("x", default) never needs a value; var("x") does.
            if ((v.args as Node[]).length > 1) cond({ type: "Identifier", value: name });
            else use(name);
            const def = literalValue((v.args as Node[])[1]);
            if (def !== undefined && !(name in varDefaults)) varDefaults[name] = def;
          }
          visit((v.args as Node[]).slice(1));
          return;
        }
        if (callee.type === "Identifier" && callee.value === "ref") {
          const name = stringArg(v);
          if (name && !refs.includes(name)) refs.push(name);
          return;
        }
        visit(callee);
        visit(v.args);
        return;
      }
      default:
        children(v).forEach(visit);
    }
  };
  visit(program);
  return { used, required, refs, varDefaults };
}

/** Turns `x | sql`, `x | sql_list`, `x | ident` (and `x | sql("date")`) into __dbui_filter calls. */
function rewriteFilters(v: unknown): void {
  if (Array.isArray(v)) return v.forEach(rewriteFilters);
  if (v instanceof Map) {
    for (const [k, val] of v) {
      rewriteFilters(k);
      rewriteFilters(val);
    }
    return;
  }
  if (!isNode(v)) return;
  children(v).forEach(rewriteFilters);
  if (v.type !== "FilterExpression") return;
  const f = v.filter as Node;
  const fname = f.type === "Identifier" ? (f.value as string) : f.type === "CallExpression" && (f.callee as Node).type === "Identifier" ? ((f.callee as Node).value as string) : null;
  if (!fname || !OUR_FILTERS.has(fname)) return;
  const operand = v.operand as Node;
  const operandName = operand.type === "Identifier" ? (operand.value as string) : operand.type === "CallExpression" && (operand.callee as Node).value === "var" ? (stringArg(operand) ?? "") : "";
  const extra = f.type === "CallExpression" ? (f.args as Node[]) : [];
  delete v.operand;
  delete v.filter;
  v.type = "CallExpression";
  v.callee = { type: "Identifier", value: "__dbui_filter" };
  v.args = [{ type: "StringLiteral", value: fname }, operand, { type: "StringLiteral", value: operandName }, ...extra];
}

/** Converts what a FunctionValue receives (runtime values unwrapped one level) back to plain JS. */
function unwrap(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => unwrap((x as { value: unknown }).value));
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [k, unwrap((x as { value: unknown }).value)]));
  return v;
}

function toRuntime(v: unknown): unknown {
  if (v instanceof Date) return { [DATE_MARK]: dateText(v) };
  if (Array.isArray(v)) return v.map(toRuntime);
  return v;
}

function parse(text: string): Template {
  try {
    return new Template(text);
  } catch (e) {
    throw new TemplateError(`Template syntax error: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Injection warnings
// ---------------------------------------------------------------------------------------------

/**
 * Blanks out Jinja tags (keeping offsets), so quotes in them don't confuse SQL scanning. An
 * expression `{{ … }}` becomes a placeholder value `0`, so whatever follows it isn't mistaken
 * for being right after the operator before it.
 */
export function maskJinja(text: string): string {
  return text.replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/g, (m) => (m.startsWith("{{") ? "0" : " ") + m.slice(1).replace(/[^\n]/g, " "));
}

/** Whether the end of `sql` sits inside a single-quoted string (not a comment). */
function endsInString(sql: string): boolean {
  let q = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === "'" && sql[i + 1] === "'") i++;
      else if (c === "'") q = false;
    } else if (c === "'") q = true;
    else if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      if (nl < 0) return false;
      i = nl;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) return false;
      i = end + 1;
    }
  }
  return q;
}

const VALUE_POS = /(?:=|<>|!=|<=|>=|<|>|\b(?:in|like|ilike|between)\s*\(?)\s*$/i;

export interface RiskyRange {
  start: number;
  end: number;
  varName?: string;
  message: string;
}

/**
 * `{{ x }}` expressions with no sql/sql_list/ident filter that sit where a SQL value goes
 * (after =, <>, IN, LIKE …) or inside a quoted string: pasting raw text there is an injection risk.
 */
export function riskyExpressions(template: string): RiskyRange[] {
  const out: RiskyRange[] = [];
  const masked = maskJinja(template);
  const re = /\{\{-?([\s\S]*?)-?\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    const inner = m[1]!;
    if (/\|\s*(?:sql|sql_list|ident)\b/.test(inner) || /^\s*ref\s*\(/.test(inner)) continue;
    const before = masked.slice(0, m.index);
    const quoted = endsInString(before);
    if (!quoted && !VALUE_POS.test(before)) continue;
    const name = inner.match(/^\s*var\s*\(\s*["'](\w+)/)?.[1] ?? inner.match(/^\s*([A-Za-z_]\w*)/)?.[1];
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      varName: name,
      message: quoted
        ? `{{ ${name ?? "…"} }} is pasted inside a quoted string. Use {{ ${name ?? "x"} | sql }} without the quotes.`
        : `{{ ${name ?? "…"} }} is pasted raw where a value goes. Use {{ ${name ?? "x"} | sql }} to quote it safely.`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// analyze / render
// ---------------------------------------------------------------------------------------------

function mergeInto(target: string[], src: string[]) {
  for (const s of src) if (!target.includes(s)) target.push(s);
}

function analyzeInner(template: string, opts: RenderOptions, stack: string[]): TemplateAnalysis {
  const { text, includes } = expandIncludes(template, opts.library, stack);
  const t = parse(text);
  const w = walk(t.parsed as unknown as Node);
  const usedVars = [...w.used];
  const requiredVars = [...w.required];
  const refs = [...w.refs];
  const varDefaults = { ...w.varDefaults };
  const allIncludes = [...includes];
  // Default ref() inlines the other query, so its variables are this query's too.
  if (!opts.ref) {
    for (const r of w.refs) {
      if (stack.includes(r)) throw cycleError("ref", stack, r);
      const body = opts.library?.resolve(r);
      if (body === undefined) continue;
      const sub = analyzeInner(body, opts, [...stack, r]);
      mergeInto(usedVars, sub.usedVars);
      mergeInto(requiredVars, sub.requiredVars);
      mergeInto(refs, sub.refs);
      mergeInto(allIncludes, sub.includes);
      for (const [k, v] of Object.entries(sub.varDefaults)) if (!(k in varDefaults)) varDefaults[k] = v;
    }
  }
  const warnings = riskyExpressions(text).map((r) => ({ message: r.message, varName: r.varName }));
  return { sql: "", usedVars, includes: allIncludes, refs, warnings, varDefaults, requiredVars };
}

/**
 * Static analysis only: variables, includes, refs and warnings, without evaluating. Works when
 * variables are missing, so the Parameters panel can list what's needed before a render succeeds.
 */
export function analyze(template: string, opts: RenderOptions, selfPath?: string): TemplateAnalysis {
  return analyzeInner(template, opts, selfPath ? [selfPath] : []);
}

const IDENT = /^[A-Za-z_]\w*$/;

function evaluate(template: string, opts: RenderOptions, stack: string[], refsSeen: string[]): string {
  const { text } = expandIncludes(template, opts.library, stack);
  const t = parse(text);
  rewriteFilters(t.parsed);
  const items: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opts.vars)) {
    if (IDENT.test(k) && !GLOBALS.has(k)) items[k] = toRuntime(v);
  }
  items.__dbui_filter = (name: string, operand: unknown, operandName: string, ...args: unknown[]) => {
    // A null variable reaches us as undefined, the same as a missing one; tell them apart.
    let value = unwrap(operand);
    if (value === undefined && operandName && opts.vars[operandName] === null) value = null;
    const label = operandName || undefined;
    if (name === "sql") return sqlLiteral(value, opts.dialect, typeof args[0] === "string" ? args[0] : undefined, label);
    if (name === "sql_list") return sqlList(value, opts.dialect, label);
    return sqlIdent(value, opts.dialect, label);
  };
  items.var = (name: unknown, def: unknown) => {
    const key = String(name);
    const v = opts.vars[key];
    return toRuntime(v === undefined || v === null || v === "" ? unwrap(def) : v);
  };
  items.ref = (name: unknown) => {
    const path = String(name);
    if (!refsSeen.includes(path)) refsSeen.push(path);
    if (opts.ref) return opts.ref(path);
    if (stack.includes(path)) throw cycleError("ref", stack, path);
    const body = opts.library?.resolve(path);
    if (body === undefined) throw new TemplateError(`ref("${path}"): no query at that path`);
    const inner = evaluate(body, opts, [...stack, path], refsSeen).trim().replace(/;\s*$/, "");
    return `(\n${inner}\n)`;
  };
  try {
    return t.render(items);
  } catch (e) {
    if (e instanceof TemplateError) throw e;
    throw new TemplateError((e as Error).message);
  }
}

/**
 * Renders a named query template to the SQL that will be sent. `selfPath` (the query's own path)
 * lets a template that includes itself be reported as a cycle naming it.
 */
export function render(template: string, opts: RenderOptions, selfPath?: string): TemplateAnalysis {
  const stack = selfPath ? [selfPath] : [];
  const info = analyzeInner(template, opts, stack);
  const refsSeen: string[] = [];
  const sql = evaluate(template, opts, stack, refsSeen);
  mergeInto(info.refs, refsSeen);
  return { ...info, sql };
}

// ---------------------------------------------------------------------------------------------
// Plain SQL parameters
// ---------------------------------------------------------------------------------------------

export interface SqlParam {
  /** "@start_date", "$1" or "?1" (1-based position for ?). */
  key: string;
  /** Display name: "start_date", "$1", "?1". */
  name: string;
  style: "named" | "dollar" | "question";
}

interface ParamHit {
  key: string;
  name: string;
  style: SqlParam["style"];
  start: number;
  end: number;
}

function paramHits(sql: string, dialect: DialectName): ParamHit[] {
  const hits: ParamHit[] = [];
  let pos = 0;
  let q = 0;
  for (const t of tokenize(sql)) {
    const start = pos;
    pos += t.text.length;
    if (t.kind !== "param") continue;
    const text = t.text;
    if (dialect === "bigquery" && text.startsWith("@")) {
      if (sql[start - 1] === "@") continue; // @@system_variable
      hits.push({ key: text, name: text.slice(1), style: "named", start, end: pos });
    } else if (dialect === "postgres" && /^\$\d+$/.test(text)) {
      hits.push({ key: text, name: text, style: "dollar", start, end: pos });
    } else if ((dialect === "sqlite" || dialect === "duckdb") && text === "?") {
      q++;
      hits.push({ key: `?${q}`, name: `?${q}`, style: "question", start, end: pos });
    }
  }
  return hits;
}

/**
 * Plain SQL parameters in (rendered) SQL: `@name` for BigQuery, `$1` for Postgres, `?` for
 * SQLite/DuckDB. Strings, quoted identifiers and comments are skipped. Unique, in order.
 */
export function detectSqlParams(sql: string, dialect: DialectName): SqlParam[] {
  const out: SqlParam[] = [];
  for (const h of paramHits(sql, dialect)) {
    if (!out.some((p) => p.key === h.key)) out.push({ key: h.key, name: h.name, style: h.style });
  }
  if (dialect === "postgres") out.sort((a, b) => Number(a.key.slice(1)) - Number(b.key.slice(1)));
  return out;
}

/**
 * The statement and positional params to send. The drivers bind positionally, so BigQuery's
 * named `@name` parameters become `?` with one value per occurrence.
 */
export function bindSqlParams(sql: string, dialect: DialectName, values: Record<string, unknown>): { sql: string; params: Cell[] } {
  const hits = paramHits(sql, dialect);
  if (hits.length === 0) return { sql, params: [] };
  const val = (key: string): Cell => {
    const v = values[key];
    if (v === undefined) throw new TemplateError(`SQL parameter ${key} has no value`);
    return v as Cell;
  };
  if (dialect === "postgres") {
    const max = Math.max(...hits.map((h) => Number(h.key.slice(1))));
    return { sql, params: Array.from({ length: max }, (_, i) => val(`$${i + 1}`)) };
  }
  if (dialect === "bigquery") {
    let out = "";
    let last = 0;
    const params: Cell[] = [];
    for (const h of hits) {
      out += sql.slice(last, h.start) + "?";
      last = h.end;
      params.push(val(h.key));
    }
    return { sql: out + sql.slice(last), params };
  }
  return { sql, params: hits.map((h) => val(h.key)) };
}
