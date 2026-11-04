// Per-workflow step results (DESIGN.md §3.15). Keyed by a hash of the step definition, its
// rendered SQL, its inputs' result hashes and the variables it used, so editing step 4 doesn't
// re-run steps 1–3. Kept in memory and saved to IndexedDB (store "chainResults", one row per
// workflow), so the results are still there after a reload; only Clear result (clearCache)
// or deleting the step/workflow removes them.

import type { ResultTable } from "../collections/model";

export interface CacheEntry {
  key: string;
  result?: ResultTable;
  /** Hash of the result (or of the variables a step produced), for downstream keys. */
  resultHash: string;
  renderedSql?: string;
  /** Variable changes the step made (post-run script, transform script), replayed on a hit. */
  varChanges?: Record<string, unknown>;
  rowCount: number;
  ms: number;
  bytesBilled?: number;
  tests?: { name: string; passed: boolean }[];
  logs?: string[];
  at: number;
}

/** Where saved results go; set by the app (IndexedDB). Tests and the runner alone keep memory only. */
export interface ResultStore {
  read(chainId: string): Promise<Record<string, CacheEntry> | undefined>;
  write(chainId: string, steps: Record<string, CacheEntry>): Promise<void>;
  remove(chainId: string): Promise<void>;
}

const caches = new Map<string, Map<string, CacheEntry>>();
let persist: ResultStore | null = null;
const loaded = new Map<string, Promise<void>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function setResultStore(s: ResultStore | null): void {
  persist = s;
  loaded.clear();
}

/** Loads a workflow's saved results into memory once (no-op without a store). */
export function loadSavedResults(chainId: string): Promise<void> {
  if (!persist) return Promise.resolve();
  let p = loaded.get(chainId);
  if (!p) {
    const store = persist;
    p = store.read(chainId).then(
      (saved) => {
        if (!saved) return;
        const c = chainCache(chainId);
        // A result from this session wins over the saved one.
        for (const [k, v] of Object.entries(saved)) if (!c.has(k)) c.set(k, v);
      },
      () => undefined,
    );
    loaded.set(chainId, p);
  }
  return p;
}

/** Saves a workflow's results soon (debounced, so a run's many steps write once). */
export function saveResults(chainId: string): void {
  if (!persist) return;
  clearTimeout(timers.get(chainId));
  timers.set(
    chainId,
    setTimeout(() => {
      timers.delete(chainId);
      const c = caches.get(chainId);
      if (!persist) return;
      void (c?.size ? persist.write(chainId, Object.fromEntries(c)) : persist.remove(chainId)).catch(() => undefined);
    }, 300),
  );
}

export function chainCache(chainId: string): Map<string, CacheEntry> {
  let c = caches.get(chainId);
  if (!c) caches.set(chainId, (c = new Map()));
  return c;
}

export function clearCache(chainId: string, step?: string): void {
  if (step) caches.get(chainId)?.delete(step);
  else caches.delete(chainId);
  saveResults(chainId);
}

/** Last cached result of a step, for the UI's result preview. */
export function cachedResult(chainId: string, step: string): CacheEntry | undefined {
  return caches.get(chainId)?.get(step);
}

/** JSON with sorted object keys, so equal values hash equally. */
export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(Object.keys(val as object).sort().map((k) => [k, (val as Record<string, unknown>)[k]]));
    }
    return val;
  }) ?? "undefined";
}

/** 53-bit string hash (cyrb53) as hex. Not cryptographic; only for cache keys. */
export function hashString(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export const hashValue = (v: unknown) => hashString(stableJson(v));

export function hashTable(t: ResultTable): string {
  return hashString(stableJson({ c: t.columns.map((c) => [c.name, c.type]), r: t.rows }));
}
