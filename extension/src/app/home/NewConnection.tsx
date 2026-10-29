// New connection picker (engine grid with keyboard navigation) and the per-driver sheet.

import { useMemo, useRef, useState } from "react";
import type { DriverId, Env } from "@core/types";
import { BIGQUERY_AUTH, ENGINES, defaultValues, engine, fieldVisible, gridMove, type FormField } from "../lib/driverForms";
import { buildConnection, formFromConnection, type FormState } from "../lib/connForm";
import { BIGQUERY_AUTH_GUIDES, type ConnectionGuide } from "../lib/connectionGuides";
import { openDriver, parseConnectionUrl, saveConnection, withSecret } from "../lib/connections";
import { pickFile } from "../lib/files";
import { ENV_VAR } from "../lib/format";
import * as db from "../store/db";
import { secretStore, sessionSecrets } from "../store/secrets";
import { EngineBadge, Modal } from "../components/ui";

const COLS = 4;
const ENVS: Env[] = ["local", "dev", "staging", "production"];

export function EnginePicker(props: { onPick: (id: DriverId, prefill?: Partial<FormState>) => void; onCancel: () => void; onNewGroup: () => void }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [importing, setImporting] = useState(false);
  const [url, setUrl] = useState("");
  const [importErr, setImportErr] = useState("");
  const list = ENGINES.filter((e) => e.name.toLowerCase().includes(q.toLowerCase()));
  const cur = list[Math.min(idx, list.length - 1)];

  const pick = () => cur?.available && props.onPick(cur.id as DriverId);

  const doImport = () => {
    const parsed = parseConnectionUrl(url);
    if (!parsed?.driver) {
      setImportErr("Not a postgres://, redis:// or clickhouse:// URL.");
      return;
    }
    props.onPick(parsed.driver, { name: parsed.name ?? "", values: { ...(parsed.options ?? {}) } });
  };

  return (
    <Modal
      title="New connection"
      wide
      onClose={props.onCancel}
      actions={
        <>
          <button className="btn" onClick={() => setImporting(!importing)} aria-pressed={importing}>
            Import connection
          </button>
          <button className="btn" onClick={props.onNewGroup}>
            New group
          </button>
          <span className="spacer" />
          <button className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={!cur?.available} onClick={pick}>
            Create
          </button>
        </>
      }
    >
      <input
        className="input"
        autoFocus
        placeholder="Search engines…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setIdx(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            pick();
          } else if (["ArrowDown", "ArrowUp"].includes(e.key) || (["ArrowLeft", "ArrowRight"].includes(e.key) && q === "")) {
            e.preventDefault();
            setIdx((i) => gridMove(i, e.key, list.length, COLS));
          }
        }}
        aria-label="Search engines"
      />
      <div
        className="picker-grid"
        role="listbox"
        aria-label="Engines"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Enter") pick();
          else {
            const n = gridMove(idx, e.key, list.length, COLS);
            if (n !== idx) {
              e.preventDefault();
              setIdx(n);
              (e.currentTarget.children[n] as HTMLElement | undefined)?.focus();
            }
          }
        }}
      >
        {list.map((e, i) => (
          <button
            key={e.id}
            className={"pick" + (i === idx ? " on" : "")}
            disabled={!e.available}
            role="option"
            aria-selected={i === idx}
            onClick={() => setIdx(i)}
            onDoubleClick={() => e.available && props.onPick(e.id as DriverId)}
            onFocus={() => setIdx(i)}
          >
            <EngineBadge driver={e.id} name={e.name} badge={e.badge} large dim={!e.available} />
            {e.name}
            {!e.available ? <small>Coming later</small> : e.needsRunner ? <small>needs runner</small> : <small>in browser</small>}
          </button>
        ))}
      </div>
      {importing && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="input mono"
              style={{ flex: 1 }}
              placeholder="postgres://user@host:5432/db"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setImportErr("");
              }}
              onKeyDown={(e) => e.key === "Enter" && doImport()}
              aria-label="Connection URL"
            />
            <button className="btn" onClick={doImport}>
              Import
            </button>
          </div>
          {importErr && <div className="err">{importErr}</div>}
          <div className="faint" style={{ fontSize: 13 }}>
            Passwords in the URL are ignored; you type them in the next step. TablePlus/DBeaver exports: not supported yet.
          </div>
        </div>
      )}
    </Modal>
  );
}

function FieldInput(props: {
  f: FormField;
  value: unknown;
  file?: { id: string; name: string };
  onChange: (v: unknown) => void;
  onFile: (f: { id: string; name: string }) => void;
}) {
  const { f, value } = props;
  const id = `f_${f.key}`;
  switch (f.kind) {
    case "select":
      return (
        <select id={id} className="input" value={String(value ?? f.default ?? "")} onChange={(e) => props.onChange(e.target.value)}>
          {f.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "checkbox":
      return <input id={id} type="checkbox" checked={value === true || value === "true"} onChange={(e) => props.onChange(e.target.checked)} style={{ justifySelf: "start" }} />;
    case "textarea":
      return <textarea id={id} className="input mono" rows={3} value={String(value ?? "")} onChange={(e) => props.onChange(e.target.value)} />;
    case "file":
      return (
        <div style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
          <button
            id={id}
            className="btn"
            type="button"
            onClick={async () => {
              const accept = Object.fromEntries([["application/octet-stream", (f.accept ?? "").split(",").filter(Boolean)]]);
              const h = await pickFile(accept, f.label);
              if (!h) return;
              const row: db.StoredHandle = { id: db.uid("h_"), handle: h, name: h.name };
              await db.put("handles", row);
              props.onFile({ id: row.id, name: row.name });
            }}
          >
            Choose…
          </button>
          <span className="mono faint" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {props.file?.name ?? "no file"}
          </span>
        </div>
      );
    default:
      return (
        <input
          id={id}
          className={"input" + (f.kind === "password" || f.kind === "number" ? " mono" : "")}
          type={f.kind === "password" ? "password" : f.kind === "number" ? "number" : "text"}
          placeholder={f.secret && !f.placeholder ? "unchanged if left blank" : f.placeholder}
          value={String(value ?? "")}
          autoComplete={f.kind === "password" ? "new-password" : "off"}
          onChange={(e) => props.onChange(e.target.value)}
        />
      );
  }
}

export function ConnectionForm(props: {
  driver: DriverId;
  existing?: db.SavedConnection;
  prefill?: Partial<FormState>;
  groups: string[];
  onSaved: (c: db.SavedConnection, connect: boolean) => void;
  onCancel: () => void;
}) {
  const spec = engine(props.driver)!;
  const [form, setForm] = useState<FormState>(() =>
    props.existing
      ? formFromConnection(props.existing)
      : {
          name: props.prefill?.name ?? "",
          env: "local",
          readOnly: false,
          group: "",
          secretMode: "session",
          files: {},
          ...props.prefill,
          values: { ...defaultValues(spec), ...(props.prefill?.values ?? {}) },
        },
  );
  const [test, setTest] = useState<{ state: "idle" | "running" | "ok" | "error"; msg?: string }>({ state: "idle" });
  const [error, setError] = useState("");
  const idRef = useRef(props.existing?.id ?? db.uid());
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, values: { ...f.values, [k]: v } }));

  const visible = useMemo(() => spec.fields.filter((f) => fieldVisible(f, form.values)), [spec, form.values]);
  const hasSecrets = spec.fields.some((f) => f.secret);

  const build = () => buildConnection(props.driver, form, idRef.current, props.existing?.createdAt);

  const runTest = async () => {
    setTest({ state: "running" });
    const ac = new AbortController();
    try {
      const { config, secrets } = build();
      const driver = await openDriver(config);
      const main = config.secretRef ? (secrets[config.secretRef] ?? null) : null;
      const r = await driver.connect(withSecret(config, main), ac.signal);
      await driver.disconnect();
      setTest({ state: "ok", msg: r.serverVersion ? `Connected: ${r.serverVersion}` : "Connected" });
    } catch (e) {
      setTest({ state: "error", msg: (e as Error).message });
    }
  };

  const save = async (connect: boolean) => {
    setError("");
    try {
      const { config, secrets } = build();
      // ClickHouse over HTTP needs host access to that one origin (§3.9).
      if (props.driver === "clickhouse" && typeof config.options.url === "string" && config.options.protocol !== "native") {
        try {
          const origin = new URL(config.options.url).origin + "/*";
          const ok = await chrome.permissions.request({ origins: [origin] });
          if (!ok) throw new Error(`dbui needs access to ${origin} to reach ClickHouse over HTTP.`);
        } catch (e) {
          if (e instanceof TypeError) throw new Error("The URL is not valid.");
          throw e;
        }
      }
      // A BigQuery key kept "in this browser" goes to chrome.storage.local, not a file handle.
      const bqAuth = config.options.auth as { method?: string; options?: { keySecretRef?: string } } | undefined;
      if (bqAuth?.method === "service-account" && bqAuth.options?.keySecretRef) {
        const file = form.files.keyFile;
        const row = file ? await db.get("handles", file.id) : undefined;
        if (!row) throw new Error("Choose the service account key file.");
        await secretStore("browser").set(bqAuth.options.keySecretRef, await (await row.handle.getFile()).text());
        await db.del("handles", row.id);
        delete config.options.keyFileHandleId;
      }
      const store = secretStore(form.secretMode);
      for (const [ref, v] of Object.entries(secrets)) {
        await sessionSecrets.set(ref, v);
        if (store !== sessionSecrets) await store.set(ref, v);
      }
      await saveConnection(config);
      props.onSaved(config, connect);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const authField = props.driver === "bigquery";

  return (
    <Modal
      title={
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <EngineBadge driver={spec.id} name={spec.name} badge={spec.badge} />
          {props.existing ? `Edit ${props.existing.name}` : `New ${spec.name} connection`}
        </span>
      }
      wide
      onClose={props.onCancel}
      actions={
        <>
          <button className="btn" onClick={runTest} disabled={test.state === "running"}>
            {test.state === "running" ? "Testing…" : "Test connection"}
          </button>
          {test.state === "ok" && <span style={{ color: "var(--add-fg)", fontSize: 14 }}>{test.msg}</span>}
          <span className="spacer" />
          <button className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="btn" onClick={() => void save(false)}>
            Save
          </button>
          <button className="btn primary" onClick={() => void save(true)}>
            Connect
          </button>
        </>
      }
    >
      <form className="form" onSubmit={(e) => (e.preventDefault(), void save(true))}>
        <label className="k" htmlFor="f_name">
          Name
        </label>
        <input id="f_name" className="input" autoFocus value={form.name} placeholder={spec.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <span className="k">Environment</span>
        <div className="envpick" role="group" aria-label="Environment">
          {ENVS.map((env) => (
            <button key={env} type="button" aria-pressed={form.env === env} style={{ ["--envc" as string]: ENV_VAR[env] }} onClick={() => setForm({ ...form, env, readOnly: env === "production" ? true : form.readOnly })}>
              {env}
            </button>
          ))}
        </div>
        <label className="k" htmlFor="f_group">
          Group
        </label>
        <input id="f_group" className="input" list="dbui-groups" value={form.group} placeholder="none" onChange={(e) => setForm({ ...form, group: e.target.value })} />
        <datalist id="dbui-groups">
          {props.groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>

        {authField && (
          <>
            <label className="k" htmlFor="f_auth">
              Sign in with
            </label>
            <div className="authpick">
              <select id="f_auth" className="input" value={String(form.values.auth ?? "")} onChange={(e) => set("auth", e.target.value)}>
                {BIGQUERY_AUTH.map((a) => (
                  <option key={a.value} value={a.value} disabled={!a.available}>
                    {a.available ? a.label : `${a.label} (needs the runner)`}
                  </option>
                ))}
              </select>
              <Guide guide={BIGQUERY_AUTH_GUIDES[String(form.values.auth ?? "")]} />
            </div>
          </>
        )}

        {visible
          .filter((f) => !(authField && f.key === "auth"))
          .map((f) => (
            <FieldRow key={f.key} f={f}>
              <FieldInput f={f} value={form.values[f.key]} file={form.files[f.key]} onChange={(v) => set(f.key, v)} onFile={(file) => setForm((s) => ({ ...s, files: { ...s.files, [f.key]: file } }))} />
            </FieldRow>
          ))}

        {hasSecrets && (
          <>
            <label className="k" htmlFor="f_secretMode">
              Secrets
            </label>
            <select id="f_secretMode" className="input" value={form.secretMode} onChange={(e) => setForm({ ...form, secretMode: e.target.value as FormState["secretMode"] })}>
              <option value="session">Ask every session (memory only)</option>
              <option value="browser">Remember in this browser (chrome.storage.local, never synced)</option>
            </select>
          </>
        )}
        <span className="k">Read-only</span>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={form.readOnly} onChange={(e) => setForm({ ...form, readOnly: e.target.checked })} />
          <span className="muted">Block edits and write statements</span>
        </label>
        <button type="submit" hidden />
      </form>
      {spec.needsRunner && <div className="note">This engine runs through the dbui runner. Without it, opening the connection shows the install card.</div>}
      {test.state === "error" && <ErrorLine msg={test.msg ?? ""} />}
      {error && <ErrorLine msg={error} />}
    </Modal>
  );
}

/** How the chosen BigQuery sign-in method works, what it needs, and where it fits. */
function Guide({ guide }: { guide: ConnectionGuide | undefined }) {
  if (!guide) return null;
  return (
    <section className="guide" aria-label="About this sign-in method">
      <p className="guide-how">{guide.how}</p>
      <div className="guide-cols">
        <div>
          <h4>You need</h4>
          <ul>{guide.needs.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
        <div>
          <h4 className="good">Good for</h4>
          <ul>{guide.goodFor.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
        {guide.avoid && (
          <div>
            <h4 className="avoid">Not a good fit</h4>
            <ul>{guide.avoid.map((n) => <li key={n}>{n}</li>)}</ul>
          </div>
        )}
      </div>
    </section>
  );
}

/** Error line; a stale-build error gets a Reload button since nothing else fixes it. */
function ErrorLine({ msg }: { msg: string }) {
  const stale = msg.startsWith("dbui was updated while this tab was open");
  return (
    <div className="err">
      {msg}
      {stale && (
        <>
          {" "}
          <button type="button" className="btn" onClick={() => location.reload()}>
            Reload tab
          </button>
        </>
      )}
    </div>
  );
}

function FieldRow({ f, children }: { f: FormField; children: React.ReactNode }) {
  return (
    <>
      <label className="k" htmlFor={`f_${f.key}`}>
        {f.label}
      </label>
      {children}
      {f.hint && <div className="hint">{f.hint}</div>}
    </>
  );
}
