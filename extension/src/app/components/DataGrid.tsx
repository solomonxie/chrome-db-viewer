// Virtualised DOM grid: renders only the visible rows. Sticky header with sort, resizable
// columns (double-click a header edge to fit), row numbers, row selection, cell cursor,
// in-place editing, FK arrows and an open-link button on http(s) URLs.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent } from "react";
import type { Cell, Column } from "@core/types";
import { cellText, linkOf } from "../lib/format";
import { isJsonType, isNumericType } from "../lib/coltypes";
import type { SortSpec } from "../lib/filters";
import { Icon } from "./Icon";

// Keep in sync with --row-h / --head-h, which are set on .vgrid from these.
const ROW_H = 32;
const HEAD_H = 34;
const OVERSCAN = 12;

export interface GridCursor {
  row: number;
  col: number;
}

export interface DataGridProps {
  columns: Column[];
  rowCount: number;
  /** Cell value to display (pending edits already applied). */
  value: (row: number, col: number) => Cell;
  rowStatus?: (row: number) => "add" | "del" | null;
  cellEdited?: (row: number, col: number) => boolean;
  sort?: SortSpec[];
  onSort?: (column: string, additive: boolean) => void;
  selection: Set<number>;
  onSelection: (sel: Set<number>, cursor: GridCursor) => void;
  cursor: GridCursor | null;
  editable?: boolean;
  onEdit?: (row: number, col: number, text: string) => void;
  onOpenFk?: (row: number, col: number, newTab: boolean) => void;
  onContextMenu?: (e: RMouseEvent, row: number, col: number) => void;
  /** Enter or double-click on a non-editable grid. */
  onActivate?: (row: number, col: number) => void;
  /** Highlights the cursor column (file sheets). */
  highlightColumn?: boolean;
  /** Changes when the data set changes, to reset widths. */
  resetKey?: string;
  onCopy?: (rows: number[]) => void;
}

function defaultWidth(c: Column): number {
  const t = c.type.toLowerCase();
  if (isNumericType(t)) return 130;
  if (/bool/.test(t)) return 96;
  if (/time|date/.test(t)) return 230;
  if (isJsonType(t)) return 300;
  return Math.min(320, Math.max(140, c.name.length * 10 + 70));
}

export const DataGrid = memo(function DataGrid(p: DataGridProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  const [widths, setWidths] = useState<number[]>(() => p.columns.map(defaultWidth));
  const [editing, setEditing] = useState<{ row: number; col: number; text: string } | null>(null);
  const anchor = useRef<number | null>(null);

  const colKey = p.columns.map((c) => c.name).join("\u0000") + "|" + (p.resetKey ?? "");
  useEffect(() => {
    setWidths(p.columns.map(defaultWidth));
    setEditing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colKey]);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScroll((s) => ({ ...s, height: el.clientHeight })));
    ro.observe(el);
    setScroll({ top: el.scrollTop, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const rnWidth = Math.max(52, String(p.rowCount).length * 10 + 24);
  const lefts = useMemo(() => {
    const out: number[] = [];
    let x = rnWidth;
    for (const w of widths) {
      out.push(x);
      x += w;
    }
    out.push(x);
    return out;
  }, [widths, rnWidth]);
  const totalW = lefts[lefts.length - 1] ?? rnWidth;

  const first = Math.max(0, Math.floor(scroll.top / ROW_H) - OVERSCAN);
  const last = Math.min(p.rowCount, Math.ceil((scroll.top + scroll.height) / ROW_H) + OVERSCAN);

  const scrollIntoView = useCallback(
    (row: number, col: number) => {
      const el = wrap.current;
      if (!el) return;
      const top = HEAD_H + row * ROW_H;
      if (top < el.scrollTop + HEAD_H) el.scrollTop = top - HEAD_H;
      else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
      const l = lefts[col] ?? 0;
      const r = lefts[col + 1] ?? l;
      if (l - rnWidth < el.scrollLeft) el.scrollLeft = l - rnWidth;
      else if (r > el.scrollLeft + el.clientWidth) el.scrollLeft = r - el.clientWidth;
    },
    [lefts, rnWidth],
  );

  const select = (row: number, col: number, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    let sel: Set<number>;
    if (e.shiftKey && anchor.current !== null) {
      sel = new Set();
      const [a, b] = [Math.min(anchor.current, row), Math.max(anchor.current, row)];
      for (let i = a; i <= b; i++) sel.add(i);
    } else if (e.metaKey || e.ctrlKey) {
      sel = new Set(p.selection);
      if (sel.has(row)) sel.delete(row);
      else sel.add(row);
      anchor.current = row;
    } else {
      sel = new Set([row]);
      anchor.current = row;
    }
    p.onSelection(sel, { row, col });
  };

  const startEdit = (row: number, col: number) => {
    if (!p.editable || !p.onEdit || p.rowStatus?.(row) === "del") return;
    const v = p.value(row, col);
    setEditing({ row, col, text: v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v) });
  };

  const commitEdit = (move?: "down" | "right") => {
    if (!editing) return;
    const v = p.value(editing.row, editing.col);
    const before = v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (editing.text !== before) p.onEdit?.(editing.row, editing.col, editing.text === "" && v === null ? "NULL" : editing.text);
    const { row, col } = editing;
    setEditing(null);
    wrap.current?.focus();
    if (move === "down" && row + 1 < p.rowCount) select(row + 1, col, { shiftKey: false, metaKey: false, ctrlKey: false });
    if (move === "right" && col + 1 < p.columns.length) p.onSelection(p.selection, { row, col: col + 1 });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    const cur = p.cursor ?? { row: 0, col: 0 };
    const mod = e.metaKey || e.ctrlKey;
    let next: GridCursor | null = null;
    const page = Math.max(1, Math.floor(scroll.height / ROW_H) - 1);
    switch (e.key) {
      case "ArrowDown":
        next = { row: Math.min(p.rowCount - 1, mod ? p.rowCount - 1 : cur.row + 1), col: cur.col };
        break;
      case "ArrowUp":
        next = { row: Math.max(0, mod ? 0 : cur.row - 1), col: cur.col };
        break;
      case "ArrowRight":
        if (mod) {
          const ref = p.columns[cur.col]?.references;
          if (ref && p.onOpenFk) {
            e.preventDefault();
            p.onOpenFk(cur.row, cur.col, e.altKey);
            return;
          }
        }
        next = { row: cur.row, col: Math.min(p.columns.length - 1, cur.col + 1) };
        break;
      case "ArrowLeft":
        next = { row: cur.row, col: Math.max(0, cur.col - 1) };
        break;
      case "PageDown":
        next = { row: Math.min(p.rowCount - 1, cur.row + page), col: cur.col };
        break;
      case "PageUp":
        next = { row: Math.max(0, cur.row - page), col: cur.col };
        break;
      case "Home":
        next = { row: mod ? 0 : cur.row, col: 0 };
        break;
      case "End":
        next = { row: mod ? p.rowCount - 1 : cur.row, col: p.columns.length - 1 };
        break;
      case "Enter":
        if (p.cursor) {
          e.preventDefault();
          if (p.editable && p.onEdit) startEdit(cur.row, cur.col);
          else p.onActivate?.(cur.row, cur.col);
        }
        return;
      case "a":
        if (mod) {
          e.preventDefault();
          const all = new Set<number>();
          for (let i = 0; i < p.rowCount; i++) all.add(i);
          p.onSelection(all, cur);
        }
        return;
      case "c":
        if (mod && !e.shiftKey && p.onCopy) {
          e.preventDefault();
          p.onCopy([...p.selection].sort((a, b) => a - b));
        }
        return;
    }
    if (next && p.rowCount > 0) {
      e.preventDefault();
      if (e.shiftKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        select(next.row, next.col, { shiftKey: true, metaKey: false, ctrlKey: false });
      } else if (next.row !== cur.row || !p.cursor) {
        select(next.row, next.col, { shiftKey: false, metaKey: false, ctrlKey: false });
      } else {
        p.onSelection(p.selection, next);
      }
      scrollIntoView(next.row, next.col);
    }
  };

  const startResize = (e: RMouseEvent, col: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[col] ?? 100;
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(48, startW + ev.clientX - startX);
      setWidths((ws) => ws.map((x, i) => (i === col ? w : x)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /** Widens (or narrows) a column to its longest value among the first rows, capped at 900px. */
  const fitColumn = (e: RMouseEvent, col: number) => {
    e.stopPropagation();
    const c = p.columns[col]!;
    let longest = c.name.length + c.type.length + 2;
    for (let r = 0; r < Math.min(p.rowCount, 1000); r++) longest = Math.max(longest, Math.min(200, cellText(p.value(r, col)).length));
    const w = Math.min(900, Math.max(60, Math.round(longest * 7.6) + 34));
    setWidths((ws) => ws.map((x, i) => (i === col ? w : x)));
  };

  const sortOf = (name: string) => {
    const i = p.sort?.findIndex((s) => s.column === name) ?? -1;
    if (i < 0) return null;
    const s = p.sort![i]!;
    return { dir: s.dir, n: p.sort!.length > 1 ? i + 1 : null };
  };

  const rows = [];
  for (let r = first; r < last; r++) {
    const status = p.rowStatus?.(r) ?? null;
    const selected = p.selection.has(r);
    const cells = [];
    for (let c = 0; c < p.columns.length; c++) {
      const col = p.columns[c]!;
      const v = p.value(r, c);
      const isCur = p.cursor?.row === r && p.cursor.col === c;
      const isEditing = editing?.row === r && editing.col === c;
      let cls = "c";
      if (v === null) cls += " null";
      else if (typeof v === "object") cls += " json";
      else if (typeof v === "number" || isNumericType(col.type)) cls += " num";
      if (p.cellEdited?.(r, c)) cls += " edit";
      if (isCur) cls += " cur";
      if (p.highlightColumn && p.cursor?.col === c) cls += " curcol";
      cells.push(
        <div
          key={c}
          className={cls}
          style={{ width: widths[c] }}
          onMouseDown={(e) => {
            if (e.button === 2 && selected) {
              p.onSelection(p.selection, { row: r, col: c });
              return;
            }
            if (!isEditing) select(r, c, e);
          }}
          onDoubleClick={() => (p.editable ? startEdit(r, c) : p.onActivate?.(r, c))}
          onContextMenu={(e) => {
            if (p.onContextMenu) {
              e.preventDefault();
              p.onContextMenu(e, r, c);
            }
          }}
          title={v !== null && typeof v === "object" ? JSON.stringify(v) : undefined}
        >
          {isEditing ? (
            <input
              autoFocus
              value={editing.text}
              onChange={(e) => setEditing({ ...editing, text: e.target.value })}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commitEdit("down");
                else if (e.key === "Tab") {
                  e.preventDefault();
                  commitEdit("right");
                } else if (e.key === "Escape") {
                  setEditing(null);
                  wrap.current?.focus();
                }
              }}
              onBlur={() => commitEdit()}
            />
          ) : (
            <>
              <span>{cellText(v).slice(0, 500)}</span>
              {linkOf(v) && (
                <a
                  className="cell-link"
                  href={linkOf(v)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Open ${linkOf(v)} in a new tab`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Icon name="external" className="ico sm" />
                </a>
              )}
              {col.references && v !== null && p.onOpenFk && (
                <button
                  className="fk"
                  title={`Open ${col.references} (⌥-click: new tab)`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onOpenFk!(r, c, e.altKey);
                  }}
                >
                  <Icon name="arrow-right" className="ico sm" />
                </button>
              )}
            </>
          )}
        </div>,
      );
    }
    rows.push(
      <div
        key={r}
        className={"r" + (r % 2 ? " alt" : "") + (selected ? " sel" : "") + (status ? " " + status : "")}
        style={{ top: HEAD_H + r * ROW_H, width: totalW }}
        role="row"
        aria-rowindex={r + 1}
        aria-selected={selected}
      >
        <div className="c rn" style={{ width: rnWidth }} onMouseDown={(e) => select(r, p.cursor?.col ?? 0, e)}>
          {status === "add" ? "+" : r + 1}
        </div>
        {cells}
      </div>,
    );
  }

  return (
    <div
      className="gridwrap"
      ref={wrap}
      tabIndex={0}
      onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
      onKeyDown={onKeyDown}
      role="grid"
      aria-rowcount={p.rowCount}
      aria-colcount={p.columns.length}
    >
      <div className="vgrid" style={{ width: totalW, height: HEAD_H + p.rowCount * ROW_H, ["--row-h" as string]: `${ROW_H}px`, ["--head-h" as string]: `${HEAD_H}px` }}>
        <div className="hdr" style={{ width: totalW }}>
          <div className="hc rn" style={{ width: rnWidth }} title="Reset column widths" onClick={() => setWidths(p.columns.map(defaultWidth))}>
            <Icon name="reset-width" className="ico sm" />
          </div>
          {p.columns.map((c, i) => {
            const s = sortOf(c.name);
            return (
              <div
                key={c.name + i}
                className={"hc" + (p.highlightColumn && p.cursor?.col === i ? " cur" : "")}
                style={{ width: widths[i] }}
                onClick={(e) => p.onSort?.(c.name, e.shiftKey)}
                title={`${c.name} ${c.type}${c.primaryKey ? " · primary key" : ""}${c.references ? " → " + c.references : ""}\nClick to sort, ⇧-click to add a sort`}
                role="columnheader"
                aria-sort={s ? (s.dir === "asc" ? "ascending" : "descending") : undefined}
              >
                {c.primaryKey && <Icon name="key" className="ico sm pk" title="Primary key" />}
                <span>{c.name}</span>
                <small>{c.type}</small>
                {s && (
                  <span className="arrow">
                    {s.dir === "asc" ? "▲" : "▼"}
                    {s.n}
                  </span>
                )}
                <span className="rs" onMouseDown={(e) => startResize(e, i)} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => fitColumn(e, i)} title="Drag to resize, double-click to fit the content" />
              </div>
            );
          })}
        </div>
        {rows}
      </div>
    </div>
  );
});
