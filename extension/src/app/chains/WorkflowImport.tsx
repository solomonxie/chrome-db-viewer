// Import a workflow file (src/chains/workflowFile.ts) and export one. Import shows what the
// file holds, maps each connection alias in it to a saved connection of the same engine, and,
// when a workflow with the same name exists, asks whether to replace it or keep both.

import { useEffect, useMemo, useState } from "react";
import type { Chain, NamedQuery } from "../../collections/model";
import { listAllQueries } from "../../collections/store";
import { chainLibrary } from "../../chains/appDeps";
import { guessConnections, parseWorkflowFile, workflowFileName, workflowFromFile, workflowToFile, type WorkflowFile } from "../../chains/workflowFile";
import { listConnections, type SavedConnection } from "../lib/connections";
import { ENGINE } from "../lib/format";
import { uid } from "../store/db";
import { Modal } from "../components/ui";
import { allChains, kindLabel, saveChain } from "./chainStore";

/** Opens the file chooser and hands over the parsed file, or reports why it isn't one. */
export function pickWorkflowFile(onFile: (f: WorkflowFile) => void, onError: (msg: string) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      onFile(parseWorkflowFile(await f.text()));
    } catch (e) {
      onError(`${f.name}: ${(e as Error).message}`);
    }
  };
  input.click();
}

/** Saves a workflow as a .dbui-workflow.json file. */
export async function downloadWorkflow(c: Chain): Promise<void> {
  const [conns, lib] = await Promise.all([listConnections(), chainLibrary()]);
  const file = workflowToFile(c, conns, lib);
  const blob = new Blob([JSON.stringify(file, null, 2) + "\n"], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = workflowFileName(c.name);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function ImportWorkflowDialog(props: { file: WorkflowFile; onClose: () => void; onImported: (c: Chain, replaced: boolean) => void }) {
  const { file } = props;
  const [conns, setConns] = useState<SavedConnection[] | null>(null);
  const [existing, setExisting] = useState<Chain | null>(null);
  const [taken, setTaken] = useState<string[]>([]);
  const [paths, setPaths] = useState<Map<string, string>>(new Map());
  const [mapping, setMapping] = useState<Record<string, string | undefined>>({});
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [cs, chains, lib, qs] = await Promise.all([listConnections(), allChains(), chainLibrary(), listAllQueries().catch(() => [] as NamedQuery[])]);
      setConns(cs);
      setMapping(guessConnections(file, cs));
      setExisting(chains.find((c) => c.name.trim().toLowerCase() === file.name.trim().toLowerCase()) ?? null);
      setTaken(chains.map((c) => c.name));
      setPaths(new Map(qs.map((q) => [lib.pathOf(q), q.id])));
    })();
  }, [file]);

  const aliases = Object.entries(file.connections ?? {});
  const unmapped = aliases.filter(([a]) => !mapping[a]).map(([a]) => a);
  const namedMissing = useMemo(() => file.steps.filter((s) => s.query && !paths.has(s.query) && !s.sql?.trim()).map((s) => s.name), [file, paths]);

  const save = async (replace: boolean) => {
    setError(null);
    try {
      let name = file.name.trim();
      if (!replace && existing) {
        for (let i = 2; ; i++) {
          const n = `${name} ${i}`;
          if (!taken.includes(n)) {
            name = n;
            break;
          }
        }
      }
      const c = workflowFromFile({ ...file, name }, mapping, { id: replace && existing ? existing.id : uid("ch_"), queryIdFor: (p) => paths.get(p) });
      props.onImported(await saveChain(c), replace);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (confirmReplace && existing) {
    return (
      <Modal
        title={`Replace "${existing.name}"?`}
        onClose={() => setConfirmReplace(false)}
        actions={
          <>
            {error && <span className="err">{error}</span>}
            <button className="btn" onClick={() => setConfirmReplace(false)}>
              Back
            </button>
            <button className="btn danger" autoFocus onClick={() => void save(true)}>
              Replace
            </button>
          </>
        }
      >
        <p>
          The workflow's {existing.steps.length} step{existing.steps.length === 1 ? "" : "s"} and variables are replaced by the {file.steps.length} in the file. Its link and tabs stay
          the same. This can't be undone.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      wide
      title={`Import workflow "${file.name}"`}
      onClose={props.onClose}
      actions={
        <>
          {error && <span className="err">{error}</span>}
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          {existing ? (
            <>
              <button className="btn" disabled={!conns} onClick={() => void save(false)}>
                Keep both
              </button>
              <button className="btn primary" disabled={!conns} onClick={() => setConfirmReplace(true)}>
                Replace existing…
              </button>
            </>
          ) : (
            <button className="btn primary" disabled={!conns} onClick={() => void save(false)}>
              Import
            </button>
          )}
        </>
      }
    >
      {file.description && <p className="wf-imp-desc">{file.description}</p>}
      {existing && (
        <p className="wf-imp-warn" role="status">
          A workflow named <b>{existing.name}</b> already exists. Replace it with this file, or keep both (the import gets a new name).
        </p>
      )}
      <ol className="wf-imp-steps" aria-label="Steps in the file">
        {file.steps.map((s) => (
          <li key={s.name}>
            <span className="mono">{s.name}</span> <small className="muted">{kindLabel(s.kind)}{s.connection ? ` · ${s.connection}` : ""}</small>
          </li>
        ))}
      </ol>
      {aliases.length > 0 && (
        <div className="wf-imp-conns">
          <b>Connections</b>
          <small className="muted">Pick the saved connection each name in the file stands for. You can change it per step later.</small>
          {aliases.map(([alias, want]) => {
            const same = (conns ?? []).filter((c) => c.driver === want.driver);
            return (
              <label key={alias} className="wf-imp-conn">
                <span>
                  <span className="mono">{alias}</span> <small className="muted">{ENGINE[want.driver]?.name ?? want.driver}{want.hint ? ` · ${want.hint}` : ""}</small>
                </span>
                <select className="input" aria-label={`Connection for ${alias}`} value={mapping[alias] ?? ""} onChange={(e) => setMapping((m) => ({ ...m, [alias]: e.target.value || undefined }))}>
                  <option value="">{same.length ? "Choose later" : `No ${ENGINE[want.driver]?.name ?? want.driver} connection saved`}</option>
                  {same.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
          {unmapped.length > 0 && <small className="muted">Steps on {unmapped.join(", ")} import without a connection; pick one in the step before running.</small>}
        </div>
      )}
      {namedMissing.length > 0 && <p className="err">Steps {namedMissing.join(", ")} use named queries that aren't saved here, and the file has no SQL for them.</p>}
    </Modal>
  );
}
