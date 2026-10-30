// @vitest-environment node
// The chain runner with fake remote connections (fixture rows) and the real DuckDB-WASM Node
// build for the local step tables.
import { expect, test } from "vitest";
import { clearCache, CROSS_CONNECTION_ERROR, estimateChain, runChainToEnd, withCtes, type ChainEvent } from "../../src/chains/runner";
import { buildLibrary } from "../../src/chains/library";
import { loadChain, makeDeps, readFixture } from "./helpers";

async function run(file: string, opts: Parameters<typeof runChainToEnd>[1] = {}, deps = makeDeps()) {
  const chain = loadChain(file);
  const events: ChainEvent[] = [];
  const summary = await runChainToEnd(chain, opts, deps, (e) => events.push(e));
  return { chain, deps, events, summary };
}

test("same-connection query steps are inlined as CTEs in dependency order; only the last one runs", async () => {
  const { summary, deps } = await run("cte_same_connection.json");
  expect(summary.status).toBe("done");
  expect(deps.log.executed).toHaveLength(1);
  expect(deps.log.executed[0]!.sql).toBe(
    "WITH `daily` AS (\nSELECT ad_hash, revenue, spend FROM ads_daily WHERE localdate >= '2026-10-27'\n),\n" +
      "`roas` AS (\nSELECT ad_hash, revenue / spend AS roas FROM `daily`\n)\n" +
      "SELECT * FROM `roas` ORDER BY roas DESC LIMIT 2",
  );
  expect(summary.steps.daily).toMatchObject({ status: "done", inlinedInto: ["roas"] });
  expect(summary.steps.roas).toMatchObject({ status: "done", inlinedInto: ["top"] });
  expect(summary.steps.top).toMatchObject({ status: "done", rowCount: 2, bytesBilled: 400000 });
  expect(deps.log.disconnects).toEqual(["bq"]);
});

test("withCtes merges into a body that has its own WITH", () => {
  expect(withCtes([["a", "SELECT 1"]], "WITH b AS (SELECT 2) SELECT * FROM a, b", "postgres")).toBe('WITH "a" AS (\nSELECT 1\n),\nb AS (SELECT 2) SELECT * FROM a, b');
});

test("ref to another connection's step inside a remote query is an error", async () => {
  const { summary, deps } = await run("cross_connection_ref.json");
  expect(summary.status).toBe("failed");
  expect(summary.failedStep).toBe("names");
  expect(summary.steps.names!.error).toContain(CROSS_CONNECTION_ERROR);
  expect(deps.log.executed.map((e) => e.conn)).toEqual(["bq"]);
});

test("transform-sql joins two steps from different connections in local DuckDB", async () => {
  const { summary } = await run("transform_join.json");
  expect(summary.status).toBe("done");
  const r = summary.steps.report!;
  expect(r.renderedSql).toContain(`FROM "step_sales" s JOIN "step_ads" a USING (ad_hash)`);
  expect(r.columns!.map((c) => [c.name, c.type])).toEqual([
    ["ad_name", "VARCHAR"],
    ["revenue", "DOUBLE"],
    ["spend", "DOUBLE"],
  ]);
  expect(r.preview).toEqual([
    ["Story discount", 300, 60],
    ["Autumn hero video", 120.5, 40],
    ["Carousel boots", 80, 50],
  ]);
  expect(summary.steps.has_rows).toMatchObject({ status: "done", tests: [{ name: `count("report") == 3 && nulls("report", "ad_name") == 0`, passed: true }] });
});

test("set-vars feeds a list into a query on another connection through | sql_list", async () => {
  const { summary, deps } = await run("set_vars_lookup.json");
  expect(summary.status).toBe("done");
  expect(summary.steps.pick!.vars).toEqual({ top_ad_ids: ["a1", "a2", "a3"], best: "a1", max_rev: 300, n: 3, label: "top 3", fixed: { k: [1, 2] } });
  const pg = deps.log.executed.find((e) => e.conn === "pg")!;
  expect(pg.sql).toBe("SELECT ad_hash, ad_name FROM ads WHERE ad_hash IN ('a1', 'a2', 'a3')");
  expect(summary.steps.lookup!.rowCount).toBe(3);
  expect(summary.vars.top_ad_ids).toEqual(["a1", "a2", "a3"]);
});

test("a list over the value cap is refused with a clear error", async () => {
  const { summary, deps } = await run("set_vars_lookup.json", { valueCap: 2 });
  expect(summary.status).toBe("failed");
  expect(summary.failedStep).toBe("pick");
  expect(summary.steps.pick!.error).toBe(`"top_ad_ids" holds 3 values, over the limit of 2. Pass the table with a Transform: SQL step instead.`);
  expect(summary.steps.lookup).toMatchObject({ status: "skipped" });
  expect(deps.log.executed.some((e) => e.conn === "pg")).toBe(false);
});

test("a failing assert stops the chain and skips what comes after", async () => {
  const { summary, events } = await run("assert_fails.json");
  expect(summary.status).toBe("failed");
  expect(summary.steps.no_null_revenue).toMatchObject({ status: "failed", error: `Assertion failed: nulls("sales", "revenue") == 0`, tests: [{ passed: false }] });
  expect(summary.steps.after).toMatchObject({ status: "skipped", reason: `Stopped after "no_null_revenue" failed` });
  expect(events.filter((e) => e.type === "step" && e.step === "after").map((e) => (e as { status: string }).status)).toEqual(["queued", "skipped"]);
});

test("re-running hits the cache; changing an upstream step misses downstream", async () => {
  const deps = makeDeps();
  const chain = loadChain("transform_join.json");
  clearCache(chain.id);
  const first = await runChainToEnd(chain, {}, deps);
  expect(first.status).toBe("done");
  expect(deps.log.executed).toHaveLength(2);

  const second = await runChainToEnd(chain, {}, deps);
  expect(deps.log.executed).toHaveLength(2);
  expect(second.steps.sales!.cached).toBe(true);
  expect(second.steps.report).toMatchObject({ cached: true, rowCount: 3 });

  chain.steps[1]!.sql = "SELECT * FROM ads WHERE ad_hash IN ('a1', 'a2')";
  const third = await runChainToEnd(chain, {}, deps);
  expect(deps.log.executed).toHaveLength(3);
  expect(third.steps.sales!.cached).toBe(true);
  expect(third.steps.ads!.cached).toBeUndefined();
  expect(third.steps.report).toMatchObject({ rowCount: 2 });
  expect(third.steps.report!.cached).toBeUndefined();

  clearCache(chain.id);
  await runChainToEnd(chain, {}, deps);
  expect(deps.log.executed).toHaveLength(5);
});

test("run from here re-runs the step and everything downstream, reusing upstream cache", async () => {
  const deps = makeDeps();
  const chain = loadChain("transform_join.json");
  clearCache(chain.id);
  await runChainToEnd(chain, {}, deps);
  const events: ChainEvent[] = [];
  const s = await runChainToEnd(chain, { mode: "from", step: "ads" }, deps, (e) => events.push(e));
  expect(s.status).toBe("done");
  const start = events.find((e) => e.type === "start");
  expect(start).toMatchObject({ steps: ["sales", "ads", "report", "has_rows"] });
  expect(s.steps.sales!.cached).toBe(true);
  expect(s.steps.ads!.cached).toBeUndefined();
  expect(deps.log.executed.filter((e) => e.conn === "pg")).toHaveLength(2);
  expect(deps.log.executed.filter((e) => e.conn === "bq")).toHaveLength(1);
});

test("run only this step takes upstream from the cache, or runs it when missing", async () => {
  const deps = makeDeps();
  const chain = loadChain("transform_join.json");
  clearCache(chain.id);
  const cold = await runChainToEnd(chain, { mode: "only", step: "report" }, deps);
  expect(cold.status).toBe("done");
  expect(Object.keys(cold.steps).sort()).toEqual(["ads", "report", "sales"]);
  expect(deps.log.executed).toHaveLength(2);

  const warm = await runChainToEnd(chain, { mode: "only", step: "report" }, deps);
  expect(warm.steps.sales!.cached).toBe(true);
  expect(warm.steps.ads!.cached).toBe(true);
  expect(warm.steps.report!.cached).toBeUndefined();
  expect(deps.log.executed).toHaveLength(2);
});

test("combined estimate sums BigQuery dry runs and flags steps over the cost guard", async () => {
  const deps = makeDeps();
  const est = await estimateChain(loadChain("over_limit.json"), deps);
  expect(est.steps).toEqual([
    { step: "small", connectionId: "bq", bytes: 400000, limit: 1000000, overLimit: false, renderedSql: "SELECT * FROM ads_daily", usd: undefined },
    { step: "big", connectionId: "bq", bytes: 5000000000, limit: 1000000, overLimit: true, renderedSql: "SELECT * FROM huge_events", usd: undefined },
    { step: "ads", connectionId: "pg", overLimit: false, renderedSql: "SELECT * FROM ads", note: "No cost estimate for this connection" },
  ]);
  expect(est.totalBytes).toBe(5000400000);
  expect(est.overLimit).toEqual(["big"]);
});

test("a step over the cost guard blocks the run before anything starts, unless allowed", async () => {
  const chain = loadChain("over_limit.json");
  clearCache(chain.id);
  const deps = makeDeps();
  const blocked = await runChainToEnd(chain, {}, deps);
  expect(blocked.status).toBe("blocked");
  expect(blocked.error).toContain(`"big"`);
  expect(blocked.estimate!.overLimit).toEqual(["big"]);
  expect(deps.log.executed).toHaveLength(0);
  expect(Object.values(blocked.steps).every((s) => s.status === "skipped")).toBe(true);

  const allowed = await runChainToEnd(chain, { allowOverLimit: true }, deps);
  expect(allowed.status).toBe("done");
  const big = deps.log.executed.find((e) => e.sql.includes("huge_events"))!;
  expect(Number(big.options!.maximumBytesBilled)).toBeGreaterThan(5000000000);
});

test("write statements are refused on a read-only connection", async () => {
  const { summary, deps } = await run("read_only.json");
  expect(summary.status).toBe("failed");
  expect(summary.steps.wipe!.error).toBe(`"Shop replica" is read-only: step "wipe" contains a write statement`);
  expect(deps.log.executed).toHaveLength(0);
});

test("destructive statements on production need confirmation", async () => {
  const refused = await run("production_drop.json");
  expect(refused.summary.status).toBe("failed");
  expect(refused.summary.steps.drop_it!.error).toMatch(/would drop ads on production; not confirmed/);
  expect(refused.deps.log.executed).toHaveLength(0);

  const ok = await run("production_drop.json", {}, makeDeps({ confirm: true }));
  expect(ok.deps.log.executed.map((e) => e.sql)).toEqual(["DROP TABLE ads"]);
});

test("abort cancels the running driver query and skips the rest", async () => {
  const ac = new AbortController();
  const chain = loadChain("slow.json");
  clearCache(chain.id);
  const deps = makeDeps();
  const events: ChainEvent[] = [];
  const p = runChainToEnd(chain, { signal: ac.signal }, deps, (e) => {
    events.push(e);
    if (e.type === "step" && e.step === "slow" && e.status === "running") setTimeout(() => ac.abort(), 5);
  });
  const s = await p;
  expect(s.status).toBe("cancelled");
  expect(s.steps.slow).toMatchObject({ status: "failed", error: "Cancelled" });
  expect(s.steps.after).toMatchObject({ status: "skipped", reason: `Stopped after "slow" failed` });
  expect(deps.log.disconnects).toEqual(["pg"]);
});

test("transform-script gets upstream tables and sets variables; export writes CSV through COPY", async () => {
  const script = loadChain("script_export.json").steps[1]!.script!;
  const deps = makeDeps({
    scripts: {
      [script]: (inputs) => ({ rows: inputs.ads!.rows.map((r) => ({ id: r[0]! })), vars: { n: inputs.ads!.rows.length } }),
    },
  });
  const { summary } = await run("script_export.json", {}, deps);
  expect(summary.status).toBe("done");
  expect(summary.steps.shaped).toMatchObject({ rowCount: 4, vars: { n: 4 }, logs: ["ran"] });
  expect(summary.vars.n).toBe(4);
  expect(deps.saved).toHaveLength(1);
  expect(deps.saved[0]!.name).toBe("Script_and_export_out.csv");
  expect(new TextDecoder().decode(deps.saved[0]!.bytes)).toBe("id\na1\na2\na3\na5\n");
});

test("a named query step uses the collection's default connection, environment and pre/post scripts", async () => {
  const fx = JSON.parse(readFixture("collection_scripts.json"));
  const library = buildLibrary(fx.collection, fx.folders, fx.queries);
  const deps = makeDeps();
  const calls: { kind: string; scripts: string[] }[] = [];
  deps.runPreScripts = async (scripts, vars) => {
    calls.push({ kind: "pre", scripts });
    return { ok: true, vars: { ...vars, limit: 2 }, varChanges: { limit: 2 }, envChanges: {}, tests: [], logs: ["pre ran"] };
  };
  deps.runPostScripts = async (scripts, vars, _env, result) => {
    calls.push({ kind: "post", scripts });
    return { ok: true, vars, varChanges: { best: result.rows[0]![0] }, envChanges: {}, tests: [{ name: "collection post", passed: true }], logs: [] };
  };
  const chain = fx.chain;
  clearCache(chain.id);
  const s = await runChainToEnd(chain, {}, { ...deps, library });
  expect(s.status).toBe("done");
  expect(calls).toEqual([
    { kind: "pre", scripts: ["db.vars.set('limit', 2)"] },
    { kind: "post", scripts: ["db.vars.set('best', db.result.column('ad_hash')[0])", "db.test('collection post', true)"] },
  ]);
  expect(deps.log.executed[0]).toMatchObject({ conn: "bq", sql: "SELECT ad_hash, revenue FROM ads_daily WHERE revenue >= 100 ORDER BY revenue DESC LIMIT 2" });
  expect(s.steps.top).toMatchObject({ logs: ["pre ran"], tests: [{ name: "collection post", passed: true }], vars: { best: "a1" } });
  expect(s.vars).toMatchObject({ best: "a1", limit: 2 });
});
