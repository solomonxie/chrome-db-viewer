// Opening local files with the File System Access API and remembering them as recent files.

import * as db from "../store/db";

export const DATA_FILE_ACCEPT: Record<string, string[]> = {
  "text/csv": [".csv", ".tsv", ".psv", ".txt"],
  "application/json": [".json", ".jsonl", ".ndjson"],
  "application/octet-stream": [".parquet", ".arrow", ".feather", ".gz", ".zst", ".duckdb", ".sqlite", ".db"],
};

interface OpenFilePickerWindow {
  showOpenFilePicker?: (opts: {
    multiple?: boolean;
    types?: { description: string; accept: Record<string, string[]> }[];
    excludeAcceptAllOption?: boolean;
  }) => Promise<FileSystemFileHandle[]>;
}

export function canPickFiles(): boolean {
  return typeof (window as OpenFilePickerWindow).showOpenFilePicker === "function";
}

/** Shows the picker; null when cancelled. */
export async function pickFile(accept: Record<string, string[]> = DATA_FILE_ACCEPT, description = "Data files"): Promise<FileSystemFileHandle | null> {
  const w = window as OpenFilePickerWindow;
  if (!w.showOpenFilePicker) throw new Error("This browser has no File System Access API.");
  try {
    const [h] = await w.showOpenFilePicker({ types: [{ description, accept }] });
    return h ?? null;
  } catch (e) {
    if ((e as DOMException).name === "AbortError") return null;
    throw e;
  }
}

export async function rememberFile(handle: FileSystemFileHandle): Promise<db.RecentFile> {
  const all = await db.getAll("recentFiles").catch(() => [] as db.RecentFile[]);
  for (const r of all) {
    if (r.handle && (await r.handle.isSameEntry(handle).catch(() => false))) {
      const updated = { ...r, openedAt: Date.now() };
      await db.put("recentFiles", updated);
      await db.put("handles", { id: r.id, handle: r.handle, name: r.name });
      return updated;
    }
  }
  let size: number | undefined;
  try {
    size = (await handle.getFile()).size;
  } catch {
    /* permission not granted yet */
  }
  const row: db.RecentFile = { id: db.uid("f_"), name: handle.name, handle, size, openedAt: Date.now() };
  await db.put("recentFiles", row);
  // Drivers resolve options.fileHandleId through the "handles" store.
  await db.put("handles", { id: row.id, handle, name: handle.name });
  return row;
}

export async function rememberUrl(src: string): Promise<void> {
  const all = await db.getAll("recentFiles").catch(() => [] as db.RecentFile[]);
  const existing = all.find((r) => r.src === src);
  const name = decodeURIComponent(src.split(/[?#]/)[0]!.split("/").pop() || src);
  await db.put("recentFiles", existing ? { ...existing, openedAt: Date.now() } : { id: db.uid("f_"), name, src, openedAt: Date.now() });
}

export async function recentFiles(limit = 12): Promise<db.RecentFile[]> {
  const all = await db.getAll("recentFiles").catch(() => [] as db.RecentFile[]);
  return all.sort((a, b) => b.openedAt - a.openedAt).slice(0, limit);
}

/** Chrome asks once per session before a stored handle can be read again. */
export async function ensureReadPermission(handle: FileSystemFileHandle): Promise<boolean> {
  type H = FileSystemFileHandle & {
    queryPermission?: (d: { mode: "read" }) => Promise<PermissionState>;
    requestPermission?: (d: { mode: "read" }) => Promise<PermissionState>;
  };
  const h = handle as H;
  if (!h.queryPermission) return true;
  if ((await h.queryPermission({ mode: "read" })) === "granted") return true;
  return (await h.requestPermission?.({ mode: "read" })) === "granted";
}
