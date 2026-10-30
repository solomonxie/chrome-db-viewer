// History → "Save as named query…" (DESIGN.md §3.14): pick a collection, folder and name, then
// review which literals become variables (each can be renamed or unticked), then save.

import { useEffect, useMemo, useState } from "react";
import type { Collection, Folder, NamedQuery } from "../../collections/model";
import { applySuggestions, suggestVariables, VAR_NAME, type LiteralSuggestion } from "../../collections/literals";
import type { DialectName } from "../../collections/render";
import { createCollection, createFolder, createQuery, folderPath, listCollections, loadBundle } from "../../collections/store";
import { Modal } from "../components/ui";

export function SaveAsNamedQuery(props: { sql: string; dialect: DialectName; connectionId?: string; onClose: () => void; onSaved: (q: NamedQuery) => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionId, setCollectionId] = useState<string>("");
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderId, setFolderId] = useState<string>("");
  const [name, setName] = useState(guessName(props.sql));
  const [items, setItems] = useState<LiteralSuggestion[]>(() => suggestVariables(props.sql, props.dialect));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listCollections().then(
      (cs) => {
        setCollections(cs);
        setCollectionId((id) => id || cs[0]?.id || "");
      },
      () => setCollections([]),
    );
  }, []);
  useEffect(() => {
    if (!collectionId) return setFolders([]);
    loadBundle(collectionId).then((b) => setFolders(b?.folders ?? []), () => setFolders([]));
    setFolderId("");
  }, [collectionId]);

  const chosen = items.filter((i) => i.selected);
  const preview = useMemo(() => {
    try {
      return { text: applySuggestions(props.sql, chosen).sql, error: null };
    } catch (e) {
      return { text: props.sql, error: (e as Error).message };
    }
  }, [props.sql, chosen]);

  const save = async () => {
    setError(null);
    try {
      let cid = collectionId;
      if (!cid) cid = (await createCollection("My queries")).id;
      const { sql, vars } = applySuggestions(props.sql, chosen);
      const q = await createQuery(cid, name.trim() || "query", { sql, vars, folderId: folderId || undefined, connectionId: props.connectionId });
      props.onSaved(q);
      props.onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const newCollection = async () => {
    const n = prompt("New collection name", "My queries");
    if (!n) return;
    const c = await createCollection(n);
    setCollections((cs) => [...cs, c]);
    setCollectionId(c.id);
  };
  const newFolder = async () => {
    if (!collectionId) return;
    const n = prompt("New folder name", "Base");
    if (!n) return;
    const f = await createFolder(collectionId, n, folderId || undefined);
    setFolders((fs) => [...fs, f]);
    setFolderId(f.id);
  };

  return (
    <Modal
      wide
      title="Save as named query"
      onClose={props.onClose}
      actions={
        step === 1 ? (
          <>
            <button className="btn" onClick={props.onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={!name.trim()} onClick={() => setStep(2)}>
              Next: variables
            </button>
          </>
        ) : (
          <>
            {error && <span className="err" style={{ padding: "4px 8px" }}>{error}</span>}
            <button className="btn" onClick={() => setStep(1)}>
              Back
            </button>
            <button className="btn primary" disabled={!!preview.error} onClick={() => void save()}>
              Save
            </button>
          </>
        )
      }
    >
      {step === 1 ? (
        <div className="coll-form">
          <label>
            Collection
            <span style={{ display: "flex", gap: 6 }}>
              <select className="input" style={{ flex: 1 }} value={collectionId} onChange={(e) => setCollectionId(e.target.value)} aria-label="Collection">
                {collections.length === 0 && <option value="">A new collection "My queries"</option>}
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button className="btn" onClick={() => void newCollection()}>
                New…
              </button>
            </span>
          </label>
          <label>
            Folder
            <span style={{ display: "flex", gap: 6 }}>
              <select className="input" style={{ flex: 1 }} value={folderId} onChange={(e) => setFolderId(e.target.value)} aria-label="Folder">
                <option value="">(top level)</option>
                {folders
                  .map((f) => ({ f, path: folderPath(f.id, folders) }))
                  .sort((a, b) => a.path.localeCompare(b.path))
                  .map(({ f, path }) => (
                    <option key={f.id} value={f.id}>
                      {path}
                    </option>
                  ))}
              </select>
              <button className="btn" disabled={!collectionId} onClick={() => void newFolder()}>
                New…
              </button>
            </span>
          </label>
          <label>
            Name
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Query name" onKeyDown={(e) => e.key === "Enter" && name.trim() && setStep(2)} />
          </label>
        </div>
      ) : (
        <>
          <p>Turn literals into variables so the query works for other dates and clients. The old values become the defaults.</p>
          {items.length === 0 && <div className="faint">No literals found; the query is saved as is.</div>}
          <div className="lit-list">
            {items.map((it) => {
              const bad = it.selected && !VAR_NAME.test(it.name);
              return (
                <div key={it.id} className="lit-row">
                  <input type="checkbox" checked={it.selected} onChange={(e) => setItems(items.map((x) => (x.id === it.id ? { ...x, selected: e.target.checked } : x)))} aria-label={`Make ${it.text} a variable`} />
                  <code className="lit-old" title={it.text}>
                    {it.text}
                  </code>
                  <span className="faint">→</span>
                  <input
                    className={"input mono" + (bad ? " missing" : "")}
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
          <pre className="lit-preview mono">{preview.text}</pre>
        </>
      )}
    </Modal>
  );
}

/** A starting name from the main table: "orders", or "query". */
function guessName(sql: string): string {
  const m = sql.match(/\bfrom\s+([`"]?)([\w.-]+)\1/i);
  const t = m?.[2]?.split(".").pop();
  return t && !/^production__/.test(t) ? t : "query";
}
