// Which downloads open in the media viewer. Cases in tests/fixtures/preview/media-downloads.json
// (real-shaped download items: GCS signed URLs, untyped uploads, redirects, blobs).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { mediaDisplayName, mediaKind, mediaViewerUrl } from "../../src/preview/media";

type Case = { case: string; expected: string | null; item: { url: string; finalUrl?: string; mime?: string; filename?: string } };
const CASES: Case[] = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/preview/media-downloads.json"), "utf8"));

test("images and videos Chrome can show open in the viewer; everything else downloads", () => {
  for (const { case: name, expected, item } of CASES) expect(mediaKind(item), name).toBe(expected);
});

test("the viewer names the file after the download, else the URL path, never the signature", () => {
  const [signedPng, , redirectedMov] = CASES;
  expect(mediaDisplayName(signedPng!.item.url, signedPng!.item.filename)).toBe("cover final.png");
  expect(mediaDisplayName(redirectedMov!.item.url, redirectedMov!.item.filename)).toBe("Screen Recording.mov");
});

test("the viewer URL carries the source, kind and name as query parameters", () => {
  const [signedPng] = CASES;
  const u = new URL(mediaViewerUrl("chrome-extension://dalbkdjjdgbjhoalobeikhpchkoddnpb", signedPng!.item.url, "image", "cover final.png"));
  expect(u.pathname).toBe("/media.html");
  expect(u.searchParams.get("url")).toBe(signedPng!.item.url);
  expect(u.searchParams.get("kind")).toBe("image");
  expect(u.searchParams.get("name")).toBe("cover final.png");
});
