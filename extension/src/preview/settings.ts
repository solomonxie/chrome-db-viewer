// Browser preview settings and their storage (chrome.storage.local, key "previewSettings").

import { normalizeDomain } from "./rules";

export interface PreviewSettings {
  enabled: boolean;
  /** Checked extensions without the dot, e.g. ["csv", "jsonl", "parquet", "png"]. */
  extensions: string[];
  excludedDomains: string[];
}

/** What turning the feature on checks (§3.12): every data group except JSON, plus compression; no media. */
export const DEFAULT_PREVIEW_SETTINGS: PreviewSettings = {
  enabled: false,
  extensions: ["csv", "tsv", "psv", "jsonl", "ndjson", "parquet", "arrow", "feather", "duckdb", "sqlite", "db", "gz", "zst"],
  excludedDomains: [],
};

export const PREVIEW_SETTINGS_KEY = "previewSettings";

/** The stored settings merged over the defaults; tolerates a missing or partial value. */
export async function loadPreviewSettings(): Promise<PreviewSettings> {
  const got = await chrome.storage.local.get(PREVIEW_SETTINGS_KEY);
  return mergeSettings(got[PREVIEW_SETTINGS_KEY]);
}

export function mergeSettings(raw: unknown): PreviewSettings {
  const v = (raw && typeof raw === "object" ? raw : {}) as Partial<PreviewSettings>;
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_PREVIEW_SETTINGS.enabled,
    extensions: Array.isArray(v.extensions) ? v.extensions.filter((e) => typeof e === "string") : [...DEFAULT_PREVIEW_SETTINGS.extensions],
    excludedDomains: Array.isArray(v.excludedDomains) ? v.excludedDomains.filter((e) => typeof e === "string") : [],
  };
}

export async function savePreviewSettings(settings: PreviewSettings): Promise<void> {
  await chrome.storage.local.set({ [PREVIEW_SETTINGS_KEY]: settings });
}

/** Adds a domain to "Never open from these sites". Returns the normalized domain, or null if invalid.
 *  The background worker is expected to resync the rules on storage.onChanged. */
export async function addExcludedDomain(domain: string): Promise<string | null> {
  const d = normalizeDomain(domain);
  if (!d) return null;
  const settings = await loadPreviewSettings();
  if (!settings.excludedDomains.map((x) => normalizeDomain(x)).includes(d)) {
    settings.excludedDomains = [...settings.excludedDomains, d];
    await savePreviewSettings(settings);
  }
  return d;
}
