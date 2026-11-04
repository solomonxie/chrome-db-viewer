// The text form of Set variables steps: SET name = value lines ⇄ the step's assignments.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { formatSetText, parseSetText, sqlSubquery } from "../../src/chains/setText";
import { subqueryValue } from "../../src/chains/runner";

const CHAIN = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/chains/set_vars_sql.json"), "utf8"));
const PICK: Record<string, string> = CHAIN.steps[2].assignments;

test("format then parse gives the same assignments, multi-line subqueries included", () => {
  const text = formatSetText(PICK);
  expect(text.split("\n")[0]).toBe(`SET big_ids = ${PICK.big_ids}`);
  expect(parseSetText(text)).toEqual({ assignments: PICK });
  const multi = 'SET ids = (\n  SELECT id\n  FROM {{ ref("x") }}\n);\n-- a note\nset Label := "a"';
  expect(parseSetText(multi)).toEqual({ assignments: { ids: '(\n  SELECT id\n  FROM {{ ref("x") }}\n)', Label: '"a"' } });
});

test("mistakes name their line", () => {
  expect(parseSetText("SET a = 1\nSET b =").error).toEqual({ line: 2, message: "b has no value after =" });
  expect(parseSetText("a = 1").error).toEqual({ line: 1, message: "Each variable starts with SET name = …" });
  expect(parseSetText("SET 1a = 2").error).toEqual({ line: 1, message: "Write it as SET name = value" });
  expect(parseSetText("SET a = 1\nSET a = 2").error).toEqual({ line: 2, message: "a is set twice" });
});

test("only parenthesised SELECT/WITH is SQL; it must give one row and one column", () => {
  expect(sqlSubquery(PICK.total!)).toBe(`SELECT sum(revenue) FROM {{ ref("sales") }}`);
  expect(sqlSubquery("(1 + 2)")).toBeNull();
  expect(sqlSubquery('len(big_ids)')).toBeNull();
  const col = [{ name: "a", type: "INTEGER", nullable: true }];
  expect(subqueryValue({ columns: col, rows: [[1]] })).toBe(1);
  expect(() => subqueryValue({ columns: col, rows: [[1], [2]] })).toThrow("the query returns 2 rows; it must return one");
  expect(() => subqueryValue({ columns: col, rows: [] })).toThrow("the query returns 0 rows");
  expect(() => subqueryValue({ columns: [...col, { name: "b", type: "VARCHAR", nullable: true }], rows: [[1, "x"]] })).toThrow("the query returns 2 columns; it must return one");
  // list() over no rows is NULL in DuckDB: read as an empty list.
  expect(subqueryValue({ columns: [{ name: "l", type: "VARCHAR[]", nullable: true }], rows: [[null]] })).toEqual([]);
  expect(subqueryValue({ columns: [{ name: "l", type: "VARCHAR[]", nullable: true }], rows: [[["a", "b"]]] })).toEqual(["a", "b"]);
});
