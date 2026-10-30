// SQL autocompletion against the demo database's tree (public → Tables/Views → customers, orders,
// order_items …), the same shape a Postgres connection has.
import { expect, test } from "vitest";
import { createDemoDriver } from "../../src/app/demo/demoDriver";
import { complete, connectionSource, contextAt, tableAliases } from "../../src/app/lib/completion";

const driver = createDemoDriver({ latency: 0 });
await driver.connect({ id: "demo", name: "Demo", driver: "postgres", env: "local", readOnly: false, options: { demo: true } });
const source = connectionSource(driver);
const quote = (s: string) => `"${s}"`;

const at = async (sqlWithCaret: string) => {
  const cursor = sqlWithCaret.indexOf("|");
  const sql = sqlWithCaret.replace("|", "");
  const res = await complete(sql, cursor, source, quote);
  return res?.items ?? [];
};
const labels = async (s: string) => (await at(s)).map((c) => c.label);

test("the context is the dotted name before the cursor, quoted parts unquoted", () => {
  expect(contextAt("select * from public.or", 23)).toEqual({ from: 21, to: 23, prefix: "or", qualifier: ["public"] });
  expect(contextAt('select "my schema".', 19)).toEqual({ from: 19, to: 19, prefix: "", qualifier: ["my schema"] });
  expect(contextAt("select 'publ", 12)).toBeNull();
  expect(contextAt("select 3.5", 10)).toBeNull();
  expect(contextAt("-- from pub", 11)).toBeNull();
});

test("FROM and JOIN aliases map back to their tables", () => {
  const a = tableAliases('select * from public.orders o join customers as c on c.id = o.customer_id left join "order_items"');
  expect(a.get("o")).toEqual(["public", "orders"]);
  expect(a.get("c")).toEqual(["customers"]);
  expect(a.get("order_items")).toEqual(["order_items"]);
  expect(a.has("on")).toBe(false);
});

test("schema. lists the tables and views in that schema", async () => {
  const names = await labels("select * from public.|");
  expect(names).toEqual(expect.arrayContaining(["customers", "orders", "order_items"]));
  const ord = await labels("select * from public.ord|");
  expect(ord).toEqual(expect.arrayContaining(["orders", "order_items"]));
  expect(ord).not.toContain("customers");
});

test("table. and alias. list that table's columns with their types", async () => {
  const cols = await at("select customers.| from customers");
  expect(cols.map((c) => c.label)).toEqual(expect.arrayContaining(["id", "name", "email", "country", "tier"]));
  expect(cols.find((c) => c.label === "email")).toMatchObject({ kind: "column", detail: "text" });
  expect(await labels("select c.em| from public.customers c")).toEqual(["email"]);
});

test("a bare word suggests keywords, functions, tables and columns of tables in FROM", async () => {
  expect((await at("sel|"))[0]).toMatchObject({ label: "SELECT", kind: "keyword", insert: "SELECT" });
  expect(await labels("select * from cust|")).toContain("customers");
  expect(await labels("select tie| from customers")).toContain("tier");
  expect(await labels("select coal|")).toContain("coalesce");
});

test("names that need it are quoted on insert", async () => {
  const [first] = await at("select * from public.|");
  expect(first!.insert).toBe(first!.label);
  const odd = { schemas: async () => [], tables: async () => [{ name: "Order Lines", kind: "table" as const }], columns: async () => [] };
  const res = await complete("select * from ord", 17, odd, quote);
  expect(res!.items[0]).toMatchObject({ label: "Order Lines", insert: '"Order Lines"' });
});
