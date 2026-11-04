// Trash: deleting moves items to the Trash with their secrets; Restore puts them back as they
// were; Delete forever and Empty trash remove them and their secrets. jsdom has no IndexedDB, so
// the stores keep rows in memory.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, expect, test } from "vitest";
import type { Chain, Collection, Folder, NamedQuery } from "../../src/collections/model";
import { deleteCollection, deleteFolder, deleteQuery, getChainRow, listCollections, loadBundle, putChainRow, saveCollection, saveFolder, saveQuery, trashChain, writeTrashedRow } from "../../src/collections/store";
import { deleteForever, emptyTrash, listTrash, restoreFromTrash } from "../../src/app/store/trash";
import { sessionSecrets } from "../../src/app/store/secrets";

const LIB = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/collections/trash.json"), "utf8")) as { collection: Collection; folders: Folder[]; queries: NamedQuery[]; chain: Chain };

beforeEach(async () => {
  await emptyTrash();
  await saveCollection(structuredClone(LIB.collection));
  for (const f of LIB.folders) await saveFolder(f);
  for (const q of LIB.queries) await saveQuery(q);
  await putChainRow(LIB.chain);
});

test("deleting a collection moves it, its folders, queries and secret values to the Trash; Restore brings all back", async () => {
  expect(await sessionSecrets.get("coll:col_tr:var:token")).toBe("s3cret");
  await deleteCollection("col_tr");
  expect((await listCollections()).some((c) => c.id === "col_tr")).toBe(false);
  expect(await sessionSecrets.get("coll:col_tr:var:token")).toBe("s3cret");

  const [t] = await listTrash();
  expect(t).toMatchObject({ kind: "collection", name: "Reports", where: "2 queries, 1 folder" });
  expect(t!.rows.map((r) => r.store)).toEqual(["collections", "folders", "namedQueries", "namedQueries"]);
  expect(t!.secrets).toEqual({ "coll:col_tr:var:token": "s3cret" });

  await restoreFromTrash(t!.id, writeTrashedRow);
  const b = (await loadBundle("col_tr"))!;
  expect(b.folders.map((f) => f.name)).toEqual(["daily"]);
  expect(b.queries.map((q) => q.name).sort()).toEqual(["revenue", "top_ads"]);
  expect(b.collection.vars.find((v) => v.name === "token")!.value).toBe("s3cret");
  expect(await listTrash()).toEqual([]);
});

test("Undo after deleting a query is a Restore from the Trash", async () => {
  const undo = await deleteQuery("nq_tr_rev");
  const [t] = await listTrash();
  expect(t).toMatchObject({ kind: "query", name: "revenue", where: "Reports/daily" });
  await undo();
  expect((await loadBundle("col_tr"))!.queries.some((q) => q.id === "nq_tr_rev")).toBe(true);
  expect(await listTrash()).toEqual([]);
});

test("a deleted folder's queries move up a level; the folder itself is in the Trash", async () => {
  await deleteFolder("fld_tr_daily");
  const b = (await loadBundle("col_tr"))!;
  expect(b.folders).toEqual([]);
  expect(b.queries.find((q) => q.id === "nq_tr_rev")!.folderId).toBeUndefined();
  expect((await listTrash())[0]).toMatchObject({ kind: "folder", name: "daily" });
});

test("Delete forever removes the item and its secret values; Empty trash removes everything", async () => {
  await trashChain("ch_tr");
  await deleteCollection("col_tr");
  expect(await getChainRow("ch_tr")).toBeUndefined();
  const items = await listTrash();
  expect(items.map((t) => t.kind).sort()).toEqual(["collection", "workflow"]);

  await deleteForever(items.find((t) => t.kind === "collection")!.id);
  expect(await sessionSecrets.get("coll:col_tr:var:token")).toBeNull();
  expect((await listTrash()).map((t) => t.name)).toEqual(["Weekly report"]);

  expect(await emptyTrash()).toBe(1);
  expect(await listTrash()).toEqual([]);
});
