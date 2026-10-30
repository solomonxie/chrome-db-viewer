import { expect, test } from "vitest";
import { analyze, bindSqlParams, detectSqlParams, render } from "../../src/collections/render";
import { libraryFromRows } from "../../src/collections/store";
import { loadCollectionFixture, template } from "./fixtures";

const fx = loadCollectionFixture();
const library = libraryFromRows(fx.folders, fx.queries);
const vars = {
  dataset: "production__4c1e7a2b_8d3f_4e5a_9b6c_1a2b3c4d5e6f",
  start_date: "2026-10-01",
  end_date: "2026-10-07",
  account_id: 4242,
  model: "",
};

test("sql filter: strings, numbers, null, booleans per dialect", () => {
  const t = "{{ s | sql }} {{ n | sql }} {{ z | sql }} {{ b | sql }}";
  const v = { s: "it's \\ x", n: 3.5, z: null, b: true };
  expect(render(t, { dialect: "bigquery", vars: v }).sql).toBe("'it\\'s \\\\ x' 3.5 NULL TRUE");
  expect(render(t, { dialect: "postgres", vars: v }).sql).toBe("'it''s \\ x' 3.5 NULL TRUE");
  expect(render(t, { dialect: "duckdb", vars: v }).sql).toBe("'it''s \\ x' 3.5 NULL TRUE");
});

test("sql filter: dates become DATE literals for bigquery, postgres and duckdb", () => {
  const t = "{{ d | sql }} | {{ s | sql('date') }} | {{ s | sql }}";
  const v = { d: new Date("2026-10-01T00:00:00Z"), s: "2026-10-02" };
  expect(render(t, { dialect: "bigquery", vars: v }).sql).toBe("DATE '2026-10-01' | DATE '2026-10-02' | '2026-10-02'");
  expect(render(t, { dialect: "postgres", vars: v }).sql).toBe("DATE '2026-10-01' | DATE '2026-10-02' | '2026-10-02'");
  expect(render(t, { dialect: "duckdb", vars: v }).sql).toBe("DATE '2026-10-01' | DATE '2026-10-02' | '2026-10-02'");
  expect(render(t, { dialect: "sqlite", vars: v }).sql).toBe("'2026-10-01' | '2026-10-02' | '2026-10-02'");
});

test("sql filter rejects lists; sql_list and ident quote per dialect", () => {
  expect(() => render("{{ ids | sql }}", { dialect: "bigquery", vars: { ids: [1, 2] } })).toThrow(/sql_list/);
  expect(render("IN {{ ids | sql_list }}", { dialect: "bigquery", vars: { ids: ["a", "b'c"] } }).sql).toBe("IN ('a', 'b\\'c')");
  expect(render("IN {{ ids | sql_list }}", { dialect: "postgres", vars: { ids: [1, 2, 3] } }).sql).toBe("IN (1, 2, 3)");
  expect(render("IN {{ ids | sql_list }}", { dialect: "duckdb", vars: { ids: [] } }).sql).toBe("IN (NULL)");
  expect(render("{{ t | ident }}", { dialect: "bigquery", vars: { t: "my`table" } }).sql).toBe("`my\\`table`");
  expect(render("{{ t | ident }}", { dialect: "postgres", vars: { t: 'Order "x"' } }).sql).toBe('"Order ""x"""');
  expect(render("{{ t | ident }}", { dialect: "duckdb", vars: { t: "events" } }).sql).toBe('"events"');
});

test("var() falls back to its default, and a missing sql value is an error naming it", () => {
  expect(render("LIMIT {{ var('limit', 20) }}", { dialect: "postgres", vars: {} }).sql).toBe("LIMIT 20");
  expect(render("LIMIT {{ var('limit', 20) }}", { dialect: "postgres", vars: { limit: 5 } }).sql).toBe("LIMIT 5");
  expect(() => render("x = {{ client_id | sql }}", { dialect: "postgres", vars: {} })).toThrow(/client_id/);
});

test("nested include pastes rendered SQL and shares variables", () => {
  const r = render(template("ad_report_daily"), { dialect: "bigquery", vars, library });
  expect(r.includes).toEqual(["Base/sales_metrics", "Base/fb_ads"]);
  expect(r.sql).toContain("FROM `acme-prod`.production__4c1e7a2b_8d3f_4e5a_9b6c_1a2b3c4d5e6f.sales");
  expect(r.sql).toContain("WHERE localdate BETWEEN '2026-10-01' AND '2026-10-07'");
  expect(r.sql).toContain("WHERE account_id = 4242");
  expect(r.sql).not.toContain("{%");
  expect(r.sql).not.toContain("WHERE s.model");
});

test("include cycles are an error naming the loop", () => {
  expect(() => render(template("cycle_a"), { dialect: "postgres", vars: {}, library }, "Loop/cycle_a")).toThrow(
    "Include cycle: Loop/cycle_a → Loop/cycle_b → Loop/cycle_c → Loop/cycle_a",
  );
  // Without knowing its own path, the loop is found one step later.
  expect(() => render(template("cycle_a"), { dialect: "postgres", vars: {}, library })).toThrow(/Include cycle: Loop\/cycle_b → Loop\/cycle_c → Loop\/cycle_a → Loop\/cycle_b/);
  expect(() => render('{% include "Nope/x" %}', { dialect: "postgres", vars: {}, library })).toThrow(/no query at that path/);
});

test("ref() inlines the referenced query as a subquery by default", () => {
  const r = render(template("top_ads_by_roas"), { dialect: "bigquery", vars, library });
  expect(r.refs).toEqual(["ad_report_daily"]);
  expect(r.sql).toMatch(/FROM \(\nWITH sales AS \(/);
  expect(r.sql).toContain(") AS cd");
  expect(r.sql).toContain("LIMIT 20");
  // Variables of the inlined query count as this query's.
  expect(r.usedVars).toEqual(expect.arrayContaining(["dataset", "start_date", "end_date", "account_id", "model", "limit"]));
  expect(r.includes).toEqual(["Base/sales_metrics", "Base/fb_ads"]);
});

test("ref() with a custom resolver uses its table name", () => {
  const r = render(template("top_ads_by_roas"), { dialect: "duckdb", vars: {}, library, ref: (n) => `step_${n}` });
  expect(r.sql).toContain("FROM step_ad_report_daily AS cd");
  expect(r.refs).toEqual(["ad_report_daily"]);
  expect(r.usedVars).toEqual(["limit"]);
});

test("usedVars walks includes, in first-use order, skipping loop and set names", () => {
  const r = analyze(template("ad_report_daily"), { dialect: "bigquery", vars: {}, library });
  expect(r.usedVars).toEqual(["dataset", "start_date", "end_date", "account_id", "model"]);
  const own = analyze("{% set n = 3 %}{% for c in cols %}{{ c }}{{ n }}{% endfor %}{{ var('days', 7) }}", { dialect: "postgres", vars: {} });
  expect(own.usedVars).toEqual(["cols", "days"]);
  expect(own.varDefaults).toEqual({ days: 7 });
});

test("raw {{ x }} in a value position or inside quotes is warned about", () => {
  const r = analyze(template("injection"), { dialect: "postgres", vars: {} });
  expect(r.warnings.map((w) => w.varName)).toEqual(["status", "needle"]);
  expect(r.warnings[0]!.message).toMatch(/\| sql/);
  expect(r.warnings[1]!.message).toMatch(/quoted string/);
});

test("detectSqlParams ignores strings, quoted identifiers and comments", () => {
  expect(detectSqlParams(template("params_bigquery"), "bigquery").map((p) => p.name)).toEqual(["start_date", "end_date"]);
  expect(detectSqlParams(template("params_postgres"), "postgres").map((p) => p.key)).toEqual(["$1", "$2"]);
  expect(detectSqlParams(template("params_sqlite"), "sqlite").map((p) => p.key)).toEqual(["?1", "?2"]);
  expect(detectSqlParams(template("params_sqlite"), "duckdb")).toHaveLength(2);
  expect(detectSqlParams(template("params_postgres"), "bigquery")).toEqual([]);
});

test("bindSqlParams sends values as positional params", () => {
  const bq = bindSqlParams(template("params_bigquery"), "bigquery", { "@start_date": "2026-10-01", "@end_date": "2026-10-08" });
  expect(bq.params).toEqual(["2026-10-01", "2026-10-01", "2026-10-08"]);
  expect(bq.sql).toContain("? AS d");
  expect(bq.sql).toContain("'@also_not'");
  const pg = bindSqlParams(template("params_postgres"), "postgres", { $1: "2026-01-01", $2: "paid" });
  expect(pg.params).toEqual(["2026-01-01", "paid"]);
  expect(() => bindSqlParams("a = ?", "sqlite", {})).toThrow(/\?1/);
});

test("template highlighting keeps every character and marks Jinja tags", async () => {
  const { tokenizeTemplate } = await import("../../src/collections/highlight");
  const src = template("injection") + template("ad_report_daily");
  const toks = tokenizeTemplate(src);
  expect(toks.map((t) => t.text).join("")).toBe(src);
  expect(toks.filter((t) => t.kind === "jinja-warn").map((t) => t.text)).toEqual(["{{ status }}", "{{ needle }}"]);
  expect(toks.some((t) => t.kind === "jinja" && t.text === '{% include "Base/sales_metrics" %}')).toBe(true);
  expect(toks.some((t) => t.kind === "kw" && t.text === "SELECT")).toBe(true);
});

test("requiredVars leaves out names only tested in {% if %} or given a var() default", () => {
  const r = analyze(template("ad_report_daily") + "\nLIMIT {{ var('limit', 10) }}", { dialect: "bigquery", vars: {}, library });
  expect(r.usedVars).toContain("model");
  expect(r.usedVars).toContain("limit");
  expect(r.requiredVars).toEqual(["dataset", "start_date", "end_date", "account_id"]);
  const onlyTested = analyze("SELECT 1 {% if region %}AND 1=1{% endif %}", { dialect: "postgres", vars: {} });
  expect(onlyTested.requiredVars).toEqual([]);
});
