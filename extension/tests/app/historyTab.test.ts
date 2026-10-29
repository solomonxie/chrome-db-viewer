import { expect, test } from "vitest";

import type { WorkTab } from "../../src/app/conn/model";
import { historyTarget } from "../../src/app/conn/historyTab";

const q = (id: string, sql: string, title = "Query"): WorkTab => ({ id, kind: "query", title, sql });
const table: WorkTab = { id: "t1", kind: "table", stack: [], pos: 0 };

test("a tab already holding the same SQL is focused, ignoring surrounding whitespace", () => {
  expect(historyTarget([table, q("q1", "select 1;")], "t1", "  select 1;\n")).toEqual({ focus: "q1" });
});

test("an empty active query tab is reused", () => {
  expect(historyTarget([table, q("q1", "")], "q1", "select 2")).toEqual({ load: "q1" });
});

test("later clicks load into the single History tab instead of opening more tabs", () => {
  const tabs = [table, q("q1", "select 9"), q("h1", "select 1", "History")];
  expect(historyTarget(tabs, "t1", "select 2")).toEqual({ load: "h1" });
});

test("a new tab opens only when there is no reusable one", () => {
  expect(historyTarget([table, q("q1", "select 9")], "q1", "select 2")).toEqual({ open: true });
});
