// SQL tokenizer for editor highlighting, and formatting via sql-formatter per dialect.

import { format, type SqlLanguage } from "sql-formatter";
import type { SqlDialect } from "@core/types";

export type TokenKind = "kw" | "fn" | "str" | "num" | "com" | "ident" | "param" | "op" | "text";

export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS = new Set(
  (
    "select from where and or not in is null as on join left right inner outer full cross natural using group by order " +
    "having limit offset union all distinct insert into values update set delete create table view index drop alter add " +
    "column primary key foreign references default unique check constraint case when then else end exists between like " +
    "ilike asc desc with recursive returning true false begin commit rollback transaction explain analyze if replace " +
    "temp temporary materialized partition over window rows range unbounded preceding following current row qualify " +
    "struct array unnest except intersect cast safe_cast interval date timestamp time datetime extract format settings " +
    "final prewhere sample array join show describe use database schema grant revoke truncate vacuum copy to lateral " +
    "fetch first next only nulls last filter within"
  ).split(" "),
);

const FUNCTIONS = new Set(
  (
    "count sum avg min max coalesce ifnull nullif round floor ceil abs length lower upper trim substr substring concat " +
    "now current_date current_timestamp date_trunc date_sub date_add date_diff datediff to_char to_date json_value " +
    "json_extract json_query array_agg string_agg row_number rank dense_rank lag lead first_value last_value safe_divide " +
    "regexp_contains regexp_extract regexp_replace split parse_date format_date toDate toStartOfDay uniq uniqExact any " +
    "countIf sumIf avgIf groupArray"
  )
    .split(" ")
    .map((s) => s.toLowerCase()),
);

/** Splits SQL into tokens. Never drops characters: joining every token's text gives the input back. */
export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind && (kind === "text" || kind === "op")) last.text += text;
    else out.push({ kind, text });
  };
  while (i < sql.length) {
    const c = sql[i]!;
    const rest = sql.slice(i);
    let m: RegExpMatchArray | null;
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      const end = nl < 0 ? sql.length : nl;
      push("com", sql.slice(i, end));
      i = end;
    } else if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      const end = close < 0 ? sql.length : close + 2;
      push("com", sql.slice(i, end));
      i = end;
    } else if (c === "'" || c === '"' || c === "`") {
      // Quoted string or identifier; a doubled quote or a backslash escapes.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "\\") j += 2;
        else if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) {
          j++;
          break;
        } else j++;
      }
      push(c === "'" ? "str" : "ident", sql.slice(i, Math.min(j, sql.length)));
      i = Math.min(j, sql.length);
    } else if ((m = rest.match(/^\d+(\.\d+)?([eE][+-]?\d+)?/))) {
      push("num", m[0]);
      i += m[0].length;
    } else if ((m = rest.match(/^(?:\$\d+|@[A-Za-z_]\w*|\?|:[A-Za-z_]\w*|\{[A-Za-z_]\w*:[^}]+\})/))) {
      push("param", m[0]);
      i += m[0].length;
    } else if ((m = rest.match(/^[A-Za-z_][\w$]*/))) {
      const word = m[0];
      const lower = word.toLowerCase();
      const isCall = /^\s*\(/.test(sql.slice(i + word.length));
      push(KEYWORDS.has(lower) && !(isCall && FUNCTIONS.has(lower)) ? "kw" : isCall && FUNCTIONS.has(lower) ? "fn" : "text", word);
      i += word.length;
    } else if (/[=<>!+\-*/%|,;().]/.test(c)) {
      push("op", c);
      i++;
    } else {
      push("text", c);
      i++;
    }
  }
  return out;
}

const LANGUAGE: Record<SqlDialect["name"], SqlLanguage | null> = {
  postgres: "postgresql",
  sqlite: "sqlite",
  duckdb: "duckdb",
  clickhouse: "clickhouse",
  bigquery: "bigquery",
  redis: null,
};

/** Pretty-prints SQL for the connection's dialect. Throws a readable error when it can't parse. */
export function formatSql(sql: string, dialect: SqlDialect["name"]): string {
  const language = LANGUAGE[dialect];
  if (!language) throw new Error("Formatting isn't available for this connection type.");
  try {
    return format(sql, { language, keywordCase: "upper", tabWidth: 2, linesBetweenQueries: 1 });
  } catch (e) {
    throw new Error(`Couldn't format: ${(e as Error).message.split("\n")[0]}`);
  }
}

/**
 * Formats the selection if there is one, else the whole text. Returns the new text and the
 * range the formatted part now covers, so the editor can keep it selected.
 */
export function formatRange(text: string, start: number, end: number, dialect: SqlDialect["name"]): { text: string; start: number; end: number } {
  if (end > start) {
    const leading = text.slice(start, end).match(/^\s*/)![0];
    const trailing = text.slice(start, end).match(/\s*$/)![0];
    const formatted = formatSql(text.slice(start, end), dialect);
    const next = text.slice(0, start) + leading + formatted + trailing + text.slice(end);
    return { text: next, start: start + leading.length, end: start + leading.length + formatted.length };
  }
  const formatted = formatSql(text, dialect);
  return { text: formatted, start: 0, end: formatted.length };
}
