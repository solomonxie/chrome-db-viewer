// Schema search over every object name in the connection (Driver.listAllObjects), saved per
// connection: typing filters the saved list at once, with no database round trip; the list is
// refreshed in the background when old, and by the Refresh button. Hits not in the loaded tree
// show under "In the database" with where they live. tests/fixtures/app/schema-search.json has
// the loaded tree and the catalogs the driver answers.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import type { ObjectCatalog, ObjectNode, ObjectPath } from "@core/types";
import { LeftPane } from "../../src/app/conn/LeftPane";
import type { ConnCtx } from "../../src/app/conn/model";
import { CATALOG_MAX_AGE_MS, readSchemaCatalog, writeSchemaCatalog } from "../../src/app/store/schemaCatalog";

const FIX: { tree: Record<string, ObjectNode[]>; catalog: ObjectNode[]; catalogAfterRefresh: ObjectNode[] } = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/app/schema-search.json"), "utf8"),
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
let seq = 0;

async function mount(listAll?: () => Promise<ObjectCatalog>, id = `bq_search_${++seq}`) {
  const opened: ObjectPath[] = [];
  let listings = 0;
  const driver = {
    dialect: { name: "bigquery" },
    listObjects: async (parent: ObjectPath) => FIX.tree[JSON.stringify(parent)] ?? [],
    ...(listAll
      ? {
          listAllObjects: () => {
            listings++;
            return listAll();
          },
        }
      : {}),
  };
  const ctx = { cfg: { id, driver: "bigquery", name: "BQ", options: {} }, driver, nodeTypes: new Map(), caps: {}, readOnly: true } as unknown as ConnCtx;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<LeftPane ctx={ctx} activePath={null} onOpen={(p) => opened.push(p)} onOpenSql={() => {}} historyVersion={0} refreshKey={0} />));
  await wait(20);
  return { opened, ctx, listings: () => listings };
}

async function type(value: string) {
  const input = host!.querySelector<HTMLInputElement>("input[aria-label='Search schema']")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const found = () => host!.querySelector("[aria-label='In the database']");
const foot = () => found()!.querySelector(".catalog-foot")!.textContent;
const hitRows = () =>
  [...found()!.querySelectorAll<HTMLButtonElement>(".node")].map((r) => [r.querySelector(".nm")!.textContent, r.querySelector(".loc")!.textContent]);

test("typing filters the saved names at once, finding tables in unloaded datasets, which open", async () => {
  const { opened, ctx } = await mount(async () => ({ objects: FIX.catalog }));
  await type("annotated_visits");
  // No debounce, no round trip: the hits are there in the same render.
  expect(hitRows()).toEqual([
    ["mart__fact__annotated_visits", "acme-warehouse.web_v2__attribution"],
    ["annotated_visits_v", "acme-warehouse.web_v2__attribution"],
  ]);
  await act(async () => found()!.querySelector<HTMLButtonElement>(".node")!.click());
  expect(opened).toEqual([["acme-warehouse", "web_v2__attribution", "mart__fact__annotated_visits"]]);
  expect(ctx.nodeTypes.get(JSON.stringify(opened[0]))).toBe("table");
});

test("a pasted dataset id with hyphens finds the dataset whose name has underscores", async () => {
  await mount(async () => ({ objects: FIX.catalog }));
  await type("3f2b8c1d-9e4a-4b7f-a1c2-d5e6f7a8b9c0.agg_daily__channel_metrics");
  expect(hitRows()).toEqual([["agg_daily__channel_metrics", "acme-warehouse.3f2b8c1d_9e4a_4b7f_a1c2_d5e6f7a8b9c0"]]);
});

test("a fresh saved list is used as is; an old one answers at once and is refreshed in the background", async () => {
  await writeSchemaCatalog({ id: "fresh", objects: FIX.catalog, notes: [], at: Date.now() });
  const fresh = await mount(async () => ({ objects: FIX.catalogAfterRefresh }), "fresh");
  expect(fresh.listings()).toBe(0);
  act(() => root?.unmount());
  host?.remove();

  await writeSchemaCatalog({ id: "stale", objects: FIX.catalog, notes: [], at: Date.now() - CATALOG_MAX_AGE_MS - 1 });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const stale = await mount(async () => {
    await gate;
    return { objects: FIX.catalogAfterRefresh };
  }, "stale");
  expect(stale.listings()).toBe(1);
  await type("annotated_visits");
  // The old list answers while the new one loads.
  expect(hitRows().map((r) => r[0])).toEqual(["mart__fact__annotated_visits", "annotated_visits_v"]);
  expect(foot()).toContain("Refreshing names…");
  await type("zzz_nothing");
  expect(found()!.textContent).toContain("No match in the saved names. Still refreshing…");
  await type("annotated_visits");
  release();
  await wait(20);
  expect(hitRows().map((r) => r[0])).toEqual(["mart__fact__annotated_visits_new"]);
  expect((await readSchemaCatalog("stale"))!.objects).toEqual(FIX.catalogAfterRefresh);
});

test("Refresh lists the names again", async () => {
  let answer = FIX.catalog;
  const m = await mount(async () => ({ objects: answer }));
  await type("annotated_visits");
  expect(foot()).toMatch(/5 names · listed just now/);
  answer = FIX.catalogAfterRefresh;
  const refresh = [...found()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Refresh")!;
  await act(async () => refresh.click());
  await wait(20);
  expect(m.listings()).toBe(2);
  expect(hitRows().map((r) => r[0])).toEqual(["mart__fact__annotated_visits_new"]);
});

test("no match says so, without listing places it couldn't read; a failed refresh shows its error", async () => {
  await mount(async () => ({ objects: FIX.catalog, notes: ["locked-proj: couldn't list datasets (Access Denied)"] }));
  await type("zzz_nothing");
  expect(found()!.textContent).toContain("No other tables or views match.");
  expect(found()!.textContent).not.toContain("locked-proj");
  act(() => root?.unmount());
  host?.remove();

  await mount(async () => {
    throw new Error("Access Denied: projects.list");
  });
  await type("annotated");
  expect(found()!.textContent).toContain("Refresh failed: Access Denied");
});

test("a dataset hit opens its branch in the tree and clears the search", async () => {
  await mount(async () => ({ objects: FIX.catalog }));
  await type("3f2b8c1d");
  // The dataset sits under a root node the tree has loaded but not this branch.
  const ds = found()!.querySelector<HTMLButtonElement>(".node")!;
  expect(ds.querySelector(".nm")!.textContent).toBe("3f2b8c1d_9e4a_4b7f_a1c2_d5e6f7a8b9c0");
  await act(async () => ds.click());
  await wait(20);
  expect(host!.querySelector<HTMLInputElement>("input[aria-label='Search schema']")!.value).toBe("");
  const node = [...host!.querySelectorAll<HTMLButtonElement>(".tree .node")].find((b) => b.querySelector(".nm")?.textContent === "3f2b8c1d_9e4a_4b7f_a1c2_d5e6f7a8b9c0")!;
  expect(node.getAttribute("aria-expanded")).toBe("true");
});

test("drivers without listAllObjects keep the loaded-tree filter only", async () => {
  await mount();
  await type("annotated");
  expect(found()).toBeNull();
});
