// Connection sheet fields per engine (DESIGN.md §3.8, §3.9, §4.1).

import type { DriverId } from "@core/types";

export type FieldKind = "text" | "number" | "password" | "select" | "file" | "checkbox" | "textarea";

export interface FormField {
  key: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  /** Goes to the SecretStore, not options. */
  secret?: boolean;
  /** Only shown when another field has this value. */
  when?: { key: string; equals: string | string[] };
  hint?: string;
  /** File picker accept list. */
  accept?: string;
}

export interface EngineSpec {
  id: DriverId | "mongodb" | "snowflake";
  name: string;
  badge: string;
  available: boolean;
  needsRunner?: boolean;
  fields: FormField[];
}

const ssh: FormField[] = [
  { key: "sshEnabled", label: "Over SSH", kind: "checkbox", default: false },
  { key: "sshHost", label: "SSH host", kind: "text", placeholder: "bastion.example.com", when: { key: "sshEnabled", equals: "true" } },
  { key: "sshPort", label: "SSH port", kind: "number", default: 22, when: { key: "sshEnabled", equals: "true" } },
  { key: "sshUser", label: "SSH user", kind: "text", when: { key: "sshEnabled", equals: "true" } },
  { key: "sshKey", label: "Private key", kind: "textarea", secret: true, when: { key: "sshEnabled", equals: "true" }, hint: "Stored in Keychain by the runner" },
];

// Values match GoogleAuthMethod in src/auth/google; "wif" is runner-only and not wired yet.
export const BIGQUERY_AUTH = [
  { value: "adc", label: "gcloud login (recommended)", hint: "Uses your gcloud sign-in on this Mac. Pick ~/.config/gcloud/application_default_credentials.json once (⌘⇧G in the picker to type the path).", available: true },
  { value: "access-token", label: "Paste a token (1 hour)", hint: "Run gcloud auth print-access-token and paste the ya29… output. Kept in memory only.", available: true },
  { value: "chrome-profile", label: "Chrome sign-in", hint: "The Google account signed in to Chrome. Needs an OAuth client set up for this extension.", available: true },
  { value: "web-auth", label: "Google sign-in popup", hint: "Pick any Google account in a popup. Needs an OAuth client set up for this extension.", available: true },
  { value: "service-account", label: "Service account key file", hint: "A service account's JSON key, kept as a file handle on disk or stored in this browser.", available: true },
  { value: "impersonate", label: "Act as a service account", hint: "Chrome sign-in first, then act as the service account you name.", available: true },
  { value: "wif", label: "Workload identity", hint: "external_account configs for AWS, Azure or OIDC.", available: false },
] as const;

export const ENGINES: EngineSpec[] = [
  {
    id: "postgres",
    name: "PostgreSQL",
    badge: "Pg",
    available: true,
    needsRunner: true,
    fields: [
      { key: "host", label: "Host", kind: "text", placeholder: "localhost", default: "localhost" },
      { key: "port", label: "Port", kind: "number", default: 5432 },
      { key: "user", label: "User", kind: "text", placeholder: "postgres" },
      { key: "password", label: "Password", kind: "password", secret: true },
      { key: "database", label: "Database", kind: "text", placeholder: "postgres" },
      { key: "sslmode", label: "SSL mode", kind: "select", default: "prefer", options: ["disable", "prefer", "require", "verify-full"].map((v) => ({ value: v, label: v })) },
      ...ssh,
    ],
  },
  {
    id: "clickhouse",
    name: "ClickHouse",
    badge: "Ch",
    available: true,
    fields: [
      { key: "url", label: "URL", kind: "text", placeholder: "https://ch.example.com:8443" },
      { key: "user", label: "User", kind: "text", default: "default" },
      { key: "password", label: "Password", kind: "password", secret: true },
      { key: "database", label: "Database", kind: "text", default: "default" },
      {
        key: "protocol",
        label: "Protocol",
        kind: "select",
        default: "http",
        options: [
          { value: "http", label: "HTTP (default)" },
          { value: "native", label: "Native (runner)" },
        ],
        hint: "HTTP runs from the browser; dbui asks for access to this one origin when you save.",
      },
    ],
  },
  {
    id: "bigquery",
    name: "BigQuery",
    badge: "Bq",
    available: true,
    fields: [
      { key: "auth", label: "Sign in with", kind: "select", default: "adc", options: BIGQUERY_AUTH.map((a) => ({ value: a.value, label: a.label })) },
      { key: "projectId", label: "Billing project", kind: "text", placeholder: "my-project (blank: first visible project)" },
      { key: "dataset", label: "Default dataset", kind: "text", placeholder: "optional" },
      { key: "location", label: "Location", kind: "text", placeholder: "US" },
      { key: "keyFile", label: "Key file", kind: "file", accept: ".json", when: { key: "auth", equals: ["service-account", "adc"] } },
      { key: "keyStorage", label: "Keep the key", kind: "select", default: "handle", when: { key: "auth", equals: "service-account" }, options: [
        { value: "handle", label: "As a file handle (stays on disk)" },
        { value: "browser", label: "In this browser (chrome.storage.local)" },
      ] },
      { key: "impersonateTarget", label: "Target service account", kind: "text", placeholder: "sa@project.iam.gserviceaccount.com", when: { key: "auth", equals: "impersonate" } },
      { key: "token", label: "Access token", kind: "password", secret: true, when: { key: "auth", equals: "access-token" } },
      { key: "maxBytesGb", label: "Cost guard (GB per query)", kind: "number", default: 10 },
    ],
  },
  {
    id: "duckdb",
    name: "DuckDB",
    badge: "Du",
    available: true,
    fields: [
      { key: "file", label: ".duckdb file", kind: "file", accept: ".duckdb,.db" },
      { key: "engine", label: "Engine", kind: "select", default: "auto", options: [
        { value: "auto", label: "Auto" },
        { value: "browser", label: "Browser (read-only)" },
        { value: "runner", label: "Runner (read-write)" },
      ] },
    ],
  },
  {
    id: "sqlite",
    name: "SQLite",
    badge: "Sl",
    available: true,
    fields: [{ key: "file", label: "SQLite file", kind: "file", accept: ".sqlite,.sqlite3,.db" }],
  },
  {
    id: "redis",
    name: "Redis",
    badge: "Re",
    available: true,
    needsRunner: true,
    fields: [
      { key: "host", label: "Host", kind: "text", default: "localhost" },
      { key: "port", label: "Port", kind: "number", default: 6379 },
      { key: "user", label: "User", kind: "text", placeholder: "optional" },
      { key: "password", label: "Password", kind: "password", secret: true },
      { key: "database", label: "Database", kind: "number", default: 0 },
      { key: "tls", label: "TLS", kind: "checkbox", default: false },
      ...ssh,
    ],
  },
  { id: "mongodb", name: "MongoDB", badge: "Mo", available: false, fields: [] },
  { id: "snowflake", name: "Snowflake", badge: "Sf", available: false, fields: [] },
];

export function engine(id: string): EngineSpec | undefined {
  return ENGINES.find((e) => e.id === id);
}

export function fieldVisible(f: FormField, values: Record<string, unknown>): boolean {
  if (!f.when) return true;
  const v = String(values[f.when.key] ?? "");
  return Array.isArray(f.when.equals) ? f.when.equals.includes(v) : v === f.when.equals;
}

export function defaultValues(spec: EngineSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of spec.fields) if (f.default !== undefined && !f.secret) out[f.key] = f.default;
  return out;
}

/** Next index in a grid of `cols` columns for an arrow key, skipping nothing. */
export function gridMove(index: number, key: string, count: number, cols: number): number {
  switch (key) {
    case "ArrowRight":
      return Math.min(count - 1, index + 1);
    case "ArrowLeft":
      return Math.max(0, index - 1);
    case "ArrowDown":
      return index + cols < count ? index + cols : index;
    case "ArrowUp":
      return index - cols >= 0 ? index - cols : index;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return index;
  }
}
