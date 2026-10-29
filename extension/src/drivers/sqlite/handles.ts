// Minimal reader for picked-file handles. The app stores them in IndexedDB "dbui", object
// store "handles", rows { id, handle: FileSystemFileHandle, name } (src/app/store/db.ts).
// Kept local because drivers only import from src/core, and src/drivers/duckdb/handles.ts
// (planned loadHandle) didn't exist yet. Swap for a shared core helper when there is one.

const DB_NAME = "dbui";
const STORE = "handles";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function loadHandle(id: string): Promise<FileSystemFileHandle | null> {
  // Open without a version so we never trigger (or block on) the app's schema upgrade.
  const db = await req(indexedDB.open(DB_NAME));
  try {
    if (!db.objectStoreNames.contains(STORE)) return null;
    const row = (await req(db.transaction(STORE, "readonly").objectStore(STORE).get(id))) as { handle?: FileSystemFileHandle } | undefined;
    return row?.handle ?? null;
  } finally {
    db.close();
  }
}

/** Reads a stored file's bytes. Chrome may need the user to re-grant read access once per session. */
export async function readHandleBytes(id: string): Promise<{ bytes: Uint8Array; name: string }> {
  const handle = await loadHandle(id);
  if (!handle) throw new Error("The picked file is no longer available. Pick it again.");
  type H = FileSystemFileHandle & {
    queryPermission?: (d: { mode: "read" }) => Promise<PermissionState>;
    requestPermission?: (d: { mode: "read" }) => Promise<PermissionState>;
  };
  const h = handle as H;
  if (h.queryPermission && (await h.queryPermission({ mode: "read" })) !== "granted") {
    const state = await h.requestPermission?.({ mode: "read" });
    if (state !== "granted") throw new Error(`Read access to ${handle.name} was not granted`);
  }
  const file = await handle.getFile();
  return { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name };
}

export async function readHandleText(id: string): Promise<string> {
  return new TextDecoder().decode((await readHandleBytes(id)).bytes);
}
