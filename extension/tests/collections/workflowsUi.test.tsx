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
import { listChainRows, listCollections, loadBundle, putChainRow, saveCollection, saveQuery } from "../../src/collections/store";

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

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

test("left pane sections are Schema, Collections, Workflows and History, one open at a time", async () => {
  await openConnection();
  expect(all(".psec-head").map((b) => b.textContent?.trim())).toEqual(["Schema", "Collections", "Workflows", "History"]);
  const expanded = () => all(".psec-head").filter((b) => b.getAttribute("aria-expanded") === "true").map((b) => b.textContent?.trim());
  expect(expanded()).toEqual(["Schema"]);
  await click(byText(".psec-head", "Collections"));
  expect(expanded()).toEqual(["Collections"]);
  expect(all(".psec-body").length).toBe(1);
  await click(byText(".psec-head", "Collections"));
  expect(expanded()).toEqual([]);
  expect(all(".psec-body").length).toBe(0);
});

test("the Workflows tab lists every workflow, tagged with the collections its named queries come from", async () => {
  await openConnection();
  await click(byText(".psec-head", "Workflows"));
  await until(() => all(".wf-item").length >= 2);
  const daily = all<HTMLElement>(".wf-item").find((r) => r.textContent?.includes("Daily ad report"))!;
  expect(daily.textContent).toContain("3 steps");
  expect(daily.textContent).toContain("failed");
  expect([...daily.querySelectorAll(".wf-tag")].map((t) => t.textContent)).toEqual(["Ad performance", "Finance"]);
  const close = all<HTMLElement>(".wf-item").find((r) => r.textContent?.includes("Month close"))!;
  expect(close.textContent).toContain("1 step");
  expect(close.textContent).toContain("not run yet");

  // The filter narrows the list.
  await act(async () => type($<HTMLInputElement>("input[aria-label='Filter workflows']")!, "month"));
  expect(all(".wf-item").map((r) => r.querySelector(".wf-name")!.textContent)).toEqual(["Month close"]);

  // Collections show only collections, folders and queries.
  await click(byText(".psec-head", "Collections"));
  await until(() => !!byText(".coll-head .nm", "Ad performance"));
  expect($(".tree")!.textContent).not.toMatch(/workflow|Daily ad report/i);
  expect(visibleText()).not.toMatch(/chain/i);
});

test("New workflow asks only for a name and opens the workflow at #workflow/<id>", async () => {
  const opened: string[] = [];
  vi.spyOn(window, "open").mockImplementation((url) => {
    opened.push(String(url));
    return null;
  });
  await openConnection();
  await click(byText(".psec-head", "Workflows"));
  await click($("button[aria-label='Add workflow']"));
  expect(all(".menu [role=menuitem]").map((b) => b.firstChild?.textContent)).toEqual(["New workflow", "Import from file…"]);
  await click(all(".menu [role=menuitem]")[0]);
  await until(() => !!$(".modal input[aria-label='Workflow name']"));
  expect($(".modal select")).toBeNull();
  expect(visibleText()).not.toMatch(/chain/i);
  await act(async () => type($<HTMLInputElement>(".modal input[aria-label='Workflow name']")!, "Weekly close"));
  await click(byText(".modal .btn", "Create"));
  await until(() => opened.length === 1);

  const created = (await listChainRows()).find((c) => c.name === "Weekly close")!;
  expect(created.collectionId).toBeUndefined();
  expect(opened[0]).toMatch(new RegExp(`#workflow/${created.id}$`));
});

test("the workflow view has no collection, and its query steps can pick named queries from every collection", async () => {
  await mount(<App />, "#workflow/ch_daily");
  await until(() => !!$("input[aria-label='Workflow name']"));
  await until(() => all(".chain-step").length === 3);
  expect($(".chain-top .wf-label")!.textContent).toBe("Workflow");
  expect($(".wf-home")).toBeNull();
  expect($("select[aria-label='Change collection']")).toBeNull();
  const pick = all<HTMLSelectElement>(".chain-step select")[0]!;
  await until(() => [...pick.options].length > 2);
  expect([...pick.options].map((o) => o.textContent)).toEqual(expect.arrayContaining(["Ad performance/top_ads", "Finance/revenue"]));
  // Workflow variables are always shown above the steps; there is no Variables toggle.
  expect(visibleText()).toContain("Workflow variables");
  expect(byText(".chain-top .btn", "Variables")).toBeUndefined();
  expect(visibleText()).not.toMatch(/chain/i);
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

test("Set variables shows each simple assignment as Take / column / from step pickers and how to use it", async () => {
  const chain = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/chains/set_vars_lookup.json"), "utf8"));
  await putChainRow(chain);
  await mount(<App />, "#workflow/ch_vars");
  await until(() => all(".cs-var").length === 6);
  const rows = all<HTMLElement>(".cs-var");
  const take = (r: HTMLElement) => r.querySelector<HTMLSelectElement>("select[aria-label='Take']")!.value;
  expect(rows.map(take)).toEqual(["column", "first", "max", "count", "__expr", "__expr"]);
  expect(rows[0]!.querySelector<HTMLSelectElement>("select[aria-label='Step']")!.value).toBe("top_ads");
  expect(rows[0]!.textContent).toContain("{{ top_ad_ids | sql_list }}");
  expect(rows[1]!.textContent).toContain("{{ best | sql }}");
  expect(rows[4]!.querySelector<HTMLInputElement>("input[aria-label='Expression']")!.value).toBe('"top " + n');
  expect(all(".chain-add .btn").map((b) => b.textContent?.trim())).toEqual(["Query", "Transform: DuckDB", "Transform: JavaScript", "Set variables", "Export", "Assert"]);
});

async function importFile(name: string) {
  const text = readFileSync(resolve(__dirname, "../fixtures/workflows", name), "utf8");
  const real = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string, o?: ElementCreationOptions) => {
    const el = real(tag, o);
    if (tag === "input") {
      el.click = () => {
        Object.defineProperty(el, "files", { value: [new File([text], name, { type: "application/json" })] });
        (el as HTMLInputElement).onchange?.(new Event("change"));
      };
    }
    return el;
  });
  await click($("button[aria-label='Add workflow']"));
  await click(all(".menu [role=menuitem]").find((b) => b.textContent?.startsWith("Import from file")));
  vi.mocked(document.createElement).mockRestore();
}

test("importing a file with the name of an existing workflow asks before replacing it", async () => {
  vi.spyOn(window, "open").mockImplementation(() => null);
  await openConnection();
  await click(byText(".psec-head", "Workflows"));
  await until(() => all(".wf-item").length >= 2);
  const before = (await listChainRows()).find((c) => c.name === "Month close")!;
  await importFile("import_compare.dbui-workflow.json");
  await until(() => !!$(".modal .wf-imp-warn"));
  expect($(".modal h3")!.textContent).toBe('Import workflow "Month close"');
  expect(all(".wf-imp-steps li").map((l) => l.querySelector(".mono")!.textContent)).toEqual(["bq", "pg", "diff", "has_rows"]);
  expect(all<HTMLSelectElement>(".wf-imp-conn select").map((s) => s.getAttribute("aria-label"))).toEqual(["Connection for warehouse", "Connection for app"]);

  // Replace asks first; Back returns without touching the workflow.
  await click(byText(".modal .btn", "Replace existing…"));
  expect($(".modal h3")!.textContent).toBe('Replace "Month close"?');
  await click(byText(".modal .btn", "Back"));
  expect((await listChainRows()).find((c) => c.id === before.id)!.steps.length).toBe(before.steps.length);

  await click(byText(".modal .btn", "Replace existing…"));
  await click(byText(".modal .btn", "Replace"));
  await until(() => !$(".modal"));
  const rows = (await listChainRows()).filter((c) => c.name.startsWith("Month close"));
  expect(rows.map((c) => c.id)).toEqual([before.id]);
  expect(rows[0]!.steps.map((s) => s.name)).toEqual(["bq", "pg", "diff", "has_rows"]);
  // Put the fixture workflow back for the other tests.
  await putChainRow(before);
});

test("Keep both imports the file under a new name", async () => {
  vi.spyOn(window, "open").mockImplementation(() => null);
  await openConnection();
  await click(byText(".psec-head", "Workflows"));
  await until(() => all(".wf-item").length >= 2);
  await importFile("import_compare.dbui-workflow.json");
  await until(() => !!byText(".modal .btn", "Keep both"));
  await click(byText(".modal .btn", "Keep both"));
  await until(() => !$(".modal"));
  const names = (await listChainRows()).map((c) => c.name);
  expect(names).toEqual(expect.arrayContaining(["Month close", "Month close 2"]));
});
