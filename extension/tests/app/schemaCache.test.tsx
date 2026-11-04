// Schema tree: opening a connection shows the items cached from the last visit at once, then
// reloads them in the background and swaps in the fresh lists. tests/fixtures/app/schema-cache.json
// has the cached row and what the (slow) driver answers now.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import type { ObjectNode, ObjectPath } from "@core/types";
import { LeftPane } from "../../src/app/conn/LeftPane";
import type { ConnCtx } from "../../src/app/conn/model";
import { readSchemaCache, writeSchemaCache, type SchemaCacheRow } from "../../src/app/store/schemaCache";

const FIX: { cached: SchemaCacheRow; fresh: Record<string, ObjectNode[]> } = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/app/schema-cache.json"), "utf8"));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
const text = () => host!.textContent ?? "";

test("cached schema items show before the driver answers, then the fresh list replaces them", async () => {
  await writeSchemaCache("bq_prod", new Map(Object.entries(FIX.cached.children)), new Set(FIX.cached.expanded));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const calls: string[] = [];
  const driver = {
    dialect: "bigquery",
    listObjects: async (parent: ObjectPath) => {
      calls.push(JSON.stringify(parent));
      await gate;
      return FIX.fresh[JSON.stringify(parent)] ?? [];
    },
  };
  const ctx = { cfg: { id: "bq_prod", driver: "bigquery", name: "BQ prod", options: {} }, driver, nodeTypes: new Map(), caps: {}, readOnly: true } as unknown as ConnCtx;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<LeftPane ctx={ctx} activePath={null} onOpen={() => {}} onOpenSql={() => {}} historyVersion={0} refreshKey={0} />));
  await wait(30);

  // From the cache, while the driver is still loading: no "Loading…", the open branch is open.
  expect(text()).not.toContain("Loading…");
  expect(text()).toContain("acme-old-project");
  expect(text()).toContain("events");
  expect(calls).toEqual(["[]"]);

  release();
  await wait(50);
  expect(calls).toEqual(["[]", '["acme-analytics"]']);
  expect(text()).toContain("acme-new-project");
  expect(text()).toContain("orders");
  expect(text()).not.toContain("acme-old-project");

  // The fresh lists are written back for next time.
  await wait(600);
  const saved = await readSchemaCache("bq_prod");
  expect(saved!.children["[]"]!.map((n) => n.name)).toEqual(["acme-analytics", "acme-new-project"]);
  expect(saved!.expanded).toEqual(['["acme-analytics"]']);
});
