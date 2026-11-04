// "Copy as…" for a saved connection: the formats that make sense for its engine (a URL, the
// engine's CLI command, a JDBC URL, a console link). Passwords are left out unless the caller
// passes one, and the formats that take one say so in their label.

import type { ConnectionConfig } from "@core/types";

export interface CopyFormat {
  id: string;
  label: string;
  text: string;
}

/** Quotes a value for a POSIX shell when it needs it. */
export function sh(v: string): string {
  return /^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

const enc = encodeURIComponent;

export function copyFormats(cfg: ConnectionConfig, password?: string | null): CopyFormat[] {
  const o = cfg.options;
  const s = (k: string) => (typeof o[k] === "string" || typeof o[k] === "number" ? String(o[k]) : "");
  const userinfo = (withPw: boolean) => {
    const u = s("user");
    if (!u) return "";
    return withPw && password ? `${enc(u)}:${enc(password)}@` : `${enc(u)}@`;
  };
  const out: CopyFormat[] = [];
  switch (cfg.driver) {
    case "postgres": {
      const host = s("host") || "localhost";
      const port = s("port") || "5432";
      const db = s("database");
      const ssl = s("sslmode");
      const q = ssl && ssl !== "prefer" ? `?sslmode=${ssl}` : "";
      const url = (pw: boolean) => `postgresql://${userinfo(pw)}${host}:${port}/${enc(db)}${q}`;
      out.push({ id: "url", label: "Connection URL", text: url(false) });
      if (password) out.push({ id: "url-pw", label: "Connection URL with password", text: url(true) });
      out.push({ id: "psql", label: "psql command", text: `psql ${sh(url(false))}` });
      out.push({ id: "jdbc", label: "JDBC URL", text: `jdbc:postgresql://${host}:${port}/${db}${q}${s("user") ? `${q ? "&" : "?"}user=${enc(s("user"))}` : ""}` });
      out.push({
        id: "env",
        label: "Environment variables (PGHOST…)",
        text: [`PGHOST=${sh(host)}`, `PGPORT=${port}`, s("user") && `PGUSER=${sh(s("user"))}`, db && `PGDATABASE=${sh(db)}`, ssl && `PGSSLMODE=${ssl}`].filter(Boolean).map((l) => `export ${l}`).join("\n"),
      });
      break;
    }
    case "redis": {
      const scheme = o.tls === true || o.tls === "true" ? "rediss" : "redis";
      const host = s("host") || "localhost";
      const port = s("port") || "6379";
      const db = s("database") || "0";
      const url = (pw: boolean) => `${scheme}://${userinfo(pw) || (pw && password ? `:${enc(password)}@` : "")}${host}:${port}/${db}`;
      out.push({ id: "url", label: "Connection URL", text: url(false) });
      if (password) out.push({ id: "url-pw", label: "Connection URL with password", text: url(true) });
      out.push({ id: "cli", label: "redis-cli command", text: ["redis-cli", "-h", sh(host), "-p", port, db !== "0" && `-n ${db}`, s("user") && `--user ${sh(s("user"))}`, scheme === "rediss" && "--tls"].filter(Boolean).join(" ") });
      break;
    }
    case "clickhouse": {
      let u: URL | null = null;
      try {
        u = new URL(s("url"));
      } catch {
        /* no URL set */
      }
      const db = s("database") || "default";
      const user = s("user") || "default";
      if (u) {
        out.push({ id: "url", label: "HTTP URL", text: `${u.origin}/?database=${enc(db)}` });
        const secure = u.protocol === "https:";
        out.push({
          id: "cli",
          label: "clickhouse client command",
          text: ["clickhouse", "client", "--host", sh(u.hostname), "--user", sh(user), "--database", sh(db), secure && "--secure"].filter(Boolean).join(" "),
        });
        out.push({ id: "curl", label: "curl command", text: `curl ${sh(`${u.origin}/?database=${enc(db)}`)} --user ${sh(user)} --data-binary 'SELECT 1'` });
        out.push({ id: "jdbc", label: "JDBC URL", text: `jdbc:clickhouse:${u.protocol.replace(":", "")}://${u.host}/${db}` });
      }
      break;
    }
    case "bigquery": {
      const project = s("projectId") || s("project");
      const dataset = s("dataset");
      const location = s("location");
      const flags = [project && `--project_id=${sh(project)}`, location && `--location=${sh(location)}`].filter(Boolean).join(" ");
      out.push({ id: "bq", label: "bq command", text: `bq query --use_legacy_sql=false${flags ? " " + flags : ""} 'SELECT 1'` });
      if (project) {
        out.push({
          id: "console",
          label: "Google Cloud console link",
          text: `https://console.cloud.google.com/bigquery?project=${enc(project)}${dataset ? `&ws=!1m4!1m3!3m2!1s${enc(project)}!2s${enc(dataset)}` : ""}`,
        });
        out.push({ id: "gcloud", label: "gcloud: set this project", text: `gcloud config set project ${sh(project)}` });
        out.push({ id: "project", label: dataset ? "project.dataset" : "Project id", text: dataset ? `${project}.${dataset}` : project });
      }
      break;
    }
    case "duckdb":
    case "sqlite": {
      // The form stores the picked file's name as fileName; the full path isn't visible to the browser.
      const name = s("fileName") || s("path");
      if (name) out.push({ id: "cli", label: `${cfg.driver} command`, text: `${cfg.driver === "duckdb" ? "duckdb" : "sqlite3"} ${sh(name)}` });
      break;
    }
  }
  return out;
}
