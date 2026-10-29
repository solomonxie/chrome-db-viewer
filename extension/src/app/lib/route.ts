// Hash routes inside app.html. The DNR redirect lands on app.html?src=<url> with the URL
// unencoded (it may contain '&' and its own #fragment), so ?src= is read with readSrcParam.

import { buildSrcUrl, readSrcParam } from "../../preview/src-param";

export type Route =
  | { name: "home" }
  | { name: "connection"; connectionId: string }
  | { name: "file"; src?: string; fileHandleId?: string }
  | { name: "settings"; section?: string }
  | { name: "download-prompt"; downloadId: number };

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
  }
}

/** Full URL (path + search + hash) for a route; file routes with a src keep it in ?src=. */
export function routeUrl(route: Route): string {
  if (route.name === "file" && route.src) return buildSrcUrl(location.pathname, route.src, routeHash(route));
  return location.pathname + routeHash(route);
}

export function navigate(route: Route, opts: { newTab?: boolean } = {}): void {
  if (opts.newTab) {
    window.open(routeUrl(route), "_blank");
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
