// SQL autocompletion for the editors, TablePlus-style: keywords, functions, schemas and tables
// as you type a word; after `schema.` the tables in that schema; after `table.` (or an alias
// from FROM/JOIN) its columns. Pure: names come from a CompletionSource the caller builds over
// the driver's object tree (connectionSource) or a fixed list (file sheets).

import type { Driver, ObjectNode, ObjectPath, ObjectType } from "@core/types";
import { FUNCTIONS, KEYWORDS } from "./sqlFormat";

export type CompletionKind = "keyword" | "function" | "schema" | "table" | "view" | "column";

export interface Completion {
  label: string;
  kind: CompletionKind;
  /** Text inserted in place of the word being typed (quoted when the name needs it). */
  insert: string;
  /** Short grey hint: a column's type, a table's schema. */
  detail?: string;
}

export interface CompletionSource {
  /** Containers at the top of the tree (schemas, datasets, databases). */
  schemas(): Promise<string[]>;
  /** Tables and views in a schema; with no schema, the default ones (every table when there's no schema level). */
  tables(schema?: string): Promise<{ name: string; kind: "table" | "view"; schema?: string }[]>;
  /** Columns of a table, given as the user wrote it (`orders` or `public.orders`). */
  columns(table: string[]): Promise<{ name: string; type: string }[]>;
}

export interface CompletionContext {
  /** Where the replaced word starts and ends (the cursor). */
  from: number;
  to: number;
  /** The partial word typed so far, unquoted. */
  prefix: string;
  /** Qualifier parts before the last dot, unquoted: `public.ord|` → ["public"]. Empty for a bare word. */
  qualifier: string[];
}

const IDENT = /[A-Za-z0-9_$]/;

/** Reads the dotted name ending at the cursor: `"my schema".ord|` → qualifier ["my schema"], prefix "ord". */
export function contextAt(sql: string, cursor: number): CompletionContext | null {
  if (insideStringOrComment(sql, cursor)) return null;
  const parts: string[] = [];
  let i = cursor;
  let from = cursor;
  let first = true;
  for (;;) {
    let part: string;
    if (sql[i - 1] === '"' || sql[i - 1] === "`") {
      const q = sql[i - 1]!;
      const open = sql.lastIndexOf(q, i - 2);
      if (open < 0) return null;
      part = sql.slice(open + 1, i - 1);
      i = open;
    } else {
      let j = i;
      while (j > 0 && IDENT.test(sql[j - 1]!)) j--;
      part = sql.slice(j, i);
      i = j;
    }
    if (first) {
      from = i;
      first = false;
    }
    parts.unshift(part);
    if (sql[i - 1] !== ".") break;
    i -= 1;
  }
  const prefix = parts.pop() ?? "";
  // A bare word must start with a letter or _ (not "12" or "3.5").
  if (parts.length === 0 && prefix && !/^[A-Za-z_]/.test(prefix)) return null;
  if (parts.some((p) => p === "" || /^\d/.test(p))) return null;
  return { from, to: cursor, prefix, qualifier: parts };
}

function insideStringOrComment(sql: string, cursor: number): boolean {
  let i = 0;
  while (i < cursor) {
    const c = sql[i]!;
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      if (nl < 0 || nl >= cursor) return true;
      i = nl + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0 || end + 2 > cursor) return true;
      i = end + 2;
    } else if (c === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      if (j >= cursor) return true;
      i = j + 1;
    } else i++;
  }
  return false;
}

/** Aliases from FROM/JOIN: `FROM public.orders o JOIN customers AS c` → { o: ["public","orders"], c: ["customers"] }. */
export function tableAliases(sql: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const name = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|[A-Za-z_][A-Za-z0-9_$]*)`;
  const re = new RegExp(String.raw`\b(?:from|join)\s+(${name}(?:\s*\.\s*${name})*)(?:\s+(?:as\s+)?(${name}))?`, "gi");
  const unquote = (s: string) => s.trim().replace(/^["\x60]|["\x60]$/g, "");
  const reserved = /^(on|using|where|join|left|right|inner|outer|full|cross|natural|group|order|limit|union|having|window|qualify|lateral|as)$/i;
  for (const m of sql.matchAll(re)) {
    const parts = m[1]!.split(/\s*\.\s*/).map(unquote);
    const table = parts.at(-1)!;
    out.set(table.toLowerCase(), parts);
    const alias = m[2] ? unquote(m[2]) : null;
    if (alias && !reserved.test(alias)) out.set(alias.toLowerCase(), parts);
  }
  return out;
}

const needsQuote = (s: string) => !/^[a-z_][a-z0-9_$]*$/.test(s) || KEYWORDS.has(s);

/** Quotes a name for insertion when it isn't a plain lower-case identifier. */
export function quoteName(name: string, quote: (s: string) => string): string {
  return needsQuote(name) ? quote(name) : name;
}

const rank = (label: string, prefix: string) => {
  const l = label.toLowerCase();
  const p = prefix.toLowerCase();
  if (!p) return 1;
  if (l === p) return 0;
  if (l.startsWith(p)) return 1;
  if (l.split(/[_.]/).some((w) => w.startsWith(p))) return 2;
  return l.includes(p) ? 3 : -1;
};

const KIND_ORDER: Record<CompletionKind, number> = { column: 0, table: 1, view: 1, schema: 2, function: 3, keyword: 4 };

function filterSort(items: Completion[], prefix: string, limit: number): Completion[] {
  return items
    .map((c) => ({ c, r: rank(c.label, prefix) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || KIND_ORDER[a.c.kind] - KIND_ORDER[b.c.kind] || a.c.label.localeCompare(b.c.label))
    .slice(0, limit)
    .map((x) => x.c);
}

/** Suggestions at the cursor, best first. Empty when the cursor isn't on a name. */
export async function complete(sql: string, cursor: number, source: CompletionSource, quote: (s: string) => string, limit = 60): Promise<{ ctx: CompletionContext; items: Completion[] } | null> {
  const ctx = contextAt(sql, cursor);
  if (!ctx) return null;
  const q = (s: string) => quoteName(s, quote);

  if (ctx.qualifier.length > 0) {
    const items: Completion[] = [];
    const head = ctx.qualifier;
    // table. or alias. → columns
    const alias = head.length === 1 ? tableAliases(sql).get(head[0]!.toLowerCase()) : undefined;
    const tablePath = alias ?? head;
    const cols = await source.columns(tablePath).catch(() => []);
    for (const c of cols) items.push({ label: c.name, kind: "column", insert: q(c.name), detail: c.type });
    // schema. → tables
    if (head.length === 1) {
      const schemas = await source.schemas().catch(() => []);
      const schema = schemas.find((s) => s.toLowerCase() === head[0]!.toLowerCase());
      if (schema !== undefined) {
        for (const t of await source.tables(schema).catch(() => [])) items.push({ label: t.name, kind: t.kind, insert: q(t.name), detail: schema });
      }
    }
    return { ctx, items: filterSort(items, ctx.prefix, limit) };
  }

  if (!ctx.prefix) return null;
  const items: Completion[] = [];
  const [schemas, tables] = await Promise.all([source.schemas().catch(() => []), source.tables().catch(() => [])]);
  for (const t of tables) items.push({ label: t.name, kind: t.kind, insert: q(t.name), detail: t.schema });
  for (const s of schemas) items.push({ label: s, kind: "schema", insert: q(s) });
  // Columns of the tables already named in FROM/JOIN.
  const seen = new Set<string>();
  for (const parts of new Set(tableAliases(sql).values())) {
    for (const c of await source.columns(parts).catch(() => [])) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      items.push({ label: c.name, kind: "column", insert: q(c.name), detail: c.type });
    }
  }
  for (const k of KEYWORDS) items.push({ label: k.toUpperCase(), kind: "keyword", insert: k.toUpperCase() });
  for (const f of FUNCTIONS) items.push({ label: f, kind: "function", insert: f });
  return { ctx, items: filterSort(items, ctx.prefix, limit) };
}

const CONTAINER: ObjectType[] = ["database", "schema", "dataset"];
const TABLES: ObjectType[] = ["table", "view", "materialized_view", "dictionary"];

/**
 * A CompletionSource over a driver's object tree. Grouping nodes ("Tables", "Views") are walked
 * through and left out of names. Lists and column lists are cached for the editor's lifetime.
 */
export function connectionSource(driver: Pick<Driver, "listObjects" | "describe">): CompletionSource {
  const lists = new Map<string, Promise<ObjectNode[]>>();
  const list = (p: ObjectPath) => {
    const k = JSON.stringify(p);
    let v = lists.get(k);
    if (!v) {
      v = driver.listObjects(p).catch(() => []);
      lists.set(k, v);
    }
    return v;
  };
  // Tables under a node, through group nodes (at most two levels).
  const tablesUnder = async (p: ObjectPath, depth = 0): Promise<{ node: ObjectNode }[]> => {
    const out: { node: ObjectNode }[] = [];
    for (const n of await list(p)) {
      if (TABLES.includes(n.type)) out.push({ node: n });
      else if (n.type === "group" && n.hasChildren && depth < 2) out.push(...(await tablesUnder(n.path, depth + 1)));
    }
    return out;
  };
  const roots = () => list([]);
  const schemaNodes = async () => (await roots()).filter((n) => CONTAINER.includes(n.type));
  const toTable = (n: ObjectNode, schema?: string) => ({ name: n.name, kind: (/view/.test(n.type) ? "view" : "table") as "table" | "view", schema });

  const findTable = async (parts: string[]) => {
    const lower = parts.map((p) => p.toLowerCase());
    const name = lower.at(-1)!;
    const schemas = await schemaNodes();
    const candidates = lower.length > 1 ? schemas.filter((s) => s.name.toLowerCase() === lower.at(-2)) : schemas;
    for (const s of candidates) {
      const hit = (await tablesUnder(s.path)).find((t) => t.node.name.toLowerCase() === name);
      if (hit) return hit.node;
    }
    return (await tablesUnder([])).find((t) => t.node.name.toLowerCase() === name)?.node;
  };

  return {
    async schemas() {
      return (await schemaNodes()).map((n) => n.name);
    },
    async tables(schema) {
      if (schema !== undefined) {
        const s = (await schemaNodes()).find((n) => n.name === schema);
        return s ? (await tablesUnder(s.path)).map((t) => toTable(t.node, schema)) : [];
      }
      const top = (await tablesUnder([])).map((t) => toTable(t.node));
      // With schemas, offer the tables of the first few (Postgres: public first).
      const schemas = await schemaNodes();
      const ordered = [...schemas].sort((a, b) => (a.name === "public" ? -1 : b.name === "public" ? 1 : 0)).slice(0, 4);
      for (const s of ordered) for (const t of await tablesUnder(s.path)) top.push(toTable(t.node, s.name));
      return top;
    },
    async columns(parts) {
      const node = await findTable(parts);
      if (!node) return [];
      const schema = await driver.describe(node.path);
      return schema.columns.map((c) => ({ name: c.name, type: c.type }));
    },
  };
}
