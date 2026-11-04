// Saves workflow step results in IndexedDB (DESIGN.md §3.15), so a workflow shows its last
// results after a reload or in a new tab, until Clear result. Installed once by the workflow view.

import { setResultStore, type ResultStore } from "../../chains/cache";
import * as idb from "./db";

const hasIdb = () => typeof indexedDB !== "undefined";

export const idbResultStore: ResultStore = {
  async read(chainId) {
    return (await idb.get("chainResults", chainId))?.steps;
  },
  async write(chainId, steps) {
    await idb.put("chainResults", { id: chainId, steps, at: Date.now() });
  },
  async remove(chainId) {
    await idb.del("chainResults", chainId);
  },
};

let installed = false;
export function installResultStore(): void {
  if (installed || !hasIdb()) return;
  installed = true;
  setResultStore(idbResultStore);
}

/** Drops a workflow's saved results (when it's deleted for good). */
export async function forgetChainResults(chainId: string): Promise<void> {
  if (!hasIdb()) return;
  await idb.del("chainResults", chainId).catch(() => undefined);
}
