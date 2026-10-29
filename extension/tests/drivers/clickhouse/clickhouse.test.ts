// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { collect, type ConnectionConfig } from "../../../src/core/types";
import { createDriver, extractTtl } from "../../../src/drivers/clickhouse";
import { parseCompactStream, readLines } from "../../../src/drivers/clickhouse/stream";
import { convertValue, toColumn, unwrapType } from "../../../src/drivers/clickhouse/types";

const fxBytes = (name: string) => readFileSync(resolve(__dirname, "../../fixtures/clickhouse", name));
const fx = (name: string) => fxBytes(name).toString("utf8");

/** A ReadableStream that delivers `bytes` in chunks of `size` bytes (splitting lines and UTF-8 chars). */
function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (i >= bytes.length) return ctrl.close();
      ctrl.enqueue(bytes.slice(i, i + size));
      i += size;
    },
  });
}

async function parseAll(bytes: Uint8Array, chunk: number, batch = 2000) {
  const events = [];
  for await (const ev of parseCompactStream(readLines(chunked(bytes, chunk)), batch)) events.push(ev);
  return events;
}

const cfg: ConnectionConfig = {
  id: "ch1",
  name: "ch",
  driver: "clickhouse",
  env: "dev",
  readOnly: true,
  options: { url: "http://ch.test:8123/", user: "reader", password: "pw", database: "analytics" },
};

test("stream parser: same result for every chunk size, including 1-byte chunks", async () => {
  const bytes = fxBytes("events.jsonl");
  const expected = await parseAll(bytes, bytes.length);
  expect(expected[0]).toMatchObject({ kind: "header", names: ["id", "user_id", "big", "amount", "ts", "d", "name", "note", "score", "tags", "attrs", "ok", "u"] });
  expect(expected[1]).toMatchObject({ kind: "rows" });
  for (const size of [1, 2, 3, 7, 64]) expect(await parseAll(bytes, size)).toEqual(expected);
  // The multi-byte "ünï" survives being split mid-character.
  const rows = (expected[1] as { rows: unknown[][] }).rows;
  expect(rows[1]![7]).toBe('hello "world"\nline2 ünï');
});

test("stream parser: batches rows into pages", async () => {
  const events = await parseAll(fxBytes("midstream-error.jsonl").subarray(0, fx("midstream-error.jsonl").indexOf("\n\r\n") + 1), 5, 10);
  const sizes = events.filter((e) => e.kind === "rows").map((e) => (e as { rows: unknown[] }).rows.length);
  expect(sizes).toEqual([10, 10, 4]);
});

test("stream parser: mid-stream __exception__ block becomes a DriverError", async () => {
  const seen: number[] = [];
  const run = async () => {
    for await (const ev of parseCompactStream(readLines(chunked(fxBytes("midstream-error.jsonl"), 13)), 5)) {
      if (ev.kind === "rows") seen.push(ev.rows.length);
    }
  };
  await expect(run()).rejects.toMatchObject({ name: "DriverError", code: "FUNCTION_THROW_IF_VALUE_IS_NON_ZERO" });
  await expect(run()).rejects.toThrow(/^Code: 395\. DB::Exception: boom/);
  expect(seen.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
});

test("type mapping: big ints, decimals, DateTime64 stay strings; Nullable and LowCardinality unwrap", async () => {
  const [header, rows] = await parseAll(fxBytes("events.jsonl"), 100);
  const { names, types } = header as { names: string[]; types: string[] };
  const cols = names.map((n, i) => toColumn(n, types[i]!));
  expect(cols.find((c) => c.name === "note")).toEqual({ name: "note", type: "Nullable(String)", nullable: true });
  expect(cols.find((c) => c.name === "name")).toEqual({ name: "name", type: "LowCardinality(String)", nullable: false });
  const r = (rows as { rows: unknown[][] }).rows[0]!.map((v, i) => convertValue(types[i]!, v));
  expect(r).toEqual([
    "18446744073709551615",
    "-9223372036854775808",
    "170141183460469231731687303715884105727",
    "12345.6789",
    "2024-03-01 12:34:56.789",
    "2024-03-01",
    "click",
    null,
    0.5,
    ["a", "b"],
    { k: 1 },
    true,
    "00000000-0000-0000-0000-000000000001",
  ]);
  expect(unwrapType("LowCardinality(Nullable(String))")).toEqual({ base: "String", nullable: true });
});

test("type mapping: nested arrays, named tuples, maps, nan, enums", async () => {
  const [header, rows] = await parseAll(fxBytes("nested.jsonl"), 9);
  const { names, types } = header as { names: string[]; types: string[] };
  const r = (rows as { rows: unknown[][] }).rows[0]!.map((v, i) => convertValue(types[i]!, v));
  expect(r[0]).toEqual(["1", "18446744073709551615"]);
  expect(r[1]).toEqual({ n: "1", s: "x" });
  expect(r[2]).toBeNaN();
  expect(r[3]).toBe("1.5");
  expect(r[4]).toEqual({ a: "5" });
  expect(r[5]).toBe("z");
  expect(toColumn(names[5]!, types[5]!).nullable).toBe(true);
  expect(toColumn(names[8]!, types[8]!).enumValues).toEqual(["a", "b"]);
});

function stubFetch(handler: (url: URL, body: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; body: string; headers: Record<string, string> }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = String(init?.body ?? "");
    calls.push({ url, body, headers: init?.headers as Record<string, string> });
    return handler(url, body, init!);
  });
  return { fetch, calls };
}

const versionBody = '["version()"]\n["String"]\n["26.10.3.7"]\n';

test("execute: query_id, readonly, max_execution_time, auth headers; pages from the fixture", async () => {
  const { fetch, calls } = stubFetch((_url, body) =>
    new Response(body.startsWith("SELECT version()") ? versionBody : chunked(fxBytes("events.jsonl"), 17), {
      headers: { "X-ClickHouse-Summary": '{"read_rows":"2","read_bytes":"512"}' },
    }),
  );
  const driver = createDriver({ fetch, newQueryId: () => "qid-1" });
  expect(await driver.connect(cfg)).toEqual({ serverVersion: "ClickHouse 26.10.3.7" });
  const { columns, rows, summary } = await collect(driver.execute({ sql: "SELECT * FROM events", pageSize: 1, options: { maxResultRows: 100 } }));
  expect(columns).toHaveLength(13);
  expect(rows).toHaveLength(2);
  expect(rows[0]![0]).toBe("18446744073709551615");
  expect(summary).toMatchObject({ rowCount: 2, bytesProcessed: 512 });

  const q = calls[1]!;
  expect(q.url.origin + q.url.pathname).toBe("http://ch.test:8123/");
  const p = Object.fromEntries(q.url.searchParams);
  expect(p).toMatchObject({
    query_id: "qid-1",
    readonly: "1",
    max_execution_time: "300",
    database: "analytics",
    default_format: "JSONCompactEachRowWithNamesAndTypes",
    output_format_json_quote_64bit_integers: "1",
    max_result_rows: "100",
    result_overflow_mode: "break",
  });
  expect(q.headers).toMatchObject({ "X-ClickHouse-User": "reader", "X-ClickHouse-Key": "pw" });
  expect(q.body).toBe("SELECT * FROM events");
});

test("execute: HTTP 404 exception body becomes a DriverError", async () => {
  const { fetch } = stubFetch((_u, body) =>
    body.startsWith("SELECT version()")
      ? new Response(versionBody)
      : new Response("Code: 60. DB::Exception: Unknown table expression identifier 'nope'. (UNKNOWN_TABLE) (version 26.10.3.7 (official build))\n", { status: 404 }),
  );
  const driver = createDriver({ fetch });
  await driver.connect(cfg);
  await expect(collect(driver.execute({ sql: "SELECT * FROM nope" }))).rejects.toMatchObject({ name: "DriverError", code: "UNKNOWN_TABLE" });
});

test("cancel: aborting the signal aborts the fetch and sends KILL QUERY for the query_id", async () => {
  let streamCtrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const { fetch, calls } = stubFetch((_u, body, init) => {
    if (body.startsWith("SELECT version()") || body.startsWith("KILL")) return new Response(body.startsWith("KILL") ? "" : versionBody);
    // A response that sends the header and first row, then hangs until aborted.
    const head = fxBytes("events.jsonl").toString("utf8").split("\n").slice(0, 3).join("\n") + "\n";
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        streamCtrl = c;
        c.enqueue(new TextEncoder().encode(head));
        init.signal?.addEventListener("abort", () => c.error(init.signal!.reason));
      },
    });
    return new Response(stream);
  });
  const driver = createDriver({ fetch, newQueryId: () => "11111111-2222-3333-4444-555555555555" });
  await driver.connect(cfg);
  const ctrl = new AbortController();
  const gen = driver.execute({ sql: "SELECT * FROM events", pageSize: 1 }, ctrl.signal);
  const first = await gen.next();
  expect(first.done).toBe(false);
  const pending = gen.next();
  ctrl.abort();
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  await new Promise((r) => setTimeout(r, 0));
  const kill = calls.find((c) => c.body.startsWith("KILL"))!;
  expect(kill.body).toBe("KILL QUERY WHERE query_id = '11111111-2222-3333-4444-555555555555' ASYNC");
  expect(kill.url.searchParams.get("readonly")).toBeNull();
  expect(streamCtrl).not.toBeNull();
});

test("cancel: stopping iteration early also kills the query", async () => {
  const { fetch, calls } = stubFetch((_u, body) => new Response(body.startsWith("SELECT version()") ? versionBody : body.startsWith("KILL") ? "" : fx("events.jsonl")));
  const driver = createDriver({ fetch, newQueryId: () => "q-early" });
  await driver.connect(cfg);
  for await (const _page of driver.execute({ sql: "SELECT * FROM events", pageSize: 1 })) break;
  expect(calls.some((c) => c.body === "KILL QUERY WHERE query_id = 'q-early' ASYNC")).toBe(true);
});

test("apply: inserts as JSONEachRow; update and delete are rejected", async () => {
  const { fetch, calls } = stubFetch((_u, body) => new Response(body.startsWith("SELECT version()") ? versionBody : ""));
  const driver = createDriver({ fetch });
  await driver.connect({ ...cfg, readOnly: false });
  const res = await driver.apply({
    changes: [
      { type: "insert", table: ["analytics", "events"], values: { id: "18446744073709551615", name: "a" } },
      { type: "insert", table: ["analytics", "events"], values: { id: "3", name: null } },
    ],
  });
  expect(res.applied).toBe(2);
  const ins = calls[1]!;
  expect(ins.url.searchParams.get("query")).toBe("INSERT INTO `analytics`.`events` FORMAT JSONEachRow");
  expect(ins.url.searchParams.get("readonly")).toBeNull();
  expect(ins.body).toBe('{"id":"18446744073709551615","name":"a"}\n{"id":"3","name":null}\n');

  await expect(
    driver.apply({ changes: [{ type: "update", table: ["analytics", "events"], key: { id: "1" }, column: "name", value: "x", old: "y" }] }),
  ).rejects.toMatchObject({ name: "DriverError", code: "unsupported_change" });
  await expect(driver.apply({ changes: [{ type: "delete", table: ["analytics", "events"], key: { id: "1" } }] })).rejects.toThrow(/ALTER TABLE … DELETE/);
});

test("extractTtl reads the TTL clause from SHOW CREATE TABLE", () => {
  const ddl = "CREATE TABLE analytics.events\n(\n    `d` Date\n)\nENGINE = MergeTree\nPARTITION BY toYYYYMM(d)\nORDER BY (id, ts)\nTTL d + toIntervalYear(100)\nSETTINGS index_granularity = 8192";
  expect(extractTtl(ddl)).toBe("d + toIntervalYear(100)");
  expect(extractTtl("CREATE TABLE t (a Int8) ENGINE = Memory")).toBeUndefined();
});
