import { expect, test } from "vitest";
import { applySuggestions, suggestVariables } from "../../src/collections/literals";
import { render } from "../../src/collections/render";
import { readFixture } from "./fixtures";

const sql = readFixture("history_bigquery.sql");

test("suggestVariables finds dates, strings, lists, numbers and the tenant dataset", () => {
  const s = suggestVariables(sql, "bigquery");
  expect(s.map((x) => [x.name, x.kind, x.value])).toEqual([
    ["client_id", "dataset", "4c1e7a2b_8d3f_4e5a_9b6c_1a2b3c4d5e6f"],
    ["start_date", "date", "2026-10-01"],
    ["end_date", "date", "2026-10-07"],
    ["attribution_model", "string", "last_touch"],
    ["platforms", "list", ["facebook", "tiktok"]],
    ["spend", "number", 100],
    ["limit", "number", 50],
  ]);
  expect(s.every((x) => x.selected)).toBe(true);
  expect(s.find((x) => x.name === "start_date")!.type).toBe("date");
});

test("literals with no column get value_n, and repeats of one value share a name", () => {
  const s = suggestVariables("SELECT 'a' AS x, 'b' AS y FROM t WHERE c = 'z' OR c = 'z' OR c = 'q'", "postgres");
  expect(s.map((x) => x.name)).toEqual(["value_1", "value_2", "c", "c", "c_2"]);
  expect(s.filter((x) => x.selected).map((x) => x.text)).toEqual(["'z'", "'z'", "'q'"]);
});

test("applySuggestions rewrites to Jinja with the old values as defaults, and renders back", () => {
  const chosen = suggestVariables(sql, "bigquery")
    .filter((x) => x.name !== "spend")
    .map((x) => (x.name === "attribution_model" ? { ...x, name: "model" } : x));
  const out = applySuggestions(sql, chosen);
  expect(out.sql).toContain("`acme-prod.production__{{ client_id }}.attribution_daily`");
  expect(out.sql).toContain("WHERE localdate >= {{ start_date | sql }}");
  expect(out.sql).toContain("AND localdate <= {{ end_date | sql }}");
  expect(out.sql).toContain("attribution_model = {{ model | sql }}");
  expect(out.sql).toContain("platform IN {{ platforms | sql_list }}");
  expect(out.sql).toContain("spend > 100");
  expect(out.sql).toContain("LIMIT {{ limit | sql }}");
  expect(out.vars).toEqual([
    { name: "client_id", type: "string", value: "4c1e7a2b_8d3f_4e5a_9b6c_1a2b3c4d5e6f" },
    { name: "start_date", type: "date", value: "2026-10-01" },
    { name: "end_date", type: "date", value: "2026-10-07" },
    { name: "model", type: "string", value: "last_touch" },
    { name: "platforms", type: "list", value: ["facebook", "tiktok"] },
    { name: "limit", type: "number", value: 50 },
  ]);
  // With the defaults, the template renders back to the original statement.
  const vars = Object.fromEntries(out.vars.map((v) => [v.name, v.value]));
  expect(render(out.sql, { dialect: "bigquery", vars }).sql).toBe(sql.replace(/\n$/, ""));
});

test("applySuggestions refuses an invalid name", () => {
  const [first] = suggestVariables("SELECT * FROM t WHERE a = 1", "postgres");
  expect(() => applySuggestions("SELECT * FROM t WHERE a = 1", [{ ...first!, name: "1bad" }])).toThrow(/valid variable name/);
});
