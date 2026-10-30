// The small expression language of Set variables and Assert steps (DESIGN.md §3.15).
// Parsed and evaluated here, never with eval (MV3 forbids it, and these are user strings).
//
//   literals     1  2.5  "text"  'text'  true  false  null  [1, "a"]  {"k": 1}
//   variables    start_date            (chain variables)
//   members      inputs.sales.rowCount  vars.top_ids  x.length
//   functions    column("step", "col")  → array of the column's values
//                first("step", "col")   → first value (null when empty)
//                max/min/sum/avg("step", "col")
//                count("step")          → row count; count("step", "col") → non-NULL values
//                nulls("step", "col")   → NULL values in the column
//                distinct("step", "col")→ unique values, in first-seen order
//                len(x)                 → length of an array or string
//   operators    == != > >= < <=   && || !   and or not   + - * /   ( )

import type { Cell } from "@core/types";
import type { ResultTable } from "../collections/model";

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExprError";
  }
}

export interface ExprContext {
  /** Result table of a step, or undefined when it has none. */
  table(step: string): ResultTable | undefined;
  vars: Record<string, unknown>;
}

type Node =
  | { t: "lit"; v: unknown }
  | { t: "id"; name: string }
  | { t: "member"; obj: Node; prop: string }
  | { t: "call"; fn: string; args: Node[] }
  | { t: "arr"; items: Node[] }
  | { t: "obj"; entries: [string, Node][] }
  | { t: "un"; op: "!" | "-"; arg: Node }
  | { t: "bin"; op: string; l: Node; r: Node };

type Tok = { k: "num" | "str" | "id" | "op"; v: string; pos: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ k: "num", v: m[0], pos: start });
      i += m[0].length;
    } else if (c === '"' || c === "'") {
      let s = "";
      i++;
      for (;;) {
        if (i >= src.length) throw new ExprError(`Unterminated string starting at ${start + 1}`);
        const ch = src[i]!;
        if (ch === c) {
          i++;
          break;
        }
        if (ch === "\\") {
          const n = src[i + 1] ?? "";
          s += ({ n: "\n", t: "\t", r: "\r" } as Record<string, string>)[n] ?? n;
          i += 2;
        } else {
          s += ch;
          i++;
        }
      }
      out.push({ k: "str", v: s, pos: start });
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))!;
      out.push({ k: "id", v: m[0], pos: start });
      i += m[0].length;
    } else {
      const two = src.slice(i, i + 3) === "===" || src.slice(i, i + 3) === "!==" ? src.slice(i, i + 3) : src.slice(i, i + 2);
      if (["===", "!==", "==", "!=", ">=", "<=", "&&", "||"].includes(two)) {
        out.push({ k: "op", v: two.length === 3 ? two.slice(0, 2) : two, pos: start });
        i += two.length;
      } else if ("()[]{},.:<>!+-*/%".includes(c)) {
        out.push({ k: "op", v: c, pos: start });
        i++;
      } else throw new ExprError(`Unexpected "${c}" at ${start + 1}`);
    }
  }
  return out;
}

const PRECEDENCE: Record<string, number> = { "||": 1, or: 1, "&&": 2, and: 2, "==": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };

export function parseExpr(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.k === "op" && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(`Expected "${v}" ${where()}`);
    p++;
  };
  const where = () => (peek() ? `at ${peek()!.pos + 1}` : "at the end");

  const binOp = (): string | undefined => {
    const t = peek();
    if (!t) return undefined;
    if (t.k === "op" && t.v in PRECEDENCE) return t.v;
    if (t.k === "id" && (t.v === "and" || t.v === "or")) return t.v;
    return undefined;
  };

  const expr = (minPrec: number): Node => {
    let l = unary();
    for (;;) {
      const op = binOp();
      if (!op || PRECEDENCE[op]! < minPrec) return l;
      p++;
      const r = expr(PRECEDENCE[op]! + 1);
      l = { t: "bin", op: op === "and" ? "&&" : op === "or" ? "||" : op, l, r };
    }
  };

  const unary = (): Node => {
    if (isOp("!") || (peek()?.k === "id" && peek()!.v === "not")) {
      p++;
      return { t: "un", op: "!", arg: unary() };
    }
    if (isOp("-")) {
      p++;
      return { t: "un", op: "-", arg: unary() };
    }
    return postfix(primary());
  };

  const postfix = (n: Node): Node => {
    for (;;) {
      if (isOp(".")) {
        p++;
        const t = peek();
        if (t?.k !== "id") throw new ExprError(`Expected a property name ${where()}`);
        p++;
        n = { t: "member", obj: n, prop: t.v };
      } else if (isOp("[")) {
        p++;
        const t = peek();
        if (t?.k !== "str" && t?.k !== "num") throw new ExprError(`Expected a quoted name or number in [] ${where()}`);
        p++;
        expect("]");
        n = { t: "member", obj: n, prop: t.v };
      } else return n;
    }
  };

  const list = (close: string): Node[] => {
    const items: Node[] = [];
    if (isOp(close)) {
      p++;
      return items;
    }
    for (;;) {
      items.push(expr(1));
      if (isOp(",")) {
        p++;
        continue;
      }
      expect(close);
      return items;
    }
  };

  const primary = (): Node => {
    const t = peek();
    if (!t) throw new ExprError("Expression is incomplete");
    p++;
    if (t.k === "num") return { t: "lit", v: Number(t.v) };
    if (t.k === "str") return { t: "lit", v: t.v };
    if (t.k === "id") {
      if (t.v === "true" || t.v === "false") return { t: "lit", v: t.v === "true" };
      if (t.v === "null") return { t: "lit", v: null };
      if (isOp("(")) {
        p++;
        return { t: "call", fn: t.v, args: list(")") };
      }
      return { t: "id", name: t.v };
    }
    if (t.v === "(") {
      const e = expr(1);
      expect(")");
      return e;
    }
    if (t.v === "[") return { t: "arr", items: list("]") };
    if (t.v === "{") {
      const entries: [string, Node][] = [];
      if (isOp("}")) {
        p++;
        return { t: "obj", entries };
      }
      for (;;) {
        const k = peek();
        if (k?.k !== "str" && k?.k !== "id") throw new ExprError(`Expected an object key ${where()}`);
        p++;
        expect(":");
        entries.push([k.v, expr(1)]);
        if (isOp(",")) {
          p++;
          continue;
        }
        expect("}");
        return { t: "obj", entries };
      }
    }
    throw new ExprError(`Unexpected "${t.v}" at ${t.pos + 1}`);
  };

  if (!toks.length) throw new ExprError("Expression is empty");
  const n = expr(1);
  if (p < toks.length) throw new ExprError(`Unexpected "${toks[p]!.v}" at ${toks[p]!.pos + 1}`);
  return n;
}

/** Parses and evaluates `src`. */
export function evaluate(src: string, ctx: ExprContext): unknown {
  return evalNode(parseExpr(src), ctx);
}

/** Variable names an expression reads (bare identifiers and vars.x), for cache keys. */
export function exprVariables(src: string): string[] {
  const out = new Set<string>();
  const visit = (n: Node) => {
    switch (n.t) {
      case "id":
        if (n.name !== "inputs" && n.name !== "vars") out.add(n.name);
        break;
      case "member":
        if (n.obj.t === "id" && n.obj.name === "vars") out.add(n.prop);
        else visit(n.obj);
        break;
      case "call":
        n.args.forEach(visit);
        break;
      case "arr":
        n.items.forEach(visit);
        break;
      case "obj":
        n.entries.forEach(([, v]) => visit(v));
        break;
      case "un":
        visit(n.arg);
        break;
      case "bin":
        visit(n.l);
        visit(n.r);
        break;
    }
  };
  try {
    visit(parseExpr(src));
  } catch {
    /* reported when evaluated */
  }
  return [...out];
}

function evalNode(n: Node, ctx: ExprContext): unknown {
  switch (n.t) {
    case "lit":
      return n.v;
    case "arr":
      return n.items.map((i) => evalNode(i, ctx));
    case "obj":
      return Object.fromEntries(n.entries.map(([k, v]) => [k, evalNode(v, ctx)]));
    case "id":
      if (n.name === "inputs") return inputsObject(ctx);
      if (n.name === "vars") return ctx.vars;
      if (!(n.name in ctx.vars)) throw new ExprError(`Unknown variable "${n.name}"`);
      return ctx.vars[n.name];
    case "member": {
      const obj = evalNode(n.obj, ctx);
      if (obj === null || obj === undefined) throw new ExprError(`Can't read "${n.prop}" of ${obj === null ? "null" : "undefined"}`);
      if (typeof obj === "string" && n.prop === "length") return obj.length;
      if (typeof obj !== "object") return undefined;
      return Object.prototype.hasOwnProperty.call(obj, n.prop) || (Array.isArray(obj) && n.prop === "length") ? (obj as Record<string, unknown>)[n.prop] : undefined;
    }
    case "un": {
      const v = evalNode(n.arg, ctx);
      return n.op === "!" ? !truthy(v) : -num(v, "-");
    }
    case "bin": {
      if (n.op === "&&") return truthy(evalNode(n.l, ctx)) && truthy(evalNode(n.r, ctx));
      if (n.op === "||") return truthy(evalNode(n.l, ctx)) || truthy(evalNode(n.r, ctx));
      const l = evalNode(n.l, ctx);
      const r = evalNode(n.r, ctx);
      switch (n.op) {
        case "==":
          return looseEqual(l, r);
        case "!=":
          return !looseEqual(l, r);
        case "<":
          return compare(l, r) < 0;
        case "<=":
          return compare(l, r) <= 0;
        case ">":
          return compare(l, r) > 0;
        case ">=":
          return compare(l, r) >= 0;
        case "+":
          return typeof l === "string" || typeof r === "string" ? String(l) + String(r) : num(l, "+") + num(r, "+");
        case "-":
          return num(l, "-") - num(r, "-");
        case "*":
          return num(l, "*") * num(r, "*");
        case "/":
          return num(l, "/") / num(r, "/");
        case "%":
          return num(l, "%") % num(r, "%");
      }
      throw new ExprError(`Unknown operator ${n.op}`);
    }
    case "call":
      return callFn(n.fn, n.args.map((a) => evalNode(a, ctx)), ctx);
  }
}

/** `inputs.step` → { rowCount, columns, rows } for steps that have tables. */
function inputsObject(ctx: ExprContext): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string") return undefined;
        const t = ctx.table(prop);
        if (!t) throw new ExprError(`Step "${prop}" has no result table`);
        return { rowCount: t.rows.length, columns: t.columns.map((c) => c.name), rows: t.rows };
      },
      has: (_t, prop) => typeof prop === "string" && !!ctx.table(prop),
      getOwnPropertyDescriptor: (_t, prop) => (typeof prop === "string" && ctx.table(prop) ? { configurable: true, enumerable: true, value: undefined } : undefined),
    },
  );
}

function callFn(fn: string, args: unknown[], ctx: ExprContext): unknown {
  const table = (): ResultTable => {
    const name = args[0];
    if (typeof name !== "string") throw new ExprError(`${fn}() needs a step name as its first argument`);
    const t = ctx.table(name);
    if (!t) throw new ExprError(`Step "${name}" has no result table`);
    return t;
  };
  const values = (): Cell[] => {
    const t = table();
    const col = args[1];
    if (typeof col !== "string") throw new ExprError(`${fn}() needs a column name as its second argument`);
    const i = t.columns.findIndex((c) => c.name === col);
    if (i < 0) throw new ExprError(`Step "${String(args[0])}" has no column "${col}" (columns: ${t.columns.map((c) => c.name).join(", ")})`);
    return t.rows.map((r) => r[i] ?? null);
  };
  switch (fn) {
    case "column":
      return values();
    case "distinct": {
      const seen = new Set<string>();
      return values().filter((v) => {
        const k = JSON.stringify(v);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    case "first":
      return values()[0] ?? null;
    case "count":
      return args.length > 1 ? values().filter((v) => v !== null).length : table().rows.length;
    case "nulls":
      return values().filter((v) => v === null).length;
    case "max":
    case "min": {
      const vs = values().filter((v) => v !== null);
      if (!vs.length) return null;
      return vs.reduce((a, b) => (compare(b, a) * (fn === "max" ? 1 : -1) > 0 ? b : a));
    }
    case "sum":
    case "avg": {
      const vs = values().filter((v) => v !== null).map((v) => num(v, fn));
      if (!vs.length) return fn === "sum" ? 0 : null;
      const s = vs.reduce((a, b) => a + b, 0);
      return fn === "sum" ? s : s / vs.length;
    }
    case "len": {
      const v = args[0];
      if (typeof v === "string" || Array.isArray(v)) return v.length;
      throw new ExprError("len() needs an array or a string");
    }
  }
  throw new ExprError(`Unknown function ${fn}()`);
}

function truthy(v: unknown): boolean {
  return Array.isArray(v) ? v.length > 0 : !!v;
}

/** Numbers that arrive as strings (BIGINT, DECIMAL) compare as numbers. */
function num(v: unknown, op: string): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  throw new ExprError(`"${op}" needs numbers, got ${JSON.stringify(v)}`);
}

const numeric = (v: unknown) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));

function compare(a: unknown, b: unknown): number {
  if (numeric(a) && numeric(b) && (typeof a === "number" || typeof b === "number" || /^-?\d+(\.\d+)?$/.test(String(a)))) {
    return Number(a) - Number(b);
  }
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (a === null || b === null) throw new ExprError("Can't compare with null");
  return num(a, "<") - num(b, "<");
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a == b;
  if (numeric(a) && numeric(b)) return Number(a) === Number(b);
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}
