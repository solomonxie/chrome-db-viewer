// Pre-run: stop when a required input is missing.
db.log("checking inputs");
if (!db.vars.get("client_id")) db.fail("client_id is required");
db.vars.set("after_fail", true);
