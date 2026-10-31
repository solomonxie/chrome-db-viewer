// Details pane: every field has a copy button that puts that field's value on the clipboard.
// The row comes from tests/fixtures/app/details-row.json.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { Cell, Column } from "@core/types";
import { copyText, DetailsPane } from "../../src/app/conn/DetailsPane";
import { emptyPending } from "../../src/app/lib/changes";

const ROW: { columns: Column[]; values: Cell[] } = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/app/details-row.json"), "utf8"));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
});

test("each field's copy button copies that field's value", async () => {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const source = { table: null, columns: ROW.columns, editable: false, rows: [{ rowId: "0", key: {}, values: ROW.values }] };
  await act(async () => root!.render(<DetailsPane ctx={{ pending: emptyPending, setPending: () => {}, readOnly: true }} source={source} />));

  const buttons = [...host.querySelectorAll<HTMLButtonElement>(".field .fcopy")];
  expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Copy id", "Copy video_download_url", "Copy meta", "Copy deleted_at"]);
  for (const b of buttons) await act(async () => b.click());
  expect(copied).toEqual([ROW.values[0], ROW.values[1], JSON.stringify(ROW.values[2], null, 2), ""]);
  expect(buttons[0]!.classList.contains("done")).toBe(true);
});

test("copyText: NULL copies as empty, objects as indented JSON", () => {
  expect(copyText(null)).toBe("");
  expect(copyText(42)).toBe("42");
  expect(copyText({ a: 1 })).toBe('{\n  "a": 1\n}');
});
