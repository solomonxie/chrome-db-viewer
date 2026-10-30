// Hash routes inside app.html. The DNR redirect lands on app.html?src=<url> with the URL
// unencoded (it may contain '&' and its own #fragment), so ?src= is read with readSrcParam.

import { buildSrcUrl, readSrcParam } from "../../preview/src-param";

export type Route =
  | { name: "home" }
  | { name: "connection"; connectionId: string }
  | { name: "file"; src?: string; fileHandleId?: string }
  | { name: "settings"; section?: string }
  | { name: "download-prompt"; downloadId: number }
  /** A workflow (code name: chain), at #workflow/<id>. */
  | { name: "chain"; chainId: string };

export function parseRoute(hash: string, search = ""): Route {
  const sp = readSrcParam(search, hash);
  const src = sp?.src;
  const h = (sp ? sp.hash : hash).replace(/^#/, "");

  if (h.startsWith("c_") && h.length > 2) return { name: "connection", connectionId: decodeURIComponent(h.slice(2)) };
  if (h === "file" || h.startsWith("file/")) {
    const id = h.slice(5);
    return { name: "file", src, fileHandleId: id ? decodeURIComponent(id) : undefined };
  }
  if (h === "settings" || h.startsWith("settings/")) {
    const section = h.slice(9);
    return section ? { name: "settings", section: decodeURIComponent(section) } : { name: "settings" };
  }
  // Workflows: #workflow/<id> is what the UI links to; #chain/<id> (the old name) still works.
  if (h.startsWith("workflow/") && h.length > 9) return { name: "chain", chainId: decodeURIComponent(h.slice(9)) };
  if (h.startsWith("chain/") && h.length > 6) return { name: "chain", chainId: decodeURIComponent(h.slice(6)) };
  if (h.startsWith("download-prompt")) {
    const id = Number(new URLSearchParams(h.split("?")[1] ?? "").get("id"));
    if (Number.isInteger(id) && id >= 0) return { name: "download-prompt", downloadId: id };
  }
  if (h === "" && src) return { name: "file", src };
  return { name: "home" };
}

export function routeHash(route: Route): string {
  switch (route.name) {
    case "home":
      return "#home";
    case "connection":
      return `#c_${encodeURIComponent(route.connectionId)}`;
    case "file":
      return route.fileHandleId ? `#file/${encodeURIComponent(route.fileHandleId)}` : "#file";
    case "settings":
      return route.section ? `#settings/${encodeURIComponent(route.section)}` : "#settings";
    case "download-prompt":
      return `#download-prompt?id=${route.downloadId}`;
    case "chain":
      return `#workflow/${encodeURIComponent(route.chainId)}`;
  }
}

/** Full URL (path + search + hash) for a route; file routes with a src keep it in ?src=. */
export function routeUrl(route: Route): string {
  if (route.name === "file" && route.src) return buildSrcUrl(location.pathname, route.src, routeHash(route));
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
    const url = route.name === "file" && route.src ? buildSrcUrl(page, route.src, routeHash(route)) : page + routeHash(route);
    void c.tabs.create({ url });
    return;
  }
  window.open(routeUrl(route), "_blank");
}

/** A connection always opens in its own new tab (#c_<id>); the current tab stays where it is. */
export function openConnectionTab(connectionId: string): void {
  openInNewTab({ name: "connection", connectionId });
}

export function navigate(route: Route, opts: { newTab?: boolean } = {}): void {
  if (opts.newTab) {
    openInNewTab(route);
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
