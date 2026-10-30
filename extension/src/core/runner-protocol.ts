// Messages between the extension and dbui-runner over native messaging.
// See design/DESIGN.md §3.3. The C++ side in runner/ must match this file exactly.
// Framing: each message is a 4-byte native-endian length followed by UTF-8 JSON.
// Runner → extension messages must stay under 1 MB; the runner splits pages to fit.

import type { Cell, Column } from "./types";

export const RUNNER_HOST = "com.dbui.runner";
export const PROTOCOL_VERSION = 1;
/** backup.write / backup.read refuse anything larger (DESIGN.md §3.16). */
export const BACKUP_MAX_BYTES = 50 * 1024 * 1024;

export type RunnerRequest =
  | { id: number; op: "hello"; client: string }
  | { id: number; op: "connect"; conn: RunnerConnectConfig }
  | { id: number; op: "disconnect" }
  | { id: number; op: "listObjects"; parent: string[] }
  | { id: number; op: "describe"; path: string[] }
  | { id: number; op: "execute"; sql: string; params?: Cell[]; pageSize?: number }
  | { id: number; op: "cancel"; target: number }
  | { id: number; op: "apply"; statements: { sql: string; params?: Cell[] }[] }
  | { id: number; op: "secret.set"; ref: string; value: string }
  | { id: number; op: "secret.get"; ref: string }
  | { id: number; op: "secret.delete"; ref: string }
  // Additive in protocol 1: runners without them answer UNKNOWN_OP, which the extension treats
  // as "no automatic backup". `json` is a BackupFile (src/app/store/backup.ts) with no secrets.
  | { id: number; op: "backup.write"; json: string }
  | { id: number; op: "backup.read" };

export interface RunnerConnectConfig {
  driver: "postgres" | "redis" | "duckdb";
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  /** DuckDB file path. */
  path?: string;
  /** Password typed for this session. Takes precedence over secretRef; never stored by the runner. */
  password?: string;
  /** Keychain item holding the password, used when no inline password is given. */
  secretRef?: string;
  /** libpq sslmode: disable, prefer, require, verify-full. */
  sslmode?: string;
  readOnly: boolean;
  ssh?: { host: string; port?: number; user: string; keySecretRef?: string };
}

export type RunnerMessage =
  | { id: number; type: "hello"; runner: string; protocol: number; drivers: string[]; features?: string[] }
  | { id: number; type: "ok"; [k: string]: unknown }
  | { id: number; type: "columns"; cols: Column[] }
  | { id: number; type: "page"; seq: number; rows: Cell[][] }
  | { id: number; type: "done"; rowCount: number; ms: number; affectedRows?: number }
  | { id: number; type: "objects"; nodes: unknown[] }
  | { id: number; type: "schema"; schema: unknown }
  | { id: number; type: "secret"; value: string | null }
  /** backup.read: the file in UTF-8-safe pieces (each message < 1 MB), then one "backup". */
  | { id: number; type: "chunk"; seq: number; data: string }
  | { id: number; type: "backup"; exists: boolean; mtime: number | null; size: number; chunks: number }
  | { id: number; type: "error"; code?: string; message: string };
