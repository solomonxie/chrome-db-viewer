// Toolbar popup (DESIGN.md §4.1): the only connection list; there is no Home page. Saved
// connections, grouped. Clicking one (or ↑↓ + Enter) opens it in its tab (focusing the one already
// showing it) and closes the popup. Workflows also keep one tab each.
// Each row's ⋯ opens an action strip under it: Edit, Duplicate (password included), Move to
// group, Export, Delete. New connection and Edit show the engine picker and form right here.
// Under the connections, the 4 most recently changed workflows and All workflows (#workflows).
// The footer has New connection and Settings; data files open passively (§3.12), so no button.

import { useEffect, useMemo, useState } from "react";
import { groupConnections, subtitleOf } from "../app/components/ConnectionPicker";
import { EngineBadge } from "../app/components/ui";
import { ConnectionForm, EnginePicker } from "../app/conn/NewConnection";
import type { DriverId } from "@core/types";
import type { FormState } from "../app/lib/connForm";
import { Icon, type IconName } from "../app/components/Icon";
import { copyFormats } from "../app/lib/copyAs";
import { isDemo } from "../app/demo/demoDriver";
import {
  deleteConnection,
  duplicateConnection,
  exportConnection,
  listConnections,
  openConnection,
  resolveSecret,
  saveConnection,
  type SavedConnection,
} from "../app/lib/connections";
import { ENV_VAR, fmtAgo } from "../app/lib/format";
import { focusOrOpen, parseRoute } from "../app/lib/route";
import { allChains } from "../app/chains/chainStore";
import type { Chain } from "../collections/model";

/** How many recent workflows the popup lists; "All workflows" opens the full list. */
export const RECENT_WORKFLOWS = 4;

/**
 * Opens an app page (`#new`, `#edit/<id>`, `#settings`, `#workflows`, `#workflow/<id>`). With
 * `reuse`, a tab already showing that page is focused instead (one tab per workflow, Settings,
 * Workflows); one-job pages (the connection editor) always get a new tab.
 */
export async function openAppPage(hash: string, reuse = false): Promise<void> {
  if (reuse) return focusOrOpen(parseRoute(hash));
  await chrome.tabs.create({ url: chrome.runtime.getURL("app.html") + hash });
}

const RUN_LABEL = { done: "passed", failed: "failed", cancelled: "stopped", blocked: "blocked" } as const;

type Panel = { id: string; mode: "menu" | "group" | "delete" | "copy" };
type Sheet =
  | { kind: "pick" }
  | { kind: "form"; driver: DriverId; prefill?: Partial<FormState>; existing?: SavedConnection };

export function Popup(props: { onDone?: () => void }) {
  const done = props.onDone ?? (() => window.close());
  const [conns, setConns] = useState<SavedConnection[] | null>(null);
  const [active, setActive] = useState(0);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [groupName, setGroupName] = useState("");
  const [note, setNote] = useState("");
  // The password, when it is remembered, so "Copy as" can offer a URL that includes it.
  const [copySecretValue, setCopySecretValue] = useState<string | null>(null);

  const [workflows, setWorkflows] = useState<Chain[]>([]);
  const reload = () => void listConnections().then(setConns);
  useEffect(reload, []);
  useEffect(() => {
    void allChains().then((cs) => setWorkflows(cs.slice(0, RECENT_WORKFLOWS)), () => {});
  }, []);
  const allGroups = useMemo(
    () => [...new Set((conns ?? []).map((c) => c.group).filter((g): g is string => !!g && g !== "Demo"))].sort(),
    [conns],
  );

  const groups = useMemo(() => groupConnections(conns ?? []), [conns]);
  const flat = groups.flatMap((g) => g.conns);
  const showHeaders = groups.length > 1 || (groups[0] && groups[0].group !== "");

  const open = async (c: SavedConnection | undefined) => {
    if (!c) return;
    await openConnection(c);
    done();
  };
  const app = async (hash: string, reuse = false) => {
    await openAppPage(hash, reuse);
    done();
  };

  const duplicate = async (c: SavedConnection) => {
    const { copy, missingSecret } = await duplicateConnection(c);
    setPanel(null);
    setNote(missingSecret ? `Duplicated as ${copy.name}. Its password was only typed for one session, so the copy will ask for it.` : `Duplicated as ${copy.name}`);
    reload();
  };
  const moveToGroup = async (c: SavedConnection) => {
    const g = groupName.trim();
    await saveConnection({ ...c, group: g || undefined });
    setPanel(null);
    setNote(g ? `Moved ${c.name} to ${g}` : `${c.name} is ungrouped`);
    reload();
  };
  const remove = async (c: SavedConnection) => {
    await deleteConnection(c.id);
    setPanel(null);
    setNote(`Moved ${c.name} to the Trash (Settings › Trash)`);
    reload();
  };

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNote(`Copied ${label.toLowerCase()}`);
    } catch {
      setNote("Chrome blocked the clipboard");
    }
    setPanel(null);
  };

  const item = (icon: IconName, label: string, run: () => void, extra?: { danger?: boolean; hint?: string; sub?: boolean }) => (
    <button key={label} role="menuitem" className={"pop-mi" + (extra?.danger ? " danger" : "")} onClick={run} title={extra?.hint}>
      <Icon name={icon} className="ico" />
      <span>{label}</span>
      {extra?.sub && <Icon name="chevron-right" className="ico sub" />}
    </button>
  );

  const actions = (c: SavedConnection, mode: Panel["mode"]) => {
    if (mode === "delete") {
      return (
        <div className="pop-menu" role="group" aria-label={`Delete ${c.name}`}>
          <p className="pop-menu-q">
            Move <b>{c.name}</b> to the Trash? You can restore it, password included, from Settings › Trash. The database itself is not touched.
          </p>
          <div className="pop-menu-acts">
            <button className="btn sm" onClick={() => setPanel(null)}>
              Cancel
            </button>
            <button className="btn sm danger" onClick={() => void remove(c)}>
              Delete
            </button>
          </div>
        </div>
      );
    }
    if (mode === "group") {
      return (
        <div className="pop-menu" role="group" aria-label={`Move ${c.name} to group`}>
          <div className="pop-menu-acts">
            <input
              className="input"
              autoFocus
              list="pop-groups"
              value={groupName}
              placeholder="Group (empty to ungroup)"
              aria-label="Group name"
              onChange={(e) => setGroupName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") void moveToGroup(c);
                if (e.key === "Escape") setPanel(null);
              }}
            />
            <datalist id="pop-groups">
              {allGroups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
            <button className="btn sm primary" onClick={() => void moveToGroup(c)}>
              Move
            </button>
          </div>
        </div>
      );
    }
    if (mode === "copy") {
      const formats = copyFormats(c, copySecretValue);
      return (
        <div className="pop-menu" role="menu" aria-label={`Copy ${c.name} as`}>
          {item("back", "Copy as", () => setPanel({ id: c.id, mode: "menu" }))}
          <hr />
          {formats.length === 0 && <p className="pop-menu-q">Nothing to copy for this engine.</p>}
          {formats.map((f) => (
            <button key={f.id} role="menuitem" className="pop-mi fmt" onClick={() => void copy(f.label, f.text)} title={f.text}>
              <span>{f.label}</span>
              <code>{f.text.split("\n")[0]}</code>
            </button>
          ))}
        </div>
      );
    }
    return (
      <div className="pop-menu" role="menu" aria-label={`${c.name} actions`}>
        {item("edit", "Edit", () => {
          setPanel(null);
          setSheet({ kind: "form", driver: c.driver, existing: c });
        })}
        {item("copy", "Duplicate", () => void duplicate(c), { hint: "Copies the settings and the saved password" })}
        {item(
          "terminal",
          "Copy as",
          () => {
            void resolveSecret(c).then((v) => setCopySecretValue(v));
            setPanel({ id: c.id, mode: "copy" });
          },
          { sub: true, hint: "Connection URL, CLI command, console link…" },
        )}
        {item("folder", "Move to group", () => {
          setGroupName(c.group ?? "");
          setPanel({ id: c.id, mode: "group" });
        })}
        {item("download", "Export", () => exportConnection(c), { hint: "JSON file, no secrets" })}
        <hr />
        {item("trash", "Delete", () => setPanel({ id: c.id, mode: "delete" }), { danger: true })}
      </div>
    );
  };

  // ↑↓ + Enter on the list. Ignored while typing in a field or while a sheet is open.
  useEffect(() => {
    if (sheet) return;
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select")) return;
      onKeyDown(e);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => Math.min(flat.length - 1, Math.max(0, i + d)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      void open(flat[active]);
    }
  };

  let idx = -1;
  const row = (c: SavedConnection) => {
    idx += 1;
    const i = idx;
    const demo = isDemo(c);
    const open_ = panel?.id === c.id;
    return (
      <div key={c.id}>
      <div
        id={`pop-opt-${i}`}
        role="option"
        aria-selected={i === active}
        className={"cpick-opt" + (i === active ? " on" : "")}
        style={{ ["--envc" as string]: ENV_VAR[c.env] }}
        onMouseEnter={() => setActive(i)}
        onClick={() => void open(c)}
        title={`Open ${c.name} (switches to its tab when it's already open)`}
      >
        <EngineBadge driver={c.driver} demo={demo} />
        <span className="cpick-text">
          <span className="cpick-name">{c.name}</span>
          <small>{subtitleOf(c)}</small>
        </span>
        {c.readOnly && <span className="rotag">read-only</span>}
        <span className="cpick-env" title={c.env}>
          <span className="envdot" aria-hidden />
        </span>
        {!demo && (
          <button
            className={"btn icon ghost pop-more" + (open_ ? " on" : "")}
            aria-label={`More actions for ${c.name}`}
            aria-expanded={open_}
            title="Edit, duplicate, copy as, move to group, export, delete"
            onClick={(e) => {
              e.stopPropagation();
              setNote("");
              setPanel(open_ ? null : { id: c.id, mode: "menu" });
            }}
          >
            <Icon name="more" />
          </button>
        )}
      </div>
      {open_ && actions(c, panel.mode)}
      </div>
    );
  };

  const workflowRow = (w: Chain) => (
    <div
      key={w.id}
      role="listitem"
      className="cpick-opt pop-wf"
      onClick={() => void app(`#workflow/${encodeURIComponent(w.id)}`, true)}
      title={`Open workflow ${w.name} (switches to its tab when it's already open)`}
    >
      <span className="pop-wf-ico" aria-hidden>
        <Icon name="workflow" />
      </span>
      <span className="cpick-text">
        <span className="cpick-name">{w.name}</span>
        <small>
          {w.steps.length} step{w.steps.length === 1 ? "" : "s"}
          {w.lastRun ? ` · ${RUN_LABEL[w.lastRun.status]} ${fmtAgo(w.lastRun.at)}` : " · not run yet"}
        </small>
      </span>
    </div>
  );

  if (sheet) {
    const close = () => setSheet(null);
    const tab = (hash: string) => () => void app(hash);
    return (
      <div className="pop pop-sheet">
        {sheet.kind === "pick" ? (
          <EnginePicker inline={{ openInTab: tab("#new") }} onCancel={close} onPick={(driver, prefill) => setSheet({ kind: "form", driver, prefill })} />
        ) : (
          <ConnectionForm
            inline={{ openInTab: tab(sheet.existing ? `#edit/${encodeURIComponent(sheet.existing.id)}` : `#new/${sheet.driver}`) }}
            driver={sheet.driver}
            prefill={sheet.prefill}
            existing={sheet.existing}
            groups={allGroups}
            onCancel={sheet.existing ? close : () => setSheet({ kind: "pick" })}
            onSaved={(c, connect) => {
              setSheet(null);
              if (connect) void open(c);
              else {
                setNote(`Saved ${c.name}`);
                reload();
              }
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="pop">
      <div className="pop-list">
        <div id="pop-list" role="listbox" aria-label="Connections">
          {groups.map((g) =>
            showHeaders ? (
              <div key={g.group || "_"} role="group" aria-label={g.group || "Ungrouped"}>
                <div className="cpick-group" aria-hidden>
                  {g.group || "Ungrouped"}
                </div>
                {g.conns.map(row)}
              </div>
            ) : (
              g.conns.map(row)
            ),
          )}
        </div>
        <div className="cpick-group pop-wf-head">
          <span>Workflows</span>
          <button className="btn ghost sm pop-wf-all" onClick={() => void app("#workflows", true)} title="Every workflow, plus New workflow and Import from file">
            {workflows.length ? "All workflows" : "New or import"} <Icon name="chevron-right" />
          </button>
        </div>
        <div role="list" aria-label="Recent workflows">
          {workflows.map(workflowRow)}
        </div>
      </div>
      {note && (
        <div className="pop-note" role="status">
          {note}
        </div>
      )}
      <div className="pop-foot">
        <button
          className="btn ghost"
          onClick={() => {
            setPanel(null);
            setNote("");
            setSheet({ kind: "pick" });
          }}
        >
          <Icon name="plus" /> New connection
        </button>
        <span className="spacer" />
        <button className="btn icon ghost" onClick={() => void app("#settings", true)} title="Settings" aria-label="Settings">
          <Icon name="settings" />
        </button>
      </div>
    </div>
  );
}
