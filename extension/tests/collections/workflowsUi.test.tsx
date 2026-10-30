// jsdom: the Workflows tab, New workflow with a collection pick, the workflow view, saving a
// History query into a new default collection, and ⌘S in an unbound query tab. IndexedDB is
// absent in jsdom, so the collections store keeps rows in memory.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { App } from "../../src/app/App";
import { SaveAsNamedQuery } from "../../src/app/collections/SaveAsNamedQuery";
import { ToastProvider } from "../../src/app/components/ui";
import type { Chain, Collection, NamedQuery } from "../../src/collections/model";
import { getChainRow, listChainRows, listCollections, loadBundle, putChainRow, saveCollection, saveQuery } from "../../src/collections/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  const lib = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/workflows/library.json"), "utf8")) as { collections: Collection[]; queries: NamedQuery[]; chains: Chain[] };
  for (const c of lib.collections) await saveCollection(c);
  for (const q of lib.queries) await saveQuery(q);
  for (const ch of lib.chains) await putChainRow(ch);
});

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => localStorage.clear());
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
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
const all = <T extends Element>(sel: string) => [...host!.querySelectorAll<T>(sel)];
const byText = (sel: string, text: string) => all<HTMLElement>(sel).find((b) => b.textContent?.trim() === text);
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());

async function mount(node: React.ReactNode, hash?: string) {
  if (hash) history.replaceState(null, "", "/app.html" + hash);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
}
async function openConnection() {
  await mount(<App />, "#c_demo");
  await until(() => !!$(".tree")?.textContent?.includes("orders"));
}

/** Everything a user can read: text, plus labels, titles, placeholders and input values. */
function visibleText(): string {
  const attrs = all<HTMLElement>("[aria-label], [title], [placeholder], input, option").flatMap((el) => [
    el.getAttribute("aria-label") ?? "",
    el.getAttribute("title") ?? "",
    el.getAttribute("placeholder") ?? "",
    (el as HTMLInputElement).value ?? "",
  ]);
  return [host!.textContent ?? "", ...attrs, document.title].join(" ");
}

function select(el: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

test("left pane tabs are Items, Collections, Workflows and History", async () => {
  await openConnection();
  expect(all(".ptabs button").map((b) => b.textContent?.trim())).toEqual(["Items", "Collections", "Workflows", "History"]);
});

test("the Workflows tab lists workflows across collections with their collection tags", async () => {
  await openConnection();
  await click(byText(".ptabs button", "Workflows"));
  await until(() => all(".wf-item").length >= 2);
  const daily = all<HTMLElement>(".wf-item").find((r) => r.textContent?.includes("Daily ad report"))!;
  expect(daily.textContent).toContain("3 steps");
  expect(daily.textContent).toContain("failed");
  expect([...daily.querySelectorAll(".wf-tag")].map((t) => t.textContent)).toEqual(["Ad performance", "Finance"]);
  expect(daily.querySelector(".wf-tag.home")!.textContent).toBe("Ad performance");
  const close = all<HTMLElement>(".wf-item").find((r) => r.textContent?.includes("Month close"))!;
  expect(close.textContent).toContain("1 step");
  expect(close.textContent).toContain("not run yet");

  // The filter narrows the list.
  await act(async () => type($<HTMLInputElement>("input[aria-label='Filter workflows']")!, "month"));
  expect(all(".wf-item").map((r) => r.querySelector(".wf-name")!.textContent)).toEqual(["Month close"]);

  // Collections show only collections, folders and queries.
  await click(byText(".ptabs button", "Collections"));
  await until(() => !!byText(".coll-head .nm", "Ad performance"));
  expect($(".tree")!.textContent).not.toMatch(/workflow|Daily ad report/i);
  expect(visibleText()).not.toMatch(/chain/i);
});

test("New workflow lets you pick the collection and opens the workflow at #workflow/<id>", async () => {
  const opened: string[] = [];
  vi.spyOn(window, "open").mockImplementation((url) => {
    opened.push(String(url));
    return null;
  });
  await openConnection();
  await click(byText(".ptabs button", "Workflows"));
  await click($("button[aria-label='New workflow']"));
  await until(() => !!$(".modal select[aria-label='Collection']"));
  expect(visibleText()).not.toMatch(/chain/i);
  await act(async () => type($<HTMLInputElement>(".modal input[aria-label='Workflow name']")!, "Weekly close"));
  const pick = $<HTMLSelectElement>(".modal select[aria-label='Collection']")!;
  const fin = [...pick.options].find((o) => o.textContent === "Finance")!;
  await act(async () => select(pick, fin.value));
  await click(byText(".modal .btn", "Create"));
  await until(() => opened.length === 1);

  const created = (await listChainRows()).find((c) => c.name === "Weekly close")!;
  expect(created.collectionId).toBe("col_fin");
  expect(opened[0]).toMatch(new RegExp(`#workflow/${created.id}$`));
});

test("the workflow view says Workflow, links to its collection, and can change it", async () => {
  await mount(
    <App />,
    "#workflow/ch_daily",
  );
  await until(() => !!$("input[aria-label='Workflow name']") && !!$(".wf-home .wf-tag.home"));
  await until(() => all(".chain-step").length === 3);
  expect($(".chain-top .wf-label")!.textContent).toBe("Workflow");
  expect($(".wf-home .wf-tag.home")!.textContent).toBe("Ad performance");
  await click(byText(".btn", "Variables"));
  expect(visibleText()).not.toMatch(/chain/i);

  const change = $<HTMLSelectElement>("select[aria-label='Change collection']")!;
  await act(async () => select(change, "col_fin"));
  await until(() => $(".wf-home .wf-tag.home")?.textContent === "Finance");
  await wait(500);
  expect((await getChainRow("ch_daily"))!.collectionId).toBe("col_fin");
});

test("the old #chain/<id> link opens the same workflow", async () => {
  await mount(<App />, "#chain/ch_close");
  await until(() => $<HTMLInputElement>("input[aria-label='Workflow name']")?.value === "Month close");
  expect(visibleText()).not.toMatch(/chain/i);
});

test("saving a History query with no collection picked makes a Saved queries collection", async () => {
  const saved: NamedQuery[] = [];
  await mount(
    <ToastProvider>
      <SaveAsNamedQuery sql="SELECT * FROM orders WHERE status = 'paid'" dialect="postgres" connectionId="demo" onClose={() => {}} onSaved={(q) => saved.push(q)} />
    </ToastProvider>,
  );
  await until(() => $<HTMLSelectElement>("select[aria-label='Collection']")?.value === "__saved__");
  expect($<HTMLInputElement>("input[aria-label='Query name']")!.value).toMatch(/^orders \d{4}-\d{2}-\d{2}$/);
  // Variables are optional and collapsed.
  expect($<HTMLDetailsElement>("details.save-reusable")!.open).toBe(false);
  await click(byText(".modal .btn", "Save"));
  await until(() => saved.length === 1);

  const col = (await listCollections()).find((c) => c.name === "Saved queries")!;
  expect(saved[0]).toMatchObject({ collectionId: col.id, sql: "SELECT * FROM orders WHERE status = 'paid'", connectionId: "demo", vars: [] });
});

test("⌘S in an unbound query tab saves into a collection and binds the tab", async () => {
  await openConnection();
  await click($("button.wtab-new"));
  const editor = await (async () => {
    await until(() => !!$("textarea[aria-label='SQL editor']"));
    return $<HTMLTextAreaElement>("textarea[aria-label='SQL editor']")!;
  })();
  await act(async () => type(editor, "SELECT * FROM customers"));
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, metaKey: true, bubbles: true })));
  await until(() => !!$(".modal input[aria-label='Query name']"));
  await act(async () => type($<HTMLInputElement>(".modal input[aria-label='Query name']")!, "all_customers"));
  await click(byText(".modal .btn", "Save"));
  // The tab is now bound: the template editor and the Parameters panel replace the plain editor.
  await until(() => !!$("textarea[aria-label='Template editor']"));
  expect($(".wtab[aria-selected=true] .wtab-label")!.textContent).toBe("all_customers");
  const col = (await listCollections()).find((c) => c.name === "Saved queries")!;
  const b = (await loadBundle(col.id))!;
  expect(b.queries.find((q) => q.name === "all_customers")).toMatchObject({ sql: "SELECT * FROM customers", connectionId: "demo" });
});

test("Run all in a query tab shows one result tab per statement and stops at the failing one", async () => {
  await openConnection();
  await click($("button.wtab-new"));
  await until(() => !!$("textarea[aria-label='SQL editor']"));
  await act(async () => type($<HTMLTextAreaElement>("textarea[aria-label='SQL editor']")!, "SELECT * FROM orders;\nSELECT * FROM customers;\nSELECT FROM;\nSELECT * FROM order_items"));
  await click(byText(".edbar .btn", "Run all ⌘⇧↵") ?? all<HTMLElement>(".edbar .btn").find((b) => b.textContent?.startsWith("Run all")));
  await until(() => all(".stmt-tab").length === 4 && !!$(".stmt-tab.failed"));
  const tabs = all<HTMLButtonElement>(".stmt-tab");
  expect(tabs.map((t) => t.textContent)).toEqual(["Result 1", "Result 2", "Result 3 ✗", "Result 4"]);
  expect(tabs[3]!.disabled).toBe(true);
  expect(tabs[0]!.title).toBe("SELECT * FROM orders");
  // The failed statement is shown, with its number.
  expect($(".center .err")!.textContent).toMatch(/^Statement 3 failed/);
  await click(tabs[1]);
  await until(() => all(".vgrid .r").length > 0);
  expect($(".center .err")).toBeNull();
});
