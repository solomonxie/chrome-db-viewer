// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { collect, type ConnectionConfig, type Driver } from "../../../src/core/types";
import { createDriver } from "../../../src/drivers/bigquery";
import { microsToIso } from "../../../src/drivers/bigquery/convert";

const fx = (name: string) => readFileSync(resolve(__dirname, "../../fixtures/bigquery", name), "utf8");

const cfg: ConnectionConfig = {
  id: "bq1",
  name: "bq",
  driver: "bigquery",
  env: "dev",
  readOnly: true,
  options: { projectId: "dbui-test", location: "US", maximumBytesBilled: "5000" },
};

type Call = { method: string; url: URL; body: Record<string, unknown> | undefined };

/** Serves fixture files by route; records every call. */
function stubFetch(routes: (c: Call) => string | { file: string; status: number }) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", url: new URL(String(input)), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const r = routes(call);
    const { file, status } = typeof r === "string" ? { file: r, status: 200 } : r;
    return new Response(fx(file), { status, headers: { "Content-Type": "application/json" } });
  });
  return { fetch, calls };
}

const tokenProvider = { getToken: async () => ({ token: "tok", expiresAt: Date.now() + 3600_000 }) };

async function connected(routes: Parameters<typeof stubFetch>[0]): Promise<{ driver: Driver; calls: Call[] }> {
  const { fetch, calls } = stubFetch(routes);
  const driver = createDriver({ fetch, tokenProvider });
  await driver.connect(cfg);
  return { driver, calls };
}

test("execute: jobs.query then getQueryResults page 2, f/v rows converted", async () => {
  const { driver, calls } = await connected((c) =>
    c.method === "POST" ? "jobs-query-page1.json" : "get-query-results-page2.json",
  );
  const pages = [];
  const gen = driver.execute({ sql: "SELECT * FROM shop.orders", pageSize: 2 });
  for (;;) {
    const n = await gen.next();
    if (n.done) {
      expect(n.value.rowCount).toBe(3);
      expect(n.value.bytesProcessed).toBe(1048576);
      break;
    }
    pages.push(n.value);
  }
  expect(pages.map((p) => p.seq)).toEqual([0, 1]);
  expect(pages[0]!.columns!.map((c) => [c.name, c.type, c.nullable])).toEqual([
    ["id", "INTEGER", false],
    ["amount", "NUMERIC", true],
    ["score", "FLOAT", true],
    ["active", "BOOLEAN", true],
    ["created_at", "TIMESTAMP", true],
    ["day", "DATE", true],
    ["tags", "ARRAY<STRING>", true],
    ["address", "STRUCT<city STRING, zip INTEGER>", true],
    ["items", "ARRAY<STRUCT<sku STRING, qty INTEGER>>", true],
    ["meta", "JSON", true],
  ]);
  expect(pages[0]!.rows[0]).toEqual([
    "9223372036854775807",
    "12345678901234567890.123456789",
    0.5,
    true,
    "2023-11-14T22:13:20.123456Z",
    "2024-03-01",
    ["a", "b"],
    { city: "Berlin", zip: "10115" },
    [{ sku: "A-1", qty: "2" }, { sku: "B-2", qty: "1" }],
    { k: 1, n: [1, 2] },
  ]);
  expect(pages[0]!.rows[1]).toEqual(["2", null, -1.25e10, false, null, null, [], null, [], null]);
  expect(pages[1]!.columns).toBeUndefined();
  expect(pages[1]!.rows[0]).toEqual(["3", "-0.5", NaN, null, "1969-12-31T23:59:59.999999Z", "1969-12-31", ["z"], { city: null, zip: null }, [], [1, "x"]]);

  const q = calls[0]!;
  expect(q.url.pathname).toBe("/bigquery/v2/projects/dbui-test/queries");
  expect(q.body).toMatchObject({ query: "SELECT * FROM shop.orders", useLegacySql: false, maximumBytesBilled: "5000", maxResults: 2, location: "US" });
  const page2 = calls[1]!;
  expect(page2.url.pathname).toBe("/bigquery/v2/projects/dbui-test/queries/job_a1B2c3D4e5F6g7H8");
  expect(page2.url.searchParams.get("pageToken")).toBe("BFKJ3HHVXIAQAAASA4EAAEEAQCAAKGQEBCFACBMQCAA");
  expect(page2.url.searchParams.get("location")).toBe("US");
});

test("execute: polls getQueryResults while jobComplete is false", async () => {
  let n = 0;
  const { driver, calls } = await connected((c) => {
    if (c.method === "POST") return "jobs-query-incomplete.json";
    return n++ === 0 ? "jobs-query-page1.json" : "get-query-results-page2.json";
  });
  const { rows } = await collect(driver.execute({ sql: "SELECT 1" }));
  expect(rows).toHaveLength(3);
  expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
});

test("execute: statement maximumBytesBilled overrides the connection's", async () => {
  const { driver, calls } = await connected(() => "get-query-results-page2.json");
  await collect(driver.execute({ sql: "SELECT 1", options: { maximumBytesBilled: 99 } }));
  expect(calls[0]!.body!.maximumBytesBilled).toBe("99");
});

test("execute: bytes-billed limit becomes a clear DriverError", async () => {
  const { driver } = await connected(() => ({ file: "error-bytes-billed.json", status: 400 }));
  await expect(collect(driver.execute({ sql: "SELECT 1" }))).rejects.toMatchObject({ name: "DriverError", code: "bytes_billed_limit" });
});

test("execute: abort calls jobs.cancel", async () => {
  const { driver, calls } = await connected((c) => {
    if (c.url.pathname.endsWith("/cancel")) return "jobs-cancel.json";
    return c.method === "POST" ? "jobs-query-page1.json" : "get-query-results-page2.json";
  });
  const ctrl = new AbortController();
  const gen = driver.execute({ sql: "SELECT 1" }, ctrl.signal);
  await gen.next(); // page 1
  ctrl.abort();
  await expect(gen.next()).rejects.toBeTruthy();
  await new Promise((r) => setTimeout(r, 0));
  const cancel = calls.find((c) => c.url.pathname.endsWith("/cancel"))!;
  expect(cancel.method).toBe("POST");
  expect(cancel.url.pathname).toBe("/bigquery/v2/projects/dbui-test/jobs/job_a1B2c3D4e5F6g7H8/cancel");
  expect(cancel.url.searchParams.get("location")).toBe("US");
});

test("estimate: dry run bytes and on-demand USD", async () => {
  const { driver, calls } = await connected(() => "jobs-query-dry-run.json");
  const est = await driver.estimate!({ sql: "SELECT * FROM shop.orders" });
  expect(est.bytes).toBe(5497558138880); // 5 TiB
  expect(est.usd).toBeCloseTo(31.25);
  expect(calls[0]!.body).toMatchObject({ dryRun: true, useLegacySql: false });
});

test("describe: tables.get schema, partitioning, clustering, sizes, constraints", async () => {
  const { driver, calls } = await connected(() => "tables-get.json");
  const s = await driver.describe(["dbui-test", "shop", "orders"]);
  expect(calls[0]!.url.pathname).toBe("/bigquery/v2/projects/dbui-test/datasets/shop/tables/orders");
  expect(s.columns).toHaveLength(10);
  expect(s.columns[0]).toMatchObject({ name: "id", primaryKey: true, nullable: false });
  expect(s.columns.find((c) => c.name === "day")!.references).toBe("customers.day");
  expect(s.info).toMatchObject({
    type: "TABLE",
    rows: "48213",
    size: "1.2 GB (1288490188 bytes)",
    partitioning: "created_at by DAY",
    "partition expiration": "90 days",
    "require partition filter": "true",
    clustering: "id, day",
    location: "US",
  });
  expect(s.indexes[0]).toMatchObject({ primary: true, columns: ["id"] });
});

test("listObjects: projects → datasets → tables with size and partition meta", async () => {
  const { driver } = await connected((c) => {
    const p = c.url.pathname;
    if (p.endsWith("/queries")) return "tables-meta-query.json";
    if (p.endsWith("/tables")) return "tables-list.json";
    if (p.endsWith("/datasets")) return "datasets-list.json";
    return "projects-list.json";
  });
  expect(await driver.listObjects([])).toEqual([
    { path: ["dbui-test"], name: "dbui-test", type: "database", hasChildren: true, meta: "dbui test" },
    { path: ["other-proj"], name: "other-proj", type: "database", hasChildren: true, meta: undefined },
  ]);
  expect(await driver.listObjects(["dbui-test"])).toEqual([{ path: ["dbui-test", "shop"], name: "shop", type: "dataset", hasChildren: true, meta: "US" }]);
  expect(await driver.listObjects(["dbui-test", "shop"])).toEqual([
    { path: ["dbui-test", "shop", "orders"], name: "orders", type: "table", hasChildren: false, meta: "1.2 GB · partitioned" },
    { path: ["dbui-test", "shop", "orders_v"], name: "orders_v", type: "view", hasChildren: false, meta: "0 B" },
  ]);
});

test("apply: read-only grid", async () => {
  const { driver } = await connected(() => "projects-list.json");
  await expect(driver.apply({ changes: [] })).rejects.toMatchObject({ code: "read_only" });
  expect(driver.capabilities()).toMatchObject({ editableRows: false, costEstimate: true, cancel: true });
});

test("microsToIso keeps microseconds, including before 1970", () => {
  expect(microsToIso("0")).toBe("1970-01-01T00:00:00.000000Z");
  expect(microsToIso("-1")).toBe("1969-12-31T23:59:59.999999Z");
});
