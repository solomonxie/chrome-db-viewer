// Editor highlighting for templates: SQL colours from the SQL tokenizer, with Jinja tags drawn
// on top. Jinja tags are blanked out before SQL tokenizing (same length), so a tag inside a
// quoted string doesn't throw off where the string ends.

import { tokenize } from "../app/lib/sqlFormat";
import { riskyExpressions } from "./render";

export interface HlToken {
  /** SQL kinds (kw, str …) or "jinja", "jinja-com", "jinja-warn". */
  kind: string;
  text: string;
  title?: string;
}

const TAG = /\{\{[\s\S]*?(?:\}\}|$)|\{%[\s\S]*?(?:%\}|$)|\{#[\s\S]*?(?:#\}|$)/g;

/** Tokens for a Jinja + SQL template. Joining every token's text gives the input back. */
export function tokenizeTemplate(text: string): HlToken[] {
  const tags: { start: number; end: number; kind: string; title?: string }[] = [];
  const risky = riskyExpressions(text);
  let m: RegExpExecArray | null;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(text))) {
    if (m[0].length === 0) {
      TAG.lastIndex++;
      continue;
    }
    const start = m.index;
    const r = risky.find((x) => x.start === start);
    tags.push({ start, end: start + m[0].length, kind: m[0].startsWith("{#") ? "jinja-com" : r ? "jinja-warn" : "jinja", title: r?.message });
  }
  if (tags.length === 0) return tokenize(text);

  let masked = "";
  let last = 0;
  for (const t of tags) {
    masked += text.slice(last, t.start) + text.slice(t.start, t.end).replace(/[^\n]/g, " ");
    last = t.end;
  }
  masked += text.slice(last);

  const out: HlToken[] = [];
  let pos = 0;
  let cur = 0;
  let ti = 0;
  for (const tok of tokenize(masked)) {
    const tokEnd = pos + tok.text.length;
    let c = Math.max(cur, pos);
    while (c < tokEnd) {
      const tag = tags[ti];
      if (tag && c >= tag.start) {
        out.push({ kind: tag.kind, text: text.slice(tag.start, tag.end), title: tag.title });
        c = tag.end;
        ti++;
        continue;
      }
      const stop = tag ? Math.min(tokEnd, tag.start) : tokEnd;
      out.push({ kind: tok.kind, text: text.slice(c, stop) });
      c = stop;
    }
    cur = c;
    pos = tokEnd;
  }
  // A tag at the very end that the SQL tokens didn't reach (all whitespace merged away).
  for (; ti < tags.length; ti++) {
    const tag = tags[ti]!;
    if (tag.start >= cur) out.push({ kind: tag.kind, text: text.slice(tag.start, tag.end), title: tag.title });
  }
  return out;
}
