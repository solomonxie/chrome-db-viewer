// "Open in dbui" for downloads the redirect rule can't catch (§3.12): Export buttons,
// Content-Disposition: attachment, URLs with no extension, blob: URLs, form POSTs.
//
// chrome.notifications isn't in the manifest, so the prompt is a small tab:
//   app.html#download-prompt?id=<downloadId>
// The pending prompt's details are in chrome.storage.session under `downloadPrompt:<id>`
// (PendingDownloadPrompt below); the UI reads that, then calls openDownloadInDbui or dismisses.

import { classifyFilename, classifyMime, classifyUrl, isExcludedHost, type PreviewKind } from "./rules";
import { loadPreviewSettings, type PreviewSettings } from "./settings";
import { buildSrcUrl } from "./src-param";

export const DOWNLOAD_PROMPT_PREFIX = "downloadPrompt:";

export interface PendingDownloadPrompt {
  downloadId: number;
  /** The URL the download came from (finalUrl when known). May be blob: or data:. */
  url: string;
  /** Best guess at the file name: the suggested filename, else the last URL path segment. */
  filename: string;
  mime: string;
  kind: PreviewKind;
  /** True when dbui can fetch `url` again itself (http(s), GET-able). False: wait for the file on disk. */
  refetchable: boolean;
  /** Bytes, or -1 when unknown. */
  totalBytes: number;
  createdAt: number;
}

export type DownloadDecision =
  | { prompt: false; reason: "disabled" | "excluded" | "no-match" | "extension" }
  | { prompt: true; kind: PreviewKind; filename: string };

function baseName(path: string): string {
  return path.split(/[/\\]/).pop() ?? "";
}

function urlFileName(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "file:") return "";
    return decodeURIComponent(baseName(u.pathname));
  } catch {
    return "";
  }
}

/** Pure decision: does this download get an "Open in dbui" prompt? Downloads dbui started itself
 *  (Download instead, Save as PNG) never do. */
export function decideDownloadPrompt(item: chrome.downloads.DownloadItem, settings: PreviewSettings, ownExtensionId?: string): DownloadDecision {
  if (!settings.enabled) return { prompt: false, reason: "disabled" };
  if ((ownExtensionId && item.byExtensionId === ownExtensionId) || (item.finalUrl || item.url).startsWith("chrome-extension://")) {
    return { prompt: false, reason: "extension" };
  }
  const url = item.finalUrl || item.url;
  if (isExcludedHost(url, settings) || (item.referrer && isExcludedHost(item.referrer, settings))) {
    return { prompt: false, reason: "excluded" };
  }
  const filename = baseName(item.filename) || urlFileName(url);
  const kind = (filename ? classifyFilename(filename, settings) : null) ?? classifyUrl(url, settings) ?? classifyMime(item.mime ?? "", settings);
  if (!kind) return { prompt: false, reason: "no-match" };
  return { prompt: true, kind, filename: filename || "download" };
}

function isRefetchable(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Called from chrome.downloads.onCreated in the background worker. */
export async function handleDownloadCreated(item: chrome.downloads.DownloadItem): Promise<void> {
  const settings = await loadPreviewSettings();
  const decision = decideDownloadPrompt(item, settings, chrome.runtime?.id);
  if (!decision.prompt) return;
  const url = item.finalUrl || item.url;
  const pending: PendingDownloadPrompt = {
    downloadId: item.id,
    url,
    filename: decision.filename,
    mime: item.mime ?? "",
    kind: decision.kind,
    refetchable: isRefetchable(url),
    totalBytes: typeof item.totalBytes === "number" ? item.totalBytes : -1,
    createdAt: Date.now(),
  };
  await chrome.storage.session.set({ [DOWNLOAD_PROMPT_PREFIX + item.id]: pending });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`app.html#download-prompt?id=${item.id}`), active: true });
}

export async function getPendingDownloadPrompt(downloadId: number): Promise<PendingDownloadPrompt | null> {
  const key = DOWNLOAD_PROMPT_PREFIX + downloadId;
  const got = await chrome.storage.session.get(key);
  return (got[key] as PendingDownloadPrompt | undefined) ?? null;
}

export async function dismissDownloadPrompt(downloadId: number): Promise<void> {
  await chrome.storage.session.remove(DOWNLOAD_PROMPT_PREFIX + downloadId);
}

/** The page a finished/refetchable download opens in: media.html for images/video, else app.html#file. */
export function viewerUrlFor(src: string, kind: PreviewKind): string {
  return kind === "media"
    ? buildSrcUrl(chrome.runtime.getURL("media.html"), src)
    : buildSrcUrl(chrome.runtime.getURL("app.html"), src, "#file");
}

function fileUrlFromPath(path: string): string {
  // Encode each segment but keep the slashes; Windows paths get a leading slash.
  const norm = path.replace(/\\/g, "/");
  const withSlash = norm.startsWith("/") ? norm : `/${norm}`;
  return `file://${withSlash.split("/").map(encodeURIComponent).join("/")}`;
}

async function findDownload(downloadId: number): Promise<chrome.downloads.DownloadItem | undefined> {
  const [item] = await chrome.downloads.search({ id: downloadId });
  return item;
}

/** Resolves with the finished item once `state` is complete; rejects on interrupt. */
export function waitForDownloadComplete(downloadId: number): Promise<chrome.downloads.DownloadItem> {
  return new Promise((resolve, reject) => {
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === "complete") {
        chrome.downloads.onChanged.removeListener(onChanged);
        findDownload(downloadId).then((item) => (item ? resolve(item) : reject(new Error("download disappeared"))), reject);
      } else if (delta.state.current === "interrupted") {
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(new Error("download interrupted"));
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    // It may have finished before the listener was attached.
    findDownload(downloadId).then((item) => {
      if (item?.state === "complete") {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve(item);
      } else if (item?.state === "interrupted") {
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(new Error("download interrupted"));
      }
    }, reject);
  });
}

/**
 * Opens a download in dbui. http(s) URLs are fetched again directly (the download keeps going;
 * the UI may cancel it). blob:, data: and other one-time sources wait for the file on disk and
 * open file://<path>, which needs "Allow access to file URLs".
 * Returns the URL of the tab it opened.
 */
export async function openDownloadInDbui(downloadId: number): Promise<string> {
  const pending = await getPendingDownloadPrompt(downloadId);
  const item = await findDownload(downloadId);
  const url = pending?.url ?? (item ? item.finalUrl || item.url : "");
  const settings = await loadPreviewSettings();
  const name = pending?.filename ?? (item ? baseName(item.filename) : "");
  const kind: PreviewKind = pending?.kind ?? (classifyFilename(name, { ...settings, enabled: true }) ?? "data");

  let target: string;
  if (isRefetchable(url) && pending?.refetchable !== false) {
    target = viewerUrlFor(url, kind);
  } else {
    const done = item?.state === "complete" ? item : await waitForDownloadComplete(downloadId);
    target = viewerUrlFor(fileUrlFromPath(done.filename), kind);
  }
  await chrome.tabs.create({ url: target, active: true });
  await dismissDownloadPrompt(downloadId);
  return target;
}
