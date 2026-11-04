// Trash (DESIGN.md §3.17): deleting a workflow, collection, folder, saved query or connection
// moves it here instead of removing it. Restore writes the rows back exactly as they were, with
// their secret values; Delete forever (or Empty trash) removes the item and its secrets for good.
// Uses IndexedDB, or memory where there is none (jsdom tests).

import * as idb from "./db";
import type { TrashItem } from "./db";
import { forgetSecret, readSecret, sessionSecrets, secretStore } from "./secrets";

export type { TrashItem };

const memory = new Map<string, TrashItem>();
const hasIdb = () => typeof indexedDB !== "undefined";
const listeners = new Set<() => void>();

export function onTrashChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const changed = () => {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* a listener must not break a delete */
    }
  }
};

async function putItem(t: TrashItem): Promise<void> {
  if (hasIdb()) await idb.put("trash", t);
  else memory.set(t.id, structuredClone(t));
  changed();
}

async function dropItem(id: string): Promise<void> {
  if (hasIdb()) await idb.del("trash", id);
  else memory.delete(id);
  changed();
}

export async function listTrash(): Promise<TrashItem[]> {
  const all = hasIdb() ? await idb.getAll("trash").catch(() => [] as TrashItem[]) : [...memory.values()].map((t) => structuredClone(t));
  return all.sort((a, b) => b.deletedAt - a.deletedAt);
}

export async function getTrashItem(id: string): Promise<TrashItem | undefined> {
  return hasIdb() ? idb.get("trash", id) : structuredClone(memory.get(id));
}

/** Reads a secret from this page's memory or the browser store; null when it has no value. */
async function readAny(ref: string): Promise<string | null> {
  const m = await sessionSecrets.get(ref);
  if (m !== null) return m;
  try {
    return await readSecret(ref, "browser");
  } catch {
    return null;
  }
}

/** Puts a secret back where secrets that outlive the page are kept, and in this page's memory. */
async function writeBack(ref: string, value: string): Promise<void> {
  await sessionSecrets.set(ref, value);
  try {
    await secretStore("browser").set(ref, value);
  } catch {
    /* not in an extension context */
  }
}

/**
 * Records a deleted item. The caller has removed (or is about to remove) its rows; `secretRefs`
 * are read now, so the item can be restored with them. Returns the trash entry.
 */
export async function moveToTrash(item: Omit<TrashItem, "id" | "deletedAt" | "secrets">, secretRefs: string[] = []): Promise<TrashItem> {
  const secrets: Record<string, string> = {};
  for (const ref of new Set(secretRefs)) {
    const v = await readAny(ref);
    if (v !== null) secrets[ref] = v;
  }
  const t: TrashItem = { ...item, id: idb.uid("tr_"), deletedAt: Date.now(), ...(Object.keys(secrets).length ? { secrets } : {}) };
  await putItem(t);
  return t;
}

/** Writes an item's rows and secrets back and takes it out of the Trash. */
export async function restoreFromTrash(id: string, write: (store: TrashItem["rows"][number]["store"], row: unknown) => Promise<void>): Promise<TrashItem | undefined> {
  const t = await getTrashItem(id);
  if (!t) return undefined;
  for (const [ref, v] of Object.entries(t.secrets ?? {})) await writeBack(ref, v);
  for (const r of t.rows) await write(r.store, r.row);
  await dropItem(id);
  return t;
}

/** Deletes an item for good, with its secret values. */
export async function deleteForever(id: string): Promise<void> {
  const t = await getTrashItem(id);
  if (!t) return;
  for (const ref of Object.keys(t.secrets ?? {})) await forgetSecret(ref);
  // A workflow's saved step results stay while it's in the Trash (Restore brings them back).
  if (t.kind === "workflow" && hasIdb()) {
    for (const r of t.rows) if (r.store === "chains") await idb.del("chainResults", (r.row as { id: string }).id).catch(() => undefined);
  }
  await dropItem(id);
}

export async function emptyTrash(): Promise<number> {
  const all = await listTrash();
  for (const t of all) await deleteForever(t.id);
  return all.length;
}
