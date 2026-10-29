// Pending-changes drawer (⌘⇧P): the exact statements via previewChangeSet, Commit (⌘S),
// Discard, and a typed confirmation on production.

import { useMemo, useState } from "react";
import type { ObjectPath } from "@core/types";
import { previewChangeSet } from "@core/sql";
import { TypedConfirm } from "../components/ui";
import { discard, toChangeSet, undo } from "../lib/changes";
import { MOD } from "../lib/keys";
import type { ConnCtx } from "./model";

export function ReviewDrawer(props: { ctx: ConnCtx; applying: boolean; error: string | null; askConfirm?: boolean; onApply: () => void; onClose: () => void }) {
  const { ctx } = props;
  const [confirm, setConfirm] = useState(!!props.askConfirm && ctx.cfg.env === "production");
  const set = useMemo(() => toChangeSet(ctx.pending), [ctx.pending]);
  const sql = useMemo(() => {
    try {
      return previewChangeSet(set, ctx.driver.dialect, (p: ObjectPath) => ctx.sqlName(p));
    } catch (e) {
      return `-- ${(e as Error).message}`;
    }
  }, [set, ctx]);
  const counts = useMemo(() => {
    const c = { update: 0, insert: 0, delete: 0 };
    for (const ch of set.changes) c[ch.type]++;
    return c;
  }, [set]);
  const prod = ctx.cfg.env === "production";

  return (
    <div className="drawer" role="dialog" aria-label="Pending changes">
      <header>
        <h3>Pending changes</h3>
        <span className="faint" style={{ fontSize: 12 }}>
          {counts.update} updated · {counts.insert} inserted · {counts.delete} deleted
        </span>
        <span className="spacer" />
        <button className="btn icon ghost" onClick={props.onClose} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="body">
        {set.changes.length === 0 ? (
          <div className="empty">No pending changes.</div>
        ) : (
          <>
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
              These statements run in one transaction{ctx.caps.transactions ? "" : " where the engine supports it"} when you commit. Literals are shown inline here; the driver sends them as parameters.
            </p>
            <pre className="code">{sql}</pre>
          </>
        )}
        {props.error && <div className="err">{props.error}</div>}
        {prod && set.changes.length > 0 && (
          <div className="note" style={{ borderColor: "var(--env-prod)" }}>
            <b>Production.</b> You'll be asked to type the connection name before these run.
          </div>
        )}
      </div>
      <footer>
        <button className="btn" onClick={() => ctx.setPending(undo)} disabled={ctx.pending.past.length === 0}>
          Undo <kbd>{MOD}Z</kbd>
        </button>
        <button className="btn" onClick={() => ctx.setPending(discard)} disabled={set.changes.length === 0}>
          Discard all
        </button>
        <span className="spacer" />
        <button className={"btn " + (prod ? "danger" : "primary")} disabled={set.changes.length === 0 || props.applying || ctx.readOnly} onClick={() => (prod ? setConfirm(true) : props.onApply())}>
          {props.applying ? "Committing…" : "Commit"} <kbd>{MOD}S</kbd>
        </button>
      </footer>
      {confirm && (
        <TypedConfirm
          title="Commit to production"
          message={
            <>
              {set.changes.length} change{set.changes.length === 1 ? "" : "s"} will be written to <b>{ctx.cfg.name}</b>.
            </>
          }
          expected={ctx.cfg.name}
          confirmLabel="Commit to production"
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            props.onApply();
          }}
        />
      )}
    </div>
  );
}
