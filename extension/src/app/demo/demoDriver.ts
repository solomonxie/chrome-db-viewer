// In-memory Driver over generated sample data, so the UI works without real drivers.
// The UI labels every demo connection "Demo data" and never presents it as a real database.
// Tree: public → tables/views/functions → orders, customers, order_items.

import type {
  ApplyResult, Capabilities, Cell, ChangeSet, Column, ConnectionConfig, Driver, ExecuteSummary,
  ObjectNode, ObjectPath, ResultPage, Statement, TableSchema,
} from "@core/types";
import { DriverError } from "@core/types";
import { postgresDialect, previewChangeSet } from "@core/sql";
import { compare, evaluate, parse, runSelect } from "./miniSql";

type Row = Record<string, Cell>;

interface DemoTable {
  name: string;
  columns: Column[];
  rows: Row[];
  indexes: TableSchema["indexes"];
  view?: boolean;
}

export const DEMO_CONNECTION_ID = "demo";

export const DEMO_CONNECTION: ConnectionConfig = {
  id: DEMO_CONNECTION_ID,
  name: "Demo database",
  driver: "postgres",
  env: "local",
  readOnly: false,
  options: { demo: true, host: "in-memory", database: "demo_shop" },
};

export const isDemo = (cfg: ConnectionConfig | undefined) => cfg?.options.demo === true;

/** Deterministic PRNG so tests and screenshots see the same data. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Ada", "Grace", "Linus", "Margaret", "Ken", "Barbara", "Dennis", "Frances", "Edsger", "Radia", "Alan", "Hedy", "Donald", "Katherine", "Guido", "Sophie"];
const LAST = ["Lovelace", "Hopper", "Torvalds", "Hamilton", "Thompson", "Liskov", "Ritchie", "Allen", "Dijkstra", "Perlman", "Turing", "Lamarr", "Knuth", "Johnson", "Rossum", "Wilson"];
const COUNTRIES = ["US", "DE", "FR", "GB", "JP", "BR", "IN", "CA", "AU", "NL"];
const STATUSES = ["paid", "pending", "refunded", "shipped", "cancelled"];
const SOURCES = ["web", "ios", "android", "pos"];
const PRODUCTS = ["Keyboard", "Mouse", "Monitor", "Cable", "Dock", "Webcam", "Headset", "Chair", "Desk lamp", "Notebook"];

export function buildDemoData(): Map<string, DemoTable> {
  const r = rng(42);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const base = Date.UTC(2026, 0, 1);
  const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "+00");

  const customers: Row[] = [];
  for (let i = 0; i < 120; i++) {
    const first = pick(FIRST);
    const last = pick(LAST);
    customers.push({
      id: String(4800 + i),
      name: `${first} ${last}`,
      email: r() < 0.06 ? null : `${first}.${last}${i}@example.com`.toLowerCase(),
      country: pick(COUNTRIES),
      tier: pick(["free", "pro", "team"]),
      active: r() < 0.85,
      created_at: iso(base - Math.floor(r() * 400 * 86400000)),
    });
  }

  const orders: Row[] = [];
  const items: Row[] = [];
  let itemId = 1;
  for (let i = 0; i < 640; i++) {
    const id = String(10400 + i);
    const status = pick(STATUSES);
    const n = 1 + Math.floor(r() * 4);
    let total = 0;
    for (let k = 0; k < n; k++) {
      const price = Math.round((5 + r() * 240) * 100) / 100;
      const qty = 1 + Math.floor(r() * 3);
      total += price * qty;
      items.push({ id: itemId++, order_id: id, product: pick(PRODUCTS), qty, price: price.toFixed(2) });
    }
    orders.push({
      id,
      customer_id: pick(customers).id ?? null,
      status,
      total: total.toFixed(2),
      paid: status === "paid" || status === "shipped",
      metadata: { source: pick(SOURCES), coupon: r() < 0.2 ? pick(["SPRING10", "VIP", "WELCOME"]) : null, items: n },
      note: r() < 0.7 ? null : pick(["gift wrap", "leave at door", "call before delivery", "fragile"]),
      created_at: iso(base + Math.floor(r() * 300 * 86400000)),
    });
  }

  const tables = new Map<string, DemoTable>();
  tables.set("customers", {
    name: "customers",
    rows: customers,
    columns: [
      { name: "id", type: "int8", nullable: false, primaryKey: true },
      { name: "name", type: "text", nullable: false },
      { name: "email", type: "text", nullable: true },
      { name: "country", type: "varchar(2)", nullable: false },
      { name: "tier", type: "customer_tier", nullable: false, enumValues: ["free", "pro", "team"], default: "'free'" },
      { name: "active", type: "bool", nullable: false, default: "true" },
      { name: "created_at", type: "timestamptz", nullable: false, default: "now()" },
    ],
    indexes: [
      { name: "customers_pkey", columns: ["id"], unique: true, primary: true },
      { name: "customers_email_key", columns: ["email"], unique: true, primary: false },
    ],
  });
  tables.set("orders", {
    name: "orders",
    rows: orders,
    columns: [
      { name: "id", type: "int8", nullable: false, primaryKey: true },
      { name: "customer_id", type: "int8", nullable: false, references: "customers.id" },
      { name: "status", type: "order_status", nullable: false, enumValues: STATUSES },
      { name: "total", type: "numeric(10,2)", nullable: false },
      { name: "paid", type: "bool", nullable: false, default: "false" },
      { name: "metadata", type: "jsonb", nullable: true },
      { name: "note", type: "text", nullable: true },
      { name: "created_at", type: "timestamptz", nullable: false, default: "now()" },
    ],
    indexes: [
      { name: "orders_pkey", columns: ["id"], unique: true, primary: true },
      { name: "orders_customer_id_idx", columns: ["customer_id"], unique: false, primary: false },
      { name: "orders_status_created_idx", columns: ["status", "created_at"], unique: false, primary: false },
    ],
  });
  tables.set("order_items", {
    name: "order_items",
    rows: items,
    columns: [
      { name: "id", type: "int4", nullable: false, primaryKey: true },
      { name: "order_id", type: "int8", nullable: false, references: "orders.id" },
      { name: "product", type: "text", nullable: false },
      { name: "qty", type: "int4", nullable: false },
      { name: "price", type: "numeric(10,2)", nullable: false },
    ],
    indexes: [{ name: "order_items_pkey", columns: ["id"], unique: true, primary: true }],
  });
  tables.set("paid_orders", {
    name: "paid_orders",
    view: true,
    get rows() {
      return tables.get("orders")!.rows.filter((o) => o.paid === true);
    },
    columns: tables.get("orders")!.columns.map((c) => ({ ...c, primaryKey: false })),
    indexes: [],
  });
  return tables;
}

function ddlFor(t: DemoTable): string {
  if (t.view) return `CREATE VIEW public.${t.name} AS\n  SELECT * FROM public.orders WHERE paid;`;
  const cols = t.columns.map((c) => {
    let s = `  ${c.name} ${c.type}`;
    if (!c.nullable) s += " NOT NULL";
    if (c.default) s += ` DEFAULT ${c.default}`;
    if (c.primaryKey) s += " PRIMARY KEY";
    if (c.references) s += ` REFERENCES ${c.references.replace(".", "(")})`;
    return s;
  });
  return `CREATE TABLE public.${t.name} (\n${cols.join(",\n")}\n);`;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DriverError("Query cancelled", "cancelled"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DriverError("Query cancelled", "cancelled"));
    }, { once: true });
  });

export interface DemoDriverOptions {
  /** Simulated latency per call, ms. */
  latency?: number;
}

export class DemoDriver implements Driver {
  readonly id = "postgres" as const;
  readonly dialect = postgresDialect;
  private tables = buildDemoData();
  private connected = false;
  /** In file mode the tree shows one file node, like the file driver. */
  private fileName: string | null = null;
  private latency: number;

  constructor(opts: DemoDriverOptions = {}) {
    this.latency = opts.latency ?? 60;
  }

  capabilities(): Capabilities {
    return { kind: this.fileName ? "file" : "relational", transactions: true, editableRows: true, costEstimate: false, cancel: true };
  }

  async connect(cfg: ConnectionConfig, signal?: AbortSignal) {
    await sleep(this.latency, signal);
    if (typeof cfg.options.demoFile === "string") {
      this.fileName = cfg.options.demoFile;
      const orders = this.tables.get("orders")!;
      this.tables.set(this.fileName, { ...orders, name: this.fileName, indexes: [] });
    }
    this.connected = true;
    return { serverVersion: "Demo 1.0 (in-memory sample data)" };
  }

  async disconnect() {
    this.connected = false;
  }

  private ensure() {
    if (!this.connected) throw new DriverError("Not connected");
  }

  private table(path: ObjectPath | string[]): DemoTable {
    const name = path.at(-1) ?? "";
    const t = this.tables.get(name);
    if (!t) throw new DriverError(`relation "${path.join(".")}" does not exist`, "42P01");
    return t;
  }

  async listObjects(parent: ObjectPath, signal?: AbortSignal): Promise<ObjectNode[]> {
    this.ensure();
    await sleep(this.latency / 2, signal);
    if (this.fileName) {
      return parent.length === 0
        ? [{ path: [this.fileName], name: this.fileName, type: "table", hasChildren: false, meta: `${this.table([this.fileName]).rows.length} rows` }]
        : [];
    }
    if (parent.length === 0) return [{ path: ["public"], name: "public", type: "schema", hasChildren: true }];
    if (parent.length === 1) {
      return [
        { path: ["public", "functions"], name: "Functions", type: "group", hasChildren: false },
        { path: ["public", "tables"], name: "Tables", type: "group", hasChildren: true },
        { path: ["public", "views"], name: "Views", type: "group", hasChildren: true },
      ];
    }
    if (parent.length === 2) {
      const views = parent[1] === "views";
      return [...this.tables.values()]
        .filter((t) => !!t.view === views && t.name !== this.fileName)
        .map((t) => ({
          path: [...parent, t.name],
          name: t.name,
          type: views ? "view" : "table",
          hasChildren: false,
          meta: views ? undefined : String(t.rows.length),
        }));
    }
    return [];
  }

  async describe(path: ObjectPath, signal?: AbortSignal): Promise<TableSchema> {
    this.ensure();
    await sleep(this.latency / 2, signal);
    const t = this.table(path);
    return {
      path,
      columns: t.columns,
      indexes: t.indexes,
      ddl: ddlFor(t),
      info: { Rows: String(t.rows.length), Kind: t.view ? "view" : "table", Source: "demo data (in memory)" },
    };
  }

  async *execute(stmt: Statement, signal?: AbortSignal): AsyncGenerator<ResultPage, ExecuteSummary, void> {
    this.ensure();
    const started = performance.now();
    await sleep(this.latency, signal);
    const sql = stmt.sql.trim();
    if (/^(insert|update|delete|create|drop|alter|truncate)\b/i.test(sql)) {
      throw new DriverError("The demo database only runs SELECT in the editor. Edit rows in the grid and press ⌘S instead.", "demo_readonly");
    }
    let q;
    try {
      q = parse(sql);
    } catch (e) {
      throw new DriverError(`syntax error: ${(e as Error).message}`, "42601");
    }

    if (q.kind === "sleep") {
      await sleep(q.seconds * 1000, signal);
      yield { columns: [{ name: "pg_sleep", type: "void", nullable: true }], rows: [[null]], seq: 0 };
      return { rowCount: 1, ms: performance.now() - started };
    }

    const t = this.table(q.from);
    let columns: Column[];
    let rows: Cell[][];
    if (q.kind === "summarize") {
      columns = [
        { name: "column_name", type: "VARCHAR", nullable: false },
        { name: "column_type", type: "VARCHAR", nullable: false },
        { name: "min", type: "VARCHAR", nullable: true },
        { name: "max", type: "VARCHAR", nullable: true },
        { name: "approx_unique", type: "BIGINT", nullable: false },
        { name: "avg", type: "DOUBLE", nullable: true },
        { name: "count", type: "BIGINT", nullable: false },
        { name: "null_percentage", type: "DOUBLE", nullable: false },
      ];
      const where = q.where;
      const source = where ? t.rows.filter((r) => evaluate(where, r) === true) : t.rows;
      rows = t.columns.map((c) => {
        const vals = source.map((r) => r[c.name] ?? null);
        const nonNull = vals.filter((v) => v !== null);
        const sorted = nonNull.slice().sort(compare);
        const nums = nonNull.map((v) => Number(v)).filter((n) => typeof nonNull[0] !== "object" && typeof nonNull[0] !== "boolean" && Number.isFinite(n));
        const asText = (v: Cell | undefined) => (v === undefined || v === null ? null : typeof v === "object" ? JSON.stringify(v) : String(v));
        return [
          c.name,
          c.type,
          asText(sorted[0]),
          asText(sorted.at(-1)),
          new Set(nonNull.map((v) => JSON.stringify(v))).size,
          nums.length === nonNull.length && nums.length > 0 ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null,
          vals.length,
          Math.round(((vals.length - nonNull.length) / Math.max(1, vals.length)) * 10000) / 100,
        ];
      });
    } else {
      const res = runSelect(q, t.rows, t.columns.map((c) => c.name));
      columns = res.columns.map(
        (name) => t.columns.find((c) => c.name === name) ?? { name, type: name === "count" ? "int8" : "text", nullable: true },
      );
      rows = res.rows;
    }

    const size = stmt.pageSize ?? 200;
    let seq = 0;
    if (rows.length === 0) yield { columns, rows: [], seq: seq++ };
    for (let i = 0; i < rows.length; i += size) {
      if (signal?.aborted) throw new DriverError("Query cancelled", "cancelled");
      yield { ...(seq === 0 ? { columns } : {}), rows: rows.slice(i, i + size), seq: seq++ };
      if (i + size < rows.length) await sleep(5, signal);
    }
    return { rowCount: rows.length, ms: performance.now() - started };
  }

  async apply(changes: ChangeSet, signal?: AbortSignal): Promise<ApplyResult> {
    this.ensure();
    const started = performance.now();
    await sleep(this.latency, signal);
    // All-or-nothing: work on copies, then swap in.
    const copies = new Map<string, Row[]>();
    const rowsOf = (path: ObjectPath) => {
      const t = this.table(path);
      if (t.view) throw new DriverError(`cannot change view "${t.name}"`);
      if (!copies.has(t.name)) copies.set(t.name, t.rows.map((r) => ({ ...r })));
      return { t, rows: copies.get(t.name)! };
    };
    const match = (r: Row, key: Record<string, Cell>) => Object.entries(key).every(([k, v]) => compare(r[k] ?? null, v) === 0);

    for (const c of changes.changes) {
      const { t, rows } = rowsOf(c.table);
      if (c.type === "update") {
        const hits = rows.filter((r) => match(r, c.key));
        if (hits.length === 0) throw new DriverError(`row not found in ${t.name}: ${JSON.stringify(c.key)}`);
        for (const h of hits) h[c.column] = c.value;
      } else if (c.type === "delete") {
        const keep = rows.filter((r) => !match(r, c.key));
        rows.splice(0, rows.length, ...keep);
      } else {
        const row: Row = {};
        for (const col of t.columns) row[col.name] = c.values[col.name] ?? null;
        const pk = t.columns.find((x) => x.primaryKey);
        if (pk && (row[pk.name] === null || row[pk.name] === "")) {
          const max = rows.reduce((m, r) => Math.max(m, Number(r[pk.name]) || 0), 0);
          row[pk.name] = /int8/.test(pk.type) ? String(max + 1) : max + 1;
        }
        for (const col of t.columns) {
          if (!col.nullable && row[col.name] === null) throw new DriverError(`null value in column "${col.name}" violates not-null constraint`, "23502");
        }
        rows.push(row);
      }
    }
    for (const [name, rows] of copies) {
      const t = this.tables.get(name)!;
      t.rows = rows;
    }
    return {
      applied: changes.changes.length,
      ms: performance.now() - started,
      statements: previewChangeSet(changes, this.dialect).split("\n"),
    };
  }
}

export function createDemoDriver(opts?: DemoDriverOptions): Driver {
  return new DemoDriver(opts);
}
