// Splits SQL on ';' outside strings and comments, keeping each statement's original text.
// Used by query tabs (Run all), named queries with several statements, and workflow query steps.

/** Statements of `sql`, trimmed, without the separating ';'. Comment-only chunks are dropped. */
export function splitStatementsRaw(sql: string): string[] {
  return splitWithOffsets(sql).map((s) => s.text);
}

/** Like splitStatementsRaw, with where each statement starts and ends in `sql`. */
export function splitWithOffsets(sql: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let start = 0;
  let q: string | null = null;
  const push = (end: number) => {
    const raw = sql.slice(start, end);
    if (hasCode(raw)) {
      const lead = raw.length - raw.trimStart().length;
      out.push({ text: raw.trim(), start: start + lead, end });
    }
  };
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (q) {
      if (c === q && sql[i + 1] === q) i++;
      else if (c === q) q = null;
    } else if (c === "'" || c === '"' || c === "`") {
      q = c;
    } else if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = (nl < 0 ? sql.length : nl) - 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = (close < 0 ? sql.length : close + 2) - 1;
    } else if (c === ";") {
      push(i);
      start = i + 1;
    }
  }
  push(sql.length);
  return out;
}

/** Index of the statement around `pos` (or the last one before it), -1 when there are none. */
export function statementIndexAt(sql: string, pos: number): number {
  const parts = splitWithOffsets(sql);
  if (!parts.length) return -1;
  for (let i = 0; i < parts.length; i++) if (pos <= parts[i]!.end) return pos < parts[i]!.start && i > 0 ? i - 1 : i;
  return parts.length - 1;
}

/** True when `s` has anything besides whitespace and comments. */
function hasCode(s: string): boolean {
  return s.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?(\*\/|$)/g, "").trim().length > 0;
}

export interface StatementResult<C = unknown, R = unknown, S = unknown> {
  sql: string;
  columns: C[];
  rows: R[];
  summary?: S;
  error?: string;
}

/**
 * Runs statements one after another and stops at the first error. Returns one entry per
 * statement that ran (the failing one included, with its error); later ones are not run.
 */
export async function runStatements<C, R, S>(
  statements: string[],
  exec: (sql: string, index: number) => Promise<StatementResult<C, R, S>>,
  onEach?: (r: StatementResult<C, R, S>, index: number) => void,
): Promise<StatementResult<C, R, S>[]> {
  const out: StatementResult<C, R, S>[] = [];
  for (let i = 0; i < statements.length; i++) {
    let r: StatementResult<C, R, S>;
    try {
      r = await exec(statements[i]!, i);
    } catch (e) {
      r = { sql: statements[i]!, columns: [], rows: [], error: (e as Error).message || String(e) };
    }
    out.push(r);
    onEach?.(r, i);
    if (r.error) break;
  }
  return out;
}
