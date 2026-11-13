// Object tree row counts show as rough marks (<100, ~450, ~10k, ~24M); other labels are kept.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { roundedMeta } from "../../src/app/lib/approxCount";

const CASES: [string, string, string][] = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/app/row-counts.json"), "utf8"));

test.each(CASES)("%s on a %s shows %s", (meta, type, shown) => {
  expect(roundedMeta(meta, type)).toBe(shown);
});
