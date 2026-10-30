// The connection page's in-page tab strip: click to switch, middle-click or × to close,
// right-click for Close / Close others / Close to the right / Duplicate, drag to reorder,
// and the active tab scrolled into view when the strip overflows.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ContextMenu, Modal, type MenuItem } from "../../components/ui";
import { Icon, type IconName } from "../../components/Icon";
import { ALT, MOD } from "../../lib/keys";
import type { WorkTab } from "../model";

export interface TabInfo {
  label: string;
  title: string;
  icon: IconName;
  dirty: boolean;
}

export function TabStrip(props: {
  tabs: WorkTab[];
  activeId: string | null;
  info: (t: WorkTab) => TabInfo;
  nav?: ReactNode;
  onActivate: (id: string) => void;
  onClose: (ids: string[]) => void;
  onCloseOthers: (id: string) => void;
  onCloseRight: (id: string) => void;
  onDuplicate: (id: string) => void;
  onMove: (id: string, to: number) => void;
  onNew: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const dragId = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // Keep the active tab visible when the strip scrolls.
  useEffect(() => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-tab="${props.activeId}"]`);
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [props.activeId, props.tabs.length]);

  const menuItems = (id: string): MenuItem[] => {
    const i = props.tabs.findIndex((t) => t.id === id);
    return [
      { label: "Close", hint: `${ALT}W`, onClick: () => props.onClose([id]) },
      { label: "Close others", disabled: props.tabs.length < 2, onClick: () => props.onCloseOthers(id) },
      { label: "Close to the right", disabled: i === props.tabs.length - 1, onClick: () => props.onCloseRight(id) },
      { separator: true, label: "" },
      { label: "Duplicate", onClick: () => props.onDuplicate(id) },
    ];
  };

  const endDrag = () => {
    dragId.current = null;
    setDropAt(null);
  };

  return (
    <div className="wtabs">
      {props.nav}
      <div className="scroller" role="tablist" ref={scroller} onDragLeave={(e) => e.currentTarget === e.target && setDropAt(null)}>
        {props.tabs.map((t, i) => {
          const { label, title, icon, dirty } = props.info(t);
          return (
            <div
              key={t.id}
              data-tab={t.id}
              className={"wtab" + (dropAt === i ? " drop-before" : "") + (dropAt === i + 1 && i === props.tabs.length - 1 ? " drop-after" : "")}
              role="tab"
              aria-selected={t.id === props.activeId}
              draggable
              onClick={() => props.onActivate(t.id)}
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                props.onClose([t.id]);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, id: t.id });
              }}
              onDragStart={(e) => {
                dragId.current = t.id;
                e.dataTransfer?.setData("text/plain", label);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (!dragId.current) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setDropAt(r.width && e.clientX > r.left + r.width / 2 ? i + 1 : i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = dragId.current;
                const at = dropAt ?? i;
                endDrag();
                if (!id) return;
                const from = props.tabs.findIndex((x) => x.id === id);
                props.onMove(id, from < at ? at - 1 : at);
              }}
              onDragEnd={endDrag}
              title={title}
            >
              <Icon name={icon} className={"ico wtab-ico k-" + icon} />
              <span className="wtab-label">{label}</span>
              {dirty && <span className="pdot" title="Pending changes" />}
              <button
                className="x"
                draggable={false}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onClose([t.id]);
                }}
                aria-label={`Close ${label}`}
                title={`Close (${ALT}W)`}
              >
                <Icon name="close" />
              </button>
            </div>
          );
        })}
        <button className="wtab wtab-new" onClick={props.onNew} title={`New query tab (${ALT}T)`} aria-label="New query tab">
          <Icon name="plus" />
        </button>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.id)} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** In-page confirm before closing tabs whose tables have pending edits. */
export function CloseDirtyConfirm(props: { names: string[]; count: number; onDiscard: () => void; onKeep: () => void; onCancel: () => void }) {
  const what = props.names.length === 1 ? <b>{props.names[0]}</b> : `${props.names.length} tabs`;
  return (
    <Modal
      title="Close tab with pending changes?"
      onClose={props.onCancel}
      actions={
        <>
          <button className="btn" onClick={props.onCancel} autoFocus>
            Cancel
          </button>
          <button className="btn" onClick={props.onKeep}>
            Close, keep changes
          </button>
          <button className="btn danger" onClick={props.onDiscard}>
            Discard and close
          </button>
        </>
      }
    >
      <p>
        {what} {props.names.length === 1 ? "has" : "have"} {props.count} pending change{props.count === 1 ? "" : "s"} that {props.count === 1 ? "isn't" : "aren't"} committed yet.
      </p>
      <p className="faint">
        Kept changes stay in the review drawer (<kbd>{MOD}⇧P</kbd>) until you commit or undo them.
      </p>
    </Modal>
  );
}
