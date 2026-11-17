// Schema search (DESIGN.md §3.3): the search box's text is split into lower-case terms at spaces
// and dots, and each must appear in "parent.name". "-" and "_" count as the same character, since
// BigQuery dataset names can't hold "-" but people paste ids with them (a UUID-named dataset).
// "et_v2 annotated_visits" and "et_v2.annotated" both find et_v2__x.mart__annotated_visits.

import type { ObjectNode } from "./types";

/** Most hits a search shows. */
export const SEARCH_LIMIT = 200;

const norm = (s: string) => s.toLowerCase().replace(/-/g, "_");

export function searchTerms(needle: string): string[] {
  return norm(needle)
    .split(/[\s.]+/)
    .filter(Boolean);
}

/** True when every term appears in "parent.name". */
export function matchesTerms(parent: string, name: string, terms: string[]): boolean {
  const hay = norm(`${parent}.${name}`);
  return terms.every((t) => hay.includes(t));
}

/** The catalog's objects matching the search text (`meta` is where each one lives). */
export function searchCatalog(objects: ObjectNode[], needle: string, limit = SEARCH_LIMIT): ObjectNode[] {
  const terms = searchTerms(needle);
  if (!terms.length) return [];
  const out: ObjectNode[] = [];
  for (const n of objects) {
    if (matchesTerms(n.meta ?? "", n.name, terms)) out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}
