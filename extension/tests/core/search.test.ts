// Schema search matching: terms split at spaces and dots, each must appear in "parent.name",
// and "-" matches "_" (BigQuery dataset ids can't hold "-"). Objects from the app fixture.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import type { ObjectNode } from "@core/types";
import { searchCatalog, searchTerms } from "@core/search";

const { catalog }: { catalog: ObjectNode[] } = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/app/schema-search.json"), "utf8"));
const names = (needle: string) => searchCatalog(catalog, needle).map((n) => n.name);

test("terms split at spaces and dots, lower case, hyphens as underscores", () => {
  expect(searchTerms("  ET_V2.Annotated  visits-x ")).toEqual(["et_v2", "annotated", "visits_x"]);
});

test("every term must appear in parent.name", () => {
  expect(names("web_v2 annotated")).toEqual(["mart__fact__annotated_visits", "annotated_visits_v"]);
  expect(names("web_v2.mart")).toEqual(["mart__fact__annotated_visits"]);
  expect(names("acme-adhoc alex")).toEqual(["alex_scratch"]);
  expect(names("nothing_like_this")).toEqual([]);
  expect(names("   ")).toEqual([]);
});

test("a UUID pasted with hyphens finds the dataset named with underscores, and its tables", () => {
  expect(names("3f2b8c1d-9e4a-4b7f-a1c2-d5e6f7a8b9c0")).toEqual(["3f2b8c1d_9e4a_4b7f_a1c2_d5e6f7a8b9c0", "agg_daily__channel_metrics"]);
  expect(names("3f2b8c1d-9e4a-4b7f-a1c2-d5e6f7a8b9c0.agg_daily__channel_metrics")).toEqual(["agg_daily__channel_metrics"]);
});

test("the limit caps the hits", () => {
  expect(searchCatalog(catalog, "acme", 2)).toHaveLength(2);
});
