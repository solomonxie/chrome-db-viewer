// Connection page tab strip against the demo driver: one tab per table, FK navigation in
// place, restore after remount, and the in-page confirm when closing a tab with edits.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { App } from "../../src/app/App";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

beforeEach(() => localStorage.clear());
afterEach(() => {
  unmount();
  location.hash = "";
});

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
}

async function render(hash = "#c_demo") {
  history.replaceState(null, "", "/app.html" + hash);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<App />));
  await until(() => !!host!.querySelector(".tree")?.textContent?.includes("orders"));
}

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
async function until(fn: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for UI: " + host?.textContent?.slice(0, 300));
    await wait(25);
  }
}

const tabLabels = () => [...host!.querySelectorAll(".wtab[role=tab] .wtab-label")].map((e) => e.textContent);
const activeLabel = () => host!.querySelector(".wtab[aria-selected=true] .wtab-label")?.textContent;
const node = (name: string) => [...host!.querySelectorAll<HTMLButtonElement>(".tree .node")].find((b) => b.querySelector(".nm")?.textContent === name)!;
async function click(el: Element) {
  await act(async () => (el as HTMLElement).click());
}
async function openTable(name: string) {
  await click(node(name));
  await until(() => activeLabel() === name);
}

test("clicking two tables gives two tabs, and clicking an open table switches to it", async () => {
  await render();
  await openTable("orders");
  await openTable("customers");
  expect(tabLabels()).toEqual(["orders", "customers"]);
  await click(node("orders"));
  expect(tabLabels()).toEqual(["orders", "customers"]);
  expect(activeLabel()).toBe("orders");
});

test("FK navigation stays within the tab and Back returns", async () => {
  await render();
  await openTable("orders");
  await until(() => host!.querySelectorAll(".vgrid .fk").length > 0);
  await click(host!.querySelector(".vgrid .fk")!);
  await until(() => activeLabel() === "customers");
  expect(tabLabels()).toEqual(["customers"]);
  await click(host!.querySelector("button[aria-label=Back]")!);
  expect(tabLabels()).toEqual(["orders"]);
});

test("close, close others from the menu, and new query tab", async () => {
  await render();
  await openTable("orders");
  await openTable("customers");
  await openTable("order_items");
  await click(host!.querySelector("button[aria-label='New query tab'].wtab-new")!);
  expect(tabLabels()).toEqual(["orders", "customers", "order_items", "Query"]);

  await click(host!.querySelector("button[aria-label='Close order_items']")!);
  expect(tabLabels()).toEqual(["orders", "customers", "Query"]);

  const customers = [...host!.querySelectorAll(".wtab[role=tab]")].find((t) => t.textContent?.includes("customers"))!;
  await act(async () => customers.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })));
  const item = [...host!.querySelectorAll<HTMLButtonElement>(".menu button")].find((b) => b.textContent === "Close others")!;
  await click(item);
  expect(tabLabels()).toEqual(["customers"]);
  expect(activeLabel()).toBe("customers");
});

test("open tabs come back after a remount", async () => {
  await render();
  await openTable("orders");
  await openTable("customers");
  await click(host!.querySelector("button.wtab-new")!);
  await click([...host!.querySelectorAll(".wtab[role=tab]")].find((t) => t.textContent?.includes("orders"))!);
  unmount();

  await render();
  expect(tabLabels()).toEqual(["orders", "customers", "Query"]);
  expect(activeLabel()).toBe("orders");
});

test("closing a tab with pending edits asks first in the page", async () => {
  await render();
  await openTable("customers");
  await until(() => host!.querySelectorAll(".vgrid .r").length > 0);
  // Ctrl/⌘+I adds a row to the active grid.
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", code: "KeyI", ctrlKey: true, metaKey: true, bubbles: true })));
  await until(() => !!host!.querySelector(".wtab .pdot"));

  await click(host!.querySelector("button[aria-label='Close customers']")!);
  expect(host!.querySelector(".modal")?.textContent).toContain("pending change");
  expect(tabLabels()).toEqual(["customers"]);
  await click([...host!.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Cancel")!);
  expect(tabLabels()).toEqual(["customers"]);

  await click(host!.querySelector("button[aria-label='Close customers']")!);
  await click([...host!.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Discard and close")!);
  expect(tabLabels()).toEqual([]);
  expect(host!.textContent).not.toMatch(/pending change/);
});

test("the Details pane starts hidden and remembers being turned on", async () => {
  await render();
  const toggle = () => host!.querySelector<HTMLButtonElement>("button[aria-label='Toggle Details pane']")!;
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  await click(toggle());
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
  unmount();
  await render();
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
});
