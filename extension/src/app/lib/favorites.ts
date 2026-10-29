// Starred objects per connection, kept on the saved connection row in IndexedDB.

import type { ObjectNode } from "@core/types";
import * as db from "../store/db";
import { DEMO_CONNECTION_ID } from "../demo/demoDriver";

export type Favorite = db.FavoriteObject;

const key = (path: string[]) => JSON.stringify(path);

export function isFavorite(list: Favorite[], path: string[]): boolean {
  const k = key(path);
  return list.some((f) => key(f.path) === k);
}

/** Adds the node if it isn't starred, removes it if it is. Keeps the list sorted by name. */
export function toggleFavorite(list: Favorite[], node: Pick<ObjectNode, "path" | "name" | "type">): Favorite[] {
  if (isFavorite(list, node.path)) return list.filter((f) => key(f.path) !== key(node.path));
  return [...list, { path: node.path, name: node.name, type: node.type }].sort((a, b) => a.name.localeCompare(b.name));
}

// The demo connection isn't stored in IndexedDB, so its stars live in memory for the session.
const demoFavorites = new Map<string, Favorite[]>();

export async function loadFavorites(connectionId: string): Promise<Favorite[]> {
  if (connectionId === DEMO_CONNECTION_ID) return demoFavorites.get(connectionId) ?? [];
  return (await db.get("connections", connectionId))?.favorites ?? [];
}

export async function saveFavorites(connectionId: string, favorites: Favorite[]): Promise<void> {
  if (connectionId === DEMO_CONNECTION_ID) {
    demoFavorites.set(connectionId, favorites);
    return;
  }
  // Re-read the row so a concurrent edit to the connection settings isn't overwritten.
  const row = await db.get("connections", connectionId);
  if (row) await db.put("connections", { ...row, favorites });
}
