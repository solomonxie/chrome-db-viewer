// Export a result grid (query results) as a file: CSV, TSV, JSON array or JSON Lines, built in
// memory from the rows on screen, then saved through the save dialog (or a download).

import type { Cell, Column } from "@core/types";
import { writeOut, type SaveFormat } from "../file/saveFile";

export type RowFormat = Extract<SaveFormat, "csv" | "tsv" | "json" | "jsonl">;

export const ROW_FORMATS: { format: RowFormat; label: string }[] = [
  { format: "csv", label: "CSV" },
  { format: "tsv", label: "TSV" },
  { format: "json", label: "JSON array" },
  { format: "jsonl", label: "JSON Lines" },
];

/** A cell for a text file: NULL is empty, objects (JSON, arrays) are JSON text. */
function flat(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** RFC 4180: quote fields with the separator, a quote or a line break; double the quotes. */
function quote(s: string, sep: string): string {
  return s.includes(sep) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The rows as file text. Duplicate column names in JSON get _2, _3 … so no value is lost. */
export function rowsToText(columns: Column[], rows: Cell[][], format: RowFormat): string {
  if (format === "csv" || format === "tsv") {
    const sep = format === "csv" ? "," : "\t";
    const line = (cells: string[]) => cells.map((c) => quote(c, sep)).join(sep);
    return [line(columns.map((c) => c.name)), ...rows.map((r) => line(r.map(flat)))].join("\n") + "\n";
  }
  const seen = new Map<string, number>();
  const keys = columns.map((c) => {
    const n = (seen.get(c.name) ?? 0) + 1;
    seen.set(c.name, n);
    return n === 1 ? c.name : `${c.name}_${n}`;
  });
  const objs = rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? null])));
  return format === "json" ? JSON.stringify(objs, null, 2) + "\n" : objs.map((o) => JSON.stringify(o)).join("\n") + (objs.length ? "\n" : "");
}

/** "orders_2026-11-13.csv" from a tab title. */
export function exportName(title: string, format: RowFormat, now = new Date()): string {
  const base = title.trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_") || "result";
  const day = now.toISOString().slice(0, 10);
  return `${base}_${day}.${format}`;
}

/** Saves the rows; false when the save dialog was cancelled. */
export async function exportRows(title: string, columns: Column[], rows: Cell[][], format: RowFormat): Promise<boolean> {
  const bytes = new TextEncoder().encode(rowsToText(columns, rows, format));
  return writeOut(exportName(title, format), bytes, format);
}
