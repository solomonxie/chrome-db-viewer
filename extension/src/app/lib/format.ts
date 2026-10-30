import type { Cell, Env } from "@core/types";
import type { DriverId } from "@core/types";

export function cellText(v: Cell): string {
  if (v === null) return "NULL";
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** The value as a link target when it's a whole http(s) URL, else null. Nothing else (javascript:, data:) ever becomes a link. */
export function linkOf(v: Cell): string | null {
  if (typeof v !== "string" || v.length > 4096) return null;
  const s = v.trim();
  if (!/^https?:\/\/\S+$/i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Parses what the user typed into a cell back into a Cell, guided by the old value / type. */
export function parseCellInput(text: string, like: Cell, type: string): Cell {
  if (text === "NULL") return null;
  const t = type.toLowerCase();
  if (typeof like === "number" || (like === null && /^(u?int\d*|integer|smallint|float\d*|double|real|numeric)$/.test(t))) {
    const n = Number(text);
    return text.trim() !== "" && Number.isFinite(n) ? n : text;
  }
  if (typeof like === "boolean" || /^bool/.test(t)) {
    if (/^(true|t|1)$/i.test(text)) return true;
    if (/^(false|f|0)$/i.test(text)) return false;
  }
  if ((like !== null && typeof like === "object") || /json|struct|map|array/.test(t)) {
    try {
      return JSON.parse(text) as Cell;
    } catch {
      return text;
    }
  }
  return text;
}

export const fmtInt = (n: number) => n.toLocaleString("en-US");

export function fmtBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

export function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function fmtAgo(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

export const ENV_LABEL: Record<Env, string> = { local: "local", dev: "dev", staging: "staging", production: "production" };
export const ENV_VAR: Record<Env, string> = {
  local: "var(--env-local)",
  dev: "var(--env-dev)",
  staging: "var(--env-stage)",
  production: "var(--env-prod)",
};

export const ENGINE: Record<DriverId | "demo", { badge: string; name: string }> = {
  postgres: { badge: "Pg", name: "PostgreSQL" },
  clickhouse: { badge: "Ch", name: "ClickHouse" },
  bigquery: { badge: "Bq", name: "BigQuery" },
  duckdb: { badge: "Du", name: "DuckDB" },
  redis: { badge: "Re", name: "Redis" },
  sqlite: { badge: "Sl", name: "SQLite" },
  file: { badge: "Fi", name: "Data file" },
  demo: { badge: "De", name: "Demo" },
};
