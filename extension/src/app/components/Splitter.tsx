import { useCallback, useEffect, useRef, useState } from "react";

// Drag bar between two panes. Drag, arrow keys (Shift for bigger steps), or double-click to
// reset. `side` says which neighbour it sizes: "left" grows as you drag right, "right" grows
// as you drag left, "top" (a horizontal bar between stacked panes) grows as you drag down, and
// "bottom" (a bar above a bottom panel) grows as you drag up.

export interface PaneSize {
  width: number;
  min: number;
  max: number;
  defaultWidth: number;
}

export function clampWidth(width: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, width)));
}

/** Width state persisted per key in localStorage (a per-viewer layout preference). */
export function usePaneWidth(key: string, defaultWidth: number, min: number, max: number) {
  const [width, setWidthState] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(key));
      return saved ? clampWidth(saved, min, max) : defaultWidth;
    } catch {
      return defaultWidth;
    }
  });
  const setWidth = useCallback(
    (w: number) => {
      const next = clampWidth(w, min, max);
      setWidthState(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // storage blocked: keep the size for this session only
      }
    },
    [key, min, max],
  );
  return { width, setWidth, min, max, defaultWidth } as PaneSize & { setWidth: (w: number) => void };
}

export function Splitter(props: {
  side: "left" | "right" | "top" | "bottom";
  label: string;
  size: PaneSize;
  onResize: (width: number) => void;
}) {
  const { side, size, onResize } = props;
  const [dragging, setDragging] = useState(false);
  const vertical = side === "top" || side === "bottom";
  const start = useRef({ pos: 0, width: 0 });

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const d = (vertical ? e.clientY : e.clientX) - start.current.pos;
      onResize(start.current.width + (side === "right" || side === "bottom" ? -d : d));
    };
    const up = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    document.body.classList.add(vertical ? "resizing-rows" : "resizing");
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.body.classList.remove(vertical ? "resizing-rows" : "resizing");
    };
  }, [dragging, side, vertical, onResize]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    const grow = side === "top" ? "ArrowDown" : side === "bottom" ? "ArrowUp" : side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "top" ? "ArrowUp" : side === "bottom" ? "ArrowDown" : side === "left" ? "ArrowLeft" : "ArrowRight";
    if (e.key === grow) onResize(size.width + step);
    else if (e.key === shrink) onResize(size.width - step);
    else if (e.key === "Home") onResize(size.min);
    else if (e.key === "End") onResize(size.max);
    else return;
    e.preventDefault();
  };

  return (
    <div
      className={`splitter${vertical ? " rows" : ""}${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation={vertical ? "horizontal" : "vertical"}
      aria-label={props.label}
      aria-valuenow={size.width}
      aria-valuemin={size.min}
      aria-valuemax={size.max}
      tabIndex={0}
      title={`${props.label}: drag to resize, double-click to reset`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        start.current = { pos: vertical ? e.clientY : e.clientX, width: size.width };
        setDragging(true);
      }}
      onDoubleClick={() => onResize(size.defaultWidth)}
      onKeyDown={onKeyDown}
    >
      <span className="grip" aria-hidden="true" />
    </div>
  );
}
