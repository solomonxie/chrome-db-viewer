// Service worker: keeps the browser-preview redirect rules in sync with the saved settings (§3.12)
// and opens image/video downloads in the media viewer (§3.13).
// The toolbar icon opens popup.html (manifest default_popup, DESIGN.md §4.1), not a handler here.

import { handleDownloadCreated, loadPreviewSettings, localFileToOpen, mediaDisplayName, mediaKind, mediaViewerUrl, PREVIEW_SETTINGS_KEY, syncPreviewRules } from "../preview/index";

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

// Images and videos a site sends as a download open in media.html instead (src/preview/media.ts).
// Only downloads that a tab's navigation turned into one: opening a signed URL or clicking a
// plain link. "Save image as…", <a download> and the viewer's own Download button still save.
const recentNavigations = new Map<string, number>();
chrome.webNavigation.onBeforeNavigate.addListener(({ url, timeStamp }) => {
  for (const [old, time] of recentNavigations) {
    if (timeStamp - time > 60_000) recentNavigations.delete(old);
  }
  recentNavigations.set(url, timeStamp);
});

// Here rather than onCreated: this is where Chrome knows the file name from Content-Disposition,
// before any Save As dialog and before anything is written to disk.
// - A data file dropped onto Chrome (file://) opens straight from where it is, with no copy in Downloads.
// - Images and videos a tab navigated to open in media.html.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const navigated = recentNavigations.delete(item.url);
  const media = item.byExtensionId === chrome.runtime.id || !navigated ? null : mediaKind(item);
  const local = /^file:/i.test(item.finalUrl || item.url);
  if (!media && !local) {
    suggest();
    return;
  }
  void (async () => {
    const url = item.finalUrl || item.url;
    const target = media
      ? mediaViewerUrl(chrome.runtime.getURL(""), url, media, mediaDisplayName(url, item.filename))
      : localFileToOpen(item, await loadPreviewSettings(), chrome.runtime.id);
    if (!target) {
      suggest();
      return;
    }
    await chrome.downloads.cancel(item.id).catch(() => {});
    await chrome.downloads.erase({ id: item.id }).catch(() => {});
    await chrome.tabs.create({ url: target });
  })();
  return true;
});
