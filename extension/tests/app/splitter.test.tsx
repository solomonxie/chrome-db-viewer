// Pane splitter: drag, keyboard, clamping, double-click reset and the saved width.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { clampWidth, Splitter, usePaneWidth } from "../../src/app/components/Splitter";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;
let current = 0;

function Harness(props: { side: "left" | "right" | "top" }) {
  const pane = usePaneWidth("test.pane", 300, 200, 500);
  current = pane.width;
  return <Splitter side={props.side} label="Resize" size={pane} onResize={pane.setWidth} />;
}

function mount(side: "left" | "right" | "top"): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Harness side={side} />));
  return host.querySelector<HTMLElement>(".splitter")!;
}

function drag(el: HTMLElement, fromX: number, toX: number) {
  act(() => el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: fromX }) as PointerEvent));
  act(() => window.dispatchEvent(new MouseEvent("pointermove", { clientX: toX }) as PointerEvent));
  act(() => window.dispatchEvent(new MouseEvent("pointerup", {}) as PointerEvent));
}

beforeEach(() => localStorage.clear());

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

test("clampWidth keeps widths inside the pane limits", () => {
  expect(clampWidth(150, 200, 500)).toBe(200);
  expect(clampWidth(320.6, 200, 500)).toBe(321);
  expect(clampWidth(900, 200, 500)).toBe(500);
});

test("dragging the left splitter right widens the left pane and saves the width", () => {
  const el = mount("left");
  drag(el, 300, 360);
  expect(current).toBe(360);
  expect(localStorage.getItem("test.pane")).toBe("360");
  expect(el.getAttribute("aria-valuenow")).toBe("360");
});

test("dragging the right splitter left widens the right pane, clamped to the max", () => {
  const el = mount("right");
  drag(el, 800, 500);
  expect(current).toBe(500);
});

test("arrow keys resize, Shift takes bigger steps, double-click resets", () => {
  const el = mount("left");
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(current).toBe(316);
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true })));
  expect(current).toBe(268);
  act(() => el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(current).toBe(300);
});

test("a saved width is restored on the next mount", () => {
  localStorage.setItem("test.pane", "420");
  mount("left");
  expect(current).toBe(420);
});

function dragY(el: HTMLElement, fromY: number, toY: number) {
  act(() => el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientY: fromY }) as PointerEvent));
  act(() => window.dispatchEvent(new MouseEvent("pointermove", { clientY: toY }) as PointerEvent));
  act(() => window.dispatchEvent(new MouseEvent("pointerup", {}) as PointerEvent));
}

test("a top splitter is a horizontal bar: dragging down grows the pane above it", () => {
  const el = mount("top");
  expect(el.classList.contains("rows")).toBe(true);
  expect(el.getAttribute("aria-orientation")).toBe("horizontal");
  dragY(el, 400, 460);
  expect(current).toBe(360);
  dragY(el, 460, 0);
  expect(current).toBe(200);
});

test("a top splitter moves with the up and down arrow keys", () => {
  const el = mount("top");
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect(current).toBe(316);
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", shiftKey: true, bubbles: true })));
  expect(current).toBe(268);
});
