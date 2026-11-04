// File sheet: clicking a column header sorts the rows (asc, then desc, then off).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, test, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { FileSheet } = await import("../../src/app/file/FileSheet");
const { ToastProvider } = await import("../../src/app/components/ui");

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
});
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
async function until(fn: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out: " + host?.textContent?.slice(0, 300));
    await wait(25);
  }
}

const $ = <T extends Element>(sel: string) => host!.querySelector<T>(sel);
const all = <T extends Element>(sel: string) => [...host!.querySelectorAll<T>(sel)];
const click = (el: Element) => act(async () => (el as HTMLElement).click());
const nameOf = (h: Element) => h.querySelector(":scope > span:not(.arrow):not(.rs)")?.textContent;
const header = (name: string) => all<HTMLElement>(".hdr .hc:not(.rn)").find((h) => nameOf(h) === name)!;
/** Values of one column, top to bottom, as shown. */
const columnValues = (name: string) => {
  const i = all(".hdr .hc:not(.rn)").findIndex((h) => nameOf(h) === name);
  return all(".vgrid .r").map((r) => r.querySelectorAll(".c:not(.rn)")[i]?.textContent ?? "");
};

test("clicking a column header sorts the file's rows: ascending, descending, then off", async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // A URL that can't be read: the error page offers the demo sheet, which is the real sheet UI.
  vi.stubGlobal("fetch", async () => {
    throw new Error("offline");
  });
  await act(async () => root!.render(<ToastProvider><FileSheet src="https://example.invalid/orders.csv" /></ToastProvider>));
  await until(() => all("button").some((b) => b.textContent === "Try with demo data"));
  await click(all("button").find((b) => b.textContent === "Try with demo data")!);
  await until(() => all(".vgrid .r").length > 3);
  const first = nameOf(all(".hdr .hc:not(.rn)")[0]!)!;
  const before = columnValues(first);

  await click(header(first));
  await until(() => header(first)?.getAttribute("aria-sort") === "ascending");
  await until(() => columnValues(first).join() !== before.join() || columnValues(first).join() === [...before].sort().join());
  const asc = columnValues(first);
  await click(header(first));
  await until(() => header(first)?.getAttribute("aria-sort") === "descending");
  await until(() => columnValues(first).join() !== asc.join());
  expect(columnValues(first)[0]).not.toBe(asc[0]);
  await click(header(first));
  await until(() => header(first)?.getAttribute("aria-sort") === null);
});


test("SQL run from a SQL sheet replaces it; a long stack keeps one line with a … menu", async () => {
  const { crumbItems } = await import("../../src/app/file/FileSheet");
  expect(crumbItems(3)).toEqual([0, 1, 2]);
  expect(crumbItems(7)).toEqual([0, "more", 5, 6]);

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal("fetch", async () => {
    throw new Error("offline");
  });
  await act(async () => root!.render(<ToastProvider><FileSheet src="https://example.invalid/orders.csv" /></ToastProvider>));
  await until(() => all("button").some((b) => b.textContent === "Try with demo data"));
  await click(all("button").find((b) => b.textContent === "Try with demo data")!);
  await until(() => all(".vgrid .r").length > 3);
  await click(all<HTMLButtonElement>("button").find((b) => b.textContent?.trim() === "SQL")!);
  const runSql = async (sql: string) => {
    const box = $<HTMLTextAreaElement>("textarea[aria-label='SQL over this file']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, sql);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })));
  };
  const crumbs = () => all(".crumbs button").map((b) => b.textContent);
  await runSql('SELECT * FROM "orders.csv" LIMIT 10');
  await runSql('SELECT * FROM "orders.csv" LIMIT 20');
  await runSql('SELECT * FROM "orders.csv" LIMIT 30');
  expect(crumbs()).toEqual(["orders.csv (demo data)", 'SQLSELECT * FROM "orders.csv" LIMIT 30']);
  expect(all<HTMLButtonElement>(".crumbs button")[1]!.title).toBe('SELECT * FROM "orders.csv" LIMIT 30');
});
