// "Turn literals into variables" (DESIGN.md §3.14, History → named query): finds string,
// number and date literals, IN lists and tenant-looking dataset names in a SQL statement,
// suggests a variable name for each, and rewrites the chosen ones as Jinja.

import { tokenize, type Token } from "../app/lib/sqlFormat";
import type { VarDef, VarType } from "./model";
import type { DialectName } from "./render";

export type LiteralKind = "string" | "number" | "date" | "list" | "dataset";

export interface LiteralSuggestion {
  /** Stable key for the checklist: the start offset. */
  id: string;
  start: number;
  end: number;
  /** The text being replaced, as written in the SQL. */
  text: string;
  kind: LiteralKind;
  /** Parsed value, used as the variable default. */
  value: unknown;
  /** Suggested variable name; the user may change it. */
  name: string;
  type: VarType;
  /** Column it is compared with, when there is one. */
  column?: string;
  /** Ticked by default in the checklist (compared values, dates, tenants; not stray literals). */
  selected: boolean;
}

interface Pos extends Token {
  start: number;
  end: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
/** production__<uuid with underscores>, or any <word>__<uuid>. */
const TENANT = /([A-Za-z][A-Za-z0-9]*__)([0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12})/gi;
const COMPARE = new Set(["=", "<>", "!=", "<", ">", "<=", ">=", "=="]);

function withPositions(sql: string): Pos[] {
  const out: Pos[] = [];
  let pos = 0;
  for (const t of tokenize(sql)) {
    // Split merged operator/text runs into single meaningful pieces for look-behind.
    if (t.kind === "op" || t.kind === "text") {
      const re = /\s+|<>|!=|<=|>=|==|[A-Za-z_][\w$]*|[^\s]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(t.text))) out.push({ kind: t.kind, text: m[0], start: pos + m.index, end: pos + m.index + m[0].length });
    } else out.push({ ...t, start: pos, end: pos + t.text.length });
    pos += t.text.length;
  }
  return out.filter((t) => t.text.trim() !== "" && t.kind !== "com");
}

function unquoteString(text: string): string {
  const q = text[0]!;
  return text.slice(1, -1).replace(new RegExp(q + q, "g"), q).replace(/\\(.)/g, "$1");
}

/** The bare column name a token names: `o.status` → status, `"Order Date"` → Order Date. */
function columnName(tokens: Pos[], i: number): string | undefined {
  const t = tokens[i];
  if (!t) return undefined;
  if (t.kind === "ident") return t.text.slice(1, -1).split(".").pop();
  if (t.kind === "text" && /^[A-Za-z_][\w$]*$/.test(t.text)) return t.text;
  if (t.kind === "kw" && /^(date|timestamp|time|datetime)$/i.test(t.text)) return t.text.toLowerCase();
  return undefined;
}

interface Context {
  column?: string;
  op?: string;
  /** For BETWEEN: 0 for the lower bound, 1 for the upper. */
  between?: 0 | 1;
  limit?: boolean;
  interval?: boolean;
}

/** What a literal at token index i is compared with, looking left. */
function contextOf(tokens: Pos[], i: number): Context {
  let j = i - 1;
  // DATE '…' / TIMESTAMP '…': the keyword is part of the literal.
  if (tokens[j]?.kind === "kw" && /^(date|timestamp|datetime|time)$/i.test(tokens[j]!.text)) j--;
  const prev = tokens[j];
  if (!prev) return {};
  const low = prev.text.toLowerCase();
  if (low === "limit" || low === "offset") return { limit: low === "limit" };
  if (low === "interval") return { interval: true };
  if (COMPARE.has(prev.text)) return { column: columnName(tokens, j - 1), op: prev.text };
  if (low === "like" || low === "ilike") {
    const k = tokens[j - 1]?.text.toLowerCase() === "not" ? j - 2 : j - 1;
    return { column: columnName(tokens, k), op: "like" };
  }
  if (low === "between") return { column: columnName(tokens, j - 1), op: "between", between: 0 };
  if (low === "and") {
    // x BETWEEN a AND b: find the BETWEEN two tokens back (allowing DATE before a).
    for (let k = j - 1; k >= Math.max(0, j - 4); k--) {
      if (tokens[k]!.text.toLowerCase() === "between") return { column: columnName(tokens, k - 1), op: "between", between: 1 };
    }
  }
  return {};
}

function dateName(ctx: Context): string {
  const col = ctx.column;
  if (ctx.op === ">=" || ctx.op === ">" || (ctx.op === "between" && ctx.between === 0)) return "start_date";
  if (ctx.op === "<=" || ctx.op === "<" || (ctx.op === "between" && ctx.between === 1)) return "end_date";
  if (!col) return "";
  const c = snake(col);
  return /(^|_)date$/.test(c) ? c : `${c.replace(/_?date$/, "")}_date`;
}

function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .replace(/^(\d)/, "_$1");
}

function plural(col: string): string {
  const c = snake(col);
  if (c.endsWith("s")) return c;
  if (c.endsWith("y") && !/[aeiou]y$/.test(c)) return c.slice(0, -1) + "ies";
  return c + "s";
}

/**
 * Literals in `sql` that could become variables, left to right, with suggested names: from
 * the compared column, start_date/end_date for date ranges, `limit`, `client_id` for tenant
 * datasets, otherwise value_1, value_2 …. Same value with the same name shares one variable.
 */
export function suggestVariables(sql: string, _dialect: DialectName): LiteralSuggestion[] {
  const tokens = withPositions(sql);
  const out: Omit<LiteralSuggestion, "id">[] = [];
  const covered = (start: number) => out.some((s) => start >= s.start && start < s.end);

  // Tenant datasets, inside quoted identifiers or bare.
  for (const t of tokens) {
    if (t.kind !== "ident" && t.kind !== "text" && t.kind !== "str") continue;
    if (t.kind === "str") continue;
    TENANT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TENANT.exec(t.text))) {
      const start = t.start + m.index + m[1]!.length;
      out.push({ start, end: start + m[2]!.length, text: m[2]!, kind: "dataset", value: m[2]!, name: "client_id", type: "string", selected: true });
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (covered(t.start)) continue;

    // IN ( literal, literal … ) → one list variable.
    if (t.kind === "kw" && t.text.toLowerCase() === "in" && tokens[i + 1]?.text === "(") {
      const items: Pos[] = [];
      let k = i + 2;
      let ok = true;
      for (; k < tokens.length; k++) {
        const x = tokens[k]!;
        if (x.text === ")") break;
        if (x.text === ",") continue;
        if (x.kind === "str" || x.kind === "num") items.push(x);
        else {
          ok = false;
          break;
        }
      }
      const close = tokens[k];
      if (ok && close?.text === ")" && items.length > 0) {
        const notIdx = tokens[i - 1]?.text.toLowerCase() === "not" ? i - 2 : i - 1;
        const col = columnName(tokens, notIdx);
        const values = items.map((x) => (x.kind === "num" ? Number(x.text) : unquoteString(x.text)));
        out.push({
          start: tokens[i + 1]!.start,
          end: close.end,
          text: sql.slice(tokens[i + 1]!.start, close.end),
          kind: "list",
          value: values,
          name: col ? plural(col) : "",
          type: "list",
          column: col,
          selected: true,
        });
        i = k;
        continue;
      }
    }

    if (t.kind === "str" && t.text.startsWith("'")) {
      const value = unquoteString(t.text);
      const ctx = contextOf(tokens, i);
      if (ctx.interval) continue;
      const compared = !!ctx.op;
      if (ISO_DATE.test(value) || ISO_DATETIME.test(value)) {
        out.push({
          start: t.start,
          end: t.end,
          text: t.text,
          kind: "date",
          value,
          name: dateName(ctx),
          type: ISO_DATE.test(value) ? "date" : "string",
          column: ctx.column,
          selected: true,
        });
      } else {
        out.push({ start: t.start, end: t.end, text: t.text, kind: "string", value, name: ctx.column ? snake(ctx.column) : "", type: "string", column: ctx.column, selected: compared });
      }
      continue;
    }

    if (t.kind === "num") {
      const ctx = contextOf(tokens, i);
      if (ctx.limit) {
        out.push({ start: t.start, end: t.end, text: t.text, kind: "number", value: Number(t.text), name: "limit", type: "number", selected: true });
      } else if (ctx.interval) {
        const unit = tokens[i + 1]?.text.toLowerCase().replace(/s$/, "");
        const name = unit && /^(day|week|month|year|hour|minute)$/.test(unit) ? `${unit}s` : "";
        out.push({ start: t.start, end: t.end, text: t.text, kind: "number", value: Number(t.text), name, type: "number", selected: !!name });
      } else if (ctx.op) {
        out.push({ start: t.start, end: t.end, text: t.text, kind: "number", value: Number(t.text), name: ctx.column ? snake(ctx.column) : "", type: "number", column: ctx.column, selected: true });
      }
    }
  }

  out.sort((a, b) => a.start - b.start);
  return nameAll(out).map((s) => ({ ...s, id: String(s.start) }));
}

/** Fills empty names with value_n and makes names unique (same name + same value share). */
function nameAll<T extends { name: string; value: unknown }>(items: T[]): T[] {
  const byName = new Map<string, unknown>();
  let n = 0;
  return items.map((s) => {
    let name = s.name || `value_${++n}`;
    const key = (v: unknown) => JSON.stringify(v);
    if (byName.has(name) && key(byName.get(name)) !== key(s.value)) {
      let i = 2;
      while (byName.has(`${name}_${i}`) && key(byName.get(`${name}_${i}`)) !== key(s.value)) i++;
      name = `${name}_${i}`;
    }
    if (!byName.has(name)) byName.set(name, s.value);
    return { ...s, name };
  });
}

export const VAR_NAME = /^[A-Za-z_]\w*$/;

/**
 * Rewrites the chosen literals: values become `{{ name | sql }}` (lists `{{ name | sql_list }}`),
 * dataset parts `{{ name }}`. Returns the template and one VarDef per name, defaulting to the
 * literal it replaced.
 */
export function applySuggestions(sql: string, chosen: Pick<LiteralSuggestion, "start" | "end" | "kind" | "value" | "name" | "type">[]): { sql: string; vars: VarDef[] } {
  const sorted = [...chosen].sort((a, b) => a.start - b.start);
  for (const s of sorted) if (!VAR_NAME.test(s.name)) throw new Error(`"${s.name}" isn't a valid variable name`);
  let out = "";
  let last = 0;
  const vars: VarDef[] = [];
  for (const s of sorted) {
    if (s.start < last) continue; // overlapping; keep the first
    const expr = s.kind === "dataset" ? `{{ ${s.name} }}` : s.kind === "list" ? `{{ ${s.name} | sql_list }}` : `{{ ${s.name} | sql }}`;
    out += sql.slice(last, s.start) + expr;
    last = s.end;
    if (!vars.some((v) => v.name === s.name)) vars.push({ name: s.name, type: s.type, value: s.value });
  }
  return { sql: out + sql.slice(last), vars };
}
