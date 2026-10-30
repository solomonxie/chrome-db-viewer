// A minimal template renderer with the same contract as src/collections/render.ts: handles
// {{ ref("x") }}, {{ name }}, {{ name | sql }}, {{ name | sql_list }}, {{ name | ident }} and
// {{ var("name", default) }}. Chains use it only when the full Jinja renderer isn't available;
// control flow ({% … %}) needs the real one.

import type { RenderOptions, RenderResult } from "../collections/model";

type Dialect = RenderOptions["dialect"];

export function sqlLiteral(v: unknown, dialect: Dialect): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (Array.isArray(v)) return sqlList(v, dialect);
  if (typeof v === "object") v = JSON.stringify(v);
  const s = String(v);
  if (dialect === "bigquery" || dialect === "clickhouse") return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return `'${s.replace(/'/g, "''")}'`;
}

export function sqlList(v: unknown, dialect: Dialect): string {
  const items = Array.isArray(v) ? v : [v];
  // An empty IN () is a syntax error everywhere; (NULL) matches nothing.
  if (!items.length) return "(NULL)";
  return `(${items.map((x) => sqlLiteral(x, dialect)).join(", ")})`;
}

export function sqlIdent(name: unknown, dialect: Dialect): string {
  const s = String(name);
  if (dialect === "bigquery") return "`" + s.replace(/`/g, "\\`") + "`";
  if (dialect === "clickhouse") return "`" + s.replace(/`/g, "``") + "`";
  return `"${s.replace(/"/g, '""')}"`;
}

export function miniRender(template: string, opts: RenderOptions): RenderResult {
  const usedVars: string[] = [];
  const refs: string[] = [];
  const warnings: RenderResult["warnings"] = [];
  const use = (n: string) => {
    if (!usedVars.includes(n)) usedVars.push(n);
  };
  if (/\{%/.test(template)) throw new Error("This template uses {% … %} blocks, which need the full template engine");
  const sql = template.replace(/\{\{-?([\s\S]*?)-?\}\}/g, (_m, inner: string, offset: number) => {
    const [head, ...filters] = inner.split("|").map((s) => s.trim());
    if (!head) throw new Error("Empty {{ }} in template");
    let value: unknown;
    let raw = false;
    const ref = /^ref\(\s*(["'])(.+?)\1\s*\)$/.exec(head);
    const varCall = /^var\(\s*(["'])(.+?)\1\s*(?:,\s*(.+))?\)$/.exec(head);
    if (ref) {
      const name = ref[2]!;
      if (!refs.includes(name)) refs.push(name);
      if (opts.ref) return opts.ref(name);
      const t = opts.library?.resolve(name);
      if (t === undefined) throw new Error(`ref("${name}"): no query with that path`);
      return `(${miniRender(t, { ...opts }).sql})`;
    } else if (varCall) {
      const name = varCall[2]!;
      use(name);
      value = name in opts.vars ? opts.vars[name] : varCall[3] !== undefined ? JSON.parse(varCall[3].replace(/'/g, '"')) : undefined;
    } else if (/^[A-Za-z_]\w*$/.test(head)) {
      use(head);
      if (!(head in opts.vars)) throw new Error(`Variable "${head}" has no value`);
      value = opts.vars[head];
    } else throw new Error(`Unsupported expression {{ ${head} }}: the full template engine is needed`);
    let out: string | undefined;
    for (const f of filters) {
      if (f === "sql") out = sqlLiteral(value, opts.dialect);
      else if (f === "sql_list") out = sqlList(value, opts.dialect);
      else if (f === "ident") out = sqlIdent(value, opts.dialect);
      else throw new Error(`Unknown filter "${f}"`);
    }
    if (out === undefined) {
      raw = true;
      out = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    }
    if (raw && /(?:=|<|>|\bin|\blike)\s*$/i.test(template.slice(0, offset))) {
      warnings.push({ message: `{{ ${head} }} is pasted as raw text where a value belongs; use | sql`, varName: head });
    }
    return out;
  });
  return { sql, usedVars, includes: [], refs, warnings };
}
