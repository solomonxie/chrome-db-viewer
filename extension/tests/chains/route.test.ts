import { expect, test } from "vitest";
import { parseRoute, routeHash } from "../../src/app/lib/route";
import { freshStepName, newStep } from "../../src/app/chains/chainStore";
import { loadChain } from "./helpers";

test("#workflow/<id> routes to the workflow view and is the link the UI builds", () => {
  expect(parseRoute("#workflow/ch_a%2Fb")).toEqual({ name: "chain", chainId: "ch_a/b" });
  expect(routeHash({ name: "chain", chainId: "ch_a/b" })).toBe("#workflow/ch_a%2Fb");
  expect(parseRoute("#workflow/")).toEqual({ name: "home" });
});

test("#chain/<id> still opens the same workflow", () => {
  expect(parseRoute("#chain/ch_a%2Fb")).toEqual({ name: "chain", chainId: "ch_a/b" });
  expect(parseRoute("#chain/")).toEqual({ name: "home" });
});

test("new steps get unique names and point at the previous step", () => {
  const steps = loadChain("transform_join.json").steps;
  expect(freshStepName(steps, "sales")).toBe("sales_2");
  const t = newStep("transform-sql", steps);
  expect(t.name).toBe("transform");
  expect(t.sql).toBe(`SELECT *\nFROM {{ ref("has_rows") }}`);
  expect(newStep("assert", steps).condition).toBe(`count("has_rows") > 0`);
});
