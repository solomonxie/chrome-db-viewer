// Collections and workflows in the memory store (jsdom has no IndexedDB): nested folders,
// the old Saved-tab migration, and workflow helpers.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import type { Chain, Collection, NamedQuery } from "../../src/collections/model";
import { createCollection, createFolder, createQuery, folderPath, listCollections, loadBundle, moveFolder, moveQuery, putChainRow, saveCollection, saveQuery } from "../../src/collections/store";
import { migrateSavedQueries } from "../../src/app/collections/migrateSaved";
import { folderOptions, guessQueryName } from "../../src/app/collections/SaveAsNamedQuery";
import { allChains, collectionsUsed, createChain, defaultWorkflowCollection, duplicateChain } from "../../src/app/chains/chainStore";
import type { SavedQuery } from "../../src/app/store/db";

const fixture = (p: string) => readFileSync(resolve(__dirname, "../fixtures", p), "utf8");

test("subfolders nest to any depth, show as paths, and refuse a move into their own descendant", async () => {
  const c = await createCollection("Folders test");
  const reports = await createFolder(c.id, "Reports");
  const weekly = await createFolder(c.id, "Weekly", reports.id);
  const daily = await createFolder(c.id, "Daily", weekly.id);
  const q = await createQuery(c.id, "signups", { sql: "SELECT 1", folderId: daily.id });

  let b = (await loadBundle(c.id))!;
  expect(folderPath(daily.id, b.folders)).toBe("Reports/Weekly/Daily");
  expect(folderOptions(b.folders).map((o) => o.path)).toEqual(["Reports", "Reports / Weekly", "Reports / Weekly / Daily"]);

  await expect(moveFolder(reports.id, daily.id)).rejects.toThrow("Can't move a folder into itself or one of its subfolders");
  await expect(moveFolder(weekly.id, weekly.id)).rejects.toThrow();

  // Daily moves up to the top level; its query goes with it.
  await moveFolder(daily.id, undefined);
  await moveQuery(q.id, reports.id);
  b = (await loadBundle(c.id))!;
  expect(b.folders.find((f) => f.id === daily.id)!.parentId).toBeUndefined();
  expect(b.queries.find((x) => x.id === q.id)!.folderId).toBe(reports.id);
});

test("old saved queries move into a \"Saved queries\" collection exactly once", async () => {
  let rows = JSON.parse(fixture("app/saved_queries.json")) as SavedQuery[];
  const store = {
    list: async () => rows,
    remove: async (id: string) => {
      rows = rows.filter((r) => r.id !== id);
    },
  };
  const created = await migrateSavedQueries(store);
  expect(created.map((q) => q.name)).toEqual(["Paid orders", "Customers"]);
  expect(rows).toEqual([]);

  const saved = (await listCollections()).filter((c) => c.name === "Saved queries");
  expect(saved).toHaveLength(1);
  const b = (await loadBundle(saved[0]!.id))!;
  expect(b.queries.map((q) => [q.name, q.sql, q.connectionId]).sort()).toEqual([
    ["Customers", "SELECT * FROM customers", "demo"],
    ["Paid orders", "SELECT * FROM orders WHERE paid", "demo"],
  ]);

  // Running again (even if the old rows were never deleted) adds nothing.
  rows = JSON.parse(fixture("app/saved_queries.json")) as SavedQuery[];
  expect(await migrateSavedQueries(store)).toEqual([]);
  expect((await loadBundle(saved[0]!.id))!.queries).toHaveLength(2);
});

test("a saved query's name defaults to its first table and the date, else the start of the SQL", () => {
  const day = new Date(2026, 9, 30);
  expect(guessQueryName("SELECT * FROM public.orders WHERE paid", day)).toBe("orders 2026-10-30");
  expect(guessQueryName("SELECT now() AS ts, 1 + 1 AS two, 'something long here'", day)).toBe("SELECT now() AS ts, 1 + 1 AS two, 'somet");
});

test("workflows list across collections, with the collections their query steps use", async () => {
  const lib = JSON.parse(fixture("workflows/library.json")) as { collections: Collection[]; queries: NamedQuery[]; chains: Chain[] };
  for (const c of lib.collections) await saveCollection(c);
  for (const q of lib.queries) await saveQuery(q);
  for (const ch of lib.chains) await putChainRow(ch);

  const all = await allChains();
  expect(all.filter((c) => c.id.startsWith("ch_d") || c.id === "ch_close").map((c) => c.name)).toEqual(["Daily ad report", "Month close"]);
  const daily = all.find((c) => c.id === "ch_daily")!;
  expect(collectionsUsed(daily, lib.queries)).toEqual(["col_ads", "col_fin"]);

  const copy = await duplicateChain(daily);
  expect(copy).toMatchObject({ name: "Daily ad report copy", collectionId: "col_ads" });
  expect(copy.id).not.toBe(daily.id);
  expect(copy.lastRun).toBeUndefined();
});

test("New workflow defaults to the only collection, else a Workflows collection made once", async () => {
  const only = { id: "col_only", name: "Only", vars: [], environments: [], createdAt: 0, updatedAt: 0 };
  expect((await defaultWorkflowCollection([only])).id).toBe("col_only");
  const made = await defaultWorkflowCollection();
  expect(made.name).toBe("Workflows");
  expect((await defaultWorkflowCollection()).id).toBe(made.id);
  const w = await createChain(made.id);
  expect(w).toMatchObject({ name: "New workflow", collectionId: made.id, steps: [] });
});
