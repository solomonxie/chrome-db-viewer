import { expect, test } from "vitest";
import { collect } from "@core/types";
import { compileWhere, buildSelect, type FilterRow } from "../../src/app/lib/filters";
import { DEMO_CONNECTION, DemoDriver } from "../../src/app/demo/demoDriver";

async function connected() {
  const d = new DemoDriver({ latency: 0 });
  await d.connect(DEMO_CONNECTION);
  return d;
}

test("tree lists schema, groups and tables", async () => {
  const d = await connected();
  expect((await d.listObjects([])).map((n) => n.name)).toEqual(["public"]);
  const tables = await d.listObjects(["public", "tables"]);
  expect(tables.map((n) => n.name).sort()).toEqual(["customers", "order_items", "orders"]);
});

test("orders has an FK, jsonb, bool and timestamps", async () => {
  const d = await connected();
  const s = await d.describe(["public", "tables", "orders"]);
  const byName = Object.fromEntries(s.columns.map((c) => [c.name, c]));
  expect(byName.customer_id?.references).toBe("customers.id");
  expect(byName.metadata?.type).toBe("jsonb");
  expect(byName.paid?.type).toBe("bool");
  expect(byName.created_at?.type).toBe("timestamptz");
});

test("filter rows compile to SQL the demo driver runs", async () => {
  const d = await connected();
  const s = await d.describe(["public", "tables", "orders"]);
  const rows: FilterRow[] = [
    { id: 1, enabled: true, column: "status", op: "=", value: "paid" },
    { id: 2, enabled: true, column: "total", op: ">", value: "100" },
    { id: 3, enabled: true, column: "metadata", op: "contains", value: "web" },
  ];
  const where = compileWhere(rows, s.columns, d.dialect);
  const sql = buildSelect({ table: `"public"."orders"`, where, sort: [{ column: "total", dir: "desc" }], limit: 50 }, d.dialect);
  const { columns, rows: out } = await collect(d.execute({ sql }));
  expect(out.length).toBeGreaterThan(0);
  const status = columns.findIndex((c) => c.name === "status");
  const total = columns.findIndex((c) => c.name === "total");
  for (const r of out) {
    expect(r[status]).toBe("paid");
    expect(Number(r[total])).toBeGreaterThan(100);
  }
  const totals = out.map((r) => Number(r[total]));
  expect(totals).toEqual(totals.slice().sort((a, b) => b - a));
});

test("group-by and summarize queries work", async () => {
  const d = await connected();
  const freq = await collect(d.execute({ sql: `SELECT "status", count(*) AS "count" FROM "orders" GROUP BY "status" ORDER BY "count" DESC` }));
  expect(freq.columns.map((c) => c.name)).toEqual(["status", "count"]);
  expect(freq.rows.reduce((a, r) => a + Number(r[1]), 0)).toBe(640);
  const sum = await collect(d.execute({ sql: `SUMMARIZE "orders"` }));
  expect(sum.rows.map((r) => r[0])).toContain("metadata");
});

test("apply runs a ChangeSet all-or-nothing", async () => {
  const d = await connected();
  await d.apply({ changes: [{ type: "update", table: ["public", "orders"], key: { id: "10400" }, column: "status", value: "refunded", old: null }] });
  const after = await collect(d.execute({ sql: `SELECT * FROM orders WHERE id = '10400'` }));
  expect(after.rows[0]?.[2]).toBe("refunded");

  await expect(
    d.apply({
      changes: [
        { type: "update", table: ["public", "orders"], key: { id: "10401" }, column: "status", value: "x", old: null },
        { type: "update", table: ["public", "orders"], key: { id: "nope" }, column: "status", value: "x", old: null },
      ],
    }),
  ).rejects.toThrow(/row not found/);
  const untouched = await collect(d.execute({ sql: `SELECT status FROM orders WHERE id = '10401'` }));
  expect(untouched.rows[0]?.[0]).not.toBe("x");
});

test("execute stops when aborted", async () => {
  const d = await connected();
  const ac = new AbortController();
  const p = collect(d.execute({ sql: "SELECT pg_sleep(5)" }, ac.signal));
  ac.abort();
  await expect(p).rejects.toThrow(/cancelled/);
});
