// Automatic backup through the runner (DESIGN.md §3.16).
//
// About 5 s after the last IndexedDB write (db.onStoreChange) or change to a backed-up setting,
// the app sends exportAll() to the runner (`backup.write`), which keeps it in
// ~/Library/Application Support/dbui/backup.json. On a fresh install with an empty database the
// Home page offers to restore it (checkForRestore + RestoreBanner). Without the runner nothing
// happens: "not installed" and "older runner" errors are swallowed.
//
// Safety: a fresh profile must never overwrite a backup it hasn't seen, or the very thing the
// backup exists for (reinstalling) would destroy it on the first write. So automatic writes only
// happen once this profile is "linked" to the file: after it wrote it, restored from it, or the
// user chose "Back up now", or when no backup file existed yet. The flag lives in
// chrome.storage.local, which Chrome clears on uninstall, so a reinstall starts unlinked.

import { RUNNER_HOST, type RunnerMessage } from "@core/runner-protocol";
import { BACKUP_SETTINGS_KEYS, exportAll, importAll, isDatabaseEmpty, parseBackup, summarize, type BackupFile, type BackupIO, type BackupSummary, idbBackupIO } from "./backup";
import * as db from "./db";

export const AUTO_BACKUP_DELAY_MS = 5000;
export const BACKUP_STATE_KEY = "backupState";

export interface BackupState {
  /** This profile wrote, restored or explicitly replaced the runner's backup file. */
  linked: boolean;
  /** When this profile last wrote the file (ms), and the file's mtime then. */
  lastWriteAt?: number;
  lastMtime?: number;
  lastError?: string;
}

// ---- transport: one short-lived native port per call -------------------------------------------

export class BackupUnavailable extends Error {
  constructor(
    message: string,
    readonly reason: "not-installed" | "unsupported" | "no-extension",
  ) {
    super(message);
    this.name = "BackupUnavailable";
  }
}

export interface BackupTransport {
  write(json: string): Promise<{ mtime: number }>;
  read(): Promise<{ json: string | null; mtime: number | null }>;
}

function call(req: { op: "backup.write"; json: string } | { op: "backup.read" }, timeoutMs: number): Promise<{ final: RunnerMessage; chunks: string[] }> {
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.connectNative) {
      reject(new BackupUnavailable("Native messaging is only available inside the extension.", "no-extension"));
      return;
    }
    let port: chrome.runtime.Port;
    let done = false;
    const chunks: string[] = [];
    const finish = (err: Error | null, final?: RunnerMessage) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        port?.disconnect();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve({ final: final!, chunks });
    };
    const timer = setTimeout(() => finish(new Error("The runner did not answer in time.")), timeoutMs);
    try {
      port = chrome.runtime.connectNative(RUNNER_HOST);
    } catch (e) {
      finish(classify((e as Error).message));
      return;
    }
    port.onDisconnect.addListener(() => finish(classify(chrome.runtime.lastError?.message)));
    port.onMessage.addListener((msg: RunnerMessage) => {
      if (msg.id !== 1) return;
      if (msg.type === "chunk") chunks[msg.seq] = msg.data;
      else if (msg.type === "error") {
        finish(msg.code === "UNKNOWN_OP" ? new BackupUnavailable("This dbui runner is too old for automatic backup; update it.", "unsupported") : new Error(msg.message));
      } else finish(null, msg);
    });
    port.postMessage({ id: 1, ...req });
  });
}

function classify(message: string | undefined): Error {
  const m = message ?? "The runner closed the connection";
  if (/not found/i.test(m)) return new BackupUnavailable("dbui runner is not installed", "not-installed");
  return new Error(`dbui runner: ${m}`);
}

export const runnerBackupTransport: BackupTransport = {
  async write(json) {
    const { final } = await call({ op: "backup.write", json }, 30_000);
    const mtime = final.type === "ok" && typeof final.mtime === "number" ? final.mtime : Date.now();
    return { mtime };
  },
  async read() {
    const { final, chunks } = await call({ op: "backup.read" }, 60_000);
    if (final.type !== "backup") throw new Error(`Unexpected runner reply: ${final.type}`);
    if (!final.exists) return { json: null, mtime: null };
    if (chunks.length !== final.chunks || chunks.some((c) => c === undefined)) throw new Error("The backup arrived incomplete.");
    return { json: chunks.join(""), mtime: final.mtime };
  },
};

// ---- state in chrome.storage.local ----------------------------------------------------------------

export interface StateIO {
  load(): Promise<BackupState>;
  save(s: BackupState): Promise<void>;
}

export const chromeStateIO: StateIO = {
  async load() {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return { linked: false };
    const got = await chrome.storage.local.get(BACKUP_STATE_KEY);
    const v = got[BACKUP_STATE_KEY];
    return v && typeof v === "object" ? { ...(v as Partial<BackupState>), linked: (v as Partial<BackupState>).linked === true } : { linked: false };
  },
  async save(s) {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    await chrome.storage.local.set({ [BACKUP_STATE_KEY]: s });
  },
};

// ---- the debounced writer --------------------------------------------------------------------------

export type BackupOutcome =
  | { kind: "written"; at: number; mtime: number }
  | { kind: "paused"; mtime: number | null }
  | { kind: "unavailable"; reason: BackupUnavailable["reason"] }
  | { kind: "error"; message: string };

export interface AutoBackupDeps {
  transport?: BackupTransport;
  exportFn?: () => Promise<BackupFile>;
  state?: StateIO;
  delayMs?: number;
  now?: () => number;
  onOutcome?: (o: BackupOutcome) => void;
}

export interface AutoBackup {
  /** Restart the debounce timer; the write happens delayMs after the last call. */
  schedule(): void;
  /** Write now if a write is pending (page hide). */
  flush(): Promise<void>;
  /** Write now regardless of the link state ("Back up now"). Links this profile to the file. */
  backupNow(): Promise<BackupOutcome>;
  readonly pending: boolean;
  dispose(): void;
}

export function createAutoBackup(deps: AutoBackupDeps = {}): AutoBackup {
  const transport = deps.transport ?? runnerBackupTransport;
  const exportFn = deps.exportFn ?? (() => exportAll());
  const state = deps.state ?? chromeStateIO;
  const delay = deps.delayMs ?? AUTO_BACKUP_DELAY_MS;
  const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<BackupOutcome> | null = null;
  let again = false;
  /** Set once the runner turns out to be missing or too old; no more automatic tries this page. */
  let unavailable = false;

  const report = (o: BackupOutcome) => {
    deps.onOutcome?.(o);
    return o;
  };

  async function write(force: boolean): Promise<BackupOutcome> {
    try {
      const st = await state.load().catch(() => ({ linked: false }) as BackupState);
      if (!st.linked && !force) {
        // A backup this profile hasn't seen may be someone's only copy: leave it alone.
        const existing = await transport.read();
        if (existing.json !== null) return report({ kind: "paused", mtime: existing.mtime });
      }
      const file = await exportFn();
      const { mtime } = await transport.write(JSON.stringify(file));
      const at = now();
      await state.save({ linked: true, lastWriteAt: at, lastMtime: mtime }).catch(() => {});
      return report({ kind: "written", at, mtime });
    } catch (e) {
      if (e instanceof BackupUnavailable) {
        unavailable = true;
        return report({ kind: "unavailable", reason: e.reason });
      }
      const message = (e as Error).message;
      const st = await state.load().catch(() => ({ linked: false }) as BackupState);
      await state.save({ ...st, lastError: message }).catch(() => {});
      return report({ kind: "error", message });
    }
  }

  function run(force: boolean): Promise<BackupOutcome> {
    if (running) {
      again = true;
      return running;
    }
    running = write(force).finally(() => {
      running = null;
      if (again) {
        again = false;
        api.schedule();
      }
    });
    return running;
  }

  const api: AutoBackup = {
    schedule() {
      if (unavailable) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void run(false);
      }, delay);
    },
    async flush() {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      await run(false);
    },
    async backupNow() {
      clearTimeout(timer);
      timer = undefined;
      unavailable = false;
      if (running) await running;
      return run(true);
    },
    get pending() {
      return timer !== undefined;
    },
    dispose() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
  return api;
}

// ---- app wiring -------------------------------------------------------------------------------------

let instance: AutoBackup | null = null;

/** The app-wide auto-backup, created by startAutoBackup(). */
export function autoBackup(): AutoBackup {
  if (!instance) instance = createAutoBackup();
  return instance;
}

/** Hooks the auto-backup to IndexedDB writes and backed-up settings. Returns a stop function. */
export function startAutoBackup(): () => void {
  const ab = autoBackup();
  const offDb = db.onStoreChange((name) => {
    if (name !== "handles") ab.schedule();
  });
  const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && BACKUP_SETTINGS_KEYS.some((k) => k in changes)) ab.schedule();
  };
  const hasStorage = typeof chrome !== "undefined" && !!chrome.storage?.onChanged;
  if (hasStorage) chrome.storage.onChanged.addListener(onStorage);
  const onHide = () => {
    if (document.visibilityState === "hidden") void ab.flush();
  };
  document.addEventListener("visibilitychange", onHide);
  return () => {
    offDb();
    if (hasStorage) chrome.storage.onChanged.removeListener(onStorage);
    document.removeEventListener("visibilitychange", onHide);
  };
}

// ---- restore on a fresh install ----------------------------------------------------------------

export interface RestoreOffer {
  backup: BackupFile;
  summary: BackupSummary;
  /** File mtime (ms), else the backup's exportedAt. */
  at: number;
}

/**
 * What the Home banner offers: a runner backup, but only when this profile has no connections,
 * collections or history. Null when there's data, no runner, no backup or an unreadable one.
 */
export async function checkForRestore(deps: { io?: Pick<BackupIO, "getAll">; transport?: BackupTransport } = {}): Promise<RestoreOffer | null> {
  if (!(await isDatabaseEmpty(deps.io ?? idbBackupIO))) return null;
  let got: { json: string | null; mtime: number | null };
  try {
    got = await (deps.transport ?? runnerBackupTransport).read();
  } catch {
    return null; // runner missing, too old or failing: nothing to offer
  }
  if (got.json === null) return null;
  let backup: BackupFile;
  try {
    backup = parseBackup(got.json);
  } catch {
    return null;
  }
  const summary = summarize(backup);
  if (Object.values(summary.counts).every((n) => !n)) return null;
  return { backup, summary, at: got.mtime ?? backup.exportedAt };
}

/** Restores an offer in replace mode and links this profile to the backup file. */
export async function restoreOffer(offer: RestoreOffer, deps: { io?: BackupIO; state?: StateIO } = {}) {
  const result = await importAll(offer.backup, { mode: "replace" }, deps.io ?? idbBackupIO);
  const state = deps.state ?? chromeStateIO;
  await state.save({ linked: true, lastMtime: offer.at, lastWriteAt: (await state.load()).lastWriteAt }).catch(() => {});
  return result;
}
