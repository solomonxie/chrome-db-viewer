// Filter rows above the grid (DESIGN.md §4.2): ☑ [column ▾] [operator ▾] [value] [−][+].

import type { Column } from "@core/types";
import { FILTER_OPS, opNeedsValue, RAW_SQL, type FilterOp, type FilterRow, type Joiner } from "../lib/filters";
import { MOD } from "../lib/keys";

let nextId = 1;
export const newFilter = (column = "", op: FilterOp = "=", value = ""): FilterRow => ({ id: nextId++, enabled: true, column, op, value });

export function FilterRows(props: {
  columns: Column[];
  rows: FilterRow[];
  joiner: Joiner;
  onChange: (rows: FilterRow[], joiner: Joiner) => void;
  onApply: (rows: FilterRow[], joiner: Joiner) => void;
  onShowSql: () => void;
}) {
  const { rows, joiner } = props;
  const update = (id: number, patch: Partial<FilterRow>) => props.onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)), joiner);
  const remove = (id: number) => {
    const left = rows.filter((r) => r.id !== id);
    props.onChange(left.length ? left : [newFilter(props.columns[0]?.name)], joiner);
  };
  const add = (after: number) => {
    const i = rows.findIndex((r) => r.id === after);
    const next = rows.slice();
    next.splice(i + 1, 0, newFilter(props.columns[0]?.name));
    props.onChange(next, joiner);
  };

  return (
    <div className="frows">
      {rows.map((r, i) => {
        const raw = r.column === RAW_SQL;
        return (
          <div className="frow-f" key={r.id}>
            <input type="checkbox" checked={r.enabled} onChange={(e) => update(r.id, { enabled: e.target.checked })} title="Turn this condition on or off" aria-label="Enabled" />
            {i > 0 ? <span className="faint" style={{ width: 28, fontSize: 11 }}>{joiner}</span> : <span style={{ width: 28 }} />}
            <select className="input" value={r.column} onChange={(e) => update(r.id, { column: e.target.value })} aria-label="Column">
              <option value={RAW_SQL}>Raw SQL</option>
              {props.columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            {!raw && (
              <select className="input" value={r.op} onChange={(e) => update(r.id, { op: e.target.value as FilterOp })} aria-label="Operator">
                {FILTER_OPS.map((o) => (
                  <option key={o.op} value={o.op}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
            {(raw || opNeedsValue(r.op)) && (
              <input
                className="input mono val"
                value={r.value}
                placeholder={raw ? "WHERE expression, e.g. total > 100 OR paid" : r.op === "in" ? "a, b, c" : r.op === "between" ? "from" : "value"}
                onChange={(e) => update(r.id, { value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    props.onApply([{ ...r, enabled: true }], joiner);
                  }
                }}
                aria-label="Value"
              />
            )}
            {!raw && r.op === "between" && (
              <input className="input mono val" value={r.value2 ?? ""} placeholder="to" onChange={(e) => update(r.id, { value2: e.target.value })} aria-label="Upper bound" />
            )}
            {!raw && !opNeedsValue(r.op) && <span className="val" />}
            <button className="btn" onClick={() => props.onApply([{ ...r, enabled: true }], joiner)} title="Apply only this condition">
              Apply
            </button>
            <button className="btn icon" onClick={() => remove(r.id)} title="Remove condition" aria-label="Remove condition">
              −
            </button>
            <button className="btn icon" onClick={() => add(r.id)} title="Add condition" aria-label="Add condition">
              +
            </button>
          </div>
        );
      })}
      <div className="frow-f">
        <span className="hint">
          <span>
            Apply all: <kbd>{MOD}↵</kbd>
          </span>
          <span>
            Hide: <kbd>{MOD}F</kbd>
          </span>
        </span>
        <span className="spacer" />
        <button className="btn" onClick={props.onShowSql} title="Open the generated query in a query tab">
          SQL
        </button>
        <button className="btn" onClick={() => props.onApply([], joiner)}>
          Clear
        </button>
        <span className="seg" role="group" aria-label="Join conditions with">
          {(["AND", "OR"] as const).map((j) => (
            <button key={j} aria-pressed={joiner === j} onClick={() => props.onChange(rows, j)}>
              {j}
            </button>
          ))}
        </span>
        <button className="btn primary" onClick={() => props.onApply(rows, joiner)}>
          Apply All
        </button>
      </div>
    </div>
  );
}
