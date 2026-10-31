// File sheet (#file): breadcrumb sheet stack over createDriver("file"), with frequency,
// summary, sort, filter, a SQL bar for any query over the file, and a Details pane. While the DuckDB driver is still a placeholder, the error card
// offers the demo sheet so the UI can be tried.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConnectionConfig, Driver } from "@core/types";
import { createDriver } from "@core/registry";
import { createDemoDriver } from "../demo/demoDriver";
import { DataGrid, type GridCursor } from "../components/DataGrid";
import { CommandPalette, useToast, type PaletteCommand } from "../components/ui";
import { ensureReadPermission, pickFile, recentFiles, rememberFile, rememberUrl } from "../lib/files";
import { cellText, fmtBytes, fmtInt, fmtMs } from "../lib/format";
import { MOD, SHIFT, useKeys } from "../lib/keys";
import { navigate } from "../lib/route";
import * as db from "../store/db";
import { useResult } from "../conn/useResult";
import { cycleSort, equalsCondition, filteredSheet, frequencySheet, querySheet, sheetSql, sourceSheet, summarySheet, type Sheet } from "./sheets";
import { DetailsPane, type DetailsCtx } from "../conn/DetailsPane";
import type { DetailsSource } from "../conn/model";
import { emptyPending } from "../lib/changes";
import { SqlEditor } from "../components/SqlEditor";
import { connectionSource } from "../lib/completion";
import { Splitter, usePaneWidth } from "../components/Splitter";
import { Icon } from "../components/Icon";

type Phase =
  | { kind: "loading" }
  | { kind: "pick" }
  | { kind: "error"; message: string; name: string; code?: string }
  | { kind: "ready"; driver: Driver; table: string; name: string; size?: number; demo: boolean };

async function openFileDriver(cfg: ConnectionConfig): Promise<{ driver: Driver; table: string }> {
  const driver = await createDriver("file");
  await driver.connect(cfg);
  const nodes = await driver.listObjects([]);
  const node = nodes.find((n) => n.type === "table" || n.type === "file" || n.type === "view") ?? nodes[0];
  if (!node) throw new Error("The file driver registered no table for this file.");
  return { driver, table: node.name };
}

export function FileSheet({ src, fileHandleId }: { src?: string; fileHandleId?: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  const openDemo = useCallback(async (name: string) => {
    const driver = createDemoDriver();
    await driver.connect({ id: "demo-file", name, driver: "file", env: "local", readOnly: true, options: { demo: true, demoFile: "orders.csv" } });
    setPhase({ kind: "ready", driver, table: "orders.csv", name: "orders.csv (demo data)", demo: true });
  }, []);

  // Fallback when Chrome won't let the page read a file:// URL: the same file through the picker.
  const chooseFromDisk = async () => {
    const h = await pickFile();
    if (!h) return;
    const r = await rememberFile(h);
    navigate({ name: "file", fileHandleId: r.id });
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let name = "file";
      try {
        const options: Record<string, unknown> = {};
        let size: number | undefined;
        if (src) {
          name = decodeURIComponent(src.split(/[?#]/)[0]!.split("/").pop() || src);
          options.src = src;
          void rememberUrl(src).catch(() => {});
        } else if (fileHandleId) {
          const rec = await db.get("recentFiles", fileHandleId);
          if (!rec?.handle) throw new Error("This recent file is no longer available. Open it again.");
          name = rec.name;
          if (!(await ensureReadPermission(rec.handle))) throw new Error("Chrome did not grant read access to the file.");
          // Both the stored id and the live handle; the driver uses whichever it supports.
          options.fileHandleId = fileHandleId;
          options.fileHandle = rec.handle;
          size = rec.size;
          void rememberFile(rec.handle).catch(() => {});
        } else {
          if (!cancelled) setPhase({ kind: "pick" });
          return;
        }
        document.title = name;
        options.fileName = name;
        const cfg: ConnectionConfig = { id: `file:${src ?? fileHandleId}`, name, driver: "file", env: "local", readOnly: true, options };
        const { driver, table } = await openFileDriver(cfg);
        if (!cancelled) setPhase({ kind: "ready", driver, table, name, size, demo: false });
      } catch (e) {
        if (!cancelled) setPhase({ kind: "error", message: (e as Error).message, name, code: (e as { code?: string }).code });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, fileHandleId]);

  if (phase.kind === "loading") return <div className="empty">Opening…</div>;
  if (phase.kind === "pick") return <PickFile />;
  if (phase.kind === "error") {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
        <div className="install">
          <h2>Couldn't open {phase.name}</h2>
          <div className="err">{phase.message}</div>
          {phase.code === "file_access" ? (
            <p>
              On <b>chrome://extensions</b>, open Chrome DB Viewer's <b>Details</b>, turn on <b>Allow access to file URLs</b>, and press the extension's reload button (Chrome only applies new file
              permissions after a reload). Or open the file once from disk below; it's remembered under recent files.
            </p>
          ) : (
            <p>If the link has expired or needs a sign-in, open it in a normal tab first, or download it and open the file from disk.</p>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {phase.code === "file_access" && (
              <button className="btn primary" onClick={() => void chooseFromDisk()}>
                Choose {phase.name.length > 40 ? "the file" : phase.name}…
              </button>
            )}
            {phase.code === "file_access" && (
              <button className="btn" onClick={() => void chrome.tabs?.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })}>
                Open extension settings
              </button>
            )}
            {src && !/^file:/i.test(src) && (
              <button className="btn" onClick={() => void chrome.downloads?.download({ url: src })}>
                Download instead
              </button>
            )}
            <button className="btn" onClick={() => void openDemo(phase.name)}>
              Try with demo data
            </button>
            <button className="btn" onClick={() => navigate({ name: "home" })}>
              Home
            </button>
          </div>
        </div>
      </div>
    );
  }
  return <SheetStack driver={phase.driver} table={phase.table} name={phase.name} size={phase.size} demo={phase.demo} />;
}

function PickFile() {
  const [files, setFiles] = useState<db.RecentFile[]>([]);
  useEffect(() => void recentFiles().then(setFiles), []);
  const open = async () => {
    const h = await pickFile();
    if (!h) return;
    const r = await rememberFile(h);
    navigate({ name: "file", fileHandleId: r.id });
  };
  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className="install">
        <h2>Open a data file</h2>
        <p>CSV, TSV, JSONL, JSON or Parquet (also .gz). Large files stay on disk; DuckDB reads only what it needs.</p>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn primary" onClick={() => void open()}>
            Open file… <kbd>{MOD}O</kbd>
          </button>
          <button className="btn" onClick={() => navigate({ name: "home" })}>
            Home
          </button>
        </div>
        {files.length > 0 && (
          <div className="flist">
            {files.map((f) => (
              <button key={f.id} className="frow" onClick={() => navigate(f.src ? { name: "file", src: f.src } : { name: "file", fileHandleId: f.id })}>
                <span className="fn">{f.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SheetStack(props: { driver: Driver; table: string; name: string; size?: number; demo: boolean }) {
  const { driver, table } = props;
  const [stack, setStack] = useState<Sheet[]>([{ ...sourceSheet(table), title: props.name }]);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState<GridCursor | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [totalRows, setTotalRows] = useState<number | null>(null);
  const [showDetails, setShowDetails] = useState(() => readFlag(DETAILS_KEY));
  const [showSql, setShowSql] = useState(false);
  const [sqlText, setSqlText] = useState(() => `SELECT *\nFROM ${driver.dialect.quoteIdent(table)}\nLIMIT 100`);
  const detailsPane = usePaneWidth("dbui.pane.right", 340, 260, 720);
  // Height of the SQL panel at the bottom (the hook stores one number; here it's a height).
  const sqlPane = usePaneWidth("dbui.pane.fileSql", 200, 110, 600);
  // Autocomplete: the file's table and its columns, plus keywords and functions.
  const completion = useMemo(() => ({ source: connectionSource(driver), quote: (n: string) => driver.dialect.quoteIdent(n) }), [driver]);
  const toast = useToast();
  const { state, run, abort } = useResult(driver);
  const sheet = stack[stack.length - 1]!;
  const sql = useMemo(() => sheetSql(sheet, table, driver.dialect, sheet.kind === "source" ? 100000 : undefined), [sheet, table, driver.dialect]);

  useEffect(() => {
    setSelection(new Set());
    setCursor(null);
    void run(sql);
  }, [sql, run]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const gen = driver.execute({ sql: `SELECT count(*) AS "n" FROM ${driver.dialect.quoteIdent(table)}` });
        for (;;) {
          const n = await gen.next();
          if (n.done) break;
          const v = n.value.rows[0]?.[0];
          if (!cancelled && v !== undefined) setTotalRows(Number(v));
        }
      } catch {
        /* count is a nice-to-have */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [driver, table]);

  const curColumn = cursor ? state.columns[cursor.col]?.name : undefined;

  const toggleDetails = () =>
    setShowDetails((v) => {
      writeFlag(DETAILS_KEY, !v);
      return !v;
    });
  const runSql = () => {
    const text = sqlText.trim();
    if (text) push(querySheet(text));
  };
  // The Details pane shows the selected rows (or the cursor row), read-only.
  const details: DetailsSource | null = useMemo(() => {
    const rows = selection.size ? [...selection].sort((a, b) => a - b).slice(0, 500) : cursor ? [cursor.row] : [];
    return { table: null, columns: state.columns, editable: false, rows: rows.map((i) => ({ rowId: String(i), key: {}, values: state.rows[i] ?? [] })) };
  }, [selection, cursor, state.columns, state.rows]);
  const push = (s: Sheet) => setStack((st) => [...st, s]);
  const back = () => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st));

  const openFrequency = () => {
    if (sheet.kind !== "source") return toast("Frequency works on the data sheet.");
    if (!curColumn) return toast("Pick a column first (click a cell).");
    push(frequencySheet(sheet, curColumn));
  };
  const openSummary = () => push(summarySheet(sheet.kind === "source" ? sheet : stack[0]!));

  // Enter on a frequency row filters the source sheet to that value.
  const activate = (row: number) => {
    if (sheet.kind === "frequency") {
      const v = state.rows[row]?.[0] ?? null;
      const parent = stack[stack.length - 2] ?? stack[0]!;
      push(filteredSheet(parent, equalsCondition(sheet.column, v, driver.dialect), `${sheet.column} = ${cellText(v)}`));
    } else if (sheet.kind === "summary") {
      const name = state.rows[row]?.[0];
      if (typeof name === "string") push(frequencySheet(stack[0]!, name));
    }
  };

  const openSelection = () => {
    if (sheet.kind !== "source" || selection.size === 0 || !curColumn) return;
    const col = curColumn;
    const ci = state.columns.findIndex((c) => c.name === col);
    const values = [...new Set([...selection].map((r) => state.rows[r]?.[ci] ?? null))];
    const cond = values.map((v) => equalsCondition(col, v, driver.dialect)).join(" OR ");
    push(filteredSheet(sheet, cond, `${selection.size} selected`));
  };

  useKeys({
    escape: back,
    "mod+shift+f": openFrequency,
    "mod+i": openSummary,
    "mod+f": () => setFilter(filter === null ? "" : null),
    "mod+k": () => setPalette(true),
    "mod+e": () => setShowSql((v) => !v),
    "mod+alt+r": toggleDetails,
    "mod+.": abort,
    "mod+o": () =>
      void pickFile().then(async (h) => {
        if (!h) return;
        const r = await rememberFile(h);
        navigate({ name: "file", fileHandleId: r.id });
      }),
    "mod+s": () => toast(props.demo ? "Demo data can't be saved." : "Save / Save as arrives with the file engine."),
  });

  const commands: PaletteCommand[] = [
    { id: "freq", label: "Frequency table of current column", hint: `${MOD}${SHIFT}F`, run: openFrequency },
    { id: "sum", label: "Column summary", hint: `${MOD}I`, run: openSummary },
    { id: "filter", label: "Filter (SQL WHERE)", hint: `${MOD}F`, run: () => setFilter("") },
    { id: "sql", label: "SQL bar: query this file", hint: `${MOD}E`, run: () => setShowSql(true) },
    { id: "details", label: "Toggle the Details pane", hint: `${MOD}⌥R`, run: toggleDetails },
    { id: "sel", label: "Open selected rows as a sheet", run: openSelection },
    { id: "back", label: "Back one sheet", hint: "Esc", run: back },
    { id: "home", label: "Go to Home", run: () => navigate({ name: "home" }) },
  ];

  const maxCount = sheet.kind === "frequency" ? Math.max(1, ...state.rows.map((r) => Number(r[1]) || 0)) : 1;
  const freqTotal = sheet.kind === "frequency" ? state.rows.reduce((a, r) => a + (Number(r[1]) || 0), 0) : 0;
  const ext = props.name.split(".").pop()?.toUpperCase() ?? "";

  return (
    <div className="sheet">
      <div className="topbar">
        <button className="btn icon ghost" title="Home" onClick={() => navigate({ name: "home" })} aria-label="Home">
          <Icon name="home" />
        </button>
        <nav className="crumbs" aria-label="Sheet stack">
          {stack.map((s, i) => (
            <span key={i} style={{ display: "contents" }}>
              {i > 0 && <span className="sep">›</span>}
              <button aria-current={i === stack.length - 1} onClick={() => setStack(stack.slice(0, i + 1))}>
                {s.title}
              </button>
            </span>
          ))}
        </nav>
        <div className="sheet-tools">
          {props.demo && <span className="tag demo">Demo data</span>}
          <span className="sheet-meta faint">
            {ext}
            {props.size !== undefined && ` · ${fmtBytes(props.size)}`}
            {totalRows !== null && ` · ${fmtInt(totalRows)} rows`}
          </span>
          <button className="btn" onClick={openFrequency} title={`Frequency of the current column (${MOD}${SHIFT}F)`}>
            Frequency
          </button>
          <button className="btn" onClick={openSummary} title={`Column summary (${MOD}I)`}>
            Summary
          </button>
          <button className="btn" onClick={() => setFilter(filter === null ? "" : null)} aria-pressed={filter !== null} title={`Filter with a SQL WHERE (${MOD}F)`}>
            Filter
          </button>
          <button className="btn" onClick={() => setShowSql(!showSql)} aria-pressed={showSql} title={`Query this file with any SQL (${MOD}E)`}>
            SQL
          </button>
          <button
            className="btn ghost details-toggle"
            onClick={toggleDetails}
            aria-pressed={showDetails}
            title={`${showDetails ? "Hide" : "Show"} the Details pane: the selected row's fields (${MOD}⌥R)`}
            aria-label="Toggle Details pane"
          >
            <Icon name="panel-right" />
            Details
          </button>
        </div>
      </div>
      {filter !== null ? (
        <div className="bar">
          <span className="faint" style={{ fontSize: 13 }}>
            WHERE
          </span>
          <input
            className="input mono"
            style={{ flex: 1 }}
            autoFocus
            placeholder={curColumn ? `${driver.dialect.quoteIdent(curColumn)} = 'value'` : "SQL expression"}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && filter.trim()) {
                const base = sheet.kind === "source" ? sheet : stack[0]!;
                push(filteredSheet(base, filter.trim(), filter.trim()));
                setFilter(null);
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setFilter(null);
              }
            }}
            aria-label="Filter expression"
          />
        </div>
      ) : (
        <div className="bar" style={{ minHeight: 0, padding: 0, border: 0 }} />
      )}
      <div className="sheet-body" style={{ gridTemplateColumns: showDetails ? `minmax(0, 1fr) var(--splitter-w) ${detailsPane.width}px` : "minmax(0, 1fr)" }}>
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
          {state.running && <div className="loading-bar" />}
          {state.error && (
            <div className="err" style={{ margin: 8 }}>
              {state.error}
            </div>
          )}
          {sheet.kind === "frequency" ? (
            <FrequencyTable
              column={sheet.column}
              rows={state.rows}
              max={maxCount}
              total={freqTotal}
              cursor={cursor?.row ?? null}
              onCursor={(r) => setCursor({ row: r, col: 0 })}
              onActivate={activate}
            />
          ) : (
            <DataGrid
              columns={state.columns}
              rowCount={state.rows.length}
              value={(r, c) => state.rows[r]?.[c] ?? null}
              sort={sheet.kind === "source" ? sheet.sort : undefined}
              onSort={(name, additive) => sheet.kind === "source" && setStack((st) => [...st.slice(0, -1), { ...sheet, sort: cycleSort(sheet.sort, name, additive) }])}
              selection={selection}
              cursor={cursor}
              onSelection={(s, c) => {
                setSelection(s);
                setCursor(c);
              }}
              onActivate={activate}
              highlightColumn
              resetKey={sql}
              onCopy={(rows) => void navigator.clipboard.writeText(rows.map((r) => (state.rows[r] ?? []).map(cellText).join("\t")).join("\n")).then(() => toast("Copied"))}
            />
          )}
        </div>
        {showDetails && <Splitter side="right" label="Resize Details pane" size={detailsPane} onResize={detailsPane.setWidth} />}
        {showDetails && <DetailsPane ctx={READ_ONLY_DETAILS} source={details} />}
      </div>
      {showSql && <Splitter side="bottom" label="Resize SQL panel" size={sqlPane} onResize={sqlPane.setWidth} />}
      {showSql && (
        <div className="sheet-sql" style={{ height: sqlPane.width }}>
          <div className="sheet-sql-bar">
            <button className="btn primary" onClick={runSql} disabled={!sqlText.trim() || state.running} title={`Run the query (${MOD}↵)`}>
              <Icon name="play" /> Run <kbd>{MOD}↵</kbd>
            </button>
            <span className="faint sheet-sql-hint">
              The file is table <code>{driver.dialect.quoteIdent(table)}</code> · results open as a new sheet · Esc goes back · ⌃Space suggests
            </span>
            <span className="spacer" />
            <button className="btn icon ghost" onClick={() => setShowSql(false)} title="Hide the SQL panel" aria-label="Hide SQL panel">
              <Icon name="close" />
            </button>
          </div>
          <SqlEditor
            className="sheet-sqled"
            value={sqlText}
            onChange={setSqlText}
            completion={completion}
            autoFocus
            aria-label="SQL over this file"
            placeholder={`SELECT … FROM ${driver.dialect.quoteIdent(table)}`}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                runSql();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setShowSql(false);
              }
            }}
          />
        </div>
      )}
      <div className="foot">
        <span className="hint">
          {sheet.kind === "frequency" ? <span>Enter: filter source</span> : sheet.kind === "summary" ? <span>Enter: frequency of that column</span> : <span>Click header: sort</span>}
          <span>Esc: back</span>
          <span>
            {MOD}
            {SHIFT}F: frequency
          </span>
          <span>{MOD}I: summary</span>
          <span>{MOD}F: filter</span>
          <span>{MOD}E: SQL</span>
        </span>
        <span className="spacer" />
        <span className="count">
          {selection.size > 1 ? `${fmtInt(selection.size)} selected · ` : ""}
          {fmtInt(state.rows.length)} {sheet.kind === "frequency" ? "values" : "rows"}
          {sheet.kind === "source" && state.rows.length === 100000 ? " (first 100,000)" : ""}
          {state.summary && ` · ${fmtMs(state.summary.ms)}`}
        </span>
      </div>
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
    </div>
  );
}

const DETAILS_KEY = "dbui.file.details";
const READ_ONLY_DETAILS: DetailsCtx = { pending: emptyPending, setPending: () => {}, readOnly: true };

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}

function FrequencyTable(props: { column: string; rows: unknown[][]; max: number; total: number; cursor: number | null; onCursor: (r: number) => void; onActivate: (r: number) => void }) {
  return (
    <div
      className="gridwrap"
      tabIndex={0}
      onKeyDown={(e) => {
        const cur = props.cursor ?? -1;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          props.onCursor(Math.min(props.rows.length - 1, cur + 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          props.onCursor(Math.max(0, cur - 1));
        } else if (e.key === "Enter" && props.cursor !== null) props.onActivate(props.cursor);
      }}
      ref={(el) => el?.focus()}
    >
      <table className="plain" style={{ fontFamily: "var(--font-mono)" }}>
        <thead>
          <tr>
            <th>{props.column}</th>
            <th style={{ textAlign: "right" }}>count</th>
            <th style={{ textAlign: "right" }}>%</th>
            <th style={{ width: "40%" }} />
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r, i) => {
            const n = Number(r[1]) || 0;
            return (
              <tr
                key={i}
                onClick={() => props.onCursor(i)}
                onDoubleClick={() => props.onActivate(i)}
                style={{ cursor: "pointer", background: props.cursor === i ? "var(--sel)" : undefined }}
                aria-selected={props.cursor === i}
              >
                <td className={r[0] === null ? "faint" : ""}>{cellText(r[0] as never)}</td>
                <td style={{ textAlign: "right" }}>{fmtInt(n)}</td>
                <td style={{ textAlign: "right" }}>{props.total ? ((n / props.total) * 100).toFixed(1) : "0.0"}%</td>
                <td>
                  <div className="fbar">
                    <i style={{ width: `${(n / props.max) * 100}%` }} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
