import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { formatBytes, formatDuration, kindFromMime, kindFromUrl, probeMedia } from "../../src/media/kind";
import { filterSiblings, findSiblings, indexOfSrc, parentDirUrl, parseChromeFileListing, parseHttpIndex } from "../../src/media/siblings";
import { buildSrcUrl, readSrcParam } from "../../src/preview/src-param";

const FIXTURES = resolve(__dirname, "../fixtures/media");
const fixture = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8");

test("kindFromUrl and kindFromMime", () => {
  expect(kindFromUrl("https://x.test/a/photo.JPG?w=1")).toBe("image");
  expect(kindFromUrl("file:///Users/me/clip.mov")).toBe("video");
  expect(kindFromUrl("https://x.test/a/data.csv")).toBeNull();
  expect(kindFromUrl("https://x.test/a/raw")).toBeNull();
  expect(kindFromMime("image/heic")).toBe("image");
  expect(kindFromMime("video/mp4; codecs=avc1")).toBe("video");
  expect(kindFromMime("text/html")).toBeNull();
});

test("probeMedia sniffs the MIME type with HEAD when the URL has no extension", async () => {
  const calls: [string, RequestInit | undefined][] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    return new Response(null, { status: 200, headers: { "content-type": "video/webm", "content-length": "4096" } });
  }) as typeof fetch;
  expect(await probeMedia("https://cdn.test/media/12345", fakeFetch)).toEqual({ kind: "video", mime: "video/webm", size: 4096 });
  expect(calls[0]?.[1]?.method).toBe("HEAD");
  expect(await probeMedia("file:///a/b.png", fakeFetch)).toEqual({ kind: "image", mime: null, size: null });
});

test("readSrcParam keeps an unencoded presigned URL from the redirect rule whole", () => {
  const url = "https://b.s3.amazonaws.com/k/a.png?X-Amz-Signature=x%2Fy&X-Amz-Date=1";
  expect(readSrcParam(`?src=${url}`, "#frag")).toEqual({ src: `${url}#frag`, hash: "" });
});

test("readSrcParam decodes URLs dbui built itself and keeps the page hash", () => {
  const src = "file:///Users/me/My Data/a b.csv";
  const built = buildSrcUrl("chrome-extension://id/app.html", src, "#file");
  const u = new URL(built);
  expect(readSrcParam(u.search, u.hash)).toEqual({ src, hash: "#file" });
  expect(readSrcParam("?foo=1", "")).toBeNull();
});

test("parseHttpIndex reads a real python http.server listing", () => {
  const dir = "http://127.0.0.1:8765/photos/";
  const links = parseHttpIndex(fixture("http-dir-listing.html"), dir);
  expect(links).toContain("http://127.0.0.1:8765/photos/beach%2001.jpg");
  expect(links).not.toContain("http://127.0.0.1:8765/photos/sub/");
  expect(filterSiblings(links, "image")).toEqual([
    "http://127.0.0.1:8765/photos/b.png",
    "http://127.0.0.1:8765/photos/beach%2001.jpg",
    "http://127.0.0.1:8765/photos/c.webp",
  ]);
  expect(filterSiblings(links, "video")).toEqual(["http://127.0.0.1:8765/photos/clip.mp4"]);
});

test("parseChromeFileListing reads Chrome's file:// folder page, sorted naturally", () => {
  const dir = "file:///Users/me/photos/";
  const images = filterSiblings(parseChromeFileListing(fixture("chrome-file-listing.html"), dir), "image");
  expect(images).toEqual([
    "file:///Users/me/photos/beach%2001.png",
    "file:///Users/me/photos/IMG_2.jpg",
    "file:///Users/me/photos/IMG_10.jpg",
    "file:///Users/me/photos/say%20%22hi%22.gif",
  ]);
  expect(indexOfSrc(images, "file:///Users/me/photos/beach 01.png")).toBe(0);
});

test("parentDirUrl", () => {
  expect(parentDirUrl("https://x.test/a/b.png?sig=1#f")).toBe("https://x.test/a/");
  expect(parentDirUrl("file:///Users/me/a.png")).toBe("file:///Users/me/");
  expect(parentDirUrl("blob:https://x.test/uuid")).toBeNull();
});

test("findSiblings returns the folder's images, or nothing when there's no listing", async () => {
  const html = fixture("http-dir-listing.html");
  const ok = (async () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })) as unknown as typeof fetch;
  const list = await findSiblings("http://127.0.0.1:8765/photos/c.webp", "image", ok);
  expect(list).toHaveLength(3);
  const notFound = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
  expect(await findSiblings("http://127.0.0.1:8765/photos/c.webp", "image", notFound)).toEqual([]);
  expect(await findSiblings("https://b.s3.amazonaws.com/c.webp?X-Amz-Signature=1", "image", ok)).toEqual([]);
  // Only one video in the folder: no stepping.
  expect(await findSiblings("http://127.0.0.1:8765/photos/clip.mp4", "video", ok)).toEqual([]);
});

test("formatBytes and formatDuration", () => {
  expect(formatBytes(1525)).toBe("1.5 KB");
  expect(formatBytes(null)).toBe("—");
  expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
  expect(formatDuration(75.5)).toBe("1:15.50");
  expect(formatDuration(3725)).toBe("1:02:05.00");
});
