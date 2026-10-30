// URL cells: linkOf decides what counts as a link (cases in tests/fixtures/grid/link-cells.json),
// and the grid adds an open-in-new-tab button only to those cells.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, test } from "vitest";
import type { Cell, Column } from "@core/types";
import { DataGrid } from "../../src/app/components/DataGrid";
import { linkOf } from "../../src/app/lib/format";

const CASES: { links: [string, string][]; notLinks: Cell[] } = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/grid/link-cells.json"), "utf8"));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

test("whole http(s) URLs are links; script, data, embedded and other schemes are not", () => {
  for (const [value, href] of CASES.links) expect(linkOf(value)).toBe(href);
  for (const value of CASES.notLinks) expect(linkOf(value)).toBeNull();
});

test("the grid shows an open-link button on URL cells only, opening in a new tab", async () => {
  const columns: Column[] = [{ name: "video_download_url", type: "VARCHAR", nullable: true }];
  const values: Cell[] = [CASES.links[0]![0], ...CASES.notLinks];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(<DataGrid columns={columns} rowCount={values.length} value={(r) => values[r] ?? null} selection={new Set()} cursor={null} onSelection={() => {}} />),
  );
  const links = [...host.querySelectorAll<HTMLAnchorElement>("a.cell-link")];
  expect(links).toHaveLength(1);
  expect(links[0]!.href).toBe(CASES.links[0]![1]);
  expect(links[0]!.target).toBe("_blank");
  expect(links[0]!.rel).toBe("noopener noreferrer");
});
