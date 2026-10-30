// Theme setting (Settings → Appearance): "dark" (default), "light" or "system".
// Stored in chrome.storage.local["theme"], mirrored to localStorage["dbui.theme"] so
// public/theme-boot.js can set <html data-theme> synchronously before the first paint.
// tokens.css maps data-theme to colours; "system" follows prefers-color-scheme there.

export type ThemePref = "dark" | "light" | "system";

export const THEME_KEY = "theme";
export const THEME_LOCAL_KEY = "dbui.theme";
export const DEFAULT_THEME: ThemePref = "dark";
export const THEMES: { value: ThemePref; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "Match system" },
];

export function normalizeTheme(v: unknown): ThemePref {
  return v === "light" || v === "system" || v === "dark" ? v : DEFAULT_THEME;
}

function hasChromeStorage(): boolean {
  return typeof chrome !== "undefined" && !!chrome.storage?.local;
}

function readLocal(): ThemePref {
  try {
    return normalizeTheme(localStorage.getItem(THEME_LOCAL_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

function writeLocal(t: ThemePref) {
  try {
    localStorage.setItem(THEME_LOCAL_KEY, t);
  } catch {
    // Private window or blocked storage: the chrome.storage copy still applies on load.
  }
}

export function applyTheme(t: ThemePref, root: HTMLElement = document.documentElement) {
  root.dataset.theme = t;
}

export async function loadTheme(): Promise<ThemePref> {
  if (!hasChromeStorage()) return readLocal();
  try {
    const got = await chrome.storage.local.get(THEME_KEY);
    return got[THEME_KEY] === undefined ? readLocal() : normalizeTheme(got[THEME_KEY]);
  } catch {
    return readLocal();
  }
}

export async function saveTheme(t: ThemePref): Promise<void> {
  writeLocal(t);
  applyTheme(t);
  if (hasChromeStorage()) await chrome.storage.local.set({ [THEME_KEY]: t });
}

/** Boot: apply the mirrored value now, then sync from chrome.storage and follow changes from other tabs. */
export function initTheme(): void {
  applyTheme(readLocal());
  void loadTheme().then((t) => {
    writeLocal(t);
    applyTheme(t);
  });
  if (hasChromeStorage()) {
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area !== "local" || !(THEME_KEY in changes)) return;
      const t = normalizeTheme(changes[THEME_KEY]?.newValue);
      writeLocal(t);
      applyTheme(t);
    });
  }
}
