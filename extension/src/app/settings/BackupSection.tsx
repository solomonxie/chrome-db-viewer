// Settings → Backup (DESIGN.md §3.16): export / import a backup file, and the runner's
// automatic backup (last time, "Back up now").

import { useEffect, useRef, useState } from "react";
import { exportAll, importAll, parseBackup, summarize, type BackupFile, type ImportMode } from "../store/backup";
import { autoBackup, BACKUP_STATE_KEY, chromeStateIO, runnerBackupTransport, type BackupState } from "../store/autoBackup";
import { useToast } from "../components/ui";
import { fmtAgo } from "../lib/format";

interface SaveFilePickerWindow {
  showSaveFilePicker?: (opts: { suggestedName?: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
}

export function backupFileName(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `dbui-backup-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}.json`;
}

/** Saves the JSON with showSaveFilePicker when there is one, else chrome.downloads (blob URL). */
async function saveJson(text: string, name: string): Promise<"saved" | "cancelled"> {
  const w = window as SaveFilePickerWindow;
  if (w.showSaveFilePicker) {
    try {
      const h = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: "dbui backup", accept: { "application/json": [".json"] } }] });
      const out = await h.createWritable();
      await out.write(text);
      await out.close();
      return "saved";
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return "cancelled";
      throw e;
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  try {
    if (typeof chrome !== "undefined" && chrome.downloads?.download) {
      await chrome.downloads.download({ url, filename: name, saveAs: true });
    } else {
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
    }
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return "saved";
}

type Pending = { file: BackupFile; name: string; confirm?: ImportMode };

export function BackupSection() {
  const toast = useToast();
  const [state, setState] = useState<BackupState | null>(null);
  const [runnerFile, setRunnerFile] = useState<{ mtime: number | null } | "none" | "unavailable" | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    void chromeStateIO.load().then(setState).catch(() => setState({ linked: false }));
    void runnerBackupTransport
      .read()
      .then((r) => setRunnerFile(r.json === null ? "none" : { mtime: r.mtime }))
      .catch(() => setRunnerFile("unavailable"));
  };

  useEffect(() => {
    refresh();
    if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
    const on = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && BACKUP_STATE_KEY in changes) setState({ ...(changes[BACKUP_STATE_KEY]?.newValue as Partial<BackupState>), linked: !!(changes[BACKUP_STATE_KEY]?.newValue as Partial<BackupState> | undefined)?.linked });
    };
    chrome.storage.onChanged.addListener(on);
    return () => chrome.storage.onChanged.removeListener(on);
  }, []);

  const doExport = async () => {
    setErr(null);
    try {
      const file = await exportAll();
      if ((await saveJson(JSON.stringify(file, null, 2), backupFileName())) === "saved") toast(`Exported ${summarize(file).text}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const onPicked = async (f: File | undefined) => {
    setErr(null);
    if (!f) return;
    try {
      setPending({ file: parseBackup(await f.text()), name: f.name });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const doImport = async (mode: ImportMode) => {
    if (!pending) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await importAll(pending.file, { mode });
      const n = Object.values(r.written).reduce((a, b) => a + (b ?? 0), 0);
      toast(mode === "replace" ? `Replaced with ${summarize(pending.file).text}` : `Merged ${n} rows${r.keptLocal ? `, kept ${r.keptLocal} newer local rows` : ""}`);
      setPending(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const backupNow = async () => {
    setBusy(true);
    setErr(null);
    const o = await autoBackup().backupNow();
    setBusy(false);
    if (o.kind === "written") toast("Backed up to the runner");
    else if (o.kind === "unavailable") setErr(o.reason === "unsupported" ? "The installed dbui runner is too old for backups. Update it." : "The dbui runner isn't installed, so there's no automatic backup.");
    else if (o.kind === "error") setErr(o.message);
    refresh();
  };

  const summary = pending ? summarize(pending.file) : null;
  const paused = state && !state.linked && runnerFile && typeof runnerFile === "object";

  return (
    <section id="settings-backup">
      <h2>Backup</h2>
      <p className="muted" style={{ margin: 0, lineHeight: 1.5, fontSize: 14.5 }}>
        Chrome deletes dbui's saved data when the extension is uninstalled. A backup keeps connections, collections, workflows, history and settings. It never contains passwords, tokens or keys; picked files have to be chosen again after a restore.
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn" onClick={() => void doExport()}>
          Export…
        </button>
        <button className="btn" onClick={() => inputRef.current?.click()}>
          Import…
        </button>
        <input ref={inputRef} type="file" accept=".json,application/json" hidden aria-label="Backup file to import" onChange={(e) => void onPicked(e.target.files?.[0])} />
      </div>

      {pending && summary && (
        <div className="note" role="group" aria-label="Import backup">
          <b>{pending.name}</b>
          {pending.file.exportedAt ? ` (from ${new Date(pending.file.exportedAt).toLocaleString()})` : ""}: {summary.text}.
          {summary.needsRepick > 0 && ` ${summary.needsRepick} picked file${summary.needsRepick === 1 ? "" : "s"} will need choosing again.`}
          {pending.confirm === "replace" ? (
            <div style={{ marginTop: 8 }}>
              <b>Replace deletes every connection, collection, workflow and history entry in this browser</b> and puts the backup's in their place.
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button className="btn danger" disabled={busy} onClick={() => void doImport("replace")}>
                  Replace everything
                </button>
                <button className="btn" disabled={busy} onClick={() => setPending({ ...pending, confirm: undefined })}>
                  Back
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <button className="btn primary" disabled={busy} onClick={() => void doImport("merge")} title="Add the backup's rows; where both have a row, the newer one wins">
                Merge
              </button>
              <button className="btn" disabled={busy} onClick={() => setPending({ ...pending, confirm: "replace" })}>
                Replace…
              </button>
              <button className="btn ghost" disabled={busy} onClick={() => setPending(null)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      <div>
        <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>Automatic backup</h3>
        {runnerFile === "unavailable" ? (
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            Needs the dbui runner (below). With it, dbui keeps a copy in <span className="mono">~/Library/Application Support/dbui/backup.json</span> a few seconds after every change.
          </p>
        ) : (
          <>
            <p className="muted" style={{ margin: "0 0 8px", fontSize: 14 }}>
              Kept in <span className="mono">~/Library/Application Support/dbui/backup.json</span> (previous copy: <span className="mono">backup.prev.json</span>).{" "}
              {runnerFile === null
                ? "Checking…"
                : runnerFile === "none"
                  ? "No backup yet."
                  : `Last backup: ${runnerFile.mtime ? `${new Date(runnerFile.mtime).toLocaleString()} (${fmtAgo(runnerFile.mtime)})` : "unknown"}.`}
            </p>
            {paused && (
              <div className="note" style={{ marginBottom: 8 }}>
                <b>Automatic backup is paused.</b> The file holds a backup this browser hasn't restored, so dbui won't overwrite it. Restore it from Home (shown when nothing is saved yet), or press Back up now to replace it with this browser's data.
              </div>
            )}
            {state?.lastError && <div className="err" style={{ marginBottom: 8 }}>Last automatic backup failed: {state.lastError}</div>}
            <button className="btn" disabled={busy} onClick={() => void backupNow()}>
              Back up now
            </button>
          </>
        )}
      </div>
      {err && <div className="err">{err}</div>}
    </section>
  );
}
