import { useCallback, useEffect, useState } from "react";
import { probeRunner, RUNNER_PKG_URL, type RunnerStatus } from "../lib/runner";

export function useRunnerStatus() {
  const [status, setStatus] = useState<RunnerStatus>({ state: "checking" });
  const check = useCallback(() => {
    setStatus({ state: "checking" });
    void probeRunner().then(setStatus);
  }, []);
  useEffect(check, [check]);
  return { status, check };
}

async function installRunner() {
  // Download the per-user .pkg, then open it once Chrome has it on disk (§5.2).
  const id = await chrome.downloads.download({ url: RUNNER_PKG_URL });
  const onChanged = (d: chrome.downloads.DownloadDelta) => {
    if (d.id !== id || !d.state) return;
    if (d.state.current === "complete") void chrome.downloads.open(id);
    if (d.state.current !== "in_progress") chrome.downloads.onChanged.removeListener(onChanged);
  };
  chrome.downloads.onChanged.addListener(onChanged);
}

export function RunnerCard({ status, onCheck, compact }: { status: RunnerStatus; onCheck: () => void; compact?: boolean }) {
  if (status.state === "checking") {
    return (
      <div className="rcard">
        <div className="row">
          <span className="dot" /> <b>dbui runner</b> <span className="faint">checking…</span>
        </div>
      </div>
    );
  }
  if (status.state === "ok") {
    return (
      <div className="rcard">
        <div className="row">
          <span className="dot ok" /> <b>dbui runner {status.version}</b>
        </div>
        {!compact && <p>Postgres and Redis connections are available. Drivers: {status.drivers.join(", ") || "none reported"}.</p>}
      </div>
    );
  }
  const outdated = status.state === "outdated";
  const crashed = status.state === "crashed";
  return (
    <div className="rcard">
      <div className="row">
        <span className={"dot " + (crashed ? "bad" : "warn")} />
        <b>{outdated ? "Update dbui runner" : crashed ? "dbui runner stopped" : "Install dbui runner"}</b>
      </div>
      <p>
        {outdated
          ? `The installed runner (${status.version}) speaks an older protocol than this extension needs.`
          : crashed
            ? "The runner exited unexpectedly. It may not be notarized, or it crashed. Logs: ~/Library/Logs/dbui/runner.log"
            : status.state === "unavailable"
              ? status.message
              : "Postgres and Redis need a small helper app. It installs into your home folder: no admin password, no Homebrew."}
      </p>
      {status.state !== "unavailable" && !crashed && (
        <div className="row">
          <button className="btn primary" onClick={() => void installRunner()}>
            {outdated ? "Update runner" : "Install runner"}
          </button>
          <button className="btn" onClick={onCheck}>
            Check again
          </button>
        </div>
      )}
      {(crashed || status.state === "unavailable") && (
        <div className="row">
          <button className="btn" onClick={onCheck}>
            Check again
          </button>
        </div>
      )}
      {!compact && status.state === "missing" && (
        <>
          <p>Or from a terminal:</p>
          <code>curl -fsSL https://dbui.invalid/install.sh | sh</code>
        </>
      )}
    </div>
  );
}
