// Collections storage (DESIGN.md §3.14): CRUD over the IndexedDB stores, paths for include/ref,
// variable resolution, and JSON export/import. Values of variables marked secret live in the
// SecretStore under a ref; IndexedDB rows and exports never carry them.

import * as idb from "../app/store/db";
import { readSecret, secretStore, sessionSecrets, forgetSecret } from "../app/store/secrets";
import type { Chain, Collection, Environment, Folder, NamedQuery, Scripts, TemplateLibrary, VarDef } from "./model";

// ---------------------------------------------------------------------------------------------
// Row access: IndexedDB, or memory when it isn't there (jsdom tests, some private windows)
// ---------------------------------------------------------------------------------------------

type CollStore = "collections" | "folders" | "namedQueries" | "chains";
type RowOf<S extends CollStore> = S extends "collections" ? Collection : S extends "folders" ? Folder : S extends "namedQueries" ? NamedQuery : Chain;

const memory = new Map<CollStore, Map<string, unknown>>();
const mem = (s: CollStore) => {
  let m = memory.get(s);
  if (!m) memory.set(s, (m = new Map()));
  return m;
};
const hasIdb = () => typeof indexedDB !== "undefined";
const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

const db = {
  uid: idb.uid,
  async getAll<S extends CollStore>(s: S): Promise<RowOf<S>[]> {
    return hasIdb() ? ((await idb.getAll(s)) as RowOf<S>[]) : ([...mem(s).values()].map(clone) as RowOf<S>[]);
  },
  async get<S extends CollStore>(s: S, id: string): Promise<RowOf<S> | undefined> {
    return hasIdb() ? ((await idb.get(s, id)) as RowOf<S> | undefined) : (clone(mem(s).get(id)) as RowOf<S> | undefined);
  },
  async put<S extends CollStore>(s: S, row: RowOf<S>): Promise<void> {
    if (hasIdb()) await idb.put(s, row as never);
    else mem(s).set(row.id, clone(row));
    notifyCollectionsChanged();
  },
  async del(s: CollStore, id: string): Promise<void> {
    if (hasIdb()) await idb.del(s, id);
    else mem(s).delete(id);
    notifyCollectionsChanged();
  },
  async byCollection<S extends "folders" | "namedQueries" | "chains">(s: S, collectionId: string): Promise<RowOf<S>[]> {
    if (hasIdb()) return (await idb.byCollection(s, collectionId)) as RowOf<S>[];
    return [...mem(s).values()].filter((r) => (r as { collectionId: string }).collectionId === collectionId).map(clone) as RowOf<S>[];
  },
};

// ---------------------------------------------------------------------------------------------
// Change notifications, so the tree and open query tabs refresh after edits elsewhere
// ---------------------------------------------------------------------------------------------

const listeners = new Set<() => void>();
let queued = false;

export function onCollectionsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tells listeners once per burst of writes (batched to the next macrotask). */
export function notifyCollectionsChanged(): void {
  if (queued) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    for (const fn of [...listeners]) fn();
  }, 0);
}

// ---------------------------------------------------------------------------------------------
// Session variable values (kept for this page only; post-run scripts write here too)
// ---------------------------------------------------------------------------------------------

const session = new Map<string, Record<string, unknown>>();

export function sessionVars(collectionId: string): Record<string, unknown> {
  return session.get(collectionId) ?? {};
}

/** Applies changes to a collection's session values; a null value unsets. */
export function setSessionVars(collectionId: string, changes: Record<string, unknown>): void {
  const next = { ...sessionVars(collectionId) };
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  session.set(collectionId, next);
  notifyCollectionsChanged();
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/** Folders from the top level down to `folderId` (stops on a broken or cyclic parent link). */
export function folderChain(folderId: string | undefined, folders: Folder[]): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: Folder[] = [];
  const seen = new Set<string>();
  for (let f = folderId ? byId.get(folderId) : undefined; f && !seen.has(f.id); f = f.parentId ? byId.get(f.parentId) : undefined) {
    seen.add(f.id);
    out.unshift(f);
  }
  return out;
}

/** "Folder/Sub/name": the path include and ref use. */
export function pathOf(query: Pick<NamedQuery, "name" | "folderId">, folders: Folder[]): string {
  return [...folderChain(query.folderId, folders).map((f) => f.name), query.name].join("/");
}

export function folderPath(folderId: string | undefined, folders: Folder[]): string {
  return folderChain(folderId, folders)
    .map((f) => f.name)
    .join("/");
}

/** Template lookup by path for rows already loaded. */
export function libraryFromRows(folders: Folder[], queries: NamedQuery[]): TemplateLibrary {
  const byPath = new Map(queries.map((q) => [pathOf(q, folders), q.sql]));
  return { resolve: (path) => byPath.get(path.replace(/^\/+|\/+$/g, "")) };
}

/** Template lookup by path for one collection, read from IndexedDB. */
export async function libraryFor(collectionId: string): Promise<TemplateLibrary> {
  const [folders, queries] = await Promise.all([db.byCollection("folders", collectionId), db.byCollection("namedQueries", collectionId)]);
  return libraryFromRows(folders, queries);
}

/** Pre scripts in run order (collection → folder → query) and post (query → folder → collection). */
export function scriptChain(collection: Collection | undefined, folders: Folder[], query: NamedQuery): { pre: string[]; post: string[] } {
  const chain: (Scripts | undefined)[] = [collection?.scripts, ...folderChain(query.folderId, folders).map((f) => f.scripts), query.scripts];
  return {
    pre: chain.map((s) => s?.pre ?? "").filter((s) => s.trim()),
    post: [...chain]
      .reverse()
      .map((s) => s?.post ?? "")
      .filter((s) => s.trim()),
  };
}

// ---------------------------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------------------------

export type VarSource = "session" | "environment" | "query" | "collection" | "template";

export interface ResolvedVar {
  value: unknown;
  source: VarSource;
}

const hasValue = (v: unknown) => v !== undefined && v !== null && v !== "";

export function activeEnvironment(c: Collection | undefined): Environment | undefined {
  return c?.environments.find((e) => e.id === c.activeEnvironmentId);
}

/**
 * Variable values, highest priority first: session values > active environment > query
 * defaults > collection defaults > inline var("x", default) defaults.
 */
export function resolveVars(input: {
  collection?: Pick<Collection, "vars" | "environments" | "activeEnvironmentId">;
  query?: Pick<NamedQuery, "vars">;
  session?: Record<string, unknown>;
  templateDefaults?: Record<string, unknown>;
}): Record<string, ResolvedVar> {
  const out: Record<string, ResolvedVar> = {};
  const layer = (values: Record<string, unknown> | undefined, source: VarSource) => {
    for (const [k, v] of Object.entries(values ?? {})) if (hasValue(v)) out[k] = { value: v, source };
  };
  const defs = (vars: VarDef[] | undefined) => Object.fromEntries((vars ?? []).map((v) => [v.name, v.value]));
  layer(input.templateDefaults, "template");
  layer(defs(input.collection?.vars), "collection");
  layer(defs(input.query?.vars), "query");
  const env = input.collection?.environments.find((e) => e.id === input.collection?.activeEnvironmentId);
  layer(env?.values, "environment");
  layer(input.session, "session");
  return out;
}

export const valuesOf = (r: Record<string, ResolvedVar>): Record<string, unknown> => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.value]));

// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------

export const secretRef = (collectionId: string, scope: string, name: string) => `coll:${collectionId}:${scope}:${name}`;

async function putSecret(ref: string, value: unknown): Promise<void> {
  if (!hasValue(value)) return forgetSecret(ref);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  await sessionSecrets.set(ref, text);
  try {
    await secretStore("browser").set(ref, text);
  } catch {
    /* not in an extension context: session only */
  }
}

async function getSecret(ref: string): Promise<string | null> {
  try {
    return await readSecret(ref, "browser");
  } catch {
    return sessionSecrets.get(ref);
  }
}

const secretNames = (vars: VarDef[]) => new Set(vars.filter((v) => v.secret).map((v) => v.name));

/** A copy with secret values removed: collection var values and environment values of secret vars. */
export function stripCollectionSecrets(c: Collection): Collection {
  const secret = secretNames(c.vars);
  return {
    ...c,
    vars: c.vars.map((v) => (v.secret ? { ...v, value: undefined } : v)),
    environments: c.environments.map((e) => ({ ...e, values: Object.fromEntries(Object.entries(e.values).filter(([k]) => !secret.has(k))) })),
  };
}

/** Query vars: a var is secret if the query or the collection marks it so. */
export function stripQuerySecrets(q: NamedQuery, collectionVars: VarDef[] = []): NamedQuery {
  const secret = secretNames([...collectionVars, ...q.vars]);
  return { ...q, vars: q.vars.map((v) => (v.secret || secret.has(v.name) ? { ...v, value: undefined } : v)) };
}

/** Moves secret values into the SecretStore; returns the row to write. */
async function stashCollectionSecrets(c: Collection): Promise<Collection> {
  const secret = secretNames(c.vars);
  for (const v of c.vars) if (v.secret && v.value !== undefined) await putSecret(secretRef(c.id, "var", v.name), v.value);
  for (const e of c.environments) {
    for (const [k, val] of Object.entries(e.values)) if (secret.has(k)) await putSecret(secretRef(c.id, `env:${e.id}`, k), val);
  }
  return stripCollectionSecrets(c);
}

async function fillCollectionSecrets(c: Collection): Promise<Collection> {
  const secret = secretNames(c.vars);
  if (secret.size === 0) return c;
  const vars = await Promise.all(c.vars.map(async (v) => (v.secret ? { ...v, value: (await getSecret(secretRef(c.id, "var", v.name))) ?? undefined } : v)));
  const environments = await Promise.all(
    c.environments.map(async (e) => {
      const values = { ...e.values };
      for (const k of secret) {
        const s = await getSecret(secretRef(c.id, `env:${e.id}`, k));
        if (s !== null) values[k] = s;
      }
      return { ...e, values };
    }),
  );
  return { ...c, vars, environments };
}

// ---------------------------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------------------------

export interface CollectionBundle {
  collection: Collection;
  folders: Folder[];
  queries: NamedQuery[];
}

export async function listCollections(): Promise<Collection[]> {
  const rows = await db.getAll("collections");
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** A collection with its folders and queries, secret values filled in from the SecretStore. */
export async function loadBundle(collectionId: string): Promise<CollectionBundle | undefined> {
  const row = await db.get("collections", collectionId);
  if (!row) return undefined;
  const [folders, queries] = await Promise.all([db.byCollection("folders", collectionId), db.byCollection("namedQueries", collectionId)]);
  const collection = await fillCollectionSecrets(row);
  const filled = await Promise.all(queries.map((q) => fillQuerySecrets(q)));
  return { collection, folders, queries: filled };
}

export async function saveCollection(c: Collection): Promise<Collection> {
  const row = await stashCollectionSecrets({ ...c, updatedAt: Date.now() });
  await db.put("collections", row);
  return { ...c, updatedAt: row.updatedAt };
}

export async function createCollection(name: string, partial: Partial<Collection> = {}): Promise<Collection> {
  const now = Date.now();
  const c: Collection = { id: db.uid("col_"), name, vars: [], environments: [], createdAt: now, updatedAt: now, ...partial };
  return saveCollection(c);
}

export async function deleteCollection(id: string): Promise<void> {
  // Workflows whose home this was are kept; their view offers to pick another collection.
  const [folders, queries, row] = await Promise.all([db.byCollection("folders", id), db.byCollection("namedQueries", id), db.get("collections", id)]);
  for (const q of queries) await deleteQuery(q.id);
  for (const f of folders) await db.del("folders", f.id);
  if (row) {
    for (const v of row.vars) if (v.secret) await forgetSecret(secretRef(id, "var", v.name));
    for (const e of row.environments) for (const v of row.vars) if (v.secret) await forgetSecret(secretRef(id, `env:${e.id}`, v.name));
  }
  await db.del("collections", id);
}

export async function createFolder(collectionId: string, name: string, parentId?: string): Promise<Folder> {
  const f: Folder = { id: db.uid("fld_"), collectionId, name, parentId };
  await db.put("folders", f);
  return f;
}

export async function saveFolder(f: Folder): Promise<void> {
  await db.put("folders", f);
}

/** Deletes a folder; its queries and subfolders move up to the parent. */
export async function deleteFolder(id: string): Promise<void> {
  const f = await db.get("folders", id);
  if (!f) return;
  const [folders, queries] = await Promise.all([db.byCollection("folders", f.collectionId), db.byCollection("namedQueries", f.collectionId)]);
  for (const sub of folders.filter((x) => x.parentId === id)) await db.put("folders", { ...sub, parentId: f.parentId });
  for (const q of queries.filter((x) => x.folderId === id)) await db.put("namedQueries", { ...q, folderId: f.parentId });
  await db.del("folders", id);
}

/** A name that doesn't clash with `taken`: "name", "name 2", "name 3" … */
export function uniqueName(name: string, taken: string[]): string {
  if (!taken.includes(name)) return name;
  for (let i = 2; ; i++) if (!taken.includes(`${name} ${i}`)) return `${name} ${i}`;
}

async function fillQuerySecrets(q: NamedQuery): Promise<NamedQuery> {
  if (!q.vars.some((v) => v.secret)) return q;
  const vars = await Promise.all(q.vars.map(async (v) => (v.secret ? { ...v, value: (await getSecret(secretRef(q.collectionId, `q:${q.id}`, v.name))) ?? undefined } : v)));
  return { ...q, vars };
}

export async function saveQuery(q: NamedQuery): Promise<NamedQuery> {
  const next = { ...q, updatedAt: Date.now() };
  for (const v of next.vars) if (v.secret && v.value !== undefined) await putSecret(secretRef(q.collectionId, `q:${q.id}`, v.name), v.value);
  await db.put("namedQueries", stripQuerySecrets(next));
  return next;
}

export async function createQuery(collectionId: string, name: string, partial: Partial<NamedQuery> = {}): Promise<NamedQuery> {
  const siblings = (await db.byCollection("namedQueries", collectionId)).filter((q) => q.folderId === partial.folderId).map((q) => q.name);
  const q: NamedQuery = { id: db.uid("nq_"), collectionId, name: uniqueName(name, siblings), sql: "", vars: [], updatedAt: Date.now(), ...partial };
  q.name = uniqueName(q.name, siblings);
  return saveQuery(q);
}

export async function loadQuery(id: string): Promise<NamedQuery | undefined> {
  const q = await db.get("namedQueries", id);
  return q ? fillQuerySecrets(q) : undefined;
}

export async function deleteQuery(id: string): Promise<void> {
  const q = await db.get("namedQueries", id);
  if (q) for (const v of q.vars) if (v.secret) await forgetSecret(secretRef(q.collectionId, `q:${q.id}`, v.name));
  await db.del("namedQueries", id);
}

/** Moves a query to a folder (undefined = top level), renaming it if the name is taken there. */
export async function moveQuery(id: string, folderId: string | undefined): Promise<NamedQuery | undefined> {
  const q = await db.get("namedQueries", id);
  if (!q || q.folderId === folderId) return q;
  const siblings = (await db.byCollection("namedQueries", q.collectionId)).filter((x) => x.folderId === folderId && x.id !== id).map((x) => x.name);
  const next = { ...q, folderId, name: uniqueName(q.name, siblings), updatedAt: Date.now() };
  await db.put("namedQueries", next);
  return next;
}

/** Moves a folder under another (undefined = top level). Refuses to move a folder into itself. */
export async function moveFolder(id: string, parentId: string | undefined): Promise<void> {
  const f = await db.get("folders", id);
  if (!f) return;
  if (parentId) {
    const folders = await db.byCollection("folders", f.collectionId);
    if (folderChain(parentId, folders).some((x) => x.id === id)) throw new Error("Can't move a folder into itself or one of its subfolders");
  }
  await db.put("folders", { ...f, parentId });
}

// ---------------------------------------------------------------------------------------------
// Workflow rows (the "chains" store). A workflow keeps a home collectionId for its variables and
// named queries; these go through the same IndexedDB-or-memory access as everything above.
// ---------------------------------------------------------------------------------------------

export async function listChainRows(): Promise<Chain[]> {
  return db.getAll("chains");
}

export async function getChainRow(id: string): Promise<Chain | undefined> {
  return db.get("chains", id);
}

export async function putChainRow(c: Chain): Promise<void> {
  await db.put("chains", c);
}

export async function deleteChainRow(id: string): Promise<void> {
  await db.del("chains", id);
}

export async function chainRowsFor(collectionId: string): Promise<Chain[]> {
  return db.byCollection("chains", collectionId);
}

/** Every named query in every collection (for workflow rows that show which collections they use). */
export async function listAllQueries(): Promise<NamedQuery[]> {
  return db.getAll("namedQueries");
}

// ---------------------------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------------------------

export interface CollectionExport {
  format: "dbui-collection";
  version: 1;
  exportedAt: number;
  collection: Collection;
  folders: Folder[];
  queries: NamedQuery[];
  chains: Chain[];
}

/** One JSON-ready object for a collection, with every secret value left out. */
export function buildExport(b: CollectionBundle & { chains?: Chain[] }, now = Date.now()): CollectionExport {
  return {
    format: "dbui-collection",
    version: 1,
    exportedAt: now,
    collection: stripCollectionSecrets(b.collection),
    folders: b.folders,
    queries: b.queries.map((q) => stripQuerySecrets(q, b.collection.vars)),
    chains: b.chains ?? [],
  };
}

export async function exportCollection(collectionId: string): Promise<string> {
  const b = await loadBundle(collectionId);
  if (!b) throw new Error("No such collection");
  const chains = await db.byCollection("chains", collectionId);
  return JSON.stringify(buildExport({ ...b, chains }), null, 2);
}

/**
 * Parses an export and gives every row a fresh id, so importing the same file twice makes two
 * collections. Returns rows ready to store; secret values are dropped if a file had any.
 */
export function prepareImport(json: string, newId: (prefix: string) => string = db.uid): CollectionExport {
  let data: CollectionExport;
  try {
    data = JSON.parse(json) as CollectionExport;
  } catch {
    throw new Error("Not a JSON file");
  }
  if (data?.format !== "dbui-collection" || !data.collection) throw new Error("Not a dbui collection export");
  const cid = newId("col_");
  const folderIds = new Map((data.folders ?? []).map((f) => [f.id, newId("fld_")]));
  const queryIds = new Map((data.queries ?? []).map((q) => [q.id, newId("nq_")]));
  const envIds = new Map((data.collection.environments ?? []).map((e) => [e.id, newId("env_")]));
  const now = Date.now();
  const collection = stripCollectionSecrets({
    ...data.collection,
    id: cid,
    vars: data.collection.vars ?? [],
    environments: (data.collection.environments ?? []).map((e) => ({ ...e, id: envIds.get(e.id)! })),
    activeEnvironmentId: data.collection.activeEnvironmentId ? envIds.get(data.collection.activeEnvironmentId) : undefined,
    createdAt: now,
    updatedAt: now,
  });
  return {
    ...data,
    collection,
    folders: (data.folders ?? []).map((f) => ({ ...f, id: folderIds.get(f.id)!, collectionId: cid, parentId: f.parentId ? folderIds.get(f.parentId) : undefined })),
    queries: (data.queries ?? []).map((q) =>
      stripQuerySecrets({ ...q, id: queryIds.get(q.id)!, collectionId: cid, folderId: q.folderId ? folderIds.get(q.folderId) : undefined, vars: q.vars ?? [] }, collection.vars),
    ),
    chains: (data.chains ?? []).map((ch) => ({
      ...ch,
      id: newId("ch_"),
      collectionId: cid,
      steps: ch.steps.map((s) => ({ ...s, queryId: s.queryId ? (queryIds.get(s.queryId) ?? s.queryId) : undefined })),
    })),
  };
}

export async function importCollection(json: string): Promise<Collection> {
  const data = prepareImport(json);
  await db.put("collections", data.collection);
  for (const f of data.folders) await db.put("folders", f);
  for (const q of data.queries) await db.put("namedQueries", q);
  for (const ch of data.chains) await db.put("chains", ch);
  return data.collection;
}
