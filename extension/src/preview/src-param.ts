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
  /** The file's name when the URL doesn't show it (a download's Content-Disposition name): `?name=` before `?src=`. */
  name?: string;
}

const ENCODED_SCHEME = /^(?:https?|file|blob)%3A/i;

/** Builds `<page>?[name=<encoded name>&]src=<encoded url><hash>` the same way readSrcParam expects it.
 *  `name` goes first so a verbatim src (everything after src=) stays last. */
export function buildSrcUrl(pageUrl: string, src: string, hash = "", name?: string): string {
  const n = name ? `name=${encodeURIComponent(name)}&` : "";
  return `${pageUrl}?${n}src=${encodeURIComponent(src)}${hash}`;
}

function readName(q: string, srcAt: number): string | undefined {
  const m = /(?:^|&)name=([^&]*)/.exec(q.slice(0, srcAt));
  if (!m?.[1]) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return undefined;
  }
}

/** Extracts the source URL from `search` + `hash` (e.g. `location.search`, `location.hash`). */
export function readSrcParam(search: string, hash: string): SrcParam | null {
  const q = search.startsWith("?") ? search.slice(1) : search;
  const at = q.startsWith("src=") ? 0 : q.indexOf("&src=") + 1;
  if (at === 0 && !q.startsWith("src=")) return null;
  const raw = q.slice(at + 4);
  if (!raw) return null;
  const name = readName(q, at);
  const withName = (p: SrcParam): SrcParam => (name ? { ...p, name } : p);
  if (ENCODED_SCHEME.test(raw)) {
    // Encoded by dbui: the value stops at the next "&", the hash is the page's own route.
    const value = raw.split("&")[0] ?? "";
    try {
      return withName({ src: decodeURIComponent(value), hash });
    } catch {
      return null;
    }
  }
  // Verbatim from the redirect rule: everything after src= is the URL, including its fragment.
  return withName({ src: raw + hash, hash: "" });
}
