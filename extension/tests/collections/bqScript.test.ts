// BigQuery scripts: DECLARE/SET statements are sent in one job with the query that uses them.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { asScript, isScriptSetup, isWholeScript, needsScript, scriptFor } from "../../src/collections/bqScript";
import { splitStatementsRaw } from "../../src/collections/split";

const SCRIPT = splitStatementsRaw(readFileSync(resolve(__dirname, "../fixtures/sql/bq-declare-script.sql"), "utf8"));

test("DECLARE, SET and CREATE TEMP FUNCTION are setup; a leading comment doesn't hide them", () => {
  expect(SCRIPT.map(isScriptSetup)).toEqual([true, true, false, false]);
  expect(isScriptSetup("create temp function f(x INT64) AS (x + 1)")).toBe(true);
  expect(isScriptSetup("CREATE TABLE t AS SELECT 1")).toBe(false);
  expect(needsScript(SCRIPT)).toBe(true);
  expect(needsScript(["SELECT 1", "SELECT 2"])).toBe(false);
});

test("Run on a query takes the DECLAREs and SETs above it along", () => {
  expect(scriptFor(SCRIPT, 3)).toBe([SCRIPT[0], SCRIPT[1], SCRIPT[3]].join(";\n"));
  expect(scriptFor(SCRIPT, 0)).toBe(SCRIPT[0]);
  expect(scriptFor(["SELECT 1", "SELECT 2"], 1)).toBe("SELECT 2");
});

test("Run all sends the whole text as one script", () => {
  const whole = asScript(SCRIPT);
  expect(splitStatementsRaw(whole)).toEqual(SCRIPT);
  expect(isWholeScript([whole])).toBe(true);
  expect(isWholeScript(SCRIPT)).toBe(false);
});
