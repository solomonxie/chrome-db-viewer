// A BigQuery query tab with DECLARE: Run all sends one script job, and Run at the cursor sends
// the DECLAREs/SETs above the statement along with it. Other engines still split at ';'.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, test } from "vitest";
import { QueryView } from "../../src/app/conn/QueryView";
import type { ConnCtx } from "../../src/app/conn/model";
import { ToastProvider } from "../../src/app/components/ui";
import { createDemoDriver, DEMO_CONNECTION } from "../../src/app/demo/demoDriver";
import { bigqueryDialect } from "../../src/core/sql";
import type { Driver, ScriptResult, Statement } from "../../src/core/types";
import { splitStatementsRaw } from "../../src/collections/split";
import { isScriptSetup } from "../../src/collections/bqScript";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SCRIPT = readFileSync(resolve(__dirname, "../fixtures/sql/bq-declare-script.sql"), "utf8");

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

/**
 * The demo driver, recording each SQL it's asked to run; `bq` makes it speak BigQuery, and
 * `script` adds runScript, answering one result per non-setup statement.
 */
function recordingDriver(bq: boolean, script = false) {
  const sent: string[] = [];
  const d = createDemoDriver();
  const execute = d.execute.bind(d);
  const driver = Object.assign(Object.create(d), {
    dialect: bq ? bigqueryDialect : d.dialect,
    execute: (stmt: Statement, signal?: AbortSignal) => {
      sent.push(stmt.sql);
      return execute({ ...stmt, sql: "SELECT * FROM orders LIMIT 3" }, signal);
    },
    ...(script
      ? {
          runScript: async (stmt: Statement): Promise<ScriptResult[]> => {
            sent.push(stmt.sql);
            return splitStatementsRaw(stmt.sql)
              .filter((x) => !isScriptSetup(x))
              .map((sql, i) => ({ sql, columns: [{ name: "n", type: "INT64", nullable: true }], rows: [[String(i + 1)]], summary: { rowCount: 1, ms: 1 } }));
          },
        }
      : {}),
  }) as Driver;
  return { driver, sent, inner: d };
}

async function mount(driver: Driver, sql = SCRIPT) {
  const ctx = {
    cfg: { id: "c", name: "c", driver: "bigquery", env: "dev", readOnly: false, options: {} },
    driver,
    caps: { ...driver.capabilities(), costEstimate: false },
    readOnly: false,
    pending: { tables: new Map() },
    setPending: () => {},
    nodeTypes: new Map(),
    sqlName: (p: string[]) => p.join("."),
    describe: async () => ({ columns: [] }),
    toast: () => {},
    addHistory: () => {},
    resolveTable: (r: string) => [r],
    editMode: "grid",
  } as unknown as ConnCtx;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <ToastProvider>
        <QueryView ctx={ctx} sql={sql} title="Query" active onSql={() => {}} onDetails={() => {}} onSaved={() => {}} />
      </ToastProvider>,
    ),
  );
}
const buttons = () => [...host!.querySelectorAll<HTMLButtonElement>(".edbar .btn")];
const wait = () => act(() => new Promise((r) => setTimeout(r, 50)));

test("Run all on BigQuery shows one result tab per query in the script, all from one job", async () => {
  const { driver, sent } = recordingDriver(true, true);
  await mount(driver);
  await act(async () => buttons().find((b) => b.textContent?.startsWith("Run all"))!.click());
  await wait();
  expect(sent).toHaveLength(1);
  const tabs = [...host!.querySelectorAll<HTMLButtonElement>(".stmt-tab")];
  expect(tabs.map((t) => t.textContent)).toEqual(["Result 1", "Result 2"]);
  expect(tabs.map((t) => t.title)).toEqual(["SELECT ad_key_hash, COUNT(*) AS clicks", "SELECT COUNT(*) FROM clicks WHERE day = end_date"]);
  await act(async () => tabs[1]!.click());
  expect(host!.querySelector(".stmt-tab[aria-selected=true]")!.textContent).toBe("Result 2");
});

test("without runScript, Run all on BigQuery still sends the whole DECLARE script as one job", async () => {
  const { driver, sent } = recordingDriver(true);
  await mount(driver);
  await act(async () => buttons().find((b) => b.textContent?.startsWith("Run all"))!.click());
  await wait();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("DECLARE end_date");
  expect(sent[0]).toContain("SELECT COUNT(*) FROM clicks WHERE day = end_date");
});

test("Run at the cursor on BigQuery brings the DECLARE and SET above the statement", async () => {
  const { driver, sent } = recordingDriver(true);
  await mount(driver);
  const ta = host!.querySelector<HTMLTextAreaElement>("textarea[aria-label='SQL editor']")!;
  const at = SCRIPT.indexOf("GROUP BY");
  ta.setSelectionRange(at, at);
  await act(async () => buttons().find((b) => b.textContent?.startsWith("Run") && !b.textContent.startsWith("Run all"))!.click());
  await wait();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.split(";\n").map((s) => s.split(/\s+/).slice(0, 2).join(" "))).toEqual(["-- Window", "SET end_date", "SELECT ad_key_hash,"]);
});

test("other engines still run each statement as its own query", async () => {
  const { driver, sent } = recordingDriver(false);
  await mount(driver);
  await act(async () => buttons().find((b) => b.textContent?.startsWith("Run all"))!.click());
  await wait();
  // Split at ';': the first statement goes on its own (and Run all stops when it fails).
  expect(sent[0]).toBe("-- Window for the report.\nDECLARE end_date DATE DEFAULT CURRENT_DATE()");
});

test("query results have an Export menu with CSV, TSV, JSON array and JSON Lines", async () => {
  const { driver, inner } = recordingDriver(false);
  await inner.connect(DEMO_CONNECTION);
  await mount(driver, "SELECT * FROM orders LIMIT 3");
  await act(async () => buttons().find((b) => b.textContent?.startsWith("Run all"))!.click());
  for (let i = 0; i < 20 && !host!.querySelector(".foot .btn"); i++) await wait();
  const exp = [...host!.querySelectorAll<HTMLButtonElement>(".foot .btn")].find((b) => b.textContent === "Export")!;
  expect(exp).toBeDefined();
  await act(async () => exp.click());
  expect([...document.querySelectorAll(".menu [role=menuitem]")].map((m) => m.textContent)).toEqual(["CSV", "TSV", "JSON array", "JSON Lines"]);
});
