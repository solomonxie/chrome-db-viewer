// RunnerDriver against a fake chrome.runtime.connectNative port that replays a session
// recorded from the real dbui-runner (tests/fixtures/runner/sessions.json, written by
// runner/tests/integration/record_fixture.py).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { collect, DriverError } from "@core/types";
import type { ChangeSet, ConnectionConfig } from "@core/types";
import { checkRunner, createDriver, RunnerDriver, toRunnerConfig } from "../../../src/drivers/runner/index";

interface Exchange {
  request: Record<string, unknown>;
  responses: Record<string, unknown>[];
  afterCancel?: Record<string, unknown>[];
}
interface Sessions {
  postgres: Exchange[];
  redis: Exchange[];
}

const sessions: Sessions = JSON.parse(
  readFileSync(resolve(__dirname, "../../fixtures/runner/sessions.json"), "utf8"),
);

type Fn = (...args: never[]) => void;

/**
 * Fake native port. Each postMessage must match the next recorded request (minus its id);
 * the recorded responses come back with the request's id, asynchronously like Chrome.
 */
class ReplayPort {
  /** When set, requests are accepted and never answered (a host that never replies). */
  silent = false;
  sent: Record<string, unknown>[] = [];
  disconnected = false;
  private msgListeners: Fn[] = [];
  private discListeners: Fn[] = [];
  private pendingCancel: { id: number; responses: Record<string, unknown>[] } | null = null;

  constructor(private script: Exchange[]) {}

  onMessage = { addListener: (f: Fn) => this.msgListeners.push(f) };
  onDisconnect = { addListener: (f: Fn) => this.discListeners.push(f) };

  postMessage(msg: Record<string, unknown>) {
    this.sent.push(msg);
    if (this.silent) return;
    const { id, ...req } = msg;
    const next = this.script.shift();
    if (!next) throw new Error(`unexpected request ${JSON.stringify(msg)}`);
    if (req.op === "cancel") {
      expect(next.request.op).toBe("cancel");
      expect(req.target).toBe(this.pendingCancel?.id);
    } else {
      expect(req).toEqual(next.request);
    }
    const replies = next.responses.map((r) => ({ ...r, id }));
    if (next.afterCancel) this.pendingCancel = { id: id as number, responses: next.afterCancel };
    if (req.op === "cancel" && this.pendingCancel) {
      const target = this.pendingCancel;
      this.pendingCancel = null;
      replies.push(...target.responses.map((r) => ({ ...r, id: target.id })));
    }
    for (const r of replies) setTimeout(() => this.emit(r), 0);
  }

  emit(msg: Record<string, unknown>) {
    for (const f of this.msgListeners) (f as (m: unknown) => void)(msg);
  }

  /** Simulates Chrome closing the port, e.g. the host is missing or exited. */
  fail(lastError: string) {
    (globalThis as { chrome: { runtime: { lastError?: { message: string } } } }).chrome.runtime.lastError = { message: lastError };
    for (const f of this.discListeners) (f as () => void)();
    (globalThis as { chrome: { runtime: { lastError?: unknown } } }).chrome.runtime.lastError = undefined;
  }

  disconnect() {
    this.disconnected = true;
  }
}

function installChrome(makePort: () => ReplayPort) {
  const ports: ReplayPort[] = [];
  const connectNative = vi.fn((host: string) => {
    expect(host).toBe("com.dbui.runner");
    const p = makePort();
    ports.push(p);
    return p;
  });
  vi.stubGlobal("chrome", { runtime: { connectNative, lastError: undefined } });
  return { ports, connectNative };
}

function script(name: keyof Sessions): Exchange[] {
  return structuredClone(sessions[name]);
}

/** The recorded exchanges for driver `name` starting at the first request with op `op`. */
function from(name: keyof Sessions, op: string, sql?: string): Exchange[] {
  const s = script(name);
  const head = s.slice(0, 2); // hello + connect
  const i = s.findIndex((e) => e.request.op === op && (sql === undefined || e.request.sql === sql));
  return [...head, ...s.slice(i)];
}

const pgConfig: ConnectionConfig = {
  id: "c1",
  name: "local pg",
  driver: "postgres",
  env: "local",
  readOnly: false,
  options: { host: "127.0.0.1", port: 15432, user: "postgres", database: "dbui" },
};

const redisConfig: ConnectionConfig = {
  id: "c2",
  name: "local redis",
  driver: "redis",
  env: "local",
  readOnly: false,
  options: { host: "127.0.0.1", port: "16379" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

test("connect sends hello then connect and reports the server version", async () => {
  const { ports } = installChrome(() => new ReplayPort(script("postgres")));
  const driver = createDriver();
  const { serverVersion } = await driver.connect(pgConfig);
  expect(serverVersion).toMatch(/^PostgreSQL 17/);
  expect(ports[0]!.sent.map((m) => m.op)).toEqual(["hello", "connect"]);
  expect(ports[0]!.sent.map((m) => m.id)).toEqual([1, 2]);
  expect(driver.id).toBe("postgres");
  expect(driver.dialect.name).toBe("postgres");
  expect(driver.capabilities().kind).toBe("relational");
});

test("listObjects and describe return the runner's nodes and schema", async () => {
  installChrome(() => new ReplayPort(script("postgres")));
  const driver = createDriver();
  await driver.connect(pgConfig);
  const schemas = await driver.listObjects([]);
  expect(schemas.map((n) => n.name)).toContain("shop");
  const tables = await driver.listObjects(["shop", "tables"]);
  expect(tables.map((n) => n.name)).toEqual(["customers", "events", "orders"]);
  const schema = await driver.describe(["shop", "tables", "customers"]);
  expect(schema.columns[0]).toMatchObject({ name: "id", type: "bigint", primaryKey: true, nullable: false });
  expect(schema.ddl).toContain('CREATE TABLE "shop"."customers"');
});

test("execute yields pages with columns on the first one and returns the summary", async () => {
  installChrome(() => new ReplayPort(from("postgres", "execute")));
  const driver = createDriver();
  await driver.connect(pgConfig);
  const gen = driver.execute({ sql: "select id, total, paid, qty, weight, meta from shop.orders order by id", pageSize: 2 });
  const first = await gen.next();
  expect(first.done).toBe(false);
  if (first.done) return;
  expect(first.value.seq).toBe(0);
  expect(first.value.columns?.map((c) => c.type)).toEqual(["int8", "numeric", "bool", "int4", "float8", "jsonb"]);
  expect(first.value.rows[0]).toEqual(["1", "12.50", true, 2, 1.25, { source: "web", tags: ["a", "b"] }]);
  const second = await gen.next();
  expect(second.done).toBe(false);
  if (second.done) return;
  expect(second.value.seq).toBe(1);
  expect(second.value.columns).toBeUndefined();
  expect(second.value.rows[0]?.[1]).toBe("9007199254740993.10");
  const end = await gen.next();
  expect(end).toEqual({ done: true, value: { rowCount: 3, ms: 5 } });
});

test("a runner error becomes a DriverError with the SQLSTATE code", async () => {
  installChrome(() => new ReplayPort(from("postgres", "execute", "select * from shop.nope")));
  const driver = createDriver();
  await driver.connect(pgConfig);
  const err = await collect(driver.execute({ sql: "select * from shop.nope", pageSize: 2000 })).catch((e) => e);
  expect(err).toBeInstanceOf(DriverError);
  expect(err.code).toBe("42P01");
  expect(err.message).toContain('relation "shop.nope" does not exist');
});

test("aborting the signal sends cancel for the running request", async () => {
  const { ports } = installChrome(() => new ReplayPort(from("postgres", "execute", "select pg_sleep(30)")));
  const driver = createDriver();
  await driver.connect(pgConfig);
  const ac = new AbortController();
  const run = collect(driver.execute({ sql: "select pg_sleep(30)", pageSize: 2000 }, ac.signal)).catch((e) => e);
  await new Promise((r) => setTimeout(r, 5));
  ac.abort();
  const err = await run;
  expect(err).toBeInstanceOf(DriverError);
  expect(err.code).toBe("CANCELLED");
  expect(ports[0]!.sent.slice(-2)).toEqual([
    { op: "execute", sql: "select pg_sleep(30)", pageSize: 2000, id: 3 },
    { op: "cancel", target: 3, id: 4 },
  ]);
});

test("postgres apply sends buildChangeSet statements with $n params", async () => {
  const { ports } = installChrome(() => new ReplayPort(from("postgres", "apply")));
  const driver = createDriver();
  await driver.connect(pgConfig);
  const changes: ChangeSet = {
    changes: [
      { type: "update", table: ["shop", "tables", "customers"], key: { id: "2" }, column: "name", value: "Bobby", old: "Bob" },
      { type: "delete", table: ["shop", "tables", "customers"], key: { id: "3" } },
    ],
  };
  const result = await driver.apply(changes);
  expect(result.applied).toBe(2);
  expect(result.ms).toBe(5);
  expect(result.statements).toEqual([
    'UPDATE "shop"."customers" SET "name" = $1 WHERE "id" = $2',
    'DELETE FROM "shop"."customers" WHERE "id" = $1',
  ]);
  expect(ports[0]!.sent.at(-1)?.op).toBe("apply");
});

test("redis: connect, list keys, execute a command line", async () => {
  installChrome(() => new ReplayPort(script("redis")));
  const driver = new RunnerDriver();
  const { serverVersion } = await driver.connect(redisConfig);
  expect(serverVersion).toMatch(/^Redis 7/);
  expect(driver.id).toBe("redis");
  expect(driver.dialect.name).toBe("redis");
  expect(driver.dialect.quoteIdent("session:1")).toBe("session:1");
  expect(driver.capabilities().kind).toBe("keyvalue");

  const keys = await driver.listObjects(["session:"]);
  expect(keys.map((k) => [k.name, k.type])).toEqual([
    ["session:1", "key"],
    ["session:2", "key"],
  ]);
  const { columns, rows } = await collect(driver.execute({ sql: "HGETALL session:1", pageSize: 2000 }));
  expect(columns.map((c) => c.name)).toEqual(["field", "value"]);
  expect(rows).toContainEqual(["user", "ada"]);
});

test("redis apply turns hash edits into typed commands", async () => {
  // The driver looks up the key type first; prepend that exchange to the recorded apply.
  const s = script("redis");
  const apply = s.find((e) => e.request.op === "apply")!;
  const typeLookup: Exchange = {
    request: { op: "execute", sql: "TYPE", params: ["session:1"] },
    responses: [
      { type: "columns", cols: [{ name: "value", type: "string", nullable: true }] },
      { type: "page", seq: 0, rows: [["hash"]] },
      { type: "done", rowCount: 1, ms: 0 },
    ],
  };
  const { ports } = installChrome(() => new ReplayPort([s[0]!, s[1]!, typeLookup, apply]));
  const driver = new RunnerDriver();
  await driver.connect(redisConfig);
  const result = await driver.apply({
    changes: [
      { type: "update", table: ["session:1"], key: { field: "theme" }, column: "value", value: "light", old: "dark" },
      { type: "delete", table: ["session:1"], key: { field: "role" } },
    ],
  });
  expect(result.applied).toBe(2);
  expect(result.statements).toEqual(["HSET session:1 theme light", "HDEL session:1 role"]);
  expect(ports[0]!.sent.at(-1)).toMatchObject({ op: "apply", statements: apply.request.statements });
});

test("host not found maps to RUNNER_NOT_INSTALLED", async () => {
  const { ports } = installChrome(() => Object.assign(new ReplayPort([]), { silent: true }));
  const driver = createDriver();
  // Chrome accepts the postMessage, then disconnects the port.
  const pending = driver.connect(pgConfig).catch((e) => e);
  await vi.waitFor(() => expect(ports[0]?.sent.length).toBe(1));
  ports[0]!.fail("Specified native messaging host not found.");
  const err = await pending;
  expect(err).toBeInstanceOf(DriverError);
  expect(err.code).toBe("RUNNER_NOT_INSTALLED");
});

test("an old protocol in hello maps to RUNNER_OUTDATED", async () => {
  const s = script("postgres");
  s[0]!.responses[0]!.protocol = 0;
  const { ports } = installChrome(() => new ReplayPort(s));
  const err = await createDriver().connect(pgConfig).catch((e) => e);
  expect(err).toBeInstanceOf(DriverError);
  expect(err.code).toBe("RUNNER_OUTDATED");
  expect(ports[0]!.disconnected).toBe(true);
});

test("a runner crash mid-query rejects with RUNNER_EXITED", async () => {
  const s = from("postgres", "execute", "select pg_sleep(30)");
  const { ports } = installChrome(() => new ReplayPort(s));
  const driver = createDriver();
  await driver.connect(pgConfig);
  const run = collect(driver.execute({ sql: "select pg_sleep(30)", pageSize: 2000 })).catch((e) => e);
  await new Promise((r) => setTimeout(r, 5));
  ports[0]!.fail("Native host has exited.");
  const err = await run;
  expect(err.code).toBe("RUNNER_EXITED");
  await expect(driver.listObjects([])).rejects.toMatchObject({ code: "NOT_CONNECTED" });
});

test("disconnect closes the port", async () => {
  const { ports } = installChrome(() => new ReplayPort(script("postgres")));
  const driver = createDriver();
  await driver.connect(pgConfig);
  await driver.disconnect();
  expect(ports[0]!.disconnected).toBe(true);
  await expect(driver.describe(["shop", "tables", "orders"])).rejects.toMatchObject({ code: "NOT_CONNECTED" });
});

test("checkRunner reports the installed version, or not installed", async () => {
  const { ports } = installChrome(() => new ReplayPort(script("postgres").slice(0, 1)));
  expect(await checkRunner()).toEqual({ installed: true, version: "0.1.0", protocol: 1 });
  expect(ports[0]!.disconnected).toBe(true);

  const missing = installChrome(() => Object.assign(new ReplayPort([]), { silent: true }));
  const pending = checkRunner();
  missing.ports[0]!.fail("Specified native messaging host not found.");
  expect(await pending).toEqual({ installed: false });
});

const configs = JSON.parse(
  readFileSync(resolve(__dirname, "../../fixtures/runner/connection-configs.json"), "utf8"),
) as Record<string, ConnectionConfig>;

test("a session password is sent inline and the Keychain ref is not", () => {
  const conn = toRunnerConfig(configs.sessionPassword!);
  expect(conn.password).toBe("typed-this-session");
  expect(conn.secretRef).toBeUndefined();
  expect(conn.sslmode).toBe("prefer");
  expect(conn.readOnly).toBe(true);
});

test("keychain mode without an inline password sends only the ref", () => {
  const conn = toRunnerConfig(configs.keychainNoInline!);
  expect(conn.password).toBeUndefined();
  expect(conn.secretRef).toBe("c_9a1");
  expect(conn.port).toBe(6432);
});

test("session mode with no password yet sends neither, so the runner never looks in Keychain", () => {
  const conn = toRunnerConfig(configs.sessionNoSecretYet!);
  expect(conn.password).toBeUndefined();
  expect(conn.secretRef).toBeUndefined();
});
