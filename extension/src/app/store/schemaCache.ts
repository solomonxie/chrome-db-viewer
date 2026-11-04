// The Schema tree's last loaded items, per connection (DESIGN.md §3.3): the tree shows them as
// soon as the connection opens, then reloads them in the background and swaps in what changed.
// One row per connection: every loaded branch's children and which branches were open.
// IndexedDB, or memory where there is none (jsdom tests).

import type { ObjectNode } from "@core/types";
import * as idb from "./db";
import type { SchemaCacheRow } from "./db";

export type { SchemaCacheRow };

const memory = new Map<string, SchemaCacheRow>();
const hasIdb = () => typeof indexedDB !== "undefined";

export async function readSchemaCache(connectionId: string): Promise<SchemaCacheRow | undefined> {
  try {
    return hasIdb() ? await idb.get("schemaCache", connectionId) : structuredClone(memory.get(connectionId));
  } catch {
    return undefined;
  }
}

export async function writeSchemaCache(connectionId: string, children: Map<string, ObjectNode[]>, expanded: Set<string>): Promise<void> {
  const row: SchemaCacheRow = { id: connectionId, children: Object.fromEntries(children), expanded: [...expanded], at: Date.now() };
  try {
    if (hasIdb()) await idb.put("schemaCache", row);
    else memory.set(connectionId, structuredClone(row));
  } catch {
    /* a cache that can't be written only costs a slower next open */
  }
}

export async function forgetSchemaCache(connectionId: string): Promise<void> {
  try {
    if (hasIdb()) await idb.del("schemaCache", connectionId);
    else memory.delete(connectionId);
  } catch {
    /* nothing cached */
  }
}
