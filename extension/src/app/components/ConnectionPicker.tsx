// Searchable connection dropdown (ARIA combobox + listbox). Home uses it as the main picker;
// the connection page uses a compact one in its top bar as a switcher. Opening is the
// caller's job (onOpen); this component only selects, filters and reports.

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  compareGroups,
  connectionSubtitle,
  type SavedConnection,
} from "../lib/connections";
import { isDemo } from "../demo/demoDriver";
import { ENV_VAR } from "../lib/format";
import { EngineBadge, Highlight } from "./ui";
import { Icon, type IconName } from "./Icon";

/** A non-connection row at the bottom of the list, e.g. "New connection…". */
export interface PickerAction {
  id: string;
  label: string;
  icon?: IconName;
  run: () => void;
}

type Item =
  | { kind: "conn"; conn: SavedConnection }
  | { kind: "action"; action: PickerAction };

export function subtitleOf(c: SavedConnection): string {
  return isDemo(c)
    ? "Sample data in memory"
    : connectionSubtitle(c) || c.driver;
}

/** Groups in display order (ungrouped, A-Z, Demo last), each sorted by last use then name. */
export function groupConnections(
  conns: SavedConnection[],
  needle = "",
): { group: string; conns: SavedConnection[] }[] {
  const n = needle.trim().toLowerCase();
  const hits = conns
    .filter(
      (c) =>
        !n ||
        `${c.name} ${subtitleOf(c)} ${c.driver} ${c.env} ${c.group ?? ""}`
          .toLowerCase()
          .includes(n),
    )
    .sort(
      (a, b) =>
        (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) ||
        a.name.localeCompare(b.name),
    );
  const names = [...new Set(hits.map((c) => c.group ?? ""))].sort(
    compareGroups,
  );
  return names.map((group) => ({
    group,
    conns: hits.filter((c) => (c.group ?? "") === group),
  }));
}

export function ConnectionPicker(props: {
  connections: SavedConnection[];
  selectedId: string | null;
  /** Highlight moved to a connection by click or Enter (Home keeps it as its selection). */
  onSelect?: (c: SavedConnection) => void;
  /** Enter on a connection, double-click, or (with openOnClick) a single click. */
  onOpen: (c: SavedConnection) => void;
  /** Single click opens instead of selecting (the top-bar switcher). */
  openOnClick?: boolean;
  actions?: PickerAction[];
  compact?: boolean;
  /** Marks this connection as the one the page shows (switcher). */
  currentId?: string;
  label?: string;
  autoFocus?: boolean;
  /** Extra content after the input when closed (e.g. Home's env tag). */
  trailing?: ReactNode;
}) {
  const { connections, selectedId, compact } = props;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/:/g, "");
  const listId = `cpick-list-${uid}`;
  const optId = (i: number) => `cpick-${uid}-${i}`;

  const selected = connections.find((c) => c.id === selectedId) ?? null;
  const groups = useMemo(
    () => groupConnections(connections, open ? q : ""),
    [connections, q, open],
  );
  const actions = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (props.actions ?? []).filter(
      (a) => !open || !n || a.label.toLowerCase().includes(n),
    );
  }, [props.actions, q, open]);
  const items: Item[] = useMemo(
    () => [
      ...groups.flatMap((g) =>
        g.conns.map((conn) => ({ kind: "conn" as const, conn })),
      ),
      ...actions.map((action) => ({ kind: "action" as const, action })),
    ],
    [groups, actions],
  );
  const showHeaders =
    groups.length > 1 || (groups[0] && groups[0].group !== "");

  const openList = () => {
    if (open) return;
    setQ("");
    const i = selected
      ? groupConnections(connections)
          .flatMap((g) => g.conns)
          .findIndex((c) => c.id === selected.id)
      : 0;
    setActive(Math.max(0, i));
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setQ("");
  };

  // Click outside closes.
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("mousedown", on);
    return () => window.removeEventListener("mousedown", on);
  }, [open]);

  // Keep the active option in view.
  useEffect(() => {
    if (!open) return;
    document
      .getElementById(optId(active))
      ?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open]);

  const choose = (it: Item | undefined, how: "enter" | "click" | "dbl") => {
    if (!it) return;
    if (it.kind === "action") {
      close();
      it.action.run();
      return;
    }
    const c = it.conn;
    props.onSelect?.(c);
    close();
    if (how === "enter" || how === "dbl" || props.openOnClick) props.onOpen(c);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return openList();
      const d = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => Math.min(items.length - 1, Math.max(0, i + d)));
    } else if (e.key === "Home" && open) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && open) {
      e.preventDefault();
      setActive(items.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open) choose(items[active], "enter");
      else if (selected) props.onOpen(selected);
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    } else if (e.key === "Tab") {
      close();
    }
  };

  const activeItem = open ? items[active] : undefined;
  const envc = selected ? ENV_VAR[selected.env] : undefined;
  let idx = -1;
  const optionRow = (it: Item, key: string) => {
    idx += 1;
    const i = idx;
    const on = i === active;
    if (it.kind === "action") {
      return (
        <div
          key={key}
          id={optId(i)}
          role="option"
          aria-selected={on}
          className={"cpick-opt act" + (on ? " on" : "")}
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => choose(it, "click")}
        >
          <span className="cpick-acticon">
            {it.action.icon && <Icon name={it.action.icon} />}
          </span>
          <span className="cpick-name">{it.action.label}</span>
        </div>
      );
    }
    const c = it.conn;
    const demo = isDemo(c);
    const isSel = c.id === (props.currentId ?? selectedId);
    return (
      <div
        key={key}
        id={optId(i)}
        role="option"
        aria-selected={on}
        aria-current={isSel || undefined}
        data-id={c.id}
        className={"cpick-opt" + (on ? " on" : "") + (isSel ? " sel" : "")}
        style={{ ["--envc" as string]: ENV_VAR[c.env] }}
        onMouseEnter={() => setActive(i)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => choose(it, "click")}
        onDoubleClick={() => choose(it, "dbl")}
        title={
          props.openOnClick
            ? `Open ${c.name} in a new tab`
            : `${c.name}: double-click to connect`
        }
      >
        <EngineBadge driver={c.driver} demo={demo} />
        <span className="cpick-text">
          <span className="cpick-name">
            <Highlight text={c.name} needle={q.trim()} />
          </span>
          <small>
            <Highlight text={subtitleOf(c)} needle={q.trim()} />
          </small>
        </span>
        {c.readOnly && <span className="rotag">read-only</span>}
        <span className="cpick-env" title={c.env}>
          <span className="envdot" aria-hidden />
          {!compact && c.env}
        </span>
        {isSel && <Icon name="check" className="ico cpick-check" />}
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      className={"cpick" + (compact ? " compact" : "") + (open ? " open" : "")}
      style={envc ? { ["--envc" as string]: envc } : undefined}
    >
      <div
        className="cpick-field"
        onMouseDown={(e) => {
          if (e.target === inputRef.current) return;
          e.preventDefault();
          inputRef.current?.focus();
          if (open) close();
          else openList();
        }}
      >
        {open || !selected ? (
          <Icon name="search" className="ico cpick-lead" />
        ) : (
          <EngineBadge driver={selected.driver} demo={isDemo(selected)} />
        )}
        <span className="cpick-input-wrap">
          <input
            ref={inputRef}
            role="combobox"
            aria-label={props.label ?? "Connection"}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeItem ? optId(active) : undefined}
            autoFocus={props.autoFocus}
            spellCheck={false}
            autoComplete="off"
            placeholder={open ? "Search connections…" : "Choose a connection…"}
            value={open ? q : (selected?.name ?? "")}
            onChange={(e) => {
              if (!open) openList();
              setQ(e.target.value);
              setActive(0);
            }}
            onClick={() => openList()}
            onKeyDown={onKeyDown}
          />
          {!open && selected && !compact && (
            <small className="cpick-sub">{subtitleOf(selected)}</small>
          )}
        </span>
        {!open && props.trailing}
        <Icon name="chevron-down" className="ico cpick-chev" />
      </div>
      {open && (
        <div className="cpick-pop" ref={listRef}>
          <div
            id={listId}
            role="listbox"
            aria-label={props.label ?? "Connections"}
          >
            {groups.map((g) =>
              showHeaders ? (
                <div
                  key={g.group || "_"}
                  role="group"
                  aria-label={g.group || "Ungrouped"}
                >
                  <div className="cpick-group" aria-hidden>
                    {g.group || "Ungrouped"}
                  </div>
                  {g.conns.map((c) =>
                    optionRow({ kind: "conn", conn: c }, c.id),
                  )}
                </div>
              ) : (
                g.conns.map((c) => optionRow({ kind: "conn", conn: c }, c.id))
              ),
            )}
            {groups.length === 0 && (
              <div className="cpick-empty">
                No connection matches “{q.trim()}”.
              </div>
            )}
            {actions.length > 0 && (
              <div role="group" aria-label="Actions" className="cpick-actions">
                {actions.map((a) =>
                  optionRow({ kind: "action", action: a }, "a:" + a.id),
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
