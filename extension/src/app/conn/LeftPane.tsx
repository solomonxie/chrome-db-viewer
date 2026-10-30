// Left pane: Items (lazy object tree with search highlight and type filter), Collections (named
// queries: Postman-style), Workflows (multi-step pipelines: dbt-style), and History.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ObjectNode, ObjectPath, ObjectType } from "@core/types";
import * as db from "../store/db";
import { fmtAgo, fmtMs } from "../lib/format";
import { Highlight } from "../components/ui";
import { pathKey, type ConnCtx } from "./model";
import { Icon } from "../components/Icon";
import { isFavorite, loadFavorites, saveFavorites, toggleFavorite, type Favorite } from "../lib/favorites";
import type { NamedQuery } from "../../collections/model";
import { CollectionsTree } from "../collections/CollectionsTree";
import { WorkflowsList } from "../chains/WorkflowsList";
import { SaveAsNamedQuery } from "../collections/SaveAsNamedQuery";
import { ContextMenu } from "../components/ui";
import { Chevron, KindIcon, PaneTabs } from "../components/TreeRow";

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
  const [tab, setTab] = useState<PaneTabKey>("items");
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

  // Initial load: root, and auto-expand single containers (one schema, Tables group) like TablePlus.
  useEffect(() => {
    let cancelled = false;
    setTree({ children: new Map(), expanded: new Set(), loading: new Set(), errors: new Map() });
    (async () => {
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
  }, [load, props.refreshKey]);

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

  const needle = q.trim().toLowerCase();

  // With a search, show loaded nodes whose name (or a descendant's) matches; unmatched branches hide.
  const matches = useCallback(
    (n: ObjectNode): boolean => {
      if (!needle) return true;
      if (n.name.toLowerCase().includes(needle)) return true;
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
            <Highlight text={n.name} needle={needle} />
          </span>
          {n.meta && <span className="meta">{n.meta}</span>}
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

  return (
    <div className="pane-left">
      <PaneTabs
        tabs={TAB_KEYS.map((t) => ({ key: t, label: TAB_LABEL[t], icon: TAB_ICON[t], hint: TAB_HINT[t] }))}
        value={tab}
        onChange={setTab}
      />
      {tab === "items" && (
        <>
          <div className="psearch">
            <Icon name="search" className="ico psearch-ico" />
            <input placeholder="Search items" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQ("")} aria-label="Search items" />
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
              favorites={favorites.filter((f) => !needle || f.name.toLowerCase().includes(needle))}
              activePath={props.activePath}
              needle={needle}
              onOpen={props.onOpen}
              onUnstar={star}
            />
            {renderLevel([], 0)}
          </div>
        </>
      )}
      {tab === "collections" && <CollectionsTree onOpenQuery={(q) => props.onOpenNamedQuery?.(q)} activeQueryId={props.activeNamedQueryId} toast={ctx.toast} />}
      {tab === "workflows" && <WorkflowsList toast={ctx.toast} />}
      {tab === "history" && (
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
      )}
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
            <Highlight text={f.name} needle={props.needle} />
          </span>
          <StarToggle on name={f.name} onToggle={() => props.onUnstar(f)} />
        </button>
      ))}
    </div>
  );
}

// Collections and Workflows are separate tabs: one holds reusable named queries, the other
// pipelines built from them. The tab strip collapses labels to icons when the pane is narrow.
const TAB_KEYS = ["items", "collections", "workflows", "history"] as const;
type PaneTabKey = (typeof TAB_KEYS)[number];
const TAB_LABEL = { items: "Items", collections: "Collections", workflows: "Workflows", history: "History" } as const;
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
