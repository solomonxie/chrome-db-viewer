import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { guessConnections, parseWorkflowFile, workflowFromFile, workflowToFile } from "../../src/chains/workflowFile";
import { CONNECTIONS, loadChain } from "./helpers";

const read = (name: string) => readFileSync(resolve(__dirname, "../fixtures/workflows", name), "utf8");

test("a workflow file parses, and its aliases map to saved connections of the same engine", () => {
  const f = parseWorkflowFile(read("import_compare.dbui-workflow.json"));
  expect(f.steps.map((s) => s.name)).toEqual(["bq", "pg", "diff", "has_rows"]);
  // "warehouse" has one BigQuery candidate; "app" + hint "orders" has three Postgres ones and none match, so the first wins.
  expect(guessConnections(f, CONNECTIONS)).toEqual({ warehouse: "bq", app: "pg" });
  expect(guessConnections(f, CONNECTIONS.filter((c) => c.driver !== "bigquery")).warehouse).toBeUndefined();
});

test("the hint picks the connection whose name or host matches", () => {
  const f = parseWorkflowFile(read("import_compare.dbui-workflow.json"));
  f.connections!.app!.hint = "replica";
  expect(guessConnections(f, CONNECTIONS).app).toBe("pg_ro");
});

test("importing turns aliases into connection ids and keeps SQL, vars and checks", () => {
  const f = parseWorkflowFile(read("import_compare.dbui-workflow.json"));
  const c = workflowFromFile(f, { warehouse: "bq" }, { id: "ch_new", now: 5 });
  expect(c).toMatchObject({ id: "ch_new", name: "Month close", description: "Compare BigQuery clients with Postgres dashboards.", updatedAt: 5, vars: [{ name: "partner", value: "ACME_ADS" }] });
  expect(c.steps.map((s) => [s.name, s.kind, s.connectionId])).toEqual([
    ["bq", "query", "bq"],
    ["pg", "query", undefined],
    ["diff", "transform-sql", undefined],
    ["has_rows", "assert", undefined],
  ]);
  expect(c.steps[3]!.condition).toBe('count("diff") >= 0');
  expect(new Set(c.steps.map((s) => s.id)).size).toBe(4);
});

test("files with a ref to a missing step, or a connection that isn't listed, are refused with the step name", () => {
  expect(() => parseWorkflowFile(read("import_bad_ref.dbui-workflow.json"))).toThrow(/"b" refers to "missing"/);
  expect(() => parseWorkflowFile(read("import_unknown_alias.dbui-workflow.json"))).toThrow(/Step "a" uses connection "nope"/);
  expect(() => parseWorkflowFile(read("library.json"))).toThrow(/Not a workflow file/);
});

test("exporting writes aliases named after the connections, and the file imports back to the same steps", () => {
  const chain = loadChain("cross_connection_ref.json");
  const file = workflowToFile(chain, CONNECTIONS);
  expect(file.connections).toEqual({ acme_bigquery: { driver: "bigquery", hint: "Acme BigQuery" }, shop_postgres: { driver: "postgres", hint: "Shop Postgres" } });
  expect(file.steps.map((s) => s.connection)).toEqual(["acme_bigquery", "shop_postgres"]);
  const back = workflowFromFile(parseWorkflowFile(JSON.stringify(file)), guessConnections(file, CONNECTIONS), { id: "x" });
  expect(back.steps.map(({ id: _id, ...s }) => s)).toEqual(chain.steps.map(({ id: _id, ...s }) => s));
});
