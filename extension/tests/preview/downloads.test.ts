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

test("decideDownloadPrompt: off, excluded, own downloads and unknown types don't prompt", () => {
  const csv = item({ url: "https://app.test/export", filename: "/Users/me/Downloads/report.csv" });
  expect(decideDownloadPrompt(csv, DEFAULT_PREVIEW_SETTINGS)).toEqual({ prompt: false, reason: "disabled" });
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
  expect(decideDownloadPrompt(item({ url: "https://x.test/p/1", mime: "image/png" }), { ...on, extensions: ["png"] })).toEqual({ prompt: true, kind: "media", filename: "1" });
});

test("handleDownloadCreated stores the pending prompt in session storage and opens the prompt tab", async () => {
  const { c, session } = stubChrome({ settings: { enabled: true } });
  await handleDownloadCreated(item({ id: 42, url: "https://app.test/export", finalUrl: "https://cdn.app.test/r.parquet?sig=1", mime: "application/octet-stream", totalBytes: 2048 }));
  expect(session["downloadPrompt:42"]).toMatchObject({
    downloadId: 42, url: "https://cdn.app.test/r.parquet?sig=1", filename: "r.parquet", kind: "data", refetchable: true, totalBytes: 2048,
  });
  expect(c.tabs.create).toHaveBeenCalledWith({ url: `${EXT}app.html#download-prompt?id=42`, active: true });
});

test("handleDownloadCreated does nothing when the feature is off", async () => {
  const { c, session } = stubChrome();
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

test("openDownloadInDbui sends images to media.html", async () => {
  stubChrome({ settings: { enabled: true, extensions: ["png"] } });
  await handleDownloadCreated(item({ id: 3, url: "https://x.test/p.png" }));
  expect(await openDownloadInDbui(3)).toBe(`${EXT}media.html?src=${encodeURIComponent("https://x.test/p.png")}`);
});

test("syncPreviewRules replaces rules 1-3, and clears them when off or without host access", async () => {
  const { c } = stubChrome();
  await syncPreviewRules(on);
  expect(c.permissions.contains).toHaveBeenCalledWith({ origins: ["https://*/*", "http://*/*"] });
  const first = c.declarativeNetRequest.updateDynamicRules.mock.calls[0] as unknown as [chrome.declarativeNetRequest.UpdateRuleOptions];
  expect(first[0].removeRuleIds).toEqual([1, 2, 3]);
  expect(first[0].addRules?.map((r) => r.id)).toEqual([1, 3]);
  expect(first[0].addRules?.[1]?.condition.initiatorDomains).toEqual(["extid"]);
  expect(first[0].addRules?.[0]?.action.redirect?.regexSubstitution).toBe(`${EXT}app.html?src=\\0`);

  await syncPreviewRules(DEFAULT_PREVIEW_SETTINGS);
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
