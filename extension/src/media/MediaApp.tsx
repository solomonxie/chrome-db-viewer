import { useCallback, useEffect, useRef, useState } from "react";
import { addExcludedDomain } from "../preview/settings";
import { readSrcParam } from "../preview/src-param";
import { ImageViewer } from "./ImageViewer";
import { fileNameFromUrl, probeMedia, type Probe } from "./kind";
import { downloadOriginal, fetchAny } from "./load";
import { isTypingTarget, Unsupported } from "./shared";
import { findSiblings, indexOfSrc } from "./siblings";
import { VideoViewer } from "./VideoViewer";

function initialSrc(): string | null {
  return readSrcParam(location.search, location.hash)?.src ?? null;
}

function hostnameOf(src: string): string | null {
  try {
    const u = new URL(src);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : null;
  } catch {
    return null;
  }
}

export function MediaApp() {
  const [src, setSrc] = useState<string | null>(initialSrc);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [siblings, setSiblings] = useState<string[]>([]);
  const [infoOpen, setInfoOpen] = useState(() => window.innerWidth >= 720);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [excluded, setExcluded] = useState(false);
  const toastTimer = useRef<number>(0);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 2400);
  }, []);

  useEffect(() => {
    const onPop = () => setSrc(initialSrc());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    setProbe(null);
    document.title = `${fileNameFromUrl(src)} · dbui`;
    void probeMedia(src).then((p) => {
      if (!cancelled) setProbe(p);
    });
    return () => {
      cancelled = true;
    };
  }, [src]);

  // Siblings are looked up once per folder; stepping keeps the list.
  const kind = probe?.kind ?? null;
  useEffect(() => {
    if (!src || !kind) return;
    if (siblings.length > 0 && indexOfSrc(siblings, src) >= 0) return;
    let cancelled = false;
    void findSiblings(src, kind, fetchAny).then((list) => {
      if (!cancelled) setSiblings(list);
    });
    return () => {
      cancelled = true;
    };
  }, [src, kind, siblings]);

  const index = src ? indexOfSrc(siblings, src) : -1;
  const step = useCallback(
    (dir: 1 | -1) => {
      if (index < 0 || siblings.length < 2) return;
      const next = siblings[(index + dir + siblings.length) % siblings.length];
      if (!next) return;
      history.pushState(null, "", `${location.pathname}?src=${encodeURIComponent(next)}`);
      setSrc(next);
    },
    [index, siblings],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      // Arrow keys belong to the <video> controls when they have focus.
      if (e.target instanceof HTMLVideoElement) return;
      if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "i") setInfoOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  const host = src ? hostnameOf(src) : null;
  const neverFromSite = async () => {
    if (!host) return;
    try {
      const d = await addExcludedDomain(host);
      if (d) {
        setExcluded(true);
        toast(`dbui won't open files from ${d} anymore`);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't save the setting");
    }
  };

  if (!src) {
    return (
      <div className="mv">
        <div className="mv-empty">
          <div className="mv-empty-title">No file to show</div>
          <div className="mv-empty-detail">Open an image or video link with Browser preview turned on, or add <code>?src=&lt;url&gt;</code>.</div>
        </div>
      </div>
    );
  }

  const name = fileNameFromUrl(src);
  return (
    <div className="mv">
      <header className="mv-header">
        <div className="mv-brand" aria-hidden="true">dbui</div>
        {siblings.length > 1 && index >= 0 && (
          <div className="mv-nav">
            <button className="mv-btn icon" onClick={() => step(-1)} title="Previous (←)" aria-label="Previous file">←</button>
            <span className="mv-faint mono">{index + 1}/{siblings.length}</span>
            <button className="mv-btn icon" onClick={() => step(1)} title="Next (→)" aria-label="Next file">→</button>
          </div>
        )}
        <div className="mv-title" title={src}>
          <span className="mv-name">{name}</span>
          {host && <span className="mv-host mv-faint">{host}</span>}
        </div>
        <div className="mv-actions">
          <button className={`mv-btn${infoOpen ? " on" : ""}`} onClick={() => setInfoOpen((o) => !o)} title="Info (I)">Info</button>
          <button className="mv-btn" onClick={() => void downloadOriginal(src)} title="Download the original file">Download</button>
          {host && (
            <button className="mv-btn subtle" onClick={() => void neverFromSite()} disabled={excluded} title={`Stop opening files from ${host} in dbui`}>
              {excluded ? "Won't open from this site" : "Never open from this site"}
            </button>
          )}
        </div>
      </header>
      {!probe ? (
        <div className="mv-empty"><div className="mv-loading">Loading…</div></div>
      ) : probe.kind === "image" ? (
        <ImageViewer src={src} name={name} mime={probe.mime} size={probe.size} infoOpen={infoOpen} toast={toast} />
      ) : probe.kind === "video" ? (
        <VideoViewer src={src} name={name} mime={probe.mime} size={probe.size} infoOpen={infoOpen} toast={toast} />
      ) : (
        <Unsupported src={src} title="This isn't an image or video" detail={probe.mime ? `The server says it's ${probe.mime}.` : undefined} />
      )}
      {toastMsg && <div className="mv-toast" role="status">{toastMsg}</div>}
    </div>
  );
}
