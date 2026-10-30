// Pure tab-list operations and the per-connection saved tab list (conn/tabs/tabState.ts).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { closeIds, duplicateTab, findTableTab, moveTab, nextActive, othersOf, restoreTabs, rightOf, serializeTabs, MAX_SAVED_TABS } from "../../src/app/conn/tabs/tabState";
import type { WorkTab } from "../../src/app/conn/model";

const raw = readFileSync(resolve(__dirname, "../fixtures/app/saved-tabs.json"), "utf8");
const ids = () => {
  let n = 0;
  return () => `r${++n}`;
};
const restored = () => restoreTabs(raw, ids());

test("restore keeps valid tabs, drops malformed ones, and maps the active index and bound query", () => {
  const { tabs, active, bound } = restored();
  expect(tabs.map((t) => t.kind)).toEqual(["table", "table", "query"]);
  const second = tabs[1]!;
  expect(second.kind === "table" && second.stack[second.pos]!.path).toEqual(["public", "tables", "customers"]);
  expect(second.kind === "table" && second.stack[1]!.sort).toEqual([{ column: "name", dir: "asc" }]);
  expect(active).toBe(tabs[2]!.id);
  expect(bound).toEqual({ [tabs[2]!.id]: "nq_top" });
});

test("restore survives garbage", () => {
  expect(restoreTabs("{not json", ids()).tabs).toEqual([]);
  expect(restoreTabs(null, ids()).tabs).toEqual([]);
  expect(restoreTabs('{"v":2,"tabs":[]}', ids()).tabs).toEqual([]);
});

test("serialize round-trips and caps the number of tabs", () => {
  const { tabs, active, bound } = restored();
  const again = restoreTabs(serializeTabs(tabs, active, bound), ids());
  expect(again.tabs.map((t) => (t.kind === "table" ? t.stack.map((e) => e.path.at(-1)) : t.title))).toEqual([["orders"], ["order_items", "customers"], "Top customers"]);
  expect(Object.values(again.bound)).toEqual(["nq_top"]);

  const many: WorkTab[] = Array.from({ length: 45 }, (_, i) => ({ id: `q${i}`, kind: "query", title: `Q${i}`, sql: "" }));
  expect((JSON.parse(serializeTabs(many, "q3", {})) as { tabs: unknown[] }).tabs).toHaveLength(MAX_SAVED_TABS);
});

test("close, close others and close to the right pick a sensible next tab", () => {
  const { tabs } = restored();
  const [a, b, c] = tabs.map((t) => t.id) as [string, string, string];
  const afterB = closeIds(tabs, [b]);
  expect(afterB.map((t) => t.id)).toEqual([a, c]);
  expect(nextActive(tabs, afterB, b)).toBe(c);
  expect(nextActive(tabs, closeIds(tabs, [c]), c)).toBe(b);
  expect(nextActive(tabs, afterB, a)).toBe(a);
  expect(othersOf(tabs, b)).toEqual([a, c]);
  expect(rightOf(tabs, a)).toEqual([b, c]);
  expect(rightOf(tabs, c)).toEqual([]);
});

test("reorder and duplicate", () => {
  const { tabs } = restored();
  const [a, b, c] = tabs.map((t) => t.id) as [string, string, string];
  expect(moveTab(tabs, c, 0).map((t) => t.id)).toEqual([c, a, b]);
  expect(moveTab(tabs, a, 99).map((t) => t.id)).toEqual([b, c, a]);
  const dup = duplicateTab(tabs, b, "d1");
  expect(dup.map((t) => t.id)).toEqual([a, b, "d1", c]);
  expect(findTableTab(dup, ["public", "tables", "customers"])!.id).toBe(b);
});
