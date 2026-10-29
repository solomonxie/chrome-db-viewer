// What a media URL is, plus small formatting helpers for the info panel.

import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, fileExtension } from "../preview/rules";

export type MediaKind = "image" | "video";

export function kindFromExtension(ext: string): MediaKind | null {
  const e = ext.toLowerCase();
  if (IMAGE_EXTENSIONS.includes(e)) return "image";
  if (VIDEO_EXTENSIONS.includes(e)) return "video";
  return null;
}

export function kindFromUrl(url: string): MediaKind | null {
  const parsed = fileExtension(url);
  return parsed && !parsed.compression ? kindFromExtension(parsed.ext) : null;
}

export function kindFromMime(mime: string | null | undefined): MediaKind | null {
  const t = (mime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/") || t === "application/vnd.apple.mpegurl") return "video";
  return null;
}

export interface Probe {
  kind: MediaKind | null;
  mime: string | null;
  size: number | null;
}

/** Picks image or video from the extension, falling back to a HEAD request's Content-Type. */
export async function probeMedia(src: string, fetchImpl: typeof fetch = fetch): Promise<Probe> {
  const byExt = kindFromUrl(src);
  if (!/^https?:/i.test(src)) return { kind: byExt, mime: null, size: null };
  try {
    const res = await fetchImpl(src, { method: "HEAD", credentials: "include" });
    if (!res.ok) return { kind: byExt, mime: null, size: null };
    const mime = res.headers.get("content-type");
    const len = Number(res.headers.get("content-length"));
    return { kind: byExt ?? kindFromMime(mime), mime, size: Number.isFinite(len) && len > 0 ? len : null };
  } catch {
    return { kind: byExt, mime: null, size: null };
  }
}

export function fileNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : u.hostname || url;
  } catch {
    return url.split(/[/\\]/).pop() || url;
  }
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = s.toFixed(2).padStart(5, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "photo.heic" -> "photo.png" */
export function replaceExtension(name: string, ext: string): string {
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name || "image"}.${ext}`;
}
