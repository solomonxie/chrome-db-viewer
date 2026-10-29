import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { formatRange, formatSql, tokenize } from "../../src/app/lib/sqlFormat";

const sql = readFileSync(resolve(__dirname, "../fixtures/sql/orders-report.sql"), "utf8");
const kinds = (text: string) => tokenize(text).filter((t) => t.kind !== "text" && t.kind !== "op").map((t) => `${t.kind}:${t.text}`);

test("tokenize gives back the exact input", () => {
  expect(tokenize(sql).map((t) => t.text).join("")).toBe(sql);
});

test("tokenize marks keywords, functions, strings, numbers, comments and params", () => {
  const k = kinds(sql);
  expect(k).toContain("com:-- weekly paid orders per customer");
  expect(k).toContain("com:/* second statement */");
  expect(k).toContain("kw:select");
  expect(k).toContain("kw:group");
  expect(k).toContain("fn:count");
  expect(k).toContain("fn:sum");
  expect(k).toContain("str:'paid'");
  expect(k).toContain("str:'it''s'");
  expect(k).toContain("num:3.5e2");
  expect(k).toContain("param:$1");
  expect(k).toContain("ident:`weird name`");
  // Column names stay plain text.
  expect(k).not.toContain("kw:email");
});

test("an unterminated string doesn't swallow or drop text", () => {
  const text = "select 'abc\nfrom t";
  expect(tokenize(text).map((t) => t.text).join("")).toBe(text);
});

test("formatSql uppercases keywords and puts clauses on their own lines", () => {
  const out = formatSql("select a, b from t where x = 1", "postgres");
  expect(out).toBe("SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  x = 1");
});

test("formatSql uses the connection's dialect", () => {
  const out = formatSql("select * from `p.d.t` where d >= @start", "bigquery");
  expect(out).toContain("`p.d.t`");
  expect(out).toContain("@start");
});

test("formatRange formats only the selection and keeps the text around it", () => {
  const text = "-- keep me\nselect a from t;\nselect b from u;";
  const start = text.indexOf("select a");
  const end = text.indexOf(";") ;
  const r = formatRange(text, start, end, "postgres");
  expect(r.text).toBe("-- keep me\nSELECT\n  a\nFROM\n  t;\nselect b from u;");
  expect(r.text.slice(r.start, r.end)).toBe("SELECT\n  a\nFROM\n  t");
});

test("formatRange formats everything when nothing is selected", () => {
  const r = formatRange("select 1;select 2", 3, 3, "sqlite");
  expect(r.text).toBe("SELECT\n  1;\n\nSELECT\n  2");
  expect([r.start, r.end]).toEqual([0, r.text.length]);
});

test("formatting a Redis connection explains it isn't available", () => {
  expect(() => formatSql("GET k", "redis")).toThrow(/isn't available/);
});
