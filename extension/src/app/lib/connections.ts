// Loading, saving and opening connections. Secrets are resolved here and handed to the
// driver in options; they are never written back to IndexedDB.

import type { ConnectionConfig, Driver } from "@core/types";
import { createDriver } from "@core/registry";
import { createDemoDriver, DEMO_CONNECTION, DEMO_CONNECTION_ID, isDemo } from "../demo/demoDriver";
import * as db from "../store/db";
import { readSecret, type SecretMode } from "../store/secrets";
import { openConnectionTab } from "./route";

export type { SavedConnection } from "../store/db";

export async function listConnections(): Promise<db.SavedConnection[]> {
  let rows: db.SavedConnection[] = [];
  try {
    rows = await db.getAll("connections");
  } catch {
    /* IndexedDB unavailable (tests, private mode) */
  }
  const demo: db.SavedConnection = { ...DEMO_CONNECTION, group: "Demo", createdAt: 0 };
  return [...rows.filter((r) => r.id !== DEMO_CONNECTION_ID), demo];
}

export async function loadConnection(id: string): Promise<db.SavedConnection | undefined> {
  if (id === DEMO_CONNECTION_ID) return { ...DEMO_CONNECTION, group: "Demo", createdAt: 0 };
  return db.get("connections", id);
}

export async function saveConnection(cfg: db.SavedConnection): Promise<void> {
  if (cfg.id === DEMO_CONNECTION_ID) return;
  await db.put("connections", cfg);
}

/**
 * Opens a connection in a new browser tab (never reusing one, even for the same connection)
 * and records when it was last used. The tab opens first, while the click still counts as
 * a user gesture for the window.open fallback.
 */
export async function openConnection(c: db.SavedConnection): Promise<void> {
  openConnectionTab(c.id);
  if (!isDemo(c)) await saveConnection({ ...c, lastUsedAt: Date.now() }).catch(() => {});
}

/** Sort order shared by Home and the pickers: ungrouped first, named groups A-Z, Demo last. */
export function compareGroups(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "") return -1;
  if (b === "") return 1;
  if (a === "Demo") return 1;
  if (b === "Demo") return -1;
  return a.localeCompare(b);
}

export async function deleteConnection(id: string): Promise<void> {
  await db.del("connections", id);
}

export function secretMode(cfg: ConnectionConfig): SecretMode {
  const m = cfg.options.secretMode;
  return m === "browser" || m === "keychain" ? m : "session";
}

export function needsSecret(cfg: ConnectionConfig): boolean {
  return !!cfg.secretRef && cfg.options.noSecret !== true;
}

/** Resolves the stored secret; null when the user has to type it this session. */
export async function resolveSecret(cfg: ConnectionConfig): Promise<string | null> {
  if (!cfg.secretRef) return null;
  try {
    return await readSecret(cfg.secretRef, secretMode(cfg));
  } catch {
    return null;
  }
}

export async function openDriver(cfg: ConnectionConfig): Promise<Driver> {
  if (isDemo(cfg)) return createDemoDriver();
  return createDriver(cfg.driver);
}

/** Config passed to driver.connect(): secret added under options.secret, in memory only. */
export function withSecret(cfg: ConnectionConfig, secret: string | null): ConnectionConfig {
  return secret === null ? cfg : { ...cfg, options: { ...cfg.options, secret } };
}

export function connectionSubtitle(cfg: ConnectionConfig): string {
  const o = cfg.options;
  const s = (k: string) => (typeof o[k] === "string" || typeof o[k] === "number" ? String(o[k]) : "");
  switch (cfg.driver) {
    case "bigquery":
      return [s("project"), s("dataset")].filter(Boolean).join(" : ") || "No project set";
    case "clickhouse":
      return [s("url").replace(/^https?:\/\//, ""), s("database")].filter(Boolean).join(" : ");
    case "duckdb":
    case "sqlite":
    case "file":
      return s("fileName") || s("path") || "local file";
    default: {
      const host = s("host") ? `${s("host")}${s("port") ? ":" + s("port") : ""}` : "";
      return [host, s("database")].filter(Boolean).join(" : ");
    }
  }
}

/** Parses postgres://user@host:5432/db, redis://, clickhouse(s)://, http(s):// URLs. */
export function parseConnectionUrl(url: string): Partial<ConnectionConfig> | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const proto = u.protocol.replace(/:$/, "");
  const user = decodeURIComponent(u.username);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const name = u.hostname || "connection";
  if (proto === "postgres" || proto === "postgresql") {
    return { driver: "postgres", name, options: { host: u.hostname, port: Number(u.port || 5432), user, database: db } };
  }
  if (proto === "redis" || proto === "rediss") {
    return { driver: "redis", name, options: { host: u.hostname, port: Number(u.port || 6379), user, database: db || "0", tls: proto === "rediss" } };
  }
  if (proto === "clickhouse" || proto === "clickhouses" || proto === "http" || proto === "https") {
    const secure = proto === "https" || proto === "clickhouses";
    const port = u.port || (secure ? "8443" : "8123");
    return {
      driver: "clickhouse",
      name,
      options: { url: `${secure ? "https" : "http"}://${u.hostname}:${port}`, user: user || "default", database: db || "default", protocol: "http" },
    };
  }
  return null;
}
