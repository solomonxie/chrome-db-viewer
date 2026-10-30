// What a chain needs from its collection: named queries by id, their templates by path (for
// include/ref), the collection → folder → query script chain, and variable values.

import type { Collection, Folder, NamedQuery, TemplateLibrary } from "../collections/model";
import { activeEnvironment, libraryFromRows, pathOf, resolveVars, scriptChain, valuesOf } from "../collections/store";

export interface ChainLibrary {
  query(id: string): NamedQuery | undefined;
  /** Path ("Folder/Sub/name") of a named query, for display. */
  pathOf(q: NamedQuery): string;
  templates: TemplateLibrary;
  /** Pre scripts in run order (collection → folder → query) and post scripts (query → folder → collection). */
  scripts(q: NamedQuery): { pre: string[]; post: string[] };
  defaultConnectionId?: string;
  /** Collection variable defaults with the active environment applied. */
  vars: Record<string, unknown>;
  /** Active environment values, as scripts see them through db.env. */
  env: Record<string, unknown>;
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
