// Browser preview redirect rules (design/DESIGN.md §3.12). Pure functions: no chrome.* calls here,
// so the tests can check the generated regex against real URLs.

import type { PreviewSettings } from "./settings";

/** dbui only opens data files; images and video are left to Chrome. */
export type PreviewKind = "data";

/** Every extension the settings page offers, grouped as in §3.12. */
export const PREVIEW_GROUPS = {
  tables: ["csv", "tsv", "psv"],
  jsonLines: ["jsonl", "ndjson"],
  columnar: ["parquet", "arrow", "feather"],
  databases: ["duckdb", "sqlite", "db"],
  json: ["json"],
  compressed: ["gz", "zst"],
} as const;

export const DATA_EXTENSIONS: readonly string[] = [
  ...PREVIEW_GROUPS.tables, ...PREVIEW_GROUPS.jsonLines, ...PREVIEW_GROUPS.columnar,
  ...PREVIEW_GROUPS.databases, ...PREVIEW_GROUPS.json,
];
export const COMPRESSION_EXTENSIONS: readonly string[] = PREVIEW_GROUPS.compressed;

export const DATA_RULE_ID = 1;
/**
 * Ids of rules older versions installed: 2 redirected images/video to a media viewer, 3 set
 * Cross-Origin-Resource-Policy on image/media responses for it. Never added any more, but still
 * removed on every sync so existing installs get them cleared.
 */
export const LEGACY_RULE_IDS = [2, 3];
/** Every id syncPreviewRules removes before adding the current rules. */
export const PREVIEW_RULE_IDS = [DATA_RULE_ID, ...LEGACY_RULE_IDS];

interface CheckedExtensions {
  data: string[];
  compression: string[];
}

/** Splits the checked list into the known groups. Unknown entries are dropped, so nothing
 *  user-controlled reaches the regex unescaped. */
export function checkedExtensions(settings: PreviewSettings): CheckedExtensions {
  const checked = new Set(settings.extensions.map((e) => e.trim().toLowerCase().replace(/^\./, "")));
  return {
    data: DATA_EXTENSIONS.filter((e) => checked.has(e)),
    compression: COMPRESSION_EXTENSIONS.filter((e) => checked.has(e)),
  };
}

/** Rule 1's regex, or null when no data extension is checked. `.gz`/`.zst` only after a data type. */
export function dataRegex(settings: PreviewSettings): string | null {
  const { data, compression } = checkedExtensions(settings);
  if (data.length === 0) return null;
  const suffix = compression.length > 0 ? `(?:\\.(?:${compression.join("|")}))?` : "";
  return `^(?:https?|file)://[^?#]*\\.(?:${data.join("|")})${suffix}(?:[?#].*)?$`;
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

/** The dynamic rules for these settings: rule 1 sends data files to app.html. Returns [] when the feature is off. */
export function buildRules(settings: PreviewSettings, extensionBaseUrl: string): chrome.declarativeNetRequest.Rule[] {
  if (!settings.enabled) return [];
  const base = extensionBaseUrl.endsWith("/") ? extensionBaseUrl : `${extensionBaseUrl}/`;
  const data = dataRegex(settings);
  return data ? [redirectRule(DATA_RULE_ID, data, `${base}app.html`, normalizedExcludedDomains(settings))] : [];
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
};

/** The checked extension a MIME type stands for, or null. "application/x-ndjson" counts if ndjson or jsonl is checked. */
export function extensionForMime(mime: string, settings: PreviewSettings): string | null {
  const type = (mime.split(";")[0] ?? "").trim().toLowerCase();
  const ext = MIME_EXTENSIONS[type];
  if (!ext) return null;
  const checked = new Set(settings.extensions.map((e) => e.toLowerCase()));
  if (checked.has(ext)) return ext;
  if (ext === "ndjson" && checked.has("jsonl")) return "jsonl";
  if (ext === "jsonl" && checked.has("ndjson")) return "ndjson";
  return null;
}

export function classifyMime(mime: string, settings: PreviewSettings): PreviewKind | null {
  if (!settings.enabled) return null;
  const ext = extensionForMime(mime, settings);
  return ext ? "data" : null;
}
