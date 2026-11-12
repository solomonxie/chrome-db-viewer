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
import { deleteChainRow, listChainRows, listCollections, loadBundle, putChainRow, saveCollection, saveQuery } from "../../src/collections/store";

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

test("the #workflows page lists every workflow and has New workflow and Import from file", async () => {
  const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
  await mount(<App />, "#workflows");
  await until(() => all(".wf-item").length >= 2);
  expect(document.title).toBe("Workflows");
  expect($("h1")!.textContent).toBe("Workflows");
  expect(all(".wf-name").map((n) => n.textContent)).toEqual(expect.arrayContaining(["Daily ad report", "Month close"]));

  // + offers New workflow and Import from file…
  await click($("button[aria-label='Add workflow']"));
  expect(all(".menu [role=menuitem]").map((b) => b.textContent)).toEqual(["New workflow", expect.stringMatching(/^Import from file…/)]);
  await click(byText(".menu [role=menuitem]", "New workflow"));
  await until(() => !!$(".modal input[aria-label='Workflow name']"));
  await act(async () => type($<HTMLInputElement>(".modal input[aria-label='Workflow name']")!, "From the page"));
  await click(byText(".modal .btn", "Create"));
  await until(() => openSpy.mock.calls.length === 1);
  const created = (await listChainRows()).find((c) => c.name === "From the page")!;
  expect(String(openSpy.mock.calls[0]![0])).toContain(`#workflow/${created.id}`);
  // The page stays on the list.
  expect(location.hash).toBe("#workflows");

  await importFile("import_compare.dbui-workflow.json");
  await until(() => !!byText(".modal .btn", "Import"));
  await click(byText(".modal .btn", "Import"));
  await until(() => !$(".modal"));
  const imported = (await listChainRows()).find((c) => /^Month close \(\d\)$/.test(c.name))!;
  await until(() => all(".wf-name").some((n) => n.textContent === imported.name));
  // Later tests count on the fixture library as it was.
  await deleteChainRow(imported.id);
  await deleteChainRow(created.id);
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
  await until(() => !!$("select[aria-label='Saved query']"));
  const pick = $<HTMLSelectElement>("select[aria-label='Saved query']")!;
  expect(pick.options[0]!.textContent).toBe("None: SQL written below");
  expect([...pick.options].map((o) => o.textContent)).toEqual(expect.arrayContaining(["Ad performance/top_ads", "Finance/revenue"]));
  // Inputs are Set variables steps; there is no separate Workflow variables panel.
  expect(visibleText()).not.toContain("Workflow variables");
  expect(byText(".chain-top .btn", "Variables")).toBeUndefined();
  // No side panel: a step's result, SQL and log go in its own card once it has run.
  expect($(".chain-detail")).toBeNull();
  expect($(".cs-out-panel")).toBeNull();
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

test("Set variables is one SET box: it shows each assignment as a line and saves what you type", async () => {
  const chain = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/chains/set_vars_lookup.json"), "utf8"));
  await putChainRow(chain);
  await mount(<App />, "#workflow/ch_vars");
  await until(() => !!$("textarea[aria-label='Set variables']"));
  const box = $<HTMLTextAreaElement>("textarea[aria-label='Set variables']")!;
  expect(box.value.split("\n")).toEqual([
    'SET top_ad_ids = column("top_ads", "ad_hash")',
    'SET best = first("top_ads", "ad_hash")',
    'SET max_rev = max("top_ads", "revenue")',
    'SET n = count("top_ads")',
    'SET label = "top " + n',
    'SET fixed = {"k": [1, 2]}',
  ]);
  // A mistake is shown and not saved; fixing it saves.
  await act(async () => type(box, box.value + "\nSET broken ="));
  expect($(".cs-set .err-text")!.textContent).toBe("Line 7: broken has no value after =. Not saved until it's fixed.");
  await act(async () => type(box, box.value.replace("SET broken =", 'SET since = (SELECT max(day) FROM {{ ref("top_ads") }})')));
  expect($(".cs-set .err-text")).toBeNull();
  await wait(700);
  const saved = (await listChainRows()).find((c) => c.id === "ch_vars")!;
  expect(saved.steps[1]!.assignments!.since).toBe('(SELECT max(day) FROM {{ ref("top_ads") }})');
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

test("importing a file with the name of an existing workflow never replaces it: the import is named (2), then (3)", async () => {
  const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
  await openConnection();
  await click(byText(".psec-head", "Workflows"));
  await until(() => all(".wf-item").length >= 2);
  const before = (await listChainRows()).find((c) => c.name === "Month close")!;
  await importFile("import_compare.dbui-workflow.json");
  await until(() => !!$(".modal .wf-imp-warn"));
  expect($(".modal h3")!.textContent).toBe('Import workflow "Month close"');
  // The file's description is folded to a few lines.
  expect($(".modal .wf-imp-desc")?.classList.contains("folded") ?? true).toBe(true);
  expect($(".modal .wf-imp-warn")!.textContent).toContain("imported as Month close (2)");
  expect(all(".wf-imp-steps li").map((l) => l.querySelector(".mono")!.textContent)).toEqual(["bq", "pg", "diff", "has_rows"]);
  expect(all<HTMLSelectElement>(".wf-imp-conn select").map((s) => s.getAttribute("aria-label"))).toEqual(["Connection for warehouse", "Connection for app"]);
  expect(all(".modal .btn").map((b) => b.textContent?.trim())).toEqual(["Cancel", "Import"]);
  await click(byText(".modal .btn", "Import"));
  await until(() => !$(".modal"));

  await importFile("import_compare.dbui-workflow.json");
  await until(() => !!byText(".modal .btn", "Import"));
  expect($(".modal .wf-imp-warn")!.textContent).toContain("imported as Month close (3)");
  await click(byText(".modal .btn", "Import"));
  await until(() => !$(".modal"));

  const rows = await listChainRows();
  expect(rows.find((c) => c.id === before.id)).toEqual(before);
  expect(rows.map((c) => c.name)).toEqual(expect.arrayContaining(["Month close", "Month close (2)", "Month close (3)"]));
  expect(rows.find((c) => c.name === "Month close (2)")!.steps.map((s) => s.name)).toEqual(["inputs", "bq", "pg", "diff", "has_rows"]);
  // Imports show up in the list; nothing opens on its own.
  await until(() => all(".wf-item").some((r) => r.textContent?.includes("Month close (3)")));
  expect(openSpy).not.toHaveBeenCalled();
  expect(location.hash).not.toMatch(/#workflow\//);
});

test("a step's description is edited from its ⋯ menu; the workflow's has an Edit button and folds later", async () => {
  await mount(<App />, "#workflow/ch_notes");
  await until(() => all(".chain-step").length === 2);
  const note = () => $<HTMLElement>(".desc.cs-desc")!;
  // No Edit button on the step note, and clicking the text does nothing.
  expect(note().querySelector("button[aria-label='Edit step description']")).toBeNull();
  await click(note().querySelector("p")!);
  expect($("textarea[aria-label='Step description']")).toBeNull();
  // The workflow description keeps its Edit button and shows 8 lines before folding.
  expect($(".desc.chain-desc button[aria-label='Edit workflow description']")).not.toBeNull();
  expect($<HTMLElement>(".desc.chain-desc")!.style.getPropertyValue("--desc-lines")).toBe("8");
  expect(note().style.getPropertyValue("--desc-lines")).toBe("3");

  const menu = async (i: number, label: string) => {
    await click(all("button[aria-label='Step actions']")[i]!);
    await click(byText(".menu [role=menuitem]", label)!);
  };
  await menu(0, "Edit description");
  const box = $<HTMLTextAreaElement>("textarea[aria-label='Step description']")!;
  expect(box.value).toBe("since: first day to look at.");
  await act(async () => type(box, "since: the first day."));
  await click(byText(".desc-editing .btn", "Save")!);
  await until(() => $(".desc.cs-desc p")?.textContent === "since: the first day.");

  // Cancel keeps the old text.
  await menu(0, "Edit description");
  await act(async () => type($<HTMLTextAreaElement>("textarea[aria-label='Step description']")!, "thrown away"));
  await click(byText(".desc-editing .btn", "Cancel")!);
  expect($(".desc.cs-desc p")!.textContent).toBe("since: the first day.");

  // A step without a note: Add description.
  await menu(1, "Add description");
  await act(async () => type($<HTMLTextAreaElement>("textarea[aria-label='Step description']")!, "Stops the run when false."));
  await click(byText(".desc-editing .btn", "Save")!);
  await until(() => all(".desc.cs-desc p").length === 2);
  await wait(700);
  const saved = (await listChainRows()).find((c) => c.id === "ch_notes")!;
  expect(saved.steps.map((s) => s.description)).toEqual(["since: the first day.", "Stops the run when false."]);
});

test("on open, a step's earlier result is folded and its row count shows; Set variables has no result panel", async () => {
  const { chainCache } = await import("../../src/chains/cache");
  chainCache("ch_daily").set("top", {
    key: "k",
    result: { columns: [{ name: "ad_hash", type: "VARCHAR", nullable: true }], rows: [["a1"], ["a2"], ["a3"]] },
    resultHash: "h",
    rowCount: 3,
    ms: 12,
    at: 1,
  });
  await mount(<App />, "#workflow/ch_daily");
  await until(() => !!$(".cs-out-panel"));
  const panel = $(".cs-out-panel")!;
  expect(panel.classList.contains("open")).toBe(false);
  expect(panel.querySelector(".cd-count")!.textContent).toBe("3 rows · cached");
  expect(panel.querySelector(".cd-grid")).toBeNull();
  await click(panel.querySelector("button[aria-label='Show the result']")!);
  expect($(".cs-out-panel")!.classList.contains("open")).toBe(true);
  chainCache("ch_daily").clear();
});

test("a step's graph problem shows on that step's card, not above the steps", async () => {
  const chain = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/chains/set_vars_missing_step.json"), "utf8"));
  await putChainRow(chain);
  await mount(<App />, "#workflow/ch_bad_set");
  await until(() => all(".chain-step").length === 2);
  expect($(".chain-steps > .err")).toBeNull();
  expect(all(".chain-step")[0]!.querySelector(".err")!.textContent).toBe(
    `SET bq_project_name in step "inputs" refers to "step", which is not a step in this workflow. Nothing runs until it's fixed.`,
  );
  expect(all(".chain-step")[1]!.querySelector(".err")).toBeNull();
});

test("Set variables shows a Preview of its values, Assert has no panel; headers say how many set / passed", async () => {
  const { runChainToEnd } = await import("../../src/chains/runner");
  const chain = (await listChainRows()).find((c) => c.id === "ch_notes")!;
  // ch_notes: inputs (set-vars) then check (assert true). Runs without connections.
  const deps = { render: (await import("../../src/collections/render")).render } as never;
  const sum = await runChainToEnd(chain, {}, deps);
  expect(sum.status).toBe("done");
  await mount(<App />, "#workflow/ch_notes");
  await until(() => all(".chain-step .cs-stats").some((e) => e.textContent?.includes("passed")));
  const stats = all(".chain-step .cs-stats").map((e) => e.textContent?.replace(/ · .*/, ""));
  expect(stats).toEqual(["1 set", "passed"]);
  // Set variables: a folded Preview, no tabs. Assert: nothing.
  const panels = all(".cs-out-panel");
  expect(panels).toHaveLength(1);
  expect(panels[0]!.classList.contains("vars-preview")).toBe(true);
  expect(panels[0]!.querySelector(".seg")).toBeNull();
  await click(panels[0]!.querySelector("button[aria-label='Show the preview']")!);
  expect(all(".vp-row").map((r) => r.textContent)).toEqual(["sincetext2026-10-14"]);
  (await import("../../src/chains/cache")).clearCache("ch_notes");
});
