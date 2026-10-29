// Left pane: Items (lazy object tree with search highlight and type filter), Queries, History.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ObjectNode, ObjectPath, ObjectType } from "@core/types";
import * as db from "../store/db";
import { fmtAgo, fmtMs } from "../lib/format";
import { Highlight } from "../components/ui";
import { pathKey, type ConnCtx } from "./model";

const ICON: Partial<Record<ObjectType, string>> = {
  database: "◫", schema: "◇", group: "", table: "▦", view: "◰", materialized_view: "◲",
  function: "ƒ", dictionary: "▤", dataset: "◫", key: "⚿", file: "▤",
};
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
  historyVersion: number;
  refreshKey: number;
}) {
  const { ctx } = props;
  const { driver, nodeTypes } = ctx;
  const [tab, setTab] = useState<"items" | "queries" | "history">("items");
  const [q, setQ] = useState("");
  const [hidden, setHidden] = useState<Set<ObjectType>>(new Set());
  const [showTypeMenu, setShowTypeMenu] = useState(false);
  const [tree, setTree] = useState<TreeState>({ children: new Map(), expanded: new Set(), loading: new Set(), errors: new Map() });

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
          className={"node" + (active ? " active" : "") + (n.type === "group" ? " grp" : "")}
          style={{ paddingLeft: 6 + depth * 12 }}
          onClick={(e) => (openable ? props.onOpen(n.path, e.altKey || e.metaKey) : n.hasChildren && toggle(n))}
          onDoubleClick={() => openable && n.hasChildren && toggle(n)}
          title={n.path.join(".")}
          role="treeitem"
          aria-expanded={n.hasChildren ? open : undefined}
        >
          <span
            className="tw"
            onClick={(e) => {
              if (n.hasChildren) {
                e.stopPropagation();
                toggle(n);
              }
            }}
          >
            {n.hasChildren ? (tree.loading.has(nk) ? "…" : open ? "▾" : "▸") : ""}
          </span>
          {ICON[n.type] && <span className="faint">{ICON[n.type]}</span>}
          <span className="nm">
            <Highlight text={n.name} needle={needle} />
          </span>
          {n.meta && <span className="meta">{n.meta}</span>}
        </button>,
      );
      if (open) out.push(...renderLevel(n.path, depth + 1));
      const err = tree.errors.get(nk);
      if (err && open) {
        out.push(
          <div key={nk + ":err"} className="err" style={{ margin: "2px 6px 2px " + (18 + depth * 12) + "px" }}>
            {err}
          </div>,
        );
      }
    }
    return out;
  };

  return (
    <div className="pane-left">
      <div className="ptabs" role="tablist">
        {(["items", "queries", "history"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === "items" && (
        <>
          <div className="psearch">
            <input placeholder="Search items" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQ("")} aria-label="Search items" />
            {q && (
              <button className="btn icon ghost" onClick={() => setQ("")} title="Clear">
                ⊗
              </button>
            )}
            <button className="btn icon ghost" title="Object types" aria-pressed={hidden.size > 0} onClick={() => setShowTypeMenu(!showTypeMenu)}>
              ☰
            </button>
          </div>
          {showTypeMenu && (
            <div style={{ padding: "0 10px 6px", display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
              {TYPE_FILTERS.map((f) => (
                <label key={f.type} style={{ display: "flex", gap: 6 }}>
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
            {renderLevel([], 0)}
          </div>
        </>
      )}
      {tab === "queries" && <QueriesList connectionId={ctx.cfg.id} onOpen={props.onOpenSql} version={props.historyVersion} />}
      {tab === "history" && <HistoryList connectionId={ctx.cfg.id} onOpen={props.onOpenSql} version={props.historyVersion} />}
    </div>
  );
}

function QueriesList({ connectionId, onOpen, version }: { connectionId: string; onOpen: (sql: string, title?: string) => void; version: number }) {
  const [rows, setRows] = useState<db.SavedQuery[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => {
    db.getAll("queries")
      .then((all) => setRows(all.filter((r) => r.connectionId === connectionId).sort((a, b) => b.updatedAt - a.updatedAt)))
      .catch(() => setRows([]));
  }, [connectionId, version]);
  const hits = rows.filter((r) => (r.name + r.sql).toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="psearch">
        <input placeholder="Search queries" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search queries" />
      </div>
      <div className="hlist">
        {hits.length === 0 && <div className="empty">No saved queries. Save one from a query tab.</div>}
        {hits.map((r) => (
          <button key={r.id} className="hitem" onClick={() => onOpen(r.sql, r.name)}>
            <b style={{ fontSize: 12 }}>{r.name}</b>
            <code>{r.sql}</code>
            <small>{fmtAgo(r.updatedAt)}</small>
          </button>
        ))}
      </div>
    </>
  );
}

function HistoryList({ connectionId, onOpen, version }: { connectionId: string; onOpen: (sql: string) => void; version: number }) {
  const [rows, setRows] = useState<db.HistoryEntry[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => {
    db.historyFor(connectionId).then(setRows, () => setRows([]));
  }, [connectionId, version]);
  const hits = useMemo(() => rows.filter((r) => r.sql.toLowerCase().includes(q.toLowerCase())), [rows, q]);
  return (
    <>
      <div className="psearch">
        <input placeholder="Search history" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search history" />
      </div>
      <div className="hlist">
        {hits.length === 0 && <div className="empty">Nothing run yet.</div>}
        {hits.map((r) => (
          <button key={r.id} className={"hitem" + (r.error ? " error" : "")} onClick={() => onOpen(r.sql)} title={r.error ?? r.sql}>
            <code>
              <Highlight text={r.sql.replace(/\s+/g, " ")} needle={q} />
            </code>
            <small>
              {new Date(r.at).toLocaleTimeString()}
              {r.ms !== undefined && ` · ${fmtMs(r.ms)}`}
              {r.rows !== undefined && ` · ${r.rows} rows`}
              {r.error && " · error"}
            </small>
          </button>
        ))}
      </div>
    </>
  );
}
