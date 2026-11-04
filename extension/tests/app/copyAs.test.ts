// "Copy as" formats per engine, from the saved connections in tests/fixtures/app/connections.json
// and tests/fixtures/app/remembered-connection.json.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import type { SavedConnection } from "../../src/app/store/db";
import { copyFormats } from "../../src/app/lib/copyAs";

const CONNS: SavedConnection[] = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/app/connections.json"), "utf8"));
const BQ: SavedConnection = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/app/remembered-connection.json"), "utf8")).connection;
const conn = (id: string) => CONNS.find((c) => c.id === id)!;
const text = (formats: { id: string; text: string }[], id: string) => formats.find((f) => f.id === id)?.text;

test("postgres: URL, psql, JDBC and PG env vars; the password only when given", () => {
  const f = copyFormats(conn("pg_orders"));
  expect(text(f, "url")).toBe("postgresql://reader@orders.db.internal:5432/orders");
  expect(text(f, "url-pw")).toBeUndefined();
  expect(text(f, "jdbc")).toBe("jdbc:postgresql://orders.db.internal:5432/orders?user=reader");
  expect(text(f, "env")).toBe("export PGHOST=orders.db.internal\nexport PGPORT=5432\nexport PGUSER=reader\nexport PGDATABASE=orders");
  expect(text(copyFormats(conn("pg_orders"), "p@ss w"), "url-pw")).toBe("postgresql://reader:p%40ss%20w@orders.db.internal:5432/orders");
});

test("clickhouse: HTTP URL, clickhouse client with --secure for https", () => {
  const f = copyFormats(conn("ch_events"));
  expect(text(f, "url")).toBe("https://ch.example.test:8443/?database=events");
  expect(text(f, "cli")).toBe("clickhouse client --host ch.example.test --user default --database events --secure");
});

test("bigquery: bq command, console link and gcloud for the billing project", () => {
  const f = copyFormats(BQ);
  expect(text(f, "bq")).toBe("bq query --use_legacy_sql=false --project_id=acme-analytics 'SELECT 1'");
  expect(text(f, "console")).toBe("https://console.cloud.google.com/bigquery?project=acme-analytics");
  expect(text(f, "gcloud")).toBe("gcloud config set project acme-analytics");
});
