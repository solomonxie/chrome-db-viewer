// @vitest-environment node
import { expect, test } from "vitest";
import { ancestors, buildGraph, ChainGraphError, descendants, findRefs } from "../../src/chains/graph";
import { loadChain } from "./helpers";

test("findRefs reads both quote styles, once each", () => {
  expect(findRefs(`SELECT * FROM {{ ref("a") }} JOIN {{ ref('b') }} JOIN {{ref( "a" )}}`)).toEqual(["a", "b"]);
});

test("levels: independent steps share a level; set-vars variables and dependsOn add edges", () => {
  const g = buildGraph(loadChain("graph_levels.json"));
  expect(g.levels).toEqual([["sales", "ads"], ["joined"], ["ids"], ["lookup"], ["check"]]);
  expect(g.inputs.get("joined")).toEqual(["sales", "ads"]);
  expect(g.inputs.get("lookup")).toEqual(["ids"]);
  expect(g.inputs.get("check")).toEqual(["lookup", "sales"]);
  expect([...descendants(g, "ads")].sort()).toEqual(["check", "ids", "joined", "lookup"]);
  expect([...ancestors(g, "lookup")].sort()).toEqual(["ads", "ids", "joined", "sales"]);
});

test("a cycle is refused, naming the loop", () => {
  let err: unknown;
  try {
    buildGraph(loadChain("graph_cycle.json"));
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ChainGraphError);
  const e = err as ChainGraphError;
  expect(e.kind).toBe("cycle");
  expect(new Set(e.names)).toEqual(new Set(["a", "b", "c"]));
  expect(e.names[0]).toBe(e.names[e.names.length - 1]);
  expect(e.message).toMatch(/^Steps form a cycle: \w → \w → \w → \w$/);
});

test("a ref to a step that doesn't exist names both steps", () => {
  expect(() => buildGraph(loadChain("graph_missing.json"))).toThrow(`Step "report" refers to "salse_typo", which is not a step in this workflow`);
});

test("duplicate step names are refused", () => {
  const c = loadChain("graph_missing.json");
  c.steps[1]!.name = "sales";
  expect(() => buildGraph(c)).toThrow(`Two steps are named "sales"`);
});
