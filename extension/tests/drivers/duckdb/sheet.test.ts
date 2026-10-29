// Pure helpers: format detection, sheet SQL builders, value formatting.
import { expect, test } from "vitest";
import {
  bytesToBigInt,
  formatBignum,
  formatBit,
  formatBlob,
  formatDate,
  formatDecimal,
  formatInterval,
  formatTime,
  formatTimestamp,
  formatUuid,
} from "../../../src/drivers/duckdb/convert";
import { copyToSql, detectFormat, fileNameOf, frequency, readerSql, saveFormatFor, sortedFiltered, summarize } from "../../../src/drivers/duckdb/sheet";

test("detectFormat: plain, double and unsupported extensions", () => {
  expect(detectFormat("orders.csv")).toEqual({ format: "csv", compression: null, ext: "csv" });
  expect(detectFormat("orders.CSV.GZ")).toEqual({ format: "csv", compression: "gzip", ext: "csv.gz" });
  expect(detectFormat("events.jsonl.zst")).toEqual({ format: "jsonl", compression: "zstd", ext: "jsonl.zst" });
  expect(detectFormat("e.ndjson")?.format).toBe("jsonl");
  expect(detectFormat("t.tsv")?.format).toBe("tsv");
  expect(detectFormat("t.psv")?.format).toBe("psv");
  expect(detectFormat("t.feather")?.format).toBe("arrow");
  expect(detectFormat("https://x.io/a/trips.parquet?X-Amz-Signature=abc#frag")?.format).toBe("parquet");
  expect(detectFormat("https://x.io/my%20data.json")?.format).toBe("json");
  expect(detectFormat("backup.tar.gz")).toBeNull();
  expect(detectFormat("data.gz")).toBeNull();
  expect(detectFormat("README")).toBeNull();
  expect(detectFormat("t.parquet.gz")).toBeNull();
  expect(fileNameOf("https://x.io/a/my%20file.csv?x=1")).toBe("my file.csv");
});

test("readerSql picks the DuckDB reader and options", () => {
  expect(readerSql("o.csv", detectFormat("o.csv")!)).toBe("read_csv_auto('o.csv')");
  expect(readerSql("o.tsv.gz", detectFormat("o.tsv.gz")!)).toBe("read_csv_auto('o.tsv.gz', delim = '\\t', compression = 'gzip')");
  expect(readerSql("e.jsonl", detectFormat("e.jsonl")!)).toBe("read_json_auto('e.jsonl', format = 'newline_delimited')");
  expect(readerSql("it's.parquet", detectFormat("x.parquet")!)).toBe("read_parquet('it''s.parquet')");
});

test("sheet SQL builders", () => {
  expect(frequency("status")).toBe(
    `SELECT "status", count(*) AS "count", round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS "percent" FROM "sheet" GROUP BY "status" ORDER BY "count" DESC, "status" ASC NULLS LAST`,
  );
  expect(frequency("a\"b", ["x > 1", "y = 2"])).toContain(`FROM "sheet" WHERE (x > 1) AND (y = 2) GROUP BY "a""b"`);
  expect(summarize()).toBe(`SUMMARIZE "sheet"`);
  expect(summarize("total > 10")).toBe(`SUMMARIZE SELECT * FROM "sheet" WHERE total > 10`);
  expect(sortedFiltered()).toBe(`SELECT * FROM "sheet"`);
  expect(sortedFiltered("status = 'paid'", [{ column: "total", dir: "desc" }, { column: "id" }], { limit: 100, offset: 200 })).toBe(
    `SELECT * FROM "sheet" WHERE status = 'paid' ORDER BY "total" DESC, "id" ASC LIMIT 100 OFFSET 200`,
  );
  expect(sortedFiltered([], "total DESC")).toBe(`SELECT * FROM "sheet" ORDER BY total DESC`);
  expect(copyToSql("out.csv", "csv")).toBe(`COPY "sheet" TO 'out.csv' (FORMAT csv, HEADER true, use_tmp_file false)`);
  expect(saveFormatFor("a.jsonl")).toBe("jsonl");
  expect(saveFormatFor("a.csv.gz")).toBeNull();
});

test("value formatting follows DuckDB's text output", () => {
  expect(formatDecimal(12345n, 2)).toBe("123.45");
  expect(formatDecimal(-500n, 4)).toBe("-0.0500");
  expect(formatDecimal(7n, 0)).toBe("7");
  expect(formatTimestamp(1704164645123456n, 2, false)).toBe("2024-01-02 03:04:05.123456");
  expect(formatTimestamp(1704067200500000n, 2, false)).toBe("2024-01-01 00:00:00.5");
  expect(formatTimestamp(1704067200000n, 1, true)).toBe("2024-01-01 00:00:00+00");
  expect(formatTimestamp(-1n, 2, false)).toBe("1969-12-31 23:59:59.999999");
  expect(formatTimestamp((1n << 63n) - 1n, 2, false)).toBe("infinity");
  expect(formatDate(19723)).toBe("2024-01-01");
  expect(formatDate(-719528)).toBe("0001-01-01 (BC)");
  expect(formatTime(3723120000n, 2)).toBe("01:02:03.12");
  expect(formatInterval(14, 3, 14706500000000n)).toBe("1 year 2 months 3 days 04:05:06.5");
  expect(formatInterval(0, -3, 0n)).toBe("-3 days");
  expect(formatBlob([0x41, 0x00, 0x5c])).toBe("A\\x00\\x5C");
  expect(formatUuid(Uint8Array.from([0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4, 0xa7, 0x16, 0x44, 0x66, 0x55, 0x44, 0x00, 0x00]))).toBe(
    "550e8400-e29b-41d4-a716-446655440000",
  );
  // Byte layouts as DuckDB-WASM sends them (captured from the engine).
  expect(bytesToBigInt([254, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255], true)).toBe(-2n);
  expect(formatBit([3, 246])).toBe("10110");
  expect(formatBignum([128, 0, 10, 2, 157, 66, 182, 78, 118, 113, 66, 68, 203])).toBe("12345678901234567890123");
  expect(formatBignum([127, 255, 245, 253, 98, 189, 73, 177, 137, 142, 189, 187, 52])).toBe("-12345678901234567890123");
  expect(formatBignum([128, 0, 1, 0])).toBe("0");
});
