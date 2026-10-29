// Fetching media bytes and saving files out of the viewer.

/** fetch() doesn't support file:// in Chrome; XHR does for extensions with "Allow access to file URLs". */
function xhr(url: string, type: "blob" | "text"): Promise<{ body: Blob | string; type: string | null }> {
  return new Promise((resolve, reject) => {
    const req = new XMLHttpRequest();
    req.open("GET", url);
    req.responseType = type;
    req.onload = () => {
      // file:// reports status 0 on success.
      if (req.status === 0 || (req.status >= 200 && req.status < 300)) {
        resolve({ body: req.response as Blob | string, type: req.getResponseHeader("content-type") });
      } else reject(new Error(`HTTP ${req.status}`));
    };
    req.onerror = () => reject(new Error(url.startsWith("file:") ? "Can't read local files. Turn on Allow access to file URLs for dbui." : "Network error"));
    req.send();
  });
}

export async function loadBlob(src: string): Promise<Blob> {
  if (src.startsWith("file:")) return (await xhr(src, "blob")).body as Blob;
  const res = await fetch(src, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  return res.blob();
}

/** A fetch that also reads file:// (used for folder listings). */
export const fetchAny: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("file:")) {
    const { body, type } = await xhr(url, "text");
    return new Response(body as string, { status: 200, headers: { "content-type": type ?? "text/html" } });
  }
  return fetch(input, init);
};

export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("This image can't be exported (cross-origin or too large)."))), type, quality);
  });
}

/** Saves a blob through chrome.downloads (Save as dialog), falling back to an <a download>. */
export async function saveBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  try {
    if (typeof chrome !== "undefined" && chrome.downloads?.download) {
      await chrome.downloads.download({ url, filename, saveAs: true });
    } else {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
    }
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

/** "Download instead": a download, not a navigation, so the redirect rule doesn't catch it. */
export async function downloadOriginal(src: string): Promise<void> {
  if (typeof chrome !== "undefined" && chrome.downloads?.download) {
    await chrome.downloads.download({ url: src });
  } else {
    window.open(src, "_blank");
  }
}
