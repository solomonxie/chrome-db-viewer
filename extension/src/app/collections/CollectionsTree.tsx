// Left pane "Collections" tab (DESIGN.md §3.14): collections → folders → named queries, with
// new / rename / delete from a context menu, drag a query or folder onto a folder (or the
// collection, for top level), settings, scripts and export/import. Collections hold queries only;
// workflows have their own tab (WorkflowsList).

import { useCallback, useEffect, useState } from "react";
import type { Collection, Folder, NamedQuery } from "../../collections/model";
import {
  createCollection,
  createFolder,
  createQuery,
  deleteCollection,
  deleteFolder,
  deleteQuery,
  exportCollection,
  importCollection,
  listCollections,
  loadBundle,
  moveFolder,
  moveQuery,
  onCollectionsChanged,
  saveCollection,
  saveFolder,
  saveQuery,
  uniqueName,
  type CollectionBundle,
} from "../../collections/store";
import { ContextMenu, Highlight, type MenuItem } from "../components/ui";
import { Icon } from "../components/Icon";
import { Chevron, KindIcon } from "../components/TreeRow";
import { CollectionSettings, ScriptsModal } from "./CollectionSettings";

type DragItem = { kind: "query" | "folder"; id: string; collectionId: string };

const DRAG_MIME = "application/x-dbui-collection-item";

export function CollectionsTree(props: { onOpenQuery: (q: NamedQuery) => void; activeQueryId?: string; toast: (m: string) => void }) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [bundles, setBundles] = useState<Map<string, CollectionBundle>>(new Map());
  const [open, setOpen] = useState<Set<string>>(() => new Set(readOpen()));
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [settings, setSettings] = useState<Collection | null>(null);
  const [scripts, setScripts] = useState<{ title: string; target: Folder | NamedQuery } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => onCollectionsChanged(() => setVersion((v) => v + 1)), []);

  const reload = useCallback(async () => {
    const cs = await listCollections().catch(() => [] as Collection[]);
    setCollections(cs);
    const entries = await Promise.all(cs.map(async (c) => [c.id, await loadBundle(c.id).catch(() => undefined)] as const));
    setBundles(new Map(entries.filter((e): e is [string, CollectionBundle] => !!e[1])));
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, version]);

  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
    writeOpen([...next]);
  };
  const expand = (...ids: string[]) => {
    const next = new Set([...open, ...ids]);
    setOpen(next);
    writeOpen([...next]);
  };

  const newCollection = async () => {
    const name = prompt("New collection name", uniqueName("New collection", collections.map((c) => c.name)));
    if (!name) return;
    const c = await createCollection(name);
    expand("c:" + c.id);
  };
  const newFolder = async (collectionId: string, parentId?: string) => {
    const name = prompt("New folder name", "New folder");
    if (!name) return;
    await createFolder(collectionId, name, parentId);
    expand("c:" + collectionId, ...(parentId ? ["f:" + parentId] : []));
  };
  const newQuery = async (collectionId: string, folderId?: string) => {
    const name = prompt("New query name", "new_query");
    if (!name) return;
    const created = await createQuery(collectionId, name, { folderId, sql: "SELECT *\nFROM {{ table | ident }}\nLIMIT {{ var('limit', 100) }}" });
    expand("c:" + collectionId, ...(folderId ? ["f:" + folderId] : []));
    props.onOpenQuery(created);
  };

  const onDrop = async (e: React.DragEvent, collectionId: string, folderId: string | undefined) => {
    e.preventDefault();
    setDropTarget(null);
    let item: DragItem;
    try {
      item = JSON.parse(e.dataTransfer.getData(DRAG_MIME)) as DragItem;
    } catch {
      return;
    }
    if (item.collectionId !== collectionId) return props.toast("Move between collections isn't supported yet; export and import instead.");
    try {
      if (item.kind === "query") await moveQuery(item.id, folderId);
      else if (item.id !== folderId) await moveFolder(item.id, folderId);
      if (folderId) expand("f:" + folderId);
    } catch (err) {
      props.toast((err as Error).message);
    }
  };
  const dropProps = (key: string, collectionId: string, folderId: string | undefined) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropTarget(key);
    },
    onDragLeave: () => setDropTarget((t) => (t === key ? null : t)),
    onDrop: (e: React.DragEvent) => void onDrop(e, collectionId, folderId),
  });
  const dragProps = (item: DragItem) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(DRAG_MIME, JSON.stringify(item));
      e.dataTransfer.effectAllowed = "move";
    },
  });

  const exportOne = async (c: Collection) => {
    try {
      const json = await exportCollection(c.id);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      a.download = `${c.name.replace(/[^\w.-]+/g, "_")}.dbui-collection.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) {
      props.toast((e as Error).message);
    }
  };
  const importOne = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const c = await importCollection(await f.text());
        expand("c:" + c.id);
        props.toast(`Imported "${c.name}"`);
      } catch (e) {
        props.toast((e as Error).message);
      }
    };
    input.click();
  };

  const needle = q.trim().toLowerCase();

  const collectionMenu = (c: Collection): MenuItem[] => [
    { label: "New query…", onClick: () => void newQuery(c.id) },
    { label: "New folder…", onClick: () => void newFolder(c.id) },
    { separator: true, label: "" },
    { label: "Settings, variables, environments…", onClick: () => setSettings(c) },
    {
      label: "Rename…",
      onClick: async () => {
        const name = prompt("Rename collection", c.name);
        if (name && name !== c.name) await saveCollection({ ...c, name });
      },
    },
    { label: "Export as JSON", onClick: () => void exportOne(c) },
    { separator: true, label: "" },
    {
      label: "Delete collection…",
      onClick: async () => {
        if (confirm(`Delete collection "${c.name}" with all its folders and queries?`)) await deleteCollection(c.id);
      },
    },
  ];
  const folderMenu = (f: Folder): MenuItem[] => [
    { label: "New query…", onClick: () => void newQuery(f.collectionId, f.id) },
    { label: "New subfolder…", onClick: () => void newFolder(f.collectionId, f.id) },
    { separator: true, label: "" },
    {
      label: "Rename…",
      onClick: async () => {
        const name = prompt("Rename folder", f.name);
        if (name && name !== f.name) await saveFolder({ ...f, name });
      },
    },
    { label: "Scripts…", onClick: () => setScripts({ title: `Scripts for folder ${f.name}`, target: f }) },
    { separator: true, label: "" },
    {
      label: "Delete folder…",
      onClick: async () => {
        if (confirm(`Delete folder "${f.name}"? Its queries move up a level.`)) await deleteFolder(f.id);
      },
    },
  ];
  const queryMenu = (nq: NamedQuery): MenuItem[] => [
    { label: "Open", onClick: () => props.onOpenQuery(nq) },
    {
      label: "Rename…",
      onClick: async () => {
        const name = prompt("Rename query", nq.name);
        if (name && name !== nq.name) await saveQuery({ ...nq, name });
      },
    },
    {
      label: "Duplicate",
      onClick: async () => {
        const siblings = bundles.get(nq.collectionId)?.queries.filter((x) => x.folderId === nq.folderId).map((x) => x.name) ?? [];
        await createQuery(nq.collectionId, uniqueName(`${nq.name}_copy`, siblings), { folderId: nq.folderId, sql: nq.sql, vars: nq.vars, scripts: nq.scripts, connectionId: nq.connectionId, description: nq.description });
      },
    },
    { label: "Scripts…", onClick: () => setScripts({ title: `Scripts for ${nq.name}`, target: nq }) },
    { separator: true, label: "" },
    {
      label: "Delete query…",
      onClick: async () => {
        if (confirm(`Delete query "${nq.name}"?`)) await deleteQuery(nq.id);
      },
    },
  ];
  const showMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  /** Queries in a folder and all its subfolders. */
  const countIn = (b: CollectionBundle, folderId: string): number =>
    b.queries.filter((x) => x.folderId === folderId).length + b.folders.filter((f) => f.parentId === folderId).reduce((n, f) => n + countIn(b, f.id), 0);
  const queryMatches = (nq: NamedQuery) => !needle || nq.name.toLowerCase().includes(needle) || nq.sql.toLowerCase().includes(needle);
  const folderHasMatch = (b: CollectionBundle, folderId: string): boolean =>
    b.queries.some((x) => x.folderId === folderId && queryMatches(x)) || b.folders.some((f) => f.parentId === folderId && folderHasMatch(b, f.id));

  const renderLevel = (b: CollectionBundle, parentId: string | undefined, depth: number): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    const folders = b.folders.filter((f) => f.parentId === parentId).sort((x, y) => x.name.localeCompare(y.name));
    for (const f of folders) {
      if (needle && !folderHasMatch(b, f.id)) continue;
      const key = "f:" + f.id;
      const isOpen = open.has(key) || !!needle;
      out.push(
        <button
          key={key}
          className={"node coll-folder" + (dropTarget === key ? " drop" : "")}
          style={{ paddingLeft: 6 + depth * 12 }}
          onClick={() => toggle(key)}
          onContextMenu={(e) => showMenu(e, folderMenu(f))}
          role="treeitem"
          aria-expanded={isOpen}
          {...dragProps({ kind: "folder", id: f.id, collectionId: b.collection.id })}
          {...dropProps(key, b.collection.id, f.id)}
        >
          <Chevron open={isOpen} />
          <KindIcon name={isOpen ? "folder-open" : "folder"} />
          <span className="nm">{f.name}</span>
          {f.scripts && (f.scripts.pre || f.scripts.post) && <span className="meta" title="Has scripts">ƒ</span>}
          <CountBadge n={countIn(b, f.id)} />
          <RowAddButton onClick={() => void newQuery(b.collection.id, f.id)} label={`New query in ${f.name}`} />
          <RowMenuButton onClick={(e) => showMenu(e, folderMenu(f))} label={`Actions for folder ${f.name}`} />
        </button>,
      );
      if (isOpen) out.push(...renderLevel(b, f.id, depth + 1));
    }
    const queries = b.queries.filter((x) => x.folderId === parentId && queryMatches(x)).sort((x, y) => x.name.localeCompare(y.name));
    for (const nq of queries) {
      out.push(
        <button
          key={"q:" + nq.id}
          className={"node coll-query" + (props.activeQueryId === nq.id ? " active" : "")}
          style={{ paddingLeft: 6 + depth * 12 }}
          onClick={() => props.onOpenQuery(nq)}
          onContextMenu={(e) => showMenu(e, queryMenu(nq))}
          title={nq.description ?? nq.sql}
          role="treeitem"
          {...dragProps({ kind: "query", id: nq.id, collectionId: b.collection.id })}
        >
          <Chevron open={false} leaf />
          <KindIcon name="named-query" />
          <span className="nm">
            <Highlight text={nq.name} needle={needle} />
          </span>
          <RowMenuButton onClick={(e) => showMenu(e, queryMenu(nq))} label={`Actions for ${nq.name}`} />
        </button>,
      );
    }
    return out;
  };

  return (
    <>
      <div className="psearch">
        <Icon name="search" className="ico psearch-ico" />
        <input placeholder="Search named queries" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQ("")} aria-label="Search named queries" />
        <button className="btn icon ghost" title="New collection" aria-label="New collection" onClick={() => void newCollection()}>
          <Icon name="plus" />
        </button>
        <button className="btn ghost" title="Import a collection from a JSON export" onClick={importOne}>
          Import
        </button>
      </div>
      <div className="tree" role="tree" aria-label="Collections">
        {collections.length === 0 && (
          <div className="empty">
            <p>No collections yet. A collection keeps named queries with variables, like a Postman collection for SQL.</p>
            <button className="btn primary" onClick={() => void newCollection()}>
              New collection
            </button>
          </div>
        )}
        {collections.map((c) => {
          const b = bundles.get(c.id);
          const key = "c:" + c.id;
          const isOpen = open.has(key) || (!!needle && !!b?.queries.some(queryMatches));
          const env = c.environments.find((e) => e.id === c.activeEnvironmentId);
          if (needle && !isOpen && !c.name.toLowerCase().includes(needle)) return null;
          return (
            <div key={c.id} className="coll" role="group">
              <button
                className={"node coll-head" + (dropTarget === key ? " drop" : "")}
                onClick={() => toggle(key)}
                onContextMenu={(e) => showMenu(e, collectionMenu(c))}
                role="treeitem"
                aria-expanded={isOpen}
                {...dropProps(key, c.id, undefined)}
              >
                <Chevron open={isOpen} />
                <KindIcon name="collections" />
                <span className="nm">{c.name}</span>
                {env && <span className="meta" title="Active environment">{env.name}</span>}
                {b && <CountBadge n={b.queries.length} />}
                <RowAddButton onClick={() => void newQuery(c.id)} label={`New query in ${c.name}`} />
                <RowMenuButton onClick={(e) => showMenu(e, collectionMenu(c))} label={`Actions for collection ${c.name}`} />
              </button>
              {isOpen && b && (
                <>
                  {renderLevel(b, undefined, 1)}
                  {b.queries.length === 0 && b.folders.length === 0 && (
                    <div className="coll-empty faint">
                      <button className="linkbtn" onClick={() => void newQuery(c.id)}>
                        Add a query
                      </button>
                      , or save one from History.
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {settings && <CollectionSettings collection={bundles.get(settings.id)?.collection ?? settings} onClose={() => setSettings(null)} />}
      {scripts && (
        <ScriptsModal
          title={scripts.title}
          scripts={scripts.target.scripts}
          onClose={() => setScripts(null)}
          onSave={(s) => {
            const t = scripts.target;
            if ("sql" in t) void saveQuery({ ...t, scripts: s });
            else void saveFolder({ ...t, scripts: s });
          }}
        />
      )}
    </>
  );
}

/** Number of queries under a collection or folder. */
function CountBadge({ n }: { n: number }) {
  return (
    <span className="coll-count" title={`${n} quer${n === 1 ? "y" : "ies"}`} aria-label={`${n} quer${n === 1 ? "y" : "ies"}`}>
      {n}
    </span>
  );
}

/** "+" on a collection or folder row: a new query right there. A span, since rows are buttons. */
function RowAddButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <span
      className="rowadd"
      role="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Icon name="plus" className="ico sm" />
    </span>
  );
}

/** "…" on a row, a span since rows are buttons. */
function RowMenuButton({ onClick, label }: { onClick: (e: React.MouseEvent) => void; label: string }) {
  return (
    <span
      className="rowmenu"
      role="button"
      aria-label={label}
      title="Actions"
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
    >
      <Icon name="more" className="ico sm" />
    </span>
  );
}

const OPEN_KEY = "dbui.collections.open";
function readOpen(): string[] {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}
function writeOpen(ids: string[]) {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(ids));
  } catch {
    /* storage blocked */
  }
}
