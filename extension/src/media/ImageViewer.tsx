import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatCoordinates, parseExif, type ExifData } from "./exif";
import { formatBytes, replaceExtension } from "./kind";
import { canvasToBlob, loadBlob, saveBlob } from "./load";
import { InfoPanel, isTypingTarget, Unsupported, type ViewerProps } from "./shared";

type Zoom = "fit" | number;

const MIN_SCALE = 0.02;
const MAX_SCALE = 64;
const ZOOM_STEPS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

interface Picked {
  x: number;
  y: number;
  hex: string;
  rgb: [number, number, number];
  alpha: number;
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function ImageViewer({ src, name, mime, size, infoOpen, toast }: ViewerProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const pixelsRef = useRef<CanvasRenderingContext2D | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [directUrl, setDirectUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [decodeError, setDecodeError] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [exif, setExif] = useState<ExifData | null>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [tainted, setTainted] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Load the bytes once per src: EXIF and an untainted canvas both need them.
  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    setObjectUrl(null);
    setDirectUrl(null);
    setBlob(null);
    setLoadError(null);
    setDecodeError(false);
    setNatural(null);
    setExif(null);
    setZoom("fit");
    setPan({ x: 0, y: 0 });
    setRotation(0);
    setPicked(null);
    setTainted(false);
    pixelsRef.current = null;
    loadBlob(src).then(
      async (b) => {
        if (cancelled) return;
        made = URL.createObjectURL(b);
        setBlob(b);
        setObjectUrl(made);
        const head = new Uint8Array(await b.slice(0, 512 * 1024).arrayBuffer());
        if (!cancelled) setExif(parseExif(head));
      },
      (err: unknown) => {
        if (cancelled) return;
        // Let the browser try the URL itself (e.g. a host that refuses extension fetches).
        setLoadError(err instanceof Error ? err.message : String(err));
        setDirectUrl(src);
      },
    );
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [src]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setStage({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const quarterTurned = rotation % 180 !== 0;
  const fitScale = useMemo(() => {
    if (!natural || !stage.w || !stage.h) return 1;
    const w = quarterTurned ? natural.h : natural.w;
    const h = quarterTurned ? natural.w : natural.h;
    return Math.min(1, (stage.w - 32) / w, (stage.h - 32) / h);
  }, [natural, stage, quarterTurned]);
  const scale = zoom === "fit" ? fitScale : zoom;

  const zoomTo = useCallback(
    (next: number, anchor?: { x: number; y: number }) => {
      const s = clamp(next, MIN_SCALE, MAX_SCALE);
      if (anchor) {
        // Keep the point under the cursor still: pan' = a - (a - pan) * s / scale.
        const k = s / scale;
        setPan((p) => ({ x: anchor.x - (anchor.x - p.x) * k, y: anchor.y - (anchor.y - p.y) * k }));
      }
      setZoom(s);
    },
    [scale],
  );

  const stepZoom = useCallback(
    (dir: 1 | -1) => {
      const next = dir > 0 ? ZOOM_STEPS.find((z) => z > scale * 1.001) : [...ZOOM_STEPS].reverse().find((z) => z < scale * 0.999);
      zoomTo(next ?? (dir > 0 ? MAX_SCALE : MIN_SCALE));
    },
    [scale, zoomTo],
  );

  const fit = useCallback(() => {
    setZoom("fit");
    setPan({ x: 0, y: 0 });
  }, []);

  const actual = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const rotate = useCallback((dir: 1 | -1) => {
    setRotation((r) => (r + dir * 90 + 360) % 360);
    setPan({ x: 0, y: 0 });
  }, []);

  // Keyboard: ⌘+ ⌘- ⌘0 (blocks the browser's page zoom here), r / R rotate, i is handled by the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        stepZoom(1);
      } else if (mod && e.key === "-") {
        e.preventDefault();
        stepZoom(-1);
      } else if (mod && e.key === "0") {
        e.preventDefault();
        fit();
      } else if (!mod && !e.altKey && e.key.toLowerCase() === "r") {
        rotate(e.shiftKey ? -1 : 1);
      } else if (!mod && e.key === "1") {
        actual();
      } else if (e.key === "Escape") {
        setPicking(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepZoom, fit, rotate, actual]);

  // Wheel + ⌘/Ctrl (and trackpad pinch, which sends ctrlKey) zooms at the cursor; plain wheel pans.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.metaKey || e.ctrlKey) {
        const anchor = { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
        zoomTo(scale * Math.exp(-e.deltaY * 0.0025), anchor);
      } else {
        setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scale, zoomTo]);

  // Drag to pan.
  const drag = useRef<{ id: number; x: number; y: number; px: number; py: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (picking || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    setDragging(true);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (drag.current?.id === e.pointerId) {
      drag.current = null;
      setDragging(false);
    }
  };

  const drawRotated = useCallback(
    (bg?: string): HTMLCanvasElement | null => {
      const img = imgRef.current;
      if (!img || !natural) return null;
      const c = document.createElement("canvas");
      c.width = quarterTurned ? natural.h : natural.w;
      c.height = quarterTurned ? natural.w : natural.h;
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, c.width, c.height);
      }
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.drawImage(img, -natural.w / 2, -natural.h / 2);
      return c;
    },
    [natural, rotation, quarterTurned],
  );

  const pixelContext = (): CanvasRenderingContext2D | null => {
    if (pixelsRef.current) return pixelsRef.current;
    const img = imgRef.current;
    if (!img || !natural || tainted) return null;
    const c = document.createElement("canvas");
    c.width = natural.w;
    c.height = natural.h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    try {
      ctx.getImageData(0, 0, 1, 1);
    } catch {
      setTainted(true);
      return null;
    }
    pixelsRef.current = ctx;
    return ctx;
  };

  /** Maps a client point to image pixel coordinates by undoing pan, rotation and scale. */
  const toImagePoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = stageRef.current;
    if (!el || !natural) return null;
    const r = el.getBoundingClientRect();
    const dx = clientX - (r.left + r.width / 2 + pan.x);
    const dy = clientY - (r.top + r.height / 2 + pan.y);
    const t = (-rotation * Math.PI) / 180;
    const ux = (dx * Math.cos(t) - dy * Math.sin(t)) / scale;
    const uy = (dx * Math.sin(t) + dy * Math.cos(t)) / scale;
    const x = Math.floor(ux + natural.w / 2);
    const y = Math.floor(uy + natural.h / 2);
    return x >= 0 && y >= 0 && x < natural.w && y < natural.h ? { x, y } : null;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d && d.id === e.pointerId) {
      setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y });
      return;
    }
    if (!picking) return;
    const pt = toImagePoint(e.clientX, e.clientY);
    const ctx = pt ? pixelContext() : null;
    if (!pt || !ctx) return;
    const [r = 0, g = 0, b = 0, a = 255] = ctx.getImageData(pt.x, pt.y, 1, 1).data;
    setPicked({ x: pt.x, y: pt.y, hex: toHex(r, g, b), rgb: [r, g, b], alpha: a / 255 });
  };

  const onStageClick = () => {
    if (picking && picked) void copyText(picked.hex);
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${text}`);
    } catch {
      toast("Couldn't copy to the clipboard");
    }
  };

  const copyImage = async () => {
    try {
      const c = drawRotated();
      if (!c) return;
      const png = await canvasToBlob(c, "image/png");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      toast("Image copied");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't copy the image");
    }
  };

  const saveAs = async (type: "png" | "webp" | "jpeg") => {
    try {
      const c = drawRotated(type === "jpeg" ? "#ffffff" : undefined);
      if (!c) return;
      const out = await canvasToBlob(c, `image/${type}`, type === "png" ? undefined : 0.92);
      await saveBlob(out, replaceExtension(name, type === "jpeg" ? "jpg" : type));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't save the image");
    }
  };

  const imgSrc = objectUrl ?? directUrl;
  if (decodeError) {
    return (
      <Unsupported
        src={src}
        title="Chrome can't decode this file"
        detail={loadError ? loadError : `${name} isn't an image format this browser can show (HEIC and TIFF often aren't).`}
      />
    );
  }

  const exifRows: [string, React.ReactNode][] = [];
  if (exif) {
    const camera = [exif.make, exif.model && exif.make && exif.model.startsWith(exif.make) ? exif.model.slice(exif.make.length).trim() : exif.model]
      .filter(Boolean)
      .join(" ");
    if (camera) exifRows.push(["Camera", camera]);
    if (exif.lensModel) exifRows.push(["Lens", exif.lensModel]);
    if (exif.dateTimeOriginal) exifRows.push(["Taken", exif.dateTimeOriginal.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3")]);
    if (exif.gps) {
      const { latitude, longitude } = exif.gps;
      exifRows.push([
        "GPS",
        <a key="gps" href={`https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=15/${latitude}/${longitude}`} target="_blank" rel="noreferrer">
          {formatCoordinates(latitude, longitude)}
        </a>,
      ]);
    }
    if (exif.gps?.altitude !== undefined) exifRows.push(["Altitude", `${exif.gps.altitude.toFixed(1)} m`]);
  }

  const zoomLabel = `${Math.round(scale * 100)}%`;
  return (
    <div className="mv-body">
      <div className="mv-toolbar" role="toolbar" aria-label="Image tools">
        <button className={`mv-btn${zoom === "fit" ? " on" : ""}`} onClick={fit} title="Fit (⌘0)">Fit</button>
        <button className={`mv-btn${zoom === 1 ? " on" : ""}`} onClick={actual} title="Actual size (1)">100%</button>
        <button className="mv-btn icon" onClick={() => stepZoom(-1)} title="Zoom out (⌘−)" aria-label="Zoom out">−</button>
        <span className="mv-zoom mono" aria-live="polite">{zoomLabel}</span>
        <button className="mv-btn icon" onClick={() => stepZoom(1)} title="Zoom in (⌘+)" aria-label="Zoom in">+</button>
        <span className="mv-sep" />
        <button className="mv-btn icon" onClick={() => rotate(-1)} title="Rotate left (⇧R)" aria-label="Rotate left">⟲</button>
        <button className="mv-btn icon" onClick={() => rotate(1)} title="Rotate right (R)" aria-label="Rotate right">⟳</button>
        <span className="mv-sep" />
        <button className={`mv-btn${picking ? " on" : ""}`} onClick={() => setPicking((p) => !p)} disabled={!natural || tainted} title="Colour picker: hover to sample, click to copy hex">Pick colour</button>
        <button className="mv-btn" onClick={() => void copyImage()} disabled={!natural || tainted}>Copy</button>
        <label className="mv-select">
          <span className="sr-only">Save as</span>
          <select
            value=""
            disabled={!natural || tainted}
            onChange={(e) => {
              const v = e.target.value as "png" | "webp" | "jpeg" | "";
              if (v) void saveAs(v);
            }}
          >
            <option value="">Save as…</option>
            <option value="png">PNG</option>
            <option value="webp">WebP</option>
            <option value="jpeg">JPEG</option>
          </select>
        </label>
      </div>
      <div className="mv-main">
        <div
          ref={stageRef}
          className={`mv-stage checker${picking ? " picking" : ""}${dragging ? " dragging" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClick={onStageClick}
          onDoubleClick={() => (zoom === "fit" ? actual() : fit())}
        >
          {imgSrc && (
            <img
              ref={imgRef}
              className="mv-img"
              src={imgSrc}
              alt={name}
              draggable={false}
              style={{
                transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) rotate(${rotation}deg) scale(${scale})`,
                imageRendering: scale >= 4 ? "pixelated" : "auto",
                visibility: natural ? "visible" : "hidden",
              }}
              onLoad={(e) => {
                const el = e.currentTarget;
                // SVGs without intrinsic size report 0; give them a sensible canvas.
                setNatural({ w: el.naturalWidth || 300, h: el.naturalHeight || 150 });
              }}
              onError={() => setDecodeError(true)}
            />
          )}
          {!imgSrc && !loadError && <div className="mv-loading">Loading…</div>}
          {picking && picked && (
            <div className="mv-picked mono" onClick={(e) => e.stopPropagation()}>
              <span className="mv-swatch" style={{ background: picked.hex }} />
              <button className="mv-link" onClick={() => void copyText(picked.hex)}>{picked.hex}</button>
              <button className="mv-link" onClick={() => void copyText(`rgb(${picked.rgb.join(", ")})`)}>
                rgb({picked.rgb.join(", ")}){picked.alpha < 1 ? ` α ${picked.alpha.toFixed(2)}` : ""}
              </button>
              <span className="mv-faint">
                {picked.x}, {picked.y}
              </span>
            </div>
          )}
        </div>
        {infoOpen && (
          <InfoPanel
            rows={[
              ["Dimensions", natural ? `${natural.w} × ${natural.h}` : "—"],
              ["Size", formatBytes(blob?.size ?? size)],
              ["Type", blob?.type || mime?.split(";")[0] || name.split(".").pop()?.toUpperCase() || "—"],
              ["Zoom", zoomLabel],
              ...(rotation ? ([["Rotation", `${rotation}°`]] as [string, React.ReactNode][]) : []),
              ...exifRows,
            ]}
          >
            {tainted && <p className="mv-note">This image came from another site without CORS, so colour picking, copy and save are off.</p>}
            {loadError && directUrl && <p className="mv-note">Shown directly by the browser ({loadError}); file size and EXIF aren't available.</p>}
          </InfoPanel>
        )}
      </div>
    </div>
  );
}
