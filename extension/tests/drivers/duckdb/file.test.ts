// @vitest-environment node
// The "file" driver against real fixture files (tests/fixtures/files, made with the duckdb CLI).
import { expect, test } from "vitest";
import { collect, type ConnectionConfig, type Driver } from "../../../src/core/types";
import { asDuckDriver, createDriver, FILE_SHEET_TABLE, frequency, sortedFiltered, summarize } from "../../../src/drivers/duckdb";
import { fixtureFile, testEngine } from "./engine";

const cfg = (options: Record<string, unknown>): ConnectionConfig => ({ id: "f", name: "file", driver: "file", env: "local", readOnly: true, options });

async function openFile(name: string, extra: Record<string, unknown> = {}): Promise<Driver> {
  const driver = createDriver({ engine: testEngine, readFile: async () => fixtureFile(name) });
  await driver.connect(cfg({ fileHandleId: "h1", ...extra }));
  return driver;
}

const run = async (d: Driver, sql: string) => collect(d.execute({ sql }));

test("csv: materialised sheet with typed columns", async () => {
  const d = await openFile("orders.csv");
  expect(d.id).toBe("file");
  expect(d.capabilities()).toMatchObject({ kind: "file", editableRows: true });
  const nodes = await d.listObjects([]);
  expect(nodes).toEqual([{ path: [FILE_SHEET_TABLE], name: "sheet", type: "table", hasChildren: false, meta: "CSV · 845 B · 20 rows" }]);
  const { columns, rows } = await run(d, "SELECT * FROM sheet ORDER BY id LIMIT 2");
  expect(columns.map((c) => [c.name, c.type])).toEqual([
    ["id", "BIGINT"],
    ["customer", "VARCHAR"],
    ["status", "VARCHAR"],
    ["total", "DOUBLE"],
    ["created_at", "TIMESTAMP"],
  ]);
  expect(rows[0]).toEqual(["1", "bob", "pending", 12.75, "2024-03-01 16:00:00"]);
  await d.disconnect();
});

test("csv.gz: double extension is detected and decompressed", async () => {
  const d = await openFile("orders.csv.gz");
  const nodes = await d.listObjects([]);
  expect(nodes[0]!.meta).toBe("CSV (gzip) · 302 B · 20 rows");
  const { rows } = await run(d, "SELECT count(*) AS n, sum(total) AS t FROM sheet");
  expect(rows).toEqual([["20", 2630]]);
  await d.disconnect();
});

test("jsonl: nested structs and lists become objects and arrays; big ints stay exact", async () => {
  const d = await openFile("events.jsonl");
  const { columns, rows } = await run(d, "SELECT * FROM sheet ORDER BY id LIMIT 2");
  expect(columns.map((c) => c.name)).toEqual(["id", "type", "payload", "big_id"]);
  expect(rows[0]).toEqual(["1", "view", { user: "u1", tags: ["a", "b"] }, "9007199254740994"]);
  expect(rows[1]![2]).toEqual({ user: "u2", tags: ["a"] });
  await d.disconnect();
});

test("jsonl.zst: zstd-compressed JSON lines", async () => {
  const d = await openFile("events.jsonl.zst");
  expect((await d.listObjects([]))[0]!.meta).toMatch(/^JSONL \(zstd\)/);
  const { rows } = await run(d, "SELECT count(*) FROM sheet");
  expect(rows).toEqual([["10"]]);
  await d.disconnect();
});

test("parquet: decimals, timestamps with microseconds, lists and booleans", async () => {
  const d = await openFile("trips.parquet");
  const { columns, rows } = await run(d, "SELECT * FROM sheet ORDER BY trip_id LIMIT 1");
  expect(columns.map((c) => [c.name, c.type])).toEqual([
    ["trip_id", "BIGINT"],
    ["fare", "DECIMAL(12,3)"],
    ["pickup", "TIMESTAMP"],
    ["zones", "BIGINT[]"],
    ["shared", "BOOLEAN"],
  ]);
  expect(rows[0]).toEqual(["1", "1.750", "2024-05-01 00:13:00.123456", ["1", "2"], false]);
  await d.disconnect();
});

test("large files stay a view and can't be edited", async () => {
  const d = await openFile("orders.csv", { materialize: false });
  expect(d.capabilities()).toMatchObject({ editableRows: false });
  expect((await d.listObjects([]))[0]!.meta).toBe("CSV · 845 B · view");
  expect((await run(d, "SELECT count(*) FROM sheet")).rows).toEqual([["20"]]);
  await expect(d.apply({ changes: [{ type: "delete", table: ["sheet"], key: { id: "1" } }] })).rejects.toMatchObject({ code: "read_only" });
  await d.disconnect();
});

test("sheet helpers: frequency, summarize, sortedFiltered", async () => {
  const d = await openFile("orders.csv");
  const freq = await run(d, frequency("status"));
  expect(freq.columns.map((c) => c.name)).toEqual(["status", "count", "percent"]);
  expect(freq.rows).toEqual([
    ["pending", "7", 35],
    ["refunded", "7", 35],
    ["paid", "6", 30],
  ]);

  const filteredFreq = await run(d, frequency("customer", ["status = 'paid'"]));
  expect(filteredFreq.rows.reduce((a, r) => a + Number(r[1]), 0)).toBe(6);

  const summary = await run(d, summarize());
  expect(summary.rows.map((r) => r[0])).toEqual(["id", "customer", "status", "total", "created_at"]);

  const sorted = await run(d, sortedFiltered(["status = 'refunded'", "total > 100"], [{ column: "total", dir: "desc" }]));
  expect(sorted.rows.map((r) => r[0])).toEqual(["20", "17", "14", "11", "8"]);
  await d.disconnect();
});

test("apply edits the in-memory sheet in a transaction and saveAs exports it", async () => {
  const d = await openFile("orders.csv");
  const res = await d.apply({
    changes: [
      { type: "update", table: ["sheet"], key: { id: "1" }, column: "status", value: "paid", old: "pending" },
      { type: "delete", table: ["sheet"], key: { id: "2" } },
      { type: "insert", table: ["sheet"], values: { id: "99", customer: "zed", status: "paid", total: 1.5, created_at: "2024-06-01 00:00:00" } },
    ],
  });
  expect(res.applied).toBe(3);
  expect(res.statements[0]).toMatch(/^UPDATE "dbui_\d+"\."main"\."sheet" SET "status" = \? WHERE "id" = \?$/);
  expect((await run(d, "SELECT status FROM sheet WHERE id = 1")).rows).toEqual([["paid"]]);
  expect((await run(d, "SELECT count(*) FROM sheet")).rows).toEqual([["20"]]);
  expect((await d.listObjects([]))[0]!.meta).toContain("20 rows");

  // A failing change rolls back the whole set.
  await expect(
    d.apply({ changes: [{ type: "delete", table: ["sheet"], key: { id: "3" } }, { type: "update", table: ["sheet"], key: { id: "4" }, column: "nope", value: 1, old: 0 }] }),
  ).rejects.toThrow(/nope/);
  expect((await run(d, "SELECT count(*) FROM sheet WHERE id = 3")).rows).toEqual([["1"]]);

  const duck = asDuckDriver(d)!;
  const csv = new TextDecoder().decode(await duck.exportBytes("csv"));
  expect(csv.split("\n")[0]).toBe("id,customer,status,total,created_at");
  expect(csv).toContain("99,zed,paid,1.5,2024-06-01 00:00:00");
  const jsonl = new TextDecoder().decode(await duck.exportBytes("jsonl", "SELECT id, status FROM sheet WHERE id = 99"));
  expect(jsonl.trim()).toBe('{"id":99,"status":"paid"}');
  const parquet = await duck.exportBytes("parquet");
  expect(new TextDecoder().decode(parquet.subarray(0, 4))).toBe("PAR1");

  const written: unknown[] = [];
  const handle = {
    name: "out.csv",
    createWritable: async () => ({ write: async (b: unknown) => void written.push(b), close: async () => undefined, abort: async () => undefined }),
  } as unknown as FileSystemFileHandle;
  expect(await duck.saveAs("csv", handle)).toEqual({ bytes: csv.length });
  expect(new TextDecoder().decode(written[0] as Uint8Array)).toBe(csv);
  await d.disconnect();
});

test("unsupported and missing files give clear errors", async () => {
  const d = createDriver({ engine: testEngine, readFile: async () => fixtureFile("orders.csv") });
  await expect(d.connect(cfg({ fileHandleId: "h1", fileName: "notes.txt" }))).rejects.toMatchObject({ code: "unsupported_format" });
  const bad = createDriver({ engine: testEngine, readFile: async () => new File(["not parquet"], "broken.parquet") });
  await expect(bad.connect(cfg({ fileHandleId: "h2" }))).rejects.toThrow(/Could not read broken\.parquet as PARQUET/);
});

test("remote CSV over ~1 GB asks first", async () => {
  const fakeFetch = (async () => new Response(null, { status: 200, headers: { "content-length": String(2 * 1024 ** 3) } })) as typeof fetch;
  const d = createDriver({ engine: testEngine, fetch: fakeFetch });
  await expect(d.connect(cfg({ src: "https://example.com/data/big.csv?sig=1" }))).rejects.toMatchObject({ code: "too_large" });
});

test("execute pages results and stops on abort", async () => {
  const d = await openFile("orders.csv");
  const pages = [];
  const gen = d.execute({ sql: "SELECT * FROM range(5000) t(i)", pageSize: 2000 });
  for (;;) {
    const n = await gen.next();
    if (n.done) {
      expect(n.value.rowCount).toBe(5000);
      break;
    }
    pages.push(n.value);
  }
  expect(pages.map((p) => [p.seq, p.rows.length, !!p.columns])).toEqual([
    [0, 2000, true],
    [1, 2000, false],
    [2, 1000, false],
  ]);
  expect(pages[2]!.rows.at(-1)).toEqual(["4999"]);

  const ac = new AbortController();
  ac.abort();
  await expect(collect(d.execute({ sql: "SELECT 1" }, ac.signal))).rejects.toMatchObject({ code: "cancelled" });
  await d.disconnect();
});

test("file:// src (a file dropped onto Chrome) is read through readFileUrl, not handed to DuckDB as a URL", async () => {
  const seen: string[] = [];
  const driver = createDriver({
    engine: testEngine,
    readFileUrl: async (url, name) => {
      seen.push(url);
      return new File([await fixtureFile("orders.csv").arrayBuffer()], name);
    },
    fetch: async () => {
      throw new Error("no network for a local file");
    },
  });
  await driver.connect(cfg({ src: "file:///Users/me/Downloads/orders.csv" }));
  expect(seen).toEqual(["file:///Users/me/Downloads/orders.csv"]);
  const nodes = await driver.listObjects([]);
  expect(nodes[0]!.meta).toBe("CSV · 845 B · 20 rows");
  const { rows } = await run(driver, "SELECT count(*) FROM sheet");
  expect(Number(rows[0]![0])).toBe(20);
  await driver.disconnect();
});

test("a signed URL that refuses HEAD (GCS, S3) still opens: the CSV is fetched once with GET", async () => {
  const url = "https://storage.googleapis.com/bucket/creatives_e2e_custom-2026_10_23_21_45_38_840958-000000000000.csv?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=ab12";
  const calls: string[] = [];
  const signedOnlyGet = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(method);
    // A URL signed for GET answers 403 to anything else.
    if (method !== "GET") return new Response(null, { status: 403 });
    return new Response(await fixtureFile("orders.csv").arrayBuffer(), { status: 200 });
  }) as typeof fetch;
  const d = createDriver({ engine: testEngine, fetch: signedOnlyGet });
  await d.connect(cfg({ src: url }));
  expect(calls).toEqual(["HEAD", "GET"]);
  const nodes = await d.listObjects([]);
  expect(nodes[0]!.meta).toBe("CSV · 845 B · 20 rows");
  const { rows } = await run(d, "SELECT customer FROM sheet ORDER BY id LIMIT 1");
  expect(rows[0]).toEqual(["bob"]);
  await d.disconnect();
});
