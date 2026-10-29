// Settings: Browser preview (DESIGN.md §3.12). Master switch → all-sites permission request →
// per-extension checklist → chrome.storage.local "previewSettings". The background worker
// watches that key and rebuilds the redirect rules.

import { useEffect, useState } from "react";
import {
  DEFAULT_PREVIEW_SETTINGS, PREVIEW_GROUPS, PREVIEW_ORIGINS, hasPreviewHostAccess, loadPreviewSettings, mergeSettings,
  normalizeDomain, savePreviewSettings, type PreviewSettings,
} from "../../preview/index";
import { navigate } from "../lib/route";
import { useToast } from "../components/ui";
import { RunnerCard, useRunnerStatus } from "../home/RunnerCard";

type GroupKey = keyof typeof PREVIEW_GROUPS;

const GROUP_INFO: Record<GroupKey, { label: string; note?: string }> = {
  tables: { label: "Tables" },
  jsonLines: { label: "JSON Lines" },
  columnar: { label: "Columnar" },
  databases: { label: "Databases" },
  json: { label: "JSON", note: "Off by default: Chrome's own JSON view is often what you want for API responses." },
  compressed: { label: "Compressed", note: "Only on top of a checked data type, e.g. .csv.gz. A plain .tar.gz still downloads." },
  images: { label: "Images", note: "Opens in dbui's media viewer. Off by default." },
  video: { label: "Video", note: "Opens in dbui's media viewer. Off by default." },
};

export function Settings({ section }: { section?: string }) {
  const [s, setS] = useState<PreviewSettings | null>(null);
  const [granted, setGranted] = useState(false);
  const [domain, setDomain] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const runner = useRunnerStatus();
  const inExtension = typeof chrome !== "undefined" && !!chrome.storage?.local;

  useEffect(() => {
    if (!inExtension) {
      setS(mergeSettings(null));
      return;
    }
    void loadPreviewSettings().then(setS);
    void hasPreviewHostAccess().then(setGranted);
    const on = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && "previewSettings" in changes) setS(mergeSettings(changes.previewSettings?.newValue));
    };
    chrome.storage.onChanged.addListener(on);
    return () => chrome.storage.onChanged.removeListener(on);
  }, [inExtension]);

  useEffect(() => {
    if (section) document.getElementById(`settings-${section}`)?.scrollIntoView();
  }, [section, s]);

  const save = async (next: PreviewSettings) => {
    setS(next);
    setErr(null);
    try {
      await savePreviewSettings(next);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const toggleMaster = async (on: boolean) => {
    if (!s) return;
    if (!on) return save({ ...s, enabled: false });
    try {
      // Must run in the click handler: Chrome only shows the prompt for a user gesture.
      const ok = await chrome.permissions.request({ origins: PREVIEW_ORIGINS });
      setGranted(ok);
      if (!ok) {
        setErr("Chrome didn't grant access to all sites, so dbui can't catch data-file links. Nothing was changed.");
        return;
      }
      await save({ ...s, enabled: true, extensions: s.extensions.length ? s.extensions : [...DEFAULT_PREVIEW_SETTINGS.extensions] });
      toast("Browser preview is on");
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const toggleExt = (ext: string, on: boolean) => {
    if (!s) return;
    const set = new Set(s.extensions);
    if (on) set.add(ext);
    else set.delete(ext);
    void save({ ...s, extensions: [...set] });
  };

  const toggleGroup = (exts: readonly string[], on: boolean) => {
    if (!s) return;
    const set = new Set(s.extensions);
    for (const e of exts) {
      if (on) set.add(e);
      else set.delete(e);
    }
    void save({ ...s, extensions: [...set] });
  };

  const addDomain = () => {
    if (!s) return;
    const d = normalizeDomain(domain);
    if (!d) {
      setErr(`"${domain}" isn't a domain name.`);
      return;
    }
    setDomain("");
    if (!s.excludedDomains.includes(d)) void save({ ...s, excludedDomains: [...s.excludedDomains, d] });
  };

  return (
    <div className="settings">
      <div className="settings-inner">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button className="btn" onClick={() => navigate({ name: "home" })}>
            ‹ Home
          </button>
          <h1>Settings</h1>
        </div>

        <section id="settings-preview">
          <h2>Browser preview</h2>
          <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
            Open data files (CSV, JSONL, Parquet …) you click in Chrome in a dbui sheet instead of downloading them. Chrome evaluates the redirect rule itself; dbui never sees the rest of your browsing.
          </p>
          {!inExtension && <div className="note">Open this page from the installed extension to change these settings.</div>}
          {s && (
            <>
              <label className="switch">
                <input type="checkbox" checked={s.enabled} disabled={!inExtension} onChange={(e) => void toggleMaster(e.target.checked)} />
                <span>
                  <b>Open data files from the browser in dbui</b>
                  <br />
                  <small className="muted">Turning this on asks Chrome for access to all sites. Rules only match a file opened as the tab's address.</small>
                </span>
              </label>
              {s.enabled && !granted && (
                <div className="note">
                  <b>Site access was removed.</b> The rules stay off until you grant it again.{" "}
                  <button className="btn" onClick={() => void toggleMaster(true)}>
                    Grant access
                  </button>
                </div>
              )}
              <fieldset disabled={!s.enabled} style={{ border: 0, padding: 0, margin: 0, opacity: s.enabled ? 1 : 0.55 }}>
                <div className="extgroups">
                  {(Object.keys(PREVIEW_GROUPS) as GroupKey[]).map((g) => {
                    const exts = PREVIEW_GROUPS[g];
                    const all = exts.every((e) => s.extensions.includes(e));
                    const some = exts.some((e) => s.extensions.includes(e));
                    return (
                      <div className="extgroup" key={g}>
                        <header>
                          <input
                            type="checkbox"
                            checked={all}
                            ref={(el) => {
                              if (el) el.indeterminate = some && !all;
                            }}
                            onChange={(e) => toggleGroup(exts, e.target.checked)}
                            aria-label={`All ${GROUP_INFO[g].label}`}
                          />
                          {GROUP_INFO[g].label}
                        </header>
                        <div className="exts">
                          {exts.map((ext) => (
                            <label key={ext}>
                              <input type="checkbox" checked={s.extensions.includes(ext)} onChange={(e) => toggleExt(ext, e.target.checked)} />.{ext}
                            </label>
                          ))}
                        </div>
                        {GROUP_INFO[g].note && <small>{GROUP_INFO[g].note}</small>}
                      </div>
                    );
                  })}
                </div>
              </fieldset>
              <div>
                <h3 style={{ margin: "0 0 6px", fontSize: 13 }}>Never open from these sites</h3>
                <div className="domains" style={{ marginBottom: 8 }}>
                  {s.excludedDomains.length === 0 && <span className="faint" style={{ border: 0, background: "none", padding: 0 }}>No sites excluded.</span>}
                  {s.excludedDomains.map((d) => (
                    <span key={d}>
                      {d}
                      <button onClick={() => void save({ ...s, excludedDomains: s.excludedDomains.filter((x) => x !== d) })} aria-label={`Remove ${d}`}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 6, maxWidth: 420 }}>
                  <input className="input mono" style={{ flex: 1 }} placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addDomain()} aria-label="Domain to exclude" />
                  <button className="btn" onClick={addDomain} disabled={!domain.trim() || !inExtension}>
                    Add
                  </button>
                </div>
              </div>
              <div className="note">
                <b>Local files</b> (<span className="mono">file:///…/data.csv</span>) also need <b>Allow access to file URLs</b> turned on for dbui on{" "}
                <a href="#" onClick={(e) => {
                  e.preventDefault();
                  void chrome.tabs?.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
                }}>
                  chrome://extensions
                </a>
                .
              </div>
            </>
          )}
          {err && <div className="err">{err}</div>}
        </section>

        <section id="settings-runner">
          <h2>dbui runner</h2>
          <RunnerCard status={runner.status} onCheck={runner.check} />
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            To uninstall, run <span className="mono">~/Library/Application Support/dbui/uninstall.sh</span>. It removes the binary, the browser manifests and dbui's Keychain items.
          </p>
        </section>

        <section id="settings-privacy">
          <h2>Secrets and storage</h2>
          <p className="muted" style={{ margin: 0, lineHeight: 1.5, fontSize: 12.5 }}>
            Connection settings live in this browser's IndexedDB. Passwords are kept in memory for the session, or in chrome.storage.local when you choose "Remember in this browser". Nothing is synced to your Google account, and secrets never appear in exports.
          </p>
        </section>
      </div>
    </div>
  );
}
