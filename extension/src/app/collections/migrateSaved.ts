// One-time move of the old "Saved" tab's rows (the "queries" store, ⌘S in a plain query tab)
// into a "Saved queries" collection as named queries. Safe to run on every start: each old row
// becomes a named query with an id derived from its own, so a second run finds it and skips it,
// and the old row is deleted only after its copy is stored.

import type { NamedQuery } from "../../collections/model";
import { createCollection, createQuery, listCollections, loadQuery } from "../../collections/store";
import * as db from "../store/db";
import { SAVED_QUERIES } from "./SaveAsNamedQuery";

export interface OldSavedStore {
  list(): Promise<db.SavedQuery[]>;
  remove(id: string): Promise<void>;
}

const idbStore: OldSavedStore = {
  list: () => db.getAll("queries"),
  remove: (id) => db.del("queries", id),
};

/** Copies every old saved query into "Saved queries"; returns the named queries created this time. */
export async function migrateSavedQueries(store: OldSavedStore = idbStore): Promise<NamedQuery[]> {
  let rows: db.SavedQuery[];
  try {
    rows = await store.list();
  } catch {
    return []; // no IndexedDB (tests, some private windows): nothing to migrate
  }
  if (!rows.length) return [];
  const cols = await listCollections();
  const target = cols.find((c) => c.name === SAVED_QUERIES) ?? (await createCollection(SAVED_QUERIES));
  const created: NamedQuery[] = [];
  for (const r of [...rows].sort((a, b) => a.updatedAt - b.updatedAt)) {
    const id = `nq_saved_${r.id}`;
    if (!(await loadQuery(id))) {
      created.push(await createQuery(target.id, r.name || "query", { id, sql: r.sql, connectionId: r.connectionId }));
    }
    await store.remove(r.id).catch(() => {});
  }
  return created;
}
