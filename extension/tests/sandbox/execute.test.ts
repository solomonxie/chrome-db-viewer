import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import type { ResultTable, SandboxRequest, SandboxResponse } from "../../src/collections/model";
import { executeScript, hardenGlobals, MAX_LOG_LINES } from "../../src/sandbox/execute";
import { runPostScripts, runPreScripts } from "../../src/sandbox/client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => readFileSync(resolve(__dirname, "../fixtures/sandbox", name), "utf8");
const fxTable = (name: string) => JSON.parse(fx(name)) as ResultTable;
const now = () => new Date(2026, 9, 29, 12, 0, 0);

const pre = (code: string, vars: Record<string, unknown> = {}, env: Record<string, unknown> = {}) =>
  executeScript({ id: "t", kind: "pre", code, vars, env }, { now });
const post = (code: string, result: ResultTable, vars: Record<string, unknown> = {}) =>
  executeScript({ id: "t", kind: "post", code, vars, env: {}, result });
const transform = (code: string, inputs: Record<string, ResultTable>, vars: Record<string, unknown> = {}, maxRows?: number) =>
  executeScript({ id: "t", kind: "transform", code, vars, inputs }, { maxRows });

test("pre script sets and unsets vars with the date helpers", async () => {
  const res = await pre(fx("pre-dates.js"), { stale: 1, keep: "x" });
  expect(res.ok).toBe(true);
  expect(res.id).toBe("t");
  expect(res.varChanges).toEqual({ end_date: "2026-10-29", start_date: "2026-10-22", stale: null });
  expect(res.logs).toEqual(["window 2026-10-22 to 2026-10-29"]);
});

test("db.result is undefined in a pre script", async () => {
  const res = await pre('db.vars.set("r", typeof db.result)');
  expect(res.varChanges).toEqual({ r: "undefined" });
});

test("date helpers cross month boundaries and format dates", async () => {
  const res = await pre(
    'db.vars.set("a", db.date.addDays("2026-03-01", -1)); db.vars.set("b", db.date.format(new Date(2026, 0, 5))); db.vars.set("c", db.date.addDays("2026-12-31", 1))',
  );
  expect(res.varChanges).toEqual({ a: "2026-02-28", b: "2026-01-05", c: "2027-01-01" });
});

test("post script reads the result, runs tests and sets vars from a column", async () => {
  const res = await post(fx("post-tests.js"), fxTable("result.json"));
  expect(res.ok).toBe(true);
  expect(res.tests).toEqual([
    { name: "has rows", passed: true },
    { name: "ids are unique", passed: true },
    { name: "spend is positive", passed: true },
    { name: "more than 100 rows", passed: false },
  ]);
  expect(res.varChanges).toEqual({ top_ids: ["a1", "a2", "a3"] });
  expect(JSON.parse(res.logs[0]!)).toEqual({ columns: ["ad_id", "spend"], first: { ad_id: "a1", spend: 12.5 } });
});

test("a test function that throws counts as a fail and is logged", async () => {
  const table = fxTable("result.json");
  table.rows[1] = ["a2", -1];
  const res = await post(fx("post-tests.js"), table);
  expect(res.ok).toBe(true);
  expect(res.tests.find((t) => t.name === "spend is positive")).toEqual({ name: "spend is positive", passed: false });
  expect(res.logs).toContain('Test "spend is positive" failed: non-positive spend');
});

test("db.fail stops the script and returns ok false", async () => {
  const res = await pre(fx("fail.js"));
  expect(res.ok).toBe(false);
  expect(res.error).toBe("client_id is required");
  expect(res.varChanges).toEqual({});
  expect(res.logs).toEqual(["checking inputs"]);

  const passed = await pre(fx("fail.js"), { client_id: 7 });
  expect(passed.ok).toBe(true);
  expect(passed.varChanges).toEqual({ after_fail: true });
});

test("a thrown error and a syntax error come back as ok false", async () => {
  expect((await pre('throw new Error("boom")')).error).toBe("boom");
  const syntax = await pre("db.vars.set(");
  expect(syntax.ok).toBe(false);
  expect(syntax.error).toMatch(/^Syntax error/);
});

test("logs stringify values and cap at the line limit", async () => {
  const res = await pre('db.log("n", 1, { a: [1, 2] }, null, undefined); console.warn("w")');
  expect(res.logs).toEqual(['n 1 {"a":[1,2]} null undefined', "[warn] w"]);

  const many = await pre("for (let i = 0; i < 5000; i++) db.log(i)");
  expect(many.logs).toHaveLength(MAX_LOG_LINES);
  expect(many.logs.at(-1)).toMatch(/truncated/);
});

test("env writes are recorded in envChanges, not applied to the input env", async () => {
  const env = { region: "us" };
  const res = await pre(fx("env-write.js"), {}, env);
  expect(res.ok).toBe(true);
  expect(res.envChanges).toEqual({ region: "eu" });
  expect(env).toEqual({ region: "us" });
  expect(res.logs).toEqual(["region was us", "region now eu"]);
});

test("transform returning { rows, vars } infers columns and types and sets vars", async () => {
  const res = await transform(fx("transform-reshape.js"), { sales: fxTable("result.json"), ads: fxTable("ads.json") }, { start_date: "2026-10-01" });
  expect(res.ok).toBe(true);
  expect(res.result!.columns).toEqual([
    { name: "ad_id", type: "VARCHAR", nullable: false },
    { name: "name", type: "VARCHAR", nullable: true },
    { name: "spend", type: "DOUBLE", nullable: false },
    { name: "big", type: "BOOLEAN", nullable: false },
  ]);
  expect(res.result!.rows).toEqual([
    ["a1", "Spring", 12.5, true],
    ["a2", null, 3, false],
    ["a3", "Autumn", 40, true],
  ]);
  expect(res.varChanges).toEqual({ total: 55.5, min_date: "2026-10-01" });
});

test("transform returning arrays with named columns", async () => {
  const res = await transform(fx("transform-arrays.js"), { sales: fxTable("result.json") });
  expect(res.ok).toBe(true);
  expect(res.result!.columns.map((c) => [c.name, c.type])).toEqual([
    ["ad_id", "VARCHAR"],
    ["doubled", "BIGINT"],
  ]);
  expect(res.result!.rows).toEqual([
    ["a1", 25],
    ["a2", 6],
    ["a3", 80],
  ]);
});

test("transform returning a bare array of objects unions keys in first-seen order", async () => {
  const res = await transform(fx("transform-objects.js"), { sales: fxTable("result.json") });
  expect(res.ok).toBe(true);
  expect(res.result!.columns.map((c) => c.name)).toEqual(["ad_id", "note", "ratio"]);
  expect(res.result!.columns[1]).toEqual({ name: "note", type: "VARCHAR", nullable: true });
  expect(res.result!.rows[0]).toEqual(["a1", null, null]);
  expect(res.result!.rows[2]).toEqual(["a3", "x", 40 / 3]);
});

test("transform output over the row cap fails", async () => {
  const ok = await transform(fx("transform-many.js"), {}, { n: 10 }, 10);
  expect(ok.ok).toBe(true);
  expect(ok.result!.rows).toHaveLength(10);
  const over = await transform(fx("transform-many.js"), {}, { n: 11 }, 10);
  expect(over.ok).toBe(false);
  expect(over.error).toBe("Script returned 11 rows; the limit is 10");
});

test("async code is awaited, including async tests", async () => {
  const res = await pre(fx("async.js"));
  expect(res.ok).toBe(true);
  expect(res.varChanges).toEqual({ waited: true });
  expect(res.tests).toEqual([{ name: "async test", passed: true }]);
  expect(res.logs).toEqual(["done"]);
});

test("network, storage and extension globals are undefined inside executed code", async () => {
  const res = await pre(fx("network.js"));
  expect(res.ok).toBe(true);
  expect(Object.values(res.varChanges.types as Record<string, string>).every((t) => t === "undefined")).toBe(true);
});

test("hardenGlobals removes network globals and sendBeacon from a scope", () => {
  const scope: Record<string, unknown> = {
    fetch: () => 0,
    XMLHttpRequest: class {},
    indexedDB: {},
    navigator: { sendBeacon: () => true, userAgent: "x" },
    keep: 1,
  };
  hardenGlobals(scope);
  expect(scope.fetch).toBeUndefined();
  expect(scope.XMLHttpRequest).toBeUndefined();
  expect(scope.indexedDB).toBeUndefined();
  expect((scope.navigator as Record<string, unknown>).sendBeacon).toBeUndefined();
  expect(scope.keep).toBe(1);
});

// ---- chaining with an injected executor ----

function recordingExec(calls: SandboxRequest[]) {
  return (req: SandboxRequest): Promise<SandboxResponse> => {
    calls.push(req);
    return executeScript(req, { now });
  };
}

test("runPreScripts threads var changes through scripts and merges tests, logs and env", async () => {
  const calls: SandboxRequest[] = [];
  const chain = [fx("pre-dates.js"), "", fx("env-write.js"), 'db.test("start set", db.vars.get("start_date") === "2026-10-22")'];
  const res = await runPreScripts(chain, { stale: 1, client_id: 3 }, { region: "us" }, { exec: recordingExec(calls) });
  expect(res.ok).toBe(true);
  expect(calls).toHaveLength(3);
  expect(calls[1]!.vars).toEqual({ client_id: 3, end_date: "2026-10-29", start_date: "2026-10-22" });
  expect(res.vars).toEqual({ client_id: 3, end_date: "2026-10-29", start_date: "2026-10-22" });
  expect(res.varChanges).toEqual({ end_date: "2026-10-29", start_date: "2026-10-22", stale: null });
  expect(res.envChanges).toEqual({ region: "eu" });
  expect(res.tests).toEqual([{ name: "start set", passed: true }]);
  expect(res.logs).toEqual(["window 2026-10-22 to 2026-10-29", "region was us", "region now eu"]);
});

test("runPreScripts stops at the first failure", async () => {
  const calls: SandboxRequest[] = [];
  const res = await runPreScripts([fx("pre-dates.js"), fx("fail.js"), fx("env-write.js")], {}, {}, { exec: recordingExec(calls) });
  expect(res.ok).toBe(false);
  expect(res.error).toBe("client_id is required");
  expect(res.failedAt).toBe(1);
  expect(calls).toHaveLength(2);
  expect(res.envChanges).toEqual({});
  expect(res.logs).toEqual(["window 2026-10-22 to 2026-10-29", "checking inputs"]);
});

test("runPostScripts passes the result to every script", async () => {
  const calls: SandboxRequest[] = [];
  const res = await runPostScripts(
    [fx("post-tests.js"), 'db.vars.set("n", db.vars.get("top_ids").length)'],
    {},
    {},
    fxTable("result.json"),
    { exec: recordingExec(calls) },
  );
  expect(res.ok).toBe(true);
  expect(calls.every((c) => c.kind === "post")).toBe(true);
  expect(res.vars).toEqual({ top_ids: ["a1", "a2", "a3"], n: 3 });
  expect(res.tests).toHaveLength(4);
});

test("hardenGlobals also removes names inherited through the prototype chain", () => {
  const proto = { fetch: () => 0, WebSocket: class {} };
  const scope = Object.create(proto) as Record<string, unknown>;
  hardenGlobals(scope);
  expect(scope.fetch).toBeUndefined();
  expect(scope.WebSocket).toBeUndefined();
});

test("db.results has every statement's result in a post script; db.result is the last", async () => {
  const first = fxTable("result.json");
  const last = fxTable("ads.json");
  const res = await executeScript({ id: "t", kind: "post", code: fx("post-results.js"), vars: {}, env: {}, result: last, results: [first, last] });
  expect(res.ok).toBe(true);
  expect(res.varChanges).toEqual({ statements: 2, first_count: 3, last_is_result: true });
  expect(res.tests).toEqual([{ name: "setup returned rows", passed: true }]);
  // A single-statement query sees db.results as [db.result].
  const one = await post('db.vars.set("n", db.results.length)', first);
  expect(one.varChanges).toEqual({ n: 1 });
});
