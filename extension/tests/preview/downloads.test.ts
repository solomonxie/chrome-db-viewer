import { afterEach, expect, test, vi } from "vitest";
import { decideDownloadPrompt, handleDownloadCreated, openDownloadInDbui } from "../../src/preview/downloads";
import { syncPreviewRules } from "../../src/preview/index";
import { DEFAULT_PREVIEW_SETTINGS, addExcludedDomain, type PreviewSettings } from "../../src/preview/settings";

const EXT = "chrome-extension://extid/";
type Listener = (delta: chrome.downloads.DownloadDelta) => void;

function item(over: Partial<chrome.downloads.DownloadItem>): chrome.downloads.DownloadItem {
  return {
    id: 7, url: "", finalUrl: "", referrer: "", filename: "", mime: "", state: "in_progress", danger: "safe",
    bytesReceived: 0, totalBytes: 1024, fileSize: 0, paused: false, canResume: false, exists: true,
    incognito: false, startTime: "", error: undefined, ...over,
  } as chrome.downloads.DownloadItem;
}

/** A minimal chrome global: storage.local/session in memory, tabs, downloads, DNR, permissions. */
function stubChrome(opts: { settings?: Partial<PreviewSettings>; granted?: boolean; downloads?: chrome.downloads.DownloadItem[] } = {}) {
  const local: Record<string, unknown> = opts.settings ? { previewSettings: { ...DEFAULT_PREVIEW_SETTINGS, ...opts.settings } } : {};
  const session: Record<string, unknown> = {};
  const listeners: Listener[] = [];
  const downloads = [...(opts.downloads ?? [])];
  const area = (store: Record<string, unknown>) => ({
    get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
    set: vi.fn(async (v: Record<string, unknown>) => void Object.assign(store, v)),
    remove: vi.fn(async (key: string) => void delete store[key]),
  });
  const c = {
    runtime: { id: "extid", getURL: (p: string) => EXT + p },
    storage: { local: area(local), session: area(session) },
    tabs: { create: vi.fn(async (_: { url: string }) => ({ id: 1 })) },
    permissions: { contains: vi.fn(async () => opts.granted ?? true) },
    declarativeNetRequest: { updateDynamicRules: vi.fn(async () => {}) },
    downloads: {
      search: vi.fn(async ({ id }: { id: number }) => downloads.filter((d) => d.id === id)),
      onChanged: {
        addListener: (l: Listener) => listeners.push(l),
        removeListener: (l: Listener) => listeners.splice(listeners.indexOf(l), 1),
      },
    },
  };
  vi.stubGlobal("chrome", c);
  return { c, local, session, listeners, downloads };
}

afterEach(() => vi.unstubAllGlobals());

const on: PreviewSettings = { ...DEFAULT_PREVIEW_SETTINGS, enabled: true };
const off: PreviewSettings = { ...DEFAULT_PREVIEW_SETTINGS, enabled: false };

test("decideDownloadPrompt: off, excluded, own downloads and unknown types don't prompt", () => {
  const csv = item({ url: "https://app.test/export", filename: "/Users/me/Downloads/report.csv" });
  expect(decideDownloadPrompt(csv, off)).toEqual({ prompt: false, reason: "disabled" });
  expect(decideDownloadPrompt(csv, { ...on, excludedDomains: ["app.test"] })).toEqual({ prompt: false, reason: "excluded" });
  expect(decideDownloadPrompt({ ...csv, byExtensionId: "extid" }, on, "extid")).toEqual({ prompt: false, reason: "extension" });
  expect(decideDownloadPrompt(item({ url: "https://x.test/setup.dmg", filename: "/d/setup.dmg" }), on)).toEqual({ prompt: false, reason: "no-match" });
  expect(decideDownloadPrompt(item({ url: "https://x.test/backup.tar.gz" }), on)).toEqual({ prompt: false, reason: "no-match" });
});

test("decideDownloadPrompt matches by file name, URL, then MIME type", () => {
  expect(decideDownloadPrompt(item({ url: "https://app.test/export?id=3", filename: "/d/Orders 2024.CSV" }), on)).toEqual({ prompt: true, kind: "data", filename: "Orders 2024.CSV" });
  // onCreated often fires before the file name is known.
  expect(decideDownloadPrompt(item({ url: "https://x.test/dl/events.jsonl.gz" }), on)).toEqual({ prompt: true, kind: "data", filename: "events.jsonl.gz" });
  expect(decideDownloadPrompt(item({ url: "blob:https://app.test/0b1c", mime: "text/csv" }), on)).toEqual({ prompt: true, kind: "data", filename: "download" });
  expect(decideDownloadPrompt(item({ url: "https://x.test/p/1", mime: "image/png" }), on).prompt).toBe(false);
});

test("decideDownloadPrompt: image and video downloads never prompt, even with old media extensions checked", () => {
  const legacy: PreviewSettings = { ...on, extensions: [...on.extensions, "png", "jpg", "mp4", "mkv"] };
  expect(decideDownloadPrompt(item({ url: "https://x.test/p/1", mime: "image/png" }), legacy)).toEqual({ prompt: false, reason: "no-match" });
  expect(decideDownloadPrompt(item({ url: "https://x.test/photo.jpg", filename: "/d/photo.jpg" }), legacy)).toEqual({ prompt: false, reason: "no-match" });
  expect(decideDownloadPrompt(item({ url: "https://x.test/clip.mp4", mime: "video/mp4" }), legacy)).toEqual({ prompt: false, reason: "no-match" });
});

test("handleDownloadCreated stores the pending prompt in session storage and opens the prompt tab", async () => {
  const { c, session } = stubChrome({ settings: { enabled: true } });
  await handleDownloadCreated(item({ id: 42, url: "https://app.test/export", finalUrl: "https://cdn.app.test/r.parquet?sig=1", mime: "application/octet-stream", totalBytes: 2048 }));
  expect(session["downloadPrompt:42"]).toMatchObject({
    downloadId: 42, url: "https://cdn.app.test/r.parquet?sig=1", filename: "r.parquet", kind: "data", refetchable: true, totalBytes: 2048,
  });
  expect(c.tabs.create).toHaveBeenCalledWith({ url: `${EXT}app.html#download-prompt?id=42`, active: true });
});

const GCS_SIGNED = "https://storage.googleapis.com/my-bucket/exports/2026/10/report_2026-10-29.csv?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=svc%40proj.iam.gserviceaccount.com%2F20261029%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date=20261029T120000Z&X-Goog-Expires=900&X-Goog-SignedHeaders=host&X-Goog-Signature=0a1b2c";

test("a GCS signed CSV that arrives as a download (Console Download button, Content-Disposition) gets the prompt", async () => {
  // By URL alone, before Chrome knows the file name.
  expect(decideDownloadPrompt(item({ url: GCS_SIGNED, finalUrl: GCS_SIGNED, mime: "application/octet-stream" }), on)).toEqual({ prompt: true, kind: "data", filename: "report_2026-10-29.csv" });
  // By the file name when the final URL has no data extension in its path.
  const consoleDl = item({ url: "https://console.cloud.google.com/storage/browser/_details/my-bucket/obj?download=1", finalUrl: "https://storage.googleapis.com/download/storage/v1/b/my-bucket/o/obj?alt=media&generation=1", filename: "/Users/me/Downloads/report_2026-10-29.csv", mime: "application/octet-stream" });
  expect(decideDownloadPrompt(consoleDl, on)).toEqual({ prompt: true, kind: "data", filename: "report_2026-10-29.csv" });

  const { c, session } = stubChrome({ settings: { enabled: true } });
  await handleDownloadCreated(item({ id: 11, url: GCS_SIGNED, finalUrl: GCS_SIGNED }));
  expect(session["downloadPrompt:11"]).toMatchObject({ url: GCS_SIGNED, filename: "report_2026-10-29.csv", kind: "data", refetchable: true });
  expect(c.tabs.create).toHaveBeenCalledWith({ url: `${EXT}app.html#download-prompt?id=11`, active: true });
  expect(await openDownloadInDbui(11)).toBe(`${EXT}app.html?src=${encodeURIComponent(GCS_SIGNED)}#file`);
});

test("handleDownloadCreated does nothing when the feature is off", async () => {
  const { c, session } = stubChrome({ settings: { enabled: false } });
  await handleDownloadCreated(item({ url: "https://x.test/a.csv" }));
  expect(session).toEqual({});
  expect(c.tabs.create).not.toHaveBeenCalled();
});

test("openDownloadInDbui refetches an http(s) URL directly", async () => {
  const { c, session } = stubChrome({ settings: { enabled: true } });
  await handleDownloadCreated(item({ id: 5, url: "https://x.test/a b.csv?x=1&y=2" }));
  const target = await openDownloadInDbui(5);
  expect(target).toBe(`${EXT}app.html?src=${encodeURIComponent("https://x.test/a b.csv?x=1&y=2")}#file`);
  expect(c.tabs.create).toHaveBeenLastCalledWith({ url: target, active: true });
  expect(session["downloadPrompt:5"]).toBeUndefined();
});

test("openDownloadInDbui waits for a blob: download to finish and opens the file from disk", async () => {
  const pending = item({ id: 9, url: "blob:https://app.test/uuid", mime: "text/csv", filename: "/Users/me/Downloads/My Report.csv" });
  const { listeners, downloads } = stubChrome({ settings: { enabled: true }, downloads: [pending] });
  await handleDownloadCreated(pending);
  const opened = openDownloadInDbui(9);
  await vi.waitFor(() => expect(listeners).toHaveLength(1));
  downloads[0] = { ...pending, state: "complete" };
  listeners[0]?.({ id: 9, state: { previous: "in_progress", current: "complete" } });
  expect(await opened).toBe(`${EXT}app.html?src=${encodeURIComponent("file:///Users/me/Downloads/My%20Report.csv")}#file`);
  expect(listeners).toHaveLength(0);
});

test("syncPreviewRules adds rule 1, always removes legacy rules 2 and 3, and clears everything when off or without host access", async () => {
  const { c } = stubChrome();
  await syncPreviewRules(on);
  expect(c.permissions.contains).toHaveBeenCalledWith({ origins: ["https://*/*", "http://*/*"] });
  const first = c.declarativeNetRequest.updateDynamicRules.mock.calls[0] as unknown as [chrome.declarativeNetRequest.UpdateRuleOptions];
  expect(first[0].removeRuleIds).toEqual([1, 2, 3]);
  expect(first[0].addRules?.map((r) => r.id)).toEqual([1]);
  expect(first[0].addRules?.[0]?.action.redirect?.regexSubstitution).toBe(`${EXT}app.html?src=\\0`);

  await syncPreviewRules(off);
  expect(c.declarativeNetRequest.updateDynamicRules).toHaveBeenLastCalledWith({ removeRuleIds: [1, 2, 3], addRules: [] });

  stubChrome({ granted: false });
  await syncPreviewRules(on);
  expect(chrome.declarativeNetRequest.updateDynamicRules).toHaveBeenLastCalledWith({ removeRuleIds: [1, 2, 3], addRules: [] });
});

test("addExcludedDomain adds the hostname once to previewSettings", async () => {
  const { local } = stubChrome({ settings: { enabled: true } });
  expect(await addExcludedDomain("Files.Example.com")).toBe("files.example.com");
  expect(await addExcludedDomain("https://files.example.com/x")).toBe("files.example.com");
  expect((local.previewSettings as PreviewSettings).excludedDomains).toEqual(["files.example.com"]);
  expect((local.previewSettings as PreviewSettings).enabled).toBe(true);
});
