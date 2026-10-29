// Picked-file handles (FileSystemFileHandle) kept in IndexedDB so connections can reopen a
// local file later. Shares the app's store: database "dbui", object store "handles",
// rows { id, handle, name } (src/app/store/db.ts creates the store).
//
// The database is always opened WITHOUT a version number so this module never triggers or
// blocks the app's schema upgrade. If the store doesn't exist yet (the app never ran its
// upgrade), reads return null and saveHandle throws.

export const HANDLE_DB = "dbui";
export const HANDLE_STORE = "handles";

export interface StoredHandle {
  id: string;
  handle: FileSystemFileHandle;
  name: string;
}

type PermissionMode = "read" | "readwrite";
type PermissionedHandle = FileSystemHandle & {
  queryPermission?: (d: { mode: PermissionMode }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: PermissionMode }) => Promise<PermissionState>;
};

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>, missing: () => T): Promise<T> {
  const db = await req(indexedDB.open(HANDLE_DB));
  try {
    if (!db.objectStoreNames.contains(HANDLE_STORE)) return missing();
    const tx = db.transaction(HANDLE_STORE, mode);
    const result = await fn(tx.objectStore(HANDLE_STORE));
    await done(tx);
    return result;
  } finally {
    db.close();
  }
}

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

/**
 * Stores a picked file handle and returns its id, for ConnectionConfig.options.fileHandleId.
 * Pass `id` to overwrite an existing entry.
 */
export async function saveHandle(handle: FileSystemFileHandle, id: string = newId()): Promise<string> {
  const row: StoredHandle = { id, handle, name: handle.name };
  return withStore(
    "readwrite",
    async (store) => {
      await req(store.put(row));
      return id;
    },
    () => {
      throw new Error(`IndexedDB store "${HANDLE_DB}/${HANDLE_STORE}" doesn't exist yet; open the app once to create it.`);
    },
  );
}

/** The stored row (handle + display name), or null when the id is unknown. */
export async function loadHandleRecord(id: string): Promise<StoredHandle | null> {
  return withStore(
    "readonly",
    async (store) => ((await req(store.get(id))) as StoredHandle | undefined) ?? null,
    () => null,
  );
}

/** The stored handle, or null when the id is unknown. */
export async function loadHandle(id: string): Promise<FileSystemFileHandle | null> {
  return (await loadHandleRecord(id))?.handle ?? null;
}

export async function deleteHandle(id: string): Promise<void> {
  await withStore(
    "readwrite",
    async (store) => {
      await req(store.delete(id));
    },
    () => undefined,
  );
}

/**
 * Makes sure we may read (or write) the handle. Chrome asks once per session; requesting
 * needs a user gesture, so call this from a click handler when it may prompt.
 */
export async function ensurePermission(handle: FileSystemHandle, mode: PermissionMode = "read"): Promise<boolean> {
  const h = handle as PermissionedHandle;
  if (!h.queryPermission) return true;
  if ((await h.queryPermission({ mode })) === "granted") return true;
  return (await h.requestPermission?.({ mode })) === "granted";
}

/** Loads the handle by id, checks read permission and returns the File. */
export async function readHandleFile(id: string): Promise<File> {
  const handle = await loadHandle(id);
  if (!handle) throw new Error("The picked file is no longer available. Pick it again.");
  if (!(await ensurePermission(handle, "read"))) throw new Error(`Read access to ${handle.name} was not granted`);
  return handle.getFile();
}

/** Reads a stored file's bytes (same shape as src/drivers/sqlite/handles.ts). */
export async function readHandleBytes(id: string): Promise<{ bytes: Uint8Array; name: string }> {
  const file = await readHandleFile(id);
  return { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name };
}

export async function readHandleText(id: string): Promise<string> {
  return new TextDecoder().decode((await readHandleBytes(id)).bytes);
}

/** Overwrites the file behind a handle (asks for write permission first). */
export async function writeHandle(handle: FileSystemFileHandle, data: Uint8Array | Blob | string): Promise<void> {
  if (!(await ensurePermission(handle, "readwrite"))) throw new Error(`Write access to ${handle.name} was not granted`);
  const w = await handle.createWritable();
  try {
    await w.write(data as FileSystemWriteChunkType);
    await w.close();
  } catch (e) {
    await w.abort().catch(() => undefined);
    throw e;
  }
}
