// Pretty-printed, foldable JSON for the Details pane.
import { useState } from "react";

function Leaf({ v }: { v: unknown }) {
  if (v === null) return <span className="jb">null</span>;
  if (typeof v === "string") return <span className="js">{JSON.stringify(v)}</span>;
  if (typeof v === "number") return <span className="jn">{String(v)}</span>;
  if (typeof v === "boolean") return <span className="jb">{String(v)}</span>;
  return <span>{JSON.stringify(v)}</span>;
}

function Node({ name, v, last, depth }: { name?: string; v: unknown; last: boolean; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const comma = last ? "" : ",";
  const label = name !== undefined ? <><span className="jk">{JSON.stringify(name)}</span>: </> : null;
  if (v === null || typeof v !== "object") {
    return (
      <div>
        {label}
        <Leaf v={v} />
        {comma}
      </div>
    );
  }
  const isArr = Array.isArray(v);
  const entries = isArr ? (v as unknown[]).map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
  const [o, c] = isArr ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) {
    return (
      <div>
        {label}
        {o}
        {c}
        {comma}
      </div>
    );
  }
  return (
    <div>
      <button className="jt" onClick={() => setOpen(!open)} aria-label={open ? "Fold" : "Unfold"}>
        {open ? "▾" : "▸"}
      </button>
      {label}
      {o}
      {open ? (
        <div className="ji">
          {entries.map(([k, x], i) => (
            <Node key={k} name={isArr ? undefined : k} v={x} last={i === entries.length - 1} depth={depth + 1} />
          ))}
        </div>
      ) : (
        <span className="faint"> … {entries.length} </span>
      )}
      {c}
      {comma}
    </div>
  );
}

export function JsonView({ value }: { value: unknown }) {
  return (
    <div className="json-view">
      <Node v={value} last depth={0} />
    </div>
  );
}
