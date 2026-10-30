// Post-run: assertions over the result, and pull a column into a variable.
db.test("has rows", db.result.rowCount > 0);
db.test("ids are unique", () => new Set(db.result.column("ad_id")).size === db.result.rowCount);
db.test("spend is positive", () => {
  if (db.result.rows.some((r) => r.spend <= 0)) throw new Error("non-positive spend");
});
db.test("more than 100 rows", db.result.rowCount > 100);
db.vars.set("top_ids", db.result.column("ad_id"));
db.log({ columns: db.result.columns, first: db.result.rows[0] });
