// Workflow editor and runner (DESIGN.md §3.15), at #workflow/<id> (#chain/<id> still works).
// The code calls workflows "chains"; every word the user sees says "workflow". A notebook-like list of steps,
// each with its own editor, status chip, rows, time and bytes. Clicking a step shows its
// rendered SQL, result preview, tests and log underneath.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Chain, ChainStep, ChainStepKind, Collection, NamedQuery, VarDef } from "../../collections/model";
import { listCollections, loadBundle, onCollectionsChanged } from "../../collections/store";
import { CollectionSettings } from "../collections/CollectionSettings";
import { buildGraph, ChainGraphError, type ChainGraph } from "../../chains/graph";
import { cachedResult, clearCache, estimateChain, runChain, type ChainEstimate, type ChainEvent, type StepEvent } from "../../chains/runner";
import { appChainDeps, chainLibrary } from "../../chains/appDeps";
import type { ChainLibrary } from "../../chains/library";
import type { Destructive } from "../lib/safety";
import { listConnections, type SavedConnection } from "../lib/connections";
import { navigate } from "../lib/route";
import { byCollection } from "../store/db";
import { cellText, fmtBytes, fmtInt, fmtMs } from "../lib/format";
import { DataGrid, type GridCursor } from "../components/DataGrid";
import { SqlEditor } from "../components/SqlEditor";
import { Icon } from "../components/Icon";
import { Modal, TypedConfirm, useToast } from "../components/ui";
import { kindLabel, loadChain, newStep, saveChain, STEP_KINDS } from "./chainStore";
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
  const [showVars, setShowVars] = useState(false);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [colVersion, setColVersion] = useState(0);
  const [showCollection, setShowCollection] = useState(false);
  const ac = useRef<AbortController | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Load the chain, its collection's library and the connection list.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const c = await loadChain(chainId).catch(() => undefined);
      if (cancelled) return;
      setChain(c ?? null);
      if (!c) return;
      document.title = c.name;
      const [l, cs] = await Promise.all([chainLibrary(c.collectionId), listConnections()]);
      if (cancelled) return;
      setLib(l);
      setConns(cs);
      setQueries(await byCollection("namedQueries", c.collectionId).catch(() => []));
    })();
    return () => {
      cancelled = true;
      ac.current?.abort();
    };
  }, [chainId]);

  // The home collection: shown as a tag in the header, and changeable.
  useEffect(() => onCollectionsChanged(() => setColVersion((v) => v + 1)), []);
  useEffect(() => {
    listCollections().then(setCollections, () => setCollections([]));
  }, [colVersion]);
  const homeId = chain?.collectionId;
  useEffect(() => {
    if (!homeId) return;
    let cancelled = false;
    void Promise.all([chainLibrary(homeId), loadBundle(homeId).then((b) => b?.queries ?? [], () => [])]).then(([l, qs]) => {
      if (cancelled) return;
      setLib(l);
      setQueries(qs);
    });
    return () => {
      cancelled = true;
    };
  }, [homeId, colVersion]);

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
          <button className="btn" onClick={() => navigate({ name: "home" })}>
            Home
          </button>
        </div>
      </div>
    );
  }

  const home = collections.find((c) => c.id === chain.collectionId);
  const sel = chain.steps.find((s) => s.name === selected);
  const selState = sel ? states[sel.name] : undefined;
  const total = Object.values(states).reduce((a, s) => a + (s.bytesBilled ?? 0), 0);

  return (
    <div className="chain-page">
      <header className="topbar chain-top">
        <button className="btn icon ghost" title="Home" aria-label="Home" onClick={() => navigate({ name: "home" })}>
          <Icon name="home" />
        </button>
        <span className="wf-label">Workflow</span>
        <input className="input chain-name" value={chain.name} aria-label="Workflow name" onChange={(e) => update((c) => ({ ...c, name: e.target.value }))} />
        <span className="wf-home">
          {home ? (
            <button className="wf-tag home" title="Open this collection's variables and environments" onClick={() => setShowCollection(true)}>
              {home.name}
            </button>
          ) : (
            <span className="wf-tag missing" title="The home collection was deleted; pick another">
              No collection
            </span>
          )}
          <select
            className="input wf-home-pick"
            aria-label="Change collection"
            title="Change the collection whose variables and named queries this workflow uses"
            value=""
            onChange={(e) => {
              const id = e.target.value;
              if (!id || id === chain.collectionId) return;
              update((c) => ({ ...c, collectionId: id }));
              toast(`Workflow now uses "${collections.find((c) => c.id === id)?.name ?? "collection"}"`);
            }}
          >
            <option value="">Change…</option>
            {collections
              .filter((c) => c.id !== chain.collectionId)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </span>
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
        <button className="btn" aria-pressed={showVars} onClick={() => setShowVars((v) => !v)}>
          Variables{chain.vars.length ? ` (${chain.vars.length})` : ""}
        </button>
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
      </header>

      <div className="chain-body">
        <div className="chain-steps">
          {graph.error && <div className="err">{graph.error}</div>}
          {runError && <div className="err">{runError}</div>}
          {showVars && <VarsEditor vars={chain.vars} runVars={runVars} onChange={(vars) => update((c) => ({ ...c, vars }))} />}
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
      {showCollection && home && <CollectionSettings collection={home} onClose={() => setShowCollection(false)} />}
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
      <StepEditor step={step} queries={props.queries} lib={props.lib} conns={props.conns} onChange={props.onChange} />
      {state?.error && <div className="err">{state.error}</div>}
    </section>
  );
}

function StepEditor({ step, queries, lib, conns, onChange }: { step: ChainStep; queries: NamedQuery[]; lib: ChainLibrary | null; conns: SavedConnection[]; onChange: (p: Partial<ChainStep>) => void }) {
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
          <small className="muted">Runs locally in DuckDB. {"{{ ref(\"step\") }}"} is that step's result table.</small>
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
      return <AssignmentsEditor value={step.assignments ?? {}} onChange={(assignments) => onChange({ assignments })} />;
    case "export":
      return (
        <div className="cs-editor">
          <div className="cs-row">
            <label>
              Format{" "}
              <select className="input" value={step.format ?? "csv"} onChange={(e) => onChange({ format: e.target.value as ChainStep["format"] })}>
                <option value="csv">CSV</option>
                <option value="jsonl">JSONL</option>
                <option value="parquet">Parquet</option>
              </select>
            </label>
          </div>
          <SqlEditor className="cs-sql short" value={step.sql ?? ""} onChange={(sql) => onChange({ sql })} placeholder={`SELECT * FROM {{ ref("report") }}`} aria-label="Export SQL" />
        </div>
      );
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

function AssignmentsEditor({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const rows = Object.entries(value);
  const set = (i: number, k: string, v: string) => {
    const next = rows.map((r, j) => (j === i ? [k, v] : r));
    onChange(Object.fromEntries(next));
  };
  return (
    <div className="cs-editor">
      {rows.map(([k, v], i) => (
        <div className="cs-assign" key={i}>
          <input className="input mono" value={k} aria-label="Variable name" onChange={(e) => set(i, e.target.value.replace(/[^\w]/g, "_"), v)} />
          <span>=</span>
          <input className="input mono" value={v} aria-label="Expression" placeholder={`column("top_ads", "ad_hash")`} onChange={(e) => set(i, k, e.target.value)} />
          <button className="btn icon ghost" aria-label="Remove" onClick={() => onChange(Object.fromEntries(rows.filter((_, j) => j !== i)))}>
            <Icon name="minus" />
          </button>
        </div>
      ))}
      <div>
        <button
          className="btn"
          onClick={() => {
            let n = rows.length + 1;
            while (`var_${n}` in value) n++;
            onChange({ ...value, [`var_${n}`]: "" });
          }}
        >
          <Icon name="plus" /> Variable
        </button>{" "}
        <small className="muted">
          <code>column("step", "col")</code> → list, <code>first</code>, <code>max</code>/<code>min</code>, <code>count("step")</code>, or JSON like <code>[1, 2]</code>. Lists go into queries with{" "}
          <code>{"{{ name | sql_list }}"}</code>.
        </small>
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
