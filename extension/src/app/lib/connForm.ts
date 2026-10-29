// Connection sheet values → ConnectionConfig.options. Secrets are split out; only their
// secretRef stays in the config.

import type { DriverId, Env } from "@core/types";
import type { SavedConnection } from "../store/db";
import type { SecretMode } from "../store/secrets";
import { engine, fieldVisible } from "./driverForms";

export interface FormState {
  name: string;
  env: Env;
  readOnly: boolean;
  group: string;
  secretMode: SecretMode;
  values: Record<string, unknown>;
  /** Handle ids for file fields, keyed by field key. */
  files: Record<string, { id: string; name: string }>;
}

export interface BuiltConnection {
  config: SavedConnection;
  /** secretRef → value; written to the SecretStore by the caller. */
  secrets: Record<string, string>;
}

export function buildConnection(driver: DriverId, form: FormState, id: string, createdAt = Date.now()): BuiltConnection {
  const spec = engine(driver);
  if (!spec) throw new Error(`Unknown engine ${driver}`);
  const options: Record<string, unknown> = { secretMode: form.secretMode };
  const secrets: Record<string, string> = {};
  let secretRef: string | undefined;

  for (const f of spec.fields) {
    if (!fieldVisible(f, form.values)) continue;
    if (f.kind === "file") {
      const file = form.files[f.key];
      if (file) {
        options[`${f.key}HandleId`] = file.id;
        options[`${f.key}Name`] = file.name;
      }
      continue;
    }
    const v = form.values[f.key];
    if (f.secret) {
      if (typeof v === "string" && v !== "") {
        const ref = f.key === "password" || f.key === "token" ? `c_${id}` : `c_${id}_${f.key}`;
        if (ref === `c_${id}`) secretRef = ref;
        secrets[ref] = v;
      } else if (f.key === "password" || f.key === "token") {
        secretRef = `c_${id}`;
      }
      continue;
    }
    if (v === undefined || v === "") continue;
    options[f.key] = f.kind === "number" ? Number(v) : f.kind === "checkbox" ? v === true || v === "true" : v;
  }

  if (driver === "bigquery") shapeBigQuery(options, id);
  if (options.sshEnabled) {
    options.ssh = { host: options.sshHost, port: options.sshPort, user: options.sshUser, keySecretRef: `c_${id}_sshKey` };
  }

  return {
    config: {
      id,
      name: form.name.trim() || spec.name,
      driver,
      env: form.env,
      readOnly: form.readOnly,
      group: form.group.trim() || undefined,
      options,
      secretRef,
      createdAt,
    },
    secrets,
  };
}

/** The BigQuery driver reads options.auth = { method, options } and options.projectId. */
function shapeBigQuery(o: Record<string, unknown>, id: string) {
  const method = String(o.auth ?? "adc");
  let authOptions: Record<string, unknown> = {};
  switch (method) {
    case "web-auth":
      authOptions = { refreshTokenRef: `c_${id}_refresh`, interactive: true };
      break;
    case "service-account":
      authOptions = o.keyStorage === "browser" ? { keySecretRef: `c_${id}_key` } : { keyFileHandleId: o.keyFileHandleId };
      break;
    case "adc":
      authOptions = { adcFileHandleId: o.keyFileHandleId };
      break;
    case "impersonate":
      authOptions = { base: { method: "chrome-profile", options: {} }, targetServiceAccount: o.impersonateTarget };
      break;
    case "access-token":
      // The token itself is filled in from the secret store at connect time.
      authOptions = {};
      break;
  }
  o.auth = { method, options: authOptions };
  if (typeof o.maxBytesGb === "number") o.maximumBytesBilled = String(Math.round(o.maxBytesGb * 1024 ** 3));
}

/** Reverse of buildConnection for editing an existing connection (secrets left blank). */
export function formFromConnection(c: SavedConnection): FormState {
  const o = { ...c.options };
  const values: Record<string, unknown> = { ...o };
  const files: FormState["files"] = {};
  for (const k of Object.keys(o)) {
    const m = /^(.*)HandleId$/.exec(k);
    if (m && typeof o[k] === "string") files[m[1]!] = { id: o[k] as string, name: String(o[`${m[1]}Name`] ?? "file") };
  }
  if (c.driver === "bigquery" && o.auth && typeof o.auth === "object") {
    const a = o.auth as { method?: string; options?: Record<string, unknown> };
    values.auth = a.method;
    if (a.options?.targetServiceAccount) values.impersonateTarget = a.options.targetServiceAccount;
  }
  return {
    name: c.name,
    env: c.env,
    readOnly: c.readOnly,
    group: c.group ?? "",
    secretMode: (o.secretMode as SecretMode) ?? "session",
    values,
    files,
  };
}
