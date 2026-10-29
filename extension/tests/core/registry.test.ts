import { expect, test } from "vitest";

import { isStaleChunkError } from "../../src/core/registry";

test("Chrome's failed lazy-chunk import counts as a stale build", () => {
  const msg = "Failed to fetch dynamically imported module: chrome-extension://abc/assets/runner-OUMpHCFD.js";
  expect(isStaleChunkError(new TypeError(msg))).toBe(true);
  expect(isStaleChunkError("Importing a module script failed.")).toBe(true);
});

test("ordinary driver errors are not treated as a stale build", () => {
  expect(isStaleChunkError(new Error("No Keychain item for secretRef c_1"))).toBe(false);
  expect(isStaleChunkError(new Error("connection refused"))).toBe(false);
});
