// Left pane "Workflows" tab (DESIGN.md §3.15): a flat list of every workflow across collections,
// with a filter, New workflow (pick its home collection), rename, duplicate and delete. Each row
// shows the step count, the last run, and which collection(s) its query steps use as small tags.
// The code calls workflows "chains" (src/chains/, the Chain type, the "chains" store).

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Chain, Collection, NamedQuery } from "../../collections/model";
import { listAllQueries, listCollections, onCollectionsChanged } from "../../collections/store";
import { ContextMenu, Highlight, Modal, type MenuItem, type Toast } from "../components/ui";
import { Icon } from "../components/Icon";
import { InlineName } from "../components/TreeRow";
import { navigate } from "../lib/route";
import { fmtAgo } from "../lib/format";
import { allChains, collectionsUsed, createChain, defaultWorkflowCollection, deleteChain, duplicateChain, saveChain, WORKFLOWS_COLLECTION } from "./chainStore";

const openWorkflow = (c: Chain) => navigate({ name: "chain", chainId: c.id }, { newTab: true });

export function WorkflowsList(props: { toast: Toast; onOpen?: (c: Chain) => void }) {
  const [rows, setRows] = useState<Chain[] | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [queries, setQueries] = useState<NamedQuery[]>([]);
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [creating, setCreating] = useState(false);
  const [version, setVersion] = useState(0);
  const open = props.onOpen ?? openWorkflow;

  useEffect(() => onCollectionsChanged(() => setVersion((v) => v + 1)), []);
  const reload = useCallback(async () => {
    const [cs, cols, qs] = await Promise.all([allChains().catch(() => []), listCollections().catch(() => []), listAllQueries().catch(() => [])]);
    setRows(cs);
    setCollections(cols);
    setQueries(qs);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, version]);

  const colName = useMemo(() => new Map(collections.map((c) => [c.id, c.name])), [collections]);
  const needle = q.trim().toLowerCase();
  const hits = (rows ?? []).filter((c) => !needle || c.name.toLowerCase().includes(needle) || (colName.get(c.collectionId) ?? "").toLowerCase().includes(needle));

  const [renaming, setRenaming] = useState<string | null>(null);
  const rename = (c: Chain, name: string | null) => {
    setRenaming(null);
    if (name) void saveChain({ ...c, name }).catch((e) => props.toast((e as Error).message));
  };
  const remove = async (c: Chain) => {
    try {
      const restore = await deleteChain(c.id);
      props.toast(`Deleted workflow "${c.name}"`, { label: "Undo", run: () => void restore().catch((e) => props.toast((e as Error).message)) });
    } catch (e) {
      props.toast((e as Error).message);
    }
  };
  const rowMenu = (c: Chain): MenuItem[] => [
    { label: "Open", onClick: () => open(c) },
    { label: "Rename", onClick: () => setRenaming(c.id) },
    { label: "Duplicate", onClick: () => void duplicateChain(c).then((d) => props.toast(`Created "${d.name}"`)) },
    { separator: true, label: "" },
    { label: "Delete workflow", onClick: () => void remove(c) },
  ];
  const showMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  return (
    <>
      <div className="psearch">
        <Icon name="search" className="ico psearch-ico" />
        <input placeholder="Filter workflows" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQ("")} aria-label="Filter workflows" />
        <button className="btn icon ghost" title="New workflow" aria-label="New workflow" onClick={() => setCreating(true)}>
          <Icon name="plus" />
        </button>
      </div>
      <div className="wf-list" role="list" aria-label="Workflows">
        {rows !== null && rows.length === 0 && (
          <div className="empty">
            <p>No workflows yet. A workflow runs several steps in order, each using earlier results, like a small dbt project.</p>
            <button className="btn primary" onClick={() => setCreating(true)}>
              New workflow
            </button>
          </div>
        )}
        {rows !== null && rows.length > 0 && hits.length === 0 && <div className="empty">No workflow matches "{q}".</div>}
        {hits.map((c) => {
          const used = collectionsUsed(c, queries);
          const tags = used.length ? used : [c.collectionId];
          if (renaming === c.id) {
            return (
              <div key={c.id} role="listitem" className="wf-row">
                <InlineName value={c.name} label="Workflow name" indent={8} onDone={(n) => rename(c, n)} />
              </div>
            );
          }
          return (
            <div key={c.id} role="listitem" className="wf-row">
              <button className="hitem wf-item" onClick={() => open(c)} onContextMenu={(e) => showMenu(e, rowMenu(c))} title={`Open ${c.name}`}>
                <span className="wf-name">
                  <Icon name="workflow" className="ico kind" />
                  <b>
                    <Highlight text={c.name} needle={needle} />
                  </b>
                </span>
                <small className="wf-meta">
                  {c.steps.length} step{c.steps.length === 1 ? "" : "s"}
                  {c.lastRun ? (
                    <>
                      {" · "}
                      <span className={"wf-run " + c.lastRun.status}>{RUN_LABEL[c.lastRun.status]}</span> {fmtAgo(c.lastRun.at)}
                    </>
                  ) : (
                    " · not run yet"
                  )}
                </small>
                <span className="wf-tags">
                  {tags.map((id) => (
                    <span key={id} className={"wf-tag" + (id === c.collectionId ? " home" : "")} title={id === c.collectionId ? "Home collection: variables and named queries" : "Named queries from this collection"}>
                      {colName.get(id) ?? "missing collection"}
                    </span>
                  ))}
                </span>
              </button>
              <span className="rowmenu" role="button" aria-label={`Actions for workflow ${c.name}`} title="Actions" onClick={(e) => showMenu(e, rowMenu(c))}>
                <Icon name="more" className="ico sm" />
              </span>
            </div>
          );
        })}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {creating && (
        <NewWorkflowDialog
          collections={collections}
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            open(c);
          }}
        />
      )}
    </>
  );
}

const RUN_LABEL = { done: "passed", failed: "failed", cancelled: "stopped", blocked: "blocked" } as const;

const NEW_DEFAULT = "__default__";

/** Name and home collection for a new workflow; the default is the only collection, or a "Workflows" one. */
export function NewWorkflowDialog(props: { collections: Collection[]; onClose: () => void; onCreated: (c: Chain) => void }) {
  const [name, setName] = useState("New workflow");
  const only = props.collections.length === 1 ? props.collections[0] : undefined;
  const existingDefault = props.collections.find((c) => c.name === WORKFLOWS_COLLECTION);
  const [collectionId, setCollectionId] = useState<string>(only?.id ?? existingDefault?.id ?? NEW_DEFAULT);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    try {
      const home = collectionId === NEW_DEFAULT ? await defaultWorkflowCollection(props.collections) : { id: collectionId };
      props.onCreated(await createChain(home.id, name.trim() || "New workflow"));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal
      title="New workflow"
      onClose={props.onClose}
      actions={
        <>
          {error && <span className="err">{error}</span>}
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => void create()}>
            Create
          </button>
        </>
      }
    >
      <div className="coll-form">
        <label>
          Name
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Workflow name" onKeyDown={(e) => e.key === "Enter" && name.trim() && void create()} />
        </label>
        <label>
          Collection
          <select className="input" value={collectionId} onChange={(e) => setCollectionId(e.target.value)} aria-label="Collection">
            {!only && !existingDefault && <option value={NEW_DEFAULT}>A new "{WORKFLOWS_COLLECTION}" collection</option>}
            {props.collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <small className="faint">Its variables, environments and named queries are what this workflow's steps can use.</small>
        </label>
      </div>
    </Modal>
  );
}
