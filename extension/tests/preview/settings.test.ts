import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { mergeSettings } from "../../src/preview/settings";

const fixture = (name: string) => JSON.parse(readFileSync(resolve(__dirname, "../fixtures/preview", name), "utf8"));

test("mergeSettings drops image and video extensions saved by older versions", () => {
  // legacy-settings.json: settings saved while the Images and Video groups existed.
  expect(mergeSettings(fixture("legacy-settings.json"))).toEqual({
    enabled: true,
    extensions: ["csv", "parquet", "gz"],
    excludedDomains: ["example.org"],
  });
});
