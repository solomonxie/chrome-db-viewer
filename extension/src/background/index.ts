// Service worker: toolbar click opens or focuses the app tab (DESIGN.md §4.1) and keeps the
// browser-preview redirect rules in sync with the saved settings (§3.12).

import { handleDownloadCreated, loadPreviewSettings, PREVIEW_SETTINGS_KEY, syncPreviewRules } from "../preview/index";

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("app.html");
  const [tab] = await chrome.tabs.query({ url: url + "*" });
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

async function resync(): Promise<void> {
  try {
    await syncPreviewRules(await loadPreviewSettings());
  } catch (e) {
    console.error("dbui: syncing preview rules failed", e);
  }
}

// Every service-worker start (browser start, extension reload, wake-up after idle) resyncs:
// onStartup doesn't fire on an extension reload, and dynamic rules must match the settings,
// which default to on (§3.12).
void resync();
chrome.runtime.onStartup.addListener(() => void resync());
chrome.runtime.onInstalled.addListener(() => void resync());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && PREVIEW_SETTINGS_KEY in changes) void resync();
});

// Granting or revoking all-sites access changes whether the rules may be active.
chrome.permissions.onAdded.addListener(() => void resync());
chrome.permissions.onRemoved.addListener(() => void resync());

chrome.downloads.onCreated.addListener((item) => {
  void handleDownloadCreated(item).catch((e) => console.error("dbui: download handler failed", e));
});
