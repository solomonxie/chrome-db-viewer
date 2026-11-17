// Hash routes inside app.html. The DNR redirect lands on app.html?src=<url> with the URL
// unencoded (it may contain '&' and its own #fragment), so ?src= is read with readSrcParam.

import { buildSrcUrl, readSrcParam } from "../../preview/src-param";

export type Route =
  /** #new (engine picker), #new/<engine> (that engine's form) or #edit/<id>. The toolbar popup
   *  opens these when a form needs a file chooser, which would close the popup. */
  | { name: "connection-editor"; connectionId?: string; driver?: string }
  | { name: "connection"; connectionId: string }
  /** `fileName`: the name when the URL doesn't show it, e.g. a Google Sheets CSV export link. */
  | { name: "file"; src?: string; fileHandleId?: string; fileName?: string }
  | { name: "settings"; section?: string }
  | { name: "download-prompt"; downloadId: number }
  /** Every workflow, at #workflows: opened from the toolbar popup. */
  | { name: "workflows" }
  /** A workflow (code name: chain), at #workflow/<id>. */
  | { name: "chain"; chainId: string };

export function parseRoute(hash: string, search = ""): Route {
  const sp = readSrcParam(search, hash);
  const src = sp?.src;
  const h = (sp ? sp.hash : hash).replace(/^#/, "");

  if (h === "new") return { name: "connection-editor" };
  if (h.startsWith("new/") && h.length > 4) return { name: "connection-editor", driver: decodeURIComponent(h.slice(4)) };
  if (h.startsWith("edit/") && h.length > 5) return { name: "connection-editor", connectionId: decodeURIComponent(h.slice(5)) };
  if (h.startsWith("c_") && h.length > 2) return { name: "connection", connectionId: decodeURIComponent(h.slice(2)) };
  if (h === "file" || h.startsWith("file/")) {
    const id = h.slice(5);
    return { name: "file", src, fileHandleId: id ? decodeURIComponent(id) : undefined, ...(sp?.name ? { fileName: sp.name } : {}) };
  }
  if (h === "settings" || h.startsWith("settings/")) {
    const section = h.slice(9);
    return section ? { name: "settings", section: decodeURIComponent(section) } : { name: "settings" };
  }
  if (h === "workflows") return { name: "workflows" };
  // Workflows: #workflow/<id> is what the UI links to; #chain/<id> (the old name) still works.
  if (h.startsWith("workflow/") && h.length > 9) return { name: "chain", chainId: decodeURIComponent(h.slice(9)) };
  if (h.startsWith("chain/") && h.length > 6) return { name: "chain", chainId: decodeURIComponent(h.slice(6)) };
  if (h.startsWith("download-prompt")) {
    const id = Number(new URLSearchParams(h.split("?")[1] ?? "").get("id"));
    if (Number.isInteger(id) && id >= 0) return { name: "download-prompt", downloadId: id };
  }
  if (h === "" && src) return { name: "file", src, ...(sp?.name ? { fileName: sp.name } : {}) };
  // There is no Home page; the toolbar popup lists connections. Anything else lands on Settings.
  return { name: "settings" };
}

export function routeHash(route: Route): string {
  switch (route.name) {
    case "connection-editor":
      if (route.connectionId) return `#edit/${encodeURIComponent(route.connectionId)}`;
      return route.driver ? `#new/${encodeURIComponent(route.driver)}` : "#new";
    case "connection":
      return `#c_${encodeURIComponent(route.connectionId)}`;
    case "file":
      return route.fileHandleId ? `#file/${encodeURIComponent(route.fileHandleId)}` : "#file";
    case "settings":
      return route.section ? `#settings/${encodeURIComponent(route.section)}` : "#settings";
    case "download-prompt":
      return `#download-prompt?id=${route.downloadId}`;
    case "workflows":
      return "#workflows";
    case "chain":
      return `#workflow/${encodeURIComponent(route.chainId)}`;
  }
}

/** Full URL (path + search + hash) for a route; file routes with a src keep it in ?src=. */
export function routeUrl(route: Route): string {
  if (route.name === "file" && route.src) return buildSrcUrl(location.pathname, route.src, routeHash(route), route.fileName);
  return location.pathname + routeHash(route);
}

/**
 * Opens a route in a new browser tab, never reusing one: chrome.tabs.create inside the
 * extension, window.open outside it (tests, a plain dev page).
 */
export function openInNewTab(route: Route): void {
  const c = typeof chrome !== "undefined" ? chrome : undefined;
  if (c?.tabs?.create && c.runtime?.getURL) {
    const page = c.runtime.getURL("app.html");
    const url = route.name === "file" && route.src ? buildSrcUrl(page, route.src, routeHash(route), route.fileName) : page + routeHash(route);
    void c.tabs.create({ url });
    return;
  }
  window.open(routeUrl(route), "_blank");
}

/**
 * Each connection, workflow and fixed page (Settings, Workflows) has one tab: opening it again
 * focuses the tab already showing it, else opens a new one. Pages for one job (the connection
 * editor, a file) always get a new tab (openInNewTab).
 */
export async function focusOrOpen(route: Route): Promise<void> {
  const c = typeof chrome !== "undefined" ? chrome : undefined;
  if (!c?.tabs?.query || !c.runtime?.getURL) {
    openInNewTab(route);
    return;
  }
  const page = c.runtime.getURL("app.html");
  const url = page + routeHash(route);
  // Only our own pages (readable without the "tabs" permission); the #fragment is compared
  // here because url patterns ignore it.
  const tabs = await c.tabs.query({ url: page + "*" });
  const tab = tabs.find((t) => t.url === url);
  if (tab?.id !== undefined) {
    await c.tabs.update(tab.id, { active: true });
    await c.windows?.update(tab.windowId, { focused: true });
  } else {
    await c.tabs.create({ url });
  }
}

/** A connection opens in its tab (#c_<id>): the one already showing it, else a new one. */
export function openConnectionTab(connectionId: string): Promise<void> {
  return focusOrOpen({ name: "connection", connectionId });
}

export function navigate(route: Route, opts: { newTab?: boolean } = {}): void {
  if (opts.newTab) {
    // Connections, workflows and the fixed pages keep one tab each.
    if (route.name === "connection" || route.name === "chain" || route.name === "settings" || route.name === "workflows") void focusOrOpen(route);
    else openInNewTab(route);
    return;
  }
  const hasSrc = route.name === "file" && !!route.src;
  if (hasSrc || location.search) {
    // Changing ?src= (or dropping it) needs a real URL change, then a hashchange to re-route.
    history.pushState(null, "", routeUrl(route));
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  location.hash = routeHash(route);
}

/** Closes this tab (pages opened for one job: a connection that's gone, the connection editor). */
export function closeThisTab(): void {
  const c = typeof chrome !== "undefined" ? chrome : undefined;
  if (c?.tabs?.getCurrent) {
    void c.tabs.getCurrent().then((t) => (t?.id !== undefined ? c.tabs.remove(t.id) : window.close()));
    return;
  }
  window.close();
}
