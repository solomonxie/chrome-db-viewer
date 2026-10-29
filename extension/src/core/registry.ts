// Maps a DriverId to its implementation. Every driver folder exports createDriver().
// Loaded lazily so DuckDB/SQLite WASM only download when first used.
import type { Driver, DriverId } from "./types";

const loaders: Record<DriverId, () => Promise<{ createDriver(): Driver }>> = {
  duckdb: () => import("../drivers/duckdb/index"),
  file: () => import("../drivers/duckdb/index"),
  sqlite: () => import("../drivers/sqlite/index"),
  bigquery: () => import("../drivers/bigquery/index"),
  clickhouse: () => import("../drivers/clickhouse/index"),
  postgres: () => import("../drivers/runner/index"),
  redis: () => import("../drivers/runner/index"),
};

export async function createDriver(id: DriverId): Promise<Driver> {
  const mod = await loaders[id]();
  return mod.createDriver();
}
