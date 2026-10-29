import { expect, test } from "vitest";
import { parseRoute, routeHash, type Route } from "../../src/app/lib/route";

test("empty hash is home", () => {
  expect(parseRoute("")).toEqual({ name: "home" });
  expect(parseRoute("#home")).toEqual({ name: "home" });
  expect(parseRoute("#nonsense")).toEqual({ name: "home" });
});

test("connection hash", () => {
  expect(parseRoute("#c_8f2")).toEqual({ name: "connection", connectionId: "8f2" });
  expect(parseRoute("#c_")).toEqual({ name: "home" });
});

test("file route reads ?src= and a handle id", () => {
  expect(parseRoute("#file", "?src=https%3A%2F%2Fx.test%2Fa.parquet")).toEqual({ name: "file", src: "https://x.test/a.parquet", fileHandleId: undefined });
  expect(parseRoute("#file/f_12")).toEqual({ name: "file", src: undefined, fileHandleId: "f_12" });
});

test("a DNR redirect with only ?src= opens the file", () => {
  expect(parseRoute("", "?src=https://x.test/a.csv")).toEqual({ name: "file", src: "https://x.test/a.csv" });
});

test("an unencoded redirect URL keeps its '&' params and #fragment", () => {
  expect(parseRoute("#part2", "?src=https://b.s3.test/a.parquet?X-Sig=1&X-Date=2")).toEqual({
    name: "file",
    src: "https://b.s3.test/a.parquet?X-Sig=1&X-Date=2#part2",
  });
});

test("download prompt route", () => {
  expect(parseRoute("#download-prompt?id=42")).toEqual({ name: "download-prompt", downloadId: 42 });
  expect(parseRoute("#download-prompt?id=x")).toEqual({ name: "home" });
});

test("settings with an optional section", () => {
  expect(parseRoute("#settings")).toEqual({ name: "settings" });
  expect(parseRoute("#settings/preview")).toEqual({ name: "settings", section: "preview" });
});

test("routeHash round-trips", () => {
  const routes: Route[] = [
    { name: "home" },
    { name: "connection", connectionId: "a b/c" },
    { name: "file", fileHandleId: "f_1" },
    { name: "settings", section: "preview" },
    { name: "download-prompt", downloadId: 7 },
  ];
  for (const r of routes) {
    const back = parseRoute(routeHash(r));
    expect(back).toMatchObject(r);
  }
});
