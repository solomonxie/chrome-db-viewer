// The cell box: Space, Enter or double-click opens a cell's whole value in a text box over the grid.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, test } from "vitest";
import type { Cell, Column } from "../../src/core/types";
import { boxText, DataGrid, type GridCursor } from "../../src/app/components/DataGrid";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const DATA = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/app/long-cells.json"), "utf8")) as { columns: Column[]; rows: Cell[][] };

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

const edits: [number, number, string][] = [];
function Grid(props: { editable?: boolean }) {
  const [rows, setRows] = useState(DATA.rows);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [cur, setCur] = useState<GridCursor | null>(null);
  return (
    <DataGrid
      columns={DATA.columns}
      rowCount={rows.length}
      value={(r, c) => rows[r]?.[c] ?? null}
      selection={sel}
      cursor={cur}
      onSelection={(s, c) => {
        setSel(s);
        setCur(c);
      }}
      editable={props.editable}
      onEdit={(r, c, text) => {
        edits.push([r, c, text]);
        setRows((rs) => rs.map((row, i) => (i === r ? row.map((v, j) => (j === c ? text : v)) : row)));
      }}
    />
  );
}

async function mount(editable = false) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Grid editable={editable} />));
}
const $ = <T extends Element>(s: string) => host!.querySelector<T>(s);
const cell = (r: number, c: number) => host!.querySelectorAll<HTMLElement>(".vgrid .r")[r]!.querySelectorAll<HTMLElement>(".c:not(.rn)")[c]!;
const key = (el: Element, k: string, mods: KeyboardEventInit = {}) => act(async () => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...mods })));

test("JSON values and JSON text are pretty-printed; other text is shown as is", () => {
  expect(boxText({ a: 1 }).text).toBe('{\n  "a": 1\n}');
  expect(boxText('{"plan":"annual"}')).toEqual({ text: '{\n  "plan": "annual"\n}', json: true });
  expect(boxText("{not json")).toEqual({ text: "{not json", json: false });
  expect(boxText(null)).toEqual({ text: "", json: false });
});

test("click selects as before; Space opens the whole value in a read-only box, Esc closes it", async () => {
  await mount();
  await act(async () => void cell(1, 1).dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  expect($(".cellbox")).toBeNull();
  await key($(".gridwrap")!, " ");
  const ta = $<HTMLTextAreaElement>(".cellbox textarea")!;
  expect(ta.value).toBe(DATA.rows[1]![1]);
  expect(ta.readOnly).toBe(true);
  expect(document.activeElement).toBe(ta);
  expect($(".cellbox-head")!.textContent).toContain("plans");
  expect($(".cellbox-head")!.textContent).toContain("90 chars");
  // Keys inside the box stay in the box: the grid cursor doesn't move.
  await key(ta, "ArrowDown");
  expect($(".cellbox")).not.toBeNull();
  await key(ta, "Escape");
  expect($(".cellbox")).toBeNull();
});

test("double-click on a JSON cell shows it pretty-printed", async () => {
  await mount();
  await act(async () => void cell(1, 2).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect($<HTMLTextAreaElement>(".cellbox textarea")!.value).toBe('{\n  "source": "web",\n  "tags": [\n    "a",\n    "b"\n  ]\n}');
  expect($(".cellbox-head")!.textContent).toContain("JSON");
});

test("in an editable grid, a long value is edited in the box and ⌘↵ saves it; short values keep the inline input", async () => {
  edits.length = 0;
  await mount(true);
  await act(async () => void cell(2, 3).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  const ta = $<HTMLTextAreaElement>(".cellbox.editing textarea")!;
  expect(ta.readOnly).toBe(false);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "line one\nline 2");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await key(ta, "Enter", { metaKey: true });
  expect(edits).toEqual([[2, 3, "line one\nline 2"]]);
  expect($(".cellbox")).toBeNull();

  await act(async () => void cell(0, 3).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect($(".cellbox")).toBeNull();
  expect($<HTMLInputElement>(".vgrid .c input")!.value).toBe("short");
});
