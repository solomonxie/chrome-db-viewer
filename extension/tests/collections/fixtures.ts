// Loads the collection fixture; "@templates/x.sql" in a query's sql reads that template file.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Collection, Folder, NamedQuery } from "../../src/collections/model";

const DIR = resolve(__dirname, "../fixtures/collections");

export const readFixture = (name: string) => readFileSync(resolve(DIR, name), "utf8");
export const template = (name: string) => readFixture(`templates/${name}.sql`);

export function loadCollectionFixture(): { collection: Collection; folders: Folder[]; queries: NamedQuery[] } {
  const raw = JSON.parse(readFixture("ad-performance.json")) as { collection: Collection; folders: Folder[]; queries: NamedQuery[] };
  const queries = raw.queries.map((q) => (q.sql.startsWith("@") ? { ...q, sql: readFixture(q.sql.slice(1)) } : q));
  return { ...raw, queries };
}
