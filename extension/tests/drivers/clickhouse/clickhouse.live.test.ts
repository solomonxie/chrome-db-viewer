// @vitest-environment node
// Live test against a real ClickHouse server. Skipped unless CLICKHOUSE_URL is set, e.g.
//   docker run -d --rm --name dbui-ch -p 18123:8123 -e CLICKHOUSE_PASSWORD=test clickhouse/clickhouse-server
//   CLICKHOUSE_URL=http://localhost:18123 CLICKHOUSE_PASSWORD=test npm test -- tests/drivers/clickhouse
import { expect, test } from "vitest";
import { collect, type ConnectionConfig } from "../../../src/core/types";
import { createDriver } from "../../../src/drivers/clickhouse";

const url = process.env.CLICKHOUSE_URL;
const live = url ? test : test.skip;

const cfg = (readOnly: boolean): ConnectionConfig => ({
  id: "live",
  name: "live",
  driver: "clickhouse",
  env: "local",
  readOnly,
  options: { url, user: process.env.CLICKHOUSE_USER ?? "default", password: process.env.CLICKHOUSE_PASSWORD ?? "" },
});

live("live: types, sidebar, describe, read-only, insert, cancel", async () => {
  const rw = createDriver();
  await rw.connect(cfg(false));
  const db = "dbui_live_test";
  await collect(rw.execute({ sql: `DROP DATABASE IF EXISTS ${db}` }));
  await collect(rw.execute({ sql: `CREATE DATABASE ${db}` }));
  await collect(
    rw.execute({
      sql: `CREATE TABLE ${db}.t (id UInt64, big Int128, amount Decimal(18,4), ts DateTime64(3,'UTC'), name LowCardinality(String), note Nullable(String), d Date)
            ENGINE = MergeTree PARTITION BY toYYYYMM(d) ORDER BY id TTL d + INTERVAL 100 YEAR`,
    }),
  );
  await rw.apply({
    changes: [
      { type: "insert", table: [db, "t"], values: { id: "18446744073709551615", big: "-170141183460469231731687303715884105728", amount: "1.2345", ts: "2024-01-01 00:00:00.123", name: "a", note: null, d: "2024-01-01" } },
    ],
  });

  const { columns, rows } = await collect(rw.execute({ sql: `SELECT * FROM ${db}.t` }));
  expect(columns.map((c) => c.nullable)).toEqual([false, false, false, false, false, true, false]);
  expect(rows).toEqual([["18446744073709551615", "-170141183460469231731687303715884105728", "1.2345", "2024-01-01 00:00:00.123", "a", null, "2024-01-01"]]);

  // Params bind to {p1:Type}.
  const p = await collect(rw.execute({ sql: "SELECT {p1:UInt64} + 1 AS x", params: [41] }));
  expect(p.rows).toEqual([["42"]]);

  // Paging across many rows.
  const many = await collect(rw.execute({ sql: "SELECT number FROM numbers(4500)", pageSize: 2000 }));
  expect(many.rows).toHaveLength(4500);

  const dbs = await rw.listObjects([]);
  expect(dbs.some((n) => n.name === db)).toBe(true);
  const tables = await rw.listObjects([db]);
  expect(tables).toEqual([{ path: [db, "t"], name: "t", type: "table", hasChildren: false, meta: expect.stringMatching(/^1 rows/) }]);

  const s = await rw.describe([db, "t"]);
  expect(s.info).toMatchObject({ engine: "MergeTree", "partition key": "toYYYYMM(d)", "order by": "id", ttl: "d + toIntervalYear(100)" });
  expect(s.columns[0]).toMatchObject({ name: "id", type: "UInt64", primaryKey: true });
  expect(s.ddl).toMatch(/^CREATE TABLE dbui_live_test\.t/);

  // readonly=1 is enforced by the server.
  const ro = createDriver();
  await ro.connect(cfg(true));
  await expect(collect(ro.execute({ sql: `INSERT INTO ${db}.t (id) VALUES (1)` }))).rejects.toMatchObject({ code: "READONLY" });

  // readonly=1 also forbids SETTINGS clauses in the query (URL-level settings still apply).
  await expect(collect(ro.execute({ sql: "SELECT 1 SETTINGS max_block_size = 1" }))).rejects.toMatchObject({ code: "READONLY" });

  // Cancel a long query; it must disappear from system.processes.
  const ctrl = new AbortController();
  const queryId = crypto.randomUUID();
  const slow = collect(rw.execute({ sql: "SELECT sleepEachRow(1) FROM numbers(30) SETTINGS max_block_size = 1", options: { queryId } }, ctrl.signal));
  await new Promise((r) => setTimeout(r, 700));
  ctrl.abort();
  await expect(slow).rejects.toMatchObject({ code: "cancelled" });
  let running = 1;
  for (let i = 0; i < 20 && running; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const r = await collect(rw.execute({ sql: `SELECT count() FROM system.processes WHERE query_id = '${queryId}'` }));
    running = Number(r.rows[0]![0]);
  }
  expect(running).toBe(0);

  await collect(rw.execute({ sql: `DROP DATABASE ${db}` }));
}, 30_000);
