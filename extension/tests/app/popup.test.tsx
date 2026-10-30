// Toolbar popup: lists saved connections from tests/fixtures/app/connections.json (served by an
// in-memory stand-in for the IndexedDB store), filters as you type, and opens the chosen one
// in a new tab. The footer brings up Home in an existing app tab or a new one.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { SavedConnection } from "../../src/app/store/db";

const FIXTURE: SavedConnection[] = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/app/connections.json"), "utf8"));
const store = new Map<string, SavedConnection>();

vi.mock("../../src/app/store/db", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/app/store/db")>();
  return {
    ...orig,
    getAll: async (name: string) => (name === "connections" ? [...store.values()] : []),
    get: async (name: string, id: string) => (name === "connections" ? store.get(id) : undefined),
    put: async (name: string, row: SavedConnection) => {
      if (name === "connections") store.set(row.id, row);
    },
  };
});

const { Popup } = await import("../../src/popup/Popup");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const createTab = vi.fn(async (_: { url: string }) => ({}));
const updateTab = vi.fn(async (_id: number, _p: { active: boolean; url: string }) => ({}));
let openTabs: { id: number; windowId: number; url: string }[] = [];
let done = 0;
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  store.clear();
  for (const c of FIXTURE) store.set(c.id, structuredClone(c));
  createTab.mockClear();
  updateTab.mockClear();
  openTabs = [];
  done = 0;
  (globalThis as { chrome?: unknown }).chrome = {
    tabs: { create: createTab, update: updateTab, query: async () => openTabs },
    windows: { update: async () => ({}) },
    runtime: { getURL: (p: string) => `chrome-extension://dbui/${p}` },
  };
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  delete (globalThis as { chrome?: unknown }).chrome;
});

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
async function until(fn: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for UI: " + host?.textContent?.slice(0, 300));
    await wait(20);
  }
}
async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Popup onDone={() => done++} />));
  await until(() => names().length > 0);
}
const names = () => [...host!.querySelectorAll("[role=option] .cpick-name")].map((e) => e.textContent);
const input = () => host!.querySelector<HTMLInputElement>("input[role=combobox]")!;
async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(k: string) {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
}
async function click(el: Element) {
  await act(async () => (el as HTMLElement).click());
}
const button = (text: string) => [...host!.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;

test("lists every saved connection plus the demo, and clicking one opens it in a new tab", async () => {
  await mount();
  expect(names()).toHaveLength(FIXTURE.length + 1);
  expect(names()).toContain("Orders prod");
  const row = [...host!.querySelectorAll("[role=option]")].find((r) => r.textContent?.includes("Orders prod"))!;
  await click(row);
  await until(() => done === 1);
  expect(createTab).toHaveBeenCalledWith({ url: "chrome-extension://dbui/app.html#c_pg_orders" });
  expect(store.get("pg_orders")!.lastUsedAt).toBeGreaterThan(FIXTURE[0]!.lastUsedAt!);
});

test("typing filters and Enter opens the highlighted connection", async () => {
  await mount();
  await type("events");
  expect(names()).toEqual(["Events warehouse"]);
  await key("Enter");
  await until(() => done === 1);
  expect(createTab).toHaveBeenCalledWith({ url: "chrome-extension://dbui/app.html#c_ch_events" });
});

test("New connection reuses an app tab on Home but leaves a connection tab alone", async () => {
  openTabs = [
    { id: 1, windowId: 9, url: "chrome-extension://dbui/app.html#c_pg_orders" },
    { id: 2, windowId: 9, url: "chrome-extension://dbui/app.html#home" },
  ];
  await mount();
  await click(button("New connection"));
  await until(() => done === 1);
  expect(updateTab).toHaveBeenCalledWith(2, { active: true, url: "chrome-extension://dbui/app.html#home/new" });
  expect(createTab).not.toHaveBeenCalled();

  openTabs = [{ id: 1, windowId: 9, url: "chrome-extension://dbui/app.html#c_pg_orders" }];
  await click(button("Open app"));
  await until(() => done === 2);
  expect(createTab).toHaveBeenCalledWith({ url: "chrome-extension://dbui/app.html#home" });
});
