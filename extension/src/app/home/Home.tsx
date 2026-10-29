// Home (DESIGN.md §4.1): connection search and list with groups, new-connection picker,
// recent files, Open file, runner status, Settings.

import { useEffect, useMemo, useRef, useState } from "react";
import type { DriverId } from "@core/types";
import { connectionSubtitle, deleteConnection, listConnections, saveConnection, type SavedConnection } from "../lib/connections";
import { isDemo } from "../demo/demoDriver";
import { canPickFiles, pickFile, recentFiles, rememberFile } from "../lib/files";
import { fmtAgo, fmtBytes, ENV_VAR } from "../lib/format";
import { navigate } from "../lib/route";
import { useKeys, MOD } from "../lib/keys";
import type { RecentFile } from "../store/db";
import { forgetSecret } from "../store/secrets";
import { EngineBadge, EnvTag, Highlight, Modal, useToast } from "../components/ui";
import { ConnectionForm, EnginePicker } from "./NewConnection";
import type { FormState } from "../lib/connForm";
import { RunnerCard, useRunnerStatus } from "./RunnerCard";

type Sheet =
  | { kind: "picker" }
  | { kind: "form"; driver: DriverId; prefill?: Partial<FormState>; existing?: SavedConnection }
  | { kind: "group" }
  | { kind: "delete"; conn: SavedConnection }
  | null;

const UNGROUPED = "";

export function Home() {
  const [conns, setConns] = useState<SavedConnection[]>([]);
  const [files, setFiles] = useState<RecentFile[]>([]);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [extraGroups, setExtraGroups] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const runner = useRunnerStatus();
  const toast = useToast();
  const searchRef = useRef<HTMLInputElement>(null);

  const reload = () => {
    void listConnections().then(setConns);
    void recentFiles().then(setFiles);
  };
  useEffect(reload, []);

  const needle = q.trim().toLowerCase();
  const hits = useMemo(
    () =>
      conns
        .filter((c) => !needle || `${c.name} ${connectionSubtitle(c)} ${c.driver} ${c.env} ${c.group ?? ""}`.toLowerCase().includes(needle))
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.name.localeCompare(b.name)),
    [conns, needle],
  );
  const groups = useMemo(() => {
    const names = new Set<string>([...hits.map((c) => c.group ?? UNGROUPED), ...(needle ? [] : extraGroups)]);
    return [...names].sort((a, b) => (a === UNGROUPED ? -1 : b === UNGROUPED ? 1 : a === "Demo" ? 1 : b === "Demo" ? -1 : a.localeCompare(b)));
  }, [hits, extraGroups, needle]);
  // Flattened in display order, for ↑↓ navigation.
  const ordered = useMemo(() => groups.flatMap((g) => hits.filter((c) => (c.group ?? UNGROUPED) === g)), [groups, hits]);
  const allGroups = useMemo(() => [...new Set([...conns.map((c) => c.group).filter((g): g is string => !!g && g !== "Demo"), ...extraGroups])], [conns, extraGroups]);

  const open = async (c: SavedConnection, newTab = false) => {
    if (!isDemo(c)) await saveConnection({ ...c, lastUsedAt: Date.now() }).catch(() => {});
    navigate({ name: "connection", connectionId: c.id }, { newTab });
  };

  const openFile = async () => {
    try {
      const h = await pickFile();
      if (!h) return;
      const r = await rememberFile(h);
      navigate({ name: "file", fileHandleId: r.id });
    } catch (e) {
      toast((e as Error).message);
    }
  };

  useKeys({ "mod+o": () => void openFile(), "mod+n": () => setSheet({ kind: "picker" }) });

  const moveToGroup = async (id: string, group: string) => {
    const c = conns.find((x) => x.id === id);
    if (!c || isDemo(c)) return;
    await saveConnection({ ...c, group: group || undefined });
    reload();
  };

  const onDropFiles = async (e: React.DragEvent) => {
    e.preventDefault();
    setFileDrag(false);
    const item = [...e.dataTransfer.items].find((i) => i.kind === "file");
    if (!item) return;
    type WithHandle = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };
    const h = await (item as WithHandle).getAsFileSystemHandle?.();
    if (h && h.kind === "file") {
      const r = await rememberFile(h as FileSystemFileHandle);
      navigate({ name: "file", fileHandleId: r.id });
    } else toast("Drop a file from Finder to open it.");
  };

  return (
    <div
      className={"home" + (fileDrag ? " dropzone" : "")}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setFileDrag(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setFileDrag(false)}
      onDrop={(e) => e.dataTransfer.types.includes("Files") && void onDropFiles(e)}
    >
      <div className="home-inner">
        <div className="main">
          <h1>
            <svg className="ico" style={{ width: 20, height: 20, color: "var(--accent)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <ellipse cx="12" cy="5" rx="8" ry="3" />
              <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
            </svg>
            dbui
          </h1>
          <div className="hhead">
            <input
              ref={searchRef}
              className="hsearch"
              autoFocus
              placeholder="Search for connection…"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setIdx(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setIdx((i) => Math.min(ordered.length - 1, i + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setIdx((i) => Math.max(0, i - 1));
                } else if (e.key === "Enter" && ordered[idx]) void open(ordered[idx]!, e.altKey || e.metaKey);
              }}
              aria-label="Search for connection"
            />
            <button className="btn primary" onClick={() => setSheet({ kind: "picker" })} title="New connection">
              + New
            </button>
          </div>

          <div className="clist" role="listbox" aria-label="Connections">
            {ordered.length === 0 && <div className="empty">{needle ? "No connection matches." : "No connections yet. Click + New."}</div>}
            {groups.map((g) => {
              const inGroup = hits.filter((c) => (c.group ?? UNGROUPED) === g);
              return (
                <div key={g || "_"}>
                  {(g !== UNGROUPED || groups.length > 1) && (
                    <div
                      className={"cgroup" + (dragOver === g ? " drop" : "")}
                      onDragOver={(e) => {
                        if (g === "Demo") return;
                        e.preventDefault();
                        setDragOver(g);
                      }}
                      onDragLeave={() => setDragOver(null)}
                      onDrop={(e) => {
                        setDragOver(null);
                        void moveToGroup(e.dataTransfer.getData("text/x-dbui-conn"), g);
                      }}
                    >
                      ▾ {g || "Ungrouped"} <span>{inGroup.length}</span>
                    </div>
                  )}
                  {inGroup.map((c) => {
                    const i = ordered.indexOf(c);
                    const demo = isDemo(c);
                    return (
                      <div
                        key={c.id}
                        className={"crow" + (i === idx ? " on" : "")}
                        role="option"
                        aria-selected={i === idx}
                        tabIndex={-1}
                        draggable={!demo}
                        onDragStart={(e) => e.dataTransfer.setData("text/x-dbui-conn", c.id)}
                        onClick={(e) => void open(c, e.altKey || e.metaKey)}
                        onMouseEnter={() => setIdx(i)}
                        style={{ cursor: "pointer", ["--envc" as string]: ENV_VAR[c.env] }}
                      >
                        <EngineBadge driver={c.driver} demo={demo} />
                        <span className="cn">
                          <b>
                            <Highlight text={c.name} needle={needle} />
                          </b>
                          <small>
                            <Highlight text={demo ? "Sample data in memory, not a real database" : connectionSubtitle(c) || c.driver} needle={needle} />
                          </small>
                        </span>
                        {demo && <span className="tag demo">Demo data</span>}
                        {c.readOnly && <span className="faint" title="Read-only">🔒</span>}
                        <EnvTag env={c.env} />
                        {!demo && (
                          <span className="acts" onClick={(e) => e.stopPropagation()}>
                            <button className="btn icon ghost" title="Edit" onClick={() => setSheet({ kind: "form", driver: c.driver, existing: c })}>
                              ✎
                            </button>
                            <button className="btn icon ghost" title="Delete" onClick={() => setSheet({ kind: "delete", conn: c })}>
                              ✕
                            </button>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          <div className="faint" style={{ fontSize: 11.5 }}>
            <kbd>↑</kbd> <kbd>↓</kbd> + <kbd>Enter</kbd> connects · <kbd>⌥</kbd>-click opens in a new tab · drag a connection onto a group · <kbd>{MOD}O</kbd> open file
          </div>
        </div>

        <aside className="side-col">
          <div>
            <h2>Files</h2>
            <div className="flist">
              <button className="frow" onClick={() => void openFile()} disabled={!canPickFiles()}>
                <span className="fn" style={{ fontFamily: "var(--font-ui)" }}>
                  Open file…
                </span>
                <span className="sub">
                  <kbd>{MOD}O</kbd>
                </span>
              </button>
              {files.map((f) => (
                <button key={f.id} className="frow" onClick={() => navigate(f.src ? { name: "file", src: f.src } : { name: "file", fileHandleId: f.id })} title={f.src ?? f.name}>
                  <span className="fn">{f.name}</span>
                  <span className="sub">
                    {f.size !== undefined ? fmtBytes(f.size) + " · " : f.src ? "URL · " : ""}
                    {fmtAgo(f.openedAt)}
                  </span>
                </button>
              ))}
              {files.length === 0 && (
                <div className="frow faint" style={{ cursor: "default" }}>
                  CSV, JSONL, Parquet … or drop a file here
                </div>
              )}
            </div>
          </div>
          <div>
            <h2>Runner</h2>
            <RunnerCard status={runner.status} onCheck={runner.check} />
          </div>
          <div className="rcard">
            <div className="row">
              <b>Settings</b>
            </div>
            <p>Browser preview for data files, theme and keys.</p>
            <div className="row">
              <button className="btn" onClick={() => navigate({ name: "settings" })}>
                Open Settings
              </button>
            </div>
          </div>
        </aside>
      </div>

      {sheet?.kind === "picker" && (
        <EnginePicker
          onCancel={() => setSheet(null)}
          onPick={(driver, prefill) => setSheet({ kind: "form", driver, prefill })}
          onNewGroup={() => setSheet({ kind: "group" })}
        />
      )}
      {sheet?.kind === "form" && (
        <ConnectionForm
          driver={sheet.driver}
          prefill={sheet.prefill}
          existing={sheet.existing}
          groups={allGroups}
          onCancel={() => setSheet(null)}
          onSaved={(c, connect) => {
            setSheet(null);
            reload();
            if (connect) void open(c);
            else toast(`Saved ${c.name}`);
          }}
        />
      )}
      {sheet?.kind === "group" && (
        <NewGroup
          onCancel={() => setSheet(null)}
          onCreate={(name) => {
            setExtraGroups((g) => [...new Set([...g, name])]);
            setSheet(null);
          }}
        />
      )}
      {sheet?.kind === "delete" && (
        <Modal
          title={`Delete ${sheet.conn.name}?`}
          onClose={() => setSheet(null)}
          actions={
            <>
              <button className="btn" onClick={() => setSheet(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  await deleteConnection(sheet.conn.id);
                  if (sheet.conn.secretRef) await forgetSecret(sheet.conn.secretRef);
                  setSheet(null);
                  reload();
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <p>Removes the saved settings and any password dbui remembered for it. The database itself is not touched.</p>
        </Modal>
      )}
    </div>
  );
}

function NewGroup({ onCreate, onCancel }: { onCreate: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  return (
    <Modal
      title="New group"
      onClose={onCancel}
      actions={
        <>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => onCreate(name.trim())}>
            Create
          </button>
        </>
      }
    >
      <p>Drag connections onto the group to move them.</p>
      <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && onCreate(name.trim())} aria-label="Group name" />
    </Modal>
  );
}
