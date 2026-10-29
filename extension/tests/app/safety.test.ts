import { expect, test } from "vitest";
import { findDestructive, isWriteStatement } from "../../src/app/lib/safety";

test("flags DROP, TRUNCATE and unbounded DELETE/UPDATE", () => {
  const found = findDestructive(`
    drop table if exists public.orders;
    TRUNCATE "audit_log";
    delete from customers;
    update orders set paid = true;
    ALTER TABLE events DELETE WHERE ts < now();
  `);
  expect(found.map((f) => [f.kind, f.target])).toEqual([
    ["drop", "public.orders"],
    ["truncate", "audit_log"],
    ["delete_all", "customers"],
    ["update_all", "orders"],
    ["alter_mutation", "events"],
  ]);
});

test("DELETE/UPDATE with WHERE are fine", () => {
  expect(findDestructive("delete from orders where id = 1; update orders set paid = true where id = 2")).toEqual([]);
});

test("keywords inside strings and comments are ignored", () => {
  expect(findDestructive("select 'drop table x'; -- truncate y\n/* delete from z */ select 1")).toEqual([]);
});

test("isWriteStatement", () => {
  expect(isWriteStatement("select * from t")).toBe(false);
  expect(isWriteStatement("with x as (select 1) select * from x")).toBe(false);
  expect(isWriteStatement("select 1; insert into t values (1)")).toBe(true);
});
