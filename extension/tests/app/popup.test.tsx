// Toolbar popup: lists saved connections from tests/fixtures/app/connections.json (served by an
// in-memory stand-in for the IndexedDB store), filters as you type, and opens the chosen one
// in a new tab. Each row's ⋯ has the connection actions; the footer opens app pages.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { SavedConnection } from "../../src/app/store/db";
import type { Chain } from "../../src/collections/model";

const FIXTURE: SavedConnection[] = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/app/connections.json"), "utf8"));
const store = new Map<string, SavedConnection>();
const WORKFLOWS: Chain[] = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/app/workflows.json"), "utf8"));

vi.mock("../../src/app/store/db", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/app/store/db")>();
  return {
    ...orig,
    getAll: async (name: string) => (name === "connections" ? [...store.values()] : []),
    get: async (name: string, id: string) => (name === "connections" ? store.get(id) : undefined),
    put: async (name: string, row: SavedConnection) => {
      if (name === "connections") store.set(row.id, row);
    },
    del: async (name: string, id: string) => {
      if (name === "connections") store.delete(id);
    },
  };
});

const { Popup } = await import("../../src/popup/Popup");
// jsdom has no IndexedDB, so workflows live in the collections store's in-memory fallback.
const { deleteChainRow, listChainRows, putChainRow } = await import("../../src/collections/store");
async function setWorkflows(rows: Chain[]) {
  for (const c of await listChainRows()) await deleteChainRow(c.id);
  for (const c of rows) await putChainRow(c);
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const createTab = vi.fn(async (_: { url: string }) => ({}));
const updateTab = vi.fn(async (_id: number, _p: { active: boolean; url: string }) => ({}));
let openTabs: { id: number; windowId: number; url: string }[] = [];
/** chrome.storage.local, where "Remember in this browser" secrets live. */
let local: Record<string, unknown> = {};
const REMEMBERED: { connection: SavedConnection; storage: Record<string, string> } = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/app/remembered-connection.json"), "utf8"),
);
let done = 0;
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(async () => {
  store.clear();
  for (const c of FIXTURE) store.set(c.id, structuredClone(c));
  await setWorkflows(WORKFLOWS);
  createTab.mockClear();
  updateTab.mockClear();
  openTabs = [];
  local = {};
  done = 0;
  (globalThis as { chrome?: unknown }).chrome = {
    tabs: { create: createTab, update: updateTab, query: async () => openTabs },
    windows: { update: async () => ({}) },
    storage: {
      local: {
        get: async (k: string) => (k in local ? { [k]: local[k] } : {}),
        set: async (o: Record<string, unknown>) => void Object.assign(local, o),
        remove: async (k: string) => void delete local[k],
      },
    },
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
async function key(k: string) {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
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

test("there is no search box; arrow keys and Enter open the highlighted connection", async () => {
  await mount();
  expect(host!.querySelector("input")).toBeNull();
  // Ungrouped first, then "Shop" by last use: Local postgres, Orders prod, Events warehouse.
  await key("ArrowDown");
  await key("ArrowDown");
  await key("Enter");
  await until(() => done === 1);
  expect(createTab).toHaveBeenCalledWith({ url: "chrome-extension://dbui/app.html#c_ch_events" });
});

const rowOf = (name: string) => [...host!.querySelectorAll("[role=option]")].find((r) => r.querySelector(".cpick-name")?.textContent === name)!;
const more = (name: string) => host!.querySelector<HTMLButtonElement>(`button[aria-label='More actions for ${name}']`)!;

test("the footer has New connection and Settings; Settings reuses an open tab", async () => {
  openTabs = [{ id: 2, windowId: 9, url: "chrome-extension://dbui/app.html#settings" }];
  await mount();
  expect(button("Open app")).toBeUndefined();
  expect(button("Open file")).toBeUndefined();
  await click(host!.querySelector("button[aria-label=Settings]")!);
  await until(() => done === 1);
  expect(updateTab).toHaveBeenCalledWith(2, { active: true });
  expect(createTab).not.toHaveBeenCalled();
});

const workflowNames = () => [...host!.querySelectorAll("[aria-label='Recent workflows'] .cpick-name")].map((e) => e.textContent);

test("a Workflows section under the connections lists the 4 most recent; clicking one opens it", async () => {
  await mount();
  await until(() => workflowNames().length > 0);
  expect(workflowNames()).toEqual(["Daily ad report", "Month close", "Spend check", "New users"]);
  const daily = host!.querySelector("[aria-label='Recent workflows'] [role=listitem]")!;
  expect(daily.textContent).toContain("2 steps · failed");
  // Workflows aren't connections: arrow keys and Enter don't reach them.
  expect(names()).not.toContain("Daily ad report");
  await click(daily);
  await until(() => done === 1);
  expect(createTab).toHaveBeenCalledWith({ url: "chrome-extension://dbui/app.html#workflow/ch_daily" });
});

test("a connection or workflow that's already open in a tab is focused, not opened again", async () => {
  openTabs = [
    { id: 4, windowId: 9, url: "chrome-extension://dbui/app.html#c_pg_orders" },
    { id: 5, windowId: 9, url: "chrome-extension://dbui/app.html#workflow/ch_daily" },
  ];
  await mount();
  await until(() => workflowNames().length > 0);
  const conn = [...host!.querySelectorAll<HTMLElement>("[role=option]")].find((o) => o.textContent?.includes("Orders prod"))!;
  await click(conn);
  await until(() => done === 1);
  expect(updateTab).toHaveBeenCalledWith(4, { active: true });

  await click(host!.querySelector("[aria-label='Recent workflows'] [role=listitem]")!);
  await until(() => done === 2);
  expect(updateTab).toHaveBeenCalledWith(5, { active: true });
  expect(createTab).not.toHaveBeenCalled();
});

test("All workflows opens the full list page, reusing an open one", async () => {
  await mount();
  await until(() => workflowNames().length > 0);
  await click(button("All workflows"));
  await until(() => done === 1);
  expect(createTab).toHaveBeenCalledWith({ url: "chrome-extension://dbui/app.html#workflows" });

  openTabs = [{ id: 3, windowId: 9, url: "chrome-extension://dbui/app.html#workflows" }];
  createTab.mockClear();
  await click(button("All workflows"));
  await until(() => done === 2);
  expect(updateTab).toHaveBeenCalledWith(3, { active: true });
  expect(createTab).not.toHaveBeenCalled();
});

test("with no workflows the section offers New or import", async () => {
  await setWorkflows([]);
  await mount();
  await until(() => !!button("New or import"));
  expect(workflowNames()).toEqual([]);
});

test("turning off the demo connection in Settings hides it from the popup", async () => {
  local.showDemo = false;
  await mount();
  expect(names()).toHaveLength(FIXTURE.length);
  expect(host!.textContent).not.toContain("Demo");
});

test("New connection shows the engine picker and form inside the popup and saves there", async () => {
  await mount();
  await click(button("New connection"));
  expect(host!.querySelector(".inline-sheet h3")?.textContent).toBe("New connection");
  expect(host!.querySelector(".modal")).toBeNull();
  const ch = [...host!.querySelectorAll<HTMLButtonElement>(".picker-grid .pick")].find((b) => b.textContent?.startsWith("ClickHouse"))!;
  await click(ch);
  await click(button("Create"));
  expect(host!.querySelector(".inline-sheet h3")?.textContent).toContain("New ClickHouse connection");
  const name = host!.querySelector<HTMLInputElement>("#f_name")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Logs");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  (globalThis as { chrome: { permissions?: unknown } }).chrome.permissions = { request: async () => true };
  await click(button("Save"));
  await until(() => names().includes("Logs"));
  expect(createTab).not.toHaveBeenCalled();
  expect(host!.querySelector(".pop-note")!.textContent).toBe("Saved Logs");
});

test("Edit opens the connection's form in the popup; the demo has no actions", async () => {
  await mount();
  expect(more("Demo database")).toBeNull();
  await click(more("Orders prod"));
  await click(button("Edit"));
  expect(host!.querySelector(".inline-sheet h3")?.textContent).toContain("Edit Orders prod");
  expect([...host!.querySelectorAll<HTMLInputElement>("input")].some((i) => i.value === "orders.db.internal")).toBe(true);
  await click(button("Cancel"));
  expect(names()).toContain("Orders prod");
  expect(createTab).not.toHaveBeenCalled();
});

test("Duplicate copies a remembered token and refresh token under the copy's own refs", async () => {
  store.set(REMEMBERED.connection.id, structuredClone(REMEMBERED.connection));
  Object.assign(local, REMEMBERED.storage);
  await mount();
  await click(more("BQ prod"));
  await click(button("Duplicate"));
  await until(() => names().includes("BQ prod copy"));

  const copy = [...store.values()].find((c) => c.name === "BQ prod copy")!;
  expect(copy.id).not.toBe("bq_prod");
  expect(copy.secretRef).toBe(`c_${copy.id}`);
  expect((copy.options.auth as { options: { refreshTokenRef: string } }).options.refreshTokenRef).toBe(`c_${copy.id}_refresh`);
  expect(local[`secret:c_${copy.id}`]).toBe("ya29.fixture-access-token");
  expect(local[`secret:c_${copy.id}_refresh`]).toBe("1//fixture-refresh-token");
  // The original keeps its own.
  expect(local["secret:c_bq_prod"]).toBe("ya29.fixture-access-token");
  expect(copy.options.projectId).toBe("acme-analytics");
  expect(host!.querySelector(".pop-note")!.textContent).toBe("Duplicated as BQ prod copy");
});

test("Duplicate of a session-only password says the copy will ask for it", async () => {
  await mount();
  await click(more("Orders prod"));
  await click(button("Duplicate"));
  await until(() => names().includes("Orders prod copy"));
  expect(host!.querySelector(".pop-note")!.textContent).toMatch(/will ask for it/);
});

test("Move to group and Delete work inside the popup", async () => {
  await mount();
  await click(more("Local postgres"));
  await click(button("Move to group"));
  const box = host!.querySelector<HTMLInputElement>("input[aria-label='Group name']")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, "Shop");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(button("Move"));
  await until(() => store.get("pg_local")!.group === "Shop");

  await click(more("Local postgres"));
  await click(button("Delete"));
  expect(store.has("pg_local")).toBe(true);
  expect(rowOf("Local postgres").parentElement!.textContent).toContain("Move Local postgres to the Trash?");
  await click(button("Delete"));
  await until(() => !store.has("pg_local") && !names().includes("Local postgres"));
  // It went to the Trash, not away: Restore brings back the same row.
  const { listTrash, restoreFromTrash } = await import("../../src/app/store/trash");
  const [t] = await listTrash();
  expect(t).toMatchObject({ kind: "connection", name: "Local postgres", where: "PostgreSQL" });
  await restoreFromTrash(t!.id, async (_s, row) => void store.set((row as SavedConnection).id, row as SavedConnection));
  expect(store.get("pg_local")!.name).toBe("Local postgres");
  expect(await listTrash()).toEqual([]);
});

test("Copy as lists the engine's formats and copies the chosen one", async () => {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
  await mount();
  await click(more("Orders prod"));
  await click(button("Copy as"));
  const labels = [...host!.querySelectorAll(".pop-mi.fmt span")].map((e) => e.textContent);
  expect(labels).toEqual(["Connection URL", "psql command", "JDBC URL", "Environment variables (PGHOST…)"]);
  await click([...host!.querySelectorAll(".pop-mi.fmt")].find((b) => b.querySelector("span")!.textContent === "psql command")!);
  await until(() => copied.length === 1);
  expect(copied[0]).toBe("psql postgresql://reader@orders.db.internal:5432/orders");
  expect(host!.querySelector(".pop-note")!.textContent).toBe("Copied psql command");
});
