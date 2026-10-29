// SQL query tab: highlighted editor, ⌘↵ runs (selection or statement at cursor), ⌘⇧↵ runs all,
// ⌘. aborts, ⌘⇧F formats the selection or the whole text. Every run is added to History.

import { useEffect, useRef, useState } from "react";
import type { CostEstimate } from "@core/types";
import { DataGrid, type GridCursor } from "../components/DataGrid";
import { SqlEditor } from "../components/SqlEditor";
import { Splitter, usePaneWidth } from "../components/Splitter";
import { TypedConfirm } from "../components/ui";
import { cellText, fmtBytes, fmtInt, fmtMs } from "../lib/format";
import { findDestructive, isWriteStatement, splitStatements } from "../lib/safety";
import { MOD, useKeys } from "../lib/keys";
import { formatRange } from "../lib/sqlFormat";
import * as db from "../store/db";
import type { ConnCtx, DetailsSource } from "./model";
import { useResult } from "./useResult";

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
  active: boolean;
  onSql: (sql: string) => void;
  onDetails: (src: DetailsSource | null) => void;
  onSaved: () => void;
}) {
  const { ctx } = props;
  const { state, run, abort } = useResult(ctx.driver, (h) => ctx.addHistory({ ...h, source: "editor" }));
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState<GridCursor | null>(null);
  const [confirm, setConfirm] = useState<{ sql: string; target: string; what: string } | null>(null);
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [estErr, setEstErr] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (props.active) ta.current?.focus();
  }, [props.active]);

  // BigQuery-style dry run, debounced.
  useEffect(() => {
    if (!ctx.caps.costEstimate || !ctx.driver.estimate || !props.sql.trim()) {
      setEstimate(null);
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(() => {
      ctx.driver.estimate!({ sql: props.sql }, ac.signal).then(
        (e) => {
          setEstimate(e);
          setEstErr(null);
        },
        (e) => !ac.signal.aborted && setEstErr((e as Error).message),
      );
    }, 600);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [props.sql, ctx]);

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
    // Multiple statements: run them one by one, showing the last result.
    const stmts = splitStatementsRaw(sql);
    if (stmts.length <= 1) void run(sql.trim().replace(/;\s*$/, ""));
    else {
      void (async () => {
        for (const s of stmts) await run(s);
      })();
    }
  };

  const runCurrent = () => {
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
          "mod+shift+enter": () => execute(props.sql),
          "mod+.": abort,
          "mod+s": () => void saveQuery(),
          "mod+shift+f": prettify,
        }
      : {},
  );

  const saveQuery = async () => {
    const name = prompt("Save query as", props.title);
    if (!name) return;
    await db.put("queries", { id: db.uid("q_"), connectionId: ctx.cfg.id, name, sql: props.sql, updatedAt: Date.now() }).catch(() => {});
    ctx.toast(`Saved query "${name}"`);
    props.onSaved();
  };

  useEffect(() => {
    if (!props.active) return;
    const sel = [...selection].sort((a, b) => a - b).slice(0, 500);
    props.onDetails({ table: null, columns: state.columns, editable: false, rows: sel.map((i) => ({ rowId: String(i), key: {}, values: state.rows[i] ?? [] })) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.active, selection, state.rows, state.columns]);

  const overLimit = estimate && estimate.bytes > Number(ctx.cfg.options.maximumBytesBilled ?? 10 * 1024 ** 3);
  // Height of the editor box (text area only); the results take the rest.
  const editorPane = usePaneWidth("dbui.pane.editor", 220, 80, 900);

  return (
    <div className="center" style={{ display: props.active ? undefined : "none" }}>
      <div className="editor" style={{ "--ed-h": `${editorPane.width}px` } as React.CSSProperties}>
        <SqlEditor
          ref={ta}
          value={props.sql}
          onChange={props.onSql}
          placeholder={`SELECT * FROM …\n\n${MOD}↵ runs the statement at the cursor, ${MOD}⇧↵ runs all, ${MOD}. stops, ${MOD}⇧F formats`}
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
          aria-label="SQL editor"
        />
        <div className="edbar">
          {state.running ? (
            <button className="btn warn" onClick={abort}>
              Stop <kbd>{MOD}.</kbd>
            </button>
          ) : (
            <button className={"btn " + (overLimit ? "warn" : "primary")} onClick={runCurrent}>
              {overLimit ? "Run anyway" : "Run"} <kbd>{MOD}↵</kbd>
            </button>
          )}
          <button className="btn" onClick={() => execute(props.sql)} disabled={state.running}>
            Run all <kbd>{MOD}⇧↵</kbd>
          </button>
          <button className="btn" onClick={prettify} disabled={!props.sql.trim()} title="Formats the selected SQL, or all of it when nothing is selected">
            Format <kbd>{MOD}⇧F</kbd>
          </button>
          <button className="btn" onClick={() => void saveQuery()} title="Keep this query in the Saved tab">
            Save <kbd>{MOD}S</kbd>
          </button>
          {ctx.caps.costEstimate && (
            <span className="muted">
              {estErr ? <span style={{ color: "var(--del-fg)" }}>{estErr}</span> : estimate ? <>Will scan <b style={{ color: overLimit ? "var(--env-stage)" : "var(--fg)" }}>{fmtBytes(estimate.bytes)}</b>{estimate.usd !== undefined && ` · ~$${estimate.usd.toFixed(2)}`}</> : "Estimating…"}
            </span>
          )}
          <span className="spacer" />
          {state.running && (
            <>
              <span className="live" /> <span className="muted">{fmtInt(state.rows.length)} rows so far</span>
            </>
          )}
          {state.summary && (
            <span className="muted">
              {state.summary.affectedRows !== undefined ? `${fmtInt(state.summary.affectedRows)} rows affected` : `${fmtInt(state.summary.rowCount)} rows`} · {fmtMs(state.summary.ms)}
              {state.summary.bytesProcessed !== undefined && ` · ${fmtBytes(state.summary.bytesProcessed)} processed`}
              {state.summary.message && ` · ${state.summary.message}`}
            </span>
          )}
        </div>
      </div>
      <Splitter side="top" label="Resize editor" size={editorPane} onResize={editorPane.setWidth} />
      {state.running && <div className="loading-bar" />}
      {state.error && <div className="err" style={{ margin: 8 }}>{state.error}</div>}
      {state.columns.length > 0 ? (
        <DataGrid
          columns={state.columns}
          rowCount={state.rows.length}
          value={(r, c) => state.rows[r]?.[c] ?? null}
          selection={selection}
          cursor={cursor}
          onSelection={(s, c) => {
            setSelection(s);
            setCursor(c);
          }}
          onCopy={(rows) => {
            const text = (rows.length ? rows : cursor ? [cursor.row] : []).map((r) => (state.rows[r] ?? []).map(cellText).join("\t")).join("\n");
            void navigator.clipboard.writeText(text).then(() => ctx.toast("Copied"));
          }}
          resetKey={String(state.runId)}
        />
      ) : (
        !state.running && !state.error && <div className="empty">{state.summary ? "Statement ran; no rows returned." : "Run a query to see results."}</div>
      )}
      <div className="foot">
        <span className="count">
          {selection.size > 0 ? `${fmtInt(selection.size)} of ` : ""}
          {fmtInt(state.rows.length)} rows{selection.size > 0 ? " selected" : ""}
        </span>
      </div>
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
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const sql = confirm.sql;
            setConfirm(null);
            execute(sql, true);
          }}
        />
      )}
    </div>
  );
}

/** Splits on ';' outside strings/comments, keeping original text (unlike safety.splitStatements). */
function splitStatementsRaw(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (q) {
      cur += c;
      if (c === q && sql[i + 1] === q) cur += sql[++i];
      else if (c === q) q = null;
    } else if (c === "'" || c === '"' || c === "`") {
      q = c;
      cur += c;
    } else if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      const end = nl < 0 ? sql.length : nl;
      cur += sql.slice(i, end);
      i = end - 1;
    } else if (c === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  // Drop comment-only chunks.
  return out.filter((s) => splitStatements(s).length > 0);
}
