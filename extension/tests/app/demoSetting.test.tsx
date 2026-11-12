// Settings → Connections: the "Show the demo connection" switch saves chrome.storage.local
// "showDemo", and listConnections leaves the demo out while it's off.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ConnectionsSection } from "../../src/app/settings/ConnectionsSection";
import { listConnections } from "../../src/app/lib/connections";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let local: Record<string, unknown> = {};
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  local = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: async (k: string) => (k in local ? { [k]: local[k] } : {}),
        set: async (o: Record<string, unknown>) => void Object.assign(local, o),
      },
    },
  };
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  delete (globalThis as { chrome?: unknown }).chrome;
});

const demoListed = async () => (await listConnections()).some((c) => c.id === "demo");

test("the demo connection is shown by default; switching it off hides it, on brings it back", async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<ConnectionsSection />));
  const box = host.querySelector<HTMLInputElement>("input[aria-label='Show the demo connection']")!;
  expect(box.checked).toBe(true);
  expect(await demoListed()).toBe(true);

  await act(async () => box.click());
  expect(local.showDemo).toBe(false);
  expect(box.checked).toBe(false);
  expect(await demoListed()).toBe(false);

  await act(async () => box.click());
  expect(local.showDemo).toBe(true);
  expect(await demoListed()).toBe(true);
});
