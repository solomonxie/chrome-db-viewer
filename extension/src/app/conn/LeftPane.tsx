// Left pane: Schema (lazy object tree with search highlight and type filter), Collections (named
// queries: Postman-style), Workflows (multi-step pipelines: dbt-style), and History.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ObjectNode, ObjectPath, ObjectType } from "@core/types";
import * as db from "../store/db";
import { readSchemaCache, writeSchemaCache } from "../store/schemaCache";
import { fmtAgo, fmtMs } from "../lib/format";
import { Highlight } from "../components/ui";
import { fuzzyMatch } from "../lib/fuzzy";
import { searchCatalog } from "@core/search";
import { CATALOG_MAX_AGE_MS, readSchemaCatalog, writeSchemaCatalog } from "../store/schemaCatalog";
import { roundedMeta } from "../lib/approxCount";
import { pathKey, type ConnCtx } from "./model";
import { Icon } from "../components/Icon";
import { isFavorite, loadFavorites, saveFavorites, toggleFavorite, type Favorite } from "../lib/favorites";
import type { NamedQuery } from "../../collections/model";
import { CollectionsTree } from "../collections/CollectionsTree";
import { WorkflowsList } from "../chains/WorkflowsList";
import { SaveAsNamedQuery } from "../collections/SaveAsNamedQuery";
import { ContextMenu } from "../components/ui";
import { Chevron, KindIcon, PaneSections } from "../components/TreeRow";

const OPENABLE = new Set<ObjectType>(["table", "view", "materialized_view", "dictionary", "file", "key"]);
const TYPE_FILTERS: { type: ObjectType; label: string }[] = [
  { type: "table", label: "Tables" },
  { type: "view", label: "Views" },
  { type: "materialized_view", label: "Materialized views" },
  { type: "function", label: "Functions" },
  { type: "dictionary", label: "Dictionaries" },
];

interface TreeState {
  children: Map<string, ObjectNode[]>;
  expanded: Set<string>;
  loading: Set<string>;
  errors: Map<string, string>;
}

export function LeftPane(props: {
  ctx: ConnCtx;
  activePath: ObjectPath | null;
  onOpen: (path: ObjectPath, newTab: boolean) => void;
  onOpenSql: (sql: string, title?: string) => void;
  /** History clicks; reuses a tab instead of opening a new one each time. */
  onOpenHistory?: (sql: string) => void;
  historyVersion: number;
  refreshKey: number;
  /** Collections tab: open a named query in a query tab bound to it. */
  onOpenNamedQuery?: (q: NamedQuery) => void;
  activeNamedQueryId?: string;
}) {
  const { ctx } = props;
  const { driver, nodeTypes } = ctx;
  const [tab, setTab] = useState<PaneTabKey | null>("items");
  const [q, setQ] = useState("");
  const [hidden, setHidden] = useState<Set<ObjectType>>(new Set());
  const [showTypeMenu, setShowTypeMenu] = useState(false);
  const [tree, setTree] = useState<TreeState>({ children: new Map(), expanded: new Set(), loading: new Set(), errors: new Map() });
  const [favorites, setFavorites] = useState<Favorite[]>([]);

  useEffect(() => {
    let cancelled = false;
    loadFavorites(ctx.cfg.id).then((f) => !cancelled && setFavorites(f), () => !cancelled && setFavorites([]));
    return () => {
      cancelled = true;
    };
  }, [ctx.cfg.id]);

  const star = (n: Pick<ObjectNode, "path" | "name" | "type">) => {
    setFavorites((list) => {
      const next = toggleFavorite(list, n);
      void saveFavorites(ctx.cfg.id, next);
      return next;
    });
  };

  const load = useCallback(
    async (parent: ObjectPath) => {
      const k = pathKey(parent);
      setTree((t) => ({ ...t, loading: new Set(t.loading).add(k) }));
      try {
        const nodes = await driver.listObjects(parent);
        for (const n of nodes) nodeTypes.set(pathKey(n.path), n.type);
        setTree((t) => {
          const children = new Map(t.children).set(k, nodes);
          const loading = new Set(t.loading);
          loading.delete(k);
          const errors = new Map(t.errors);
          errors.delete(k);
          return { ...t, children, loading, errors };
        });
        return nodes;
      } catch (e) {
        setTree((t) => {
          const loading = new Set(t.loading);
          loading.delete(k);
          return { ...t, loading, errors: new Map(t.errors).set(k, (e as Error).message) };
        });
        return [];
      }
    },
    [driver, nodeTypes],
  );

  // Open: show the items cached from the last visit right away, then reload them in the
  // background (the root and every open branch) and swap in the fresh lists. With nothing cached:
  // load the root and auto-expand single containers (one schema, Tables group) like TablePlus.
  const cacheReady = useRef(false);
  useEffect(() => {
    let cancelled = false;
    cacheReady.current = false;
    (async () => {
      const cached = await readSchemaCache(ctx.cfg.id);
      if (cancelled) return;
      if (cached?.children[pathKey([])]) {
        const children = new Map(Object.entries(cached.children));
        for (const nodes of children.values()) for (const n of nodes) nodeTypes.set(pathKey(n.path), n.type);
        setTree({ children, expanded: new Set(cached.expanded), loading: new Set(), errors: new Map() });
        cacheReady.current = true;
        // Root first, then the open branches, each replacing its cached list when it arrives.
        const open = cached.expanded.filter((k) => children.has(k));
        await load([]);
        await Promise.all(open.map((k) => load(JSON.parse(k) as ObjectPath)));
        if (cancelled) return;
        // Branches cached but folded are dropped, so opening one loads it fresh.
        setTree((t) => ({ ...t, children: new Map([...t.children].filter(([k]) => k === pathKey([]) || t.expanded.has(k))) }));
        return;
      }
      setTree({ children: new Map(), expanded: new Set(), loading: new Set(), errors: new Map() });
      cacheReady.current = true;
      let level = await load([]);
      const expand: string[] = [];
      for (let depth = 0; depth < 3 && !cancelled; depth++) {
        const containers = level.filter((n) => n.hasChildren);
        const next = containers.length === 1 ? containers[0] : containers.find((n) => n.type === "group" && /tables/i.test(n.name));
        if (!next) break;
        expand.push(pathKey(next.path));
        level = await load(next.path);
      }
      if (!cancelled) setTree((t) => ({ ...t, expanded: new Set([...t.expanded, ...expand]) }));
    })();
    return () => {
      cancelled = true;
    };
  }, [load, props.refreshKey, ctx.cfg.id, nodeTypes]);

  // Keep the cache in step with what's loaded and open (debounced).
  useEffect(() => {
    if (!cacheReady.current || !tree.children.has(pathKey([]))) return;
    const t = setTimeout(() => void writeSchemaCache(ctx.cfg.id, tree.children, tree.expanded), 500);
    return () => clearTimeout(t);
  }, [tree.children, tree.expanded, ctx.cfg.id]);

  const toggle = (n: ObjectNode) => {
    const k = pathKey(n.path);
    const open = tree.expanded.has(k);
    setTree((t) => {
      const expanded = new Set(t.expanded);
      if (open) expanded.delete(k);
      else expanded.add(k);
      return { ...t, expanded };
    });
    if (!open && !tree.children.has(k)) void load(n.path);
  };

  // A dataset found by search: load its ancestors and it, expand them, and clear the search.
  const reveal = async (path: ObjectPath) => {
    const keys: string[] = [];
    for (let i = 1; i <= path.length; i++) {
      const p = path.slice(0, i);
      keys.push(pathKey(p));
      if (!tree.children.has(pathKey(p))) await load(p);
    }
    setTree((t) => ({ ...t, expanded: new Set([...t.expanded, ...keys]) }));
    setQ("");
  };

  const needle = q.trim().toLowerCase();
  const catalog = useCatalog(ctx, props.refreshKey);
  const catalogHits = useMemo(() => searchCatalog(catalog.objects, needle), [catalog.objects, needle]);
  // Hits already in the loaded tree show there; the rest go under "In the database".
  const loadedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const nodes of tree.children.values()) for (const n of nodes) keys.add(pathKey(n.path));
    return keys;
  }, [tree.children]);

  // With a search, show loaded nodes whose name (or a descendant's) matches; unmatched branches hide.
  const matches = useCallback(
    (n: ObjectNode): boolean => {
      if (!needle) return true;
      if (fuzzyMatch(n.name, needle)) return true;
      return (tree.children.get(pathKey(n.path)) ?? []).some(matches);
    },
    [needle, tree.children],
  );

  const renderLevel = (parent: ObjectPath, depth: number): React.ReactNode[] => {
    const k = pathKey(parent);
    const nodes = tree.children.get(k) ?? [];
    const out: React.ReactNode[] = [];
    for (const n of nodes) {
      if (hidden.has(n.type)) continue;
      if (!matches(n)) continue;
      const nk = pathKey(n.path);
      const open = tree.expanded.has(nk) || (!!needle && n.hasChildren && tree.children.has(nk));
      const active = props.activePath && pathKey(props.activePath) === nk;
      const openable = OPENABLE.has(n.type);
      out.push(
        <button
          key={nk}
          className={"node k-" + n.type + (active ? " active" : "") + (n.type === "group" ? " grp" : "")}
          style={{ paddingLeft: 4 + depth * 14, ["--depth" as string]: depth }}
          onClick={(e) => (openable ? props.onOpen(n.path, e.altKey || e.metaKey) : n.hasChildren && toggle(n))}
          onDoubleClick={() => openable && n.hasChildren && toggle(n)}
          onKeyDown={(e) => {
            if (openable && e.key.toLowerCase() === "f" && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              star(n);
            }
          }}
          title={n.path.join(".") + (openable ? " · F to star" : "")}
          role="treeitem"
          aria-expanded={n.hasChildren ? open : undefined}
        >
          <Chevron
            open={open}
            leaf={!n.hasChildren}
            loading={tree.loading.has(nk)}
            onToggle={(e) => {
              if (n.hasChildren) {
                e.stopPropagation();
                toggle(n);
              }
            }}
          />
          <KindIcon type={n.type} />
          <span className="nm">
            <Highlight text={n.name} needle={needle} fuzzy />
          </span>
          {n.meta && (
            <span className="meta" title={/^~?\d+$/.test(n.meta) ? `About ${Number(n.meta.replace("~", "")).toLocaleString()} rows (estimate)` : undefined}>
              {roundedMeta(n.meta, n.type)}
            </span>
          )}
          {openable && <StarToggle on={isFavorite(favorites, n.path)} name={n.name} onToggle={() => star(n)} />}
        </button>,
      );
      if (open) out.push(...renderLevel(n.path, depth + 1));
      const err = tree.errors.get(nk);
      if (err && open) {
        out.push(
          <div key={nk + ":err"} className="err" style={{ margin: "2px 6px 2px " + (22 + depth * 14) + "px" }}>
            {err}
          </div>,
        );
      }
    }
    return out;
  };

  const bodies: Record<PaneTabKey, React.ReactNode> = {
    items: (
      <>
        <div className="psearch">
          <Icon name="search" className="ico psearch-ico" />
          <input placeholder="Search schema" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQ("")} aria-label="Search schema" />
          {q && (
            <button className="btn icon ghost" onClick={() => setQ("")} title="Clear" aria-label="Clear search">
              <Icon name="clear" />
            </button>
          )}
          <button className="btn icon ghost" title="Object types" aria-pressed={hidden.size > 0} onClick={() => setShowTypeMenu(!showTypeMenu)} aria-label="Object types">
            <Icon name="filter" />
          </button>
        </div>
        {showTypeMenu && (
          <div className="typefilter">
            {TYPE_FILTERS.map((f) => (
              <label key={f.type}>
                <input
                  type="checkbox"
                  checked={!hidden.has(f.type)}
                  onChange={(e) => {
                    const h = new Set(hidden);
                    if (e.target.checked) h.delete(f.type);
                    else h.add(f.type);
                    setHidden(h);
                  }}
                />
                {f.label}
              </label>
            ))}
          </div>
        )}
        <div className="tree" role="tree">
          {tree.loading.has(pathKey([])) && !tree.children.has(pathKey([])) && <div className="empty">Loading…</div>}
          {tree.errors.get(pathKey([])) && <div className="err">{tree.errors.get(pathKey([]))}</div>}
          <FavoritesSection
            favorites={favorites.filter((f) => !needle || !!fuzzyMatch(f.name, needle))}
            activePath={props.activePath}
            needle={needle}
            onOpen={props.onOpen}
            onUnstar={star}
          />
          {renderLevel([], 0)}
          {needle && driver.listAllObjects && (
          <FoundSection
            catalog={catalog}
            hits={catalogHits.filter((n) => !loadedKeys.has(pathKey(n.path)) && !hidden.has(n.type))}
            total={catalogHits.length}
            activePath={props.activePath}
            needle={needle}
            onOpen={props.onOpen}
            onReveal={reveal}
          />
          )}
        </div>
      </>
    ),
    collections: <CollectionsTree onOpenQuery={(q) => props.onOpenNamedQuery?.(q)} activeQueryId={props.activeNamedQueryId} toast={ctx.toast} />,
    workflows: <WorkflowsList toast={ctx.toast} />,
    history: (
      <HistoryList
        connectionId={ctx.cfg.id}
        onOpen={props.onOpenHistory ?? props.onOpenSql}
        version={props.historyVersion}
        dialect={ctx.driver.dialect.name}
        onSavedNamed={(q) => {
          setTab("collections");
          props.onOpenNamedQuery?.(q);
        }}
      />
    ),
  };

  return (
    <div className="pane-left">
      <PaneSections
        sections={TAB_KEYS.map((t) => ({ key: t, label: TAB_LABEL[t], icon: TAB_ICON[t], hint: TAB_HINT[t], body: bodies[t] }))}
        value={tab}
        onChange={setTab}
      />
    </div>
  );
}

/** Star on a tree row: always shown when starred, on hover otherwise. A span, since rows are buttons. */
function StarToggle({ on, name, onToggle }: { on: boolean; name: string; onToggle: () => void }) {
  return (
    <span
      className={"star" + (on ? " on" : "")}
      role="button"
      aria-pressed={on}
      aria-label={on ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
      title={on ? "Remove from favorites" : "Add to favorites"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <Icon name="star" className="ico sm" />
    </span>
  );
}

function FavoritesSection(props: {
  favorites: Favorite[];
  activePath: ObjectPath | null;
  needle: string;
  onOpen: (path: ObjectPath, newTab: boolean) => void;
  onUnstar: (f: Favorite) => void;
}) {
  if (props.favorites.length === 0) return null;
  const active = props.activePath ? pathKey(props.activePath) : null;
  return (
    <div className="favorites" role="group" aria-label="Favorites">
      <div className="fav-head">Favorites</div>
      {props.favorites.map((f) => (
        <button
          key={pathKey(f.path)}
          className={"node" + (active === pathKey(f.path) ? " active" : "")}
          style={{ paddingLeft: 4 }}
          onClick={(e) => props.onOpen(f.path, e.altKey || e.metaKey)}
          title={f.path.join(".")}
          role="treeitem"
        >
          <Chevron open={false} leaf />
          <KindIcon type={f.type} />
          <span className="nm">
            <Highlight text={f.name} needle={props.needle} fuzzy />
          </span>
          <StarToggle on name={f.name} onToggle={() => props.onUnstar(f)} />
        </button>
      ))}
    </div>
  );
}

interface Catalog {
  /** Every object name, from the last listing (empty until one exists). */
  objects: ObjectNode[];
  /** What the last listing couldn't reach (a project it can't read, a region that failed …). */
  notes: string[];
  /** When it was listed; 0 when never. */
  at: number;
  refreshing: boolean;
  error?: string;
}

/**
 * The connection's object names for the schema search: the saved list right away, refreshed in
 * the background when it's older than CATALOG_MAX_AGE_MS (or missing), and on refresh().
 */
function useCatalog(ctx: ConnCtx, refreshKey: number): Catalog & { refresh: () => void } {
  const { driver, nodeTypes } = ctx;
  const id = ctx.cfg.id;
  const [state, setState] = useState<Catalog>({ objects: [], notes: [], at: 0, refreshing: false });
  const running = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    if (!driver.listAllObjects) return;
    running.current?.abort();
    const ac = new AbortController();
    running.current = ac;
    setState((s) => ({ ...s, refreshing: true, error: undefined }));
    driver.listAllObjects(ac.signal).then(
      ({ objects, notes }) => {
        if (ac.signal.aborted) return;
        const row = { id, objects, notes: notes ?? [], at: Date.now() };
        setState({ ...row, refreshing: false });
        void writeSchemaCatalog(row);
      },
      (e: Error) => !ac.signal.aborted && setState((s) => ({ ...s, refreshing: false, error: e.message })),
    );
  }, [driver, id]);

  useEffect(() => {
    if (!driver.listAllObjects) return;
    let cancelled = false;
    void readSchemaCatalog(id).then((row) => {
      if (cancelled) return;
      if (row) setState({ objects: row.objects, notes: row.notes, at: row.at, refreshing: false });
      if (!row || Date.now() - row.at > CATALOG_MAX_AGE_MS) refresh();
    });
    return () => {
      cancelled = true;
      running.current?.abort();
    };
  }, [driver, id, refresh, refreshKey]);

  // Hits open like tree nodes, so the table tab needs to know their types.
  useEffect(() => {
    for (const n of state.objects) nodeTypes.set(pathKey(n.path), n.type);
  }, [state.objects, nodeTypes]);

  return { ...state, refresh };
}

/** Search hits not already shown in the loaded tree, each with where it lives, and Refresh. */
function FoundSection(props: {
  catalog: Catalog & { refresh: () => void };
  hits: ObjectNode[];
  /** Matches in the catalog, including those the tree shows. */
  total: number;
  activePath: ObjectPath | null;
  needle: string;
  onOpen: (path: ObjectPath, newTab: boolean) => void;
  /** A container hit (a dataset): open its branch in the tree. */
  onReveal: (path: ObjectPath) => void;
}) {
  const { catalog } = props;
  const active = props.activePath ? pathKey(props.activePath) : null;
  const listed = catalog.at > 0;
  let empty = "";
  if (props.hits.length === 0) {
    if (!listed) empty = catalog.refreshing ? "Listing every table…" : "";
    else if (props.total > 0) empty = "All matches are shown above.";
    else if (catalog.refreshing) empty = "No match in the saved names. Still refreshing…";
    else empty = "No other tables or views match.";
  }
  return (
    <div className="favorites found" role="group" aria-label="In the database">
      <div className="fav-head">In the database</div>
      {empty && <div className="empty">{empty}</div>}
      {props.hits.map((n) => (
        <button
          key={pathKey(n.path)}
          className={"node" + (active === pathKey(n.path) ? " active" : "")}
          style={{ paddingLeft: 4 }}
          onClick={(e) => (n.hasChildren ? props.onReveal(n.path) : props.onOpen(n.path, e.altKey || e.metaKey))}
          title={(n.meta ? n.meta + "." : "") + n.name}
          role="treeitem"
        >
          <Chevron open={false} leaf />
          <KindIcon type={n.type} />
          <span className="nm">
            <Highlight text={n.name} needle={props.needle} fuzzy />
          </span>
          {n.meta && <span className="loc">{n.meta}</span>}
        </button>
      ))}
      {catalog.error && <div className="err">Refresh failed: {catalog.error}</div>}
      <div className="catalog-foot">
        <span className="muted">
          {catalog.refreshing ? "Refreshing names…" : listed ? `${catalog.objects.length.toLocaleString()} names · listed ${fmtAgo(catalog.at)}` : ""}
        </span>
        <button className="btn ghost sm" onClick={catalog.refresh} disabled={catalog.refreshing} title="List every table name again">
          Refresh
        </button>
      </div>
    </div>
  );
}

// Collections and Workflows are separate tabs: one holds reusable named queries, the other
// pipelines built from them. Each is a folding section; one is open at a time.
const TAB_KEYS = ["items", "collections", "workflows", "history"] as const;
type PaneTabKey = (typeof TAB_KEYS)[number];
const TAB_LABEL = { items: "Schema", collections: "Collections", workflows: "Workflows", history: "History" } as const;
const TAB_ICON = { items: "items", collections: "collections", workflows: "workflow", history: "history" } as const;
const TAB_HINT = {
  items: "Tables, views and other objects",
  collections: "Named queries in folders, with variables and environments (⌘S in a query tab saves here)",
  workflows: "Multi-step pipelines: queries, local transforms, variables, exports and checks",
  history: "Every statement run on this connection, newest first",
} as const;

function HistoryList({ connectionId, onOpen, version, dialect, onSavedNamed }: { connectionId: string; onOpen: (sql: string) => void; version: number; dialect: ConnCtx["driver"]["dialect"]["name"]; onSavedNamed: (q: NamedQuery) => void }) {
  const [rows, setRows] = useState<db.HistoryEntry[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; sql: string } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [show, setShow] = useState<HistoryFilter>("typed");
  useEffect(() => {
    db.historyFor(connectionId).then(setRows, () => setRows([]));
  }, [connectionId, version]);
  const hits = useMemo(() => filterHistory(rows, show, q), [rows, show, q]);
  return (
    <>
      <div className="psearch">
        <input placeholder="Search history" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search history" />
      </div>
      <div className="seg hseg" role="group" aria-label="Which statements to show">
        {(["typed", "all"] as const).map((v) => (
          <button key={v} aria-pressed={show === v} onClick={() => setShow(v)}>
            {v === "typed" ? "Typed by me" : "All, incl. browsing"}
          </button>
        ))}
      </div>
      <div className="hlist">
        {hits.length === 0 && <div className="empty">{show === "typed" ? "No queries typed yet. Run one in a query tab and it shows up here." : "Nothing run yet."}</div>}
        {hits.map((r) => (
          <button
            key={r.id}
            className={"hitem" + (r.error ? " error" : "")}
            onClick={() => onOpen(r.sql)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, sql: r.sql });
            }}
            title={r.error ?? r.sql}
          >
            <code>
              <Highlight text={r.sql.replace(/\s+/g, " ")} needle={q} />
            </code>
            <small>
              {sourceLabel(r.source)} · {fmtAgo(r.at)}
              {r.ms !== undefined && ` · ${fmtMs(r.ms)}`}
              {r.rows !== undefined && ` · ${r.rows} rows`}
              {r.error && " · error"}
              <span
                className="hsave"
                role="button"
                title="Save to a collection"
                aria-label="Save to a collection"
                onClick={(e) => {
                  e.stopPropagation();
                  setSaving(r.sql);
                }}
              >
                <Icon name="named-query" className="ico sm" /> Save
              </span>
            </small>
          </button>
        ))}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Open", onClick: () => onOpen(menu.sql) },
            { label: "Copy SQL", onClick: () => void navigator.clipboard.writeText(menu.sql) },
            { label: "Save to a collection…", onClick: () => setSaving(menu.sql) },
          ]}
        />
      )}
      {saving !== null && <SaveAsNamedQuery sql={saving} dialect={dialect} connectionId={connectionId} onClose={() => setSaving(null)} onSaved={onSavedNamed} />}
    </>
  );
}

export type HistoryFilter = "typed" | "all";

/** "typed" keeps statements run from a query tab and commits; "all" adds the SELECTs browsing generates. */
export function filterHistory(rows: db.HistoryEntry[], show: HistoryFilter, needle: string): db.HistoryEntry[] {
  const n = needle.toLowerCase();
  return rows.filter((r) => (show === "all" || (r.source ?? "editor") !== "browse") && r.sql.toLowerCase().includes(n));
}

function sourceLabel(source: db.HistorySource | undefined): string {
  return { editor: "Typed", browse: "Browsing", apply: "Commit" }[source ?? "editor"];
}
