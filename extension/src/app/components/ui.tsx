import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Env } from "@core/types";
import { ENGINE, ENV_VAR } from "../lib/format";

export function Modal(props: { title: ReactNode; onClose: () => void; wide?: boolean; children: ReactNode; actions?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("[autofocus], input, select, textarea, button");
    first?.focus();
    return () => prev?.focus?.();
  }, []);
  return (
    <div
      className="scrim"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <div className={"modal" + (props.wide ? " wide" : "")} role="dialog" aria-modal="true" ref={ref}>
        <h3>{props.title}</h3>
        {props.children}
        {props.actions && <div className="acts">{props.actions}</div>}
      </div>
    </div>
  );
}

/** Asks the user to type `expected` before running something dangerous. */
export function TypedConfirm(props: {
  title: string;
  message: ReactNode;
  expected: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const ok = text.trim() === props.expected;
  return (
    <Modal
      title={props.title}
      onClose={props.onCancel}
      actions={
        <>
          <button className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="btn danger" disabled={!ok} onClick={props.onConfirm}>
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <p>{props.message}</p>
      <p>
        Type <b className="mono">{props.expected}</b> to confirm.
      </p>
      <input
        className="input mono"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && ok && props.onConfirm()}
        aria-label="Confirmation text"
      />
    </Modal>
  );
}

const ToastCtx = createContext<(msg: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback((m: string) => {
    setMsg(m);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 2800);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && (
        <div className="toast" role="status">
          {msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

export interface MenuItem {
  label: string;
  hint?: string;
  onClick?: () => void;
  separator?: boolean;
  disabled?: boolean;
}

export function ContextMenu(props: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const close = () => props.onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    setTimeout(() => window.addEventListener("mousedown", close), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [props]);
  const left = Math.min(props.x, window.innerWidth - 220);
  const top = Math.min(props.y, window.innerHeight - props.items.length * 28 - 16);
  return (
    <div className="menu" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()} role="menu">
      {props.items.map((it, i) =>
        it.separator ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              props.onClose();
              it.onClick?.();
            }}
          >
            {it.label}
            {it.hint && <small>{it.hint}</small>}
          </button>
        ),
      )}
    </div>
  );
}

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette(props: { commands: PaletteCommand[]; onClose: () => void; placeholder?: string }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const needle = q.toLowerCase();
  const hits = props.commands.filter((c) => c.label.toLowerCase().includes(needle));
  const run = (c: PaletteCommand | undefined) => {
    if (!c) return;
    props.onClose();
    c.run();
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          autoFocus
          placeholder={props.placeholder ?? "Type a command or table name…"}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => Math.min(hits.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") run(hits[idx]);
            else if (e.key === "Escape") props.onClose();
          }}
        />
        <ul role="listbox">
          {hits.slice(0, 60).map((c, i) => (
            <li key={c.id} className={i === idx ? "on" : ""} onMouseEnter={() => setIdx(i)} onClick={() => run(c)} role="option" aria-selected={i === idx}>
              {c.label}
              {c.hint && <small>{c.hint}</small>}
            </li>
          ))}
          {hits.length === 0 && <li className="faint">No matches</li>}
        </ul>
      </div>
    </div>
  );
}

export function EngineBadge({ driver, demo, large }: { driver: string; demo?: boolean; large?: boolean }) {
  const e = ENGINE[(demo ? "demo" : driver) as keyof typeof ENGINE];
  return (
    <span className={"engine" + (large ? " lg" : "")} title={e?.name ?? driver}>
      {e?.badge ?? driver.slice(0, 2)}
    </span>
  );
}

export function EnvTag({ env }: { env: Env }) {
  return (
    <span className={"envtag " + env} style={{ ["--envc" as string]: ENV_VAR[env] }}>
      {env}
    </span>
  );
}

/** Highlights `needle` occurrences in `text` (case-insensitive). */
export function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  for (;;) {
    const j = lower.indexOf(n, i);
    if (j < 0) break;
    if (j > i) out.push(text.slice(i, j));
    out.push(<mark key={j}>{text.slice(j, j + n.length)}</mark>);
    i = j + n.length;
  }
  out.push(text.slice(i));
  return <>{out}</>;
}
