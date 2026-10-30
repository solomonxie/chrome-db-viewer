// Pre-run: compute a 7-day window ending today.
const end = db.date.today();
db.vars.set("end_date", end);
db.vars.set("start_date", db.date.addDays(end, -7));
db.vars.unset("stale");
db.log("window", db.vars.get("start_date"), "to", end);
