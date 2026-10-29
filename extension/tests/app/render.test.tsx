// Smoke tests: the main screens render against the demo driver without throwing.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, test } from "vitest";
import { App } from "../../src/app/App";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // jsdom lacks these.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  location.hash = "";
});

async function render(hash: string) {
  history.replaceState(null, "", "/app.html" + hash);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<App />));
}

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

/** Polls in small act() steps until `fn` passes (demo driver has simulated latency). */
async function until(fn: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for UI: " + host?.textContent?.slice(0, 300));
    await wait(25);
  }
}

test("home lists the demo connection, labelled as demo data", async () => {
  await render("#home");
  await wait(20);
  expect(host!.textContent).toContain("Demo database");
  expect(host!.textContent).toContain("Demo data");
  expect(host!.querySelector("input[aria-label='Search for connection']")).not.toBeNull();
});

test("demo connection tab connects, shows the tree and opens a table", async () => {
  await render("#c_demo");
  await until(() => !!host!.querySelector(".tree")?.textContent?.includes("orders"));
  expect(host!.querySelector(".capsule")?.textContent).toContain("local");

  const node = [...host!.querySelectorAll<HTMLButtonElement>(".node")].find((b) => b.textContent?.includes("orders") && !b.textContent.includes("order_items"));
  expect(node).toBeDefined();
  await act(async () => node!.click());
  await until(() => host!.querySelectorAll(".vgrid .r").length > 0);
  expect(host!.querySelectorAll(".vgrid .hc").length).toBeGreaterThan(5);
  expect(host!.textContent).toContain("customer_id");
});

test("settings page renders the preview groups", async () => {
  await render("#settings");
  await wait(20);
  expect(host!.textContent).toContain("Browser preview");
  expect(host!.textContent).toContain(".parquet");
  expect(host!.textContent).toContain("Never open from these sites");
});
