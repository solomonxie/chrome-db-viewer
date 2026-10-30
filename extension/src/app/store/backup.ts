// Backup file: everything dbui saves, as one JSON document (DESIGN.md §3.16).
//
// Chrome deletes an extension's IndexedDB and chrome.storage.local when it is uninstalled, so
// this file is how saved connections, collections, workflows and history survive. It is written
// by Settings → Backup → Export… and, when the runner is installed, automatically to
// ~/Library/Application Support/dbui/backup.json (store/autoBackup.ts).
//
// Never in a backup:
//   - secrets: passwords, tokens and keys are stripped from connection options, secret
//     collection/query variables lose their values, and nothing the SecretStore keeps
//     (chrome.storage.local "secret:*") is read. Secrets live in Keychain or are typed again.
//   - FileSystemFileHandles: they can't be serialised. The "handles" store is skipped, and
//     recent files and connections that used one are marked needsRepick.

import type { Chain, Collection, NamedQuery } from "../../collections/model";
import { stripCollectionSecrets, stripQuerySecrets } from "../../collections/store";
import * as db from "./db";

export const BACKUP_FORMAT = "dbui-backup";
export const BACKUP_VERSION = 1;

/** Every IndexedDB store a backup carries: all of them except "handles". */
export const BACKUP_STORES = ["connections", "history", "queries", "recentFiles", "groups", "collections", "folders", "namedQueries", "chains"] as const;
export type BackupStore = (typeof BACKUP_STORES)[number];

/** chrome.storage.local keys dbui owns that a backup carries. Never "secret:*". */
export const BACKUP_SETTINGS_KEYS = ["previewSettings", "theme"] as const;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  /** Milliseconds since the epoch. */
  exportedAt: number;
  stores: Partial<Record<BackupStore, Record<string, unknown>[]>>;
  settings: Record<string, unknown>;
}

export type ImportMode = "merge" | "replace";

export interface ImportResult {
  /** Rows written per store (merge skips rows whose local copy is newer). */
  written: Partial<Record<BackupStore, number>>;
  /** Rows kept because the local copy was newer (merge only). */
  keptLocal: number;
  settings: string[];
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

// ---- where the data comes from: IndexedDB + chrome.storage.local, or a test double -----------

export interface BackupIO {
  getAll(store: BackupStore): Promise<Record<string, unknown>[]>;
  putMany(store: BackupStore, rows: Record<string, unknown>[]): Promise<void>;
  clear(store: BackupStore): Promise<void>;
  getSettings(keys: readonly string[]): Promise<Record<string, unknown>>;
  setSettings(values: Record<string, unknown>): Promise<void>;
  /** Handles still in the "handles" store, by id. Lets a restore on the same profile re-attach
   *  files instead of asking for them again. Optional: without it, nothing is re-attached. */
  getHandles?(): Promise<Map<string, FileSystemFileHandle>>;
}

function hasChromeStorage(): boolean {
  return typeof chrome !== "undefined" && !!chrome.storage?.local;
}

export const idbBackupIO: BackupIO = {
  getAll: (s) => db.getAll(s) as Promise<unknown> as Promise<Record<string, unknown>[]>,
  putMany: (s, rows) => db.putMany(s, rows as never[]),
  clear: (s) => db.clear(s),
  async getSettings(keys) {
    if (!hasChromeStorage()) return {};
    return chrome.storage.local.get([...keys]);
  },
  async setSettings(values) {
    if (hasChromeStorage() && Object.keys(values).length) await chrome.storage.local.set(values);
  },
  async getHandles() {
    const rows = await db.getAll("handles").catch(() => [] as db.StoredHandle[]);
    return new Map(rows.map((r) => [r.id, r.handle]));
  },
};

// ---- secrets and handles -----------------------------------------------------------------------

/** Option keys that hold a secret value. Refs (keySecretRef), modes (secretMode), storage choices
 *  and handle ids are not secrets and stay. */
export function isSecretKey(key: string): boolean {
  if (/(Ref|Mode|Storage|HandleId|Name)$/.test(key)) return false;
  if (key === "key" || key === "sshKey" || key === "keyJson" || key === "privateKeyPem") return true;
  return /password|passwd|passphrase|secret|token|api_?key|private_?key|credential/i.test(key);
}

function stripSecretsDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripSecretsDeep);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (isSecretKey(k)) continue;
    out[k] = stripSecretsDeep(val);
  }
  return out;
}

/** True when any nested key is a handle id (fileHandleId, keyFileHandleId, adcFileHandleId …). */
function handleIds(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => handleIds(x, out));
  else if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/HandleId$/.test(k) && typeof val === "string" && val !== "") out.push(val);
      else handleIds(val, out);
    }
  }
  return out;
}

function usesHandle(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(usesHandle);
  if (!v || typeof v !== "object") return false;
  return Object.entries(v as Record<string, unknown>).some(
    ([k, val]) => (/HandleId$/.test(k) && typeof val === "string" && val !== "") || usesHandle(val),
  );
}

export function cleanConnection(row: db.SavedConnection): db.SavedConnection {
  const options = stripSecretsDeep(row.options ?? {}) as Record<string, unknown>;
  const out: db.SavedConnection = { ...row, options };
  if (usesHandle(row.options)) out.needsRepick = true;
  return out;
}

export function cleanRecentFile(row: db.RecentFile): Record<string, unknown> {
  const { handle: _handle, ...rest } = row;
  return row.src ? rest : { ...rest, needsRepick: true };
}

// ---- export --------------------------------------------------------------------------------------

export async function exportAll(io: BackupIO = idbBackupIO, now = Date.now()): Promise<BackupFile> {
  const stores: BackupFile["stores"] = {};
  for (const s of BACKUP_STORES) {
    let rows: Record<string, unknown>[];
    try {
      rows = await io.getAll(s);
    } catch {
      rows = [];
    }
    stores[s] = cleanRows(s, rows, stores);
  }
  const raw = await io.getSettings(BACKUP_SETTINGS_KEYS).catch(() => ({}) as Record<string, unknown>);
  const settings: Record<string, unknown> = {};
  for (const k of BACKUP_SETTINGS_KEYS) if (raw[k] !== undefined) settings[k] = raw[k];
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: now, stores, settings };
}

function cleanRows(s: BackupStore, rows: Record<string, unknown>[], done: BackupFile["stores"]): Record<string, unknown>[] {
  switch (s) {
    case "connections":
      return rows.map((r) => cleanConnection(r as unknown as db.SavedConnection) as unknown as Record<string, unknown>);
    case "recentFiles":
      return rows.map((r) => cleanRecentFile(r as unknown as db.RecentFile));
    case "collections":
      return rows.map((r) => stripCollectionSecrets(r as unknown as Collection) as unknown as Record<string, unknown>);
    case "namedQueries": {
      // Collections come first in BACKUP_STORES, so their var lists are known here.
      const vars = new Map((done.collections ?? []).map((c) => [c.id as string, (c as unknown as Collection).vars ?? []]));
      return rows.map((r) => {
        const q = r as unknown as NamedQuery;
        return stripQuerySecrets(q, vars.get(q.collectionId) ?? []) as unknown as Record<string, unknown>;
      });
    }
    case "chains":
      return rows.map((r) => {
        const c = r as unknown as Chain;
        return { ...c, vars: (c.vars ?? []).map((v) => (v.secret ? { ...v, value: undefined } : v)) } as unknown as Record<string, unknown>;
      });
    default:
      return rows;
  }
}

/** True when there is nothing worth backing up (no rows in any store). */
export function isEmptyBackup(b: BackupFile): boolean {
  return BACKUP_STORES.every((s) => (b.stores[s]?.length ?? 0) === 0);
}

// ---- validation ----------------------------------------------------------------------------------

/** Parses and validates a backup; throws BackupError with a message fit for the UI. */
export function parseBackup(input: string | unknown): BackupFile {
  let v: unknown = input;
  if (typeof input === "string") {
    try {
      v = JSON.parse(input);
    } catch {
      throw new BackupError("This file isn't valid JSON, so it can't be a dbui backup.");
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BackupError("This file isn't a dbui backup (expected a JSON object).");
  const o = v as Record<string, unknown>;
  if (o.format === "dbui-collection") {
    throw new BackupError("This is a single collection export. Import it from the Collections panel instead.");
  }
  if (o.format !== BACKUP_FORMAT) throw new BackupError(`This file isn't a dbui backup (format is ${JSON.stringify(o.format ?? null)}, expected "${BACKUP_FORMAT}").`);
  if (typeof o.version !== "number" || !Number.isInteger(o.version) || o.version < 1) {
    throw new BackupError(`This backup uses an old or unknown format version (${JSON.stringify(o.version ?? null)}). This dbui reads version ${BACKUP_VERSION}.`);
  }
  if (o.version > BACKUP_VERSION) {
    throw new BackupError(`This backup was made by a newer dbui (format version ${o.version}). Update dbui to import it; this one reads version ${BACKUP_VERSION}.`);
  }
  if (!o.stores || typeof o.stores !== "object" || Array.isArray(o.stores)) throw new BackupError("This backup has no \"stores\" section.");
  const stores: BackupFile["stores"] = {};
  for (const s of BACKUP_STORES) {
    const rows = (o.stores as Record<string, unknown>)[s];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) throw new BackupError(`"${s}" in this backup should be a list.`);
    rows.forEach((r, i) => {
      if (!r || typeof r !== "object" || typeof (r as { id?: unknown }).id !== "string") {
        throw new BackupError(`Row ${i + 1} of "${s}" has no id.`);
      }
    });
    stores[s] = rows as Record<string, unknown>[];
  }
  const settings = o.settings && typeof o.settings === "object" && !Array.isArray(o.settings) ? (o.settings as Record<string, unknown>) : {};
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: typeof o.exportedAt === "number" ? o.exportedAt : 0, stores, settings };
}

// ---- summary ---------------------------------------------------------------------------------------

const LABELS: Record<BackupStore, [string, string]> = {
  connections: ["connection", "connections"],
  collections: ["collection", "collections"],
  chains: ["workflow", "workflows"],
  namedQueries: ["saved query", "saved queries"],
  folders: ["folder", "folders"],
  history: ["history entry", "history entries"],
  recentFiles: ["recent file", "recent files"],
  groups: ["group", "groups"],
  queries: ["old saved query", "old saved queries"],
};
const SUMMARY_ORDER: BackupStore[] = ["connections", "collections", "chains", "namedQueries", "folders", "history", "recentFiles", "groups", "queries"];

export interface BackupSummary {
  counts: Partial<Record<BackupStore, number>>;
  /** "12 connections, 3 collections, 5 workflows, 40 history entries" */
  text: string;
  needsRepick: number;
}

export function summarize(b: BackupFile): BackupSummary {
  const counts: BackupSummary["counts"] = {};
  const parts: string[] = [];
  for (const s of SUMMARY_ORDER) {
    const n = b.stores[s]?.length ?? 0;
    counts[s] = n;
    if (n > 0) parts.push(`${n} ${LABELS[s][n === 1 ? 0 : 1]}`);
  }
  const needsRepick = [...(b.stores.connections ?? []), ...(b.stores.recentFiles ?? [])].filter((r) => r.needsRepick === true).length;
  return { counts, text: parts.length ? parts.join(", ") : "nothing saved", needsRepick };
}

// ---- import ------------------------------------------------------------------------------------------

/** The time a row was last changed, for merge: updatedAt, else the store's own timestamp. */
export function rowStamp(row: Record<string, unknown>): number {
  for (const k of ["updatedAt", "lastUsedAt", "openedAt", "at", "createdAt"]) {
    const v = row[k];
    if (typeof v === "number") return v;
  }
  return 0;
}

/**
 * Writes a backup into the stores.
 *   replace: every backed-up store is cleared first, then filled from the file; settings in the
 *            file overwrite the local ones.
 *   merge:   rows are matched by id; the one with the newer updatedAt (or the store's own
 *            timestamp) wins, ties keep the local row. Local settings are kept; settings only
 *            come from the file when they aren't set locally.
 * The "handles" store is never touched.
 */
export async function importAll(input: BackupFile | string | unknown, opts: { mode: ImportMode }, io: BackupIO = idbBackupIO): Promise<ImportResult> {
  const file = parseBackup(input);
  const result: ImportResult = { written: {}, keptLocal: 0, settings: [] };
  const handles = (await io.getHandles?.().catch(() => undefined)) ?? new Map<string, FileSystemFileHandle>();
  for (const s of BACKUP_STORES) {
    const incoming = file.stores[s]?.map((r) => reattach(s, r, handles));
    if (opts.mode === "replace") {
      await io.clear(s);
      if (incoming?.length) await io.putMany(s, incoming);
      result.written[s] = incoming?.length ?? 0;
      continue;
    }
    if (!incoming?.length) continue;
    const local = new Map((await io.getAll(s)).map((r) => [r.id as string, r]));
    const toWrite = incoming.filter((r) => {
      const mine = local.get(r.id as string);
      if (!mine || rowStamp(r) > rowStamp(mine)) return true;
      result.keptLocal++;
      return false;
    });
    if (toWrite.length) await io.putMany(s, toWrite);
    result.written[s] = toWrite.length;
  }

  const allowed = Object.fromEntries(Object.entries(file.settings).filter(([k]) => (BACKUP_SETTINGS_KEYS as readonly string[]).includes(k)));
  let apply = allowed;
  if (opts.mode === "merge") {
    const current = await io.getSettings(Object.keys(allowed)).catch(() => ({}) as Record<string, unknown>);
    apply = Object.fromEntries(Object.entries(allowed).filter(([k]) => current[k] === undefined));
  }
  await io.setSettings(apply);
  result.settings = Object.keys(apply);
  return result;
}

/** Clears needsRepick (and puts the handle back on recent files) when the picked file is still
 *  in this profile's "handles" store. */
function reattach(s: BackupStore, row: Record<string, unknown>, handles: Map<string, FileSystemFileHandle>): Record<string, unknown> {
  if (row.needsRepick !== true || handles.size === 0) return row;
  if (s === "recentFiles") {
    const h = handles.get(row.id as string);
    if (!h) return row;
    const { needsRepick: _n, ...rest } = row;
    return { ...rest, handle: h };
  }
  if (s === "connections") {
    const ids = handleIds(row.options);
    if (ids.length === 0 || !ids.every((id) => handles.has(id))) return row;
    const { needsRepick: _n, ...rest } = row;
    return rest;
  }
  return row;
}

/** True when nothing the restore banner cares about is saved yet: no connections, collections or history. */
export async function isDatabaseEmpty(io: Pick<BackupIO, "getAll"> = idbBackupIO): Promise<boolean> {
  for (const s of ["connections", "collections", "history"] as const) {
    const rows = await io.getAll(s).catch(() => []);
    if (rows.length > 0) return false;
  }
  return true;
}
