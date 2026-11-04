// Workflow editor and runner (DESIGN.md §3.15), at #workflow/<id> (#chain/<id> still works).
// The code calls workflows "chains"; every word the user sees says "workflow". A notebook-like list of steps,
// each with its own editor, status chip, rows, time and bytes. Clicking a step shows its
// rendered SQL, result preview, tests and log underneath.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Chain, ChainStep, ChainStepKind, NamedQuery, VarDef } from "../../collections/model";
import { listAllQueries, onCollectionsChanged } from "../../collections/store";
import { buildGraph, ChainGraphError, type ChainGraph } from "../../chains/graph";
import { cachedResult, clearCache, estimateChain, runChain, type ChainEstimate, type ChainEvent, type StepEvent } from "../../chains/runner";
import { appChainDeps, chainLibrary } from "../../chains/appDeps";
import type { ChainLibrary } from "../../chains/library";
import type { Destructive } from "../lib/safety";
import { listConnections, type SavedConnection } from "../lib/connections";
import { closeThisTab, navigate } from "../lib/route";
import { cellText, fmtBytes, fmtInt, fmtMs } from "../lib/format";
import { DataGrid, type GridCursor } from "../components/DataGrid";
import { SqlEditor } from "../components/SqlEditor";
import { Icon } from "../components/Icon";
import { Modal, TypedConfirm, useToast } from "../components/ui";
import { kindLabel, loadChain, newStep, saveChain, STEP_KINDS } from "./chainStore";
import { downloadWorkflow } from "./WorkflowImport";
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
  const [runVars, setRunVars] = useState<Record<string, unknown> | null>(null);
  const [estimate, setEstimate] = useState<{ est: ChainEstimate; blocked: boolean } | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [colVersion, setColVersion] = useState(0);
  const ac = useRef<AbortController | null>(null);
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

  // Show cached results from earlier runs this session.
  useEffect(() => {
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
          };
        }
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain?.id]);

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

  const graph = useMemo((): { g?: ChainGraph; error?: string } => {
    if (!chain) return {};
    try {
      return {
        g: buildGraph(chain, {
          resolveSql: (s) => (s.queryId ? lib?.query(s.queryId)?.sql : undefined),
          isLibraryRef: (n) => lib?.templates.resolve(n) !== undefined,
        }),
      };
    } catch (e) {
      return { error: e instanceof ChainGraphError ? e.message : String(e) };
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
    try {
      const gen = runChain(chain, { ...opts, signal: ctrl.signal, vars: varValues(chain.vars) }, deps);
      for (;;) {
        const n = await gen.next();
        if (n.done) {
          const s = n.value;
          setRunVars(s.vars);
          if (opts.mode === "all") update((c) => ({ ...c, lastRun: { status: s.status, at: Date.now() } }));
          if (s.status === "blocked" && s.estimate) setEstimate({ est: s.estimate, blocked: true });
          if (s.status !== "done") setRunError(s.error ?? s.status);
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

  const sel = chain.steps.find((s) => s.name === selected);
  const selState = sel ? states[sel.name] : undefined;
  const total = Object.values(states).reduce((a, s) => a + (s.bytesBilled ?? 0), 0);

  return (
    <div className="chain-page">
      <header className="topbar chain-top">
        <span className="wf-label">Workflow</span>
        <input className="input chain-name" value={chain.name} aria-label="Workflow name" onChange={(e) => update((c) => ({ ...c, name: e.target.value }))} />
        <span className="spacer" />
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
          title="Forget cached step results, so the next run re-runs every step"
          onClick={() => {
            clearCache(chain.id);
            setStates({});
            toast("Cache cleared");
          }}
        >
          Clear cache
        </button>
        <button className="btn" title="Save this workflow as a .dbui-workflow.json file" onClick={() => void downloadWorkflow(chain).catch((e) => toast((e as Error).message))}>
          Export file
        </button>
      </header>
      {chain.description && <p className="chain-desc muted">{chain.description}</p>}

      <div className="chain-body">
        <div className="chain-steps">
          {graph.error && <div className="err">{graph.error}</div>}
          {runError && <div className="err">{runError}</div>}
          <VarsEditor vars={chain.vars} runVars={runVars} onChange={(vars) => update((c) => ({ ...c, vars }))} />
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

        <StepDetail step={sel} state={selState} />
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

/** What the user typed → a value: JSON when it parses (numbers, lists, objects), else the text. */
function parseValue(text: string): unknown {
  const t = text.trim();
  if (t === "") return "";
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}

const showValue = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

// ---------------------------------------------------------------------------------------

function StatusChip({ state }: { state?: StepState }) {
  const s = state?.status;
  if (!s) return <span className="chip-status idle">not run</span>;
  const label = s === "done" && state?.cached ? "cached" : s === "done" && state?.inlinedInto ? "inlined" : s;
  return <span className={`chip-status ${s}`}>{label}</span>;
}

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
}) {
  const { step, state } = props;
  const [name, setName] = useState(step.name);
  useEffect(() => setName(step.name), [step.name]);
  return (
    <section className={"chain-step" + (props.selected ? " sel" : "") + (state?.status ? ` st-${state.status}` : "")} onClick={props.onSelect}>
      <div className="cs-head">
        <span className="cs-idx">{props.index + 1}</span>
        <input
          className="input mono cs-name"
          value={name}
          aria-label="Step name"
          onChange={(e) => setName(e.target.value.replace(/[^\w]/g, "_"))}
          onBlur={() => (name && name !== step.name ? props.onRename(name) : setName(step.name))}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <span className="cs-kind">{kindLabel(step.kind)}</span>
        <StatusChip state={state} />
        <span className="cs-stats muted">
          {state?.status === "running" && <span className="live" />}
          {state?.rowCount !== undefined && `${fmtInt(state.rowCount)} rows`}
          {state?.ms !== undefined && ` · ${fmtMs(state.ms)}`}
          {state?.bytesBilled !== undefined && ` · ${fmtBytes(state.bytesBilled)}`}
        </span>
        <span className="spacer" />
        <button className="btn" disabled={props.running || !props.canRun} title="Run this step and everything after it" onClick={(e) => (e.stopPropagation(), props.onRunFrom())}>
          Run from here
        </button>
        <button className="btn" disabled={props.running || !props.canRun} title="Run only this step (inputs from the cache)" onClick={(e) => (e.stopPropagation(), props.onRunOnly())}>
          Run only
        </button>
        <button className="btn icon ghost" disabled={props.index === 0} aria-label="Move up" title="Move up" onClick={(e) => (e.stopPropagation(), props.onMove(-1))}>
          ↑
        </button>
        <button className="btn icon ghost" disabled={props.index === props.count - 1} aria-label="Move down" title="Move down" onClick={(e) => (e.stopPropagation(), props.onMove(1))}>
          ↓
        </button>
        <button className="btn icon ghost" aria-label="Delete step" title="Delete step" onClick={(e) => (e.stopPropagation(), props.onDelete())}>
          <Icon name="trash" />
        </button>
      </div>
      {step.description && <p className="cs-desc muted">{step.description}</p>}
      <div className="cs-deps muted">
        {props.inputs.length ? (
          <>
            Inputs: {props.inputs.map((i) => <code key={i}>{i}</code>)}
          </>
        ) : (
          "No inputs"
        )}
        {state?.inlinedInto && <> · inlined as a CTE into {state.inlinedInto.join(", ")}</>}
        {state?.reason && <> · {state.reason}</>}
      </div>
      <StepEditor step={step} queries={props.queries} lib={props.lib} conns={props.conns} earlier={props.earlier} onChange={props.onChange} />
      {state?.error && <div className="err">{state.error}</div>}
    </section>
  );
}

function StepEditor({ step, queries, lib, conns, earlier, onChange }: { step: ChainStep; queries: NamedQuery[]; lib: ChainLibrary | null; conns: SavedConnection[]; earlier: { name: string; columns: string[] }[]; onChange: (p: Partial<ChainStep>) => void }) {
  switch (step.kind) {
    case "query": {
      const q = step.queryId ? queries.find((x) => x.id === step.queryId) : undefined;
      return (
        <div className="cs-editor">
          <div className="cs-row">
            <label>
              Query{" "}
              <select className="input" value={step.queryId ?? ""} onChange={(e) => onChange({ queryId: e.target.value || undefined })}>
                <option value="">Inline SQL</option>
                {queries.map((x) => (
                  <option key={x.id} value={x.id}>
                    {lib?.pathOf(x) ?? x.name}
                  </option>
                ))}
              </select>
            </label>
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
            DuckDB SQL, run on this machine. <code>{'{{ ref("step") }}'}</code> is that step's result table.
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
      return <AssignmentsEditor value={step.assignments ?? {}} earlier={earlier} onChange={(assignments) => onChange({ assignments })} />;
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

/** What a Set variables row takes from a step: a list of a column's values, one value, or a number. */
const PICKS = [
  { fn: "column", label: "All values of", hint: "a list", use: "sql_list" },
  { fn: "distinct", label: "Unique values of", hint: "a list", use: "sql_list" },
  { fn: "first", label: "First value of", hint: "one value", use: "sql" },
  { fn: "max", label: "Largest value of", hint: "one value", use: "sql" },
  { fn: "min", label: "Smallest value of", hint: "one value", use: "sql" },
  { fn: "sum", label: "Sum of", hint: "a number", use: "sql" },
  { fn: "count", label: "Row count of", hint: "a number", use: "sql" },
] as const;

/** Splits `fn("step", "col")` / `count("step")` into its parts; anything else is a custom expression. */
export function parsePick(expr: string): { fn: string; step: string; col: string } | null {
  const m = /^\s*(\w+)\(\s*"([^"]*)"\s*(?:,\s*"([^"]*)"\s*)?\)\s*$/.exec(expr);
  if (!m || !PICKS.some((p) => p.fn === m[1])) return null;
  if (m[1] !== "count" && m[3] === undefined) return null;
  return { fn: m[1]!, step: m[2]!, col: m[3] ?? "" };
}
const pickExpr = (fn: string, step: string, col: string) => (fn === "count" ? `count("${step}")` : `${fn}("${step}", "${col}")`);

function AssignmentsEditor({ value, earlier, onChange }: { value: Record<string, string>; earlier: { name: string; columns: string[] }[]; onChange: (v: Record<string, string>) => void }) {
  const rows = Object.entries(value);
  const set = (i: number, k: string, v: string) => {
    const next = rows.map((r, j) => (j === i ? [k, v] : r));
    onChange(Object.fromEntries(next));
  };
  const lastStep = earlier.at(-1);
  return (
    <div className="cs-editor">
      <p className="cs-explain">
        Takes values out of an earlier step's result so a later step can use them, for example the ids found in BigQuery
        filtering a Postgres query: <code>{"WHERE id IN {{ ids | sql_list }}"}</code>.
      </p>
      {rows.map(([k, v], i) => {
        const p = parsePick(v);
        const pick = p ? PICKS.find((x) => x.fn === p.fn)! : undefined;
        const cols = earlier.find((x) => x.name === p?.step)?.columns ?? [];
        return (
          <div className="cs-var" key={i}>
            <div className="cs-var-row">
              <input className="input mono cs-var-name" value={k} aria-label="Variable name" onChange={(e) => set(i, e.target.value.replace(/[^\w]/g, "_"), v)} />
              <span className="muted">=</span>
              <select
                className="input"
                aria-label="Take"
                value={p?.fn ?? "__expr"}
                onChange={(e) => {
                  const fn = e.target.value;
                  if (fn === "__expr") return set(i, k, v);
                  set(i, k, pickExpr(fn, p?.step ?? lastStep?.name ?? "step", p?.col ?? lastStep?.columns[0] ?? "id"));
                }}
              >
                {PICKS.map((x) => (
                  <option key={x.fn} value={x.fn}>
                    {x.label}
                  </option>
                ))}
                <option value="__expr">Custom expression…</option>
              </select>
              {p && p.fn !== "count" && (
                <>
                  {cols.length ? (
                    <select className="input mono" aria-label="Column" value={p.col} onChange={(e) => set(i, k, pickExpr(p.fn, p.step, e.target.value))}>
                      {!cols.includes(p.col) && <option value={p.col}>{p.col}</option>}
                      {cols.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input className="input mono cs-var-col" aria-label="Column" value={p.col} placeholder="column" title="Run the step once to pick from its columns" onChange={(e) => set(i, k, pickExpr(p.fn, p.step, e.target.value))} />
                  )}
                </>
              )}
              {p && (
                <>
                  <span className="muted">from</span>
                  <select className="input mono" aria-label="Step" value={p.step} onChange={(e) => set(i, k, pickExpr(p.fn, e.target.value, p.col))}>
                    {!earlier.some((x) => x.name === p.step) && <option value={p.step}>{p.step}</option>}
                    {earlier.map((x) => (
                      <option key={x.name} value={x.name}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <button className="btn icon ghost" aria-label="Remove" onClick={() => onChange(Object.fromEntries(rows.filter((_, j) => j !== i)))}>
                <Icon name="minus" />
              </button>
            </div>
            {!p && (
              <input className="input mono" value={v} aria-label="Expression" placeholder={`len(column("top_ads", "ad_hash")) > 0 ? first("top_ads", "ad_hash") : "none"`} onChange={(e) => set(i, k, e.target.value)} />
            )}
            <small className="faint">
              {pick ? <>Gives {pick.hint}. Use it in a later query as </> : <>Use it in a later query as </>}
              <code>{`{{ ${k}${pick?.use === "sql_list" ? " | sql_list" : pick ? " | sql" : ""} }}`}</code>
              {pick?.use === "sql_list" && <> (becomes <code>('a', 'b', …)</code>)</>}.
            </small>
          </div>
        );
      })}
      <div>
        <button
          className="btn"
          onClick={() => {
            let n = rows.length + 1;
            while (`var_${n}` in value) n++;
            onChange({ ...value, [rows.length ? `var_${n}` : "ids"]: pickExpr("column", lastStep?.name ?? "step", lastStep?.columns[0] ?? "id") });
          }}
        >
          <Icon name="plus" /> Variable
        </button>
      </div>
    </div>
  );
}

function VarsEditor({ vars, runVars, onChange }: { vars: VarDef[]; runVars: Record<string, unknown> | null; onChange: (v: VarDef[]) => void }) {
  const set = (i: number, patch: Partial<VarDef>) => onChange(vars.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const produced = runVars ? Object.entries(runVars).filter(([k]) => !vars.some((v) => v.name === k)) : [];
  return (
    <section className="chain-vars">
      <h3>Workflow variables</h3>
      {vars.map((v, i) => (
        <VarRow key={i} def={v} onName={(name) => set(i, { name })} onValue={(value) => set(i, { value })} onRemove={() => onChange(vars.filter((_, j) => j !== i))} />
      ))}
      <div>
        <button className="btn" onClick={() => onChange([...vars, { name: `var_${vars.length + 1}`, value: "" }])}>
          <Icon name="plus" /> Variable
        </button>
      </div>
      {produced.length > 0 && (
        <div className="muted">
          After the last run:{" "}
          {produced.map(([k, v]) => (
            <code key={k} title={showValue(v)}>
              {k} = {truncate(showValue(v), 60)}
            </code>
          ))}
        </div>
      )}
    </section>
  );
}

function VarRow({ def, onName, onValue, onRemove }: { def: VarDef; onName: (n: string) => void; onValue: (v: unknown) => void; onRemove: () => void }) {
  const [text, setText] = useState(def.value === undefined ? "" : showValue(def.value));
  return (
    <div className="cs-assign">
      <input className="input mono" value={def.name} aria-label="Variable name" onChange={(e) => onName(e.target.value.replace(/[^\w]/g, "_"))} />
      <span>=</span>
      <input className="input mono" value={text} aria-label="Value" placeholder={`2026-10-01, 42, ["a", "b"]`} onChange={(e) => setText(e.target.value)} onBlur={() => onValue(parseValue(text))} />
      <button className="btn icon ghost" aria-label="Remove variable" onClick={onRemove}>
        <Icon name="minus" />
      </button>
    </div>
  );
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function StepDetail({ step, state }: { step?: ChainStep; state?: StepState }) {
  const [tab, setTab] = useState<"result" | "sql" | "tests">("result");
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState<GridCursor | null>(null);
  if (!step) return <aside className="chain-detail empty">Click a step to see its rendered SQL and result.</aside>;
  const rows = state?.preview ?? [];
  const cols = state?.columns ?? [];
  const nTests = (state?.tests?.length ?? 0) + (state?.logs?.length ?? 0);
  return (
    <aside className="chain-detail">
      <div className="cd-head">
        <b className="mono">{step.name}</b>
        <div className="seg" role="group" aria-label="Step detail">
          <button aria-pressed={tab === "result"} onClick={() => setTab("result")}>
            Result
          </button>
          <button aria-pressed={tab === "sql"} onClick={() => setTab("sql")}>
            Rendered SQL
          </button>
          <button aria-pressed={tab === "tests"} onClick={() => setTab("tests")}>
            Tests & log{nTests ? ` (${nTests})` : ""}
          </button>
        </div>
        {state?.rowCount !== undefined && rows.length < state.rowCount && <span className="muted">first {fmtInt(rows.length)} of {fmtInt(state.rowCount)}</span>}
      </div>
      {tab === "result" &&
        (state?.vars ? (
          <div className="cd-vars">
            {Object.entries(state.vars).map(([k, v]) => (
              <div key={k}>
                <code>{k}</code> = <span className="mono">{truncate(showValue(v), 400)}</span>
                {Array.isArray(v) && <span className="muted"> ({fmtInt(v.length)} values)</span>}
              </div>
            ))}
          </div>
        ) : cols.length ? (
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
            resetKey={`${step.name}:${state?.ms ?? ""}:${state?.status ?? ""}`}
          />
        ) : (
          <div className="empty">{state?.file ? `Exported ${state.file}` : state?.status === "done" ? "No result table." : "Run the step to see its result."}</div>
        ))}
      {tab === "sql" && (state?.renderedSql ? <pre className="cd-sql mono">{state.renderedSql}</pre> : <div className="empty">Rendered SQL appears after the step runs.</div>)}
      {tab === "tests" && (
        <div className="cd-tests">
          {!nTests && <div className="empty">No tests or log output.</div>}
          {state?.tests?.map((t, i) => (
            <div key={i} className={t.passed ? "pass" : "fail"}>
              {t.passed ? "✓" : "✗"} {t.name}
            </div>
          ))}
          {state?.logs?.map((l, i) => (
            <pre key={i} className="mono">
              {l}
            </pre>
          ))}
        </div>
      )}
    </aside>
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
