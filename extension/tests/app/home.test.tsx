// Home's connection dropdown and the connection page's switcher. Saved connections come from
// tests/fixtures/app/connections.json, served by an in-memory stand-in for the IndexedDB
// store (jsdom has no IndexedDB). Opening a connection must create a new browser tab.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { SavedConnection } from "../../src/app/store/db";

const FIXTURE: SavedConnection[] = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/app/connections.json"), "utf8"),
);
const store = new Map<string, SavedConnection>();

vi.mock("../../src/app/store/db", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/app/store/db")>();
  return {
    ...orig,
    getAll: async (name: string) =>
      name === "connections" ? [...store.values()] : [],
    get: async (name: string, id: string) =>
      name === "connections" ? store.get(id) : undefined,
    put: async (name: string, row: SavedConnection) => {
      if (name === "connections") store.set(row.id, row);
    },
    del: async (name: string, id: string) => {
      if (name === "connections") store.delete(id);
    },
  };
});

const { App } = await import("../../src/app/App");
const { ConnectionPicker } =
  await import("../../src/app/components/ConnectionPicker");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const createTab = vi.fn(async (_: { url: string }) => ({}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  localStorage.clear();
  store.clear();
  for (const c of FIXTURE) store.set(c.id, structuredClone(c));
  createTab.mockClear();
  (globalThis as { chrome?: unknown }).chrome = {
    tabs: { create: createTab },
    runtime: { getURL: (p: string) => `chrome-extension://dbui/${p}` },
  };
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  location.hash = "";
  delete (globalThis as { chrome?: unknown }).chrome;
});

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
async function until(fn: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout)
      throw new Error(
        "timed out waiting for UI: " + host?.textContent?.slice(0, 300),
      );
    await wait(20);
  }
}

async function mount(node: React.ReactNode, hash = "#home") {
  history.replaceState(null, "", "/app.html" + hash);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
}

const combo = (label = "Connection") =>
  host!.querySelector<HTMLInputElement>(
    `input[role=combobox][aria-label='${label}']`,
  )!;
const options = () => [...host!.querySelectorAll<HTMLElement>("[role=option]")];
const activeName = () =>
  document
    .getElementById(combo().getAttribute("aria-activedescendant") ?? "")
    ?.querySelector(".cpick-name")?.textContent;
const button = (text: string) =>
  [...host!.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === text,
  )!;

async function key(el: HTMLElement, k: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
}
async function type(el: HTMLInputElement, text: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(el: Element) {
  await act(async () => (el as HTMLElement).click());
}

async function home() {
  await mount(<App />);
  await until(() => combo()?.value === "Orders prod");
}

test("the picker filters as you type and selects with the arrow keys and Enter", async () => {
  const opened: string[] = [];
  const selected: string[] = [];
  await mount(
    <ConnectionPicker
      connections={FIXTURE}
      selectedId={null}
      onSelect={(c) => selected.push(c.id)}
      onOpen={(c) => opened.push(c.id)}
    />,
  );
  const box = combo();
  expect(box.getAttribute("aria-expanded")).toBe("false");

  await key(box, "ArrowDown");
  expect(box.getAttribute("aria-expanded")).toBe("true");
  expect(
    host!
      .querySelector(`#${box.getAttribute("aria-controls")}`)
      ?.getAttribute("role"),
  ).toBe("listbox");
  // Ungrouped first, then the "Shop" group, each by last use.
  expect(
    options().map((o) => o.querySelector(".cpick-name")?.textContent),
  ).toEqual(["Local postgres", "Orders prod", "Events warehouse"]);

  await type(box, "shop");
  expect(
    options().map((o) => o.querySelector(".cpick-name")?.textContent),
  ).toEqual(["Orders prod", "Events warehouse"]);
  expect(activeName()).toBe("Orders prod");
  await key(box, "ArrowDown");
  expect(activeName()).toBe("Events warehouse");
  await key(box, "ArrowDown");
  expect(activeName()).toBe("Events warehouse");
  await key(box, "ArrowUp");
  expect(activeName()).toBe("Orders prod");

  await key(box, "Enter");
  expect(selected).toEqual(["pg_orders"]);
  expect(opened).toEqual(["pg_orders"]);
  expect(box.getAttribute("aria-expanded")).toBe("false");

  await type(box, "nothing like this");
  expect(options()).toHaveLength(0);
  expect(host!.textContent).toContain("No connection matches");
  await key(box, "Escape");
  expect(box.getAttribute("aria-expanded")).toBe("false");
});

test("clicking outside closes the dropdown", async () => {
  await mount(
    <ConnectionPicker
      connections={FIXTURE}
      selectedId="pg_local"
      onOpen={() => {}}
    />,
  );
  await key(combo(), "ArrowDown");
  expect(options().length).toBe(3);
  await act(async () =>
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
  );
  expect(options().length).toBe(0);
});

test("Connect opens the selected connection in a new tab and Home stays on #home", async () => {
  await home();
  await click(button("Connect"));
  expect(createTab).toHaveBeenCalledTimes(1);
  expect(createTab.mock.calls[0]![0]).toEqual({
    url: "chrome-extension://dbui/app.html#c_pg_orders",
  });
  expect(location.hash).toBe("#home");
  expect(combo()).not.toBeNull();
});

test("opening the same connection twice creates two tabs", async () => {
  await home();
  await click(button("Connect"));
  await key(combo(), "Enter");
  expect(createTab.mock.calls.map((c) => c[0].url)).toEqual([
    "chrome-extension://dbui/app.html#c_pg_orders",
    "chrome-extension://dbui/app.html#c_pg_orders",
  ]);
  expect(location.hash).toBe("#home");
});

test("double-clicking an option opens it in a new tab", async () => {
  await home();
  await key(combo(), "ArrowDown");
  const opt = options().find((o) => o.dataset.id === "ch_events")!;
  await act(async () =>
    opt.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  expect(createTab.mock.calls.at(-1)![0].url).toBe(
    "chrome-extension://dbui/app.html#c_ch_events",
  );
});

test("Edit opens the selected connection's form", async () => {
  await home();
  await key(combo(), "ArrowDown");
  await click(options().find((o) => o.dataset.id === "pg_local")!);
  expect(combo().value).toBe("Local postgres");
  expect(createTab).not.toHaveBeenCalled();
  await click(button("Edit"));
  const dialog = host!.querySelector(".modal")!;
  expect(dialog.textContent).toContain("Edit Local postgres");
  expect(
    [...dialog.querySelectorAll<HTMLInputElement>("input")].some(
      (i) => i.value === "localhost",
    ),
  ).toBe(true);
});

test("Delete asks for confirmation before removing the connection", async () => {
  await home();
  await click(
    host!.querySelector("button[aria-label='More connection actions']")!,
  );
  const del = [
    ...host!.querySelectorAll<HTMLButtonElement>("[role=menuitem]"),
  ].find((b) => b.textContent === "Delete…")!;
  expect(
    [...host!.querySelectorAll("[role=menuitem]")].map((b) => b.textContent),
  ).toContain("Duplicate");
  await click(del);
  expect(host!.querySelector(".modal")?.textContent).toContain(
    "Delete Orders prod?",
  );
  expect(store.has("pg_orders")).toBe(true);

  await click(button("Cancel"));
  expect(store.has("pg_orders")).toBe(true);

  await click(
    host!.querySelector("button[aria-label='More connection actions']")!,
  );
  await click(
    [...host!.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find(
      (b) => b.textContent === "Delete…",
    )!,
  );
  await click(button("Delete"));
  await until(() => !store.has("pg_orders") && combo().value !== "Orders prod");
});

test("the top-bar switcher opens the chosen connection in a new tab", async () => {
  await mount(<App />, "#c_demo");
  await until(
    () => !!host!.querySelector(".tree")?.textContent?.includes("orders"),
  );
  const box = combo("Switch connection");
  await until(() => {
    return box.value === "Demo database";
  });
  await key(box, "ArrowDown");
  await until(() => options().some((o) => o.dataset.id === "pg_local"));
  expect(options().map((o) => o.textContent)).toEqual(
    expect.arrayContaining(["New connection…", "Manage connections…"]),
  );
  await click(options().find((o) => o.dataset.id === "pg_local")!);
  expect(createTab).toHaveBeenCalledWith({
    url: "chrome-extension://dbui/app.html#c_pg_local",
  });
  expect(location.hash).toBe("#c_demo");
});
