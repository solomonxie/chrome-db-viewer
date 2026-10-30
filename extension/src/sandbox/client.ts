// App-side client for the script sandbox (DESIGN.md §3.14, §3.15). Called from app.html.
//
// A hidden <iframe src="sandbox.html"> is created lazily and reused. Inside it, every run gets
// its own Web Worker. On timeout the client sends { type: "cancel", id } and the sandbox page
// terminates that worker, so a busy loop dies without reloading the frame. If the sandbox
// reports it can't start Workers (inline mode), or the frame stops answering, the client
// removes the iframe instead and the next run creates a fresh one.

import type { ResultTable, SandboxRequest, SandboxResponse } from "../collections/model";
import { DEFAULT_TIMEOUT_MS } from "./execute";

/** A request without an id; runScript assigns one when missing. */
export type ScriptRequest = SandboxRequest extends infer R ? (R extends SandboxRequest ? Omit<R, "id"> & { id?: string } : never) : never;

export type Executor = (req: SandboxRequest) => Promise<SandboxResponse>;

interface Pending {
  resolve: (res: SandboxResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Frame {
  iframe: HTMLIFrameElement;
  ready: Promise<{ worker: boolean }>;
  pending: Map<string, Pending>;
  worker: boolean;
}

let frame: Frame | undefined;
let listening = false;
let seq = 0;

function sandboxUrl(): string {
  const rt = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;
  return rt?.getURL ? rt.getURL("sandbox.html") : "sandbox.html";
}

function empty(id: string, error: string): SandboxResponse {
  return { id, ok: false, varChanges: {}, envChanges: {}, tests: [], logs: [], error };
}

function onMessage(e: MessageEvent) {
  const f = frame;
  if (!f || e.source !== f.iframe.contentWindow) return;
  const msg = e.data as (SandboxResponse & { type?: undefined }) | { type: "ready"; worker: boolean } | undefined;
  if (!msg || typeof msg !== "object") return;
  if ("type" in msg && msg.type === "ready") {
    readyResolvers.get(f)?.({ worker: msg.worker });
    return;
  }
  const res = msg as SandboxResponse;
  if (typeof res.id !== "string") return;
  const p = f.pending.get(res.id);
  if (!p) return;
  f.pending.delete(res.id);
  clearTimeout(p.timer);
  p.resolve(res);
}

const readyResolvers = new WeakMap<Frame, (v: { worker: boolean }) => void>();

function getFrame(): Frame {
  if (frame) return frame;
  if (!listening) {
    window.addEventListener("message", onMessage);
    listening = true;
  }
  const iframe = document.createElement("iframe");
  iframe.src = sandboxUrl();
  iframe.title = "dbui script sandbox";
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  iframe.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
  const f = { iframe, pending: new Map(), worker: true } as unknown as Frame;
  f.ready = new Promise<{ worker: boolean }>((resolve, reject) => {
    readyResolvers.set(f, (v) => {
      f.worker = v.worker;
      resolve(v);
    });
    iframe.addEventListener("error", () => reject(new Error("Script sandbox failed to load")));
    setTimeout(() => reject(new Error("Script sandbox did not start")), 10_000);
  });
  f.ready.catch(() => {
    if (frame === f) teardown();
  });
  document.body.appendChild(iframe);
  frame = f;
  return f;
}

/** Remove the sandbox frame; pending runs fail. The next run creates a new one. */
export function teardown(reason = "Script sandbox was reset"): void {
  const f = frame;
  if (!f) return;
  frame = undefined;
  for (const [id, p] of f.pending) {
    clearTimeout(p.timer);
    p.resolve(empty(id, reason));
  }
  f.pending.clear();
  f.iframe.remove();
}

/** Run one script in the sandbox. Never rejects: failures come back as { ok: false, error }. */
export async function runScript(input: ScriptRequest): Promise<SandboxResponse> {
  const id = input.id ?? `s${Date.now().toString(36)}_${++seq}`;
  const req = { ...input, id } as SandboxRequest;
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let f: Frame;
  try {
    f = getFrame();
    await f.ready;
  } catch (e) {
    return empty(id, e instanceof Error ? e.message : String(e));
  }
  if (frame !== f) return empty(id, "Script sandbox was reset");
  return new Promise<SandboxResponse>((resolve) => {
    const timer = setTimeout(() => {
      if (!f.pending.has(id)) return;
      f.pending.delete(id);
      const secs = Math.round((timeoutMs / 1000) * 10) / 10;
      const res = empty(id, `Script timed out after ${secs}s`);
      if (f.worker) {
        // The sandbox page is free (the busy loop is in the worker): kill just that worker.
        f.iframe.contentWindow?.postMessage({ type: "cancel", id }, "*");
      } else if (frame === f) {
        // Inline mode: the loop is on the frame's own thread, so drop the whole frame.
        teardown("Script sandbox was reset after a timeout");
      }
      resolve(res);
    }, timeoutMs);
    f.pending.set(id, { resolve, timer });
    try {
      f.iframe.contentWindow?.postMessage(req, "*");
    } catch (e) {
      f.pending.delete(id);
      clearTimeout(timer);
      resolve(empty(id, `Could not send the script to the sandbox: ${String(e)}`));
    }
  });
}

// ---- running a chain of scripts (collection → folder → query) ----

export interface ChainResult {
  ok: boolean;
  /** All variables after the chain: input vars with every change applied (null = unset, removed). */
  vars: Record<string, unknown>;
  /** Net variable changes across the chain. */
  varChanges: Record<string, unknown>;
  envChanges: Record<string, unknown>;
  tests: { name: string; passed: boolean }[];
  logs: string[];
  error?: string;
  /** Index into the chain of the script that failed. */
  failedAt?: number;
}

async function runChain(
  kind: "pre" | "post",
  chain: string[],
  vars: Record<string, unknown>,
  env: Record<string, unknown>,
  result: ResultTable | undefined,
  exec: Executor,
  timeoutMs?: number,
  results?: ResultTable[],
): Promise<ChainResult> {
  const out: ChainResult = { ok: true, vars: { ...vars }, varChanges: {}, envChanges: {}, tests: [], logs: [] };
  let curEnv = { ...env };
  for (let i = 0; i < chain.length; i++) {
    const code = chain[i];
    if (!code || !code.trim()) continue;
    const id = `${kind}_${Date.now().toString(36)}_${++seq}`;
    const res = await exec({ id, kind, code, vars: out.vars, env: curEnv, result, timeoutMs, ...(results ? { results } : {}) });
    for (const [k, v] of Object.entries(res.varChanges ?? {})) {
      out.varChanges[k] = v;
      if (v === null) delete out.vars[k];
      else out.vars[k] = v;
    }
    Object.assign(out.envChanges, res.envChanges ?? {});
    // Later scripts see earlier env writes, though they aren't applied until the user confirms.
    curEnv = { ...curEnv, ...(res.envChanges ?? {}) };
    out.tests.push(...(res.tests ?? []));
    out.logs.push(...(res.logs ?? []));
    if (!res.ok) {
      out.ok = false;
      out.error = res.error ?? "Script failed";
      out.failedAt = i;
      break;
    }
  }
  return out;
}

/** Run pre-run scripts in order (collection → folder → query), threading variables; stop at the first failure. */
export function runPreScripts(
  chain: string[],
  vars: Record<string, unknown>,
  env: Record<string, unknown>,
  opts: { exec?: Executor; timeoutMs?: number } = {},
): Promise<ChainResult> {
  return runChain("pre", chain, vars, env, undefined, opts.exec ?? runScript, opts.timeoutMs);
}

/** Run post-run scripts in order (query → folder → collection) against the result; stop at the first failure. */
export function runPostScripts(
  chain: string[],
  vars: Record<string, unknown>,
  env: Record<string, unknown>,
  result: ResultTable,
  opts: { exec?: Executor; timeoutMs?: number; results?: ResultTable[] } = {},
): Promise<ChainResult> {
  return runChain("post", chain, vars, env, result, opts.exec ?? runScript, opts.timeoutMs, opts.results);
}
