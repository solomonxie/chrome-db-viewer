// Theme setting: dark by default, Settings → Appearance switches <html data-theme>, and the
// boot script applies the saved choice before React renders.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Appearance } from "../../src/app/settings/Appearance";
import { initTheme, loadTheme, saveTheme, THEME_LOCAL_KEY } from "../../src/app/lib/theme";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const theme = () => document.documentElement.dataset.theme;

test("with nothing saved, the theme is dark", async () => {
  initTheme();
  expect(theme()).toBe("dark");
  expect(await loadTheme()).toBe("dark");
});

test("an unknown saved value falls back to dark", async () => {
  localStorage.setItem(THEME_LOCAL_KEY, "sepia");
  initTheme();
  expect(theme()).toBe("dark");
});

test("saving a theme sets data-theme and persists it", async () => {
  await saveTheme("light");
  expect(theme()).toBe("light");
  expect(localStorage.getItem(THEME_LOCAL_KEY)).toBe("light");
  expect(await loadTheme()).toBe("light");
  await saveTheme("system");
  expect(theme()).toBe("system");
});

test("the Appearance control shows Dark as selected by default and switching updates data-theme", async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Appearance />));
  const option = (label: string) => [...host!.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((b) => b.textContent?.startsWith(label))!;
  expect(option("Dark").getAttribute("aria-checked")).toBe("true");

  await act(async () => option("Light").click());
  expect(theme()).toBe("light");
  expect(option("Light").getAttribute("aria-checked")).toBe("true");
  expect(option("Dark").getAttribute("aria-checked")).toBe("false");

  await act(async () => option("Match system").click());
  expect(theme()).toBe("system");
});

test("the boot script applies the saved theme before the app loads", () => {
  const boot = readFileSync(resolve(__dirname, "../../public/theme-boot.js"), "utf8");
  new Function(boot)();
  expect(theme()).toBe("dark");
  localStorage.setItem(THEME_LOCAL_KEY, "light");
  new Function(boot)();
  expect(theme()).toBe("light");
});
