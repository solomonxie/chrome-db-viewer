// Browser preview redirect rules (design/DESIGN.md §3.12). Pure functions: no chrome.* calls here,
// so the tests can check the generated regex against real URLs.

import type { PreviewSettings } from "./settings";

export type PreviewKind = "data" | "media";

/** Every extension the settings page offers, grouped as in §3.12. */
export const PREVIEW_GROUPS = {
  tables: ["csv", "tsv", "psv"],
  jsonLines: ["jsonl", "ndjson"],
  columnar: ["parquet", "arrow", "feather"],
  databases: ["duckdb", "sqlite", "db"],
  json: ["json"],
  compressed: ["gz", "zst"],
  images: ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "heic", "tiff"],
  video: ["mp4", "webm", "mov", "m4v", "mkv"],
} as const;

export const DATA_EXTENSIONS: readonly string[] = [
  ...PREVIEW_GROUPS.tables, ...PREVIEW_GROUPS.jsonLines, ...PREVIEW_GROUPS.columnar,
  ...PREVIEW_GROUPS.databases, ...PREVIEW_GROUPS.json,
];
export const COMPRESSION_EXTENSIONS: readonly string[] = PREVIEW_GROUPS.compressed;
export const IMAGE_EXTENSIONS: readonly string[] = PREVIEW_GROUPS.images;
export const VIDEO_EXTENSIONS: readonly string[] = PREVIEW_GROUPS.video;
export const MEDIA_EXTENSIONS: readonly string[] = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];

export const DATA_RULE_ID = 1;
export const MEDIA_RULE_ID = 2;
/**
 * Rule 3 sets `Cross-Origin-Resource-Policy: cross-origin` on image and media responses that
 * dbui's own pages request. Extension pages run with COEP `require-corp` (manifest, needed for
 * DuckDB-WASM threads), so Chrome blocks a cross-origin `<video>`/`<img>` whose server sends
 * neither CORS nor CORP. That would stop media.html streaming video straight from the original
 * URL. Scoped by initiatorDomains to our extension id, so pages you browse are never touched.
 */
export const CORP_RULE_ID = 3;
export const PREVIEW_RULE_IDS = [DATA_RULE_ID, MEDIA_RULE_ID, CORP_RULE_ID];

interface CheckedExtensions {
  data: string[];
  compression: string[];
  media: string[];
}

/** Splits the checked list into the known groups. Unknown entries are dropped, so nothing
 *  user-controlled reaches the regex unescaped. */
export function checkedExtensions(settings: PreviewSettings): CheckedExtensions {
  const checked = new Set(settings.extensions.map((e) => e.trim().toLowerCase().replace(/^\./, "")));
  return {
    data: DATA_EXTENSIONS.filter((e) => checked.has(e)),
    compression: COMPRESSION_EXTENSIONS.filter((e) => checked.has(e)),
    media: MEDIA_EXTENSIONS.filter((e) => checked.has(e)),
  };
}

/** Rule 1's regex, or null when no data extension is checked. `.gz`/`.zst` only after a data type. */
export function dataRegex(settings: PreviewSettings): string | null {
  const { data, compression } = checkedExtensions(settings);
  if (data.length === 0) return null;
  const suffix = compression.length > 0 ? `(?:\\.(?:${compression.join("|")}))?` : "";
  return `^(?:https?|file)://[^?#]*\\.(?:${data.join("|")})${suffix}(?:[?#].*)?$`;
}

/** Rule 2's regex, or null when no image/video extension is checked. */
export function mediaRegex(settings: PreviewSettings): string | null {
  const { media } = checkedExtensions(settings);
  if (media.length === 0) return null;
  return `^(?:https?|file)://[^?#]*\\.(?:${media.join("|")})(?:[?#].*)?$`;
}

/** "https://Sub.Example.com:8443/x" or "*.example.com" -> "sub.example.com" / "example.com". */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split(/[/?#]/)[0] ?? "";
  s = s.replace(/^\*?\./, "").replace(/:\d+$/, "").replace(/\.$/, "");
  return /^[a-z0-9.-]+$/.test(s) && s.includes(".") || s === "localhost" ? s : null;
}

export function normalizedExcludedDomains(settings: PreviewSettings): string[] {
  const out = new Set<string>();
  for (const d of settings.excludedDomains) {
    const n = normalizeDomain(d);
    if (n) out.add(n);
  }
  return [...out];
}

function redirectRule(id: number, regexFilter: string, target: string, excluded: string[]): chrome.declarativeNetRequest.Rule {
  const condition: chrome.declarativeNetRequest.RuleCondition = {
    regexFilter,
    isUrlFilterCaseSensitive: false,
    resourceTypes: ["main_frame"],
    // A form POST export can't be fetched again with GET; the download prompt covers it.
    requestMethods: ["get"],
  };
  if (excluded.length > 0) condition.excludedRequestDomains = excluded;
  return {
    id,
    priority: 1,
    condition,
    action: { type: "redirect", redirect: { regexSubstitution: `${target}?src=\\0` } },
  };
}

/**
 * The dynamic rules for these settings: rule 1 sends data files to app.html, rule 2 sends
 * images/videos to media.html, rule 3 lets media.html embed cross-origin media (see CORP_RULE_ID).
 * Returns [] when the feature is off.
 */
export function buildRules(settings: PreviewSettings, extensionBaseUrl: string): chrome.declarativeNetRequest.Rule[] {
  if (!settings.enabled) return [];
  const base = extensionBaseUrl.endsWith("/") ? extensionBaseUrl : `${extensionBaseUrl}/`;
  const excluded = normalizedExcludedDomains(settings);
  const rules: chrome.declarativeNetRequest.Rule[] = [];

  const data = dataRegex(settings);
  if (data) rules.push(redirectRule(DATA_RULE_ID, data, `${base}app.html`, excluded));

  const media = mediaRegex(settings);
  if (media) rules.push(redirectRule(MEDIA_RULE_ID, media, `${base}media.html`, excluded));

  // The extension id is the host of chrome-extension://<id>/.
  const extensionId = base.replace(/^[a-z-]+:\/\//i, "").split("/")[0] ?? "";
  if (extensionId) {
    rules.push({
      id: CORP_RULE_ID,
      priority: 1,
      condition: { initiatorDomains: [extensionId], resourceTypes: ["image", "media"] },
      action: {
        type: "modifyHeaders",
        responseHeaders: [{ header: "Cross-Origin-Resource-Policy", operation: "set", value: "cross-origin" }],
      },
    });
  }
  return rules;
}

/** Lower-cased extension of the last path segment, ignoring a checked compression suffix
 *  ("a.csv.gz" -> { ext: "csv", compression: "gz" }). Accepts URLs or bare file names. */
export function fileExtension(nameOrUrl: string): { ext: string; compression: string | null } | null {
  let path = nameOrUrl;
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(nameOrUrl)) path = new URL(nameOrUrl).pathname;
  } catch {
    // Not a URL; treat it as a path.
  }
  path = path.split(/[?#]/)[0] ?? "";
  const last = (path.split(/[/\\]/).pop() ?? "").toLowerCase();
  try {
    const decoded = decodeURIComponent(last);
    return splitExtension(decoded);
  } catch {
    return splitExtension(last);
  }
}

function splitExtension(name: string): { ext: string; compression: string | null } | null {
  const parts = name.split(".");
  if (parts.length < 2) return null;
  const lastExt = parts[parts.length - 1] ?? "";
  if (COMPRESSION_EXTENSIONS.includes(lastExt) && parts.length >= 3) {
    return { ext: parts[parts.length - 2] ?? "", compression: lastExt };
  }
  return { ext: lastExt, compression: null };
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** True when the host is an excluded domain or a subdomain of one (same as excludedRequestDomains). */
export function isExcludedHost(url: string, settings: PreviewSettings): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return normalizedExcludedDomains(settings).some((d) => host === d || host.endsWith(`.${d}`));
}

/** What a URL would open as under these settings, matching the redirect rules exactly. */
export function classifyUrl(url: string, settings: PreviewSettings): PreviewKind | null {
  if (!settings.enabled || isExcludedHost(url, settings)) return null;
  const data = dataRegex(settings);
  if (data && new RegExp(data, "i").test(url)) return "data";
  const media = mediaRegex(settings);
  if (media && new RegExp(media, "i").test(url)) return "media";
  return null;
}

/** Same decision for a bare file name, e.g. a download's suggested name. */
export function classifyFilename(name: string, settings: PreviewSettings): PreviewKind | null {
  if (!settings.enabled) return null;
  const parsed = fileExtension(name);
  if (!parsed) return null;
  const checked = checkedExtensions(settings);
  if (checked.data.includes(parsed.ext) && (!parsed.compression || checked.compression.includes(parsed.compression))) {
    return "data";
  }
  if (!parsed.compression && checked.media.includes(parsed.ext)) return "media";
  return null;
}

const MIME_EXTENSIONS: Record<string, string> = {
  "text/csv": "csv",
  "application/csv": "csv",
  "text/tab-separated-values": "tsv",
  "application/x-ndjson": "ndjson",
  "application/ndjson": "ndjson",
  "application/jsonl": "jsonl",
  "application/x-jsonlines": "jsonl",
  "application/vnd.apache.parquet": "parquet",
  "application/x-parquet": "parquet",
  "application/parquet": "parquet",
  "application/vnd.apache.arrow.file": "arrow",
  "application/vnd.apache.arrow.stream": "arrow",
  "application/x-sqlite3": "sqlite",
  "application/vnd.sqlite3": "sqlite",
  "application/json": "json",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/heic": "heic",
  "image/tiff": "tiff",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-m4v": "m4v",
  "video/x-matroska": "mkv",
};

/** The checked extension a MIME type stands for, or null. "image/jpeg" counts if jpg or jpeg is checked. */
export function extensionForMime(mime: string, settings: PreviewSettings): string | null {
  const type = (mime.split(";")[0] ?? "").trim().toLowerCase();
  const ext = MIME_EXTENSIONS[type];
  if (!ext) return null;
  const checked = new Set(settings.extensions.map((e) => e.toLowerCase()));
  if (checked.has(ext)) return ext;
  if (ext === "jpg" && checked.has("jpeg")) return "jpeg";
  if (ext === "ndjson" && checked.has("jsonl")) return "jsonl";
  if (ext === "jsonl" && checked.has("ndjson")) return "ndjson";
  return null;
}

export function classifyMime(mime: string, settings: PreviewSettings): PreviewKind | null {
  if (!settings.enabled) return null;
  const ext = extensionForMime(mime, settings);
  if (!ext) return null;
  return MEDIA_EXTENSIONS.includes(ext) ? "media" : "data";
}
