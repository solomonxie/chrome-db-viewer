import { expect, test } from "vitest";
import { duckdbDialect } from "@core/sql";
import { cycleSort, equalsCondition, filteredSheet, querySheet, sheetSql, sourceSheet, summarySheet } from "../../src/app/file/sheets";

const src = sourceSheet("orders.csv");

test("source sheet selects with sort and limit", () => {
  expect(sheetSql({ kind: "source", title: "t", where: [], sort: [{ column: "total", dir: "desc" }] }, "orders.csv", duckdbDialect, 100)).toBe(`SELECT * FROM "orders.csv" ORDER BY "total" DESC LIMIT 100`);
});

test("summary uses SUMMARIZE, wrapping a filtered select", () => {
  expect(sheetSql(summarySheet(src), "t", duckdbDialect)).toBe(`SUMMARIZE "t"`);
  expect(sheetSql(summarySheet(filteredSheet(src, "a > 1", "a")), "t", duckdbDialect)).toBe(`SUMMARIZE SELECT * FROM "t" WHERE a > 1`);
});

test("stacked filters are parenthesised and ANDed", () => {
  const s = filteredSheet(filteredSheet(src, "a = 1 OR b = 2", "x"), "c IS NULL", "y");
  expect(sheetSql(s, "t", duckdbDialect)).toBe(`SELECT * FROM "t" WHERE (a = 1 OR b = 2) AND (c IS NULL)`);
});

test("equalsCondition handles null, numbers and strings", () => {
  expect(equalsCondition("s", null, duckdbDialect)).toBe(`"s" IS NULL`);
  expect(equalsCondition("n", 5, duckdbDialect)).toBe(`"n" = 5`);
  expect(equalsCondition("s", "o'k", duckdbDialect)).toBe(`"s" = 'o''k'`);
});

test("cycleSort goes asc, desc, off", () => {
  let s = cycleSort([], "a", false);
  expect(s).toEqual([{ column: "a", dir: "asc" }]);
  s = cycleSort(s, "a", false);
  expect(s).toEqual([{ column: "a", dir: "desc" }]);
  expect(cycleSort(s, "a", false)).toEqual([]);
  expect(cycleSort([{ column: "a", dir: "asc" }], "b", true)).toEqual([{ column: "a", dir: "asc" }, { column: "b", dir: "asc" }]);
});

test("a query sheet runs the typed SQL as is and titles itself with a short one-line form", () => {
  const sql = `SELECT ad_name, count(*)\n  FROM "orders.csv"\n GROUP BY 1 ORDER BY 2 DESC`;
  const s = querySheet(sql + "\n");
  expect(sheetSql(s, "orders.csv", duckdbDialect)).toBe(sql);
  expect(s.title).toBe('SELECT ad_name, count(*) FROM "orders.c…');
  expect(s.title).toHaveLength(40);
});
