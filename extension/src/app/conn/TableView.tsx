// One table tab: filter rows, virtualised grid with pending edits, Data / Structure / Index.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Cell, Column, TableSchema } from "@core/types";
import { previewChangeSet } from "@core/sql";
import { DataGrid, type GridCursor } from "../components/DataGrid";
import { ContextMenu, type MenuItem } from "../components/ui";
import { cellStatus, deleteRow, editCell, insertRow, pendingInserts, pendingValue, restoreRow, rowIdFor } from "../lib/changes";
import { buildSelect, compileWhere, parseReference, type FilterRow, type Joiner } from "../lib/filters";
import { cellText, fmtInt, fmtMs, parseCellInput } from "../lib/format";
import { MOD, useKeys } from "../lib/keys";
import { FilterRows, newFilter } from "./FilterRows";
import { newEntry, type ConnCtx, type DetailsSource, type TableEntry } from "./model";
import { useResult } from "./useResult";

const PAGE_SIZES = [200, 500, 1000, 0] as const;
const NO_COLUMNS: Column[] = [];

export function TableView(props: {
  ctx: ConnCtx;
  entry: TableEntry;
  active: boolean;
  reloadKey: number;
  onEntry: (patch: Partial<TableEntry>) => void;
  onPush: (entry: TableEntry, newTab: boolean) => void;
  onDetails: (src: DetailsSource | null) => void;
  onOpenSql: (sql: string, title?: string) => void;
}) {
  const { ctx, entry } = props;
  const [schema, setSchema] = useState<TableSchema | null>(null);
  const [schemaErr, setSchemaErr] = useState<string | null>(null);
  const [view, setView] = useState<"data" | "structure" | "index">("data");
  const [pageSize, setPageSize] = useState<number>(200);
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState<GridCursor | null>(null);
  const [quick, setQuick] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const { state, run, abort } = useResult(ctx.driver, ctx.addHistory);
  const quickRef = useRef<HTMLInputElement>(null);

  const tableName = ctx.sqlName(entry.path);
  const columns: Column[] = useMemo(() => (state.columns.length ? state.columns : (schema?.columns ?? NO_COLUMNS)), [state.columns, schema]);
  const pkCols = useMemo(() => (schema?.columns ?? []).filter((c) => c.primaryKey).map((c) => c.name), [schema]);
  const isView = /view/.test(ctx.nodeTypes.get(JSON.stringify(entry.path)) ?? "");

  const canUpdate = !ctx.readOnly && ctx.editMode === "full" && pkCols.length > 0 && !isView;
  const canInsert = !ctx.readOnly && ctx.editMode !== "none" && !isView;
  const editReason = ctx.readOnly
    ? "Read-only connection"
    : ctx.editMode === "none"
      ? `${ctx.cfg.driver === "bigquery" ? "BigQuery grids are read-only; use DML in a query tab" : "This source is read-only in the grid"}`
      : ctx.editMode === "insert"
        ? "Inserts only: updates and deletes go through the editor"
        : isView
          ? "Views are read-only"
          : pkCols.length === 0
            ? "No primary key: rows can't be identified for updates"
            : null;

  useEffect(() => {
    let cancelled = false;
    setSchema(null);
    setSchemaErr(null);
    ctx.describe(entry.path).then(
      (s) => !cancelled && setSchema(s),
      (e) => !cancelled && setSchemaErr((e as Error).message),
    );
    return () => {
      cancelled = true;
    };
  }, [ctx, entry.path]);

  const where = useMemo(
    () => (schema ? compileWhere(entry.applied, schema.columns, ctx.driver.dialect, entry.appliedJoiner) : ""),
    [schema, entry.applied, entry.appliedJoiner, ctx.driver.dialect],
  );

  const sql = useMemo(
    () =>
      buildSelect(
        { table: tableName, where, sort: entry.sort, limit: pageSize || undefined, offset: pageSize ? page * pageSize : 0 },
        ctx.driver.dialect,
      ),
    [tableName, where, entry.sort, pageSize, page, ctx.driver.dialect],
  );

  useEffect(() => {
    if (!schema) return;
    setSelection(new Set());
    setCursor(null);
    void run(sql, { pageSize: pageSize || 2000 });
  }, [schema, sql, run, props.reloadKey, pageSize]);

  useEffect(() => setPage(0), [where, entry.sort, pageSize]);

  // Base rows plus pending inserts for this table.
  const inserts = useMemo(() => pendingInserts(ctx.pending, entry.path), [ctx.pending, entry.path]);
  const baseCount = state.rows.length;
  const rowIdAt = useCallback(
    (i: number): string => {
      if (i >= baseCount) return inserts[i - baseCount]?.rowId ?? `missing:${i}`;
      return rowIdFor(entry.path, keyOf(state.rows[i]!, columns, pkCols));
    },
    [baseCount, inserts, entry.path, state.rows, columns, pkCols],
  );

  // Quick search filters the loaded rows client-side.
  const visible = useMemo(() => {
    const total = baseCount + inserts.length;
    const all = Array.from({ length: total }, (_, i) => i);
    const n = quick.trim().toLowerCase();
    if (!n) return all;
    return all.filter((i) => i >= baseCount || state.rows[i]!.some((v) => cellText(v).toLowerCase().includes(n)));
  }, [baseCount, inserts.length, quick, state.rows]);

  const valueAt = useCallback(
    (vi: number, c: number): Cell => {
      const i = visible[vi]!;
      const col = columns[c]!;
      if (i >= baseCount) return inserts[i - baseCount]?.values[col.name] ?? null;
      return pendingValue(ctx.pending, rowIdAt(i), col.name, state.rows[i]![c] ?? null);
    },
    [visible, columns, baseCount, inserts, ctx.pending, rowIdAt, state.rows],
  );

  const rowStatus = useCallback(
    (vi: number) => {
      const s = cellStatus(ctx.pending, rowIdAt(visible[vi]!));
      return s === "add" || s === "del" ? s : null;
    },
    [ctx.pending, rowIdAt, visible],
  );
  const cellEdited = useCallback(
    (vi: number, c: number) => cellStatus(ctx.pending, rowIdAt(visible[vi]!), columns[c]!.name) === "edit",
    [ctx.pending, rowIdAt, visible, columns],
  );

  const onEdit = (vi: number, c: number, text: string) => {
    const i = visible[vi]!;
    const col = columns[c]!;
    const old = i < baseCount ? (state.rows[i]![c] ?? null) : null;
    const isInsert = i >= baseCount;
    if (!isInsert && !canUpdate) return ctx.toast(editReason ?? "Read-only");
    const value = parseCellInput(text, isInsert ? (valueAt(vi, c) ?? old) : old, col.type);
    const key = isInsert ? {} : keyOf(state.rows[i]!, columns, pkCols);
    ctx.setPending((s) => editCell(s, entry.path, rowIdAt(i), key, col.name, value, old));
  };

  const setCells = (value: Cell) => {
    if (!cursor) return;
    const targets = selection.size ? [...selection] : [cursor.row];
    const col = columns[cursor.col]!;
    ctx.setPending((s) => {
      let out = s;
      for (const vi of targets) {
        const i = visible[vi]!;
        if (i < baseCount && !canUpdate) continue;
        const old = i < baseCount ? (state.rows[i]![cursor.col] ?? null) : null;
        out = editCell(out, entry.path, rowIdAt(i), i < baseCount ? keyOf(state.rows[i]!, columns, pkCols) : {}, col.name, value, old);
      }
      return out;
    });
  };

  const addRow = () => {
    if (!canInsert) return ctx.toast(editReason ?? "Read-only");
    ctx.setPending((s) => insertRow(s, entry.path, {}));
    setTimeout(() => {
      const vi = visible.length;
      setSelection(new Set([vi]));
      setCursor({ row: vi, col: 0 });
    }, 0);
  };

  const removeRows = () => {
    const targets = selection.size ? [...selection] : cursor ? [cursor.row] : [];
    if (targets.length === 0) return;
    ctx.setPending((s) => {
      let out = s;
      for (const vi of targets) {
        const i = visible[vi]!;
        const rid = rowIdAt(i);
        if (i >= baseCount) out = deleteRow(out, entry.path, rid, {});
        else if (canUpdate) out = cellStatus(out, rid) === "del" ? restoreRow(out, rid) : deleteRow(out, entry.path, rid, keyOf(state.rows[i]!, columns, pkCols));
      }
      return out;
    });
    if (!canUpdate && targets.some((vi) => visible[vi]! < baseCount)) ctx.toast(editReason ?? "Read-only");
  };

  const openFk = useCallback(
    (colIndex: number, value: Cell, newTab: boolean) => {
      const ref = columns[colIndex]?.references;
      const parsed = ref ? parseReference(ref) : null;
      if (!parsed || value === null) return;
      const path = ctx.resolveTable(parsed.table, entry.path);
      const f: FilterRow = { ...newFilter(parsed.column, "=", cellText(value)) };
      props.onPush(newEntry(path, { filters: [f], applied: [f], showFilters: true }), newTab);
    },
    [columns, ctx, entry.path, props],
  );

  const applyFilters = (rows: FilterRow[], joiner: Joiner) => {
    if (rows.length === 0) props.onEntry({ applied: [], filters: [newFilter(columns[0]?.name)], appliedJoiner: joiner });
    else props.onEntry({ applied: rows, appliedJoiner: joiner });
  };

  const toggleFilters = () => {
    if (!entry.showFilters && entry.filters.length === 0) {
      const col = cursor ? columns[cursor.col]?.name : columns[0]?.name;
      props.onEntry({ showFilters: true, filters: [newFilter(col ?? "")] });
    } else props.onEntry({ showFilters: !entry.showFilters });
  };

  const copyRows = (rows: number[], as: "tsv" | "json" | "insert") => {
    const sel = rows.length ? rows : cursor ? [cursor.row] : [];
    if (sel.length === 0) return;
    let text: string;
    if (as === "tsv") {
      text = sel.map((vi) => columns.map((_, c) => cellText(valueAt(vi, c))).join("\t")).join("\n");
    } else if (as === "json") {
      text = JSON.stringify(sel.map((vi) => Object.fromEntries(columns.map((col, c) => [col.name, valueAt(vi, c)]))), null, 2);
    } else {
      text = previewChangeSet(
        { changes: sel.map((vi) => ({ type: "insert" as const, table: entry.path, values: Object.fromEntries(columns.map((col, c) => [col.name, valueAt(vi, c)])) })) },
        ctx.driver.dialect,
        () => tableName,
      );
    }
    void navigator.clipboard.writeText(text).then(() => ctx.toast(`Copied ${sel.length} row${sel.length === 1 ? "" : "s"}`));
  };

  const exportAs = (fmt: "csv" | "json" | "sql") => {
    const all = visible.map((_, vi) => vi);
    let text: string;
    let mime = "text/plain";
    if (fmt === "csv") {
      const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
      text = [columns.map((c) => esc(c.name)).join(","), ...all.map((vi) => columns.map((_, c) => (valueAt(vi, c) === null ? "" : esc(cellText(valueAt(vi, c))))).join(","))].join("\n");
      mime = "text/csv";
    } else if (fmt === "json") {
      text = JSON.stringify(all.map((vi) => Object.fromEntries(columns.map((col, c) => [col.name, valueAt(vi, c)]))), null, 2);
      mime = "application/json";
    } else {
      text = previewChangeSet(
        { changes: all.map((vi) => ({ type: "insert" as const, table: entry.path, values: Object.fromEntries(columns.map((col, c) => [col.name, valueAt(vi, c)])) })) },
        ctx.driver.dialect,
        () => tableName,
      );
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = `${entry.path.at(-1) ?? "result"}.${fmt}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  // Details pane source.
  useEffect(() => {
    if (!props.active) return;
    const sel = [...selection].sort((a, b) => a - b).slice(0, 500);
    props.onDetails({
      table: entry.path,
      columns,
      editable: canUpdate || canInsert,
      rows: sel
        .filter((vi) => visible[vi] !== undefined)
        .map((vi) => {
          const i = visible[vi]!;
          return {
            rowId: rowIdAt(i),
            key: i < baseCount ? keyOf(state.rows[i]!, columns, pkCols) : {},
            values: i < baseCount ? state.rows[i]! : columns.map((col) => inserts[i - baseCount]?.values[col.name] ?? null),
          };
        }),
      onOpenFk: (c, v, nt) => openFk(c, v, nt),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.active, selection, columns, state.rows, inserts, canUpdate, canInsert]);

  useKeys(
    props.active
      ? {
          "mod+f": toggleFilters,
          "mod+enter": () => entry.showFilters && applyFilters(entry.filters, entry.joiner),
          "mod+i": addRow,
          "mod+backspace": removeRows,
          "mod+delete": removeRows,
          "mod+shift+c": () => copyRows([...selection].sort((a, b) => a - b), "insert"),
          "mod+shift+n": () => setCells(null),
          "mod+.": abort,
        }
      : {},
    { notInFields: ["mod+backspace", "mod+delete", "mod+shift+c"] },
  );

  const onContextMenu = (e: React.MouseEvent, vi: number, c: number) => {
    const col = columns[c]!;
    const sel = selection.has(vi) ? [...selection].sort((a, b) => a - b) : [vi];
    if (!selection.has(vi)) {
      setSelection(new Set([vi]));
      setCursor({ row: vi, col: c });
    }
    const items: MenuItem[] = [
      { label: "Copy as TSV", hint: `${MOD}C`, onClick: () => copyRows(sel, "tsv") },
      { label: "Copy as INSERT", hint: `${MOD}⇧C`, onClick: () => copyRows(sel, "insert") },
      { label: "Copy as JSON", onClick: () => copyRows(sel, "json") },
      { separator: true, label: "" },
      { label: "Set to NULL", hint: `${MOD}⇧N`, disabled: !col.nullable || (!canUpdate && visible[vi]! < baseCount), onClick: () => setCells(null) },
      { label: "Filter by this value", onClick: () => {
        const f = newFilter(col.name, valueAt(vi, c) === null ? "is_null" : "=", cellText(valueAt(vi, c)));
        props.onEntry({ showFilters: true, filters: [f], applied: [f] });
      } },
    ];
    if (col.references) items.push({ label: `Open ${col.references}`, hint: `${MOD}→`, onClick: () => openFk(c, valueAt(vi, c), false) });
    items.push({ separator: true, label: "" }, { label: rowStatus(vi) === "del" ? "Restore row" : "Delete row", hint: `${MOD}⌫`, disabled: !canInsert && !canUpdate, onClick: removeRows });
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const total = visible.length;
  const hasMore = pageSize > 0 && baseCount === pageSize;

  return (
    <div className="center" style={{ display: props.active ? undefined : "none" }}>
      {entry.showFilters && view === "data" && (
        <FilterRows
          columns={schema?.columns ?? columns}
          rows={entry.filters.length ? entry.filters : [newFilter(columns[0]?.name)]}
          joiner={entry.joiner}
          onChange={(filters, joiner) => props.onEntry({ filters, joiner })}
          onApply={applyFilters}
          onShowSql={() => props.onOpenSql(sql, `${entry.path.at(-1)} query`)}
        />
      )}
      {view === "data" && (
        <div className="bar">
          <button className="btn" onClick={() => setMenu({ x: 20, y: 120, items: [
            { label: "Export as CSV", onClick: () => exportAs("csv") },
            { label: "Export as JSON", onClick: () => exportAs("json") },
            { label: "Export as SQL INSERTs", onClick: () => exportAs("sql") },
          ] })}>
            Export
          </button>
          <button className="btn" onClick={() => props.onOpenSql(sql, `${entry.path.at(-1)} query`)}>
            SQL
          </button>
          <span className="hint">
            <span>Filter: <kbd>{MOD}F</kbd></span>
            <span>Insert: <kbd>{MOD}I</kbd></span>
            <span>Remove: <kbd>{MOD}⌫</kbd></span>
            <span>Apply All: <kbd>{MOD}↵</kbd></span>
          </span>
          <span className="spacer" />
          {entry.applied.some((f) => f.enabled) && (
            <span className="tag" title={where}>
              filtered{entry.applied.length > 1 ? ` · ${entry.applied.length} conditions` : ""}
            </span>
          )}
          {editReason && <span className="faint" style={{ fontSize: 11.5 }}>{editReason}</span>}
        </div>
      )}
      {state.running && <div className="loading-bar" />}
      {view === "data" && (
        <>
          {(state.error || schemaErr) && <div className="err" style={{ margin: 8 }}>{schemaErr ?? state.error}</div>}
          <DataGrid
            columns={columns}
            rowCount={total}
            value={valueAt}
            rowStatus={rowStatus}
            cellEdited={cellEdited}
            sort={entry.sort}
            onSort={(name, additive) => {
              const cur = entry.sort.find((s) => s.column === name);
              const dir = cur?.dir === "asc" ? "desc" : "asc";
              const rest = additive ? entry.sort.filter((s) => s.column !== name) : [];
              props.onEntry({ sort: cur?.dir === "desc" && !additive ? [] : [...rest, { column: name, dir }] });
            }}
            selection={selection}
            cursor={cursor}
            onSelection={(s, c) => {
              setSelection(s);
              setCursor(c);
            }}
            editable={canUpdate || canInsert}
            onEdit={onEdit}
            onOpenFk={(vi, c, nt) => openFk(c, valueAt(vi, c), nt)}
            onContextMenu={onContextMenu}
            onCopy={(rows) => copyRows(rows, "tsv")}
            resetKey={JSON.stringify(entry.path)}
          />
        </>
      )}
      {view === "structure" && <Structure schema={schema} error={schemaErr} />}
      {view === "index" && <Indexes schema={schema} />}
      <div className="foot">
        <span className="seg" role="tablist">
          {(["data", "structure", "index"] as const).map((v) => (
            <button key={v} aria-pressed={view === v} onClick={() => setView(v)} role="tab">
              {v[0]!.toUpperCase() + v.slice(1)}
            </button>
          ))}
        </span>
        <button className="btn icon" title="New query tab (⌥T)" onClick={() => props.onOpenSql(`SELECT * FROM ${tableName} LIMIT 100;`, "Query")}>
          +
        </button>
        <span className="count">
          {selection.size > 0 ? `${fmtInt(selection.size)} of ` : ""}
          {fmtInt(total)} row{total === 1 ? "" : "s"}
          {selection.size > 0 ? " selected" : ""}
          {state.summary && ` · ${fmtMs(state.summary.ms)}`}
          {state.running && " · loading…"}
        </span>
        <span className="spacer" />
        <input ref={quickRef} className="qs" placeholder="🔍 Search loaded rows" value={quick} onChange={(e) => setQuick(e.target.value)} aria-label="Search loaded rows" />
        <select className="input" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} aria-label="Rows per page" title="Rows per page">
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n === 0 ? "All rows" : `${n} rows`}
            </option>
          ))}
        </select>
        <button className="btn icon" disabled={page === 0 || state.running} onClick={() => setPage(page - 1)} title="Previous page" aria-label="Previous page">
          ‹
        </button>
        <span className="faint" style={{ fontSize: 11.5, minWidth: 40, textAlign: "center" }}>
          {pageSize ? `page ${page + 1}` : "all"}
        </span>
        <button className="btn icon" disabled={!hasMore || state.running} onClick={() => setPage(page + 1)} title="Next page" aria-label="Next page">
          ›
        </button>
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function keyOf(row: Cell[], columns: Column[], pk: string[]): Record<string, Cell> {
  const key: Record<string, Cell> = {};
  for (const name of pk) {
    const i = columns.findIndex((c) => c.name === name);
    key[name] = i >= 0 ? (row[i] ?? null) : null;
  }
  return key;
}

function Structure({ schema, error }: { schema: TableSchema | null; error: string | null }) {
  if (error) return <div className="err" style={{ margin: 12 }}>{error}</div>;
  if (!schema) return <div className="empty">Loading…</div>;
  return (
    <div className="scroll">
      <div>
        <h3>Columns</h3>
        <div className="box">
          <table className="plain">
            <thead>
              <tr>
                <th>#</th>
                <th>Name</th>
                <th>Type</th>
                <th>Nullable</th>
                <th>Default</th>
                <th>Key</th>
                <th>References</th>
              </tr>
            </thead>
            <tbody>
              {schema.columns.map((c, i) => (
                <tr key={c.name}>
                  <td className="faint">{i + 1}</td>
                  <td className="mono">{c.name}</td>
                  <td className="mono muted">{c.type}{c.enumValues ? ` (${c.enumValues.join(", ")})` : ""}</td>
                  <td>{c.nullable ? "YES" : "NO"}</td>
                  <td className="mono muted">{c.default ?? ""}</td>
                  <td>{c.primaryKey ? <span className="tag">PK</span> : ""}</td>
                  <td className="mono">{c.references ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {schema.info && Object.keys(schema.info).length > 0 && (
        <div>
          <h3>Info</h3>
          <dl className="kv">
            {Object.entries(schema.info).map(([k, v]) => (
              <FragmentKV key={k} k={k} v={v} />
            ))}
          </dl>
        </div>
      )}
      {schema.ddl && (
        <div>
          <h3>DDL</h3>
          <pre className="code">{schema.ddl}</pre>
        </div>
      )}
    </div>
  );
}

function FragmentKV({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

function Indexes({ schema }: { schema: TableSchema | null }) {
  if (!schema) return <div className="empty">Loading…</div>;
  if (schema.indexes.length === 0) return <div className="empty">No indexes.</div>;
  return (
    <div className="scroll">
      <div className="box">
        <table className="plain">
          <thead>
            <tr>
              <th>Name</th>
              <th>Columns</th>
              <th>Unique</th>
              <th>Primary</th>
              <th>Definition</th>
            </tr>
          </thead>
          <tbody>
            {schema.indexes.map((ix) => (
              <tr key={ix.name}>
                <td className="mono">{ix.name}</td>
                <td className="mono">{ix.columns.join(", ")}</td>
                <td>{ix.unique ? "YES" : ""}</td>
                <td>{ix.primary ? "YES" : ""}</td>
                <td className="mono muted">{ix.definition ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
