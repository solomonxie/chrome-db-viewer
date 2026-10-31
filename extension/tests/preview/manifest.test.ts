import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../public/manifest.json"), "utf8"));

test("app.html is web-accessible to every site so the preview redirect can land on it, and nothing else is", () => {
  // Chrome refuses a declarativeNetRequest redirect to a chrome-extension:// page that isn't
  // web-accessible to the requesting origin; the navigation then continues as a download.
  expect(manifest.web_accessible_resources).toEqual([{ resources: ["app.html"], matches: ["<all_urls>"] }]);
});

test("the manifest keeps the COEP/COOP headers DuckDB-WASM threads need", () => {
  expect(manifest.cross_origin_embedder_policy).toEqual({ value: "require-corp" });
  expect(manifest.cross_origin_opener_policy).toEqual({ value: "same-origin" });
  expect(manifest.permissions).toContain("declarativeNetRequestWithHostAccess");
  // The media viewer only takes over downloads a tab's navigation started (src/background/).
  expect(manifest.permissions).toEqual(expect.arrayContaining(["downloads", "webNavigation"]));
});

test("the manifest grants all-sites host access at install, so Browser preview works with no prompt", () => {
  expect(manifest.host_permissions).toEqual(expect.arrayContaining(["https://*/*", "http://*/*"]));
  // Local files (dropped onto Chrome, finished downloads) are read from the page with XHR;
  // Chrome also needs "Allow access to file URLs" switched on for the extension.
  expect(manifest.host_permissions).toContain("file:///*");
  // The BigQuery origins stay.
  expect(manifest.host_permissions).toEqual(expect.arrayContaining(["https://bigquery.googleapis.com/*", "https://oauth2.googleapis.com/*", "https://iamcredentials.googleapis.com/*"]));
  expect(manifest.optional_host_permissions ?? []).not.toContain("https://*/*");
});

test("the manifest pins the extension ID with a key", () => {
  // The key fixes the ID at dalbkdjjdgbjhoalobeikhpchkoddnpb, so folder moves and reloads keep
  // IndexedDB and the runner's allowed_origins working (DESIGN.md §5.1).
  expect(typeof manifest.key).toBe("string");
  expect(manifest.key.length).toBeGreaterThan(300);
  expect(extensionIdFromKey(manifest.key)).toBe("dalbkdjjdgbjhoalobeikhpchkoddnpb");
});

/** Chrome's ID: the first 128 bits of SHA-256 over the DER public key, hex digits mapped 0-f → a-p. */
function extensionIdFromKey(key: string): string {
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}
