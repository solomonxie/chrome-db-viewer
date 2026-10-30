import { expect, test } from "vitest";
import { buildExport, pathOf, prepareImport, resolveVars, scriptChain, valuesOf } from "../../src/collections/store";
import { loadCollectionFixture } from "./fixtures";

const fx = loadCollectionFixture();
const q = (id: string) => fx.queries.find((x) => x.id === id)!;

test("pathOf joins folder names with the query name", () => {
  expect(pathOf(q("nq_sales"), fx.folders)).toBe("Base/sales_metrics");
  expect(pathOf(q("nq_top"), fx.folders)).toBe("top_ads_by_roas");
});

test("variables resolve session > environment > query > collection", () => {
  const r = resolveVars({ collection: fx.collection, query: q("nq_sales"), session: { end_date: "2026-10-31" }, templateDefaults: { limit: 20, model: "x" } });
  expect(r.end_date).toEqual({ value: "2026-10-31", source: "session" });
  expect(r.start_date).toEqual({ value: "2026-10-01", source: "environment" });
  expect(r.dataset!.source).toBe("environment");
  expect(r.model).toEqual({ value: "linear", source: "collection" });
  expect(r.limit).toEqual({ value: 20, source: "template" });

  const noEnv = resolveVars({ collection: { ...fx.collection, activeEnvironmentId: undefined }, query: q("nq_sales") });
  expect(noEnv.start_date).toEqual({ value: "2026-09-01", source: "query" });
  expect(valuesOf(noEnv).end_date).toBe("2026-01-31");
  // An empty session value doesn't hide the layers below.
  expect(resolveVars({ collection: fx.collection, session: { start_date: "" } }).start_date!.source).toBe("environment");
});

test("export leaves out every secret value", () => {
  const out = buildExport({ ...fx }, 1);
  const json = JSON.stringify(out);
  for (const secret of ["tok-collection-secret", "tok-dev-secret", "tok-prod-secret", "fb-query-secret"]) expect(json).not.toContain(secret);
  expect(out.collection.vars.find((v) => v.name === "api_token")).toEqual({ name: "api_token", type: "string", secret: true });
  expect(out.collection.environments[1]!.values).toEqual({ dataset: "production__4c1e7a2b_8d3f_4e5a_9b6c_1a2b3c4d5e6f", start_date: "2026-10-01" });
  expect(out.queries.find((x) => x.id === "nq_fb")!.vars[0]).toEqual({ name: "account_id", type: "number", value: 4242 });
  expect(out.queries).toHaveLength(fx.queries.length);
});

test("import gives fresh ids and keeps links between rows", () => {
  let n = 0;
  const data = prepareImport(JSON.stringify(buildExport({ ...fx }, 1)), (p) => `${p}${++n}`);
  expect(data.collection.id).not.toBe("col_adperf");
  const base = data.folders.find((f) => f.name === "Base")!;
  const sales = data.queries.find((x) => x.name === "sales_metrics")!;
  expect(sales.folderId).toBe(base.id);
  expect(sales.collectionId).toBe(data.collection.id);
  expect(data.collection.activeEnvironmentId).toBe(data.collection.environments[1]!.id);
  expect(() => prepareImport("{}")).toThrow(/Not a dbui collection/);
});

test("script chain runs collection → folder → query before, and back after", () => {
  const query = { ...q("nq_sales"), scripts: { pre: "q-pre", post: "q-post" } };
  const folders = fx.folders.map((f) => (f.id === "fld_base" ? { ...f, scripts: { pre: "f-pre", post: "f-post" } } : f));
  const collection = { ...fx.collection, scripts: { pre: "c-pre", post: "c-post" } };
  expect(scriptChain(collection, folders, query)).toEqual({ pre: ["c-pre", "f-pre", "q-pre"], post: ["q-post", "f-post", "c-post"] });
});
