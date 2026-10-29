import { expect, test } from "vitest";
import { postgresDialect, previewChangeSet } from "@core/sql";
import {
  cellStatus, clearTable, deleteRow, discard, editCell, emptyPending, insertRow, pendingCount, pendingValue,
  restoreRow, rowIdFor, toChangeSet, undo,
} from "../../src/app/lib/changes";

const orders = ["public", "orders"];
const key = { id: "10421" };
const rid = rowIdFor(orders, key);

test("rowIdFor is stable regardless of key order", () => {
  expect(rowIdFor(orders, { a: 1, b: 2 })).toBe(rowIdFor(orders, { b: 2, a: 1 }));
  expect(rowIdFor(orders, { a: 1 })).not.toBe(rowIdFor(["public", "customers"], { a: 1 }));
});

test("editing a cell records an update and marks it amber", () => {
  const s = editCell(emptyPending, orders, rid, key, "status", "refunded", "paid");
  expect(pendingCount(s)).toBe(1);
  expect(cellStatus(s, rid, "status")).toBe("edit");
  expect(cellStatus(s, rid, "total")).toBeNull();
  expect(pendingValue(s, rid, "status", "paid")).toBe("refunded");
});

test("editing the same cell twice keeps the first old value", () => {
  let s = editCell(emptyPending, orders, rid, key, "status", "refunded", "paid");
  s = editCell(s, orders, rid, key, "status", "shipped", "refunded");
  expect(s.items).toHaveLength(1);
  expect(s.items[0]).toMatchObject({ value: "shipped", old: "paid" });
});

test("editing back to the original value drops the change", () => {
  let s = editCell(emptyPending, orders, rid, key, "status", "refunded", "paid");
  s = editCell(s, orders, rid, key, "status", "paid", "refunded");
  expect(pendingCount(s)).toBe(0);
});

test("json values compare structurally", () => {
  const s = editCell(emptyPending, orders, rid, key, "metadata", { a: 1 }, { a: 1 });
  expect(pendingCount(s)).toBe(0);
});

test("insert then edit updates the insert values", () => {
  let s = insertRow(emptyPending, orders, { status: "pending" }, "new:1");
  s = editCell(s, orders, "new:1", {}, "total", "9.99", null);
  expect(s.items).toEqual([{ type: "insert", table: orders, rowId: "new:1", values: { status: "pending", total: "9.99" } }]);
  expect(cellStatus(s, "new:1", "total")).toBe("add");
});

test("deleting a pending insert removes it entirely", () => {
  let s = insertRow(emptyPending, orders, {}, "new:2");
  s = deleteRow(s, orders, "new:2", {});
  expect(pendingCount(s)).toBe(0);
});

test("deleting a row replaces its pending updates and marks it red", () => {
  let s = editCell(emptyPending, orders, rid, key, "status", "refunded", "paid");
  s = deleteRow(s, orders, rid, key);
  expect(s.items).toEqual([{ type: "delete", table: orders, rowId: rid, key }]);
  expect(cellStatus(s, rid, "status")).toBe("del");
  // Deleted rows can't be edited until restored.
  expect(editCell(s, orders, rid, key, "total", "1", "2")).toBe(s);
  expect(pendingCount(restoreRow(s, rid))).toBe(0);
});

test("undo steps back one operation at a time", () => {
  let s = editCell(emptyPending, orders, rid, key, "status", "refunded", "paid");
  s = editCell(s, orders, rid, key, "total", "1.00", "129.00");
  s = undo(s);
  expect(s.items).toHaveLength(1);
  s = undo(s);
  expect(s.items).toHaveLength(0);
  expect(undo(s)).toBe(s);
});

test("discard clears everything but can be undone", () => {
  let s = editCell(emptyPending, orders, rid, key, "status", "refunded", "paid");
  s = discard(s);
  expect(pendingCount(s)).toBe(0);
  expect(pendingCount(undo(s))).toBe(1);
});

test("clearTable removes only that table's changes", () => {
  const customers = ["public", "customers"];
  let s = editCell(emptyPending, orders, rid, key, "status", "refunded", "paid");
  s = deleteRow(s, customers, rowIdFor(customers, { id: "1" }), { id: "1" });
  s = clearTable(s, orders);
  expect(s.items).toHaveLength(1);
  expect(s.items[0]!.table).toEqual(customers);
  expect(s.past).toHaveLength(0);
});

test("toChangeSet maps to core changes and previews as SQL", () => {
  let s = editCell(emptyPending, orders, rid, key, "status", "refunded", "paid");
  s = insertRow(s, orders, { status: "pending", total: 5 }, "new:3");
  s = deleteRow(s, orders, rowIdFor(orders, { id: "10422" }), { id: "10422" });
  const set = toChangeSet(s, orders);
  expect(set.changes.map((c) => c.type)).toEqual(["update", "insert", "delete"]);
  expect(previewChangeSet(set, postgresDialect)).toBe(
    [
      `UPDATE "public"."orders" SET "status" = 'refunded' WHERE "id" = '10421';`,
      `INSERT INTO "public"."orders" ("status", "total") VALUES ('pending', 5);`,
      `DELETE FROM "public"."orders" WHERE "id" = '10422';`,
    ].join("\n"),
  );
});
