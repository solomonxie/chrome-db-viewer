// Right pane: the selected row(s) as a vertical form with type-aware editors (DESIGN.md §4.2).
// Several rows: differing fields show "(multiple values)"; editing sets the value on all rows.

import { useState } from "react";
import type { Cell, Column } from "@core/types";
import { JsonView } from "../components/JsonView";
import { Highlight } from "../components/ui";
import { cellsEqual, editCell, pendingValue, cellStatus } from "../lib/changes";
import { isBoolType, isJsonType, isNumericType, isTimeType } from "../lib/coltypes";
import { cellText, parseCellInput } from "../lib/format";
import type { ConnCtx, DetailsSource } from "./model";

const MULTI = Symbol("multi");

export function DetailsPane({ ctx, source }: { ctx: ConnCtx; source: DetailsSource | null }) {
  const [q, setQ] = useState("");
  const rows = source?.rows ?? [];
  const columns = source?.columns ?? [];

  const valueOf = (rowIdx: number, c: number): Cell => {
    const r = rows[rowIdx]!;
    return source?.table ? pendingValue(ctx.pending, r.rowId, columns[c]!.name, r.values[c] ?? null) : (r.values[c] ?? null);
  };

  const merged = (c: number): Cell | typeof MULTI => {
    const first = valueOf(0, c);
    for (let i = 1; i < rows.length; i++) if (!cellsEqual(first, valueOf(i, c))) return MULTI;
    return first;
  };

  const setValue = (c: number, value: Cell) => {
    if (!source?.table || !source.editable) return;
    const table = source.table;
    const col = columns[c]!;
    ctx.setPending((s) => {
      let out = s;
      for (const r of rows) {
        if (cellStatus(out, r.rowId) === "del") continue;
        out = editCell(out, table, r.rowId, r.key, col.name, value, r.values[c] ?? null);
      }
      return out;
    });
  };

  const needle = q.trim().toLowerCase();
  const fields = columns.map((col, i) => ({ col, i })).filter(({ col }) => !needle || col.name.toLowerCase().includes(needle) || col.type.toLowerCase().includes(needle));
  const editable = !!source?.table && source.editable && !ctx.readOnly;

  return (
    <div className="pane-right">
      <div className="ptabs" role="tablist">
        <button role="tab" aria-selected="true">
          Details
        </button>
      </div>
      <div className="psearch">
        <input placeholder="Search for field" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search for field" />
      </div>
      {rows.length === 0 ? (
        <div className="empty">Select a row to see its fields.</div>
      ) : (
        <div className="details">
          {rows.length > 1 && <div className="note">{rows.length} rows selected. Editing a field sets it on all of them.</div>}
          {fields.map(({ col, i }) => {
            const v = merged(i);
            const edited = rows.some((r) => source?.table && cellStatus(ctx.pending, r.rowId, col.name) === "edit");
            return (
              <div key={col.name} className={"field" + (edited ? " edit" : "")}>
                <div className="fh">
                  {col.primaryKey && <span className="faint">⚿</span>}
                  <b>
                    <Highlight text={col.name} needle={needle} />
                  </b>
                  <small>{col.type}</small>
                </div>
                <FieldEditor col={col} value={v} editable={editable && !(col.primaryKey && rows.length > 1)} onChange={(nv) => setValue(i, nv)} />
                {col.references && v !== MULTI && v !== null && source?.onOpenFk && (
                  <button className="fklink" onClick={(e) => source.onOpenFk!(i, v, e.altKey)}>
                    → {col.references.split(".").slice(0, -1).join(".")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FieldEditor(props: { col: Column; value: Cell | typeof MULTI; editable: boolean; onChange: (v: Cell) => void }) {
  const { col, value, editable } = props;
  const multi = value === MULTI;
  const v = multi ? null : (value as Cell);
  const [jsonEdit, setJsonEdit] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);

  if (isBoolType(col.type)) {
    return (
      <select className="input" disabled={!editable} value={multi ? "__multi" : v === null ? "NULL" : String(v === true || v === "true" || v === "t")} onChange={(e) => props.onChange(e.target.value === "NULL" ? null : e.target.value === "true")}>
        {multi && <option value="__multi">(multiple values)</option>}
        <option value="true">TRUE</option>
        <option value="false">FALSE</option>
        {col.nullable && <option value="NULL">NULL</option>}
      </select>
    );
  }
  if (col.enumValues?.length) {
    return (
      <select className="input" disabled={!editable} value={multi ? "__multi" : v === null ? "__null" : String(v)} onChange={(e) => props.onChange(e.target.value === "__null" ? null : e.target.value)}>
        {multi && <option value="__multi">(multiple values)</option>}
        {col.enumValues.map((x) => (
          <option key={x} value={x}>
            {x}
          </option>
        ))}
        {col.nullable && <option value="__null">NULL</option>}
      </select>
    );
  }
  if (isJsonType(col.type) || (v !== null && typeof v === "object")) {
    if (!jsonEdit || !editable) {
      return (
        <div>
          {multi ? <div className="input multi">(multiple values)</div> : v === null ? <div className="input faint">NULL</div> : <JsonView value={typeof v === "string" ? tryParse(v) : v} />}
          {editable && (
            <button className="fklink" onClick={() => setJsonEdit(true)}>
              Edit JSON
            </button>
          )}
        </div>
      );
    }
    return (
      <JsonEditor
        initial={multi || v === null ? "" : JSON.stringify(typeof v === "string" ? tryParse(v) : v, null, 2)}
        onDone={(text) => {
          setJsonEdit(false);
          if (text === null) return;
          props.onChange(text.trim() === "" ? null : (JSON.parse(text) as Cell));
        }}
      />
    );
  }
  if (isTimeType(col.type)) {
    const s = v === null ? "" : String(v);
    const local = toLocalInput(s, col.type);
    return (
      <div style={{ display: "flex", gap: 4 }}>
        <input
          className="input"
          disabled={!editable}
          placeholder={multi ? "(multiple values)" : "NULL"}
          value={draft ?? (multi ? "" : s)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== null) props.onChange(draft === "" || draft === "NULL" ? null : draft);
            setDraft(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        {editable && local.kind && (
          <input
            type={local.kind}
            className="input"
            style={{ width: 34, padding: 2 }}
            title="Pick a date"
            value={local.value}
            onChange={(e) => e.target.value && props.onChange(fromLocalInput(e.target.value, local.kind!, s))}
            aria-label="Date picker"
          />
        )}
      </div>
    );
  }
  const text = v === null ? "" : cellText(v);
  const long = text.length > 60 || text.includes("\n");
  const common = {
    className: "input",
    disabled: !editable,
    placeholder: multi ? "(multiple values)" : "NULL",
    value: draft ?? (multi ? "" : text),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: () => {
      if (draft !== null && draft !== text) props.onChange(draft === "" && (v === null || col.nullable) ? null : parseCellInput(draft, v, col.type));
      setDraft(null);
    },
  };
  return long ? (
    <textarea {...common} rows={Math.min(10, Math.max(3, Math.ceil(text.length / 40)))} />
  ) : (
    <input {...common} inputMode={isNumericType(col.type) ? "decimal" : undefined} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
  );
}

function JsonEditor({ initial, onDone }: { initial: string; onDone: (text: string | null) => void }) {
  const [text, setText] = useState(initial);
  let err: string | null = null;
  if (text.trim()) {
    try {
      JSON.parse(text);
    } catch (e) {
      err = (e as Error).message;
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <textarea className="input mono" rows={8} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      {err && <div className="err">{err}</div>}
      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn primary" disabled={!!err} onClick={() => onDone(text)}>
          Set
        </button>
        <button className="btn" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function toLocalInput(s: string, type: string): { kind: "date" | "datetime-local" | null; value: string } {
  if (/^date/i.test(type) && !/time/i.test(type)) return { kind: "date", value: /^\d{4}-\d{2}-\d{2}/.exec(s)?.[0] ?? "" };
  if (/time/i.test(type) && !/^time/i.test(type)) {
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(s);
    return { kind: "datetime-local", value: m ? `${m[1]}T${m[2]}` : "" };
  }
  return { kind: null, value: "" };
}

function fromLocalInput(v: string, kind: "date" | "datetime-local", previous: string): string {
  if (kind === "date") return v;
  // Keep seconds and zone suffix from the previous value when there was one.
  const tail = /:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}(:?\d{2})?|Z)?$/.exec(previous);
  const zone = tail?.[3] ?? "";
  return v.replace("T", " ") + ":00" + zone;
}
