// Entry of sandbox.html, the sandboxed extension page (manifest "sandbox.pages") where
// `new Function` is allowed. No extension APIs, opaque origin, CSP connect-src 'none'.
//
// Protocol with the parent (client.ts):
//   parent → sandbox: SandboxRequest              run it
//   parent → sandbox: { type: "cancel", id }      kill that run's worker
//   sandbox → parent: { type: "ready", worker }   page loaded; worker=false means inline mode
//   sandbox → parent: SandboxResponse             one per request, matched by id
//
// Each run gets its own Worker so a timeout can terminate it without reloading the frame.
// If Workers can't start here, scripts run inline on this page and the client recreates the
// frame on timeout instead.

import type { SandboxRequest, SandboxResponse } from "../collections/model";
import { executeScript, hardenGlobals } from "./execute";
import ExecWorker from "./worker?worker&inline";

// Our extension origin: location.origin is "null" in a sandboxed page, the href isn't.
const parentOrigin = new URL(location.href).origin;
const running = new Map<string, Worker>();

function workersWork(): boolean {
  try {
    const w = new ExecWorker();
    w.terminate();
    return true;
  } catch {
    return false;
  }
}

const useWorker = workersWork();

// Inline mode runs user code on this page, so strip its network globals. In worker mode the
// worker hardens itself and this page keeps Worker/Blob for spawning.
if (!useWorker) hardenGlobals(window as unknown as Record<string, unknown>);

function reply(msg: SandboxResponse | { type: "ready"; worker: boolean }) {
  window.parent.postMessage(msg, parentOrigin === "null" ? "*" : parentOrigin);
}

function failure(id: string, error: string): SandboxResponse {
  return { id, ok: false, varChanges: {}, envChanges: {}, tests: [], logs: [], error };
}

function runInWorker(req: SandboxRequest) {
  let w: Worker;
  try {
    w = new ExecWorker();
  } catch (e) {
    reply(failure(req.id, `Could not start the script worker: ${String(e)}`));
    return;
  }
  running.set(req.id, w);
  const done = (res: SandboxResponse) => {
    if (running.get(req.id) !== w) return;
    running.delete(req.id);
    w.terminate();
    reply(res);
  };
  w.onmessage = (e: MessageEvent<SandboxResponse>) => done(e.data);
  w.onerror = (e) => {
    e.preventDefault();
    done(failure(req.id, e.message || "Script worker crashed"));
  };
  w.onmessageerror = () => done(failure(req.id, "Script result could not be read"));
  w.postMessage({ req });
}

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window.parent) return;
  if (parentOrigin !== "null" && e.origin !== parentOrigin) return;
  const msg = e.data as SandboxRequest | { type: "cancel"; id: string } | undefined;
  if (!msg || typeof msg !== "object" || typeof msg.id !== "string") return;
  if ("type" in msg && msg.type === "cancel") {
    running.get(msg.id)?.terminate();
    running.delete(msg.id);
    return;
  }
  if (!("kind" in msg)) return;
  if (useWorker) runInWorker(msg);
  else void executeScript(msg).then(reply);
});

reply({ type: "ready", worker: useWorker });
