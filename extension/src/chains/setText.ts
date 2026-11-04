// The text form of a Set variables step (DESIGN.md §3.15): one `SET name = expression` per
// variable, edited as a single box. Stored as the step's `assignments` (name → expression), so
// workflow files and older workflows read the same. An expression is the expression language
// (src/chains/expr.ts: "text", 42, [1, 2], first("step", "col") …) or a DuckDB subquery in
// parentheses, `(SELECT … FROM {{ ref("step") }})`, run over earlier results.
//
//   SET client_name = "Acme"
//   SET since = '2026-10-14'
//   SET ids = (SELECT DISTINCT id FROM {{ ref("clients") }})
//
// A statement runs until the next line that starts with SET; a trailing ; is dropped; lines
// starting with -- are comments.

export interface ParsedSet {
  assignments: Record<string, string>;
  /** First problem, with its 1-based line; the assignments before it are still returned. */
  error?: { line: number; message: string };
}

const SET_RE = /^\s*set\s+([A-Za-z_]\w*)\s*(?::=|=)\s*([\s\S]*)$/i;
const NAME_RE = /^[A-Za-z_]\w*$/;

export function parseSetText(text: string): ParsedSet {
  const assignments: Record<string, string> = {};
  const lines = text.split("\n");
  let cur: { name: string; line: number; expr: string[] } | null = null;
  const flush = (): ParsedSet["error"] | undefined => {
    if (!cur) return undefined;
    const expr = cur.expr.join("\n").trim().replace(/;\s*$/, "").trim();
    if (!expr) return { line: cur.line, message: `${cur.name} has no value after =` };
    if (cur.name in assignments) return { line: cur.line, message: `${cur.name} is set twice` };
    assignments[cur.name] = expr;
    cur = null;
    return undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (/^\s*--/.test(raw)) continue;
    if (/^\s*set\b/i.test(raw)) {
      const err = flush();
      if (err) return { assignments, error: err };
      const m = SET_RE.exec(raw);
      if (!m) return { assignments, error: { line: i + 1, message: "Write it as SET name = value" } };
      cur = { name: m[1]!, line: i + 1, expr: [m[2]!] };
    } else if (cur) cur.expr.push(raw);
    else if (raw.trim()) return { assignments, error: { line: i + 1, message: "Each variable starts with SET name = …" } };
  }
  const err = flush();
  return err ? { assignments, error: err } : { assignments };
}

export function formatSetText(assignments: Record<string, string>): string {
  return Object.entries(assignments)
    .filter(([k]) => NAME_RE.test(k))
    .map(([k, v]) => `SET ${k} = ${v}`)
    .join("\n");
}

/** `(SELECT …)` / `(WITH …)`: a DuckDB subquery, without its outer parentheses; otherwise null. */
export function sqlSubquery(expr: string): string | null {
  const t = expr.trim();
  if (!/^\(\s*(select|with|from|values)\b/i.test(t) || !t.endsWith(")")) return null;
  return t.slice(1, -1).trim();
}
