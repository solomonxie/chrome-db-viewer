// Presentational bits shared by the left-pane trees (Items, Collections, Workflows):
// a hover-revealed chevron, kind icons, the folding pane sections and the inline rename field.

import { useRef, useState, type ReactNode } from "react";
import { Icon, objectIcon, type IconName } from "./Icon";

/** Expand/collapse chevron; faint until the row is hovered. Renders an empty slot for leaves. */
export function Chevron({ open, leaf, loading, onToggle }: { open: boolean; leaf?: boolean; loading?: boolean; onToggle?: (e: React.MouseEvent) => void }) {
  return (
    <span className={"tw" + (open ? " open" : "") + (loading ? " loading" : "")} onClick={onToggle} aria-hidden>
      {!leaf && <Icon name="chevron-right" className="ico chev" />}
    </span>
  );
}

/** Muted icon for an object kind; nothing for kinds without one (groups). */
export function KindIcon({ type, name }: { type?: string; name?: IconName }) {
  const n = name ?? objectIcon(type);
  return n ? <Icon name={n} className={"ico kind k-" + (type ?? n)} /> : null;
}

export interface PaneTab<K extends string> {
  key: K;
  label: string;
  icon: IconName;
  hint?: string;
}

/**
 * Left-pane sections stacked as folding headers (Items, Collections, …). One is open at a time:
 * its header is a full-width accent bar and its body fills the space below it; the others stay
 * folded underneath. No chevrons at this level: the bar alone marks the open one. Clicking the open one folds it.
 */
export function PaneSections<K extends string>(props: { sections: (PaneTab<K> & { body: ReactNode })[]; value: K | null; onChange: (k: K | null) => void }) {
  return (
    <div className="psecs">
      {props.sections.map((t) => {
        const open = props.value === t.key;
        return (
          <section key={t.key} className={"psec" + (open ? " open" : "")} aria-label={t.label}>
            <button
              className="psec-head"
              aria-expanded={open}
              onClick={() => props.onChange(open ? null : t.key)}
              title={t.hint ? `${t.label}: ${t.hint}` : t.label}
            >
              <span className="lbl">{t.label}</span>
            </button>
            {open && <div className="psec-body">{t.body}</div>}
          </section>
        );
      })}
    </div>
  );
}

/**
 * Inline rename field that takes a tree row's label place (rows are buttons, so this renders as
 * a sibling over the row). Enter or blur saves, Esc cancels. Starts with the text selected.
 * An empty or unchanged name keeps the old one.
 */
export function InlineName(props: { value: string; label: string; indent?: number; onDone: (name: string | null) => void }) {
  const [text, setText] = useState(props.value);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    const t = name?.trim();
    props.onDone(t && t !== props.value ? t : null);
  };
  return (
    <div className="node inline-name" style={{ paddingLeft: props.indent }}>
      <input
        className="input"
        value={text}
        aria-label={props.label}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") finish(text);
          else if (e.key === "Escape") finish(null);
        }}
        onBlur={() => finish(text)}
      />
    </div>
  );
}
