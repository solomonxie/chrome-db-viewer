// Runs a statement through driver.execute, collecting streamed pages, with AbortController.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Cell, Column, Driver, ExecuteSummary } from "@core/types";

export interface ResultState {
  columns: Column[];
  rows: Cell[][];
  running: boolean;
  error: string | null;
  summary: ExecuteSummary | null;
  sql: string | null;
  /** Bumped on each new run, so grids reset scroll/selection. */
  runId: number;
}

const initial: ResultState = { columns: [], rows: [], running: false, error: null, summary: null, sql: null, runId: 0 };

export function useResult(driver: Driver, onDone?: (r: { sql: string; ms?: number; rows?: number; error?: string }) => void) {
  const [state, setState] = useState<ResultState>(initial);
  const ac = useRef<AbortController | null>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const run = useCallback(
    async (sql: string, opts: { pageSize?: number; keepRows?: boolean } = {}) => {
      ac.current?.abort();
      const ctrl = new AbortController();
      ac.current = ctrl;
      const started = performance.now();
      setState((s) => ({
        ...s,
        running: true,
        error: null,
        summary: null,
        sql,
        runId: s.runId + 1,
        ...(opts.keepRows ? {} : { rows: [], columns: [] }),
      }));
      let columns: Column[] = [];
      let rows: Cell[][] = [];
      let lastFlush = 0;
      try {
        const gen = driver.execute({ sql, pageSize: opts.pageSize ?? 2000 }, ctrl.signal);
        for (;;) {
          const next = await gen.next();
          if (ctrl.signal.aborted) throw new Error("aborted");
          if (next.done) {
            setState((s) => ({ ...s, columns, rows, running: false, summary: next.value }));
            doneRef.current?.({ sql, ms: next.value.ms, rows: next.value.rowCount });
            return;
          }
          if (next.value.columns) columns = next.value.columns;
          rows = rows.concat(next.value.rows);
          // Repaint at most every 100 ms while streaming.
          const now = performance.now();
          if (now - lastFlush > 100) {
            lastFlush = now;
            const snapshot = rows;
            const cols = columns;
            setState((s) => ({ ...s, columns: cols, rows: snapshot }));
          }
        }
      } catch (e) {
        // Replaced by a newer run: that run owns the state now.
        if (ac.current !== ctrl) return;
        if (ctrl.signal.aborted) {
          setState((s) => ({ ...s, columns, rows, running: false, error: "Query cancelled" }));
          doneRef.current?.({ sql, ms: performance.now() - started, error: "cancelled" });
          return;
        }
        const msg = (e as Error).message || String(e);
        setState((s) => ({ ...s, columns, rows, running: false, error: msg }));
        doneRef.current?.({ sql, ms: performance.now() - started, error: msg });
      } finally {
        if (ac.current === ctrl) ac.current = null;
      }
    },
    [driver],
  );

  const abort = useCallback(() => {
    ac.current?.abort();
  }, []);

  useEffect(() => () => ac.current?.abort(), []);

  const patchRows = useCallback((fn: (rows: Cell[][]) => Cell[][]) => setState((s) => ({ ...s, rows: fn(s.rows) })), []);

  return { state, run, abort, patchRows };
}
