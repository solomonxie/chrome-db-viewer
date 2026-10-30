import { expect, test } from "vitest";
import { buildRules, classifyFilename, classifyMime, classifyUrl, dataRegex, LEGACY_RULE_IDS, normalizeDomain, PREVIEW_GROUPS, PREVIEW_RULE_IDS } from "../../src/preview/rules";
import { DEFAULT_PREVIEW_SETTINGS, type PreviewSettings } from "../../src/preview/settings";

const BASE = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";

const on: PreviewSettings = { ...DEFAULT_PREVIEW_SETTINGS, enabled: true };
// Media extensions are ignored even when passed in directly (mergeSettings also drops them).
const withMedia: PreviewSettings = { ...on, extensions: [...on.extensions, "mp4", "webm", "png", "jpg"] };
const excluded: PreviewSettings = { ...on, excludedDomains: ["https://Data.Example.org/path", "*.cdn.test"] };

function matches(regex: string | null, url: string): boolean {
  // RE2 and JS agree on this subset; isUrlFilterCaseSensitive: false -> the "i" flag.
  return regex !== null && new RegExp(regex, "i").test(url);
}

test("buildRules returns nothing when the feature is off", () => {
  expect(buildRules({ ...DEFAULT_PREVIEW_SETTINGS, enabled: false }, BASE)).toEqual([]);
});

test("browser preview is on by default, and the defaults make rule 1", () => {
  expect(DEFAULT_PREVIEW_SETTINGS.enabled).toBe(true);
  const rules = buildRules(DEFAULT_PREVIEW_SETTINGS, BASE);
  expect(rules.map((r) => r.id)).toEqual([1]);
  expect(rules[0]?.action.redirect?.regexSubstitution).toBe(`${BASE}app.html?src=\\0`);
  expect(matches(rules[0]?.condition.regexFilter ?? null, "http://127.0.0.1:8000/data.csv")).toBe(true);
  expect(matches(rules[0]?.condition.regexFilter ?? null, "https://api.test/v1/items.json")).toBe(false);
});

test("buildRules with the defaults makes only the data rule", () => {
  const rules = buildRules(on, BASE);
  expect(rules.map((r) => r.id)).toEqual([1]);
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

test("buildRules fills excludedRequestDomains and never adds a media or CORP rule", () => {
  const rules = buildRules({ ...withMedia, excludedDomains: excluded.excludedDomains }, BASE.slice(0, -1));
  expect(rules.map((r) => r.id)).toEqual([1]);
  expect(rules[0]?.condition.excludedRequestDomains).toEqual(["data.example.org", "cdn.test"]);
  expect(rules[0]?.condition.regexFilter).not.toMatch(/png|jpg|mp4|webm/);
});

test("buildRules with only image or video extensions checked makes no rules", () => {
  expect(buildRules({ enabled: true, extensions: ["png", "mp4", "gz"], excludedDomains: [] }, BASE)).toEqual([]);
});

test("the settings groups hold data formats only", () => {
  expect(Object.keys(PREVIEW_GROUPS)).toEqual(["tables", "jsonLines", "columnar", "databases", "json", "compressed"]);
});

test("legacy rule ids 2 and 3 are still in the removal list", () => {
  expect(LEGACY_RULE_IDS).toEqual([2, 3]);
  expect(PREVIEW_RULE_IDS).toEqual([1, 2, 3]);
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
      extensions: ["csv", "tsv", "psv", "jsonl", "ndjson", "parquet", "arrow", "feather", "duckdb", "sqlite", "db", "json", "gz", "zst"],
      excludedDomains: [],
    },
    BASE,
  );
  for (const r of all) expect((r.condition.regexFilter ?? "").length).toBeLessThan(300);
});

const URL_TABLE: [string, PreviewSettings, "data" | null][] = [
  // S3 presigned Parquet: the query string holds &, %2F and = and must not break the match.
  ["https://my-bucket.s3.us-east-1.amazonaws.com/exports/2024/part-0001.parquet?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20240517%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20240517T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123", on, "data"],
  ["https://storage.googleapis.com/bucket/dir/data.csv?x=1", on, "data"],
  // GCS V4 signed URLs and the Cloud Console's authenticated link.
  ["https://storage.googleapis.com/my-bucket/exports/2026/10/report_2026-10-29.csv?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=svc%40proj.iam.gserviceaccount.com%2F20261029%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date=20261029T120000Z&X-Goog-Expires=900&X-Goog-SignedHeaders=host&X-Goog-Signature=0a1b2c", on, "data"],
  ["https://storage.googleapis.com/my-bucket/exports/2026/10/report_2026-10-29.csv.gz?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=svc%40proj.iam.gserviceaccount.com%2F20261029%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date=20261029T120000Z&X-Goog-Expires=900&X-Goog-SignedHeaders=host&X-Goog-Signature=0a1b2c", on, "data"],
  ["https://storage.cloud.google.com/my-bucket/exports/report.csv?authuser=1", on, "data"],
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
  ["https://example.com/movie.mp4", withMedia, null],
  ["https://example.com/photo.png", withMedia, null],
  ["https://example.com/a.csv", withMedia, "data"],
  ["https://data.example.org/a.csv", excluded, null],
  ["https://sub.data.example.org/a.csv", excluded, null],
  ["https://img.cdn.test/a.csv", excluded, null],
  ["https://example.org/a.csv", excluded, "data"],
  ["https://notdata.example.org/a.csv", excluded, "data"],
];

test.each(URL_TABLE)("classifyUrl(%s) -> %s", (url, settings, expected) => {
  expect(classifyUrl(url, settings)).toBe(expected);
});

test("the generated regexes agree with classifyUrl on the URL table (domain exclusion aside)", () => {
  for (const [url, settings, expected] of URL_TABLE) {
    if (settings === excluded) continue;
    const kind = matches(dataRegex(settings), url) ? "data" : null;
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
  expect(classifyFilename("photo.png", withMedia)).toBeNull();
  expect(classifyFilename("noext", on)).toBeNull();
  expect(classifyMime("text/csv; charset=utf-8", on)).toBe("data");
  expect(classifyMime("application/vnd.apache.parquet", on)).toBe("data");
  expect(classifyMime("application/json", on)).toBeNull();
  expect(classifyMime("image/jpeg", on)).toBeNull();
  expect(classifyMime("image/jpeg", withMedia)).toBeNull();
  expect(classifyMime("video/mp4", withMedia)).toBeNull();
  expect(classifyMime("text/csv", { ...on, enabled: false })).toBeNull();
});

test("normalizeDomain", () => {
  expect(normalizeDomain("https://Data.Example.org:8443/x?y")).toBe("data.example.org");
  expect(normalizeDomain("*.example.com")).toBe("example.com");
  expect(normalizeDomain(".example.com.")).toBe("example.com");
  expect(normalizeDomain("localhost")).toBe("localhost");
  expect(normalizeDomain("not a domain")).toBeNull();
  expect(normalizeDomain("")).toBeNull();
});
