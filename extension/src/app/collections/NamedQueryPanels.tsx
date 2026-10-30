// Pieces of a query tab bound to a named query: the Parameters panel beside the editor, the
// Rendered / Tests / Console tabs beside the results, and the confirm for environment writes.

import { useState } from "react";
import { Modal } from "../components/ui";
import { formatVarInput, parseVarInput } from "../../collections/params";
import type { NamedQueryState, ParamRow } from "./useNamedQuery";

const SOURCE_LABEL = { session: "this session", environment: "environment", query: "query default", collection: "collection default", template: "var() default" } as const;

export function ParamsPanel({ nq }: { nq: NamedQueryState }) {
  const envs = nq.bundle.collection.environments;
  return (
    <div className="nq-params" aria-label="Parameters">
      <div className="nq-params-head">
        <b>Parameters</b>
        <span className="faint mono" title="Path used by include and ref">
          {nq.path}
        </span>
        <span className="spacer" />
        <label className="faint" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          Env
          <select className="input" value={nq.bundle.collection.activeEnvironmentId ?? ""} onChange={(e) => void nq.setActiveEnvironment(e.target.value || undefined)} aria-label="Active environment">
            <option value="">(none)</option>
            {envs.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {nq.rows.length === 0 && <div className="faint" style={{ padding: "6px 10px" }}>No variables. Use {"{{ name | sql }}"} in the template to add one.</div>}
      <div className="nq-param-list">
        {nq.rows.map((r) => (
          <ParamInput key={r.kind + r.key} row={r} nq={nq} />
        ))}
      </div>
      {nq.missing.length > 0 && <div className="nq-missing">Fill in {nq.missing.join(", ")} to run.</div>}
    </div>
  );
}

function ParamInput({ row, nq }: { row: ParamRow; nq: NamedQueryState }) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? formatVarInput(row.value, row.type);
  const missing = row.required && (row.value === undefined || row.value === null || row.value === "" || (Array.isArray(row.value) && row.value.length === 0));
  const commit = (t: string) => {
    setText(null);
    nq.setValue(row, parseVarInput(t, row.type));
  };
  const id = `nqp_${row.kind}_${row.key.replace(/\W/g, "_")}`;
  const common = {
    id,
    "aria-label": row.label,
    "aria-invalid": missing || undefined,
    className: "input mono" + (missing ? " missing" : ""),
  };
  let input: React.ReactNode;
  if (row.type === "boolean") {
    input = (
      <select {...common} value={row.value === true ? "true" : row.value === false ? "false" : ""} onChange={(e) => nq.setValue(row, e.target.value === "" ? undefined : e.target.value === "true")}>
        <option value="" />
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  } else {
    input = (
      <input
        {...common}
        type={row.type === "date" ? "date" : row.type === "number" ? "number" : row.secret ? "password" : "text"}
        placeholder={row.type === "list" ? "a, b, c" : row.type === "json" ? "{…}" : ""}
        value={shown}
        onChange={(e) => {
          if (row.type === "date" || row.type === "number") commit(e.target.value);
          else setText(e.target.value);
        }}
        onBlur={(e) => text !== null && commit(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && commit(e.currentTarget.value)}
        autoComplete="off"
      />
    );
  }
  return (
    <div className="nq-param">
      <label htmlFor={id} title={row.kind === "sql" ? "Sent as a real query parameter" : "Template variable"}>
        <span className="mono">{row.label}</span>
        <small className="faint">
          {row.type}
          {row.source && ` · ${SOURCE_LABEL[row.source]}`}
          {!row.required && " · optional"}
        </small>
      </label>
      {input}
      {row.kind === "var" && row.source === "session" && (
        <span className="nq-keep">
          <button className="btn ghost" onClick={() => void nq.saveAsDefault(row)} title="Keep this value as the query's default">
            Save as default
          </button>
          {nq.bundle.collection.activeEnvironmentId && (
            <button className="btn ghost" onClick={() => void nq.saveToEnvironment(row)} title="Write this value to the active environment">
              Save to env
            </button>
          )}
        </span>
      )}
    </div>
  );
}

export function RenderedPanel({ nq, onCopy }: { nq: NamedQueryState; onCopy: (text: string) => void }) {
  return (
    <div className="nq-rendered">
      <div className="edbar">
        <button className="btn" disabled={!nq.rendered} onClick={() => nq.rendered && onCopy(nq.rendered)}>
          Copy rendered SQL
        </button>
        {nq.analysis && nq.analysis.includes.length > 0 && <span className="faint">includes {nq.analysis.includes.join(", ")}</span>}
        {nq.analysis && nq.analysis.refs.length > 0 && <span className="faint">refs {nq.analysis.refs.join(", ")}</span>}
      </div>
      {nq.analysis?.warnings.map((w, i) => (
        <div key={i} className="nq-warn">
          {w.message}
        </div>
      ))}
      {nq.renderError ? <div className="err" style={{ margin: 8 }}>{nq.renderError}</div> : <pre className="nq-rendered-sql mono">{nq.rendered}</pre>}
    </div>
  );
}

export function TestsPanel({ nq }: { nq: NamedQueryState }) {
  const s = nq.scripts;
  if (!s || (s.tests.length === 0 && !s.error)) return <div className="empty">No tests yet. A post-run script can add them with db.test("has rows", db.result.rowCount &gt; 0).</div>;
  const passed = s.tests.filter((t) => t.passed).length;
  return (
    <div className="nq-tests">
      {s.error && <div className="err" style={{ margin: 8 }}>{s.error}</div>}
      {s.tests.length > 0 && (
        <div className="faint" style={{ padding: "6px 12px" }}>
          {passed} of {s.tests.length} passed
        </div>
      )}
      {s.tests.map((t, i) => (
        <div key={i} className={"nq-test " + (t.passed ? "pass" : "fail")}>
          <span>{t.passed ? "✓" : "✗"}</span> {t.name}
        </div>
      ))}
    </div>
  );
}

export function ConsolePanel({ nq }: { nq: NamedQueryState }) {
  const logs = nq.scripts?.logs ?? [];
  if (logs.length === 0) return <div className="empty">No output. Scripts write here with db.log(…).</div>;
  return <pre className="nq-console mono">{logs.join("\n")}</pre>;
}

export function EnvChangesConfirm({ nq }: { nq: NamedQueryState }) {
  const changes = nq.pendingEnv;
  if (!changes) return null;
  const env = nq.bundle.collection.environments.find((e) => e.id === nq.bundle.collection.activeEnvironmentId);
  return (
    <Modal
      title="A script wants to change the environment"
      onClose={() => void nq.applyEnv(false)}
      actions={
        <>
          <button className="btn" onClick={() => void nq.applyEnv(false)}>
            Don't change
          </button>
          <button className="btn primary" onClick={() => void nq.applyEnv(true)} disabled={!env}>
            Apply to {env?.name ?? "environment"}
          </button>
        </>
      }
    >
      <p>{env ? <>These values will be written to environment <b>{env.name}</b>:</> : "There's no active environment to write to."}</p>
      <pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
        {Object.entries(changes)
          .map(([k, v]) => `${k} = ${v === null ? "(unset)" : JSON.stringify(v)}`)
          .join("\n")}
      </pre>
    </Modal>
  );
}
