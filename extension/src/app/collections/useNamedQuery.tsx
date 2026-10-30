// Everything a query tab needs when it's bound to a named query (DESIGN.md §3.14): the
// collection it lives in, resolved variables, the live render, plain SQL parameters, pre/post
// scripts, and saving the template back. QueryView calls this and renders the pieces.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Cell, Column } from "@core/types";
import type { NamedQuery, ResultTable, VarType } from "../../collections/model";
import { analyze, bindSqlParams, detectSqlParams, render, type DialectName, type SqlParam, type TemplateAnalysis } from "../../collections/render";
import {
  activeEnvironment,
  libraryFromRows,
  loadBundle,
  loadQuery,
  onCollectionsChanged,
  pathOf,
  resolveVars,
  saveCollection,
  saveQuery,
  scriptChain,
  sessionVars,
  setSessionVars,
  valuesOf,
  type CollectionBundle,
  type VarSource,
} from "../../collections/store";
import { guessVarType } from "../../collections/params";
import { runPostScripts, runPreScripts, type ChainResult } from "../../sandbox/client";
import type { ConnCtx } from "../conn/model";

export interface ParamRow {
  /** Variable name, or the SQL parameter key ("@d", "$1", "?1"). */
  key: string;
  label: string;
  kind: "var" | "sql";
  type: VarType;
  value: unknown;
  source?: VarSource;
  required: boolean;
  secret?: boolean;
}

export interface ScriptOutput {
  tests: { name: string; passed: boolean }[];
  logs: string[];
  error?: string;
}

export interface NamedQueryState {
  query: NamedQuery;
  bundle: CollectionBundle;
  path: string;
  dialect: DialectName;
  analysis: TemplateAnalysis | null;
  /** Final SQL with every variable filled in, or null when it can't render yet. */
  rendered: string | null;
  renderError: string | null;
  sqlParams: SqlParam[];
  rows: ParamRow[];
  missing: string[];
  dirty: boolean;
  scripts: ScriptOutput | null;
  hasScripts: boolean;
  /** Script environment writes waiting for the user's OK. */
  pendingEnv: Record<string, unknown> | null;
  setValue: (row: ParamRow, value: unknown) => void;
  saveAsDefault: (row: ParamRow) => Promise<void>;
  saveToEnvironment: (row: ParamRow) => Promise<void>;
  setActiveEnvironment: (id: string | undefined) => Promise<void>;
  /** Runs pre scripts, renders and binds. Null when something stopped the run (reported via toast/scripts). */
  prepare: () => Promise<{ sql: string; params: Cell[] } | null>;
  afterRun: (result: { columns: Column[]; rows: Cell[][] }) => Promise<void>;
  save: () => Promise<void>;
  applyEnv: (ok: boolean) => Promise<void>;
}

const hasValue = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

export function useNamedQuery(ctx: ConnCtx, queryId: string | undefined, template: string): NamedQueryState | null {
  const [bundle, setBundle] = useState<CollectionBundle | null>(null);
  const [version, setVersion] = useState(0);
  const [positional, setPositional] = useState<Record<string, unknown>>({});
  const [scripts, setScripts] = useState<ScriptOutput | null>(null);
  const [pendingEnv, setPendingEnv] = useState<Record<string, unknown> | null>(null);
  const dialect = ctx.driver.dialect.name;

  useEffect(() => onCollectionsChanged(() => setVersion((v) => v + 1)), []);

  const query0 = useQueryRow(queryId, version);
  const collectionId = query0?.collectionId;
  useEffect(() => {
    if (!collectionId) return setBundle(null);
    let cancelled = false;
    loadBundle(collectionId).then((b) => !cancelled && setBundle(b ?? null), () => !cancelled && setBundle(null));
    return () => {
      cancelled = true;
    };
  }, [collectionId, version]);

  const query = bundle?.queries.find((q) => q.id === queryId) ?? null;
  const session = collectionId ? sessionVars(collectionId) : {};

  const library = useMemo(() => {
    if (!bundle || !query) return undefined;
    const others = libraryFromRows(bundle.folders, bundle.queries.filter((q) => q.id !== query.id));
    const self = pathOf(query, bundle.folders);
    return { resolve: (p: string) => (p === self ? template : others.resolve(p)) };
  }, [bundle, query, template]);
  const path = bundle && query ? pathOf(query, bundle.folders) : "";

  const analysis = useMemo(() => {
    if (!query) return null;
    try {
      return analyze(template, { dialect, vars: {}, library }, path);
    } catch {
      return null;
    }
  }, [template, dialect, library, path, query]);
  const analysisError = useMemo(() => {
    if (!query || analysis) return null;
    try {
      analyze(template, { dialect, vars: {}, library }, path);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }, [analysis, template, dialect, library, path, query]);

  const resolved = useMemo(
    () => (bundle && query ? resolveVars({ collection: bundle.collection, query, session, templateDefaults: analysis?.varDefaults }) : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bundle, query, version, analysis, JSON.stringify(session)],
  );
  const values = useMemo(() => valuesOf(resolved), [resolved]);

  const draft = useMemo(() => {
    if (!query || !analysis) return { sql: null as string | null, error: analysisError };
    try {
      return { sql: render(template, { dialect, vars: values, library }, path).sql, error: null };
    } catch (e) {
      return { sql: null, error: (e as Error).message };
    }
  }, [query, analysis, analysisError, template, dialect, values, library, path]);

  const sqlParams = useMemo(() => detectSqlParams(draft.sql ?? template, dialect), [draft.sql, template, dialect]);

  const rows: ParamRow[] = useMemo(() => {
    if (!query || !bundle) return [];
    const defs = new Map([...bundle.collection.vars, ...query.vars].map((v) => [v.name, v]));
    const out: ParamRow[] = (analysis?.usedVars ?? []).map((name) => {
      const def = defs.get(name);
      const r = resolved[name];
      return { key: name, label: name, kind: "var", type: guessVarType(name, r?.value ?? def?.value, def?.type), value: r?.value, source: r?.source, required: !!analysis?.requiredVars.includes(name), secret: def?.secret };
    });
    for (const p of sqlParams) {
      if (p.style === "named") {
        if (out.some((r) => r.key === p.name)) continue;
        const r = resolved[p.name];
        const def = defs.get(p.name);
        out.push({ key: p.name, label: `@${p.name}`, kind: "sql", type: guessVarType(p.name, r?.value ?? def?.value, def?.type), value: r?.value, source: r?.source, required: true });
      } else {
        out.push({ key: p.key, label: p.name, kind: "sql", type: guessVarType(p.name, positional[p.key]), value: positional[p.key], source: positional[p.key] !== undefined ? "session" : undefined, required: true });
      }
    }
    return out;
  }, [query, bundle, analysis, resolved, sqlParams, positional]);

  const missing = rows.filter((r) => r.required && !hasValue(r.value)).map((r) => r.label);

  const setValue = useCallback(
    (row: ParamRow, value: unknown) => {
      if (!collectionId) return;
      if (row.kind === "sql" && !row.key.match(/^[A-Za-z_]/)) setPositional((p) => ({ ...p, [row.key]: value }));
      else setSessionVars(collectionId, { [row.key]: value === undefined ? null : value });
    },
    [collectionId],
  );

  const sqlParamValues = useCallback(() => {
    const out: Record<string, unknown> = { ...positional };
    for (const p of sqlParams) if (p.style === "named") out[p.key] = values[p.name];
    return out;
  }, [positional, sqlParams, values]);

  if (!queryId || !query || !bundle) return null;

  const collection = bundle.collection;
  const env = activeEnvironment(collection);
  const chain = scriptChain(collection, bundle.folders, query);

  const applyResult = (r: ChainResult) => {
    if (Object.keys(r.varChanges).length) setSessionVars(collection.id, r.varChanges);
    if (Object.keys(r.envChanges).length) setPendingEnv(r.envChanges);
  };

  return {
    query,
    bundle,
    path,
    dialect,
    analysis,
    rendered: draft.sql,
    renderError: draft.error,
    sqlParams,
    rows,
    missing,
    dirty: template !== query.sql,
    scripts,
    hasScripts: chain.pre.length + chain.post.length > 0,
    pendingEnv,
    setValue,
    async saveAsDefault(row) {
      const vars = query.vars.some((v) => v.name === row.key)
        ? query.vars.map((v) => (v.name === row.key ? { ...v, value: row.value, type: v.type ?? row.type } : v))
        : [...query.vars, { name: row.key, type: row.type, value: row.value }];
      await saveQuery({ ...query, vars });
      setSessionVars(collection.id, { [row.key]: null });
      ctx.toast(`Saved ${row.key} as this query's default`);
    },
    async saveToEnvironment(row) {
      if (!env) return ctx.toast("No active environment. Pick or create one in the collection settings.");
      await saveCollection({ ...collection, environments: collection.environments.map((e) => (e.id === env.id ? { ...e, values: { ...e.values, [row.key]: row.value } } : e)) });
      setSessionVars(collection.id, { [row.key]: null });
      ctx.toast(`Saved ${row.key} to environment "${env.name}"`);
    },
    async setActiveEnvironment(id) {
      await saveCollection({ ...collection, activeEnvironmentId: id });
    },
    async prepare() {
      if (missing.length) {
        ctx.toast(`Fill in ${missing.join(", ")} before running.`);
        return null;
      }
      let vars = values;
      setScripts(null);
      if (chain.pre.length) {
        const r = await runPreScripts(chain.pre, vars, { ...(env?.values ?? {}) });
        setScripts({ tests: r.tests, logs: r.logs, error: r.ok ? undefined : `Pre-run script failed: ${r.error}` });
        applyResult(r);
        if (!r.ok) {
          ctx.toast(`Pre-run script failed: ${r.error}`);
          return null;
        }
        vars = r.vars;
      }
      try {
        const sql = render(template, { dialect, vars, library }, path).sql;
        const named = { ...sqlParamValues() };
        for (const p of sqlParams) if (p.style === "named") named[p.key] = vars[p.name];
        return bindSqlParams(sql, dialect, named);
      } catch (e) {
        ctx.toast((e as Error).message);
        return null;
      }
    },
    async afterRun(result) {
      if (!chain.post.length) return;
      const table: ResultTable = { columns: result.columns, rows: result.rows };
      const r = await runPostScripts(chain.post, { ...values, ...sessionVars(collection.id) }, { ...(env?.values ?? {}) }, table);
      setScripts((s) => ({ tests: [...(s?.tests ?? []), ...r.tests], logs: [...(s?.logs ?? []), ...r.logs], error: r.ok ? s?.error : `Post-run script failed: ${r.error}` }));
      applyResult(r);
    },
    async save() {
      await saveQuery({ ...query, sql: template });
      ctx.toast(`Saved "${path}"`);
    },
    async applyEnv(ok) {
      const changes = pendingEnv;
      setPendingEnv(null);
      if (!ok || !changes) return;
      if (!env) return ctx.toast("No active environment to write to.");
      const values2 = { ...env.values };
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) delete values2[k];
        else values2[k] = v;
      }
      await saveCollection({ ...collection, environments: collection.environments.map((e) => (e.id === env.id ? { ...e, values: values2 } : e)) });
      ctx.toast(`Updated environment "${env.name}"`);
    },
  };
}

function useQueryRow(queryId: string | undefined, version: number): NamedQuery | null {
  const [row, setRow] = useState<NamedQuery | null>(null);
  useEffect(() => {
    if (!queryId) return setRow(null);
    let cancelled = false;
    loadQuery(queryId).then(
      (q) => !cancelled && setRow(q ?? null),
      () => !cancelled && setRow(null),
    );
    return () => {
      cancelled = true;
    };
  }, [queryId, version]);
  return row;
}
