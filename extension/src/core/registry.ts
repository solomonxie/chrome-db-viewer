// Maps a DriverId to its implementation. Every driver folder exports createDriver().
// Loaded lazily so DuckDB/SQLite WASM only download when first used.
import { DriverError, type Driver, type DriverId } from "./types";

const loaders: Record<DriverId, () => Promise<{ createDriver(): Driver }>> = {
  duckdb: () => import("../drivers/duckdb/index"),
  file: () => import("../drivers/duckdb/index"),
  sqlite: () => import("../drivers/sqlite/index"),
  bigquery: () => import("../drivers/bigquery/index"),
  clickhouse: () => import("../drivers/clickhouse/index"),
  postgres: () => import("../drivers/runner/index"),
  redis: () => import("../drivers/runner/index"),
};

/** Chrome's wording when a lazy chunk named by this page's build no longer exists in dist/. */
export function isStaleChunkError(e: unknown): boolean {
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
    String((e as Error)?.message ?? e),
  );
}

export async function createDriver(id: DriverId): Promise<Driver> {
  let mod: { createDriver(): Driver };
  try {
    mod = await loaders[id]();
  } catch (e) {
    // The extension was rebuilt or updated while this tab was open, so the chunk names this
    // page knows are gone. Only a reload picks up the new build.
    if (isStaleChunkError(e)) {
      throw new DriverError("dbui was updated while this tab was open. Reload the tab to continue.", "STALE_BUILD");
    }
    throw e;
  }
  return mod.createDriver();
}
