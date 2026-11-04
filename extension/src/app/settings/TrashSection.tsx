// Settings › Trash (DESIGN.md §3.17): deleted workflows, collections, folders, queries and
// connections, newest first. Restore puts one back; Delete forever and Empty trash ask first.

import { useEffect, useState } from "react";
import { writeTrashedRow } from "../../collections/store";
import { deleteForever, emptyTrash, listTrash, onTrashChanged, restoreFromTrash, type TrashItem } from "../store/trash";
import { Modal, useToast } from "../components/ui";
import { fmtAgo } from "../lib/format";

const KIND: Record<TrashItem["kind"], string> = { workflow: "Workflow", collection: "Collection", folder: "Folder", query: "Query", connection: "Connection" };

export function TrashSection() {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: string; run: () => Promise<void> } | null>(null);
  const toast = useToast();

  useEffect(() => {
    const load = () => void listTrash().then(setItems);
    load();
    return onTrashChanged(load);
  }, []);

  const restore = async (t: TrashItem) => {
    try {
      await restoreFromTrash(t.id, writeTrashedRow);
      toast(`Restored ${KIND[t.kind].toLowerCase()} "${t.name}"`);
    } catch (e) {
      toast(`Couldn't restore: ${(e as Error).message}`);
    }
  };

  return (
    <section id="settings-trash">
      <div className="trash-head">
        <h2>Trash{items?.length ? ` (${items.length})` : ""}</h2>
        <span className="spacer" />
        {!!items?.length && (
          <button
            className="btn danger"
            onClick={() =>
              setConfirm({
                title: "Empty the Trash?",
                body: `${items.length} item${items.length === 1 ? "" : "s"} and their saved passwords are deleted for good. This can't be undone.`,
                run: async () => {
                  const n = await emptyTrash();
                  toast(`Deleted ${n} item${n === 1 ? "" : "s"} for good`);
                },
              })
            }
          >
            Empty trash
          </button>
        )}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        Deleted workflows, collections, folders, queries and connections stay here until you delete them from the Trash. Restoring brings an item back as it was, saved passwords included.
      </p>
      {items !== null && items.length === 0 && <div className="faint trash-empty">The Trash is empty.</div>}
      {!!items?.length && (
        <div className="trash-list" role="list" aria-label="Trash">
          {items.map((t) => (
            <div key={t.id} className="trash-row" role="listitem">
              <span className={`trash-kind k-${t.kind}`}>{KIND[t.kind]}</span>
              <span className="trash-name">
                <b>{t.name}</b>
                {t.where && <small className="faint">{t.where}</small>}
              </span>
              <small className="faint trash-when" title={new Date(t.deletedAt).toLocaleString()}>
                {fmtAgo(t.deletedAt)}
              </small>
              <button className="btn sm" onClick={() => void restore(t)}>
                Restore
              </button>
              <button
                className="btn sm ghost danger"
                onClick={() =>
                  setConfirm({
                    title: `Delete "${t.name}" forever?`,
                    body: `The ${KIND[t.kind].toLowerCase()}${t.secrets ? " and its saved passwords" : ""} can't be restored after this.`,
                    run: async () => {
                      await deleteForever(t.id);
                      toast(`Deleted "${t.name}" for good`);
                    },
                  })
                }
              >
                Delete forever
              </button>
            </div>
          ))}
        </div>
      )}
      {confirm && (
        <Modal
          title={confirm.title}
          onClose={() => setConfirm(null)}
          actions={
            <>
              <button className="btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  const run = confirm.run;
                  setConfirm(null);
                  void run().catch((e) => toast((e as Error).message));
                }}
              >
                Delete forever
              </button>
            </>
          }
        >
          <p>{confirm.body}</p>
        </Modal>
      )}
    </section>
  );
}
