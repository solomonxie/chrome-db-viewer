// jsdom: open the demo connection, create a collection and a named query, set a variable,
// and watch the Rendered SQL update. IndexedDB is absent in jsdom, so the store keeps rows in memory.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
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

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
  location.hash = "";
});

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
async function until(fn: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for UI: " + host?.textContent?.slice(0, 400));
    await wait(25);
  }
}
const $ = <T extends Element>(sel: string) => host!.querySelector<T>(sel);
const byText = (sel: string, text: string) => [...host!.querySelectorAll<HTMLElement>(sel)].find((b) => b.textContent?.trim() === text);

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

test("create a collection and query, set a variable, and the Rendered SQL updates", async () => {
  const answers = ["Ad performance", "orders_by_status"];
  vi.spyOn(window, "prompt").mockImplementation(() => answers.shift() ?? null);

  history.replaceState(null, "", "/app.html#c_demo");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<App />));
  await until(() => !!$(".tree")?.textContent?.includes("orders"));

  await act(async () => byText(".psec-head", "Collections")!.click());
  await act(async () => byText(".empty .btn", "New collection")!.click());
  await until(() => !!byText(".coll-head .nm", "Ad performance"));

  // New query from the collection's row menu; it opens in a query tab bound to it.
  await act(async () => $<HTMLElement>(".coll-head .rowmenu")!.click());
  await act(async () => byText(".menu button", "New query…")!.click());
  await until(() => !!$("textarea[aria-label='Template editor']"));
  expect(byText(".coll-query .nm", "orders_by_status")).toBeDefined();

  const editor = $<HTMLTextAreaElement>("textarea[aria-label='Template editor']")!;
  await act(async () => type(editor, "SELECT * FROM {{ table | ident }} WHERE status = {{ status | sql }} LIMIT {{ var('limit', 5) }}"));
  await until(() => !!$("input[aria-label='status']"));
  // Required variables without a value block Run.
  expect(byText(".nq-param-list .mono", "table")).toBeDefined();
  expect(host!.querySelector<HTMLButtonElement>(".edbar .btn.primary")!.disabled).toBe(true);
  expect($(".nq-missing")!.textContent).toContain("table, status");

  await act(async () => byText(".nq-tabs button", "Rendered")!.click());
  expect($(".nq-rendered .err")!.textContent).toMatch(/table/);

  await act(async () => {
    const t = $<HTMLInputElement>("input[aria-label='table']")!;
    type(t, "orders");
    t.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  await act(async () => {
    const s = $<HTMLInputElement>("input[aria-label='status']")!;
    type(s, "paid");
    s.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  await until(() => !!$(".nq-rendered-sql"));
  expect($(".nq-rendered-sql")!.textContent).toBe(`SELECT * FROM "orders" WHERE status = 'paid' LIMIT 5`);

  // Change a variable: the rendered SQL follows.
  await act(async () => {
    const s = $<HTMLInputElement>("input[aria-label='status']")!;
    type(s, "refunded");
    s.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  await until(() => $(".nq-rendered-sql")?.textContent?.includes("'refunded'") ?? false);

  // Run sends the rendered SQL to the demo driver.
  const run = host!.querySelector<HTMLButtonElement>(".edbar .btn.primary")!;
  expect(run.disabled).toBe(false);
  await act(async () => run.click());
  await until(() => host!.querySelectorAll(".vgrid .r").length > 0 || !!$(".center .err"));
  expect($(".center .err")).toBeNull();
});
