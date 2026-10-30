// SQL query tab: highlighted editor, ⌘↵ runs (selection or statement at cursor), ⌘⇧↵ runs all,
// ⌘. aborts, ⌘⇧F formats the selection or the whole text. Every run is added to History.
// Several statements run in order with one result tab each, stopping at the first error. A tab
// bound to a named query renders the template first and splits the rendered SQL.

import { useEffect, useMemo, useRef, useState } from "react";
import { collect, type Column, type CostEstimate, type ExecuteSummary } from "@core/types";
import { DataGrid, type GridCursor } from "../components/DataGrid";
import { SqlEditor } from "../components/SqlEditor";
import { Splitter, usePaneWidth } from "../components/Splitter";
import { TypedConfirm } from "../components/ui";
import { cellText, fmtBytes, fmtInt, fmtMs } from "../lib/format";
import { findDestructive, isWriteStatement } from "../lib/safety";
import { MOD, useKeys } from "../lib/keys";
import { formatRange } from "../lib/sqlFormat";
import { connectionSource } from "../lib/completion";
import type { ConnCtx, DetailsSource } from "./model";
import { useResult } from "./useResult";
import type { Cell } from "@core/types";
import { TemplateEditor } from "../collections/TemplateEditor";
import { useNamedQuery, type PreparedStatement } from "../collections/useNamedQuery";
import { SaveAsNamedQuery } from "../collections/SaveAsNamedQuery";
import { runStatements, splitStatementsRaw, statementIndexAt, type StatementResult } from "../../collections/split";
import type { NamedQuery } from "../../collections/model";

type StmtResult = StatementResult<Column, Cell[], ExecuteSummary>;
// Stable empties, so effects keyed on the shown rows don't re-run on every render.
const NO_COLUMNS: Column[] = [];
const NO_ROWS: Cell[][] = [];
/** A run of several statements: one result per statement that ran, shown as Result 1, Result 2 … */
interface MultiRun {
  statements: string[];
  results: StmtResult[];
  running: boolean;
  active: number;
  runId: number;
}
import { ConsolePanel, EnvChangesConfirm, ParamsPanel, RenderedPanel, TestsPanel } from "../collections/NamedQueryPanels";

/** Statement around the cursor: text between the surrounding semicolons. */
export function statementAt(sql: string, pos: number): string {
  const before = sql.lastIndexOf(";", Math.max(0, pos - 1));
  let after = sql.indexOf(";", pos);
  if (after < 0) after = sql.length;
  const s = sql.slice(before + 1, after).trim();
  if (s) return s;
  // Cursor right after a trailing ';': use the previous statement.
  const prev = sql.lastIndexOf(";", before - 1);
  return sql.slice(prev + 1, before).trim();
}

export function QueryView(props: {
  ctx: ConnCtx;
  sql: string;
  title: string;
  /** Set when this tab edits a named query from a collection: the editor holds its template. */
  namedQueryId?: string;
  active: boolean;
  onSql: (sql: string) => void;
  onDetails: (src: DetailsSource | null) => void;
  onSaved: () => void;
  /** ⌘S in an unbound tab saved it into a collection: bind this tab to the new named query. */
  onBound?: (q: NamedQuery) => void;
  /** The statement-log button, shown at the end of the bottom bar. */
  logToggle?: React.ReactNode;
}) {
  const { ctx } = props;
  const { state, run, abort } = useResult(ctx.driver, (h) => ctx.addHistory({ ...h, source: "editor" }));
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState<GridCursor | null>(null);
  const [confirm, setConfirm] = useState<{ sql: string; target: string; what: string; params?: Cell[] } | null>(null);
  const nq = useNamedQuery(ctx, props.namedQueryId, props.sql);
  const [side, setSide] = useState<"results" | "rendered" | "tests" | "console">("results");
  /** runId of a named-query run whose post-run scripts are still due. */
  const postFor = useRef<number | null>(null);
  // What the dry run and Run use: the rendered SQL for a named query, else the editor text.
  const estimateSql = props.namedQueryId ? (nq?.rendered ?? "") : props.sql;
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [estErr, setEstErr] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const [multi, setMulti] = useState<MultiRun | null>(null);
  const multiAc = useRef<AbortController | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => () => multiAc.current?.abort(), []);

  useEffect(() => {
    if (props.active) ta.current?.focus();
  }, [props.active]);

  // BigQuery-style dry run, debounced.
  useEffect(() => {
    if (!ctx.caps.costEstimate || !ctx.driver.estimate || !estimateSql.trim()) {
      setEstimate(null);
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(() => {
      // Several statements: dry-run each and add them up.
      const parts = splitStatementsRaw(estimateSql);
      Promise.all((parts.length ? parts : [estimateSql]).map((sql) => ctx.driver.estimate!({ sql }, ac.signal))).then(
        (all) => {
          const usd = all.some((e) => e.usd !== undefined) ? all.reduce((a, e) => a + (e.usd ?? 0), 0) : undefined;
          setEstimate({ ...all[0]!, bytes: all.reduce((a, e) => a + e.bytes, 0), ...(usd !== undefined ? { usd } : {}) });
          setEstErr(null);
        },
        (e) => !ac.signal.aborted && setEstErr((e as Error).message),
      );
    }, 600);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [estimateSql, ctx]);

  const execute = (sql: string, skipConfirm = false) => {
    if (!sql.trim()) return;
    if (ctx.readOnly && isWriteStatement(sql)) {
      ctx.toast("Read-only connection: write statements are blocked.");
      return;
    }
    if (!skipConfirm && ctx.cfg.env === "production") {
      const d = findDestructive(sql)[0];
      if (d) {
        const what = { drop: "drops", truncate: "empties", delete_all: "deletes every row of", update_all: "updates every row of", alter_mutation: "rewrites" }[d.kind];
        setConfirm({ sql, target: d.target, what });
        return;
      }
    }
    setSelection(new Set());
    setCursor(null);
    // Several statements: run them in order, one result tab each.
    const stmts = splitStatementsRaw(sql);
    if (stmts.length <= 1) {
      setMulti(null);
      void run(sql.trim().replace(/;\s*$/, ""));
    } else void runMulti(stmts.map((s) => ({ sql: s, params: [] })));
  };

  /** Runs statements one by one (stopping at the first error) and keeps every result. */
  const runMulti = async (stmts: PreparedStatement[], after?: (results: StmtResult[]) => void) => {
    multiAc.current?.abort();
    abort();
    const ctrl = new AbortController();
    multiAc.current = ctrl;
    const runId = (multi?.runId ?? 0) + 1;
    setMulti({ statements: stmts.map((s) => s.sql), results: [], running: true, active: 0, runId });
    const results = await runStatements<Column, Cell[], ExecuteSummary>(
      stmts.map((s) => s.sql),
      async (sql, i) => {
        if (ctrl.signal.aborted) throw new Error("Query cancelled");
        const started = performance.now();
        try {
          const params = stmts[i]!.params;
          const r = await collect(ctx.driver.execute({ sql, pageSize: 2000, ...(params.length ? { params } : {}) }, ctrl.signal));
          ctx.addHistory({ sql, ms: r.summary.ms, rows: r.summary.rowCount, source: "editor" });
          return { sql, columns: r.columns, rows: r.rows, summary: r.summary };
        } catch (e) {
          const msg = ctrl.signal.aborted ? "Query cancelled" : (e as Error).message || String(e);
          ctx.addHistory({ sql, ms: performance.now() - started, error: msg, source: "editor" });
          throw new Error(msg);
        }
      },
      (r, i) => {
        if (multiAc.current !== ctrl) return;
        setMulti((m) => (m && m.runId === runId ? { ...m, results: [...m.results, r], active: r.error ? i : m.active === m.results.length - 1 || i === 0 ? i : m.active } : m));
      },
    );
    if (multiAc.current !== ctrl) return;
    multiAc.current = null;
    setMulti((m) => (m && m.runId === runId ? { ...m, running: false } : m));
    if (!results.some((r) => r.error)) after?.(results);
  };
  const stop = () => {
    multiAc.current?.abort();
    abort();
  };

  /** Named query: pre-run scripts, render, bind plain SQL params, then the usual safety checks. */
  const runNamed = async (mode: "all" | "current" = "all") => {
    if (!nq) return;
    if (nq.missing.length) {
      setSide("results");
      ctx.toast(`Fill in ${nq.missing.join(", ")} before running.`);
      return;
    }
    // Run: the selection, or the statement at the cursor. Run all: every statement.
    const el = ta.current;
    const selText = mode === "current" && el ? el.value.slice(el.selectionStart, el.selectionEnd) : "";
    const prepared = await nq.prepare(selText.trim() ? { text: selText } : {});
    if (!prepared) {
      if (nq.hasScripts) setSide("tests");
      return;
    }
    let stmts = prepared.statements;
    if (mode === "current" && !selText.trim() && el && stmts.length > 1) {
      // The template's statements line up with the rendered ones unless Jinja adds or removes ';'.
      const idx = statementIndexAt(props.sql, el.selectionStart);
      if (splitStatementsRaw(props.sql).length === stmts.length && idx >= 0) stmts = [stmts[idx]!];
    }
    if (stmts.length > 1) {
      if (!checkSafety(stmts.map((s) => s.sql).join(";\n"), () => runNamedMulti(stmts))) return;
      runNamedMulti(stmts);
      return;
    }
    const { sql, params } = stmts[0]!;
    if (ctx.readOnly && isWriteStatement(sql)) {
      ctx.toast("Read-only connection: write statements are blocked.");
      return;
    }
    if (ctx.cfg.env === "production") {
      const d = findDestructive(sql)[0];
      if (d) {
        const what = { drop: "drops", truncate: "empties", delete_all: "deletes every row of", update_all: "updates every row of", alter_mutation: "rewrites" }[d.kind];
        setConfirm({ sql, target: d.target, what, params });
        return;
      }
    }
    runPrepared(sql, params);
  };

  /** Read-only and production checks for a batch; false when it was blocked or needs confirming first. */
  const pendingBatch = useRef<(() => void) | null>(null);
  const checkSafety = (sql: string, onConfirm: () => void): boolean => {
    if (ctx.readOnly && isWriteStatement(sql)) {
      ctx.toast("Read-only connection: write statements are blocked.");
      return false;
    }
    if (ctx.cfg.env === "production") {
      const d = findDestructive(sql)[0];
      if (d) {
        const what = { drop: "drops", truncate: "empties", delete_all: "deletes every row of", update_all: "updates every row of", alter_mutation: "rewrites" }[d.kind];
        pendingBatch.current = onConfirm;
        setConfirm({ sql, target: d.target, what });
        return false;
      }
    }
    return true;
  };

  const runNamedMulti = (stmts: PreparedStatement[]) => {
    setSelection(new Set());
    setCursor(null);
    setSide("results");
    void runMulti(stmts, (results) => void nq?.afterRun(results.map((r) => ({ columns: r.columns, rows: r.rows }))));
  };

  const runPrepared = (sql: string, params: Cell[]) => {
    setSelection(new Set());
    setCursor(null);
    setSide("results");
    setMulti(null);
    postFor.current = state.runId + 1;
    void run(sql.trim().replace(/;\s*$/, ""), { params });
  };

  // Post-run scripts once a named query's result has arrived.
  useEffect(() => {
    if (!nq || state.running || postFor.current !== state.runId) return;
    postFor.current = null;
    if (state.error || !state.summary) return;
    void nq.afterRun([{ columns: state.columns, rows: state.rows }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.running, state.runId, state.summary, state.error]);

  const runCurrent = () => {
    if (props.namedQueryId) return void runNamed("current");
    const el = ta.current;
    if (!el) return;
    const sel = el.value.slice(el.selectionStart, el.selectionEnd);
    execute(sel.trim() ? sel : statementAt(el.value, el.selectionStart));
  };

  const prettify = () => {
    const el = ta.current;
    if (!el || !props.sql.trim()) return;
    try {
      const r = formatRange(el.value, el.selectionStart, el.selectionEnd, ctx.driver.dialect.name);
      props.onSql(r.text);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(r.start, r.end);
      });
    } catch (e) {
      ctx.toast((e as Error).message);
    }
  };

  useKeys(
    props.active
      ? {
          "mod+enter": runCurrent,
          "mod+shift+enter": () => (props.namedQueryId ? void runNamed("all") : execute(props.sql)),
          "mod+.": stop,
          "mod+s": () => void saveQuery(),
          "mod+shift+f": prettify,
        }
      : {},
  );

  // Bound tab: save the template back. Unbound: save it into a collection, then bind the tab.
  const saveQuery = async () => {
    if (props.namedQueryId) {
      if (nq) await nq.save();
      return;
    }
    if (!props.sql.trim()) return ctx.toast("Nothing to save yet.");
    setSaving(true);
  };

  // What the results area shows: the selected statement of a multi-statement run, or the single result.
  const shown = multi?.results[multi.active];
  const view = multi
    ? {
        columns: shown?.columns ?? NO_COLUMNS,
        rows: shown?.rows ?? NO_ROWS,
        running: multi.running && !shown,
        error: shown?.error ? `Statement ${multi.active + 1} failed: ${shown.error}` : null,
        summary: shown?.summary ?? null,
        resetKey: `m${multi.runId}:${multi.active}`,
      }
    : { columns: state.columns, rows: state.rows, running: state.running, error: state.error, summary: state.summary, resetKey: String(state.runId) };
  const busy = state.running || !!multi?.running;

  useEffect(() => {
    if (!props.active) return;
    const sel = [...selection].sort((a, b) => a - b).slice(0, 500);
    props.onDetails({ table: null, columns: view.columns, editable: false, rows: sel.map((i) => ({ rowId: String(i), key: {}, values: view.rows[i] ?? [] })) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.active, selection, view.rows, view.columns]);

  const overLimit = estimate && estimate.bytes > Number(ctx.cfg.options.maximumBytesBilled ?? 10 * 1024 ** 3);
  // Height of the editor box (text area only); the results take the rest.
  const editorPane = usePaneWidth("dbui.pane.editor", 220, 80, 900);
  const Editor = props.namedQueryId ? TemplateEditor : SqlEditor;
  // Autocomplete over this connection's tree (schemas, tables, columns), cached per tab.
  const completion = useMemo(() => ({ source: connectionSource(ctx.driver), quote: (n: string) => ctx.driver.dialect.quoteIdent(n) }), [ctx.driver]);

  return (
    <div className="center" style={{ display: props.active ? undefined : "none" }}>
      <div className="editor" style={{ "--ed-h": `${editorPane.width}px` } as React.CSSProperties}>
        <Editor
          ref={ta}
          value={props.sql}
          onChange={props.onSql}
          {...(props.namedQueryId ? {} : { completion })}
          placeholder={
            props.namedQueryId
              ? `SELECT * FROM {{ table | ident }} WHERE day >= {{ start_date | sql }}\n\n${MOD}↵ renders and runs, ${MOD}S saves the template`
              : `SELECT * FROM …\n\n${MOD}↵ runs the statement at the cursor, ${MOD}⇧↵ runs all, ${MOD}. stops, ${MOD}⇧F formats`
          }
          onKeyDown={(e) => {
            if (e.key === "Tab" && !e.shiftKey) {
              e.preventDefault();
              const el = e.currentTarget;
              const { selectionStart: a, selectionEnd: b } = el;
              const v = el.value.slice(0, a) + "  " + el.value.slice(b);
              props.onSql(v);
              requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
            }
          }}
          aria-label={props.namedQueryId ? "Template editor" : "SQL editor"}
        />
        <div className="edbar">
          {busy ? (
            <button className="btn warn" onClick={stop}>
              Stop <kbd>{MOD}.</kbd>
            </button>
          ) : (
            <button className={"btn " + (overLimit ? "warn" : "primary")} onClick={runCurrent} disabled={!!nq && nq.missing.length > 0} title={nq && nq.missing.length ? `Fill in ${nq.missing.join(", ")}` : undefined}>
              {overLimit ? "Run anyway" : "Run"} <kbd>{MOD}↵</kbd>
            </button>
          )}
          <button className="btn" onClick={() => (props.namedQueryId ? void runNamed("all") : execute(props.sql))} disabled={busy || (!!nq && nq.missing.length > 0)} title="Runs every statement in order, one result tab each">
            Run all <kbd>{MOD}⇧↵</kbd>
          </button>
          {!props.namedQueryId && (
            <>
              <button className="btn" onClick={prettify} disabled={!props.sql.trim()} title="Formats the selected SQL, or all of it when nothing is selected">
                Format <kbd>{MOD}⇧F</kbd>
              </button>
            </>
          )}
          <button className="btn" onClick={() => void saveQuery()} title={props.namedQueryId ? "Save the template back to the named query" : "Save this query into a collection"}>
            Save{nq?.dirty ? " •" : ""} <kbd>{MOD}S</kbd>
          </button>
          {ctx.caps.costEstimate && (
            <span className="muted">
              {estErr ? <span style={{ color: "var(--del-fg)" }}>{estErr}</span> : estimate ? <>Will scan <b style={{ color: overLimit ? "var(--env-stage)" : "var(--fg)" }}>{fmtBytes(estimate.bytes)}</b>{estimate.usd !== undefined && ` · ~$${estimate.usd.toFixed(2)}`}</> : "Estimating…"}
            </span>
          )}
          <span className="spacer" />
          {busy && (
            <>
              <span className="live" />{" "}
              <span className="muted">{multi ? `statement ${Math.min(multi.results.length + 1, multi.statements.length)} of ${multi.statements.length}` : `${fmtInt(state.rows.length)} rows so far`}</span>
            </>
          )}
          {view.summary && (
            <span className="muted">
              {view.summary.affectedRows !== undefined ? `${fmtInt(view.summary.affectedRows)} rows affected` : `${fmtInt(view.summary.rowCount)} rows`} · {fmtMs(view.summary.ms)}
              {view.summary.bytesProcessed !== undefined && ` · ${fmtBytes(view.summary.bytesProcessed)} processed`}
              {view.summary.message && ` · ${view.summary.message}`}
            </span>
          )}
        </div>
      </div>
      {nq && <ParamsPanel nq={nq} />}
      <Splitter side="top" label="Resize editor" size={editorPane} onResize={editorPane.setWidth} />
      {nq && (
        <div className="nq-tabs" role="tablist">
          {(["results", "rendered", "tests", "console"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={side === k} onClick={() => setSide(k)}>
              {{ results: "Results", rendered: "Rendered", tests: "Tests", console: "Console" }[k]}
              {k === "tests" && nq.scripts && nq.scripts.tests.length > 0 && (
                <span className={"nq-badge " + (nq.scripts.tests.every((t) => t.passed) ? "pass" : "fail")}>
                  {nq.scripts.tests.filter((t) => t.passed).length}/{nq.scripts.tests.length}
                </span>
              )}
              {k === "console" && nq.scripts && nq.scripts.logs.length > 0 && <span className="nq-badge">{nq.scripts.logs.length}</span>}
              {k === "rendered" && nq.analysis && nq.analysis.warnings.length > 0 && <span className="nq-badge warn">!</span>}
            </button>
          ))}
        </div>
      )}
      {nq && side === "rendered" && <RenderedPanel nq={nq} onCopy={(t) => void navigator.clipboard.writeText(t).then(() => ctx.toast("Copied rendered SQL"), () => ctx.toast("Couldn't copy"))} />}
      {nq && side === "tests" && <TestsPanel nq={nq} />}
      {nq && side === "console" && <ConsolePanel nq={nq} />}
      {(!nq || side === "results") && (
        <>
      {multi && (
        <div className="stmt-tabs" role="tablist" aria-label="Statement results">
          {multi.statements.map((sql, i) => {
            const r = multi.results[i];
            const st = r ? (r.error ? "failed" : "done") : multi.running && i === multi.results.length ? "running" : "not-run";
            return (
              <button
                key={i}
                role="tab"
                aria-selected={multi.active === i}
                className={"stmt-tab " + st}
                disabled={!r}
                title={(sql.split("\n").find((l) => l.trim()) ?? sql).trim() + (st === "failed" ? " (failed)" : st === "not-run" ? " (not run)" : "")}
                onClick={() => {
                  setSelection(new Set());
                  setCursor(null);
                  setMulti((m) => (m ? { ...m, active: i } : m));
                }}
              >
                Result {i + 1}
                {st === "failed" && " ✗"}
              </button>
            );
          })}
        </div>
      )}
      {view.running && <div className="loading-bar" />}
      {view.error && <div className="err" style={{ margin: 8 }}>{view.error}</div>}
      {view.columns.length > 0 ? (
        <DataGrid
          columns={view.columns}
          rowCount={view.rows.length}
          value={(r, c) => view.rows[r]?.[c] ?? null}
          selection={selection}
          cursor={cursor}
          onSelection={(s, c) => {
            setSelection(s);
            setCursor(c);
          }}
          onCopy={(rows) => {
            const text = (rows.length ? rows : cursor ? [cursor.row] : []).map((r) => (view.rows[r] ?? []).map(cellText).join("\t")).join("\n");
            void navigator.clipboard.writeText(text).then(() => ctx.toast("Copied"));
          }}
          resetKey={view.resetKey}
        />
      ) : (
        !view.running && !view.error && <div className="empty">{view.summary ? "Statement ran; no rows returned." : "Run a query to see results."}</div>
      )}
        </>
      )}
      <div className="foot">
        <span className="count">
          {selection.size > 0 ? `${fmtInt(selection.size)} of ` : ""}
          {fmtInt(view.rows.length)} rows{selection.size > 0 ? " selected" : ""}
        </span>
        <span className="spacer" />
        {props.logToggle}
      </div>
      {nq && <EnvChangesConfirm nq={nq} />}
      {confirm && (
        <TypedConfirm
          title="Destructive statement on production"
          message={
            <>
              This statement {confirm.what} <b className="mono">{confirm.target}</b> on <b>{ctx.cfg.name}</b>.
            </>
          }
          expected={confirm.target}
          confirmLabel="Run on production"
          onCancel={() => {
            pendingBatch.current = null;
            setConfirm(null);
          }}
          onConfirm={() => {
            const { sql, params } = confirm;
            const batch = pendingBatch.current;
            pendingBatch.current = null;
            setConfirm(null);
            if (batch) batch();
            else if (params) runPrepared(sql, params);
            else execute(sql, true);
          }}
        />
      )}
      {saving && (
        <SaveAsNamedQuery
          sql={props.sql}
          dialect={ctx.driver.dialect.name}
          connectionId={ctx.cfg.id}
          name={props.title !== "Query" ? props.title : undefined}
          onClose={() => setSaving(false)}
          onSaved={(q) => {
            ctx.toast(`Saved "${q.name}"`);
            props.onSaved();
            props.onBound?.(q);
          }}
        />
      )}
    </div>
  );
}
