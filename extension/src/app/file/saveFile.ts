// Save for the file sheet (#file): the data as a file on disk. DuckDB writes the bytes (COPY …
// TO), so it works for any source (a URL, a blob: export, a picked file) and any sheet in the
// stack: the original sheet saves every row, a filtered or SQL sheet saves what it shows.
// A save dialog when Chrome has one (showSaveFilePicker), otherwise a normal download.

import type { Driver } from "@core/types";
import type { Sheet } from "./sheets";
import { sheetSql } from "./sheets";

export type SaveFormat = "csv" | "tsv" | "jsonl" | "json" | "parquet";

export const SAVE_FORMATS: { format: SaveFormat; label: string; mime: string }[] = [
  { format: "csv", label: "CSV", mime: "text/csv" },
  { format: "tsv", label: "TSV", mime: "text/tab-separated-values" },
  { format: "parquet", label: "Parquet", mime: "application/vnd.apache.parquet" },
  { format: "jsonl", label: "JSON Lines", mime: "application/x-ndjson" },
  { format: "json", label: "JSON array", mime: "application/json" },
];

interface Exporter {
  exportBytes(format: SaveFormat, fromSql?: string): Promise<Uint8Array>;
}

export function canSave(driver: Driver): driver is Driver & Exporter {
  return typeof (driver as Partial<Exporter>).exportBytes === "function";
}

/** The format a file was opened as, when DuckDB can write it (compressed and Arrow files save as CSV). */
export function formatOf(name: string): SaveFormat {
  const n = name.toLowerCase().replace(/\?.*$/, "");
  if (/\.(gz|zst)$/.test(n)) return "csv";
  if (n.endsWith(".parquet")) return "parquet";
  if (n.endsWith(".tsv")) return "tsv";
  if (n.endsWith(".jsonl") || n.endsWith(".ndjson")) return "jsonl";
  if (n.endsWith(".json")) return "json";
  return "csv";
}

/** "orders.csv" for the original sheet; "orders (status = 'paid').csv"-style names for others. */
export function saveName(fileName: string, sheet: Sheet, isOriginal: boolean, format: SaveFormat): string {
  const stem = fileName.replace(/\.(gz|zst)$/i, "").replace(/\.[^./]+$/, "") || "data";
  const ext = format === "jsonl" ? "jsonl" : format;
  if (isOriginal) return `${stem}.${ext}`;
  const tag = sheet.title.replace(/[^\w .=<>-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return `${stem}${tag ? ` (${tag})` : ""}.${ext}`;
}

/** SQL for the rows a sheet shows, with no row limit. */
export function saveSql(sheet: Sheet, table: string, driver: Driver): string {
  return sheetSql(sheet, table, driver.dialect);
}

type SavePickerWindow = Window & {
  showSaveFilePicker?: (o: { suggestedName: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
};

/** Writes the bytes through a save dialog, or downloads them. Returns false when the dialog was cancelled. */
export async function writeOut(name: string, bytes: Uint8Array, format: SaveFormat): Promise<boolean> {
  const f = SAVE_FORMATS.find((x) => x.format === format)!;
  const blob = new Blob([bytes as BlobPart], { type: f.mime });
  const w = globalThis as unknown as SavePickerWindow;
  if (w.showSaveFilePicker) {
    let handle: FileSystemFileHandle;
    try {
      handle = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: f.label, accept: { [f.mime]: [`.${name.split(".").pop()}`] } }] });
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return false;
      throw e;
    }
    const out = await handle.createWritable();
    await out.write(blob);
    await out.close();
    return true;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/** Exports a sheet and saves it. Returns the file name, or null when cancelled. */
export async function saveSheet(opts: { driver: Driver; table: string; fileName: string; sheet: Sheet; isOriginal: boolean; format?: SaveFormat }): Promise<string | null> {
  if (!canSave(opts.driver)) throw new Error("This file can't be saved from here");
  const format = opts.format ?? formatOf(opts.fileName);
  // The original sheet unsorted is the whole table; otherwise the sheet's own query.
  const plain = opts.isOriginal && opts.sheet.kind === "source" && !opts.sheet.where.length && !opts.sheet.sort.length;
  const bytes = await opts.driver.exportBytes(format, plain ? undefined : saveSql(opts.sheet, opts.table, opts.driver));
  const name = saveName(opts.fileName, opts.sheet, opts.isOriginal, format);
  return (await writeOut(name, bytes, format)) ? name : null;
}
