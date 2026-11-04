import { expect, test } from "vitest";
import { parseRoute, routeHash } from "../../src/app/lib/route";
import { freshStepName, newStep } from "../../src/app/chains/chainStore";
import { loadChain } from "./helpers";

test("#workflow/<id> routes to the workflow view and is the link the UI builds", () => {
  expect(parseRoute("#workflow/ch_a%2Fb")).toEqual({ name: "chain", chainId: "ch_a/b" });
  expect(routeHash({ name: "chain", chainId: "ch_a/b" })).toBe("#workflow/ch_a%2Fb");
  expect(parseRoute("#workflow/")).toEqual({ name: "settings" });
});

test("#chain/<id> still opens the same workflow", () => {
  expect(parseRoute("#chain/ch_a%2Fb")).toEqual({ name: "chain", chainId: "ch_a/b" });
  expect(parseRoute("#chain/")).toEqual({ name: "settings" });
});

test("new steps get unique names and point at the previous step", () => {
  const steps = loadChain("transform_join.json").steps;
  expect(freshStepName(steps, "sales")).toBe("sales_2");
  const t = newStep("transform-sql", steps);
  expect(t.name).toBe("transform");
  expect(t.sql).toBe(`SELECT *\nFROM {{ ref("has_rows") }}`);
  expect(newStep("assert", steps).condition).toBe(`count("has_rows") > 0`);
});

test("old workflow variables move into a first Set variables step that later steps depend on", async () => {
  const { varsToInputsStep } = await import("../../src/app/chains/chainStore");
  const { buildGraph } = await import("../../src/chains/graph");
  const old = loadChain("cte_same_connection.json");
  const moved = varsToInputsStep(old);
  expect(moved.vars).toEqual([]);
  expect(moved.steps[0]).toMatchObject({ name: "inputs", kind: "set-vars", assignments: { start_date: '"2026-10-27"' } });
  // Steps whose SQL uses {{ start_date }} now read the inputs step, so Run only runs it first.
  const g = buildGraph(moved);
  const users = moved.steps.filter((s) => /start_date/.test(s.sql ?? "")).map((s) => s.name);
  expect(users.length).toBeGreaterThan(0);
  for (const u of users) expect(g.inputs.get(u)).toContain("inputs");
  expect(varsToInputsStep(moved)).toBe(moved);
});
