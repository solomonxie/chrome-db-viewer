// Streaming parser for ClickHouse's JSONCompactEachRowWithNamesAndTypes (design/DESIGN.md §3.9).
// Line 1: column names. Line 2: types. Then one JSON array per row.
//
// Errors after the 200 header arrive inside the body. ClickHouse 24.11+ wraps them as
//   \r\n__exception__\r\n<tag>\r\n<message>\r\n<len> <tag>\r\n__exception__\r\n
// and older servers append a bare "Code: 123. DB::Exception: …" line. Both become DriverError.

import { DriverError } from "@core/types";

export type StreamEvent =
  | { kind: "header"; names: string[]; types: string[] }
  | { kind: "rows"; rows: unknown[][] };

/** Splits a byte stream into text lines without holding the whole body. Handles \r\n. */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  const strip = (s: string) => (s.endsWith("\r") ? s.slice(0, -1) : s);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let start = 0;
      let nl = buf.indexOf("\n", start);
      while (nl >= 0) {
        yield strip(buf.slice(start, nl));
        start = nl + 1;
        nl = buf.indexOf("\n", start);
      }
      buf = buf.slice(start);
    }
    buf += decoder.decode();
    if (buf) yield strip(buf);
  } finally {
    reader.releaseLock();
  }
}

/** Parses "Code: 60. DB::Exception: … (UNKNOWN_TABLE) (version …)" into a DriverError. */
export function exceptionToError(text: string): DriverError {
  const msg = text.trim();
  const code = /Code:\s*(\d+)/.exec(msg)?.[1];
  const name = /\(([A-Z_0-9]+)\)\s*\(version/.exec(msg)?.[1];
  return new DriverError(msg, name ?? (code ? `CH${code}` : undefined), { clickhouseCode: code ? Number(code) : undefined });
}

/**
 * Yields the header once, then batches of up to `batchSize` raw JSON rows.
 * Throws DriverError if the server reports an exception mid-stream.
 */
export async function* parseCompactStream(
  lines: AsyncIterable<string>,
  batchSize: number,
): AsyncGenerator<StreamEvent, void, void> {
  let names: string[] | null = null;
  let types: string[] | null = null;
  let batch: unknown[][] = [];
  let exception: string[] | null = null;

  for await (const line of lines) {
    if (exception) {
      if (line === "__exception__") break;
      exception.push(line);
      continue;
    }
    if (line === "") continue;
    if (line === "__exception__") {
      exception = [];
      continue;
    }
    if (line.startsWith("Code: ") && line.includes("Exception")) {
      exception = [line];
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new DriverError(`Unexpected line in ClickHouse response: ${line.slice(0, 200)}`, "bad_response");
    }
    if (!Array.isArray(parsed)) throw new DriverError("Expected one JSON array per line", "bad_response");
    if (!names) {
      names = parsed as string[];
    } else if (!types) {
      types = parsed as string[];
      yield { kind: "header", names, types };
    } else {
      batch.push(parsed);
      if (batch.length >= batchSize) {
        yield { kind: "rows", rows: batch };
        batch = [];
      }
    }
  }
  if (exception) {
    // New format: [tag, ...message lines, "<len> <tag>"]. Old format: [message].
    const tagged = exception.length >= 3 && /^\d+ \S+$/.test(exception[exception.length - 1] ?? "");
    throw exceptionToError((tagged ? exception.slice(1, -1) : exception).join("\n"));
  }
  if (batch.length) yield { kind: "rows", rows: batch };
}
