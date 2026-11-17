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

test("runScript runs the script as one job and returns each query's own result, in order", async () => {
  const { driver, calls } = await connected((c) => {
    if (c.method === "POST") return "jobs-query-script.json";
    if (c.url.pathname.endsWith("/jobs")) return "jobs-list-script-children.json";
    return c.url.pathname.endsWith("script_job_1_2") ? "get-query-results-script-orders.json" : "get-query-results-script-count.json";
  });
  const sql = "DECLARE end_date DATE DEFAULT CURRENT_DATE();\nSELECT id, status FROM shop.orders WHERE day <= end_date;\nSELECT COUNT(*) AS n FROM shop.orders WHERE day = end_date";
  const results = await driver.runScript!({ sql });
  expect(calls[0]!.body!.query).toBe(sql);
  const list = calls.find((c) => c.url.pathname.endsWith("/jobs"))!;
  expect(list.url.searchParams.get("parentJobId")).toBe("script_job_1");
  // The DECLARE returns nothing and is left out; the queries come back oldest first.
  expect(results.map((r) => r.sql)).toEqual(["SELECT id, status FROM shop.orders WHERE day <= end_date", "SELECT COUNT(*) AS n FROM shop.orders WHERE day = end_date"]);
  expect(results[0]!.columns.map((c) => c.name)).toEqual(["id", "status"]);
  expect(results[0]!.rows).toEqual([["1", "paid"], ["2", "open"]]);
  expect(results[0]!.summary).toMatchObject({ rowCount: 2, bytesProcessed: 2048, ms: 90 });
  expect(results[1]!.rows).toEqual([["4"]]);
});

/**
 * Catalog routes: projects-list-catalog.json has dbui-test (billing, datasets in us-central1),
 * other-proj (US and EU datasets, the tables in US) and locked-proj (datasets.list denied).
 */
function catalogRoutes(c: Call): string | { file: string; status: number } {
  const p = c.url.pathname;
  if (c.method === "GET" && p.endsWith("/projects")) return "projects-list-catalog.json";
  if (p.endsWith("/locked-proj/datasets")) return { file: "error-access-denied.json", status: 403 };
  if (p.endsWith("/other-proj/datasets")) return "datasets-list-catalog-us-eu.json";
  if (p.endsWith("/dbui-test/datasets")) return "datasets-list-catalog-billing.json";
  return String(c.body?.query).includes("`other-proj.region-us.") ? "catalog-tables-other-proj-us.json" : "catalog-tables-empty.json";
}

test("listAllObjects: every project's datasets, and its tables from each region its datasets use", async () => {
  const { driver, calls } = await connected(catalogRoutes);
  const { objects, notes } = await driver.listAllObjects!();
  expect(objects.map((n) => [n.type, n.path.join(".")])).toEqual([
    ["dataset", "dbui-test.shop"],
    ["dataset", "other-proj.web_v2__attribution"],
    ["dataset", "other-proj.eu_marts"],
    ["dataset", "other-proj.3f2b8c1d_9e4a_4b7f_a1c2_d5e6f7a8b9c0"],
    ["table", "other-proj.web_v2__attribution.mart__fact__annotated_visits"],
    ["view", "other-proj.web_v2__attribution.mart__fact__annotated_visits_v"],
    ["table", "other-proj.3f2b8c1d_9e4a_4b7f_a1c2_d5e6f7a8b9c0.agg_daily__channel_metrics"],
  ]);
  expect(objects[4]!.meta).toBe("other-proj.web_v2__attribution");
  // One INFORMATION_SCHEMA query per (project, region), run in that region, billed to the billing project.
  const queries = calls.filter((c) => c.method === "POST");
  expect(queries.map((c) => [String(c.body!.query).match(/FROM `([^`]+)`/)![1], c.body!.location, c.url.pathname])).toEqual([
    ["dbui-test.region-us-central1.INFORMATION_SCHEMA.TABLES", "us-central1", "/bigquery/v2/projects/dbui-test/queries"],
    ["other-proj.region-us.INFORMATION_SCHEMA.TABLES", "US", "/bigquery/v2/projects/dbui-test/queries"],
    ["other-proj.region-eu.INFORMATION_SCHEMA.TABLES", "EU", "/bigquery/v2/projects/dbui-test/queries"],
  ]);
  // The project it can't read is named, not silently dropped.
  expect(notes).toEqual(["locked-proj: couldn't list datasets (Access Denied: Table locked-proj:region-us.INFORMATION_SCHEMA.TABLES: User does not have permission to query table locked-proj:region-us.INF…)"]);
});

test("extraProjects: projects named on the connection show in the tree and get listed", async () => {
  const { fetch, calls } = stubFetch((c) => {
    if (c.url.pathname.endsWith("/projects")) return "projects-list.json";
    if (c.url.pathname.endsWith("/datasets")) return "datasets-list-catalog-us-eu.json";
    return "catalog-tables-empty.json";
  });
  const driver = createDriver({ fetch, tokenProvider });
  await driver.connect({ ...cfg, options: { ...cfg.options, extraProjects: "shared-proj, other-proj" } });
  expect((await driver.listObjects([])).map((n) => [n.name, n.meta])).toEqual([
    ["shared-proj", "added"],
    ["dbui-test", "dbui test"],
    ["other-proj", undefined],
  ]);
  await driver.listAllObjects!();
  expect(calls.filter((c) => c.url.pathname.endsWith("/datasets")).map((c) => c.url.pathname.split("/")[4])).toEqual(["dbui-test", "shared-proj", "other-proj"]);
});

test("listAllObjects: with the region view denied (only datasets shared), each dataset's tables are listed instead", async () => {
  const { driver, calls } = await connected((c) => {
    const p = c.url.pathname;
    if (p.endsWith("/projects")) return "projects-list.json";
    if (p.endsWith("/datasets")) return "datasets-list.json";
    if (p.endsWith("/datasets/shop/tables")) return "tables-list.json";
    return { file: "error-access-denied.json", status: 403 };
  });
  const { objects, notes } = await driver.listAllObjects!();
  expect(objects.filter((n) => n.type !== "dataset").map((n) => [n.type, n.path.join("."), n.meta])).toEqual([
    ["table", "dbui-test.shop.orders", "dbui-test.shop"],
    ["view", "dbui-test.shop.orders_v", "dbui-test.shop"],
    ["table", "other-proj.shop.orders", "other-proj.shop"],
    ["view", "other-proj.shop.orders_v", "other-proj.shop"],
  ]);
  expect(notes).toEqual([]);
  expect(calls.some((c) => c.url.pathname === "/bigquery/v2/projects/other-proj/datasets/shop/tables")).toBe(true);
});

test("listAllObjects: lists every project, however many (the 32nd here holds the client tables), a few at a time", async () => {
  let inFlight = 0;
  let peak = 0;
  const { fetch } = stubFetch((c) => {
    const p = c.url.pathname;
    if (p.endsWith("/projects")) return "projects-list-many.json";
    if (p.endsWith("/datasets")) return "datasets-list-catalog-billing.json";
    return String(c.body?.query).includes("`events-prod.") ? "catalog-tables-events-us.json" : "catalog-tables-empty.json";
  });
  const counting = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    try {
      return await fetch(input, init);
    } finally {
      inFlight--;
    }
  });
  const driver = createDriver({ fetch: counting, tokenProvider });
  await driver.connect(cfg);
  const { objects } = await driver.listAllObjects!();
  expect(objects.filter((n) => n.name === "agg_daily__channel_metrics").map((n) => n.meta)).toEqual([
    "events-prod.production__11111111_2222_4333_8444_555555555555",
    "events-prod.production__aaaaaaaa_bbbb_4ccc_8ddd_eeeeeeeeeeee",
  ]);
  expect(peak).toBeLessThanOrEqual(6);
});
