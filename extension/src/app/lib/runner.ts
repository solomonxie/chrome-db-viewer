// Probes dbui-runner with a short-lived native port (DESIGN.md §3.2, §5.2).

import { PROTOCOL_VERSION, RUNNER_HOST, type RunnerMessage } from "@core/runner-protocol";

export type RunnerStatus =
  | { state: "checking" }
  | { state: "ok"; version: string; protocol: number; drivers: string[] }
  | { state: "missing" }
  | { state: "outdated"; version: string; protocol: number }
  | { state: "crashed"; message: string }
  | { state: "unavailable"; message: string };

export function classifyRunnerError(message: string | undefined): RunnerStatus {
  const m = message ?? "";
  if (/not found/i.test(m)) return { state: "missing" };
  if (/exited/i.test(m)) return { state: "crashed", message: m };
  return { state: "unavailable", message: m || "No response from the runner" };
}

export function probeRunner(timeoutMs = 3000): Promise<RunnerStatus> {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.connectNative) {
      resolve({ state: "unavailable", message: "Native messaging is only available inside the extension." });
      return;
    }
    let done = false;
    let port: chrome.runtime.Port;
    const finish = (s: RunnerStatus) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch {
        /* already closed */
      }
      resolve(s);
    };
    const timer = setTimeout(() => finish({ state: "unavailable", message: "The runner did not answer in time." }), timeoutMs);
    try {
      port = chrome.runtime.connectNative(RUNNER_HOST);
    } catch (e) {
      finish(classifyRunnerError((e as Error).message));
      return;
    }
    port.onDisconnect.addListener(() => finish(classifyRunnerError(chrome.runtime.lastError?.message)));
    port.onMessage.addListener((msg: RunnerMessage) => {
      if (msg.type === "hello") {
        finish(
          msg.protocol < PROTOCOL_VERSION
            ? { state: "outdated", version: msg.runner, protocol: msg.protocol }
            : { state: "ok", version: msg.runner, protocol: msg.protocol, drivers: msg.drivers },
        );
      } else if (msg.type === "error") {
        finish({ state: "unavailable", message: msg.message });
      }
    });
    port.postMessage({ id: 1, op: "hello", client: chrome.runtime.getManifest?.().version ?? "0" });
  });
}

/** URL of the signed per-user package. Placeholder until the release pipeline exists. */
export const RUNNER_PKG_URL = "https://dbui.invalid/download/dbui-runner-latest.pkg";

export const runnerDrivers = new Set(["postgres", "redis"]);
