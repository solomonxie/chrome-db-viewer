// Home banner offering to restore the runner's automatic backup on a fresh install
// (DESIGN.md §3.16). Shown only when this profile has no connections, collections or history
// and a backup exists. Never restores without the user's click.

import { useEffect, useRef, useState } from "react";
import { checkForRestore, restoreOffer, type BackupTransport, type RestoreOffer } from "../store/autoBackup";
import type { BackupIO } from "../store/backup";
import { useToast } from "../components/ui";

/** Checks once for a restore offer; `dismiss` hides it for this page. */
export function useRestoreOffer(enabled: boolean, deps: { transport?: BackupTransport; io?: BackupIO } = {}) {
  const [offer, setOffer] = useState<RestoreOffer | null>(null);
  const checked = useRef(false);
  useEffect(() => {
    if (!enabled || checked.current) return;
    checked.current = true;
    // No cancel on cleanup: StrictMode re-runs this effect, and the ref makes the check run once.
    void checkForRestore({ io: deps.io, transport: deps.transport }).then(setOffer);
  }, [enabled, deps.io, deps.transport]);
  return { offer, dismiss: () => setOffer(null) };
}

export function RestoreBanner(props: { offer: RestoreOffer; onDone: (restored: boolean) => void; io?: BackupIO }) {
  const { offer } = props;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();

  const restore = async () => {
    setBusy(true);
    setErr(null);
    try {
      await restoreOffer(offer, { io: props.io });
      toast("Backup restored");
      props.onDone(true);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="note restore-banner" role="region" aria-label="Restore backup">
      <b>Found a backup from {new Date(offer.at).toLocaleString()}</b>: {offer.summary.text}. Restore?
      <small className="muted" style={{ display: "block", marginTop: 4 }}>
        Passwords aren't in backups; you'll enter them again when you connect.
        {offer.summary.needsRepick > 0 && ` ${offer.summary.needsRepick} picked file${offer.summary.needsRepick === 1 ? "" : "s"} will need choosing again.`}
      </small>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn primary" disabled={busy} onClick={() => void restore()}>
          Restore
        </button>
        <button className="btn" disabled={busy} onClick={() => props.onDone(false)}>
          Not now
        </button>
      </div>
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}
