// Images and videos a site sends as a download (a GCS signed URL with Content-Disposition:
// attachment, say) open in media.html instead, so they can be looked at or played in Chrome.
// The viewer's Download button still saves the file. Pure functions; the background worker
// (src/background/) wires them to chrome.downloads.

export type MediaKind = "image" | "video";

// Formats Chrome can show by itself. Anything else downloads as usual.
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"];
const VIDEO_TYPES = ["video/mp4", "video/webm", "video/ogg", "video/quicktime", "video/x-m4v"];
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico"];
const VIDEO_EXTENSIONS = ["mp4", "webm", "ogv", "mov", "m4v"];
// Storage often serves files uploaded without a type as one of these, so the name decides.
const UNTYPED = ["", "application/octet-stream", "binary/octet-stream", "application/x-download", "application/force-download"];

function kindOfExtension(name: string): MediaKind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (VIDEO_EXTENSIONS.includes(ext)) return "video";
  return null;
}

function urlPath(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return "";
  }
}

/** Whether a download opens in the viewer instead: from its type, or its name when the type says nothing. */
export function mediaKind(item: { url: string; finalUrl?: string; mime?: string; filename?: string }): MediaKind | null {
  const url = item.finalUrl || item.url;
  // blob: and data: URLs are what pages build to save a file on purpose, and a viewer tab couldn't load them.
  if (!/^https?:/i.test(url)) return null;
  const mime = (item.mime ?? "").split(";")[0]!.trim().toLowerCase();
  if (IMAGE_TYPES.includes(mime)) return "image";
  if (VIDEO_TYPES.includes(mime)) return "video";
  if (!UNTYPED.includes(mime)) return null;
  return kindOfExtension(item.filename ?? "") ?? kindOfExtension(urlPath(url));
}

/** The name the viewer shows: the download's file name, else the last part of the URL's path. */
export function mediaDisplayName(url: string, filename?: string): string {
  const fromFile = filename?.split(/[\\/]/).pop();
  return fromFile || urlPath(url).split("/").pop() || new URL(url).hostname;
}

/** media.html?url=…&kind=…&name=… for a download. */
export function mediaViewerUrl(extensionBaseUrl: string, url: string, kind: MediaKind, name: string): string {
  const base = extensionBaseUrl.endsWith("/") ? extensionBaseUrl : `${extensionBaseUrl}/`;
  return `${base}media.html?${new URLSearchParams({ url, kind, name }).toString()}`;
}
