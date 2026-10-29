// @vitest-environment node
// Runs the real @sqlite.org/sqlite-wasm build in Node, in-process (no worker), against
// tests/fixtures/sqlite/shop.sqlite. The worker wrapper itself is browser-only.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { beforeAll, expect, test } from "vitest";
import { collect, type ConnectionConfig, type Driver } from "../../../src/core/types";
import { createDriver } from "../../../src/drivers/sqlite";
import { InProcessBackend } from "../../../src/drivers/sqlite/backend";
import { hasStatement } from "../../../src/drivers/sqlite/engine";

const fixture = () => new Uint8Array(readFileSync(resolve(__dirname, "../../fixtures/sqlite/shop.sqlite")));

let sqlite3: unknown;
beforeAll(async () => {
  sqlite3 = await (sqlite3InitModule as unknown as (o?: object) => Promise<unknown>)({ print: () => undefined, printErr: () => undefined });
});

const cfg = (options: Record<string, unknown> = { fileHandleId: "h1" }, readOnly = false): ConnectionConfig => ({
  id: "s1",
  name: "shop",
  driver: "sqlite",
  env: "local",
  readOnly,
  options,
});

async function open(options?: Record<string, unknown>): Promise<{ driver: Driver; backend: InProcessBackend }> {
  const backend = new InProcessBackend(sqlite3);
  const driver = createDriver({ backend, readFile: async () => fixture() });
  await driver.connect(cfg(options));
  return { driver, backend };
}

test("connect: opens the picked file read-only by default", async () => {
  const { driver } = await open();
  expect(driver.capabilities()).toMatchObject({ kind: "relational", editableRows: false, transactions: true });
  await expect(collect(driver.execute({ sql: "DELETE FROM orders" }))).rejects.toThrow(/readonly|query_only|attempt to write/i);
  await expect(driver.apply({ changes: [] })).rejects.toMatchObject({ code: "read_only" });
});

test("connect: a non-SQLite file is rejected", async () => {
  const driver = createDriver({ backend: new InProcessBackend(sqlite3), readFile: async () => new TextEncoder().encode("not a database, just some text that is long enough") });
  await expect(driver.connect(cfg())).rejects.toMatchObject({ name: "DriverError" });
});

test("listObjects: groups, then tables and views from sqlite_schema", async () => {
  const { driver } = await open();
  expect(await driver.listObjects([])).toEqual([
    { path: ["tables"], name: "tables", type: "group", hasChildren: true, meta: "3" },
    { path: ["views"], name: "views", type: "group", hasChildren: true, meta: "1" },
  ]);
  expect((await driver.listObjects(["tables"])).map((n) => n.name)).toEqual(["customers", "order_items", "orders"]);
  expect(await driver.listObjects(["views"])).toEqual([{ path: ["views", "order_totals"], name: "order_totals", type: "view", hasChildren: false }]);
});

test("describe: columns, primary keys, foreign keys, indexes", async () => {
  const { driver } = await open();
  const orders = await driver.describe(["tables", "orders"]);
  expect(orders.columns.map((c) => [c.name, c.type, c.nullable, c.primaryKey ?? false, c.references])).toEqual([
    ["id", "INTEGER", false, true, undefined],
    ["customer_id", "INTEGER", false, false, "customers.id"],
    ["total", "REAL", true, false, undefined],
    ["big", "INTEGER", true, false, undefined],
    ["note", "TEXT", true, false, undefined],
    ["payload", "BLOB", true, false, undefined],
  ]);
  expect(orders.indexes).toEqual([
    { name: "PRIMARY KEY", columns: ["id"], unique: true, primary: true },
    { name: "orders_customer", columns: ["customer_id"], unique: false, primary: false, definition: "CREATE INDEX orders_customer ON orders(customer_id)" },
  ]);
  expect(orders.info).toMatchObject({ type: "table", rows: "3" });
  expect(orders.ddl).toMatch(/^CREATE TABLE orders/);

  const items = await driver.describe(["tables", "order_items"]);
  expect(items.indexes.find((i) => i.primary)).toMatchObject({ columns: ["order_id", "sku"], unique: true });
  expect(items.info!["without rowid"]).toBe("true");
  expect(items.columns.find((c) => c.name === "qty")).toMatchObject({ nullable: false, default: "1" });

  const customers = await driver.describe(["customers"]);
  expect(customers.columns.find((c) => c.name === "created_at")!.default).toBe("CURRENT_TIMESTAMP");
  expect(customers.indexes.some((i) => i.unique && i.columns[0] === "email")).toBe(true);
});

test("execute: pages rows; 64-bit ints beyond 2^53 are strings; blobs are hex literals", async () => {
  const { driver } = await open();
  const gen = driver.execute({ sql: "SELECT * FROM order_items ORDER BY order_id, sku", pageSize: 2000 });
  const seqs: number[] = [];
  let total = 0;
  for (;;) {
    const n = await gen.next();
    if (n.done) {
      expect(n.value.rowCount).toBe(5002);
      break;
    }
    seqs.push(n.value.seq);
    total += n.value.rows.length;
    if (n.value.seq === 0) expect(n.value.columns!.map((c) => c.name)).toEqual(["order_id", "sku", "qty"]);
  }
  expect(seqs).toEqual([0, 1, 2]);
  expect(total).toBe(5002);

  const { rows, columns } = await collect(driver.execute({ sql: "SELECT id, total, big, note, payload FROM orders ORDER BY id" }));
  expect(columns.map((c) => c.type)).toEqual(["INTEGER", "REAL", "INTEGER", "TEXT", "BLOB"]);
  expect(rows).toEqual([
    [1, 19.5, "9007199254740993", "first", "x'00ff10'"],
    [2, 5, 1, null, null],
    [3, 100.25, "-9223372036854775808", "big", null],
  ]);
});

test("execute: params, multiple statements, and an empty result keeps its columns", async () => {
  const { driver } = await open();
  const r = await collect(driver.execute({ sql: "SELECT 1; SELECT name FROM customers WHERE id = ?", params: [1] }));
  expect(r.rows).toEqual([["Ada"]]);
  const empty = await collect(driver.execute({ sql: "SELECT id FROM orders WHERE id < 0" }));
  expect(empty.columns.map((c) => c.name)).toEqual(["id"]);
  expect(empty.rows).toEqual([]);
});

test("execute: SQL errors become DriverError", async () => {
  const { driver } = await open();
  await expect(collect(driver.execute({ sql: "SELECT * FROM nope" }))).rejects.toMatchObject({ name: "DriverError", message: expect.stringMatching(/no such table: nope/) });
});

test("cancel: abort between pages stops and closes the cursor", async () => {
  const { driver } = await open();
  const ctrl = new AbortController();
  const gen = driver.execute({ sql: "SELECT * FROM order_items", pageSize: 100 }, ctrl.signal);
  await gen.next();
  ctrl.abort();
  await expect(gen.next()).rejects.toMatchObject({ code: "cancelled" });
  // The connection still works afterwards.
  expect((await collect(driver.execute({ sql: "SELECT count(*) FROM orders" }))).rows).toEqual([[3]]);
});

test("cancel: the interrupt flag stops a long-running step", async () => {
  const backend = new InProcessBackend(sqlite3);
  await backend.open({ readOnly: true });
  const flag = new Int32Array(new SharedArrayBuffer(4));
  backend.engine.setInterruptFlag(flag);
  const { cursor } = backend.engine.query("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c");
  Atomics.store(flag, 0, 1); // as the main thread would while the worker is busy
  expect(() => backend.engine.next(cursor, 1)).toThrow(/interrupt/);
});

test("apply: ChangeSet in one transaction, rolled back on error", async () => {
  const { driver } = await open({ fileHandleId: "h1", writable: true });
  expect(driver.capabilities().editableRows).toBe(true);
  const res = await driver.apply({
    changes: [
      { type: "update", table: ["tables", "customers"], key: { id: 2 }, column: "name", value: "Bob", old: null },
      { type: "insert", table: ["tables", "customers"], values: { id: 3, email: "cy@example.com", name: "Cy" } },
      { type: "delete", table: ["tables", "order_items"], key: { order_id: 3, sku: "A-1" } },
    ],
  });
  expect(res.applied).toBe(3);
  expect(res.statements[0]).toBe('UPDATE "customers" SET "name" = ? WHERE "id" = ?');
  expect((await collect(driver.execute({ sql: "SELECT id, name FROM customers ORDER BY id" }))).rows).toEqual([[1, "Ada"], [2, "Bob"], [3, "Cy"]]);

  // Second insert violates UNIQUE(email): the first one must be rolled back too.
  await expect(
    driver.apply({
      changes: [
        { type: "insert", table: ["customers"], values: { id: 4, email: "dee@example.com" } },
        { type: "insert", table: ["customers"], values: { id: 5, email: "ada@example.com" } },
      ],
    }),
  ).rejects.toMatchObject({ name: "DriverError", message: expect.stringMatching(/UNIQUE/) });
  expect((await collect(driver.execute({ sql: "SELECT count(*) FROM customers" }))).rows).toEqual([[3]]);
});

test("execute: DML reports affected rows on a writable database", async () => {
  const { driver } = await open({ fileHandleId: "h1", writable: true });
  const r = await collect(driver.execute({ sql: "UPDATE orders SET note = 'x' WHERE customer_id = 1" }));
  expect(r.summary.affectedRows).toBe(2);
});

test("hasStatement ignores trailing comments and semicolons", () => {
  expect(hasStatement(" ; -- done\n /* c */ ")).toBe(false);
  expect(hasStatement("; SELECT 1")).toBe(true);
});
