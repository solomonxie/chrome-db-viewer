// Home (DESIGN.md §4.1): a compact connection picker. One searchable dropdown of saved
// connections with Connect, New, Edit, a ⋯ menu (Duplicate, Move to group, Export, Delete)
// and Settings; below it Open file with recent files, and a one-line runner status.
// Connect always opens the connection in a new browser tab; this tab stays on Home.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { DriverId } from "@core/types";
import {
  deleteConnection,
  listConnections,
  openConnection,
  saveConnection,
  type SavedConnection,
} from "../lib/connections";
import { isDemo } from "../demo/demoDriver";
import {
  canPickFiles,
  pickFile,
  recentFiles,
  rememberFile,
} from "../lib/files";
import { fmtAgo, fmtBytes } from "../lib/format";
import { navigate } from "../lib/route";
import { useKeys, MOD } from "../lib/keys";
import { uid, type RecentFile } from "../store/db";
import { forgetSecret } from "../store/secrets";
import { ContextMenu, Modal, useToast } from "../components/ui";
import { ConnectionPicker } from "../components/ConnectionPicker";
import { ConnectionForm, EnginePicker } from "./NewConnection";
import type { FormState } from "../lib/connForm";
import { installRunner, useRunnerStatus } from "./RunnerCard";
import { Icon } from "../components/Icon";
import type { RunnerStatus } from "../lib/runner";

type Sheet =
  | { kind: "picker" }
  | {
      kind: "form";
      driver: DriverId;
      prefill?: Partial<FormState>;
      existing?: SavedConnection;
    }
  | { kind: "group"; conn?: SavedConnection }
  | { kind: "delete"; conn: SavedConnection }
  | null;

const LAST_KEY = "dbui.home.selected";

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}
function writeLast(id: string) {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    /* storage blocked */
  }
}

/**
 * `banner` is a slot at the very top of Home for app-level notices (e.g. "Found a backup…
 * Restore?"); it renders above everything else when set.
 */
export function Home(props: { banner?: ReactNode } = {}) {
  const [conns, setConns] = useState<SavedConnection[] | null>(null);
  const [files, setFiles] = useState<RecentFile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(readLast);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [extraGroups, setExtraGroups] = useState<string[]>([]);
  const [fileDrag, setFileDrag] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const runner = useRunnerStatus();
  const toast = useToast();

  const reload = () => {
    void listConnections().then(setConns);
    void recentFiles().then(setFiles);
  };
  useEffect(reload, []);

  const list = conns ?? [];
  // The remembered selection, else the most recently used connection.
  const selected = useMemo(() => {
    const hit = list.find((c) => c.id === selectedId);
    if (hit) return hit;
    return (
      [...list].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0] ??
      null
    );
  }, [list, selectedId]);
  const realConns = list.filter((c) => !isDemo(c));
  const allGroups = useMemo(
    () =>
      [
        ...new Set([
          ...list
            .map((c) => c.group)
            .filter((g): g is string => !!g && g !== "Demo"),
          ...extraGroups,
        ]),
      ].sort(),
    [list, extraGroups],
  );

  const select = (c: SavedConnection) => {
    setSelectedId(c.id);
    writeLast(c.id);
  };
  const open = (c: SavedConnection) => {
    select(c);
    void openConnection(c).then(() =>
      setConns(
        (cs) =>
          cs?.map((x) =>
            x.id === c.id && !isDemo(x) ? { ...x, lastUsedAt: Date.now() } : x,
          ) ?? cs,
      ),
    );
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

  useKeys({
    "mod+o": () => void openFile(),
    "mod+n": () => setSheet({ kind: "picker" }),
  });

  const duplicate = async (c: SavedConnection) => {
    const copy: SavedConnection = {
      ...c,
      id: uid(),
      name: `${c.name} copy`,
      createdAt: Date.now(),
      lastUsedAt: undefined,
      secretRef: undefined,
      favorites: undefined,
    };
    await saveConnection(copy);
    select(copy);
    reload();
    toast(
      `Duplicated as ${copy.name}${c.secretRef ? ". Enter its password when you connect." : ""}`,
    );
  };

  const exportConn = (c: SavedConnection) => {
    // Settings only: no secrets, no per-browser state.
    const rest: Partial<SavedConnection> = { ...c };
    delete rest.secretRef;
    delete rest.lastUsedAt;
    delete rest.favorites;
    const blob = new Blob(
      [
        JSON.stringify(
          { dbui: "connection", version: 1, connection: rest },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${c.name.replace(/[^\w.-]+/g, "_") || "connection"}.dbui.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const onDropFiles = async (e: React.DragEvent) => {
    e.preventDefault();
    setFileDrag(false);
    const item = [...e.dataTransfer.items].find((i) => i.kind === "file");
    if (!item) return;
    type WithHandle = DataTransferItem & {
      getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
    };
    const h = await (item as WithHandle).getAsFileSystemHandle?.();
    if (h && h.kind === "file") {
      const r = await rememberFile(h as FileSystemFileHandle);
      navigate({ name: "file", fileHandleId: r.id });
    } else toast("Drop a file from Finder to open it.");
  };

  const demoSel = !!selected && isDemo(selected);
  const empty = conns !== null && realConns.length === 0;

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
      onDrop={(e) =>
        e.dataTransfer.types.includes("Files") && void onDropFiles(e)
      }
    >
      <div className="home-col">
        {/* Slot for app-level notices such as the backup restore banner. */}
        {props.banner && <div className="home-banner">{props.banner}</div>}

        <header className="home-head">
          <h1>
            <span className="logo" aria-hidden>
              <Icon name="database" className="ico" />
            </span>
            dbui
          </h1>
          <button
            className="btn icon ghost"
            title="Settings"
            aria-label="Settings"
            onClick={() => navigate({ name: "settings" })}
          >
            <Icon name="settings" />
          </button>
        </header>

        <section className="home-card" aria-label="Connections">
          <div className="home-card-title">
            <h2>Connection</h2>
            {conns !== null && (
              <span className="faint">
                {realConns.length === 0 ? "" : `${realConns.length} saved`}
              </span>
            )}
          </div>
          {empty && (
            <div className="home-empty">
              <b>No connections yet</b>
              <span>
                Add a database or open a data file. The demo below has sample
                data to try.
              </span>
              <div className="row">
                <button
                  className="btn primary"
                  onClick={() => setSheet({ kind: "picker" })}
                >
                  <Icon name="plus" />
                  New connection
                </button>
                <button
                  className="btn"
                  onClick={() => void openFile()}
                  disabled={!canPickFiles()}
                >
                  <Icon name="folder-open" />
                  Open file
                </button>
              </div>
            </div>
          )}
          <div className="home-pickrow">
            <ConnectionPicker
              connections={list}
              selectedId={selected?.id ?? null}
              onSelect={select}
              onOpen={open}
              label="Connection"
              autoFocus
            />
            <button
              className="btn primary connect"
              disabled={!selected}
              onClick={() => selected && open(selected)}
              title="Open in a new tab (Enter)"
            >
              Connect
            </button>
          </div>
          {!empty && (
            <div className="home-tools">
              <button
                className="btn"
                onClick={() => setSheet({ kind: "picker" })}
                title={`New connection (${MOD}N)`}
              >
                <Icon name="plus" />
                New connection
              </button>
              <button
                className="btn"
                disabled={!selected || demoSel}
                onClick={() =>
                  selected &&
                  setSheet({
                    kind: "form",
                    driver: selected.driver,
                    existing: selected,
                  })
                }
                title={
                  demoSel
                    ? "The demo can't be edited"
                    : "Edit the selected connection"
                }
              >
                <Icon name="edit" />
                Edit
              </button>
              <button
                className="btn icon"
                disabled={!selected || demoSel}
                aria-label="More connection actions"
                aria-haspopup="menu"
                title="Duplicate, move to group, export, delete"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenu({ x: r.left, y: r.bottom + 4 });
                }}
              >
                <Icon name="more" />
              </button>
            </div>
          )}
        </section>

        <section className="home-files" aria-label="Files">
          <div className="home-card-title">
            <h2>Files</h2>
            <button
              className="btn ghost sm"
              onClick={() => void openFile()}
              disabled={!canPickFiles()}
              title={`Open a CSV, JSONL or Parquet file (${MOD}O)`}
            >
              <Icon name="folder-open" />
              Open file…
            </button>
          </div>
          {files.length > 0 ? (
            <div className="home-recent">
              {files.slice(0, 5).map((f) => (
                <button
                  key={f.id}
                  className="frow"
                  onClick={() =>
                    navigate(
                      f.src
                        ? { name: "file", src: f.src }
                        : { name: "file", fileHandleId: f.id },
                    )
                  }
                  title={f.src ?? f.name}
                >
                  <Icon name="file" className="ico" />
                  <span className="fn">{f.name}</span>
                  <span className="sub">
                    {f.size !== undefined
                      ? fmtBytes(f.size) + " · "
                      : f.src
                        ? "URL · "
                        : ""}
                    {fmtAgo(f.openedAt)}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="faint home-hint">
              CSV, JSONL, Parquet … or drop a file anywhere on this page.
            </p>
          )}
        </section>

        <RunnerLine status={runner.status} onCheck={runner.check} />
      </div>

      {menu && selected && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Duplicate", onClick: () => void duplicate(selected) },
            {
              label: "Move to group…",
              onClick: () => setSheet({ kind: "group", conn: selected }),
            },
            {
              label: "Export…",
              hint: "JSON, no secrets",
              onClick: () => exportConn(selected),
            },
            { separator: true, label: "" },
            {
              label: "Delete…",
              onClick: () => setSheet({ kind: "delete", conn: selected }),
            },
          ]}
        />
      )}
      {sheet?.kind === "picker" && (
        <EnginePicker
          onCancel={() => setSheet(null)}
          onPick={(driver, prefill) =>
            setSheet({ kind: "form", driver, prefill })
          }
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
            select(c);
            reload();
            if (connect) open(c);
            else toast(`Saved ${c.name}`);
          }}
        />
      )}
      {sheet?.kind === "group" && (
        <MoveToGroup
          conn={sheet.conn}
          groups={allGroups}
          onCancel={() => setSheet(null)}
          onDone={async (name) => {
            const conn = sheet.conn;
            setSheet(null);
            if (name) setExtraGroups((g) => [...new Set([...g, name])]);
            if (conn) {
              await saveConnection({ ...conn, group: name || undefined });
              reload();
              toast(
                name
                  ? `Moved ${conn.name} to ${name}`
                  : `${conn.name} is ungrouped`,
              );
            }
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
                  const conn = sheet.conn;
                  await deleteConnection(conn.id);
                  if (conn.secretRef) await forgetSecret(conn.secretRef);
                  setSheet(null);
                  setSelectedId(null);
                  reload();
                  toast(`Deleted ${conn.name}`);
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <p>
            Removes the saved settings and any password dbui remembered for it.
            The database itself is not touched.
          </p>
        </Modal>
      )}
    </div>
  );
}

/** One line: runner state, with Install / Check again when it isn't usable. */
function RunnerLine({
  status,
  onCheck,
}: {
  status: RunnerStatus;
  onCheck: () => void;
}) {
  const dot =
    status.state === "ok"
      ? "ok"
      : status.state === "checking"
        ? ""
        : status.state === "crashed"
          ? "bad"
          : "warn";
  const text =
    status.state === "checking"
      ? "Checking for the dbui runner…"
      : status.state === "ok"
        ? `dbui runner ${status.version}: Postgres and Redis available`
        : status.state === "outdated"
          ? `dbui runner ${status.version} is out of date`
          : status.state === "crashed"
            ? "dbui runner stopped. Logs: ~/Library/Logs/dbui/runner.log"
            : status.state === "unavailable"
              ? status.message
              : "Postgres and Redis need the dbui runner";
  const canInstall = status.state === "missing" || status.state === "outdated";
  return (
    <div
      className="home-runner"
      role="status"
      title={
        status.state === "missing"
          ? "A small helper app. It installs into your home folder: no admin password, no Homebrew."
          : undefined
      }
    >
      <span className={"dot " + dot} />
      <span className="txt">{text}</span>
      {canInstall && (
        <button className="btn sm" onClick={() => void installRunner()}>
          <Icon name="download" />
          {status.state === "outdated" ? "Update" : "Install"}
        </button>
      )}
      {status.state !== "ok" && status.state !== "checking" && (
        <button className="btn sm ghost" onClick={onCheck}>
          Check again
        </button>
      )}
    </div>
  );
}

function MoveToGroup(props: {
  conn?: SavedConnection;
  groups: string[];
  onDone: (group: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.conn?.group ?? "");
  const listId = "home-group-list";
  return (
    <Modal
      title={props.conn ? `Move ${props.conn.name} to group` : "New group"}
      onClose={props.onCancel}
      actions={
        <>
          <button className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!props.conn && !name.trim()}
            onClick={() => props.onDone(name.trim())}
          >
            {props.conn ? "Move" : "Create"}
          </button>
        </>
      }
    >
      <p>
        {props.conn
          ? "Pick a group or type a new name. Leave it empty to ungroup."
          : "Then use Move to group in the ⋯ menu to put connections in it."}
      </p>
      <input
        className="input"
        autoFocus
        list={listId}
        value={name}
        placeholder="Group name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) =>
          e.key === "Enter" &&
          (props.conn || name.trim()) &&
          props.onDone(name.trim())
        }
        aria-label="Group name"
      />
      <datalist id={listId}>
        {props.groups.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
    </Modal>
  );
}
