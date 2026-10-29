// Messages between the SQLite driver and its worker, and the async backend interface the
// driver talks to. In the browser the backend is the worker; in tests it's the engine in-process.

import type { Cell } from "@core/types";
import type { OpenArgs, QueryResult, StepResult } from "./engine";

export type WorkerRequest =
  | { id: number; op: "init"; interruptBuffer?: SharedArrayBuffer }
  | { id: number; op: "open"; args: OpenArgs }
  | { id: number; op: "query"; sql: string; params?: Cell[] }
  | { id: number; op: "next"; cursor: number; max: number }
  | { id: number; op: "closeCursor"; cursor: number }
  | { id: number; op: "all"; sql: string; params?: Cell[] }
  | { id: number; op: "transaction"; statements: { sql: string; params: Cell[] }[] }
  | { id: number; op: "close" };

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; code?: number };

export interface SqliteBackend {
  open(args: OpenArgs): Promise<{ version: string }>;
  query(sql: string, params?: Cell[]): Promise<QueryResult>;
  next(cursor: number, max: number): Promise<StepResult>;
  closeCursor(cursor: number): Promise<void>;
  all(sql: string, params?: Cell[]): Promise<Record<string, Cell>[]>;
  transaction(statements: { sql: string; params: Cell[] }[]): Promise<number>;
  /** Stops the statement that is running right now, if any. */
  interrupt(): void;
  close(): Promise<void>;
}
