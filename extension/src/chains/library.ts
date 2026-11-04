// What a workflow needs from the collections: named queries by id, their templates by path (for
// include/ref), each query's collection → folder → query script chain, and variable values.
// Workflows don't belong to a collection (DESIGN.md §3.15): a query step can use a named query
// from any collection, and that query brings its own collection's variables, environment and
// scripts. buildLibrary is one collection; buildGlobalLibrary is all of them.

import type { Collection, Folder, NamedQuery, TemplateLibrary } from "../collections/model";
import { activeEnvironment, libraryFromRows, pathOf, resolveVars, scriptChain, valuesOf } from "../collections/store";

export interface ChainLibrary {
  query(id: string): NamedQuery | undefined;
  /** Path ("Folder/Sub/name") of a named query, for display. */
  pathOf(q: NamedQuery): string;
  templates: TemplateLibrary;
  /** Pre scripts in run order (collection → folder → query) and post scripts (query → folder → collection). */
  scripts(q: NamedQuery): { pre: string[]; post: string[] };
  /** The connection a named query's collection defaults to. */
  defaultConnectionId?: string;
  connectionFor?(q: NamedQuery): string | undefined;
  /** Variable defaults every step sees (one collection's, with its active environment; {} for all). */
  vars: Record<string, unknown>;
  /** Variables a named query's own collection adds, with its active environment applied. */
  varsFor?(q: NamedQuery): Record<string, unknown>;
  /** Active environment values, as scripts see them through db.env. */
  env: Record<string, unknown>;
  envFor?(q: NamedQuery): Record<string, unknown>;
}

export const EMPTY_LIBRARY: ChainLibrary = {
  query: () => undefined,
  pathOf: (q) => q.name,
  templates: { resolve: () => undefined },
  scripts: () => ({ pre: [], post: [] }),
  vars: {},
  env: {},
};

export function buildLibrary(collection: Collection | undefined, folders: Folder[], queries: NamedQuery[]): ChainLibrary {
  const byId = new Map(queries.map((q) => [q.id, q]));
  const templates = libraryFromRows(folders, queries);
  return {
    query: (id) => byId.get(id),
    pathOf: (q) => pathOf(q, folders),
    templates,
    scripts: (q) => scriptChain(collection, folders, q),
    defaultConnectionId: collection?.defaultConnectionId,
    vars: valuesOf(resolveVars({ collection })),
    env: { ...(activeEnvironment(collection)?.values ?? {}) },
  };
}

/**
 * Every collection's named queries in one library. Template paths are "<Collection>/<folder…>/<name>",
 * and also the bare "<folder…>/<name>" when only one collection has that path.
 */
export function buildGlobalLibrary(bundles: { collection: Collection; folders: Folder[]; queries: NamedQuery[] }[]): ChainLibrary {
  const per = new Map(bundles.map((b) => [b.collection.id, { b, lib: buildLibrary(b.collection, b.folders, b.queries) }]));
  const byId = new Map(bundles.flatMap((b) => b.queries.map((q) => [q.id, q] as const)));
  const of = (q: NamedQuery) => per.get(q.collectionId);
  const bare = new Map<string, string[]>();
  for (const { b } of per.values()) for (const q of b.queries) {
    const p = pathOf(q, b.folders);
    bare.set(p, [...(bare.get(p) ?? []), b.collection.id]);
  }
  return {
    query: (id) => byId.get(id),
    pathOf: (q) => {
      const e = of(q);
      return e ? `${e.b.collection.name}/${e.lib.pathOf(q)}` : q.name;
    },
    templates: {
      resolve: (path) => {
        const p = path.replace(/^\/+|\/+$/g, "");
        const owners = bare.get(p);
        if (owners?.length === 1) return per.get(owners[0]!)!.lib.templates.resolve(p);
        for (const { b, lib } of per.values()) {
          const prefix = b.collection.name + "/";
          if (p.startsWith(prefix)) {
            const t = lib.templates.resolve(p.slice(prefix.length));
            if (t !== undefined) return t;
          }
        }
        return undefined;
      },
    },
    scripts: (q) => of(q)?.lib.scripts(q) ?? { pre: [], post: [] },
    connectionFor: (q) => of(q)?.lib.defaultConnectionId,
    vars: {},
    varsFor: (q) => of(q)?.lib.vars ?? {},
    env: {},
    envFor: (q) => of(q)?.lib.env ?? {},
  };
}
