import { expect, test } from "vitest";
import { buildConnection, type FormState } from "../../src/app/lib/connForm";
import { parseConnectionUrl } from "../../src/app/lib/connections";

const base: FormState = { name: "shop", env: "production", readOnly: true, group: "", secretMode: "session", values: {}, files: {} };

test("postgres: password goes to secrets, never options", () => {
  const { config, secrets } = buildConnection("postgres", { ...base, values: { host: "db", port: "5432", user: "app", password: "hunter2", database: "shop" } }, "x1");
  expect(config.options).toMatchObject({ host: "db", port: 5432, user: "app", database: "shop" });
  expect(JSON.stringify(config)).not.toContain("hunter2");
  expect(config.secretRef).toBe("c_x1");
  expect(secrets).toEqual({ c_x1: "hunter2" });
});

test("bigquery: auth is shaped for the driver", () => {
  const { config } = buildConnection("bigquery", { ...base, values: { auth: "impersonate", impersonateTarget: "sa@p.iam.gserviceaccount.com", projectId: "p", maxBytesGb: "1" } }, "b1");
  expect(config.options.auth).toEqual({ method: "impersonate", options: { base: { method: "chrome-profile", options: {} }, targetServiceAccount: "sa@p.iam.gserviceaccount.com" } });
  expect(config.options.projectId).toBe("p");
  expect(config.options.maximumBytesBilled).toBe(String(1024 ** 3));
});

test("file fields store a handle id", () => {
  const { config } = buildConnection("sqlite", { ...base, files: { file: { id: "h_1", name: "app.sqlite" } } }, "s1");
  expect(config.options).toMatchObject({ fileHandleId: "h_1", fileName: "app.sqlite" });
});

test("parseConnectionUrl", () => {
  expect(parseConnectionUrl("postgres://app@db.internal:6543/shop")).toMatchObject({ driver: "postgres", options: { host: "db.internal", port: 6543, user: "app", database: "shop" } });
  expect(parseConnectionUrl("https://ch.example.com/analytics")).toMatchObject({ driver: "clickhouse", options: { url: "https://ch.example.com:8443", database: "analytics" } });
  expect(parseConnectionUrl("nonsense")).toBeNull();
});
