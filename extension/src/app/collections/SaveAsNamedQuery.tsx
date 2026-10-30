// Save a query into a collection (DESIGN.md §3.14): from a History row's Save button, or ⌘S in
// a query tab that isn't bound to a named query yet. One screen: collection and folder (the
// last ones used, or a "Saved queries" collection made on first save), and a name guessed from
// the SQL. "Make it reusable…" optionally turns literals into variables before saving.

import { useEffect, useMemo, useState } from "react";
import type { Collection, Folder, NamedQuery } from "../../collections/model";
import { applySuggestions, suggestVariables, VAR_NAME, type LiteralSuggestion } from "../../collections/literals";
import type { DialectName } from "../../collections/render";
import { createCollection, createFolder, createQuery, folderPath, listCollections, loadBundle } from "../../collections/store";
import { InlineCreate, Modal } from "../components/ui";

export const SAVED_QUERIES = "Saved queries";
const NEW_SAVED = "__saved__";
const LAST_KEY = "dbui.save.last";

export function SaveAsNamedQuery(props: {
  sql: string;
  dialect: DialectName;
  connectionId?: string;
  /** Starting name; guessed from the SQL when left out. */
  name?: string;
  title?: string;
  onClose: () => void;
  onSaved: (q: NamedQuery) => void;
}) {
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [collectionId, setCollectionId] = useState<string>("");
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderId, setFolderId] = useState<string>("");
  const [name, setName] = useState(() => props.name || guessQueryName(props.sql));
  const [reusable, setReusable] = useState(false);
  const [items, setItems] = useState<LiteralSuggestion[]>(() => suggestVariables(props.sql, props.dialect));
  const [error, setError] = useState<string | null>(null);
  const [last] = useState(readLast);

  useEffect(() => {
    listCollections().then(
      (cs) => {
        setCollections(cs);
        const pick = cs.find((c) => c.id === last.collectionId) ?? cs.find((c) => c.name === SAVED_QUERIES);
        setCollectionId(pick?.id ?? NEW_SAVED);
      },
      () => {
        setCollections([]);
        setCollectionId(NEW_SAVED);
      },
    );
  }, [last.collectionId]);
  useEffect(() => {
    if (!collectionId || collectionId === NEW_SAVED) return setFolders([]);
    let cancelled = false;
    loadBundle(collectionId).then(
      (b) => {
        if (cancelled) return;
        const fs = b?.folders ?? [];
        setFolders(fs);
        setFolderId((cur) => (fs.some((f) => f.id === cur) ? cur : collectionId === last.collectionId && fs.some((f) => f.id === last.folderId) ? last.folderId! : ""));
      },
      () => !cancelled && setFolders([]),
    );
    return () => {
      cancelled = true;
    };
  }, [collectionId, last]);

  // Literals become variables only when "Make it reusable…" is open.
  const chosen = reusable ? items.filter((i) => i.selected) : [];
  const preview = useMemo(() => {
    try {
      return { text: applySuggestions(props.sql, chosen).sql, error: null };
    } catch (e) {
      return { text: props.sql, error: (e as Error).message };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sql, items, reusable]);

  const save = async () => {
    setError(null);
    try {
      let cid = collectionId;
      if (!cid || cid === NEW_SAVED) cid = (collections?.find((c) => c.name === SAVED_QUERIES) ?? (await createCollection(SAVED_QUERIES))).id;
      const { sql, vars } = applySuggestions(props.sql, chosen);
      const q = await createQuery(cid, name.trim() || "query", { sql, vars, folderId: folderId || undefined, connectionId: props.connectionId });
      writeLast({ collectionId: cid, folderId: folderId || undefined });
      props.onSaved(q);
      props.onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const newCollection = async (n: string) => {
    const c = await createCollection(n);
    setCollections((cs) => [...(cs ?? []), c]);
    setCollectionId(c.id);
  };
  const newFolder = async (n: string) => {
    let cid = collectionId;
    if (cid === NEW_SAVED) {
      const c = await createCollection(SAVED_QUERIES);
      setCollections((cs) => [...(cs ?? []), c]);
      cid = c.id;
    }
    const f = await createFolder(cid, n, folderId || undefined);
    setFolders((fs) => [...fs, f]);
    setFolderId(f.id);
    if (cid !== collectionId) setCollectionId(cid);
  };

  const bad = chosen.some((it) => !VAR_NAME.test(it.name));
  return (
    <Modal
      wide
      title={props.title ?? "Save to a collection"}
      onClose={props.onClose}
      actions={
        <>
          {error && <span className="err" style={{ padding: "4px 8px" }}>{error}</span>}
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim() || !!preview.error || bad || collections === null} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="coll-form">
        <label>
          Name
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Query name" onKeyDown={(e) => e.key === "Enter" && name.trim() && collections !== null && void save()} />
        </label>
        <label>
          Collection
          <span style={{ display: "flex", gap: 6 }}>
            <select className="input" style={{ flex: 1 }} value={collectionId} onChange={(e) => setCollectionId(e.target.value)} aria-label="Collection">
              {!collections?.some((c) => c.name === SAVED_QUERIES) && <option value={NEW_SAVED}>{SAVED_QUERIES} (new)</option>}
              {(collections ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <InlineCreate label="New…" placeholder="Collection name" initial={SAVED_QUERIES} ariaLabel="New collection name" onCreate={newCollection} />
          </span>
        </label>
        <label>
          Folder
          <span style={{ display: "flex", gap: 6 }}>
            <select className="input" style={{ flex: 1 }} value={folderId} onChange={(e) => setFolderId(e.target.value)} aria-label="Folder">
              <option value="">(top level)</option>
              {folderOptions(folders).map(({ f, path }) => (
                <option key={f.id} value={f.id}>
                  {path}
                </option>
              ))}
            </select>
            <InlineCreate
              label={folderId ? "New subfolder…" : "New folder…"}
              title={folderId ? `New subfolder inside ${folderPath(folderId, folders).replace(/\//g, " / ")}` : "New folder"}
              placeholder="Folder name"
              initial="New folder"
              ariaLabel="New folder name"
              onCreate={newFolder}
            />
          </span>
        </label>
      </div>
      <details className="save-reusable" open={reusable} onToggle={(e) => setReusable((e.target as HTMLDetailsElement).open)}>
        <summary>Make it reusable…</summary>
        <p>Turn literals into variables so the query works for other dates and clients. The old values become the defaults.</p>
        {items.length === 0 && <div className="faint">No literals found; the query is saved as is.</div>}
        <div className="lit-list">
          {items.map((it) => {
            const badName = it.selected && !VAR_NAME.test(it.name);
            return (
              <div key={it.id} className="lit-row">
                <input type="checkbox" checked={it.selected} onChange={(e) => setItems(items.map((x) => (x.id === it.id ? { ...x, selected: e.target.checked } : x)))} aria-label={`Make ${it.text} a variable`} />
                <code className="lit-old" title={it.text}>
                  {it.text}
                </code>
                <span className="faint">→</span>
                <input
                  className={"input mono" + (badName ? " missing" : "")}
                  value={it.name}
                  disabled={!it.selected}
                  onChange={(e) => setItems(items.map((x) => (x.id === it.id ? { ...x, name: e.target.value } : x)))}
                  aria-label={`Variable name for ${it.text}`}
                />
                <small className="faint">{it.kind}</small>
              </div>
            );
          })}
        </div>
        {preview.error && <div className="err">{preview.error}</div>}
        {reusable && <pre className="lit-preview mono">{preview.text}</pre>}
      </details>
    </Modal>
  );
}

/** Folders as "Reports / Weekly" paths, sorted, for the folder picker. */
export function folderOptions(folders: Folder[]): { f: Folder; path: string }[] {
  return folders
    .map((f) => ({ f, path: folderPath(f.id, folders).replace(/\//g, " / ") }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** A starting name: the first table plus today's date ("orders 2026-10-30"), else the first 40 characters of the SQL. */
export function guessQueryName(sql: string, today = new Date()): string {
  const m = sql.match(/\b(?:from|into|update|join)\s+([`"[]?)([\w.$-]+)[`"\]]?/i);
  const t = m?.[2]?.split(".").pop();
  if (t && !/^production__/.test(t)) return `${t} ${ymd(today)}`;
  const flat = sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, 40).trim() : "query";
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function readLast(): { collectionId?: string; folderId?: string } {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}") as { collectionId?: string; folderId?: string };
  } catch {
    return {};
  }
}
function writeLast(v: { collectionId: string; folderId?: string }) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(v));
  } catch {
    /* storage blocked */
  }
}
