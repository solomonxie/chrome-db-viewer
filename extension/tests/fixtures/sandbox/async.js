// Async code is awaited.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(5);
db.vars.set("waited", true);
await db.test("async test", async () => {
  await wait(1);
  return true;
});
db.log("done");
