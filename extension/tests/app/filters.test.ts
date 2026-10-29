import { expect, test } from "vitest";
import type { Column } from "@core/types";
import { bigqueryDialect, clickhouseDialect, duckdbDialect, postgresDialect } from "@core/sql";
import { buildSelect, compileFilter, compileWhere, parseReference, RAW_SQL, tableRef, type FilterRow } from "../../src/app/lib/filters";

const columns: Column[] = [
  { name: "id", type: "int8", nullable: false, primaryKey: true },
  { name: "status", type: "text", nullable: false },
  { name: "total", type: "numeric(10,2)", nullable: false },
  { name: "paid", type: "bool", nullable: false },
  { name: "metadata", type: "jsonb", nullable: true },
  { name: "user id", type: "Nullable(UInt64)", nullable: true },
];

let seq = 0;
const row = (p: Partial<FilterRow>): FilterRow => ({ id: ++seq, enabled: true, column: "status", op: "=", value: "", ...p });

test("equality on text quotes the value", () => {
  expect(compileFilter(row({ value: "paid" }), columns, postgresDialect)).toBe(`"status" = 'paid'`);
});

test("numbers stay unquoted on numeric columns", () => {
  expect(compileFilter(row({ column: "total", op: ">", value: "100" }), columns, postgresDialect)).toBe(`"total" > 100`);
  expect(compileFilter(row({ column: "user id", op: "=", value: "42" }), columns, clickhouseDialect)).toBe("`user id` = 42");
});

test("non-numeric input on a numeric column is quoted, not injected", () => {
  expect(compileFilter(row({ column: "id", value: "1 or 1=1" }), columns, postgresDialect)).toBe(`"id" = '1 or 1=1'`);
});

test("quotes inside values are escaped per dialect", () => {
  expect(compileFilter(row({ value: "o'neil" }), columns, postgresDialect)).toBe(`"status" = 'o''neil'`);
  expect(compileFilter(row({ value: "o'neil" }), columns, clickhouseDialect)).toBe("`status` = 'o\\'neil'");
});

test("booleans and NULL", () => {
  expect(compileFilter(row({ column: "paid", value: "true" }), columns, postgresDialect)).toBe(`"paid" = TRUE`);
  expect(compileFilter(row({ value: "NULL" }), columns, postgresDialect)).toBe(`"status" IS NULL`);
  expect(compileFilter(row({ op: "!=", value: "null" }), columns, postgresDialect)).toBe(`"status" IS NOT NULL`);
  expect(compileFilter(row({ op: "is_null" }), columns, postgresDialect)).toBe(`"status" IS NULL`);
  expect(compileFilter(row({ op: "is_not_null" }), columns, postgresDialect)).toBe(`"status" IS NOT NULL`);
});

test("contains and starts with escape LIKE wildcards", () => {
  expect(compileFilter(row({ op: "contains", value: "50%_off" }), columns, postgresDialect)).toBe(`"status" LIKE '%50\\%\\_off%'`);
  expect(compileFilter(row({ op: "starts_with", value: "pa" }), columns, duckdbDialect)).toBe(`"status" LIKE 'pa%' ESCAPE '\\'`);
});

test("contains on a non-text column casts per dialect", () => {
  expect(compileFilter(row({ column: "metadata", op: "contains", value: "web" }), columns, postgresDialect)).toBe(`CAST("metadata" AS TEXT) LIKE '%web%'`);
  expect(compileFilter(row({ column: "id", op: "contains", value: "4" }), columns, clickhouseDialect)).toBe("toString(`id`) LIKE '%4%'");
  expect(compileFilter(row({ column: "id", op: "contains", value: "4" }), columns, bigqueryDialect)).toBe("CAST(`id` AS STRING) LIKE '%4%'");
});

test("in splits on commas", () => {
  expect(compileFilter(row({ op: "in", value: "paid, pending ,'refunded'" }), columns, postgresDialect)).toBe(`"status" IN ('paid', 'pending', 'refunded')`);
  expect(compileFilter(row({ column: "id", op: "in", value: "1,2,3" }), columns, postgresDialect)).toBe(`"id" IN (1, 2, 3)`);
});

test("between with two boxes or one", () => {
  expect(compileFilter(row({ column: "total", op: "between", value: "10", value2: "20" }), columns, postgresDialect)).toBe(`"total" BETWEEN 10 AND 20`);
  expect(compileFilter(row({ column: "total", op: "between", value: "10 and 20" }), columns, postgresDialect)).toBe(`"total" BETWEEN 10 AND 20`);
  expect(compileFilter(row({ column: "total", op: "between", value: "10" }), columns, postgresDialect)).toBeNull();
});

test("raw SQL is wrapped in parentheses", () => {
  expect(compileFilter(row({ column: RAW_SQL, value: "total > 5 or paid" }), columns, postgresDialect)).toBe("(total > 5 or paid)");
  expect(compileFilter(row({ column: RAW_SQL, value: "  " }), columns, postgresDialect)).toBeNull();
});

test("incomplete rows are skipped", () => {
  expect(compileFilter(row({ column: "total", op: ">", value: "" }), columns, postgresDialect)).toBeNull();
  expect(compileFilter(row({ column: "" }), columns, postgresDialect)).toBeNull();
});

test("compileWhere joins enabled rows with AND or OR", () => {
  const rows = [
    row({ value: "paid" }),
    row({ column: "total", op: ">", value: "100" }),
    row({ column: "paid", value: "false", enabled: false }),
    row({ column: "total", op: "<", value: "" }),
  ];
  expect(compileWhere(rows, columns, postgresDialect)).toBe(`"status" = 'paid' AND "total" > 100`);
  expect(compileWhere(rows, columns, postgresDialect, "OR")).toBe(`"status" = 'paid' OR "total" > 100`);
  expect(compileWhere([], columns, postgresDialect)).toBe("");
});

test("buildSelect adds where, order, limit and offset", () => {
  const sql = buildSelect(
    { table: `"public"."orders"`, where: `"total" > 100`, sort: [{ column: "created_at", dir: "desc" }], limit: 200, offset: 400 },
    postgresDialect,
  );
  expect(sql).toBe(`SELECT * FROM "public"."orders" WHERE "total" > 100 ORDER BY "created_at" DESC LIMIT 200 OFFSET 400`);
  expect(buildSelect({ table: "t" }, postgresDialect)).toBe("SELECT * FROM t");
});

test("tableRef drops grouping nodes from tree paths", () => {
  expect(tableRef(["public", "tables", "orders"], [1], postgresDialect)).toBe(`"public"."orders"`);
  expect(tableRef(["analytics", "events"], [], clickhouseDialect)).toBe("`analytics`.`events`");
});

test("parseReference splits table and column", () => {
  expect(parseReference("customers.id")).toEqual({ table: "customers", column: "id" });
  expect(parseReference("public.customers.id")).toEqual({ table: "public.customers", column: "id" });
  expect(parseReference("nodot")).toBeNull();
});
