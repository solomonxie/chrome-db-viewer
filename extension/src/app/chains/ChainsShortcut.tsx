// A compact chain list with "New chain", for the left pane's Queries tab and the Collections UI.
// Pass collectionId to list one collection's chains; without it, every chain is listed and a
// new chain goes into the first collection (one is created when there are none).

import { useEffect, useState } from "react";
import type { Chain } from "../../collections/model";
import { createCollection, listCollections } from "../../collections/store";
import { navigate } from "../lib/route";
import { fmtAgo } from "../lib/format";
import { allChains, chainsFor, createChain } from "./chainStore";

export function ChainsShortcut({ collectionId, limit = 8 }: { collectionId?: string; limit?: number }) {
  const [chains, setChains] = useState<Chain[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    (collectionId ? chainsFor(collectionId) : allChains()).then(setChains, () => setChains([]));
  }, [open, collectionId]);

  const create = async () => {
    let target = collectionId;
    if (!target) {
      const cols = await listCollections().catch(() => []);
      target = cols[0]?.id ?? (await createCollection("My chains")).id;
    }
    const c = await createChain(target);
    navigate({ name: "chain", chainId: c.id }, { newTab: true });
  };

  return (
    <div className="chains-shortcut">
      <button className="hitem" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <b style={{ fontSize: 14 }}>{open ? "▾" : "▸"} Chains</b>
        <small>Multi-step pipelines across connections</small>
      </button>
      {open && (
        <div className="chains-list">
          {chains.slice(0, limit).map((c) => (
            <button key={c.id} className="hitem" onClick={() => navigate({ name: "chain", chainId: c.id }, { newTab: true })}>
              <b style={{ fontSize: 14 }}>{c.name}</b>
              <small>
                {c.steps.length} step{c.steps.length === 1 ? "" : "s"} · {fmtAgo(c.updatedAt)}
              </small>
            </button>
          ))}
          <button className="btn" onClick={() => void create()}>
            New chain
          </button>
        </div>
      )}
    </div>
  );
}
