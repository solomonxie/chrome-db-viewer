// Sibling files for ← / → stepping: read the parent folder's listing when the browser gives us one.
//   file:// folders: Chrome's listing page, rows written as addRow("name","url",isdir,...) calls.
//   http(s): an index page (nginx autoindex, Apache, python -m http.server, S3 website listings)
//            parsed as plain <a href> links into the same folder.
// Anything else (no listing, 403, cross-origin failure) -> no siblings, the arrows stay hidden.

import { fileExtension } from "../preview/rules";
import { kindFromExtension, type MediaKind } from "./kind";

function sameKind(url: string, kind: MediaKind): boolean {
  const parsed = fileExtension(url);
  return !!parsed && !parsed.compression && kindFromExtension(parsed.ext) === kind;
}

export function parentDirUrl(src: string): string | null {
  try {
    const u = new URL(src);
    if (u.protocol !== "file:" && u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.pathname.endsWith("/")) return null;
    u.search = "";
    u.hash = "";
    u.pathname = u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1);
    return u.toString();
  } catch {
    return null;
  }
}

/** Chrome's file:// directory page: `addRow("a b.png","a%20b.png",0,1234,"1.2 kB",...)`. */
export function parseChromeFileListing(html: string, dirUrl: string): string[] {
  const out: string[] = [];
  const re = /addRow\(\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*,\s*([01])/g;
  for (const m of html.matchAll(re)) {
    if (m[3] === "1") continue;
    try {
      const href = JSON.parse(m[2] ?? '""') as string;
      if (href) out.push(new URL(href, dirUrl).toString());
    } catch {
      // A row we can't read; skip it.
    }
  }
  return out;
}

/** Links in an HTML index page that point at files directly inside `dirUrl`. */
export function parseHttpIndex(html: string, dirUrl: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const dir = new URL(dirUrl);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    if (!href || href.startsWith("?") || href.startsWith("#")) continue;
    let u: URL;
    try {
      u = new URL(href, dirUrl);
    } catch {
      continue;
    }
    if (u.origin !== dir.origin || u.pathname.endsWith("/")) continue;
    const parent = u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1);
    if (parent !== dir.pathname) continue;
    u.hash = "";
    const s = u.toString();
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/** Keeps files of the same kind, sorted by name the way Finder does ("2" before "10"). */
export function filterSiblings(urls: string[], kind: MediaKind): string[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const name = (u: string) => decodeURIComponent(new URL(u).pathname.split("/").pop() ?? "");
  return urls.filter((u) => sameKind(u, kind)).sort((a, b) => collator.compare(name(a), name(b)));
}

function samePath(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && decodeURIComponent(ua.pathname) === decodeURIComponent(ub.pathname);
  } catch {
    return a === b;
  }
}

export function indexOfSrc(siblings: string[], src: string): number {
  return siblings.findIndex((s) => samePath(s, src));
}

/** Fetches the parent listing and returns same-kind siblings including `src`, or [] when unknown. */
export async function findSiblings(src: string, kind: MediaKind, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const dir = parentDirUrl(src);
  if (!dir) return [];
  // A signed URL (S3/GCS presigned) points at one object; its "folder" isn't a listing.
  if (new URL(src).search) return [];
  try {
    const res = await fetchImpl(dir, { credentials: "include" });
    if (!res.ok && dir.startsWith("http")) return [];
    const type = res.headers.get("content-type") ?? "";
    if (dir.startsWith("http") && !type.includes("html")) return [];
    const html = await res.text();
    const links = dir.startsWith("file:") ? parseChromeFileListing(html, dir) : parseHttpIndex(html, dir);
    const list = filterSiblings(links, kind);
    return list.length > 1 && indexOfSrc(list, src) >= 0 ? list : [];
  } catch {
    return [];
  }
}
