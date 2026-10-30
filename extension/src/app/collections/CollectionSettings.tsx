// Collection settings (DESIGN.md §3.14): name, default connection, variables (with a secret
// flag), environments and which one is active, and the collection's pre/post scripts. Also the
// small Scripts dialog used for folders and queries.

import { useEffect, useState } from "react";
import type { Collection, Environment, Scripts, VarDef, VarType } from "../../collections/model";
import { formatVarInput, parseVarInput } from "../../collections/params";
import { saveCollection } from "../../collections/store";
import { listConnections, type SavedConnection } from "../lib/connections";
import { Modal } from "../components/ui";
import * as db from "../store/db";

const TYPES: VarType[] = ["string", "number", "date", "boolean", "list", "json"];

export function CollectionSettings(props: { collection: Collection; onClose: () => void; onSaved?: (c: Collection) => void }) {
  const [c, setC] = useState<Collection>(props.collection);
  const [conns, setConns] = useState<SavedConnection[]>([]);
  const [envId, setEnvId] = useState<string | undefined>(props.collection.activeEnvironmentId ?? props.collection.environments[0]?.id);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    listConnections().then(setConns, () => setConns([]));
  }, []);

  const patchVar = (i: number, patch: Partial<VarDef>) => setC({ ...c, vars: c.vars.map((v, j) => (j === i ? { ...v, ...patch } : v)) });
  const env = c.environments.find((e) => e.id === envId);
  const patchEnv = (patch: Partial<Environment>) => setC({ ...c, environments: c.environments.map((e) => (e.id === envId ? { ...e, ...patch } : e)) });

  const save = async () => {
    const names = c.vars.map((v) => v.name.trim());
    const bad = names.find((n) => !/^[A-Za-z_]\w*$/.test(n));
    if (bad !== undefined) return setError(`"${bad}" isn't a valid variable name`);
    if (new Set(names).size !== names.length) return setError("Two variables have the same name");
    if (!c.name.trim()) return setError("Give the collection a name");
    const saved = await saveCollection({ ...c, name: c.name.trim(), vars: c.vars.map((v) => ({ ...v, name: v.name.trim() })) });
    props.onSaved?.(saved);
    props.onClose();
  };

  return (
    <Modal
      wide
      title={`Collection settings`}
      onClose={props.onClose}
      actions={
        <>
          {error && <span className="err" style={{ padding: "4px 8px" }}>{error}</span>}
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="coll-form">
        <label>
          Name
          <input className="input" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} aria-label="Collection name" />
        </label>
        <label>
          Default connection
          <select className="input" value={c.defaultConnectionId ?? ""} onChange={(e) => setC({ ...c, defaultConnectionId: e.target.value || undefined })} aria-label="Default connection">
            <option value="">(none)</option>
            {conns.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <h4 className="coll-h">Variables</h4>
      <p className="faint" style={{ margin: 0 }}>
        Defaults for every query in the collection. Secret values stay in this browser's secret store and are never exported.
      </p>
      <div className="coll-vars">
        {c.vars.map((v, i) => (
          <div key={i} className="coll-var">
            <input className="input mono" value={v.name} placeholder="name" onChange={(e) => patchVar(i, { name: e.target.value })} aria-label="Variable name" />
            <select className="input" value={v.type ?? "string"} onChange={(e) => patchVar(i, { type: e.target.value as VarType })} aria-label="Variable type">
              {TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <ValueInput type={v.type ?? "string"} secret={v.secret} value={v.value} onChange={(value) => patchVar(i, { value })} label={`Default for ${v.name}`} />
            <label className="coll-secret" title="Kept in the secret store, never exported">
              <input type="checkbox" checked={!!v.secret} onChange={(e) => patchVar(i, { secret: e.target.checked })} /> secret
            </label>
            <button className="btn ghost" onClick={() => setC({ ...c, vars: c.vars.filter((_, j) => j !== i) })} aria-label={`Remove ${v.name}`}>
              ✕
            </button>
          </div>
        ))}
        <button className="btn" onClick={() => setC({ ...c, vars: [...c.vars, { name: "", type: "string" }] })}>
          + Variable
        </button>
      </div>

      <h4 className="coll-h">Environments</h4>
      <div className="coll-envbar">
        <select className="input" value={envId ?? ""} onChange={(e) => setEnvId(e.target.value || undefined)} aria-label="Environment to edit">
          {c.environments.length === 0 && <option value="">No environments</option>}
          {c.environments.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
              {e.id === c.activeEnvironmentId ? " (active)" : ""}
            </option>
          ))}
        </select>
        <button
          className="btn"
          onClick={() => {
            const name = prompt("Environment name", c.environments.length ? "prod" : "dev");
            if (!name) return;
            const e: Environment = { id: db.uid("env_"), name, values: {} };
            setC({ ...c, environments: [...c.environments, e], activeEnvironmentId: c.activeEnvironmentId ?? e.id });
            setEnvId(e.id);
          }}
        >
          + Environment
        </button>
        {env && (
          <>
            <button className="btn" disabled={c.activeEnvironmentId === env.id} onClick={() => setC({ ...c, activeEnvironmentId: env.id })}>
              Make active
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                const rest = c.environments.filter((e) => e.id !== env.id);
                setC({ ...c, environments: rest, activeEnvironmentId: c.activeEnvironmentId === env.id ? rest[0]?.id : c.activeEnvironmentId });
                setEnvId(rest[0]?.id);
              }}
            >
              Delete
            </button>
          </>
        )}
        <span className="spacer" />
        <label className="faint">
          Active{" "}
          <select className="input" value={c.activeEnvironmentId ?? ""} onChange={(e) => setC({ ...c, activeEnvironmentId: e.target.value || undefined })} aria-label="Active environment">
            <option value="">(none)</option>
            {c.environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {env && (
        <div className="coll-vars">
          <input className="input" value={env.name} onChange={(e) => patchEnv({ name: e.target.value })} aria-label="Environment name" />
          {c.vars.length === 0 && <div className="faint">Add variables above, then give them values for this environment.</div>}
          {c.vars
            .filter((v) => v.name)
            .map((v) => (
              <div key={v.name} className="coll-var env">
                <span className="mono">{v.name}</span>
                <ValueInput
                  type={v.type ?? "string"}
                  secret={v.secret}
                  value={env.values[v.name]}
                  placeholder={v.value !== undefined ? `default: ${formatVarInput(v.value, v.type ?? "string")}` : "(collection default)"}
                  label={`${v.name} in ${env.name}`}
                  onChange={(value) => {
                    const values = { ...env.values };
                    if (value === undefined) delete values[v.name];
                    else values[v.name] = value;
                    patchEnv({ values });
                  }}
                />
              </div>
            ))}
        </div>
      )}

      <h4 className="coll-h">Scripts</h4>
      <ScriptsFields scripts={c.scripts} onChange={(scripts) => setC({ ...c, scripts })} />
    </Modal>
  );
}

function ValueInput(props: { type: VarType; value: unknown; secret?: boolean; placeholder?: string; label: string; onChange: (v: unknown) => void }) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? formatVarInput(props.value, props.type);
  return (
    <input
      className="input mono"
      type={props.secret ? "password" : props.type === "date" ? "date" : props.type === "number" ? "number" : "text"}
      value={shown}
      placeholder={props.placeholder}
      aria-label={props.label}
      autoComplete="off"
      onChange={(e) => {
        setText(e.target.value);
        props.onChange(parseVarInput(e.target.value, props.type));
      }}
      onBlur={() => setText(null)}
    />
  );
}

const PRE_HELP = 'Runs before render. db.vars.set("end_date", "2026-10-31"), db.env.get("x"), db.fail("why")';
const POST_HELP = 'Runs after the result. db.test("has rows", db.result.rowCount > 0); db.result.columns is a list of names, db.result.rows are objects by column; db.vars.set("ids", db.result.column("id")); db.log(…)';

function ScriptsFields({ scripts, onChange }: { scripts: Scripts | undefined; onChange: (s: Scripts) => void }) {
  return (
    <div className="coll-scripts">
      <label>
        Pre-run
        <textarea className="input mono" rows={4} value={scripts?.pre ?? ""} placeholder={PRE_HELP} onChange={(e) => onChange({ ...scripts, pre: e.target.value })} aria-label="Pre-run script" />
      </label>
      <label>
        Post-run
        <textarea className="input mono" rows={4} value={scripts?.post ?? ""} placeholder={POST_HELP} onChange={(e) => onChange({ ...scripts, post: e.target.value })} aria-label="Post-run script" />
      </label>
    </div>
  );
}

/** Scripts for a folder or a named query. */
export function ScriptsModal(props: { title: string; scripts: Scripts | undefined; onSave: (s: Scripts) => void; onClose: () => void }) {
  const [s, setS] = useState<Scripts>(props.scripts ?? {});
  return (
    <Modal
      wide
      title={props.title}
      onClose={props.onClose}
      actions={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => {
              props.onSave({ pre: s.pre?.trim() ? s.pre : undefined, post: s.post?.trim() ? s.post : undefined });
              props.onClose();
            }}
          >
            Save
          </button>
        </>
      }
    >
      <p>Order: collection pre → folder pre → query pre → run → query post → folder post → collection post.</p>
      <ScriptsFields scripts={s} onChange={setS} />
    </Modal>
  );
}
