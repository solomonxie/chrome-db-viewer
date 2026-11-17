// Every table and view name in a connection (Driver.listAllObjects), kept per connection so the
// schema search filters it locally as you type (DESIGN.md §3.3). Refreshed in the background
// when older than CATALOG_MAX_AGE_MS, or on demand. IndexedDB, or memory where there is none.

import * as idb from "./db";
import type { SchemaCatalogRow } from "./db";

export type { SchemaCatalogRow };

/** A catalog older than this is refreshed in the background when the connection opens. */
export const CATALOG_MAX_AGE_MS = 60 * 60 * 1000;

const memory = new Map<string, SchemaCatalogRow>();
const hasIdb = () => typeof indexedDB !== "undefined";

export async function readSchemaCatalog(connectionId: string): Promise<SchemaCatalogRow | undefined> {
  try {
    return hasIdb() ? await idb.get("schemaCatalog", connectionId) : structuredClone(memory.get(connectionId));
  } catch {
    return undefined;
  }
}

export async function writeSchemaCatalog(row: SchemaCatalogRow): Promise<void> {
  try {
    if (hasIdb()) await idb.put("schemaCatalog", row);
    else memory.set(row.id, structuredClone(row));
  } catch {
    /* not saved: the next open lists it again */
  }
}

export async function forgetSchemaCatalog(connectionId: string): Promise<void> {
  try {
    if (hasIdb()) await idb.del("schemaCatalog", connectionId);
    else memory.delete(connectionId);
  } catch {
    /* nothing saved */
  }
}
