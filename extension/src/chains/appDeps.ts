// The real ChainDeps for the app: the Collections template engine, the script sandbox, saved
// connections (with their secrets) and the collection's library. Tests build their own deps.

import type { ConnectionConfig } from "@core/types";
import { render } from "../collections/render";
import { loadBundle } from "../collections/store";
import { runPostScripts, runPreScripts, runScript } from "../sandbox/client";
import { loadConnection, needsSecret, openDriver, resolveSecret, withSecret } from "../app/lib/connections";
import type { ChainDeps } from "./runner";
import { buildLibrary, EMPTY_LIBRARY, type ChainLibrary } from "./library";
import type { ExportFormat } from "./local";

const MIME: Record<ExportFormat, string> = { csv: "text/csv", jsonl: "application/x-ndjson", parquet: "application/vnd.apache.parquet" };

/** Library of a chain's collection; empty when the collection is gone. */
export async function chainLibrary(collectionId: string): Promise<ChainLibrary> {
  try {
    const b = await loadBundle(collectionId);
    return b ? buildLibrary(b.collection, b.folders, b.queries) : EMPTY_LIBRARY;
  } catch {
    return EMPTY_LIBRARY;
  }
}

async function connect(cfg: ConnectionConfig, signal?: AbortSignal) {
  const secret = await resolveSecret(cfg);
  if (secret === null && needsSecret(cfg)) {
    throw new Error(`"${cfg.name}" needs its password or key for this session. Open the connection once, then run the chain again.`);
  }
  const driver = await openDriver(cfg);
  await driver.connect(withSecret(cfg, secret), signal);
  return driver;
}

/** Hands the bytes to the browser: a save dialog when available, otherwise a download. */
export async function saveBytes(name: string, bytes: Uint8Array, format: ExportFormat): Promise<void> {
  const blob = new Blob([bytes as BlobPart], { type: MIME[format] });
  const w = window as Window & { showSaveFilePicker?: (o: object) => Promise<FileSystemFileHandle> };
  if (w.showSaveFilePicker) {
    let handle: FileSystemFileHandle;
    try {
      handle = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: format.toUpperCase(), accept: { [MIME[format]]: [`.${format}`] } }] });
    } catch (e) {
      if ((e as DOMException).name === "AbortError") throw new Error("Export cancelled");
      throw e;
    }
    const out = await handle.createWritable();
    await out.write(blob);
    await out.close();
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function appChainDeps(library: ChainLibrary, extra: Partial<ChainDeps> = {}): ChainDeps {
  return {
    render: (t, o) => render(t, o),
    runScript: (req) => runScript(req),
    runPreScripts: (s, v, e) => runPreScripts(s, v, e),
    runPostScripts: (s, v, e, r) => runPostScripts(s, v, e, r),
    loadConnection,
    connect,
    library,
    saveFile: saveBytes,
    ...extra,
  };
}
