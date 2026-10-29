// A tiny SQL evaluator for the demo driver. Supports what the UI generates:
//   SELECT * | cols | count(*) [AS a] FROM t [WHERE expr] [GROUP BY cols] [ORDER BY …] [LIMIT n] [OFFSET n]
//   SUMMARIZE t   |   SELECT pg_sleep(n)
// WHERE: comparisons, AND/OR/NOT, parentheses, IS [NOT] NULL, [NOT] LIKE [ESCAPE], [NOT] IN, BETWEEN,
// CAST(x AS type), toString(x). Not a real database: demo data only.

import type { Cell } from "@core/types";

type Tok =
  | { t: "id"; v: string; quoted: boolean }
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "op"; v: string };

export function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "'") {
      let s = "";
      i++;
      for (;;) {
        if (i >= sql.length) throw new Error("Unterminated string literal");
        if (sql[i] === "\\" && sql[i + 1] !== undefined) {
          s += sql[i + 1];
          i += 2;
        } else if (sql[i] === "'" && sql[i + 1] === "'") {
          s += "'";
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else s += sql[i++];
      }
      out.push({ t: "str", v: s });
    } else if (c === '"' || c === "`") {
      let s = "";
      i++;
      while (i < sql.length) {
        if (sql[i] === c && sql[i + 1] === c) {
          s += c;
          i += 2;
        } else if (sql[i] === c) break;
        else s += sql[i++];
      }
      i++;
      out.push({ t: "id", v: s, quoted: true });
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      const m = /^\d*\.?\d+([eE][-+]?\d+)?/.exec(sql.slice(i))!;
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i))!;
      out.push({ t: "id", v: m[0], quoted: false });
      i += m[0].length;
    } else {
      const two = sql.slice(i, i + 2);
      if (["<>", "!=", "<=", ">=", "::"].includes(two)) {
        out.push({ t: "op", v: two });
        i += 2;
      } else if ("=<>(),.*;+-".includes(c)) {
        out.push({ t: "op", v: c });
        i++;
      } else throw new Error(`Unexpected character '${c}'`);
    }
  }
  return out;
}

export type Expr =
  | { k: "lit"; v: Cell }
  | { k: "col"; name: string }
  | { k: "bin"; op: string; l: Expr; r: Expr }
  | { k: "not"; e: Expr }
  | { k: "isnull"; e: Expr; neg: boolean }
  | { k: "like"; e: Expr; pat: Expr; esc?: string; neg: boolean }
  | { k: "in"; e: Expr; list: Expr[]; neg: boolean }
  | { k: "between"; e: Expr; lo: Expr; hi: Expr; neg: boolean }
  | { k: "text"; e: Expr }
  | { k: "count" };

export interface SelectItem {
  expr: Expr;
  alias: string;
}

export type Query =
  | {
      kind: "select";
      items: SelectItem[] | "*";
      from: string[];
      where?: Expr;
      groupBy?: string[];
      orderBy?: { col: string; desc: boolean }[];
      limit?: number;
      offset?: number;
    }
  | { kind: "summarize"; from: string[]; where?: Expr }
  | { kind: "sleep"; seconds: number };

class Parser {
  i = 0;
  constructor(private toks: Tok[]) {}
  peek(o = 0) {
    return this.toks[this.i + o];
  }
  kw(word: string, o = 0): boolean {
    const t = this.peek(o);
    return t?.t === "id" && !t.quoted && t.v.toLowerCase() === word;
  }
  eatKw(word: string): boolean {
    if (!this.kw(word)) return false;
    this.i++;
    return true;
  }
  needKw(word: string) {
    if (!this.eatKw(word)) throw new Error(`Expected ${word.toUpperCase()} near ${this.where()}`);
  }
  op(v: string) {
    const t = this.peek();
    return t?.t === "op" && t.v === v;
  }
  eatOp(v: string) {
    if (!this.op(v)) return false;
    this.i++;
    return true;
  }
  needOp(v: string) {
    if (!this.eatOp(v)) throw new Error(`Expected '${v}' near ${this.where()}`);
  }
  where() {
    const t = this.peek();
    return t ? `'${"v" in t ? t.v : ""}'` : "end of input";
  }
  ident(): string {
    const t = this.peek();
    if (t?.t !== "id") throw new Error(`Expected a name near ${this.where()}`);
    this.i++;
    return t.v;
  }
  dotted(): string[] {
    const parts = [this.ident()];
    while (this.eatOp(".")) parts.push(this.ident());
    return parts;
  }
  int(): number {
    const t = this.peek();
    if (t?.t !== "num") throw new Error(`Expected a number near ${this.where()}`);
    this.i++;
    return t.v;
  }

  query(): Query {
    if (this.eatKw("summarize")) {
      // SUMMARIZE t  |  SUMMARIZE SELECT * FROM t [WHERE …]
      if (this.eatKw("select")) {
        this.needOp("*");
        this.needKw("from");
        const from = this.dotted();
        const where = this.eatKw("where") ? this.expr() : undefined;
        return { kind: "summarize", from, where };
      }
      return { kind: "summarize", from: this.dotted() };
    }
    this.needKw("select");
    if (this.kw("pg_sleep") || this.kw("sleep")) {
      this.i++;
      this.needOp("(");
      const seconds = this.int();
      this.needOp(")");
      return { kind: "sleep", seconds };
    }
    let items: SelectItem[] | "*" = "*";
    if (!this.eatOp("*")) {
      items = [];
      do {
        const expr = this.expr();
        let alias = expr.k === "col" ? expr.name : expr.k === "count" ? "count" : `col${items.length + 1}`;
        if (this.eatKw("as")) alias = this.ident();
        items.push({ expr, alias });
      } while (this.eatOp(","));
    }
    this.needKw("from");
    const from = this.dotted();
    const q: Extract<Query, { kind: "select" }> = { kind: "select", items, from };
    if (this.eatKw("where")) q.where = this.expr();
    if (this.eatKw("group")) {
      this.needKw("by");
      q.groupBy = [];
      do q.groupBy.push(this.dotted().at(-1)!);
      while (this.eatOp(","));
    }
    if (this.eatKw("order")) {
      this.needKw("by");
      q.orderBy = [];
      do {
        const col = this.dotted().at(-1)!;
        let desc = false;
        if (this.eatKw("desc")) desc = true;
        else this.eatKw("asc");
        q.orderBy.push({ col, desc });
      } while (this.eatOp(","));
    }
    if (this.eatKw("limit")) q.limit = this.int();
    if (this.eatKw("offset")) q.offset = this.int();
    this.eatOp(";");
    if (this.peek()) throw new Error(`Unexpected ${this.where()}`);
    return q;
  }

  expr(): Expr {
    let l = this.and();
    while (this.eatKw("or")) l = { k: "bin", op: "or", l, r: this.and() };
    return l;
  }
  and(): Expr {
    let l = this.not();
    while (this.eatKw("and")) l = { k: "bin", op: "and", l, r: this.not() };
    return l;
  }
  not(): Expr {
    if (this.eatKw("not")) return { k: "not", e: this.not() };
    return this.pred();
  }
  pred(): Expr {
    const e = this.primary();
    const t = this.peek();
    if (t?.t === "op" && ["=", "<>", "!=", "<", ">", "<=", ">="].includes(t.v)) {
      this.i++;
      return { k: "bin", op: t.v === "!=" ? "<>" : t.v, l: e, r: this.primary() };
    }
    if (this.eatKw("is")) {
      const neg = this.eatKw("not");
      this.needKw("null");
      return { k: "isnull", e, neg };
    }
    const neg = this.eatKw("not");
    if (this.eatKw("like") || this.eatKw("ilike")) {
      const pat = this.primary();
      let esc: string | undefined;
      if (this.eatKw("escape")) {
        const s = this.primary();
        if (s.k !== "lit" || typeof s.v !== "string") throw new Error("ESCAPE needs a string");
        esc = s.v;
      }
      return { k: "like", e, pat, esc, neg };
    }
    if (this.eatKw("in")) {
      this.needOp("(");
      const list: Expr[] = [];
      do list.push(this.primary());
      while (this.eatOp(","));
      this.needOp(")");
      return { k: "in", e, list, neg };
    }
    if (this.eatKw("between")) {
      const lo = this.primary();
      this.needKw("and");
      return { k: "between", e, lo, hi: this.primary(), neg };
    }
    if (neg) throw new Error(`Unexpected NOT near ${this.where()}`);
    return e;
  }
  primary(): Expr {
    const t = this.peek();
    if (!t) throw new Error("Unexpected end of input");
    if (this.eatOp("(")) {
      const e = this.expr();
      this.needOp(")");
      return e;
    }
    if (this.eatOp("-")) {
      const n = this.int();
      return { k: "lit", v: -n };
    }
    if (t.t === "num") {
      this.i++;
      return { k: "lit", v: t.v };
    }
    if (t.t === "str") {
      this.i++;
      return { k: "lit", v: t.v };
    }
    if (t.t === "id" && !t.quoted) {
      const w = t.v.toLowerCase();
      if (w === "null") return this.i++, { k: "lit", v: null };
      if (w === "true") return this.i++, { k: "lit", v: true };
      if (w === "false") return this.i++, { k: "lit", v: false };
      if (w === "count" && this.peek(1)?.t === "op") {
        this.i++;
        this.needOp("(");
        this.needOp("*");
        this.needOp(")");
        return { k: "count" };
      }
      if (w === "cast") {
        this.i++;
        this.needOp("(");
        const e = this.expr();
        this.needKw("as");
        this.ident();
        this.needOp(")");
        return { k: "text", e };
      }
      if (w === "tostring") {
        this.i++;
        this.needOp("(");
        const e = this.expr();
        this.needOp(")");
        return { k: "text", e };
      }
    }
    if (t.t === "id") {
      const parts = this.dotted();
      let e: Expr = { k: "col", name: parts.at(-1)! };
      if (this.eatOp("::")) {
        this.ident();
        e = { k: "text", e };
      }
      return e;
    }
    throw new Error(`Unexpected ${this.where()}`);
  }
}

export function parse(sql: string): Query {
  return new Parser(tokenize(sql)).query();
}

type Row = Record<string, Cell>;

function num(v: Cell): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

export function compare(a: Cell, b: Cell): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const na = num(a);
  const nb = num(b);
  if (na !== null && nb !== null) return na - nb;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const sa = typeof a === "object" ? JSON.stringify(a) : String(a);
  const sb = typeof b === "object" ? JSON.stringify(b) : String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

const text = (v: Cell) => (v === null ? null : typeof v === "object" ? JSON.stringify(v) : String(v));

function likeToRegex(pat: string, esc?: string): RegExp {
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]!;
    if (esc && c === esc && i + 1 < pat.length) {
      re += pat[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (c === "%") re += ".*";
    else if (c === "_") re += ".";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "is");
}

export function evaluate(e: Expr, row: Row): Cell {
  switch (e.k) {
    case "lit":
      return e.v;
    case "col":
      if (!(e.name in row)) throw new Error(`column "${e.name}" does not exist`);
      return row[e.name] ?? null;
    case "text":
      return text(evaluate(e.e, row));
    case "count":
      throw new Error("count(*) is only allowed in the select list");
    case "not": {
      const v = evaluate(e.e, row);
      return v === null ? null : !v;
    }
    case "isnull":
      return (evaluate(e.e, row) === null) !== e.neg;
    case "like": {
      const v = text(evaluate(e.e, row));
      const p = text(evaluate(e.pat, row));
      if (v === null || p === null) return null;
      return likeToRegex(p, e.esc).test(v) !== e.neg;
    }
    case "in": {
      const v = evaluate(e.e, row);
      if (v === null) return null;
      return e.list.some((x) => compare(v, evaluate(x, row)) === 0) !== e.neg;
    }
    case "between": {
      const v = evaluate(e.e, row);
      if (v === null) return null;
      return (compare(v, evaluate(e.lo, row)) >= 0 && compare(v, evaluate(e.hi, row)) <= 0) !== e.neg;
    }
    case "bin": {
      if (e.op === "and") {
        const l = evaluate(e.l, row);
        if (l === false) return false;
        const r = evaluate(e.r, row);
        if (r === false) return false;
        return l === null || r === null ? null : true;
      }
      if (e.op === "or") {
        const l = evaluate(e.l, row);
        if (l === true) return true;
        const r = evaluate(e.r, row);
        if (r === true) return true;
        return l === null || r === null ? null : false;
      }
      const l = evaluate(e.l, row);
      const r = evaluate(e.r, row);
      if (l === null || r === null) return null;
      const c = compare(l, r);
      switch (e.op) {
        case "=":
          return c === 0;
        case "<>":
          return c !== 0;
        case "<":
          return c < 0;
        case ">":
          return c > 0;
        case "<=":
          return c <= 0;
        case ">=":
          return c >= 0;
      }
      throw new Error(`Unknown operator ${e.op}`);
    }
  }
}

export interface QueryResult {
  columns: string[];
  rows: Cell[][];
}

/** Runs a parsed SELECT over rows. Column types are the caller's business. */
export function runSelect(q: Extract<Query, { kind: "select" }>, rows: Row[], allColumns: string[]): QueryResult {
  let out = q.where ? rows.filter((r) => evaluate(q.where!, r) === true) : rows.slice();

  let columns: string[];
  let table: Row[];
  if (q.groupBy || (q.items !== "*" && q.items.some((i) => i.expr.k === "count"))) {
    const items = q.items === "*" ? [] : q.items;
    const keys = q.groupBy ?? [];
    const groups = new Map<string, { sample: Row; count: number }>();
    for (const r of out) {
      const k = JSON.stringify(keys.map((c) => r[c] ?? null));
      const g = groups.get(k);
      if (g) g.count++;
      else groups.set(k, { sample: r, count: 1 });
    }
    if (keys.length === 0 && groups.size === 0) groups.set("[]", { sample: {}, count: 0 });
    columns = items.map((i) => i.alias);
    table = [...groups.values()].map((g) => {
      const o: Row = {};
      for (const it of items) o[it.alias] = it.expr.k === "count" ? g.count : evaluate(it.expr, g.sample);
      return o;
    });
  } else if (q.items === "*") {
    columns = allColumns;
    table = out;
  } else {
    const items = q.items;
    columns = items.map((i) => i.alias);
    table = out.map((r) => {
      const o: Row = { ...r };
      for (const it of items) o[it.alias] = evaluate(it.expr, r);
      return o;
    });
  }

  if (q.orderBy) {
    const ob = q.orderBy;
    table.sort((a, b) => {
      for (const o of ob) {
        if (!(o.col in a)) throw new Error(`column "${o.col}" does not exist`);
        const c = compare(a[o.col] ?? null, b[o.col] ?? null);
        if (c !== 0) return o.desc ? -c : c;
      }
      return 0;
    });
  }
  const start = q.offset ?? 0;
  table = table.slice(start, q.limit !== undefined ? start + q.limit : undefined);
  out = table;
  return { columns, rows: out.map((r) => columns.map((c) => r[c] ?? null)) };
}
