// Backup file (src/app/store/backup.ts) and the runner auto-backup (src/app/store/autoBackup.ts).
// Fixtures: tests/fixtures/backup/.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  BACKUP_STORES, exportAll, importAll, parseBackup, summarize, type BackupFile, type BackupIO, type BackupStore,
} from "../../src/app/store/backup";
import { checkForRestore, createAutoBackup, restoreOffer, runnerBackupTransport, type BackupState, type StateIO } from "../../src/app/store/autoBackup";

const dir = resolve(__dirname, "../fixtures/backup");
const text = (name: string) => readFileSync(resolve(dir, name), "utf8");
const fixture = (name: string) => JSON.parse(text(name));

interface Profile {
  stores: Partial<Record<string, Record<string, unknown>[]>>;
  chromeStorageLocal?: Record<string, unknown>;
}

/** An in-memory profile (IndexedDB stores + chrome.storage.local) loaded from a fixture. */
function memoryIO(profile: Profile) {
  const stores = new Map<string, Map<string, Record<string, unknown>>>();
  for (const [name, rows] of Object.entries(profile.stores)) stores.set(name, new Map((rows ?? []).map((r) => [r.id as string, structuredClone(r)])));
  const local: Record<string, unknown> = structuredClone(profile.chromeStorageLocal ?? {});
  const store = (s: string) => {
    let m = stores.get(s);
    if (!m) stores.set(s, (m = new Map()));
    return m;
  };
  const io: BackupIO = {
    getAll: async (s) => [...store(s).values()].map((r) => structuredClone(r)),
    putMany: async (s, rows) => rows.forEach((r) => store(s).set(r.id as string, structuredClone(r))),
    clear: async (s) => store(s).clear(),
    getSettings: async (keys) => Object.fromEntries(keys.filter((k) => k in local).map((k) => [k, local[k]])),
    setSettings: async (v) => void Object.assign(local, v),
    getHandles: async () => new Map([...store("handles").values()].map((r) => [r.id as string, r.handle as FileSystemFileHandle])),
  };
  const rows = (s: string) => [...store(s).values()];
  return { io, rows, local };
}

const SECRETS = ["hunter2", "OPENSSH PRIVATE KEY", "ya29", "AIza", "tok-secret", "tok-prod-secret", "tok-in-query", "whsec", "PRIVATE KEY"];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---- export -------------------------------------------------------------------------------------

test("exportAll leaves out secrets, the SecretStore and the handles store", async () => {
  const { io } = memoryIO(fixture("idb-stores.json"));
  const file = await exportAll(io, 1761700000000);
  const json = JSON.stringify(file);

  expect(file.format).toBe("dbui-backup");
  expect(file.version).toBe(1);
  expect(file.exportedAt).toBe(1761700000000);
  expect(Object.keys(file.stores).sort()).toEqual([...BACKUP_STORES].sort());
  expect(Object.keys(file.stores)).not.toContain("handles");
  for (const s of SECRETS) expect(json).not.toContain(s);
  expect(json).not.toContain("secret:");
  expect(Object.keys(file.settings).sort()).toEqual(["previewSettings", "theme"]);

  const pg = file.stores.connections!.find((c) => c.id === "c_pg")!;
  // Refs to secrets stay; the secrets don't.
  expect(pg.secretRef).toBe("c_pg");
  expect(pg.options).toEqual({
    secretMode: "keychain", host: "db.shop.internal", port: 5432, user: "app", database: "shop",
    ssh: { host: "bastion", user: "deploy", keySecretRef: "c_pg_sshKey" },
  });
  const bq = file.stores.connections!.find((c) => c.id === "c_bq")!;
  expect(bq.options).toEqual({ secretMode: "browser", projectId: "acme", auth: { method: "service-account", options: { keyFileHandleId: "h_key" } } });

  const col = file.stores.collections![0] as { vars: { name: string; value?: unknown }[]; environments: { values: Record<string, unknown> }[] };
  expect(col.vars).toEqual([{ name: "region", value: "eu" }, { name: "apiToken", secret: true, value: undefined }]);
  expect(col.environments[0]!.values).toEqual({ region: "us" });
  const nq = file.stores.namedQueries![0] as { vars: { name: string; value?: unknown }[] };
  expect(nq.vars.find((v) => v.name === "apiToken")!.value).toBeUndefined();
  expect(nq.vars.find((v) => v.name === "limit")!.value).toBe(10);
});

test("exportAll marks connections and recent files that used a picked file as needing a re-pick", async () => {
  const { io } = memoryIO(fixture("idb-stores.json"));
  const file = await exportAll(io);
  const byId = (s: BackupStore) => Object.fromEntries(file.stores[s]!.map((r) => [r.id, r]));

  expect(byId("connections").c_duck!.needsRepick).toBe(true);
  expect(byId("connections").c_bq!.needsRepick).toBe(true); // keyFileHandleId
  expect(byId("connections").c_pg!.needsRepick).toBeUndefined();

  expect(byId("recentFiles").f_local).toEqual({ id: "f_local", name: "orders.csv", size: 2048, openedAt: 1761500000000, needsRepick: true });
  expect(byId("recentFiles").f_url).toEqual({ id: "f_url", name: "events.parquet", src: "https://data.example.org/events.parquet", openedAt: 1761510000000 });
  expect(summarize(file).needsRepick).toBe(3);
});

// ---- import -------------------------------------------------------------------------------------

test("export then replace-import into an empty profile round-trips every row", async () => {
  const source = memoryIO(fixture("idb-stores.json"));
  const file = await exportAll(source.io);
  const target = memoryIO({ stores: {} });

  const result = await importAll(JSON.stringify(file), { mode: "replace" }, target.io);
  for (const s of BACKUP_STORES) expect(target.rows(s)).toEqual(file.stores[s]);
  expect(result.written.connections).toBe(3);
  expect(target.local).toEqual({ previewSettings: { enabled: true, extensions: ["csv", "parquet"], excludedDomains: ["example.com"] }, theme: "light" });
  expect(target.rows("handles")).toEqual([]);
});

test("merge keeps the newer row by updatedAt (or the store's timestamp) and adds new ones", async () => {
  const local = memoryIO(fixture("local-before-merge.json"));
  const result = await importAll(text("backup-v1.json"), { mode: "merge" }, local.io);
  const byId = (s: string) => Object.fromEntries(local.rows(s).map((r) => [r.id, r]));

  // collections: local col_1 (updatedAt …400) is newer than the backup's (…300); col_2 is new.
  expect(byId("collections").col_1!.name).toBe("Reports");
  expect(byId("collections").col_2!.name).toBe("Ops");
  // namedQueries: the backup's nq_1 (…650) is newer than local (…400).
  expect(byId("namedQueries").nq_1!.sql).toBe("select 'newer in backup'");
  // connections have no updatedAt: lastUsedAt decides, and the backup's is newer.
  expect(byId("connections").c_pg!.name).toBe("shop prod (renamed in backup)");
  expect(byId("connections").c_duck).toBeDefined();
  // history rows are distinct ids, so both are kept.
  expect(Object.keys(byId("history")).sort()).toEqual(["h1", "h9"]);
  expect(result.keptLocal).toBe(1);
  // Local settings win on merge; unset ones come from the backup. secret:* never applies.
  expect(local.local).toEqual({ theme: "light", previewSettings: { enabled: false, extensions: ["csv"], excludedDomains: [] } });
});

test("replace clears local rows the backup doesn't have, and restores on the same profile re-attach surviving handles", async () => {
  const local = memoryIO(fixture("idb-stores.json"));
  await importAll(text("backup-v1.json"), { mode: "replace" }, local.io);

  expect(local.rows("connections").map((r) => r.id).sort()).toEqual(["c_duck", "c_pg"]);
  expect(local.rows("chains")).toEqual([]);
  // h_duck and f_local are still in this profile's handles store.
  const duck = local.rows("connections").find((r) => r.id === "c_duck")!;
  expect(duck.needsRepick).toBeUndefined();
  const f = local.rows("recentFiles").find((r) => r.id === "f_local")!;
  expect(f.needsRepick).toBeUndefined();
  expect(f.handle).toEqual({ kind: "file", name: "orders.csv" });
  expect(local.rows("handles").length).toBe(2);
  expect(local.local.theme).toBe("dark");
  expect(local.local["secret:c_pg"]).toBe("hunter2");
});

test("invalid, old and foreign files are rejected with a clear message and write nothing", async () => {
  const cases: [string, RegExp][] = [
    ["truncated.json", /isn't valid JSON/],
    ["wrong-format.json", /isn't a dbui backup \(format is "something-else"/],
    ["collection-export.json", /single collection export/],
    ["old-version.json", /old or unknown format version \(0\)/],
    ["newer-version.json", /newer dbui \(format version 2\)/],
    ["row-without-id.json", /Row 1 of "connections" has no id/],
  ];
  for (const [name, message] of cases) {
    expect(() => parseBackup(text(name)), name).toThrow(message);
    const target = memoryIO(fixture("local-before-merge.json"));
    await expect(importAll(text(name), { mode: "replace" }, target.io)).rejects.toThrow(message);
    expect(target.rows("connections").length).toBe(1);
  }
});

test("summarize counts rows the way the import prompt and restore banner show them", () => {
  const s = summarize(parseBackup(text("backup-v1.json")));
  expect(s.text).toBe("2 connections, 2 collections, 1 saved query, 1 history entry, 1 recent file");
  expect(s.needsRepick).toBe(2);
});

// ---- restore banner -----------------------------------------------------------------------------

const backupTransport = (json: string | null, mtime: number | null = 1761700000000) => ({
  read: vi.fn(async () => ({ json, mtime })),
  write: vi.fn(async () => ({ mtime: Date.now() })),
});

test("the restore banner is offered only when the database is empty and a backup exists", async () => {
  const backup = text("backup-v1.json");

  const empty = memoryIO({ stores: {} });
  const offer = await checkForRestore({ io: empty.io, transport: backupTransport(backup) });
  expect(offer?.at).toBe(1761700000000);
  expect(offer?.summary.text).toMatch(/^2 connections, 2 collections/);

  // Existing data: never offered (and the runner isn't even asked).
  const busy = memoryIO(fixture("local-before-merge.json"));
  const t = backupTransport(backup);
  expect(await checkForRestore({ io: busy.io, transport: t })).toBeNull();
  expect(t.read).not.toHaveBeenCalled();
  // History alone counts as data.
  expect(await checkForRestore({ io: memoryIO({ stores: { history: [{ id: "h", connectionId: "c", sql: "", at: 1 }] } }).io, transport: backupTransport(backup) })).toBeNull();

  // No backup, an unreadable one, or no runner: nothing to offer.
  expect(await checkForRestore({ io: empty.io, transport: backupTransport(null) })).toBeNull();
  expect(await checkForRestore({ io: empty.io, transport: backupTransport(text("truncated.json")) })).toBeNull();
  const missing = { read: vi.fn(async () => Promise.reject(new Error("Specified native messaging host not found."))), write: vi.fn() };
  expect(await checkForRestore({ io: empty.io, transport: missing })).toBeNull();
});

test("restoring the offer imports in replace mode and links this profile to the backup file", async () => {
  const empty = memoryIO({ stores: {} });
  const offer = (await checkForRestore({ io: empty.io, transport: backupTransport(text("backup-v1.json")) }))!;
  let saved: BackupState = { linked: false };
  const state: StateIO = { load: async () => saved, save: async (s) => void (saved = s) };
  await restoreOffer(offer, { io: empty.io, state });
  expect(empty.rows("connections").length).toBe(2);
  expect(saved.linked).toBe(true);
});

// ---- debounced auto-backup through the runner ----------------------------------------------------

/** chrome.runtime.connectNative stand-in for a runner that speaks backup.write / backup.read. */
function stubRunner(initial: string | null) {
  const disk = { json: initial, mtime: initial ? 1761000000000 : 0 };
  const requests: { op: string; json?: string }[] = [];
  const connectNative = vi.fn(() => {
    const msgL: ((m: unknown) => void)[] = [];
    const port = {
      onMessage: { addListener: (l: (m: unknown) => void) => msgL.push(l) },
      onDisconnect: { addListener: () => {} },
      disconnect: vi.fn(),
      postMessage: (req: { id: number; op: string; json?: string }) => {
        requests.push(req);
        queueMicrotask(() => {
          if (req.op === "backup.write") {
            disk.json = req.json!;
            disk.mtime = Date.now();
            msgL.forEach((l) => l({ id: req.id, type: "ok", mtime: disk.mtime, size: req.json!.length }));
          } else if (req.op === "backup.read") {
            const pieces = disk.json ? [disk.json.slice(0, 10), disk.json.slice(10)] : [];
            pieces.forEach((data, seq) => msgL.forEach((l) => l({ id: req.id, type: "chunk", seq, data })));
            msgL.forEach((l) => l({ id: req.id, type: "backup", exists: !!disk.json, mtime: disk.json ? disk.mtime : null, size: disk.json?.length ?? 0, chunks: pieces.length }));
          }
        });
      },
    };
    return port;
  });
  vi.stubGlobal("chrome", { runtime: { connectNative, lastError: undefined } });
  return { disk, requests, connectNative };
}

const memoryState = (initial: BackupState): StateIO & { value: BackupState } => {
  const s = { value: initial, load: async () => s.value, save: async (v: BackupState) => void (s.value = v) };
  return s;
};

test("a burst of writes sends one backup.write to the runner about 5 s after the last one", async () => {
  vi.useFakeTimers();
  const runner = stubRunner(null);
  const { io } = memoryIO(fixture("idb-stores.json"));
  const state = memoryState({ linked: true });
  const ab = createAutoBackup({ transport: runnerBackupTransport, exportFn: () => exportAll(io), state });

  for (let i = 0; i < 20; i++) {
    await vi.advanceTimersByTimeAsync(300);
    ab.schedule(); // what every db put/del does through onStoreChange
  }
  expect(runner.requests).toEqual([]);
  await vi.advanceTimersByTimeAsync(4999);
  expect(runner.requests).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await vi.runAllTimersAsync();

  expect(runner.requests.map((r) => r.op)).toEqual(["backup.write"]);
  const sent = parseBackup(runner.requests[0]!.json!) as BackupFile;
  expect(sent.stores.connections!.length).toBe(3);
  for (const s of SECRETS) expect(runner.requests[0]!.json).not.toContain(s);
  expect(state.value.linked).toBe(true);
  expect(state.value.lastWriteAt).toBeGreaterThan(0);
});

test("a fresh profile never overwrites a backup it hasn't restored; Back up now does", async () => {
  vi.useFakeTimers();
  const theirs = text("backup-v1.json");
  const runner = stubRunner(theirs);
  const { io } = memoryIO({ stores: { connections: [{ id: "c_new", name: "new", driver: "duckdb", env: "local", readOnly: false, options: {}, createdAt: 1 }] } });
  const state = memoryState({ linked: false });
  const outcomes: string[] = [];
  const ab = createAutoBackup({ transport: runnerBackupTransport, exportFn: () => exportAll(io), state, onOutcome: (o) => outcomes.push(o.kind) });

  ab.schedule();
  await vi.runAllTimersAsync();
  expect(runner.requests.map((r) => r.op)).toEqual(["backup.read"]);
  expect(runner.disk.json).toBe(theirs);
  expect(outcomes).toEqual(["paused"]);

  const o = await ab.backupNow();
  expect(o.kind).toBe("written");
  expect(parseBackup(runner.disk.json!).stores.connections!.map((c) => c.id)).toEqual(["c_new"]);
  expect(state.value.linked).toBe(true);
});

test("without the runner, auto-backup gives up quietly and stops trying", async () => {
  vi.useFakeTimers();
  const connectNative = vi.fn(() => {
    throw new Error("Specified native messaging host not found.");
  });
  vi.stubGlobal("chrome", { runtime: { connectNative } });
  const outcomes: unknown[] = [];
  const ab = createAutoBackup({ transport: runnerBackupTransport, exportFn: async () => parseBackup(text("backup-v1.json")), state: memoryState({ linked: true }), onOutcome: (o) => outcomes.push(o) });
  ab.schedule();
  await vi.runAllTimersAsync();
  expect(outcomes).toEqual([{ kind: "unavailable", reason: "not-installed" }]);
  ab.schedule();
  await vi.runAllTimersAsync();
  expect(connectNative).toHaveBeenCalledTimes(1);
});
