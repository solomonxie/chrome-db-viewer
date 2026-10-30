// Presentational bits shared by the left-pane trees (Items, Collections, Workflows):
// a hover-revealed chevron, kind icons, and the segmented pane-tab control.

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

/** Compact segmented control for the pane tabs; labels collapse to icons when the pane is narrow. */
export function PaneTabs<K extends string>(props: { tabs: PaneTab<K>[]; value: K; onChange: (k: K) => void; trailing?: ReactNode }) {
  return (
    <div className="ptabs" role="tablist">
      {props.tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={props.value === t.key} onClick={() => props.onChange(t.key)} title={t.hint ? `${t.label}: ${t.hint}` : t.label} aria-label={t.label}>
          <Icon name={t.icon} className="ico" />
          <span className="lbl">{t.label}</span>
        </button>
      ))}
      {props.trailing}
    </div>
  );
}
