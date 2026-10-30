// Post script over a query with several statements: db.results has every result, db.result the last.
db.vars.set("statements", db.results.length);
db.vars.set("first_count", db.results[0].rowCount);
db.vars.set("last_is_result", db.results[db.results.length - 1].rowCount === db.result.rowCount);
db.test("setup returned rows", db.results[0].rowCount > 0);
