// RunnerDriver: Postgres and Redis through dbui-runner, the native messaging host
// (design/DESIGN.md §3.2–3.3). One runner process per connection: connect() opens a port
// with chrome.runtime.connectNative, and Chrome starts the runner for it. Closing the port
// (disconnect()) makes the runner see EOF and exit.
//
// The registry calls createDriver() without arguments for both "postgres" and "redis", so
// the driver takes its id, dialect and capabilities from ConnectionConfig.driver on connect().

import { RUNNER_HOST, PROTOCOL_VERSION } from "@core/runner-protocol";
import type { RunnerConnectConfig, RunnerMessage, RunnerRequest } from "@core/runner-protocol";
import { buildChangeSet, postgresDialect, qualified } from "@core/sql";
import { DriverError } from "@core/types";
import type {
  ApplyResult,
  Capabilities,
  Cell,
  Change,
  ChangeSet,
  Column,
  ConnectionConfig,
  Driver,
  DriverId,
  ExecuteSummary,
  ObjectNode,
  ObjectPath,
  ResultPage,
  SqlDialect,
  Statement,
  TableSchema,
} from "@core/types";

export const CLIENT_VERSION = "0.1.0";

/** Error codes this driver adds on top of the runner's own (SQLSTATE, READ_ONLY, CANCELLED …). */
export const RunnerErrorCode = {
  NotInstalled: "RUNNER_NOT_INSTALLED",
  Outdated: "RUNNER_OUTDATED",
  Exited: "RUNNER_EXITED",
  Forbidden: "RUNNER_FORBIDDEN",
  NotConnected: "NOT_CONNECTED",
  Cancelled: "CANCELLED",
  Protocol: "PROTOCOL",
} as const;

export type RunnerDriverId = Extract<DriverId, "postgres" | "redis">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Request = DistributiveOmit<RunnerRequest, "id">;
type Reply<T extends RunnerMessage["type"]> = Extract<RunnerMessage, { type: T }>;

/** Redis has no identifiers to quote; literals are shown the way redis-cli takes them. */
export const redisDialect: SqlDialect = {
  name: "redis",
  quoteIdent: (name) => name,
  literal: (value) => redisArg(value),
};

function redisArg(value: Cell): string {
  if (value === null) return '""';
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (s !== "" && /^[^\s"'\\]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

// ---- port -----------------------------------------------------------------------------

interface Listener {
  onMessage(msg: RunnerMessage): void;
  onClose(err: DriverError): void;
}

const FINAL_TYPES = new Set<RunnerMessage["type"]>(["hello", "ok", "done", "objects", "schema", "secret", "error"]);

/** Maps chrome.runtime.lastError on disconnect to a DriverError the UI can act on. */
export function disconnectError(message: string | undefined): DriverError {
  const text = message ?? "The runner closed the connection";
  if (/not found/i.test(text)) {
    return new DriverError("dbui runner is not installed", RunnerErrorCode.NotInstalled, text);
  }
  if (/forbidden/i.test(text)) {
    return new DriverError("This extension is not allowed to use the installed dbui runner", RunnerErrorCode.Forbidden, text);
  }
  return new DriverError(`dbui runner stopped: ${text}`, RunnerErrorCode.Exited, text);
}

function cancelled(): DriverError {
  return new DriverError("Query cancelled", RunnerErrorCode.Cancelled);
}

function runnerError(msg: Reply<"error">, signal?: AbortSignal): DriverError {
  if (signal?.aborted && msg.code === RunnerErrorCode.Cancelled) return cancelled();
  return new DriverError(msg.message, msg.code);
}

function expectType<T extends RunnerMessage["type"]>(msg: RunnerMessage, type: T): Reply<T> {
  if (msg.type !== type) {
    throw new DriverError(`Unexpected runner reply: ${msg.type} (wanted ${type})`, RunnerErrorCode.Protocol);
  }
  return msg as Reply<T>;
}

/** One native messaging port, with replies routed to their request by id. */
class RunnerPort {
  private nextId = 1;
  private listeners = new Map<number, Listener>();
  private closedWith: DriverError | null = null;
  private port: chrome.runtime.Port;

  constructor() {
    this.port = chrome.runtime.connectNative(RUNNER_HOST);
    this.port.onMessage.addListener((msg: RunnerMessage) => {
      const listener = this.listeners.get(msg.id);
      if (!listener) return;
      if (FINAL_TYPES.has(msg.type)) this.listeners.delete(msg.id);
      listener.onMessage(msg);
    });
    this.port.onDisconnect.addListener(() => {
      // lastError has to be read inside this callback.
      this.close(disconnectError(chrome.runtime.lastError?.message));
    });
  }

  get closed(): boolean {
    return this.closedWith !== null;
  }

  /** Sends a request; `listener` gets every reply with its id up to the final one. */
  send(req: Request, listener?: Listener): number {
    if (this.closedWith) throw this.closedWith;
    const id = this.nextId++;
    if (listener) this.listeners.set(id, listener);
    try {
      this.port.postMessage({ ...req, id });
    } catch (e) {
      this.listeners.delete(id);
      throw disconnectError(e instanceof Error ? e.message : String(e));
    }
    return id;
  }

  /** Sends a request and resolves with its final reply. Aborting `signal` sends `cancel`. */
  call(req: Request, signal?: AbortSignal): Promise<RunnerMessage> {
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      let id = 0;
      const onAbort = () => {
        if (!this.closed) this.send({ op: "cancel", target: id });
      };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      try {
        id = this.send(req, {
          onMessage: (msg) => {
            if (!FINAL_TYPES.has(msg.type)) return;
            cleanup();
            if (msg.type === "error") reject(runnerError(msg, signal));
            else if (signal?.aborted) reject(cancelled());
            else resolve(msg);
          },
          onClose: (err) => {
            cleanup();
            reject(err);
          },
        });
      } catch (e) {
        reject(e);
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  disconnect(): void {
    if (this.closed) return;
    this.port.disconnect();
    this.close(new DriverError("Disconnected", RunnerErrorCode.NotConnected));
  }

  private close(err: DriverError): void {
    if (this.closedWith) return;
    this.closedWith = err;
    const pending = [...this.listeners.values()];
    this.listeners.clear();
    for (const listener of pending) listener.onClose(err);
  }
}

/** Sends `hello` and checks that the runner speaks our protocol and supports `driver`. */
async function hello(port: RunnerPort, driver?: string, signal?: AbortSignal): Promise<Reply<"hello">> {
  const msg = expectType(await port.call({ op: "hello", client: CLIENT_VERSION }, signal), "hello");
  if (msg.protocol < PROTOCOL_VERSION) {
    throw new DriverError(
      `dbui runner ${msg.runner} is too old (protocol ${msg.protocol}, need ${PROTOCOL_VERSION}); update it`,
      RunnerErrorCode.Outdated,
      msg,
    );
  }
  if (driver && !msg.drivers.includes(driver)) {
    throw new DriverError(`dbui runner ${msg.runner} does not support ${driver}; update it`, RunnerErrorCode.Outdated, msg);
  }
  return msg;
}

// ---- driver -----------------------------------------------------------------------------

export class RunnerDriver implements Driver {
  private port: RunnerPort | null = null;
  private driverId: RunnerDriverId;
  /** Redis key → type, from describe() or a TYPE lookup during apply(). */
  private redisTypes = new Map<string, string>();

  constructor(id: RunnerDriverId = "postgres") {
    this.driverId = id;
  }

  get id(): DriverId {
    return this.driverId;
  }

  get dialect(): SqlDialect {
    return this.driverId === "redis" ? redisDialect : postgresDialect;
  }

  capabilities(): Capabilities {
    if (this.driverId === "redis") {
      return { kind: "keyvalue", transactions: true, editableRows: true, costEstimate: false, cancel: true };
    }
    return { kind: "relational", transactions: true, editableRows: true, costEstimate: false, cancel: true };
  }

  async connect(cfg: ConnectionConfig, signal?: AbortSignal): Promise<{ serverVersion?: string }> {
    if (cfg.driver !== "postgres" && cfg.driver !== "redis") {
      throw new DriverError(`RunnerDriver can't open ${cfg.driver} connections`, "UNSUPPORTED_DRIVER");
    }
    await this.disconnect();
    this.driverId = cfg.driver;
    this.redisTypes.clear();
    const port = new RunnerPort();
    this.port = port;
    try {
      await hello(port, cfg.driver, signal);
      const ok = expectType(await port.call({ op: "connect", conn: toRunnerConfig(cfg) }, signal), "ok");
      return { serverVersion: typeof ok.server === "string" ? ok.server : undefined };
    } catch (e) {
      if (this.port === port) this.port = null;
      port.disconnect();
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    const port = this.port;
    this.port = null;
    // Closing the port is enough: the runner sees EOF, closes its connections and exits.
    port?.disconnect();
  }

  async listObjects(parent: ObjectPath, signal?: AbortSignal): Promise<ObjectNode[]> {
    const msg = await this.requirePort().call({ op: "listObjects", parent }, signal);
    return expectType(msg, "objects").nodes as ObjectNode[];
  }

  async describe(path: ObjectPath, signal?: AbortSignal): Promise<TableSchema> {
    const msg = await this.requirePort().call({ op: "describe", path }, signal);
    const schema = expectType(msg, "schema").schema as TableSchema;
    const key = path[path.length - 1];
    if (this.driverId === "redis" && schema.info?.type && key !== undefined) this.redisTypes.set(key, schema.info.type);
    return schema;
  }

  async *execute(stmt: Statement, signal?: AbortSignal): AsyncGenerator<ResultPage, ExecuteSummary, void> {
    const port = this.requirePort();
    if (signal?.aborted) throw cancelled();

    const queue: RunnerMessage[] = [];
    let wake: (() => void) | null = null;
    let closedWith: DriverError | null = null;
    let finished = false;
    const notify = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const req: Request = { op: "execute", sql: stmt.sql };
    if (stmt.params) req.params = stmt.params;
    if (stmt.pageSize) req.pageSize = stmt.pageSize;
    const id = port.send(req, {
      onMessage: (msg) => {
        queue.push(msg);
        notify();
      },
      onClose: (err) => {
        closedWith = err;
        notify();
      },
    });
    let cancelSent = false;
    const sendCancel = () => {
      if (finished || cancelSent || port.closed) return;
      cancelSent = true;
      port.send({ op: "cancel", target: id });
    };
    signal?.addEventListener("abort", sendCancel, { once: true });

    let pendingColumns: Column[] | undefined;
    try {
      for (;;) {
        const msg = queue.shift();
        if (!msg) {
          if (closedWith) throw closedWith;
          await new Promise<void>((resolve) => (wake = resolve));
          continue;
        }
        switch (msg.type) {
          case "columns":
            pendingColumns = msg.cols;
            break;
          case "page": {
            if (signal?.aborted) break; // drop rows until the runner confirms the cancel
            const page: ResultPage = { rows: msg.rows, seq: msg.seq };
            if (pendingColumns) page.columns = pendingColumns;
            pendingColumns = undefined;
            yield page;
            break;
          }
          case "done": {
            finished = true;
            if (signal?.aborted) throw cancelled();
            // A result with columns and no rows still has to show its columns.
            if (pendingColumns) yield { columns: pendingColumns, rows: [], seq: 0 };
            const summary: ExecuteSummary = { rowCount: msg.rowCount, ms: msg.ms };
            if (msg.affectedRows !== undefined) summary.affectedRows = msg.affectedRows;
            return summary;
          }
          case "error":
            finished = true;
            throw runnerError(msg, signal);
          default:
            finished = true;
            throw new DriverError(`Unexpected runner reply: ${msg.type}`, RunnerErrorCode.Protocol);
        }
      }
    } finally {
      signal?.removeEventListener("abort", sendCancel);
      // The consumer stopped early (break / return): stop the query on the server too.
      sendCancel();
    }
  }

  async apply(changes: ChangeSet, signal?: AbortSignal): Promise<ApplyResult> {
    const port = this.requirePort();
    const started = Date.now();
    let statements: { sql: string; params?: Cell[] }[];
    let display: string[];
    if (this.driverId === "redis") {
      const cmds = await this.redisCommands(changes, signal);
      statements = cmds.map(([cmd, ...args]) => ({ sql: String(cmd), params: args }));
      display = cmds.map((c) => c.map((a, i) => (i === 0 ? String(a) : redisArg(a))).join(" "));
    } else {
      const built = buildChangeSet(changes, postgresDialect, "dollar", pgTableName);
      statements = built.map((s) => ({ sql: s.sql, params: s.params }));
      display = built.map((s) => s.sql);
    }
    if (statements.length === 0) return { applied: 0, ms: 0, statements: [] };
    const ok = expectType(await port.call({ op: "apply", statements }, signal), "ok");
    return {
      applied: typeof ok.applied === "number" ? ok.applied : statements.length,
      ms: typeof ok.ms === "number" ? ok.ms : Date.now() - started,
      statements: display,
    };
  }

  // ---- Keychain through the runner (DESIGN.md §3.7) ----

  async setSecret(ref: string, value: string, signal?: AbortSignal): Promise<void> {
    await this.requirePort().call({ op: "secret.set", ref, value }, signal);
  }

  async getSecret(ref: string, signal?: AbortSignal): Promise<string | null> {
    return expectType(await this.requirePort().call({ op: "secret.get", ref }, signal), "secret").value;
  }

  async deleteSecret(ref: string, signal?: AbortSignal): Promise<void> {
    await this.requirePort().call({ op: "secret.delete", ref }, signal);
  }

  private requirePort(): RunnerPort {
    if (!this.port || this.port.closed) throw new DriverError("Not connected", RunnerErrorCode.NotConnected);
    return this.port;
  }

  /** Turns grid edits into typed Redis commands; the runner wraps them in MULTI/EXEC. */
  private async redisCommands(set: ChangeSet, signal?: AbortSignal): Promise<Cell[][]> {
    const cmds: Cell[][] = [];
    for (const change of set.changes) {
      const key = change.table[change.table.length - 1];
      if (key === undefined) throw new DriverError("Change has no key", "BAD_CHANGE");
      cmds.push(...redisChange(change, key, await this.redisType(key, signal)));
    }
    return cmds;
  }

  private async redisType(key: string, signal?: AbortSignal): Promise<string> {
    const known = this.redisTypes.get(key);
    if (known) return known;
    let type = "none";
    const gen = this.execute({ sql: "TYPE", params: [key] }, signal);
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
      const value = next.value.rows[0]?.[0];
      if (typeof value === "string") type = value;
    }
    this.redisTypes.set(key, type);
    return type;
  }
}

/** Tree paths are [schema, group, name]; SQL wants "schema"."name". */
function pgTableName(path: ObjectPath): string {
  const parts = path.length >= 3 ? [path[0]!, path[path.length - 1]!] : path;
  return qualified(parts, postgresDialect);
}

export function toRunnerConfig(cfg: ConnectionConfig): RunnerConnectConfig {
  const o = cfg.options;
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined);
  const conn: RunnerConnectConfig = { driver: cfg.driver as RunnerDriverId, readOnly: cfg.readOnly };
  const host = str(o.host);
  const port = typeof o.port === "number" ? o.port : Number(str(o.port));
  const user = str(o.user);
  const database = str(o.database);
  if (host) conn.host = host;
  if (Number.isFinite(port) && port > 0) conn.port = port;
  if (user) conn.user = user;
  if (database) conn.database = database;
  const sslmode = str(o.sslmode);
  if (sslmode) conn.sslmode = sslmode;
  // The app resolves the secret (typed this session or from browser storage) into
  // options.secret. Send it inline; only fall back to the Keychain ref without one.
  const password = str(o.secret);
  if (password) conn.password = password;
  else if (cfg.secretRef && o.secretMode === "keychain") conn.secretRef = cfg.secretRef;
  const ssh = o.ssh as RunnerConnectConfig["ssh"] | undefined;
  if (ssh && typeof ssh === "object" && ssh.host) conn.ssh = ssh;
  return conn;
}

/**
 * One grid edit → Redis commands. Grid columns per key type match the runner's describe:
 * string [value] · hash [field, value] · list [index, value] · set [member] · zset [member, score].
 */
export function redisChange(change: Change, key: string, type: string): Cell[][] {
  const bad = (why: string) => new DriverError(`Can't apply this edit to ${type} key ${key}: ${why}`, "BAD_CHANGE");
  switch (type) {
    case "string":
      if (change.type === "delete") return [["DEL", key]];
      if (change.type === "insert") return [["SET", key, change.values.value ?? ""]];
      if (change.column !== "value") throw bad("only the value can change");
      return [["SET", key, change.value, "KEEPTTL"]];
    case "hash":
      if (change.type === "delete") return [["HDEL", key, change.key.field ?? null]];
      if (change.type === "insert") return [["HSET", key, change.values.field ?? null, change.values.value ?? ""]];
      if (change.column !== "value") throw bad("rename a field by deleting it and adding a new one");
      return [["HSET", key, change.key.field ?? null, change.value]];
    case "list":
      if (change.type === "insert") return [["RPUSH", key, change.values.value ?? ""]];
      if (change.type === "delete") {
        // Lists have no delete-by-index: overwrite the slot with a marker, then remove the marker.
        const marker = `__dbui_deleted_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
        return [
          ["LSET", key, change.key.index ?? null, marker],
          ["LREM", key, 1, marker],
        ];
      }
      if (change.column !== "value") throw bad("only the value can change");
      return [["LSET", key, change.key.index ?? null, change.value]];
    case "set":
      if (change.type === "delete") return [["SREM", key, change.key.member ?? null]];
      if (change.type === "insert") return [["SADD", key, change.values.member ?? null]];
      return [
        ["SREM", key, change.old],
        ["SADD", key, change.value],
      ];
    case "zset":
      if (change.type === "delete") return [["ZREM", key, change.key.member ?? null]];
      if (change.type === "insert") return [["ZADD", key, change.values.score ?? 0, change.values.member ?? null]];
      if (change.column !== "score") throw bad("change the score, or delete and re-add the member");
      return [["ZADD", key, change.value, change.key.member ?? null]];
    case "none":
      if (change.type === "insert" && "value" in change.values) return [["SET", key, change.values.value ?? ""]];
      throw bad("the key does not exist");
    default:
      throw bad("editing this type is not supported");
  }
}

export function createDriver(id: RunnerDriverId = "postgres"): Driver {
  return new RunnerDriver(id);
}

/**
 * For the "Install dbui runner" card: opens a short-lived port, sends hello, and closes it.
 * `installed` is false when Chrome can't find or start the host, or it doesn't answer in time.
 */
export async function checkRunner(timeoutMs = 5000): Promise<{ installed: boolean; version?: string; protocol?: number }> {
  let port: RunnerPort;
  try {
    port = new RunnerPort();
  } catch {
    return { installed: false };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DriverError("dbui runner did not answer", "TIMEOUT")), timeoutMs);
    });
    const msg = expectType(await Promise.race([port.call({ op: "hello", client: CLIENT_VERSION }), timeout]), "hello");
    return { installed: true, version: msg.runner, protocol: msg.protocol };
  } catch {
    return { installed: false };
  } finally {
    clearTimeout(timer);
    port.disconnect();
  }
}
