// "Open in dbui" prompt for downloads the redirect rule can't catch (DESIGN.md §3.12).
// The background worker opens app.html#download-prompt?id=<downloadId>.

import { useEffect, useState } from "react";
import { dismissDownloadPrompt, getPendingDownloadPrompt, openDownloadInDbui, type PendingDownloadPrompt } from "../../preview/index";
import { fmtBytes } from "../lib/format";

export function DownloadPrompt({ downloadId }: { downloadId: number }) {
  const [p, setP] = useState<PendingDownloadPrompt | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Open in dbui?";
    getPendingDownloadPrompt(downloadId).then(setP, () => setP(null));
  }, [downloadId]);

  const closeSelf = () => window.close();

  if (p === undefined) return <div className="empty">Loading…</div>;
  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className="install">
        {p === null ? (
          <>
            <h2>Nothing to open</h2>
            <p>This download prompt was already handled or has expired.</p>
            <div>
              <button className="btn" onClick={closeSelf}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>Open {p.filename} in dbui?</h2>
            <p>
              Data file
              {p.totalBytes >= 0 ? ` · ${fmtBytes(p.totalBytes)}` : ""}
              {p.mime ? ` · ${p.mime}` : ""}
            </p>
            <p className="mono" style={{ fontSize: 13, wordBreak: "break-all" }}>
              {p.url}
            </p>
            {!p.refetchable && (
              <div className="note">
                This link can't be fetched again, so dbui waits for the download to finish and opens the file from disk. That needs <b>Allow access to file URLs</b> turned on for dbui on chrome://extensions.
              </div>
            )}
            {err && <div className="err">{err}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setErr(null);
                  try {
                    await openDownloadInDbui(downloadId);
                    closeSelf();
                  } catch (e) {
                    setErr((e as Error).message);
                    setBusy(false);
                  }
                }}
              >
                {busy ? (p.refetchable ? "Opening…" : "Waiting for the download…") : "Open in dbui"}
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={async () => {
                  await dismissDownloadPrompt(downloadId);
                  closeSelf();
                }}
              >
                Dismiss
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
