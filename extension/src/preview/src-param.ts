// Reading `?src=` on app.html.
//
// The redirect rule substitutes the original URL verbatim (`app.html?src=\0`), so it is NOT
// percent-encoded: `https://b.s3.amazonaws.com/a.parquet?X-Amz-Signature=..&X-Amz-Date=..` arrives
// as `?src=https://b.s3.amazonaws.com/a.parquet?X-Amz-Signature=..&X-Amz-Date=..`, and a `#frag`
// on the original URL lands in location.hash. URLSearchParams would cut it at the first `&`.
// Links dbui builds itself (openDownloadInDbui) encode the value with encodeURIComponent.

export interface SrcParam {
  src: string;
  /** The page's own hash route (e.g. "#file"), with the original URL's fragment removed. */
  hash: string;
}

const ENCODED_SCHEME = /^(?:https?|file|blob)%3A/i;

/** Builds `<page>?src=<encoded url><hash>` the same way readSrcParam expects it. */
export function buildSrcUrl(pageUrl: string, src: string, hash = ""): string {
  return `${pageUrl}?src=${encodeURIComponent(src)}${hash}`;
}

/** Extracts the source URL from `search` + `hash` (e.g. `location.search`, `location.hash`). */
export function readSrcParam(search: string, hash: string): SrcParam | null {
  const q = search.startsWith("?") ? search.slice(1) : search;
  const at = q.startsWith("src=") ? 0 : q.indexOf("&src=") + 1;
  if (at === 0 && !q.startsWith("src=")) return null;
  const raw = q.slice(at + 4);
  if (!raw) return null;
  if (ENCODED_SCHEME.test(raw)) {
    // Encoded by dbui: the value stops at the next "&", the hash is the page's own route.
    const value = raw.split("&")[0] ?? "";
    try {
      return { src: decodeURIComponent(value), hash };
    } catch {
      return null;
    }
  }
  // Verbatim from the redirect rule: everything after src= is the URL, including its fragment.
  return { src: raw + hash, hash: "" };
}
