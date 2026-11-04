// Workflow editor and runner (DESIGN.md §3.15), at #workflow/<id> (#chain/<id> still works).
// The code calls workflows "chains"; every word the user sees says "workflow". A notebook-like list of steps,
// each with its own editor, status chip, rows, time and bytes. Clicking a step shows its
// rendered SQL, result preview, tests and log underneath.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Chain, ChainStep, ChainStepKind, NamedQuery, VarDef } from "../../collections/model";
import { listAllQueries, onCollectionsChanged } from "../../collections/store";
import { buildGraph, ChainGraphError, type ChainGraph } from "../../chains/graph";
import { cachedResult, clearCache, loadSavedResults, estimateChain, runChain, type ChainEstimate, type ChainEvent, type StepEvent } from "../../chains/runner";
import { appChainDeps, chainLibrary } from "../../chains/appDeps";
import type { ChainLibrary } from "../../chains/library";
import type { Destructive } from "../lib/safety";
import { listConnections, type SavedConnection } from "../lib/connections";
import { closeThisTab, navigate } from "../lib/route";
import { cellText, fmtBytes, fmtInt, fmtMs } from "../lib/format";
import { DataGrid, type GridCursor } from "../components/DataGrid";
import { SqlEditor } from "../components/SqlEditor";
import { Icon } from "../components/Icon";
import { ContextMenu, EngineBadge, Modal, TypedConfirm, useToast, type MenuItem } from "../components/ui";
import { kindLabel, loadChain, newStep, saveChain, STEP_KINDS } from "./chainStore";
import { downloadWorkflow } from "./WorkflowImport";
import { formatSetText, parseSetText } from "../../chains/setText";
import { installResultStore } from "../store/chainResults";

installResultStore();
import { splitStatementsRaw } from "../../collections/split";

type StepState = Partial<StepEvent> & { status?: StepEvent["status"] };

interface PendingConfirm {
  step: string;
  connection: string;
  statement: Destructive;
  resolve: (ok: boolean) => void;
}

export function ChainView({ chainId }: { chainId: string }) {
  const toast = useToast();
  const [chain, setChain] = useState<Chain | null | undefined>(undefined);
  const [lib, setLib] = useState<ChainLibrary | null>(null);
  const [queries, setQueries] = useState<NamedQuery[]>([]);
  const [conns, setConns] = useState<SavedConnection[]>([]);
  const [states, setStates] = useState<Record<string, StepState>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<{ est: ChainEstimate; blocked: boolean } | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [colVersion, setColVersion] = useState(0);
  const ac = useRef<AbortController | null>(null);
  const failedStep = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Load the workflow and the connection list.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const c = await loadChain(chainId).catch(() => undefined);
      if (cancelled) return;
      setChain(c ?? null);
      if (!c) return;
      document.title = c.name;
      const cs = await listConnections();
      if (cancelled) return;
      setConns(cs);
    })();
    return () => {
      cancelled = true;
      ac.current?.abort();
    };
  }, [chainId]);

  // Named queries from every collection; reloaded when a collection changes.
  useEffect(() => onCollectionsChanged(() => setColVersion((v) => v + 1)), []);
  useEffect(() => {
    let cancelled = false;
    void chainLibrary().then((l) => {
      if (cancelled) return;
      setLib(l);
    });
    void listAllQueries().then(
      (qs) => !cancelled && setQueries(qs),
      () => !cancelled && setQueries([]),
    );
    return () => {
      cancelled = true;
    };
  }, [colVersion]);

  // Show the results of earlier runs: this session's, or the ones saved before a reload.
  useEffect(() => {
    if (!chain) return;
    let cancelled = false;
    void loadSavedResults(chain.id).then(() => !cancelled && showCached());
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain?.id]);

  const showCached = () => {
    if (!chain) return;
    setStates((prev) => {
      const next = { ...prev };
      for (const s of chain.steps) {
        if (next[s.name]) continue;
        const c = cachedResult(chain.id, s.name);
        if (c) {
          next[s.name] = {
            status: "done",
            cached: true,
            rowCount: c.rowCount,
            ms: c.ms,
            bytesBilled: c.bytesBilled,
            renderedSql: c.renderedSql,
            columns: c.result?.columns,
            preview: c.result?.rows.slice(0, 200),
            tests: c.tests,
            logs: c.logs,
            ...(c.varChanges && Object.keys(c.varChanges).length ? { vars: c.varChanges } : {}),
          };
        }
      }
      return next;
    });
  };

  const update = useCallback((fn: (c: Chain) => Chain) => {
    setChain((c) => {
      if (!c) return c;
      const next = fn(c);
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void saveChain(next).catch((e) => toast(`Could not save: ${(e as Error).message}`)), 400);
      return next;
    });
  }, [toast]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const graph = useMemo((): { g?: ChainGraph; error?: string; errorStep?: string } => {
    if (!chain) return {};
    try {
      return {
        g: buildGraph(chain, {
          resolveSql: (s) => (s.queryId ? lib?.query(s.queryId)?.sql : undefined),
          isLibraryRef: (n) => lib?.templates.resolve(n) !== undefined,
        }),
      };
    } catch (e) {
      // A missing ref or a bad name belongs to one step: shown on its card, not above the steps.
      const errorStep = e instanceof ChainGraphError && (e.kind === "missing" || e.kind === "invalid" || e.kind === "duplicate") ? e.names[0] : undefined;
      return { error: e instanceof ChainGraphError ? e.message : String(e), errorStep };
    }
  }, [chain, lib]);

  const deps = useMemo(
    () =>
      lib
        ? appChainDeps(lib, {
            confirmDestructive: ({ step, connection, statement }) =>
              new Promise<boolean>((resolve) => setConfirm({ step, connection: connection.name, statement, resolve })),
          })
        : null,
    [lib],
  );

  const updateStep = (id: string, patch: Partial<ChainStep>) =>
    update((c) => ({ ...c, steps: c.steps.map((s) => (s.id === id ? clean({ ...s, ...patch }) : s)) }));

  const renameStep = (step: ChainStep, name: string) => {
    setStates((st) => {
      const { [step.name]: old, ...rest } = st;
      return old ? { ...rest, [name]: old } : rest;
    });
    if (selected === step.name) setSelected(name);
    updateStep(step.id, { name });
  };

  const addStep = (kind: ChainStepKind) => {
    update((c) => {
      const s = newStep(kind, c.steps, lib?.defaultConnectionId ?? conns.find((x) => x.group !== "Demo")?.id);
      setSelected(s.name);
      return { ...c, steps: [...c.steps, s] };
    });
  };

  const moveStep = (id: string, dir: -1 | 1) =>
    update((c) => {
      const i = c.steps.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= c.steps.length) return c;
      const steps = [...c.steps];
      [steps[i], steps[j]] = [steps[j]!, steps[i]!];
      return { ...c, steps };
    });

  // Deleting is immediate; Undo in the toast puts the step back where it was.
  const removeStep = (step: ChainStep) => {
    const at = chain!.steps.findIndex((s) => s.id === step.id);
    clearCache(chain!.id, step.name);
    update((c) => ({ ...c, steps: c.steps.filter((s) => s.id !== step.id) }));
    toast(`Deleted step "${step.name}"`, {
      label: "Undo",
      run: () => update((c) => (c.steps.some((s) => s.id === step.id) ? c : { ...c, steps: [...c.steps.slice(0, at), step, ...c.steps.slice(at)] })),
    });
  };

  const doRun = async (opts: { mode: "all" | "from" | "only"; step?: string; allowOverLimit?: boolean }) => {
    if (!chain || !deps || running) return;
    clearTimeout(saveTimer.current);
    await saveChain(chain).catch(() => undefined);
    const ctrl = new AbortController();
    ac.current = ctrl;
    setRunning(true);
    setRunError(null);
    setEstimate(null);
    failedStep.current = false;
    try {
      const gen = runChain(chain, { ...opts, signal: ctrl.signal, vars: varValues(chain.vars) }, deps);
      for (;;) {
        const n = await gen.next();
        if (n.done) {
          const s = n.value;
          if (opts.mode === "all") update((c) => ({ ...c, lastRun: { status: s.status, at: Date.now() } }));
          if (s.status === "blocked" && s.estimate) setEstimate({ est: s.estimate, blocked: true });
          // A failed step shows its error on its own card, and a blocked run shows the estimate
          // dialog: only an error that belongs to no step goes above the steps.
          if (s.status !== "done" && s.status !== "blocked" && !failedStep.current) setRunError(s.error ?? s.status);
          break;
        }
        onEvent(n.value);
      }
    } catch (e) {
      setRunError((e as Error).message);
    } finally {
      setRunning(false);
      ac.current = null;
    }
  };

  const onEvent = (e: ChainEvent) => {
    if (e.type !== "step") return;
    if (e.status === "failed") failedStep.current = true;
    setStates((st) => {
      if (e.status === "queued") return { ...st, [e.step]: { status: "queued" } };
      if (e.status === "running") return { ...st, [e.step]: { status: "running" } };
      return { ...st, [e.step]: { ...e } };
    });
  };

  // Run all: show the combined dry run first when any step can be estimated.
  const runAll = async () => {
    if (!chain || !deps) return;
    setEstimating(true);
    try {
      const est = await estimateChain(chain, deps, { vars: varValues(chain.vars) });
      if (est.steps.some((s) => s.bytes !== undefined)) {
        setEstimate({ est, blocked: est.overLimit.length > 0 });
        return;
      }
    } catch (e) {
      setRunError((e as Error).message);
      return;
    } finally {
      setEstimating(false);
    }
    void doRun({ mode: "all" });
  };

  if (chain === undefined) return <div className="empty">Loading workflow…</div>;
  if (chain === null) {
    return (
      <div className="chain-page">
        <div className="empty">
          This workflow doesn't exist any more.{" "}
          <button className="btn" onClick={closeThisTab}>
            Close tab
          </button>
        </div>
      </div>
    );
  }

  const total = Object.values(states).reduce((a, s) => a + (s.bytesBilled ?? 0), 0);

  return (
    <div className="chain-page">
      <header className="topbar chain-top">
        <span className="wf-label">Workflow</span>
        <input className="input chain-name" value={chain.name} title={chain.name} aria-label="Workflow name" onChange={(e) => update((c) => ({ ...c, name: e.target.value }))} />
        {running ? (
          <button className="btn warn" onClick={() => ac.current?.abort()}>
            Stop
          </button>
        ) : (
          <button className="btn primary" disabled={!deps || !chain.steps.length || !!graph.error || estimating} onClick={() => void runAll()}>
            {estimating ? "Estimating…" : "Run all"}
          </button>
        )}
        <button
          className="btn"
          disabled={running}
          title="Forget every step's saved result, so the next run re-runs every step"
          onClick={() => {
            clearCache(chain.id);
            setStates({});
            toast("Results cleared");
          }}
        >
          Clear result
        </button>
        <button className="btn" title="Save this workflow as a .dbui-workflow.json file" onClick={() => void downloadWorkflow(chain).catch((e) => toast((e as Error).message))}>
          Export file
        </button>
      </header>
      <Description className="chain-desc" lines={8} label="Workflow description" placeholder="Add a description" value={chain.description} onChange={(d) => update((c) => ({ ...c, description: d || undefined }))} />

      <div className="chain-body">
        <div className="chain-steps">
          {graph.error && !(graph.errorStep && chain.steps.some((x) => x.name === graph.errorStep)) && <div className="err">{graph.error}</div>}
          {runError && <div className="err">{runError}</div>}
          {chain.steps.length === 0 && <div className="empty">No steps yet. Add a Query step to start.</div>}
          {chain.steps.map((s, i) => (
            <StepCard
              key={s.id}
              step={s}
              index={i}
              count={chain.steps.length}
              state={states[s.name]}
              inputs={graph.g?.inputs.get(s.name) ?? []}
              selected={selected === s.name}
              running={running}
              queries={queries}
              lib={lib}
              conns={conns}
              earlier={chain.steps.slice(0, i).map((x) => ({ name: x.name, columns: (states[x.name]?.columns ?? []).map((c) => c.name) }))}
              onSelect={() => setSelected(s.name)}
              onChange={(patch) => updateStep(s.id, patch)}
              onRename={(n) => renameStep(s, n)}
              onMove={(d) => moveStep(s.id, d)}
              onDelete={() => removeStep(s)}
              onRunFrom={() => void doRun({ mode: "from", step: s.name })}
              onRunOnly={() => void doRun({ mode: "only", step: s.name })}
              canRun={!!deps && !graph.error}
              graphError={graph.errorStep === s.name ? graph.error : undefined}
            />
          ))}
          <div className="chain-add">
            <span className="muted">Add step:</span>
            {STEP_KINDS.map((k) => (
              <button key={k.kind} className="btn" title={k.hint} onClick={() => addStep(k.kind)}>
                <Icon name="plus" /> {k.label}
              </button>
            ))}
          </div>
          {total > 0 && <div className="muted chain-total">Billed this run: {fmtBytes(total)}</div>}
        </div>
      </div>

      {estimate && (
        <EstimateModal
          est={estimate.est}
          blocked={estimate.blocked}
          onClose={() => setEstimate(null)}
          onRun={(allow) => {
            setEstimate(null);
            void doRun({ mode: "all", allowOverLimit: allow });
          }}
        />
      )}
      {confirm && (
        <TypedConfirm
          title="Destructive statement on production"
          message={
            <>
              Step <b>{confirm.step}</b> runs <code>{confirm.statement.kind.replace("_", " ")}</code> on <b className="mono">{confirm.statement.target}</b> in{" "}
              <b>{confirm.connection}</b>.
            </>
          }
          expected={confirm.statement.target}
          confirmLabel="Run on production"
          onCancel={() => {
            confirm.resolve(false);
            setConfirm(null);
          }}
          onConfirm={() => {
            confirm.resolve(true);
            setConfirm(null);
          }}
        />
      )}
    </div>
  );
}

/** Drops empty optional fields so the stored step stays small. */
function clean(s: ChainStep): ChainStep {
  const out = { ...s } as Record<string, unknown>;
  for (const [k, v] of Object.entries(out)) if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) delete out[k];
  return out as unknown as ChainStep;
}

function varValues(vars: VarDef[]): Record<string, unknown> {
  return Object.fromEntries(vars.filter((v) => v.value !== undefined).map((v) => [v.name, v.value]));
}

const showValue = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

// ---------------------------------------------------------------------------------------

function StatusChip({ state }: { state?: StepState }) {
  const s = state?.status;
  if (!s) return <span className="chip-status idle">not run</span>;
  const label = s === "done" && state?.cached ? "cached" : s === "done" && state?.inlinedInto ? "inlined" : s;
  return <span className={`chip-status ${s}`}>{label}</span>;
}

/** Steps whose result is a table later steps read with ref("name"); only these show their name. */
const NAMED_KINDS: ChainStepKind[] = ["query", "transform-sql", "transform-script"];
const KIND_TAG: Record<ChainStepKind, string> = {
  query: "Query",
  "transform-sql": "DuckDB",
  "transform-script": "JavaScript",
  "set-vars": "Set variables",
  assert: "Assert",
  export: "Export",
};

function StepCard(props: {
  step: ChainStep;
  index: number;
  count: number;
  state?: StepState;
  inputs: string[];
  selected: boolean;
  running: boolean;
  canRun: boolean;
  queries: NamedQuery[];
  lib: ChainLibrary | null;
  conns: SavedConnection[];
  /** Steps above this one, with their columns from the last run, for pickers. */
  earlier: { name: string; columns: string[] }[];
  onSelect: () => void;
  onChange: (patch: Partial<ChainStep>) => void;
  onRename: (name: string) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
  onRunFrom: () => void;
  onRunOnly: () => void;
  /** This step's part in a workflow-wide problem (a ref to a step that doesn't exist …). */
  graphError?: string;
}) {
  const { step, state } = props;
  const [name, setName] = useState(step.name);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [editingDesc, setEditingDesc] = useState(false);
  useEffect(() => setName(step.name), [step.name]);
  const named = NAMED_KINDS.includes(step.kind);
  const q = step.kind === "query" && step.queryId ? props.queries.find((x) => x.id === step.queryId) : undefined;
  const connId = step.kind === "query" ? (step.connectionId ?? q?.connectionId ?? props.lib?.defaultConnectionId) : undefined;
  const conn = connId ? props.conns.find((c) => c.id === connId) : undefined;
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  const items: MenuItem[] = [
    { label: "Run from here", hint: "and the steps after it", disabled: props.running || !props.canRun, onClick: props.onRunFrom },
    { label: "Run only this step", hint: "inputs from the cache", disabled: props.running || !props.canRun, onClick: props.onRunOnly },
    { separator: true, label: "" },
    { label: step.description ? "Edit description" : "Add description", onClick: () => setEditingDesc(true) },
    { separator: true, label: "" },
    { label: "Move up", disabled: props.index === 0, onClick: () => props.onMove(-1) },
    { label: "Move down", disabled: props.index === props.count - 1, onClick: () => props.onMove(1) },
    { separator: true, label: "" },
    { label: "Delete step", onClick: props.onDelete },
  ];
  return (
    <section
      className={`chain-step k-${step.kind}` + (props.selected ? " sel" : "") + (state?.status ? ` st-${state.status}` : "")}
      onClick={props.onSelect}
      aria-label={`Step ${props.index + 1}: ${kindLabel(step.kind)}${named ? ` ${step.name}` : ""}`}
    >
      <div className="cs-head">
        <span className="cs-idx">{props.index + 1}</span>
        <span className="cs-kind" title={kindLabel(step.kind)}>
          {KIND_TAG[step.kind]}
        </span>
        {step.kind === "query" && (
          <span className="cs-conn" title={conn ? `Runs on ${conn.name}` : "Pick a connection below"}>
            {conn ? (
              <>
                <EngineBadge driver={conn.driver} />
                <b>{conn.name}</b>
                {conn.env === "production" && <span className="cs-env">production</span>}
                {conn.readOnly && <span className="faint">read-only</span>}
              </>
            ) : (
              <span className="err-text">No connection</span>
            )}
          </span>
        )}
        {(step.kind === "transform-sql" || step.kind === "transform-script") && <span className="cs-conn faint">on this machine</span>}
        <span className="spacer" />
        <span className="cs-stats muted">
          {state?.status === "running" && <span className="live" />}
          {state?.rowCount !== undefined && step.kind !== "assert" && step.kind !== "set-vars" && `${fmtInt(state.rowCount)} row${state.rowCount === 1 ? "" : "s"}`}
          {step.kind === "set-vars" && state?.vars && `${Object.keys(state.vars).length} set`}
          {step.kind === "assert" && state?.status === "done" && "passed"}
          {state?.ms !== undefined && `${step.kind === "export" && state.rowCount === undefined ? "" : " · "}${fmtMs(state.ms)}`}
          {state?.bytesBilled !== undefined && ` · ${fmtBytes(state.bytesBilled)}`}
        </span>
        <StatusChip state={state} />
        <span className="cs-acts">
          <button className="btn icon ghost" disabled={props.running || !props.canRun} aria-label="Run only this step" title="Run only this step (earlier results from the cache). Run from here is in the ⋯ menu." onClick={stop(props.onRunOnly)}>
            <Icon name="play" />
          </button>
          <button
            className="btn icon ghost"
            aria-label="Step actions"
            title="Run from here, move, delete"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.right - 220, y: r.bottom + 4 });
            }}
          >
            <Icon name="more" />
          </button>
        </span>
      </div>
      {(step.description || editingDesc) && (
        <Description
          key={editingDesc ? "editing" : "shown"}
          className="cs-desc"
          label="Step description"
          placeholder="What this step is for"
          value={step.description}
          startEditing={editingDesc}
          editButton={false}
          onDone={() => setEditingDesc(false)}
          onChange={(d) => props.onChange({ description: d || undefined })}
        />
      )}
      <StepEditor step={step} queries={props.queries} lib={props.lib} conns={props.conns} earlier={props.earlier} onChange={props.onChange} />
      {props.graphError && <div className="err">{props.graphError}. Nothing runs until it's fixed.</div>}
      {state?.error && <div className="err">{state.error}</div>}
      <div className="cs-foot muted">
        {named && (
          <label className="cs-out" onClick={(e) => e.stopPropagation()}>
            Result table
            <input
              className="input mono cs-name"
              value={name}
              aria-label="Step name"
              title={`Later steps read this result as {{ ref("${step.name}") }}`}
              onChange={(e) => setName(e.target.value.replace(/[^\w]/g, "_"))}
              onBlur={() => (name && name !== step.name ? props.onRename(name) : setName(step.name))}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
            <code>{`{{ ref("${step.name}") }}`}</code>
          </label>
        )}
        {props.inputs.length > 0 && (
          <span>
            uses {props.inputs.map((i) => <code key={i}>{i}</code>)}
          </span>
        )}
        {state?.inlinedInto && <span>inlined as a CTE into {state.inlinedInto.join(", ")}</span>}
        {state?.reason && <span>{state.reason}</span>}
      </div>
      <StepOutput step={step} state={state} />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </section>
  );
}

/**
 * A workflow's or step's description. **Edit** turns it into a text box with **Save** and
 * **Cancel** (⌘↵ saves, Esc cancels); clicking the text does nothing. Text taller than 3 lines
 * is cut to 3 with **Show more**, which only appears when something is actually cut.
 */
function Description(props: {
  className: string;
  label: string;
  placeholder: string;
  value?: string;
  startEditing?: boolean;
  /** Lines shown before "Show more". */
  lines?: number;
  /** false: no Edit button here (a step edits its description from its ⋯ menu). */
  editButton?: boolean;
  /** Called when editing ends, saved or cancelled. */
  onDone?: () => void;
  onChange: (v: string) => void;
}) {
  const value = props.value ?? "";
  const [editing, setEditing] = useState(!!props.startEditing);
  const [draft, setDraft] = useState(value);
  const [expanded, setExpanded] = useState(false);
  const [cut, setCut] = useState(false);
  const text = useRef<HTMLParagraphElement>(null);

  // Is the folded text cut off? Measured, so short text never shows "Show more".
  useLayoutEffect(() => {
    const el = text.current;
    if (!el || expanded) return;
    const check = () => setCut(el.scrollHeight > el.clientHeight + 1);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [value, expanded, editing]);

  const edit = () => {
    setDraft(value);
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    props.onDone?.();
  };
  const save = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== value.trim()) props.onChange(next);
    props.onDone?.();
  };

  if (editing) {
    return (
      <div className={`desc-editing ${props.className}-editing`} onClick={(e) => e.stopPropagation()}>
        <textarea
          className="input desc-edit"
          aria-label={props.label}
          placeholder={props.placeholder}
          autoFocus
          value={draft}
          rows={Math.min(16, Math.max(3, draft.split("\n").length + 1))}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") cancel();
            else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          }}
        />
        <span className="desc-acts">
          <button className="btn primary" onClick={save}>
            Save
          </button>
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
          <span className="faint">⌘↵ saves · Esc cancels</span>
        </span>
      </div>
    );
  }
  if (!value) {
    return (
      <button className={`btn ghost desc-add ${props.className}-add`} onClick={(e) => (e.stopPropagation(), edit())}>
        <Icon name="edit" /> {props.placeholder}
      </button>
    );
  }
  return (
    <div className={`desc ${props.className}` + (!expanded ? " folded" : "")} style={{ ["--desc-lines" as string]: props.lines ?? 3 }}>
      <p ref={text} className="muted">
        {value}
      </p>
      <span className="desc-acts">
        {(cut || expanded) && (
          <button className="btn ghost small" onClick={(e) => (e.stopPropagation(), setExpanded(!expanded))}>
            <Icon name={expanded ? "chevron-down" : "chevron-right"} /> {expanded ? "Show less" : "Show more"}
          </button>
        )}
        {props.editButton !== false && (
          <button className="btn ghost small" aria-label={`Edit ${props.label.toLowerCase()}`} onClick={(e) => (e.stopPropagation(), edit())}>
            <Icon name="edit" /> Edit
          </button>
        )}
      </span>
    </div>
  );
}

function StepEditor({ step, queries, lib, conns, earlier, onChange }: { step: ChainStep; queries: NamedQuery[]; lib: ChainLibrary | null; conns: SavedConnection[]; earlier: { name: string; columns: string[] }[]; onChange: (p: Partial<ChainStep>) => void }) {
  switch (step.kind) {
    case "query": {
      const q = step.queryId ? queries.find((x) => x.id === step.queryId) : undefined;
      return (
        <div className="cs-editor">
          <div className="cs-row">
            {/* Only when there are saved queries to pick from: otherwise the SQL below is all there is. */}
            {(queries.length > 0 || step.queryId) && (
            <label title="Run a saved query from your collections instead of the SQL written in this step">
              Saved query{" "}
              <select className="input" aria-label="Saved query" value={step.queryId ?? ""} onChange={(e) => onChange({ queryId: e.target.value || undefined })}>
                <option value="">None: SQL written below</option>
                {queries.map((x) => (
                  <option key={x.id} value={x.id}>
                    {lib?.pathOf(x) ?? x.name}
                  </option>
                ))}
              </select>
            </label>
            )}
            <label>
              Connection{" "}
              <select className="input" value={step.connectionId ?? ""} onChange={(e) => onChange({ connectionId: e.target.value || undefined })}>
                <option value="">{q?.connectionId ? "The query's connection" : "Collection default"}</option>
                {conns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.readOnly ? " (read-only)" : ""}
                    {c.env === "production" ? " · production" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {q ? (
            <>
              <pre className="cs-sql-ro mono">{q.sql}</pre>
              {splitStatementsRaw(q.sql).length > 1 && (
                <small className="muted">This query has {splitStatementsRaw(q.sql).length} statements: the earlier ones run first as setup, and the last one's result is this step's output.</small>
              )}
            </>
          ) : (
            <SqlEditor className="cs-sql" value={step.sql ?? ""} onChange={(sql) => onChange({ sql })} placeholder={`SELECT … FROM {{ ref("earlier_step") }} WHERE id IN {{ ids | sql_list }}`} aria-label="Step SQL" />
          )}
        </div>
      );
    }
    case "transform-sql":
      return (
        <div className="cs-editor">
          <SqlEditor className="cs-sql" value={step.sql ?? ""} onChange={(sql) => onChange({ sql })} placeholder={`SELECT … FROM {{ ref("a") }} JOIN {{ ref("b") }} USING (id)`} aria-label="Transform SQL" />
          <small className="muted">
            DuckDB SQL over earlier results: <code>{'{{ ref("step") }}'}</code> is that step's result table.
          </small>
          {earlier.some((x) => x.columns.length) && (
            <div className="cs-cols">
              {earlier
                .filter((x) => x.columns.length)
                .map((x) => (
                  <div key={x.name}>
                    <code>{x.name}</code>: {x.columns.map((c) => <span key={c} className="mono">{c}</span>)}
                  </div>
                ))}
            </div>
          )}
        </div>
      );
    case "transform-script":
      return (
        <div className="cs-editor">
          <textarea
            className="input mono cs-script"
            spellCheck={false}
            value={step.script ?? ""}
            onChange={(e) => onChange({ script: e.target.value })}
            placeholder={"// (inputs, vars, db) => rows | { rows, vars }\nreturn inputs.top_ads.rows.filter((r) => r.revenue > 100);"}
            aria-label="Transform script"
          />
          <small className="muted">
            Body of <code>(inputs, vars, db)</code>. <code>inputs.step</code> has <code>columns</code> (names), <code>rows</code> (objects), <code>rowCount</code>, <code>column(name)</code>. Return rows, or{" "}
            <code>{"{ rows, vars }"}</code>.
          </small>
        </div>
      );
    case "set-vars":
      return <SetVarsEditor value={step.assignments ?? {}} onChange={(assignments) => onChange({ assignments })} />;
    case "export": {
      const fmt = step.format ?? "csv";
      const source = (step.sql ?? "").trim();
      return (
        <div className="cs-editor">
          <div className="cs-row">
            <label>
              Save as{" "}
              <select className="input" value={fmt} onChange={(e) => onChange({ format: e.target.value as ChainStep["format"] })}>
                <option value="csv">CSV</option>
                <option value="jsonl">JSON Lines</option>
                <option value="parquet">Parquet</option>
              </select>
            </label>
            <label>
              Step{" "}
              <select
                className="input"
                value={/^SELECT \* FROM \{\{ ref\("(\w+)"\) \}\}$/.exec(source)?.[1] ?? (source ? "__sql" : "")}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "__sql") onChange({ sql: source && !/^SELECT \* FROM \{\{ ref/.test(source) ? source : `SELECT *\nFROM {{ ref("${earlier.at(-1)?.name ?? "step"}") }}` });
                  else onChange({ sql: v ? `SELECT * FROM {{ ref("${v}") }}` : undefined });
                }}
              >
                {earlier.length === 0 && <option value="">(add a step above first)</option>}
                {earlier.map((x) => (
                  <option key={x.name} value={x.name}>
                    {x.name}
                  </option>
                ))}
                <option value="__sql">DuckDB query…</option>
              </select>
            </label>
          </div>
          {source && !/^SELECT \* FROM \{\{ ref\("\w+"\) \}\}$/.test(source) && (
            <SqlEditor className="cs-sql short" value={step.sql ?? ""} onChange={(sql) => onChange({ sql })} placeholder={`SELECT * FROM {{ ref("report") }} WHERE …`} aria-label="Export query" />
          )}
          <small className="muted">
            Writes the step's result to a file with DuckDB's <code>COPY … TO</code> ({fmt === "csv" ? "with a header row" : fmt === "jsonl" ? "one JSON object per line" : "columnar, compressed"}), on this machine. Chrome asks where to save it. Pick <i>DuckDB query…</i> to
            filter or reshape first.
          </small>
        </div>
      );
    }
    case "assert":
      return (
        <div className="cs-editor">
          <input
            className="input mono"
            value={step.condition ?? ""}
            onChange={(e) => onChange({ condition: e.target.value })}
            placeholder={`count("sales") > 0 && nulls("sales", "ad_id") == 0`}
            aria-label="Assert condition"
          />
          <small className="muted">
            Functions: <code>count</code>, <code>nulls</code>, <code>column</code>, <code>first</code>, <code>max</code>, <code>min</code>, <code>sum</code>, <code>avg</code>, <code>len</code>; operators{" "}
            <code>{"== != > >= < <= && || !"}</code>.
          </small>
        </div>
      );
  }
}

/**
 * Set variables as text: one `SET name = value` per variable, in one box. A value is a literal
 * ("Acme", 7, [1, 2]), a function over an earlier result (first("step", "col") …), or a DuckDB
 * subquery over earlier results in parentheses. Saved as the step's assignments while the text
 * parses; otherwise the box keeps your text and shows what's wrong.
 */
function SetVarsEditor({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const [text, setText] = useState(() => formatSetText(value));
  const [error, setError] = useState<{ line: number; message: string } | undefined>();
  const mine = useRef(value);
  // Reload the text when the assignments change from outside (undo, import), not from typing here.
  useEffect(() => {
    if (value === mine.current) return;
    mine.current = value;
    setText(formatSetText(value));
    setError(undefined);
  }, [value]);
  const lines = Math.max(1, text.split("\n").length);
  return (
    <div className="cs-editor cs-set">
      <div className="cs-set-wrap" style={{ height: Math.min(320, 18 + lines * 21) }}>
      <SqlEditor
        className="cs-sql cs-set-box"
        value={text}
        aria-label="Set variables"
        placeholder={'SET client_name = "Acme"\nSET since = \'2026-10-14\'\nSET ids = (SELECT list(DISTINCT id) FROM {{ ref("clients") }})'}
        onChange={(t) => {
          setText(t);
          const p = parseSetText(t);
          setError(p.error);
          if (!p.error) {
            mine.current = p.assignments;
            onChange(p.assignments);
          }
        }}
      />
      </div>
      {error ? (
        <small className="err-text">
          Line {error.line}: {error.message}. Not saved until it's fixed.
        </small>
      ) : (
        <small className="faint">
          <code>SET name = value</code>, one per line. A value is text in quotes, a number, a <code>[list]</code>, or DuckDB SQL in parentheses over earlier results that returns one
          row and one column: <code>{'(SELECT max(day) FROM {{ ref("runs") }})'}</code>, or a list with <code>{'(SELECT list(id) FROM {{ ref("clients") }})'}</code>. Use it as{" "}
          <code>{"{{ name | sql }}"}</code>, a list as <code>{"{{ name | sql_list }}"}</code>.
        </small>
      )}
    </div>
  );
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Height of a result grid inside a step card: its rows, up to about 12 of them, then it scrolls. */
const GRID_MAX_H = 34 + 12 * 32 + 14;
const gridHeight = (rows: number) => Math.min(GRID_MAX_H, 34 + Math.max(rows, 1) * 32 + 14);

const kindOf = (v: unknown): string =>
  Array.isArray(v) ? `list · ${fmtInt(v.length)}` : v === null || v === undefined ? "null" : typeof v === "string" ? "text" : typeof v === "object" ? "object" : typeof v;

/**
 * Set variables' output: a foldable Preview of each value it set (name, kind, value), no tabs.
 * A long value shows its start; "more" shows all of it.
 */
function VarsPreview({ state, open, setOpen }: { state: StepState; open: boolean; setOpen: (o: boolean) => void }) {
  const [full, setFull] = useState<Set<string>>(new Set());
  const vars = state.vars ?? {};
  const names = Object.keys(vars);
  return (
    <div className={"cs-out-panel vars-preview" + (open ? " open" : "")} onClick={(e) => e.stopPropagation()}>
      <div className="cd-head">
        <button className="btn ghost small cd-fold" aria-expanded={open} aria-label={open ? "Fold the preview" : "Show the preview"} onClick={() => setOpen(!open)}>
          <Icon name={open ? "chevron-down" : "chevron-right"} /> Preview
        </button>
        <span className="muted cd-count">
          {names.length} variable{names.length === 1 ? "" : "s"}
          {state.cached ? " · cached" : ""}
        </span>
      </div>
      {open && (
        <div className="vp-rows">
          {state.status === "running" && !names.length && <div className="empty">Running…</div>}
          {state.status === "done" && !names.length && <div className="empty">Nothing set.</div>}
          {names.map((k) => {
            const text = showValue(vars[k]);
            const long = text.length > 160;
            const shown = full.has(k) || !long ? text : text.slice(0, 159) + "…";
            return (
              <div key={k} className="vp-row">
                <code className="vp-name">{k}</code>
                <span className="faint vp-kind">{kindOf(vars[k])}</span>
                <span className="mono vp-val">
                  {shown}
                  {long && (
                    <button className="link" onClick={() => setFull((f) => (f.has(k) ? new Set([...f].filter((x) => x !== k)) : new Set(f).add(k)))}>
                      {full.has(k) ? " less" : " more"}
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * A step's result, rendered SQL and tests & log, under the step in its card. Folds away with the
 * header button; shown once the step has run (or is running).
 */
function StepOutput({ step, state }: { step: ChainStep; state?: StepState }) {
  const [tab, setTab] = useState<"result" | "sql" | "tests">("result");
  // Folded when the workflow opens (results from earlier runs); opens when the step runs now.
  const [open, setOpen] = useState(false);
  const status = state?.status;
  useEffect(() => {
    if (status === "running") setOpen(true);
  }, [status]);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState<GridCursor | null>(null);
  // Assert makes no table: its pass/fail shows in its header and error.
  if (!state || state.status === "queued" || step.kind === "assert") return null;
  if (step.kind === "set-vars") return <VarsPreview state={state} open={open} setOpen={setOpen} />;
  const rows = state.preview ?? [];
  const cols = state.columns ?? [];
  const nTests = (state.tests?.length ?? 0) + (state.logs?.length ?? 0);
  const pick = (t: typeof tab) => {
    setTab(t);
    setOpen(true);
  };
  return (
    <div className={"cs-out-panel" + (open ? " open" : "")} onClick={(e) => e.stopPropagation()}>
      <div className="cd-head">
        <button
          className="btn icon ghost cd-fold"
          aria-expanded={open}
          aria-label={open ? "Fold the result" : "Show the result"}
          title={open ? "Fold" : "Show"}
          onClick={() => setOpen(!open)}
        >
          <Icon name={open ? "chevron-down" : "chevron-right"} />
        </button>
        <div className="seg" role="group" aria-label="Step output">
          <button aria-pressed={open && tab === "result"} onClick={() => pick("result")}>
            Result
          </button>
          <button aria-pressed={open && tab === "sql"} onClick={() => pick("sql")}>
            Rendered SQL
          </button>
          <button aria-pressed={open && tab === "tests"} onClick={() => pick("tests")}>
            Tests & log{nTests ? ` (${nTests})` : ""}
          </button>
        </div>
        {state.rowCount !== undefined &&
          (open && rows.length < state.rowCount ? (
            <span className="muted">first {fmtInt(rows.length)} of {fmtInt(state.rowCount)}</span>
          ) : (
            <span className="muted cd-count">
              {fmtInt(state.rowCount)} row{state.rowCount === 1 ? "" : "s"}
              {state.cached ? " · cached" : ""}
            </span>
          ))}
      </div>
      {open && tab === "result" &&
        (state.vars ? (
          <div className="cd-vars">
            {Object.entries(state.vars).map(([k, v]) => (
              <div key={k}>
                <code>{k}</code> = <span className="mono">{truncate(showValue(v), 400)}</span>
                {Array.isArray(v) && <span className="muted"> ({fmtInt(v.length)} values)</span>}
              </div>
            ))}
          </div>
        ) : cols.length ? (
          <div className="cd-grid" style={{ height: gridHeight(rows.length) }}>
            <DataGrid
              columns={cols}
              rowCount={rows.length}
              value={(r, c) => rows[r]?.[c] ?? null}
              selection={selection}
              cursor={cursor}
              onSelection={(s, c) => {
                setSelection(s);
                setCursor(c);
              }}
              onCopy={(sel) => void navigator.clipboard.writeText((sel.length ? sel : cursor ? [cursor.row] : []).map((r) => (rows[r] ?? []).map(cellText).join("\t")).join("\n"))}
              resetKey={`${step.name}:${state.ms ?? ""}:${state.status ?? ""}`}
            />
          </div>
        ) : (
          <div className="empty">{state.file ? `Exported ${state.file}` : state.status === "running" ? "Running…" : state.status === "done" ? "No result table." : "No result."}</div>
        ))}
      {open && tab === "sql" && (state.renderedSql ? <pre className="cd-sql mono">{state.renderedSql}</pre> : <div className="empty">Rendered SQL appears after the step runs.</div>)}
      {open && tab === "tests" && (
        <div className="cd-tests">
          {!nTests && <div className="empty">No tests or log output.</div>}
          {state.tests?.map((t, i) => (
            <div key={i} className={t.passed ? "pass" : "fail"}>
              {t.passed ? "✓" : "✗"} {t.name}
            </div>
          ))}
          {state.logs?.map((l, i) => (
            <pre key={i} className="mono">
              {l}
            </pre>
          ))}
        </div>
      )}
    </div>
  );
}

function EstimateModal({ est, blocked, onClose, onRun }: { est: ChainEstimate; blocked: boolean; onClose: () => void; onRun: (allowOverLimit: boolean) => void }) {
  return (
    <Modal
      title="Combined dry run"
      onClose={onClose}
      wide
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {blocked ? (
            <button className="btn warn" onClick={() => onRun(true)}>
              Run anyway
            </button>
          ) : (
            <button className="btn primary" autoFocus onClick={() => onRun(false)}>
              Run all
            </button>
          )}
        </>
      }
    >
      <table className="chain-est">
        <thead>
          <tr>
            <th>Step</th>
            <th>Will scan</th>
            <th>Cost guard</th>
          </tr>
        </thead>
        <tbody>
          {est.steps.map((s) => (
            <tr key={s.step} className={s.overLimit ? "over" : undefined}>
              <td className="mono">{s.step}</td>
              <td>{s.bytes !== undefined ? fmtBytes(s.bytes) : <span className="muted">{s.note ?? "—"}</span>}</td>
              <td>{s.limit !== undefined ? fmtBytes(s.limit) : ""}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td>
              <b>{fmtBytes(est.totalBytes)}</b>
              {est.totalUsd !== undefined && ` · ~$${est.totalUsd.toFixed(2)}`}
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
      {blocked && <p className="err">Over the connection's cost guard: {est.overLimit.join(", ")}. The run stops unless you run anyway.</p>}
    </Modal>
  );
}
