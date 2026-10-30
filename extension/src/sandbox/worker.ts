// Per-run Web Worker inside sandbox.html. Bundled inline by Vite (?worker&inline) so it starts
// from a blob: URL, inheriting the sandbox page's CSP (unsafe-eval allowed, connect-src 'none').
// The sandbox page terminates it on timeout, which is the only way to stop a busy loop.

import type { SandboxRequest } from "../collections/model";
import { executeScript, hardenGlobals } from "./execute";

hardenGlobals(self as unknown as Record<string, unknown>);

self.onmessage = async (e: MessageEvent<{ req: SandboxRequest }>) => {
  const res = await executeScript(e.data.req);
  try {
    self.postMessage(res);
  } catch (err) {
    self.postMessage({ ...res, ok: false, result: undefined, error: `Result could not be sent back: ${String(err)}` });
  }
};
