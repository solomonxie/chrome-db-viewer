// Env writes are recorded for the UI to confirm, not applied.
db.log("region was", db.env.get("region"));
db.env.set("region", "eu");
db.log("region now", db.env.get("region"));
