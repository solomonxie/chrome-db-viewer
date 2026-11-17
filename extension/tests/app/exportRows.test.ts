// Query results export: CSV/TSV quoting, NULL as empty, JSON values kept as JSON, duplicate
// column names kept apart in JSON, and the file name.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import type { Cell, Column } from "../../src/core/types";
import { exportName, rowsToText } from "../../src/app/lib/exportRows";

const FX: { columns: Column[]; rows: Cell[][] } = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/app/export-rows.json"), "utf8"));

test("CSV quotes commas, quotes and line breaks; NULL is empty; objects are JSON", () => {
  expect(rowsToText(FX.columns, FX.rows, "csv")).toBe(
    'id,note,meta,id\n1,plain,"{""a"":1}",10\n2,"has, comma and ""quote""\nnew line",,\n3,tab\there,"[1,2]",30\n',
  );
});

test("TSV quotes the tab, not the comma", () => {
  const lines = rowsToText(FX.columns, FX.rows, "tsv").split("\n");
  expect(lines[0]).toBe("id\tnote\tmeta\tid");
  expect(lines[1]).toBe('1\tplain\t"{""a"":1}"\t10');
  expect(lines.at(-2)).toBe('3\t"tab\there"\t[1,2]\t30');
});

test("JSON and JSON Lines keep types and nulls; a repeated column name becomes name_2", () => {
  const arr = JSON.parse(rowsToText(FX.columns, FX.rows, "json"));
  expect(arr[0]).toEqual({ id: 1, note: "plain", meta: { a: 1 }, id_2: 10 });
  expect(arr[1].meta).toBeNull();
  const lines = rowsToText(FX.columns, FX.rows, "jsonl").trim().split("\n");
  expect(lines).toHaveLength(3);
  expect(JSON.parse(lines[2]!)).toEqual({ id: 3, note: "tab\there", meta: [1, 2], id_2: 30 });
});

test("the file is named after the tab and the day", () => {
  expect(exportName("Orders by day", "csv", new Date("2026-11-13T10:00:00Z"))).toBe("Orders_by_day_2026-11-13.csv");
  expect(exportName("a/b:c", "jsonl", new Date("2026-11-13T10:00:00Z"))).toBe("a_b_c_2026-11-13.jsonl");
});
