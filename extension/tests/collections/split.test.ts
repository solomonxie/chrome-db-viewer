import { expect, test } from "vitest";
import { render } from "../../src/collections/render";
import { runStatements, splitStatementsRaw, statementIndexAt } from "../../src/collections/split";
import { template } from "./fixtures";

test("a three-statement template renders, then splits on ';' outside strings and comments", () => {
  const sql = render(template("multi_statement"), { dialect: "postgres", vars: { table: "orders", status: "paid" } }).sql;
  const parts = splitStatementsRaw(sql);
  expect(parts).toHaveLength(3);
  expect(parts[0]).toBe(`CREATE TEMP TABLE picked AS SELECT * FROM "orders" WHERE status = 'paid'`);
  // The ';' inside the string literal and inside the comment don't split.
  expect(parts[1]).toContain("INSERT INTO audit (note) VALUES ('ran; for paid')");
  expect(parts[1]).toContain("-- a comment; with a semicolon");
  expect(parts[2]).toBe("SELECT count(*) AS n FROM picked");
});

test("statementIndexAt finds the statement around the cursor", () => {
  const sql = "SELECT 1;\nSELECT 'a;b';\nSELECT 3";
  expect(statementIndexAt(sql, 3)).toBe(0);
  expect(statementIndexAt(sql, sql.indexOf("'a;b'") + 2)).toBe(1);
  expect(statementIndexAt(sql, sql.length)).toBe(2);
});

test("Run all returns one result per statement and stops at the failing one", async () => {
  const statements = ["SELECT 1", "SELECT 2", "SELECT broken", "SELECT 4"];
  const ran: string[] = [];
  const results = await runStatements(statements, async (sql) => {
    ran.push(sql);
    if (sql.includes("broken")) throw new Error('column "broken" does not exist');
    return { sql, columns: ["n"], rows: [[Number(sql.slice(-1))]] };
  });
  expect(ran).toEqual(["SELECT 1", "SELECT 2", "SELECT broken"]);
  expect(results).toHaveLength(3);
  expect(results.map((r) => r.error)).toEqual([undefined, undefined, 'column "broken" does not exist']);
  expect(results[1]!.rows).toEqual([[2]]);
});
