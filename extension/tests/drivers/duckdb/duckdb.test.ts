// @vitest-environment node
// The "duckdb" driver against tests/fixtures/files/shop.duckdb (made with the duckdb CLI).
import { expect, test } from "vitest";
import { collect, type ConnectionConfig, type Driver } from "../../../src/core/types";
import { createDriver } from "../../../src/drivers/duckdb";
import { fixtureFile, testEngine } from "./engine";

const cfg = (options: Record<string, unknown>, readOnly = false): ConnectionConfig => ({ id: "d", name: "shop", driver: "duckdb", env: "local", readOnly, options });

async function openShop(): Promise<Driver> {
  const d = createDriver({ engine: testEngine, readFile: async () => fixtureFile("shop.duckdb") });
  const { serverVersion } = await d.connect(cfg({ fileHandleId: "h1" }));
  expect(serverVersion).toMatch(/^DuckDB v1\.5\.\d+ \(WASM blocking\)$/);
  return d;
}

test("picked .duckdb files open read-only", async () => {
  const d = await openShop();
  expect(d.id).toBe("duckdb");
  expect(d.capabilities()).toEqual({ kind: "relational", transactions: true, editableRows: false, costEstimate: false, cancel: true });
  await expect(collect(d.execute({ sql: "DELETE FROM customers" }))).rejects.toThrow(/read-only/);
  await expect(d.apply({ changes: [{ type: "delete", table: ["main", "customers"], key: { id: "1" } }] })).rejects.toMatchObject({ code: "read_only" });
  await d.disconnect();
});

test("listObjects: schemas, then tables and views with row counts", async () => {
  const d = await openShop();
  expect(await d.listObjects([])).toEqual([
    { path: ["main"], name: "main", type: "schema", hasChildren: true, meta: "2" },
    { path: ["sales"], name: "sales", type: "schema", hasChildren: true, meta: "2" },
  ]);
  expect(await d.listObjects(["main"])).toEqual([
    { path: ["main", "customers"], name: "customers", type: "table", hasChildren: false, meta: "3" },
    { path: ["main", "orders"], name: "orders", type: "table", hasChildren: false, meta: "2" },
  ]);
  expect(await d.listObjects(["sales"])).toEqual([
    { path: ["sales", "targets"], name: "targets", type: "table", hasChildren: false, meta: "1" },
    { path: ["sales", "big_orders"], name: "big_orders", type: "view", hasChildren: false },
  ]);
  await d.disconnect();
});

test("describe: columns, primary key, foreign key, enum values, indexes and DDL", async () => {
  const d = await openShop();
  const s = await d.describe(["main", "customers"]);
  expect(s.columns).toEqual([
    { name: "id", type: "BIGINT", nullable: false, default: null, primaryKey: true },
    { name: "name", type: "VARCHAR", nullable: false, default: null },
    { name: "email", type: "VARCHAR", nullable: true, default: null },
    { name: "tier", type: "ENUM('free', 'pro')", nullable: true, default: null, enumValues: ["free", "pro"] },
    { name: "joined", type: "DATE", nullable: true, default: "CAST(current_date AS DATE)" },
  ].map((c) => (c.name === "joined" ? { ...c, default: expect.stringContaining("current_date") } : c)));
  expect(s.indexes.map((i) => [i.name, i.columns, i.unique, i.primary])).toEqual([
    ["customers_id_pkey", ["id"], true, true],
    ["customers_email_key", ["email"], true, false],
    ["customers_name_idx", ["name"], false, false],
  ]);
  expect(s.ddl).toMatch(/^CREATE TABLE customers\(id BIGINT PRIMARY KEY/);

  const o = await d.describe(["main", "orders"]);
  expect(o.columns.find((c) => c.name === "customer_id")?.references).toBe("customers.id");

  const v = await d.describe(["sales", "big_orders"]);
  expect(v.info?.type).toBe("view");
  expect(v.ddl).toMatch(/^CREATE VIEW sales\.big_orders AS/);
  await expect(d.describe(["main", "nope"])).rejects.toMatchObject({ code: "not_found" });
  await d.disconnect();
});

test("execute: Cell rules for decimals, hugeint, timestamps; unqualified names resolve in the file", async () => {
  const d = await openShop();
  const o = await collect(d.execute({ sql: "SELECT * FROM orders ORDER BY id" }));
  expect(o.rows).toEqual([
    [10, "1", "9.99", "2024-04-01 10:00:00"],
    [11, "2", "120.50", "2024-04-02 11:30:00.25"],
  ]);
  const t = await collect(d.execute({ sql: "SELECT goal FROM sales.targets" }));
  expect(t.columns[0]!.type).toBe("HUGEINT");
  expect(t.rows).toEqual([["170141183460469231731687303715884105727"]]);
  const p = await collect(d.execute({ sql: "SELECT name FROM customers WHERE id = ? OR name = ?", params: ["2", "Cy"] }));
  expect(p.rows).toEqual([["Bob"], ["Cy"]]);
  await expect(collect(d.execute({ sql: "SELECT * FROM missing_table" }))).rejects.toMatchObject({ code: "catalog" });
  await d.disconnect();
});

test("in-memory databases are writable; apply runs in one transaction and rolls back on error", async () => {
  const d = createDriver({ engine: testEngine });
  await d.connect(cfg({}));
  expect(d.capabilities().editableRows).toBe(true);
  const ddl = await collect(d.execute({ sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, v VARCHAR)" }));
  expect(ddl.rows).toEqual([]);
  const ins = await collect(d.execute({ sql: "INSERT INTO t VALUES (1, 'a'), (2, 'b')" }));
  expect(ins.summary.affectedRows).toBe(2);

  const res = await d.apply({
    changes: [
      { type: "update", table: ["main", "t"], key: { id: 1 }, column: "v", value: "A", old: "a" },
      { type: "insert", table: ["main", "t"], values: { id: 3, v: "c" } },
    ],
  });
  expect(res.applied).toBe(2);
  await expect(
    d.apply({ changes: [{ type: "delete", table: ["main", "t"], key: { id: 2 } }, { type: "insert", table: ["main", "t"], values: { id: 1, v: "dup" } }] }),
  ).rejects.toThrow(/constraint/i);
  expect((await collect(d.execute({ sql: "SELECT id, v FROM t ORDER BY id" }))).rows).toEqual([
    [1, "A"],
    [2, "b"],
    [3, "c"],
  ]);
  await d.disconnect();
});

test("connections are isolated from each other", async () => {
  const a = createDriver({ engine: testEngine });
  const b = createDriver({ engine: testEngine });
  await a.connect(cfg({}));
  await b.connect(cfg({}));
  await collect(a.execute({ sql: "CREATE TABLE only_a AS SELECT 1 AS x" }));
  await expect(collect(b.execute({ sql: "SELECT * FROM only_a" }))).rejects.toThrow(/only_a/);
  expect(await b.listObjects(["main"])).toEqual([]);
  await a.disconnect();
  await b.disconnect();
});

test("a file that isn't a DuckDB database fails with a clear message", async () => {
  const d = createDriver({ engine: testEngine, readFile: async () => fixtureFile("orders.csv") });
  await expect(d.connect(cfg({ fileHandleId: "h1" }))).rejects.toMatchObject({ code: "open_failed", message: expect.stringMatching(/^Could not open orders\.csv as a DuckDB database/) });
});
