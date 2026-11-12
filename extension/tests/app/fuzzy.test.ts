// Schema tree search: substring first, else the letters in order; case and spaces ignored.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { fuzzyMatch, markRuns } from "../../src/app/lib/fuzzy";

const NAMES: string[] = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/app/fuzzy-names.json"), "utf8"));
const hits = (needle: string) => NAMES.filter((n) => fuzzyMatch(n, needle));

test("a substring matches as before", () => {
  expect(hits("export_res")).toEqual(["data_export_results", "data_export_results_history"]);
  expect(fuzzyMatch("data_export_results", "export")).toEqual([5, 6, 7, 8, 9, 10]);
});

test("letters in order match across underscores, case and spaces ignored", () => {
  expect(hits("dexpres")).toEqual(["data_export_results", "data_export_results_history"]);
  expect(hits("DE hist")).toEqual(["data_export_results_history"]);
  expect(hits("dataexp")).toEqual(["data_export_results", "data_export_results_history", "Data_Exports"]);
  expect(hits("usx")).toEqual([]);
});

test("matched letters are grouped into runs for highlighting", () => {
  expect(markRuns("users", fuzzyMatch("users", "ues")!)).toEqual([["u", true], ["s", false], ["e", true], ["r", false], ["s", true]]);
});
