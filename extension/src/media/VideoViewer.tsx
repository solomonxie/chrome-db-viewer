import { useCallback, useEffect, useRef, useState } from "react";
import { formatDuration, replaceExtension } from "./kind";
import { canvasToBlob, saveBlob } from "./load";
import { InfoPanel, isTypingTarget, Unsupported, type ViewerProps } from "./shared";

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const DEFAULT_FPS = 30;

interface FrameMetadata {
  mediaTime: number;
  presentedFrames: number;
}
type FrameCallback = (now: number, meta: FrameMetadata) => void;
interface VideoExtras {
  requestVideoFrameCallback?: (cb: FrameCallback) => number;
  cancelVideoFrameCallback?: (id: number) => void;
  audioTracks?: { length: number };
  videoTracks?: { length: number };
}

interface Stats {
  width: number;
  height: number;
  duration: number;
  total?: number;
  dropped?: number;
  audioTracks?: number;
  videoTracks?: number;
}

export function VideoViewer({ src, name, mime, infoOpen, toast }: ViewerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // No crossorigin attribute: CORS mode makes servers without CORS headers fail outright, while a
  // plain request plays everywhere (COEP is satisfied by DNR rule 3's CORP header). The cost is a
  // tainted canvas for cross-origin video, so the screenshot reports that instead of failing.
  const [screenshotBlocked, setScreenshotBlocked] = useState(false);
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null);
  const [speed, setSpeed] = useState(1);
  const [fps, setFps] = useState<number | null>(null);
  const [loopA, setLoopA] = useState<number | null>(null);
  const [loopB, setLoopB] = useState<number | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [time, setTime] = useState(0);

  useEffect(() => {
    setScreenshotBlocked(false);
    setError(null);
    setLoopA(null);
    setLoopB(null);
    setFps(null);
    setStats(null);
  }, [src]);

  useEffect(() => {
    const v = videoRef.current;
    if (v) v.playbackRate = speed;
  }, [speed]);

  // Frame rate from requestVideoFrameCallback: presented frames over media time while playing.
  useEffect(() => {
    const v = videoRef.current as (HTMLVideoElement & VideoExtras) | null;
    if (!v?.requestVideoFrameCallback) return;
    let last: FrameMetadata | null = null;
    let id = 0;
    const samples: number[] = [];
    const cb: FrameCallback = (_now, meta) => {
      if (last && meta.mediaTime > last.mediaTime && meta.presentedFrames > last.presentedFrames && v.playbackRate === 1) {
        const est = (meta.presentedFrames - last.presentedFrames) / (meta.mediaTime - last.mediaTime);
        if (est > 1 && est < 241) {
          samples.push(est);
          if (samples.length > 30) samples.shift();
          const sorted = [...samples].sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length / 2)] ?? est;
          setFps(Math.round(median * 100) / 100);
        }
      }
      last = meta;
      id = v.requestVideoFrameCallback!(cb);
    };
    id = v.requestVideoFrameCallback(cb);
    return () => v.cancelVideoFrameCallback?.(id);
  }, [src]);

  // Loop A–B: check every animation frame while a loop is set (timeupdate is too coarse).
  useEffect(() => {
    if (loopA === null || loopB === null || loopB <= loopA) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v && (v.currentTime >= loopB || v.currentTime < loopA - 0.25)) v.currentTime = loopA;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loopA, loopB]);

  const readStats = useCallback(() => {
    const v = videoRef.current as (HTMLVideoElement & VideoExtras) | null;
    if (!v) return;
    const q = typeof v.getVideoPlaybackQuality === "function" ? v.getVideoPlaybackQuality() : null;
    setStats({
      width: v.videoWidth,
      height: v.videoHeight,
      duration: v.duration,
      total: q?.totalVideoFrames,
      dropped: q?.droppedVideoFrames,
      audioTracks: v.audioTracks?.length,
      videoTracks: v.videoTracks?.length,
    });
  }, []);

  useEffect(() => {
    if (!infoOpen) return;
    const t = setInterval(readStats, 1000);
    return () => clearInterval(t);
  }, [infoOpen, readStats]);

  const frameStep = useCallback(
    (dir: 1 | -1) => {
      const v = videoRef.current;
      if (!v) return;
      v.pause();
      const step = 1 / (fps ?? DEFAULT_FPS);
      v.currentTime = Math.min(Math.max(0, v.currentTime + dir * step), Number.isFinite(v.duration) ? v.duration : Infinity);
    },
    [fps],
  );

  const screenshot = useCallback(async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    try {
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext("2d")?.drawImage(v, 0, 0);
      let png: Blob;
      try {
        png = await canvasToBlob(c, "image/png");
      } catch {
        setScreenshotBlocked(true);
        toast("Screenshot unavailable: this server doesn't allow it");
        return;
      }
      const stamp = formatDuration(v.currentTime).replace(/[:.]/g, "-");
      await saveBlob(png, replaceExtension(`${name.replace(/\.[^.]+$/, "")}-${stamp}`, "png"));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't capture the frame");
    }
  }, [name, toast]);

  const togglePip = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Picture-in-picture isn't available");
    }
  }, [toast]);

  const setPoint = (which: "a" | "b") => {
    const t = videoRef.current?.currentTime ?? 0;
    if (which === "a") {
      setLoopA(t);
      if (loopB !== null && loopB <= t) setLoopB(null);
    } else {
      if (loopA === null) setLoopA(0);
      if (loopA !== null && t <= loopA) {
        toast("B must be after A");
        return;
      }
      setLoopB(t);
    }
  };

  const changeSpeed = (dir: 1 | -1) => {
    const i = SPEEDS.indexOf(speed);
    const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? 3 : i) + dir))] ?? 1;
    setSpeed(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ",") frameStep(-1);
      else if (e.key === ".") frameStep(1);
      else if (e.key === "<") changeSpeed(-1);
      else if (e.key === ">") changeSpeed(1);
      else if (e.key === "[") setPoint("a");
      else if (e.key === "]") setPoint("b");
      else if (e.key === "\\") {
        setLoopA(null);
        setLoopB(null);
      } else if (e.key === "p") void togglePip();
      else if (e.key === "s") void screenshot();
      else if (e.key === " " && e.target === document.body) {
        e.preventDefault();
        const v = videoRef.current;
        if (v) void (v.paused ? v.play() : v.pause());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onError = () => {
    const v = videoRef.current;
    const code = v?.error?.code;
    if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || code === MediaError.MEDIA_ERR_DECODE) {
      setError({
        title: "Chrome can't decode this file",
        detail: `${name} uses a container or codec this browser can't play (MKV, HEVC and ProRes often aren't).`,
      });
    } else {
      setError({ title: "Couldn't load this video", detail: v?.error?.message || "The server didn't return the file." });
    }
  };

  if (error) return <Unsupported src={src} title={error.title} detail={error.detail} />;

  const fmt = (t: number | null) => (t === null ? "—" : formatDuration(t));
  const pipOk = typeof document !== "undefined" && document.pictureInPictureEnabled;
  const quality =
    stats?.total !== undefined ? `${stats.total.toLocaleString()} frames, ${(stats.dropped ?? 0).toLocaleString()} dropped` : "—";

  return (
    <div className="mv-body">
      <div className="mv-toolbar" role="toolbar" aria-label="Video tools">
        <label className="mv-select" title="Speed (< >)">
          <span className="sr-only">Speed</span>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>{s}×</option>
            ))}
          </select>
        </label>
        <button className="mv-btn icon" onClick={() => frameStep(-1)} title="Previous frame (,)" aria-label="Previous frame">⏮</button>
        <button className="mv-btn icon" onClick={() => frameStep(1)} title="Next frame (.)" aria-label="Next frame">⏭</button>
        <span className="mv-sep" />
        <button className={`mv-btn${loopA !== null ? " on" : ""}`} onClick={() => setPoint("a")} title="Set loop start ([)">A {loopA !== null && <span className="mono">{fmt(loopA)}</span>}</button>
        <button className={`mv-btn${loopB !== null ? " on" : ""}`} onClick={() => setPoint("b")} title="Set loop end (])">B {loopB !== null && <span className="mono">{fmt(loopB)}</span>}</button>
        {(loopA !== null || loopB !== null) && (
          <button className="mv-btn" onClick={() => { setLoopA(null); setLoopB(null); }} title="Clear loop (\)">Clear</button>
        )}
        <span className="mv-sep" />
        {pipOk && <button className="mv-btn" onClick={() => void togglePip()} title="Picture-in-picture (P)">PiP</button>}
        <button className="mv-btn" onClick={() => void screenshot()} disabled={screenshotBlocked} title={screenshotBlocked ? "Screenshot unavailable: this server doesn't allow it" : "Save the current frame as PNG (S)"}>Screenshot</button>
        <span className="mv-zoom mono">{formatDuration(time)}</span>
      </div>
      <div className="mv-main">
        <div className="mv-stage video">
          <video
            key={src}
            ref={videoRef}
            className="mv-video"
            src={src}
            controls
            autoPlay
            playsInline
            preload="metadata"
            onLoadedMetadata={(e) => {
              e.currentTarget.playbackRate = speed;
              readStats();
            }}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onError={onError}
          />
        </div>
        {infoOpen && (
          <InfoPanel
            rows={[
              ["Duration", stats && Number.isFinite(stats.duration) ? formatDuration(stats.duration) : "—"],
              ["Resolution", stats?.width ? `${stats.width} × ${stats.height}` : "—"],
              ["Frame rate", fps ? `${fps} fps` : `${DEFAULT_FPS} fps (assumed)`],
              ["Type", mime?.split(";")[0] || name.split(".").pop()?.toUpperCase() || "—"],
              ["Playback", quality],
              ...(stats?.videoTracks !== undefined || stats?.audioTracks !== undefined
                ? ([["Tracks", `${stats?.videoTracks ?? "?"} video, ${stats?.audioTracks ?? "?"} audio`]] as [string, React.ReactNode][])
                : []),
              ["Loop", loopA !== null && loopB !== null ? `${fmt(loopA)} → ${fmt(loopB)}` : "Off"],
            ]}
          >
            {screenshotBlocked && <p className="mv-note">Screenshot unavailable: this server doesn't allow it (no CORS headers).</p>}
          </InfoPanel>
        )}
      </div>
    </div>
  );
}
