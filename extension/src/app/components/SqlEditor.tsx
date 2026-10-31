// Plain textarea with a highlighted copy of its text drawn underneath. Typing, undo, IME and
// selection stay native; only the colours come from the layer behind. With `completion`, a
// suggestion list (src/app/lib/completion.ts) opens at the caret as you type a name or a dot:
// ↑/↓ to move, Enter or Tab to insert, Esc to close, ⌃Space to open it on demand. Otherwise
// Tab indents with 4 spaces (Shift+Tab outdents) rather than moving focus.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from "react";
import { tokenize } from "../lib/sqlFormat";
import { complete, type Completion, type CompletionContext, type CompletionSource } from "../lib/completion";
import { handleTabKey } from "../lib/indent";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
  /** Names to suggest; no list when omitted. */
  completion?: { source: CompletionSource; quote: (name: string) => string };
};

interface Popup {
  ctx: CompletionContext;
  items: Completion[];
  active: number;
  top: number;
  left: number;
}

const KIND_BADGE: Record<Completion["kind"], string> = { keyword: "kw", function: "fn", schema: "sc", table: "tb", view: "vw", column: "co" };

export const SqlEditor = forwardRef<HTMLTextAreaElement, Props>(function SqlEditor({ value, onChange, onKeyDown, onScroll, className, completion, ...rest }, ref) {
  const layer = useRef<HTMLPreElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => input.current!, []);
  const tokens = useMemo(() => tokenize(value), [value]);
  const [popup, setPopup] = useState<Popup | null>(null);
  const request = useRef(0);

  // Caret position inside the editor box, measured with a marker in a copy of the text.
  const caretXY = useCallback((pos: number) => {
    const ta = input.current;
    const ly = layer.current;
    if (!ta || !ly) return { top: 0, left: 0 };
    const probe = ly.cloneNode(false) as HTMLPreElement;
    probe.style.visibility = "hidden";
    probe.textContent = ta.value.slice(0, pos);
    const mark = document.createElement("span");
    mark.textContent = "​";
    probe.appendChild(mark);
    ly.parentElement!.appendChild(probe);
    const top = mark.offsetTop - ta.scrollTop + (mark.offsetHeight || 20);
    const left = mark.offsetLeft - ta.scrollLeft;
    probe.remove();
    return { top, left };
  }, []);

  const refresh = useCallback(
    async (text: string, cursor: number, force = false) => {
      if (!completion) return;
      const id = ++request.current;
      const before = text[cursor - 1] ?? "";
      if (!force && !/[A-Za-z0-9_.$"`]/.test(before)) {
        setPopup(null);
        return;
      }
      const res = await complete(text, cursor, completion.source, completion.quote);
      if (id !== request.current) return;
      if (!res || res.items.length === 0 || (res.items.length === 1 && res.items[0]!.insert === text.slice(res.ctx.from, res.ctx.to))) {
        setPopup(null);
        return;
      }
      setPopup({ ctx: res.ctx, items: res.items, active: 0, ...caretXY(res.ctx.from) });
    },
    [completion, caretXY],
  );

  const accept = (item: Completion) => {
    if (!popup) return;
    const { from, to } = popup.ctx;
    const next = value.slice(0, from) + item.insert + value.slice(to);
    onChange(next);
    setPopup(null);
    const caret = from + item.insert.length;
    requestAnimationFrame(() => input.current?.setSelectionRange(caret, caret));
  };

  // A click elsewhere or losing focus closes the list.
  useEffect(() => {
    if (!popup) return;
    const ta = input.current;
    const close = () => setPopup(null);
    ta?.addEventListener("blur", close);
    return () => ta?.removeEventListener("blur", close);
  }, [popup]);

  useEffect(() => {
    document.getElementById(`sqlac-${popup?.active ?? 0}`)?.scrollIntoView?.({ block: "nearest" });
  }, [popup?.active]);

  return (
    <div className={"sqled " + (className ?? "")}>
      <pre ref={layer} className="sqled-layer" aria-hidden="true">
        {tokens.map((t, i) => (t.kind === "text" ? t.text : <span key={i} className={"tk-" + t.kind}>{t.text}</span>))}
        {/* A trailing newline needs a character after it, or the layer ends one line short. */}
        {"\n "}
      </pre>
      <textarea
        ref={input}
        className="sqled-input"
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        role={completion ? "combobox" : undefined}
        aria-expanded={completion ? !!popup : undefined}
        aria-autocomplete={completion ? "list" : undefined}
        aria-activedescendant={popup ? `sqlac-${popup.active}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          void refresh(e.target.value, e.target.selectionStart);
        }}
        onScroll={(e) => {
          if (layer.current) {
            layer.current.scrollTop = e.currentTarget.scrollTop;
            layer.current.scrollLeft = e.currentTarget.scrollLeft;
          }
          setPopup(null);
          onScroll?.(e);
        }}
        onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
          if (completion && e.key === " " && e.ctrlKey) {
            e.preventDefault();
            void refresh(value, e.currentTarget.selectionStart, true);
            return;
          }
          if (popup) {
            const n = popup.items.length;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const d = e.key === "ArrowDown" ? 1 : -1;
              setPopup({ ...popup, active: (popup.active + d + n) % n });
              return;
            }
            if ((e.key === "Enter" || e.key === "Tab") && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
              e.preventDefault();
              accept(popup.items[popup.active]!);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setPopup(null);
              return;
            }
            if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") setPopup(null);
          }
          onKeyDown?.(e);
          // Tab indents (4 spaces) instead of leaving the editor; Shift+Tab outdents.
          if (!e.defaultPrevented) handleTabKey(e, onChange);
        }}
        {...rest}
      />
      {popup && (
        <div className="sqlac" role="listbox" aria-label="Suggestions" style={{ top: popup.top, left: Math.max(0, popup.left) }}>
          {popup.items.map((it, i) => (
            <div
              key={it.kind + it.label + i}
              id={`sqlac-${i}`}
              role="option"
              aria-selected={i === popup.active}
              className={"sqlac-opt k-" + it.kind + (i === popup.active ? " on" : "")}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(it);
              }}
              onMouseEnter={() => setPopup({ ...popup, active: i })}
            >
              <span className="sqlac-kind" title={it.kind}>
                {KIND_BADGE[it.kind]}
              </span>
              <span className="sqlac-label">{it.label}</span>
              {it.detail && <span className="sqlac-detail">{it.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
