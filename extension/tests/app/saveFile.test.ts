// @vitest-environment node
// Save in the file sheet: the original file, or the rows of a filtered/SQL sheet, written by DuckDB.
import { afterEach, expect, test, vi } from "vitest";
import { createDriver } from "../../src/drivers/duckdb";
import { formatOf, saveName, saveSheet } from "../../src/app/file/saveFile";
import { filteredSheet, querySheet, sourceSheet } from "../../src/app/file/sheets";
import { fixtureFile, testEngine } from "../drivers/duckdb/engine";

async function open(name: string) {
  const driver = createDriver({ engine: testEngine, readFile: async () => fixtureFile(name) });
  await driver.connect({ id: "f", name, driver: "file", env: "local", readOnly: true, options: { fileHandleId: "h1", fileName: name } });
  return driver;
}

/** Captures what the save dialog would write. */
function stubSaveDialog(cancel = false) {
  const written: { name: string; blob: Blob }[] = [];
  vi.stubGlobal("showSaveFilePicker", async ({ suggestedName }: { suggestedName: string }) => {
    if (cancel) throw new DOMException("cancelled", "AbortError");
    return { createWritable: async () => ({ write: async (blob: Blob) => void written.push({ name: suggestedName, blob }), close: async () => {} }) };
  });
  return written;
}

afterEach(() => vi.unstubAllGlobals());

test("the save format follows the file; compressed files save as plain CSV", () => {
  expect(["orders.csv", "trips.parquet", "events.jsonl", "events.jsonl.zst", "orders.csv.gz", "x.tsv"].map(formatOf)).toEqual(["csv", "parquet", "jsonl", "csv", "csv", "tsv"]);
  expect(saveName("orders.csv.gz", sourceSheet("sheet"), true, "csv")).toBe("orders.csv");
  expect(saveName("orders.csv", filteredSheet(sourceSheet("sheet"), "status = 'paid'", "status = 'paid'"), false, "parquet")).toBe("orders (status = paid).parquet");
});

test("⌘S on the original sheet saves every row of the file under its own name", async () => {
  const written = stubSaveDialog();
  const d = await open("orders.csv");
  expect(await saveSheet({ driver: d, table: "sheet", fileName: "orders.csv", sheet: sourceSheet("sheet"), isOriginal: true })).toBe("orders.csv");
  const text = await written[0]!.blob.text();
  expect(written[0]!.name).toBe("orders.csv");
  expect(text.split("\n")[0]).toBe("id,customer,status,total,created_at");
  expect(text.trim().split("\n")).toHaveLength(21);
  await d.disconnect();
});

test("a filtered sheet saves only its rows, and a SQL sheet saves its result", async () => {
  const written = stubSaveDialog();
  const d = await open("orders.csv");
  const paid = filteredSheet(sourceSheet("sheet"), "status = 'paid'", "status = 'paid'");
  await saveSheet({ driver: d, table: "sheet", fileName: "orders.csv", sheet: paid, isOriginal: false });
  const rows = (await written[0]!.blob.text()).trim().split("\n");
  expect(rows.slice(1).every((r) => r.split(",")[2] === "paid")).toBe(true);
  expect(rows.length).toBeLessThan(21);

  await saveSheet({ driver: d, table: "sheet", fileName: "orders.csv", sheet: querySheet("SELECT status, count(*) AS n FROM sheet GROUP BY 1 ORDER BY 1"), isOriginal: false, format: "jsonl" });
  expect(written[1]!.name).toMatch(/^orders \(.*\)\.jsonl$/);
  expect((await written[1]!.blob.text()).trim().split("\n")[0]).toMatch(/^\{"status":".+","n":\d+\}$/);
  await d.disconnect();
});

test("cancelling the save dialog saves nothing", async () => {
  stubSaveDialog(true);
  const d = await open("orders.csv");
  expect(await saveSheet({ driver: d, table: "sheet", fileName: "orders.csv", sheet: sourceSheet("sheet"), isOriginal: true })).toBeNull();
  await d.disconnect();
});
