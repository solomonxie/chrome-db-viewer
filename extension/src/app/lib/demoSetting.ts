// Settings → Connections: whether the demo connection is listed (popup, pickers). On by default.
// Stored in chrome.storage.local["showDemo"]; outside the extension (tests, dev page) it's on.

export const SHOW_DEMO_KEY = "showDemo";

function storage(): chrome.storage.StorageArea | undefined {
  return typeof chrome !== "undefined" ? chrome.storage?.local : undefined;
}

export async function loadShowDemo(): Promise<boolean> {
  const s = storage();
  if (!s) return true;
  try {
    const got = await s.get(SHOW_DEMO_KEY);
    return got[SHOW_DEMO_KEY] !== false;
  } catch {
    return true;
  }
}

export async function saveShowDemo(on: boolean): Promise<void> {
  await storage()?.set({ [SHOW_DEMO_KEY]: on });
}
