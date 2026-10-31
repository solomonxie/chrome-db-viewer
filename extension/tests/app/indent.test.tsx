// Tab in the SQL editors indents with 4 spaces and stays in the editor; Shift+Tab outdents.
// Text comes from tests/fixtures/editor/indent.sql.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { SqlEditor } from "../../src/app/components/SqlEditor";
import { TemplateEditor } from "../../src/app/collections/TemplateEditor";
import { applyTab } from "../../src/app/lib/indent";

const SQL = readFileSync(resolve(__dirname, "../fixtures/editor/indent.sql"), "utf8");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

test("Tab with no selection inserts 4 spaces at the caret", () => {
  const at = SQL.indexOf("FROM");
  expect(applyTab(SQL, at, at, false)).toEqual({ value: SQL.slice(0, at) + "    " + SQL.slice(at), start: at + 4, end: at + 4 });
});

test("Tab over several lines indents each line; Shift+Tab takes up to 4 spaces back off", () => {
  const start = SQL.indexOf("name");
  const end = SQL.indexOf("orders") + 2;
  const indented = applyTab(SQL, start, end, false);
  expect(indented.value).toBe("SELECT id,\n      name\n    FROM orders\nWHERE status = 'paid'\n");
  expect(indented.value.slice(indented.start, indented.end)).toBe("name\n    FROM or");
  const back = applyTab(indented.value, indented.start, indented.end, true);
  expect(back.value).toBe(SQL);
  // A line with only 2 leading spaces loses just those.
  expect(applyTab(SQL, start, start, true).value).toBe("SELECT id,\nname\nFROM orders\nWHERE status = 'paid'\n");
});

for (const [label, Editor] of [
  ["SqlEditor", SqlEditor],
  ["TemplateEditor", TemplateEditor],
] as const) {
  test(`${label}: Tab is captured (focus stays) and inserts 4 spaces`, async () => {
    function Harness() {
      const [v, setV] = useState("SELECT 1");
      return (
        <>
          <Editor value={v} onChange={setV} aria-label="ed" />
          <button>next</button>
        </>
      );
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<Harness />));
    const ta = host.querySelector<HTMLTextAreaElement>("textarea")!;
    ta.focus();
    ta.setSelectionRange(0, 0);
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => {
      ta.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(ta.value).toBe("    SELECT 1");
    expect(document.activeElement).toBe(ta);
  });
}
