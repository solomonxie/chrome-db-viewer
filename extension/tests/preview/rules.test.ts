import { expect, test } from "vitest";
import { buildRules, classifyFilename, classifyMime, classifyUrl, dataRegex, mediaRegex, normalizeDomain } from "../../src/preview/rules";
import { DEFAULT_PREVIEW_SETTINGS, type PreviewSettings } from "../../src/preview/settings";

const BASE = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";

const on: PreviewSettings = { ...DEFAULT_PREVIEW_SETTINGS, enabled: true };
const withVideo: PreviewSettings = { ...on, extensions: [...on.extensions, "mp4", "webm", "png", "jpg"] };
const excluded: PreviewSettings = { ...withVideo, excludedDomains: ["https://Data.Example.org/path", "*.cdn.test"] };

function matches(regex: string | null, url: string): boolean {
  // RE2 and JS agree on this subset; isUrlFilterCaseSensitive: false -> the "i" flag.
  return regex !== null && new RegExp(regex, "i").test(url);
}

test("buildRules returns nothing when the feature is off", () => {
  expect(buildRules(DEFAULT_PREVIEW_SETTINGS, BASE)).toEqual([]);
});

test("buildRules with the defaults makes the data rule and the CORP rule", () => {
  const rules = buildRules(on, BASE);
  expect(rules.map((r) => r.id)).toEqual([1, 3]);
  const [rule] = rules;
  expect(rule?.id).toBe(1);
  expect(rule?.condition.resourceTypes).toEqual(["main_frame"]);
  expect(rule?.condition.isUrlFilterCaseSensitive).toBe(false);
  expect(rule?.condition.excludedRequestDomains).toBeUndefined();
  expect(rule?.action).toEqual({ type: "redirect", redirect: { regexSubstitution: `${BASE}app.html?src=\\0` } });
  expect(rule?.condition.regexFilter).toBe(
    "^(?:https?|file)://[^?#]*\\.(?:csv|tsv|psv|jsonl|ndjson|parquet|arrow|feather|duckdb|sqlite|db)(?:\\.(?:gz|zst))?(?:[?#].*)?$",
  );
});

test("buildRules adds rule 2 to media.html when media is checked, and fills excludedRequestDomains", () => {
  const rules = buildRules(excluded, BASE.slice(0, -1));
  expect(rules.map((r) => r.id)).toEqual([1, 2, 3]);
  const media = rules[1];
  expect(media?.action.redirect?.regexSubstitution).toBe(`${BASE}media.html?src=\\0`);
  expect(media?.condition.regexFilter).toBe("^(?:https?|file)://[^?#]*\\.(?:png|jpg|mp4|webm)(?:[?#].*)?$");
  for (const r of rules.slice(0, 2)) expect(r.condition.excludedRequestDomains).toEqual(["data.example.org", "cdn.test"]);
});

test("buildRules with only media checked makes only rule 2", () => {
  const rules = buildRules({ enabled: true, extensions: ["png", "gz"], excludedDomains: [] }, BASE);
  expect(rules.map((r) => r.id)).toEqual([2, 3]);
});

test("buildRules ignores unknown extensions so nothing unescaped reaches the regex", () => {
  const rules = buildRules({ enabled: true, extensions: ["csv", ".*", "a|b", "CSV", ".tsv"], excludedDomains: ["bad domain", ""] }, BASE);
  expect(rules[0]?.condition.regexFilter).toContain("\\.(?:csv|tsv)");
  expect(rules[0]?.condition.excludedRequestDomains).toBeUndefined();
});

test("the regex stays small for every extension checked", () => {
  const all = buildRules(
    {
      enabled: true,
      extensions: ["csv", "tsv", "psv", "jsonl", "ndjson", "parquet", "arrow", "feather", "duckdb", "sqlite", "db", "json", "gz", "zst",
        "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "heic", "tiff", "mp4", "webm", "mov", "m4v", "mkv"],
      excludedDomains: [],
    },
    BASE,
  );
  for (const r of all) expect((r.condition.regexFilter ?? "").length).toBeLessThan(300);
});

test("rule 3 sets CORP on image/media requests from dbui's own pages only", () => {
  const corp = buildRules(withVideo, BASE).find((r) => r.id === 3);
  expect(corp).toEqual({
    id: 3,
    priority: 1,
    condition: { initiatorDomains: ["abcdefghijklmnopabcdefghijklmnop"], resourceTypes: ["image", "media"] },
    action: {
      type: "modifyHeaders",
      responseHeaders: [{ header: "Cross-Origin-Resource-Policy", operation: "set", value: "cross-origin" }],
    },
  });
});

test("rule 3 is absent when preview is off", () => {
  expect(buildRules({ ...withVideo, enabled: false }, BASE).find((r) => r.id === 3)).toBeUndefined();
});

const URL_TABLE: [string, PreviewSettings, "data" | "media" | null][] = [
  // S3 presigned Parquet: the query string holds &, %2F and = and must not break the match.
  ["https://my-bucket.s3.us-east-1.amazonaws.com/exports/2024/part-0001.parquet?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20240517%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20240517T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123", on, "data"],
  ["https://storage.googleapis.com/bucket/dir/data.csv?x=1", on, "data"],
  ["https://example.com/report.CSV", on, "data"],
  ["https://example.com/logs/events.csv.gz", on, "data"],
  ["https://example.com/logs/events.jsonl.zst#frag", on, "data"],
  ["https://example.com/backup.tar.gz", on, null],
  ["https://example.com/archive.gz", on, null],
  ["file:///Users/me/a.jsonl", on, "data"],
  ["file:///Users/me/My%20Data/b.parquet", on, "data"],
  ["https://example.com/api/export?format=csv", on, null],
  ["https://example.com/data.csv/", on, null],
  ["https://example.com/page.html?file=data.csv", on, null],
  ["https://example.com/data.json", on, null],
  ["ftp://example.com/data.csv", on, null],
  ["https://example.com/movie.mp4", on, null],
  ["https://example.com/movie.mp4", withVideo, "media"],
  ["https://example.com/movie.MP4?t=10", withVideo, "media"],
  ["https://example.com/clip.mp4.gz", withVideo, null],
  ["https://example.com/photo.png", withVideo, "media"],
  ["https://example.com/photo.jpeg", withVideo, null],
  ["https://data.example.org/a.csv", excluded, null],
  ["https://sub.data.example.org/a.csv", excluded, null],
  ["https://img.cdn.test/a.png", excluded, null],
  ["https://example.org/a.csv", excluded, "data"],
  ["https://notdata.example.org/a.csv", excluded, "data"],
];

test.each(URL_TABLE)("classifyUrl(%s) -> %s", (url, settings, expected) => {
  expect(classifyUrl(url, settings)).toBe(expected);
});

test("the generated regexes agree with classifyUrl on the URL table (domain exclusion aside)", () => {
  for (const [url, settings, expected] of URL_TABLE) {
    if (settings === excluded) continue;
    const kind = matches(dataRegex(settings), url) ? "data" : matches(mediaRegex(settings), url) ? "media" : null;
    expect(kind, url).toBe(expected);
  }
});

test("the redirect target keeps the whole original URL", () => {
  const [rule] = buildRules(on, BASE);
  const url = "https://b.s3.amazonaws.com/k/a.parquet?X-Amz-Signature=x&X-Amz-Date=y";
  const re = new RegExp(rule?.condition.regexFilter ?? "", "i");
  const target = url.replace(re, (rule?.action.redirect?.regexSubstitution ?? "").replace("\\0", () => "$&"));
  expect(target).toBe(`${BASE}app.html?src=${url}`);
});

test("classifyFilename and classifyMime follow the checked types", () => {
  expect(classifyFilename("Export 2024.CSV", on)).toBe("data");
  expect(classifyFilename("events.ndjson.gz", on)).toBe("data");
  expect(classifyFilename("backup.tar.gz", on)).toBeNull();
  expect(classifyFilename("events.csv.gz", { ...on, extensions: ["csv"] })).toBeNull();
  expect(classifyFilename("photo.png", on)).toBeNull();
  expect(classifyFilename("photo.png", withVideo)).toBe("media");
  expect(classifyFilename("noext", on)).toBeNull();
  expect(classifyMime("text/csv; charset=utf-8", on)).toBe("data");
  expect(classifyMime("application/vnd.apache.parquet", on)).toBe("data");
  expect(classifyMime("application/json", on)).toBeNull();
  expect(classifyMime("image/jpeg", on)).toBeNull();
  expect(classifyMime("image/jpeg", withVideo)).toBe("media");
  expect(classifyMime("video/mp4", { ...on, enabled: false })).toBeNull();
});

test("normalizeDomain", () => {
  expect(normalizeDomain("https://Data.Example.org:8443/x?y")).toBe("data.example.org");
  expect(normalizeDomain("*.example.com")).toBe("example.com");
  expect(normalizeDomain(".example.com.")).toBe("example.com");
  expect(normalizeDomain("localhost")).toBe("localhost");
  expect(normalizeDomain("not a domain")).toBeNull();
  expect(normalizeDomain("")).toBeNull();
});
