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
  // The SQL strip shows the exact statement the grid ran.
  expect(host!.querySelector(".sentsql-code")?.textContent).toMatch(/^SELECT \* FROM .*orders.* LIMIT \d+/);
});

test("settings page renders the preview groups", async () => {
  await render("#settings");
  await wait(20);
  expect(host!.textContent).toContain("Browser preview");
  expect(host!.textContent).toContain(".parquet");
  expect(host!.textContent).toContain("Never open from these sites");
});

test("bigquery form picks the sign-in method from a dropdown and shows its hint", async () => {
  const { ConnectionForm } = await import("../../src/app/home/NewConnection");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<ConnectionForm driver="bigquery" groups={[]} onSaved={() => {}} onCancel={() => {}} />));

  const select = document.querySelector<HTMLSelectElement>("#f_auth")!;
  expect(select).not.toBeNull();
  expect(document.querySelector('input[type="radio"][name="bq-auth"]')).toBeNull();
  expect([...select.options].find((o) => o.value === "wif")!.disabled).toBe(true);
  // gcloud login comes first and is the default for a new connection.
  expect(select.options[0]!.value).toBe("adc");
  expect(select.options[0]!.textContent).toMatch(/gcloud login/);
  expect(select.value).toBe("adc");

  await act(async () => {
    select.value = "adc";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.querySelector(".authpick .guide")!.textContent).toMatch(/application_default_credentials\.json/);
  expect(document.body.textContent).toMatch(/Key file/);
});

test("connection form explains the chosen method and updates when it changes", async () => {
  const { ConnectionForm } = await import("../../src/app/home/NewConnection");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<ConnectionForm driver="bigquery" groups={[]} onSaved={() => {}} onCancel={() => {}} />));

  const guide = () => document.querySelector(".guide")!.textContent!;
  expect(guide()).toMatch(/gcloud auth application-default login/);
  expect(guide()).toMatch(/Company accounts where you can't create OAuth clients/);

  const select = document.querySelector<HTMLSelectElement>("#f_auth")!;
  await act(async () => {
    select.value = "service-account";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(guide()).toMatch(/Not a good fit/);
  expect(guide()).toMatch(/Company production/);
});

test("every BigQuery sign-in method has a guide", async () => {
  const { BIGQUERY_AUTH } = await import("../../src/app/lib/driverForms");
  const { BIGQUERY_AUTH_GUIDES } = await import("../../src/app/lib/connectionGuides");
  for (const a of BIGQUERY_AUTH) expect(BIGQUERY_AUTH_GUIDES[a.value], a.value).toBeDefined();
});

test("the SQL strip follows sorting and filtering", async () => {
  await render("#c_demo");
  await until(() => !!host!.querySelector(".tree")?.textContent?.includes("orders"));
  const node = [...host!.querySelectorAll<HTMLButtonElement>(".node")].find((b) => b.textContent?.includes("orders") && !b.textContent.includes("order_items"));
  await act(async () => node!.click());
  await until(() => host!.querySelectorAll(".vgrid .r").length > 0);
  const sql = () => host!.querySelector(".sentsql-code")!.textContent!;
  expect(sql()).not.toMatch(/ORDER BY|WHERE/);

  const header = [...host!.querySelectorAll<HTMLElement>(".vgrid .hc")].find((h) => h.textContent?.includes("status"))!;
  await act(async () => header.click());
  await until(() => /ORDER BY .*status.* ASC/.test(sql()));

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, ctrlKey: true, bubbles: true }));
  });
  await until(() => !!host!.querySelector("input[aria-label='Value']"));
  const column = host!.querySelector<HTMLSelectElement>("select[aria-label='Column']")!;
  const value = host!.querySelector<HTMLInputElement>("input[aria-label='Value']")!;
  await act(async () => {
    column.value = "status";
    column.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(value, "paid");
    value.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    value.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await until(() => /WHERE .*status.*'paid'/.test(sql()));
  expect(sql()).toMatch(/ORDER BY/);
});

test("starring a table pins it under Favorites, and unstarring removes it", async () => {
  await render("#c_demo");
  await until(() => !!host!.querySelector(".tree")?.textContent?.includes("customers"));
  expect(host!.querySelector(".favorites")).toBeNull();

  const row = [...host!.querySelectorAll<HTMLButtonElement>(".tree > .node")].find((b) => b.querySelector(".nm")?.textContent === "customers")!;
  await act(async () => row.querySelector<HTMLElement>(".star")!.click());
  await until(() => !!host!.querySelector(".favorites"));
  expect(host!.querySelector(".favorites")!.textContent).toContain("customers");
  expect(row.querySelector(".star")!.getAttribute("aria-pressed")).toBe("true");

  await act(async () => host!.querySelector<HTMLElement>(".favorites .star")!.click());
  await until(() => !host!.querySelector(".favorites"));
});

test("a loading table shows Stop, and Stop cancels the query", async () => {
  await render("#c_demo");
  await until(() => !!host!.querySelector(".tree")?.textContent?.includes("customers"));
  const node = [...host!.querySelectorAll<HTMLButtonElement>(".node")].find((b) => b.textContent?.includes("customers"));
  await act(async () => node!.click());

  // The demo driver answers after a short simulated delay, so the query is still running here.
  const stop = () => [...host!.querySelectorAll<HTMLButtonElement>(".foot button, button")].find((b) => b.textContent?.startsWith("Stop"));
  await until(() => !!stop());
  await act(async () => stop()!.click());
  await until(() => host!.textContent!.includes("Query cancelled"));
  expect(stop()).toBeUndefined();
});
