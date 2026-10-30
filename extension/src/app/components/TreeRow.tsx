// Presentational bits shared by the left-pane trees (Items, Collections, Workflows):
// a hover-revealed chevron, kind icons, and the folding pane sections.

import type { ReactNode } from "react";
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
