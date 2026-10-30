// @vitest-environment node
import { expect, test } from "vitest";
import { evaluate, ExprError, exprVariables } from "../../src/chains/expr";
import type { ResultTable } from "../../src/collections/model";
import { BQ_TABLES } from "./helpers";

const sales = BQ_TABLES.ads_daily as ResultTable;
const ctx = { table: (n: string) => (n === "sales" ? sales : undefined), vars: { limit: 3, ids: ["a", "b"] } };
const ev = (s: string) => evaluate(s, ctx);

test("table functions over a step's result", () => {
  expect(ev(`column("sales", "ad_hash")`)).toEqual(["a1", "a2", "a3", "a4"]);
  expect(ev(`first("sales", "localdate")`)).toBe("2026-10-27");
  expect(ev(`max("sales", "revenue")`)).toBe(300);
  expect(ev(`min("sales", "localdate")`)).toBe("2026-10-27");
  expect(ev(`count("sales")`)).toBe(4);
  expect(ev(`count("sales", "revenue")`)).toBe(3);
  expect(ev(`nulls("sales", "revenue")`)).toBe(1);
  expect(ev(`sum("sales", "spend")`)).toBe(160);
  expect(ev(`distinct("sales", "localdate")`)).toEqual(["2026-10-27", "2026-10-28"]);
});

test("literals, operators, variables and inputs", () => {
  expect(ev(`{"a": [1, 2.5, "x", true, null]}`)).toEqual({ a: [1, 2.5, "x", true, null] });
  expect(ev(`count("sales") > 0 && nulls("sales", "ad_hash") == 0`)).toBe(true);
  expect(ev(`not (limit >= 3) or len(ids) == 2`)).toBe(true);
  expect(ev(`inputs.sales.rowCount * 2 - 1`)).toBe(7);
  expect(ev(`vars.ids`)).toEqual(["a", "b"]);
  expect(ev(`"n=" + count("sales")`)).toBe("n=4");
});

test("errors are clear and nothing is eval'd", () => {
  expect(() => ev(`column("nope", "x")`)).toThrow(`Step "nope" has no result table`);
  expect(() => ev(`column("sales", "x")`)).toThrow(/no column "x"/);
  expect(() => ev(`fetch("http://x")`)).toThrow("Unknown function fetch()");
  expect(() => ev(`constructor.constructor("alert(1)")()`)).toThrow(ExprError);
  expect(() => ev(`count("sales") >`)).toThrow("Expression is incomplete");
});

test("exprVariables lists the variables an expression reads", () => {
  expect(exprVariables(`len(ids) > limit && vars.other && count("sales") > 0`).sort()).toEqual(["ids", "limit", "other"]);
});
