import { expect, test } from "vitest";
import { isFavorite, toggleFavorite, type Favorite } from "../../src/app/lib/favorites";

const orders = { path: ["public", "tables", "orders"], name: "orders", type: "table" as const };
const customers = { path: ["public", "tables", "customers"], name: "customers", type: "table" as const };

test("toggling adds a table, sorted by name, and toggling again removes it", () => {
  let list: Favorite[] = [];
  list = toggleFavorite(list, orders);
  list = toggleFavorite(list, customers);
  expect(list.map((f) => f.name)).toEqual(["customers", "orders"]);
  expect(isFavorite(list, ["public", "tables", "orders"])).toBe(true);

  list = toggleFavorite(list, orders);
  expect(list.map((f) => f.name)).toEqual(["customers"]);
  expect(isFavorite(list, orders.path)).toBe(false);
});

test("favorites match by full path, so same-named tables in other schemas stay separate", () => {
  const list = toggleFavorite([], orders);
  expect(isFavorite(list, ["archive", "tables", "orders"])).toBe(false);
});
