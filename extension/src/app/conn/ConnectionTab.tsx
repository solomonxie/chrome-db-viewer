// Connection tab (DESIGN.md §4.2): top status capsule, left Items/Queries/History, centre
// table and query tabs, right Details pane, pending ChangeSet with review drawer.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Capabilities, ConnectionConfig, Driver, DriverId, ObjectPath, ObjectType, TableSchema } from "@core/types";
import { connectionSubtitle, listConnections, loadConnection, openConnection, needsSecret, openDriver, resolveSecret, saveConnection, secretMode, withSecret, type SavedConnection } from "../lib/connections";
import { isDemo } from "../demo/demoDriver";
import { clearTable, emptyPending, pendingCount, toChangeSet, undo, type PendingState } from "../lib/changes";
import { tableRef } from "../lib/filters";
import { ENGINE, ENV_VAR } from "../lib/format";
import { ALT, MOD, useKeys } from "../lib/keys";
import { navigate, openConnectionTab } from "../lib/route";
import { classifyRunnerError, runnerDrivers, type RunnerStatus } from "../lib/runner";
import * as db from "../store/db";
import { secretStore, sessionSecrets } from "../store/secrets";
import { CommandPalette, Modal, useToast, type PaletteCommand } from "../components/ui";
import { RunnerCard } from "../home/RunnerCard";
import { ConnectionForm, EnginePicker } from "../home/NewConnection";
import type { FormState } from "../lib/connForm";
import { DetailsPane } from "./DetailsPane";
import { LeftPane } from "./LeftPane";
import { Splitter, usePaneWidth } from "../components/Splitter";
import { QueryView } from "./QueryView";
import { ReviewDrawer } from "./ReviewDrawer";
import { TableView } from "./TableView";
import { newEntry, pathKey, type ConnCtx, type DetailsSource, type EditMode, type TableEntry, type WorkTab } from "./model";
import { historyTarget } from "./historyTab";
import { closeIds, duplicateTab, findTableTab, loadSavedTabs, moveTab, nextActive, othersOf, rightOf, saveTabs } from "./tabs/tabState";
import { CloseDirtyConfirm, TabStrip } from "./tabs/TabStrip";
import { Icon, objectIcon } from "../components/Icon";
import { ConnectionPicker } from "../components/ConnectionPicker";
import type { NamedQuery } from "../../collections/model";

type Phase =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "password"; cfg: SavedConnection; error?: string }
  | { kind: "connecting"; cfg: SavedConnection }
  | { kind: "runner"; cfg: SavedConnection; status: RunnerStatus }
  | { kind: "error"; cfg: SavedConnection; message: string }
  | { kind: "ready"; cfg: SavedConnection; driver: Driver; caps: Capabilities; version?: string };

let tabSeq = 0;
const tabId = () => `t${++tabSeq}`;

/** The Details pane starts hidden; turning it on is remembered for the whole app. */
const DETAILS_KEY = "dbui.pane.details.visible";
function loadDetailsVisible(): boolean {
  try {
    return localStorage.getItem(DETAILS_KEY) === "1";
  } catch {
    return false;
  }
}
function saveDetailsVisible(v: boolean) {
  try {
    localStorage.setItem(DETAILS_KEY, v ? "1" : "0");
  } catch {
    /* storage blocked */
  }
}

function editModeFor(cfg: ConnectionConfig, caps: Capabilities): EditMode {
  if (!caps.editableRows) return "none";
  if (cfg.driver === "clickhouse") return "insert";
  if (cfg.driver === "bigquery") return "none";
  return "full";
}

export function ConnectionTab({ connectionId }: { connectionId: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const toast = useToast();

  const connect = useCallback(async (cfg: SavedConnection, secret: string | null) => {
    setPhase({ kind: "connecting", cfg });
    let driver: Driver;
    try {
      driver = await openDriver(cfg);
    } catch (e) {
      setPhase({ kind: "error", cfg, message: (e as Error).message });
      return;
    }
    try {
      const r = await driver.connect(withSecret(cfg, secret));
      setPhase({ kind: "ready", cfg, driver, caps: driver.capabilities(), version: r.serverVersion });
    } catch (e) {
      const msg = (e as Error).message;
      if (runnerDrivers.has(cfg.driver) && /native messaging host|not found|exited/i.test(msg)) {
        setPhase({ kind: "runner", cfg, status: classifyRunnerError(msg) });
      } else if (needsSecret(cfg) && /auth|password|denied|credential/i.test(msg)) {
        setPhase({ kind: "password", cfg, error: msg });
      } else {
        setPhase({ kind: "error", cfg, message: msg });
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfg = await loadConnection(connectionId).catch(() => undefined);
      if (cancelled) return;
      if (!cfg) return setPhase({ kind: "missing" });
      document.title = `${cfg.name} · dbui`;
      if (needsSecret(cfg)) {
        const secret = await resolveSecret(cfg);
        if (cancelled) return;
        if (secret === null) return setPhase({ kind: "password", cfg });
        return void connect(cfg, secret);
      }
      void connect(cfg, null);
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionId, connect]);

  // Disconnect when the tab goes away.
  const driverRef = useRef<Driver | null>(null);
  useEffect(() => {
    driverRef.current = phase.kind === "ready" ? phase.driver : null;
  }, [phase]);
  useEffect(() => () => void driverRef.current?.disconnect().catch(() => {}), []);

  switch (phase.kind) {
    case "loading":
      return <Centered>Loading…</Centered>;
    case "missing":
      return (
        <Centered>
          <p>This connection no longer exists.</p>
          <button className="btn" onClick={() => navigate({ name: "home" })}>
            Go to Home
          </button>
        </Centered>
      );
    case "password":
      return (
        <PasswordPrompt
          cfg={phase.cfg}
          error={phase.error}
          onSubmit={async (secret, remember) => {
            const ref = phase.cfg.secretRef!;
            await sessionSecrets.set(ref, secret);
            if (remember) {
              await secretStore("browser").set(ref, secret);
              await saveConnection({ ...phase.cfg, options: { ...phase.cfg.options, secretMode: "browser" } });
            }
            void connect(phase.cfg, secret);
          }}
        />
      );
    case "connecting":
      return (
        <Centered>
          <div className="loading-bar" style={{ width: 200 }} />
          <p>
            Connecting to <b>{phase.cfg.name}</b>…
          </p>
        </Centered>
      );
    case "runner":
      return (
        <Centered>
          <div style={{ width: "min(480px, 100%)" }}>
            <RunnerCard
              status={phase.status}
              onCheck={async () => {
                const secret = await resolveSecret(phase.cfg);
                void connect(phase.cfg, secret);
              }}
            />
          </div>
          <button className="btn ghost" onClick={() => navigate({ name: "home" })}>
            Back to Home
          </button>
        </Centered>
      );
    case "error":
      return (
        <Centered>
          <h3 style={{ margin: 0 }}>Couldn't connect to {phase.cfg.name}</h3>
          <div className="err" style={{ maxWidth: 560 }}>
            {phase.message}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn primary"
              onClick={async () => {
                // A stale build can't be retried in place; only reloading loads the new chunks.
                if (phase.message.startsWith("dbui was updated while this tab was open")) return location.reload();
                const secret = await resolveSecret(phase.cfg);
                if (needsSecret(phase.cfg) && secret === null) setPhase({ kind: "password", cfg: phase.cfg });
                else void connect(phase.cfg, secret);
              }}
            >
              {phase.message.startsWith("dbui was updated while this tab was open") ? "Reload tab" : "Retry"}
            </button>
            <button className="btn" onClick={() => navigate({ name: "home" })}>
              Home
            </button>
          </div>
        </Centered>
      );
    case "ready":
      return <Workspace cfg={phase.cfg} driver={phase.driver} caps={phase.caps} version={phase.version} toast={toast} onCfg={(cfg) => setPhase({ ...phase, cfg })} />;
  }
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 16, color: "var(--muted)" }}>{children}</div>;
}

function PasswordPrompt(props: { cfg: SavedConnection; error?: string; onSubmit: (secret: string, remember: boolean) => void }) {
  const [v, setV] = useState("");
  const [remember, setRemember] = useState(secretMode(props.cfg) === "browser");
  const label = props.cfg.driver === "bigquery" ? "Access token" : "Password";
  return (
    <Modal
      title={`${label} for ${props.cfg.name}`}
      onClose={() => navigate({ name: "home" })}
      actions={
        <>
          <button className="btn" onClick={() => navigate({ name: "home" })}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => props.onSubmit(v, remember)}>
            Connect
          </button>
        </>
      }
    >
      <p>{connectionSubtitle(props.cfg)}</p>
      <input className="input mono" type="password" autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && props.onSubmit(v, remember)} aria-label={label} autoComplete="off" />
      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 14 }}>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Remember in this browser (chrome.storage.local, never synced)
      </label>
      {props.error && <div className="err">{props.error}</div>}
    </Modal>
  );
}

function Workspace(props: { cfg: SavedConnection; driver: Driver; caps: Capabilities; version?: string; toast: (m: string) => void; onCfg: (c: SavedConnection) => void }) {
  const { cfg, driver, caps } = props;
  const [readOnly, setReadOnly] = useState(cfg.readOnly);
  const [pending, setPendingState] = useState<PendingState>(emptyPending);
  // Open tabs come back from localStorage (per connection) on mount.
  const [restored] = useState(() => loadSavedTabs(cfg.id, tabId));
  const [tabs, setTabs] = useState<WorkTab[]>(restored.tabs);
  const [activeTab, setActiveTab] = useState<string | null>(restored.active);
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(loadDetailsVisible);
  useEffect(() => saveDetailsVisible(showRight), [showRight]);
  const [closing, setClosing] = useState<null | { ids: string[]; names: string[]; tables: ObjectPath[]; count: number }>(null);
  const leftPane = usePaneWidth("dbui.pane.left", 280, 200, 560);
  const rightPane = usePaneWidth("dbui.pane.right", 340, 260, 720);
  const [details, setDetails] = useState<DetailsSource | null>(null);
  const [drawer, setDrawer] = useState<null | { confirm: boolean }>(null);
  const [applying, setApplying] = useState(false);
  const [applyErr, setApplyErr] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [editing, setEditing] = useState(false);
  /** "New connection…" from the top-bar switcher: engine picker, then the form, in place. */
  const [creating, setCreating] = useState<null | { step: "pick" } | { step: "form"; driver: DriverId; prefill?: Partial<FormState> }>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [treeKey, setTreeKey] = useState(0);
  const [historyVersion, setHistoryVersion] = useState(0);
  /** Query tabs bound to a named query (Collections): tab id → named query id. */
  const [boundTabs, setBoundTabs] = useState<Record<string, string>>(restored.bound);
  const [log, setLog] = useState<{ sql: string; ms?: number; rows?: number; error?: string; at: number }[]>([]);
  const [showLog, setShowLog] = useState(false);
  const nodeTypes = useRef(new Map<string, ObjectType>()).current;
  const schemaCache = useRef(new Map<string, Promise<TableSchema>>()).current;

  const setPending = useCallback((fn: (s: PendingState) => PendingState) => setPendingState(fn), []);

  const addHistory = useCallback(
    (h: { sql: string; ms?: number; rows?: number; error?: string; source: db.HistorySource }) => {
      setLog((l) => [{ ...h, at: Date.now() }, ...l].slice(0, 300));
      void db
        .put("history", { id: db.uid("h_"), connectionId: cfg.id, at: Date.now(), ...h })
        .then(() => setHistoryVersion((v) => v + 1))
        .catch(() => {});
    },
    [cfg.id],
  );

  const ctx: ConnCtx = useMemo(() => {
    const groupIdx = (path: ObjectPath) => path.map((_, i) => i).filter((i) => i < path.length - 1 && nodeTypes.get(pathKey(path.slice(0, i + 1))) === "group");
    return {
      cfg,
      driver,
      caps,
      readOnly,
      pending,
      setPending,
      nodeTypes,
      sqlName: (path) => tableRef(path, groupIdx(path), driver.dialect),
      describe: (path) => {
        const k = pathKey(path);
        let p = schemaCache.get(k);
        if (!p) {
          p = driver.describe(path);
          p.catch(() => schemaCache.delete(k));
          schemaCache.set(k, p);
        }
        return p;
      },
      toast: props.toast,
      addHistory,
      resolveTable: (ref, from) => {
        const parts = ref.split(".");
        const name = parts.at(-1)!;
        // A sibling of the current table in the tree, if it was listed.
        const sibling = [...from.slice(0, -1), name];
        if (nodeTypes.has(pathKey(sibling))) return sibling;
        for (const k of nodeTypes.keys()) {
          const p = JSON.parse(k) as string[];
          if (p.at(-1) === name && ["table", "view"].includes(nodeTypes.get(k)!)) return p;
        }
        return sibling;
      },
      editMode: editModeFor(cfg, caps),
    };
  }, [cfg, driver, caps, readOnly, pending, setPending, nodeTypes, schemaCache, props.toast, addHistory]);

  const active = tabs.find((t) => t.id === activeTab) ?? null;
  const activeEntry = active?.kind === "table" ? active.stack[active.pos]! : null;

  // Remember the open tabs for this connection. Each browser tab writes its own list; the last
  // write wins, which is fine for two windows on the same connection.
  useEffect(() => {
    saveTabs(cfg.id, tabs, activeTab, boundTabs);
  }, [cfg.id, tabs, activeTab, boundTabs]);

  /** Opens a table in its own tab, or switches to the tab already showing it. ⌥/⌘ forces a new one. */
  const openTable = (path: ObjectPath, newTab = false) => {
    const existing = !newTab && findTableTab(tabs, path);
    if (existing) return setActiveTab(existing.id);
    const t: WorkTab = { id: tabId(), kind: "table", stack: [newEntry(path)], pos: 0 };
    setTabs((ts) => [...ts, t]);
    setActiveTab(t.id);
  };

  /** FK navigation: pushes onto the back/forward stack of the tab it came from (or a new tab). */
  const pushEntry = (entry: TableEntry, newTab: boolean, fromTab = activeTab) => {
    const from = tabs.find((t) => t.id === fromTab);
    if (newTab || from?.kind !== "table") {
      const t: WorkTab = { id: tabId(), kind: "table", stack: [entry], pos: 0 };
      setTabs((ts) => [...ts, t]);
      setActiveTab(t.id);
      return;
    }
    setTabs((ts) => ts.map((t) => (t.id === from.id && t.kind === "table" ? { ...t, stack: [...t.stack.slice(0, t.pos + 1), entry], pos: t.pos + 1 } : t)));
  };

  const patchEntry = (tabIdArg: string, patch: Partial<TableEntry>) =>
    setTabs((ts) => ts.map((t) => (t.id === tabIdArg && t.kind === "table" ? { ...t, stack: t.stack.map((e, i) => (i === t.pos ? { ...e, ...patch } : e)) } : t)));

  const go = (delta: number) => {
    if (active?.kind !== "table") return;
    const pos = active.pos + delta;
    if (pos < 0 || pos >= active.stack.length) return;
    setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, pos } : t)));
  };

  const openSql = (sql = "", title = "Query") => {
    const t: WorkTab = { id: tabId(), kind: "query", title, sql };
    setTabs((ts) => [...ts, t]);
    setActiveTab(t.id);
  };

  const openNamedQuery = (q: NamedQuery) => {
    const existing = Object.entries(boundTabs).find(([tid, qid]) => qid === q.id && tabs.some((t) => t.id === tid));
    if (existing) return setActiveTab(existing[0]);
    const t: WorkTab = { id: tabId(), kind: "query", title: q.name, sql: q.sql };
    setBoundTabs((b) => ({ ...b, [t.id]: q.id }));
    setTabs((ts) => [...ts, t]);
    setActiveTab(t.id);
  };

  const openFromHistory = (sql: string) => {
    const target = historyTarget(tabs, activeTab, sql);
    if ("focus" in target) return setActiveTab(target.focus);
    if ("load" in target) {
      setTabs((ts) => ts.map((t) => (t.id === target.load && t.kind === "query" ? { ...t, sql } : t)));
      return setActiveTab(target.load);
    }
    openSql(sql, "History");
  };

  const removeTabs = (ids: string[]) => {
    const next = closeIds(tabs, ids);
    setActiveTab(nextActive(tabs, next, activeTab));
    setTabs(next);
    setBoundTabs((b) => Object.fromEntries(Object.entries(b).filter(([tid]) => !ids.includes(tid))));
  };

  /** Closes tabs, asking first when a closed tab is the last one showing a table with pending edits. */
  const closeTabs = (ids: string[]) => {
    if (ids.length === 0) return;
    const remaining = closeIds(tabs, ids);
    const stillOpen = new Set(remaining.flatMap((t) => (t.kind === "table" ? [pathKey(t.stack[t.pos]!.path)] : [])));
    const dirty = new Map<string, ObjectPath>();
    for (const t of tabs) {
      if (!ids.includes(t.id) || t.kind !== "table") continue;
      const p = t.stack[t.pos]!.path;
      const k = pathKey(p);
      if (!stillOpen.has(k) && pending.items.some((i) => pathKey(i.table) === k)) dirty.set(k, p);
    }
    if (dirty.size === 0) return removeTabs(ids);
    const tables = [...dirty.values()];
    const keys = new Set(dirty.keys());
    setClosing({ ids, tables, names: tables.map((p) => p.at(-1) ?? "table"), count: pending.items.filter((i) => keys.has(pathKey(i.table))).length });
  };
  const closeTab = (id: string) => closeTabs([id]);

  const duplicate = (id: string) => {
    const nid = tabId();
    setTabs((ts) => duplicateTab(ts, id, nid));
    setActiveTab(nid);
  };

  const cycleTab = (delta: number) => {
    if (tabs.length === 0) return;
    const i = tabs.findIndex((t) => t.id === activeTab);
    setActiveTab(tabs[(i + delta + tabs.length) % tabs.length]!.id);
  };

  const openInNewWindow = () => openConnectionTab(cfg.id);
  // Saved connections, for the top-bar switcher and the palette's "Open connection…" items.
  const [allConns, setAllConns] = useState<SavedConnection[]>([]);
  useEffect(() => {
    void listConnections().then(setAllConns);
  }, [palette]);

  const count = pendingCount(pending);

  const apply = async () => {
    if (count === 0) return;
    if (readOnly) return props.toast("Read-only: switch to Read & write to commit.");
    setApplying(true);
    setApplyErr(null);
    const set = toChangeSet(pending);
    try {
      const res = await driver.apply(set);
      for (const s of res.statements) addHistory({ sql: s, ms: res.ms / Math.max(1, res.statements.length), source: "apply" });
      const tables = new Set(set.changes.map((c) => pathKey(c.table)));
      setPendingState((s) => [...tables].reduce((acc, t) => clearTable(acc, JSON.parse(t) as ObjectPath), s));
      setDrawer(null);
      setReloadKey((k) => k + 1);
      props.toast(`Committed ${res.applied} change${res.applied === 1 ? "" : "s"}`);
    } catch (e) {
      setApplyErr((e as Error).message);
      setDrawer({ confirm: false });
    } finally {
      setApplying(false);
    }
  };

  const commit = () => {
    // In a query tab ⌘S saves the query (QueryView); only commit when there's something to commit.
    if (count === 0) return active?.kind === "query" ? undefined : props.toast("No pending changes");
    if (cfg.env === "production") setDrawer({ confirm: true });
    else void apply();
  };

  const toggleReadOnly = () => {
    const next = !readOnly;
    setReadOnly(next);
    props.toast(next ? "Read-only on" : "Read-only off: edits allowed");
  };

  useKeys(
    {
      "mod+s": commit,
      "mod+shift+p": () => setDrawer(drawer ? null : { confirm: false }),
      "mod+z": () => setPendingState(undo),
      "mod+k": () => setPalette(true),
      "mod+p": () => setPalette(true),
      "mod+r": () => {
        setReloadKey((k) => k + 1);
        schemaCache.clear();
        props.toast("Refreshed");
      },
      "mod+\\": () => setShowLeft((v) => !v),
      "mod+alt+r": () => setShowRight((v) => !v),
      "mod+[": () => go(-1),
      "mod+]": () => go(1),
      "alt+t": () => openSql(),
      "alt+w": () => activeTab && closeTab(activeTab),
      "mod+alt+arrowleft": () => cycleTab(-1),
      "mod+alt+arrowright": () => cycleTab(1),
      "ctrl+tab": () => cycleTab(1),
      "ctrl+shift+tab": () => cycleTab(-1),
      // Ctrl is "mod" off macOS; Chrome usually keeps Ctrl+Tab for itself there.
      "mod+tab": () => cycleTab(1),
      "mod+shift+tab": () => cycleTab(-1),
      escape: () => drawer && setDrawer(null),
    },
    { notInFields: ["mod+z"] },
  );

  // Warn before closing the browser tab with unsaved edits.
  useEffect(() => {
    if (count === 0) return;
    const on = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", on);
    return () => window.removeEventListener("beforeunload", on);
  }, [count]);

  const commands: PaletteCommand[] = useMemo(() => {
    const out: PaletteCommand[] = [
      { id: "sql", label: "New query tab", hint: `${ALT}T`, run: () => openSql() },
      { id: "close-tab", label: "Close tab", hint: `${ALT}W`, run: () => activeTab && closeTab(activeTab) },
      { id: "close-others", label: "Close other tabs", run: () => activeTab && closeTabs(othersOf(tabs, activeTab)) },
      { id: "new-window", label: "Open connection in new browser tab", run: openInNewWindow },
      { id: "review", label: "Review pending changes", hint: `${MOD}⇧P`, run: () => setDrawer({ confirm: false }) },
      { id: "commit", label: "Commit changes", hint: `${MOD}S`, run: commit },
      { id: "refresh", label: "Refresh", hint: `${MOD}R`, run: () => setReloadKey((k) => k + 1) },
      { id: "refresh-tree", label: "Refresh object tree", run: () => setTreeKey((k) => k + 1) },
      { id: "left", label: "Toggle left pane", hint: `${MOD}\\`, run: () => setShowLeft((v) => !v) },
      { id: "right", label: "Toggle Details pane", hint: `${MOD}⌥R`, run: () => setShowRight((v) => !v) },
      { id: "ro", label: readOnly ? "Turn read-only off" : "Turn read-only on", run: toggleReadOnly },
      { id: "home", label: "Go to Home", hint: `${MOD}⇧H`, run: () => navigate({ name: "home" }) },
      { id: "settings", label: "Settings", run: () => navigate({ name: "settings" }) },
      { id: "edit", label: "Connection settings…", run: () => setEditing(true) },
    ];
    // Opening another connection always opens a new browser tab; this one stays.
    for (const c of allConns) {
      if (c.id === cfg.id) continue;
      out.push({ id: "c:" + c.id, label: `Open connection ${c.name}`, hint: "new tab", run: () => void openConnection(c) });
    }
    for (const [k, type] of nodeTypes) {
      if (type === "table" || type === "view" || type === "materialized_view") {
        const p = JSON.parse(k) as string[];
        out.push({ id: "t:" + k, label: `Open ${p.filter((_, i) => nodeTypes.get(pathKey(p.slice(0, i + 1))) !== "group").join(".")}`, hint: type.replace("_", " "), run: () => openTable(p) });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [palette, readOnly, count, tabs, activeTab, allConns]);

  const envc = ENV_VAR[cfg.env];
  const demo = isDemo(cfg);
  const engineName = demo ? "Demo" : (ENGINE[cfg.driver]?.name ?? cfg.driver);
  const db_ = String(cfg.options.database ?? cfg.options.projectId ?? cfg.options.fileName ?? "");
  const tableLabel = activeEntry ? ctx.sqlName(activeEntry.path).replace(/["`]/g, "") : active?.kind === "query" ? active.title : "";

  const tabInfo = (t: WorkTab) => {
    if (t.kind === "query") {
      const named = !!boundTabs[t.id];
      return { label: t.title, title: named ? `${t.title} (saved query)` : t.title, icon: named ? ("named-query" as const) : ("query" as const), dirty: false };
    }
    const path = t.stack[t.pos]!.path;
    const k = pathKey(path);
    const isView = /view/.test(nodeTypes.get(k) ?? "");
    return { label: path.at(-1) ?? "table", title: ctx.sqlName(path), icon: objectIcon(nodeTypes.get(k)) ?? (isView ? "view" : "table"), dirty: pending.items.some((i) => pathKey(i.table) === k) };
  };

  const cols = `${showLeft ? `${leftPane.width}px var(--splitter-w) ` : ""}minmax(0, 1fr)${showRight ? ` var(--splitter-w) ${rightPane.width}px` : ""}`;

  return (
    <div className="conn" style={{ ["--envc" as string]: envc }}>
      <div className="topbar" style={{ borderTop: `3px solid ${envc}` }}>
        <button className="btn icon ghost" title={`Toggle left pane (${MOD}\\)`} aria-pressed={showLeft} onClick={() => setShowLeft(!showLeft)} aria-label="Toggle left pane">
          <Icon name="sidebar" />
        </button>
        <button className="btn icon ghost" title="Connections (Home)" onClick={() => navigate({ name: "home" })} aria-label="Connections">
          <Icon name="home" />
        </button>
        <button className="btn ghost" title={`New query tab (${ALT}T)`} onClick={() => openSql()}>
          <Icon name="query" />
          SQL
        </button>
        <button
          className={"rotoggle" + (readOnly ? " on" : "")}
          role="switch"
          aria-checked={readOnly}
          aria-pressed={readOnly}
          onClick={toggleReadOnly}
          aria-label="Read-only"
          title={readOnly ? "Read-only: edits, inserts, deletes and write statements are blocked. Click to allow writes." : "Read & write: edits and write statements are allowed. Click to block them."}
        >
          <span className="knob" aria-hidden />
          {readOnly ? "Read-only" : "Read & write"}
        </button>
        <ConnectionPicker
          compact
          label="Switch connection"
          connections={allConns.length ? allConns : [cfg]}
          selectedId={cfg.id}
          currentId={cfg.id}
          openOnClick
          onOpen={(c) => {
            if (c.id !== cfg.id) void openConnection(c);
          }}
          actions={[
            { id: "new", label: "New connection…", icon: "plus", run: () => setCreating({ step: "pick" }) },
            { id: "manage", label: "Manage connections…", icon: "home", run: () => navigate({ name: "home" }) },
          ]}
        />
        <div className="capsule">
          <button onClick={() => setEditing(true)} title="Connection settings" disabled={demo}>
            <span className="badge">{cfg.env}</span>
            <span className="path">
              {engineName}
              {props.version && !demo ? ` ${props.version}` : ""} : <b>{cfg.name}</b>
              {db_ && ` : ${db_}`}
              {tableLabel && (
                <>
                  {" : "}
                  <b>{tableLabel}</b>
                </>
              )}
            </span>
            {demo && <span className="tag demo">Demo data</span>}
          </button>
        </div>
        <button className="btn icon ghost" title="Statements dbui ran" aria-pressed={showLog} onClick={() => setShowLog(!showLog)} aria-label="Statement log">
          <Icon name="log" />
        </button>
        <button className="btn icon ghost" title={`Refresh (${MOD}R)`} onClick={() => setReloadKey((k) => k + 1)} aria-label="Refresh">
          <Icon name="refresh" />
        </button>
        <button className="btn icon ghost" title="Open this connection in a new browser tab" onClick={openInNewWindow} aria-label="Open in new browser tab">
          <Icon name="external" />
        </button>
        <button className="btn ghost" title="Command palette" onClick={() => setPalette(true)}>
          <kbd>{MOD}K</kbd>
        </button>
        <button className={"btn ghost details-toggle"} title={`${showRight ? "Hide" : "Show"} the Details pane: the selected row's fields (${MOD}⌥R)`} aria-pressed={showRight} onClick={() => setShowRight(!showRight)} aria-label="Toggle Details pane">
          <Icon name="panel-right" />
          Details
        </button>
      </div>

      <div className="panes" style={{ gridTemplateColumns: cols }}>
        {showLeft && <LeftPane ctx={ctx} activePath={activeEntry?.path ?? null} onOpen={openTable} onOpenSql={openSql} onOpenHistory={openFromHistory} historyVersion={historyVersion} refreshKey={treeKey} onOpenNamedQuery={openNamedQuery} activeNamedQueryId={activeTab ? boundTabs[activeTab] : undefined} />}
        {showLeft && <Splitter side="left" label="Resize object tree" size={leftPane} onResize={leftPane.setWidth} />}
        <div className="center">
          {readOnly && (
            <div className="ro-banner">
              <b>Read-only.</b> {cfg.env === "production" ? "Production connections start read-only." : ""} Edits and write statements are blocked.
            </div>
          )}
          <TabStrip
            tabs={tabs}
            activeId={activeTab}
            info={tabInfo}
            nav={
              <div className="nav">
                <button className="btn icon ghost" disabled={!(active?.kind === "table" && active.pos > 0)} onClick={() => go(-1)} title={`Back (${MOD}[)`} aria-label="Back">
                  <Icon name="back" />
                </button>
                <button className="btn icon ghost" disabled={!(active?.kind === "table" && active.pos < active.stack.length - 1)} onClick={() => go(1)} title={`Forward (${MOD}])`} aria-label="Forward">
                  <Icon name="forward" />
                </button>
              </div>
            }
            onActivate={setActiveTab}
            onClose={closeTabs}
            onCloseOthers={(id) => {
              setActiveTab(id);
              closeTabs(othersOf(tabs, id));
            }}
            onCloseRight={(id) => closeTabs(rightOf(tabs, id))}
            onDuplicate={duplicate}
            onMove={(id, to) => setTabs((ts) => moveTab(ts, id, to))}
            onNew={() => openSql()}
          />

          {tabs.length === 0 && (
            <div className="empty" style={{ flex: 1 }}>
              <p>Pick a table on the left, or open a query tab.</p>
              <p className="faint">
                <kbd>{MOD}K</kbd> palette · <kbd>{ALT}T</kbd> new query · <kbd>{MOD}\</kbd> toggle sidebar
              </p>
            </div>
          )}
          {tabs.map((t) =>
            t.kind === "table" ? (
              <TableView
                key={t.id + ":" + t.pos}
                ctx={ctx}
                entry={t.stack[t.pos]!}
                active={t.id === activeTab}
                reloadKey={reloadKey}
                onEntry={(patch) => patchEntry(t.id, patch)}
                onPush={(entry, newTab) => pushEntry(entry, newTab, t.id)}
                onDetails={setDetails}
                onOpenSql={openSql}
              />
            ) : (
              <QueryView
                key={t.id}
                ctx={ctx}
                sql={t.sql}
                title={t.title}
                namedQueryId={boundTabs[t.id]}
                active={t.id === activeTab}
                onSql={(sql) => setTabs((ts) => ts.map((x) => (x.id === t.id && x.kind === "query" ? { ...x, sql } : x)))}
                onDetails={setDetails}
                onSaved={() => setHistoryVersion((v) => v + 1)}
                onBound={(q) => {
                  setBoundTabs((b) => ({ ...b, [t.id]: q.id }));
                  setTabs((ts) => ts.map((x) => (x.id === t.id && x.kind === "query" ? { ...x, title: q.name } : x)));
                }}
              />
            ),
          )}

          {(count > 0 || showLog) && (
            <div className="foot">
              {count > 0 && (
                <span className="pending">
                  {count} pending change{count === 1 ? "" : "s"}
                  <button className="btn" onClick={() => setDrawer({ confirm: false })}>
                    Review <kbd>{MOD}⇧P</kbd>
                  </button>
                  <button className="btn primary" onClick={commit} disabled={readOnly || applying}>
                    Commit <kbd>{MOD}S</kbd>
                  </button>
                </span>
              )}
              {showLog && (
                <div style={{ width: "100%", maxHeight: 160, overflow: "auto", fontFamily: "var(--font-mono)", fontSize: 13 }}>
                  {log.length === 0 && <div className="faint">No statements yet.</div>}
                  {log.map((l, i) => (
                    <div key={i} style={{ color: l.error ? "var(--del-fg)" : undefined, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={l.error ?? l.sql}>
                      <span className="faint">{new Date(l.at).toLocaleTimeString()} </span>
                      {l.ms !== undefined && <span className="faint">{Math.round(l.ms)}ms </span>}
                      {l.sql.replace(/\s+/g, " ")}
                      {l.error && ` → ${l.error}`}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {showRight && <Splitter side="right" label="Resize Details pane" size={rightPane} onResize={rightPane.setWidth} />}
        {showRight && <DetailsPane ctx={ctx} source={details} />}
      </div>

      {drawer && <ReviewDrawer ctx={ctx} applying={applying} error={applyErr} askConfirm={drawer.confirm} onApply={() => void apply()} onClose={() => setDrawer(null)} />}
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      {closing && (
        <CloseDirtyConfirm
          names={closing.names}
          count={closing.count}
          onCancel={() => setClosing(null)}
          onKeep={() => {
            removeTabs(closing.ids);
            setClosing(null);
          }}
          onDiscard={() => {
            setPendingState((s) => closing.tables.reduce((acc, t) => clearTable(acc, t), s));
            removeTabs(closing.ids);
            setClosing(null);
          }}
        />
      )}
      {creating?.step === "pick" && (
        <EnginePicker onCancel={() => setCreating(null)} onPick={(driver, prefill) => setCreating({ step: "form", driver, prefill })} onNewGroup={() => navigate({ name: "home" })} />
      )}
      {creating?.step === "form" && (
        <ConnectionForm
          driver={creating.driver}
          prefill={creating.prefill}
          groups={[...new Set(allConns.map((c) => c.group).filter((g): g is string => !!g && g !== "Demo"))]}
          onCancel={() => setCreating(null)}
          onSaved={(c, connect) => {
            setCreating(null);
            setAllConns((cs) => [...cs.filter((x) => x.id !== c.id), c]);
            if (connect) void openConnection(c);
            else props.toast(`Saved ${c.name}`);
          }}
        />
      )}
      {editing && !demo && (
        <ConnectionForm
          driver={cfg.driver}
          existing={cfg}
          groups={[]}
          onCancel={() => setEditing(false)}
          onSaved={(c) => {
            setEditing(false);
            props.onCfg(c);
            setReadOnly(c.readOnly);
            props.toast("Saved. Reconnect to apply host or credential changes.");
          }}
        />
      )}
    </div>
  );
}
