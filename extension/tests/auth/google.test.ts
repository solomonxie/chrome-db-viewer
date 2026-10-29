// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, expect, test, vi } from "vitest";
import {
  AuthError,
  CachingTokenProvider,
  REFRESH_MARGIN_MS,
  base64urlDecode,
  createTokenProvider,
  pkcePair,
  type IdentityApi,
  type SecretStore,
} from "../../src/auth/google";

const fx = (name: string) => readFileSync(resolve(__dirname, "fixtures", name), "utf8");
// No private key is committed: service-account.json ships with an empty private_key, and each
// run generates a throwaway RSA key pair that is filled in here and used to verify the JWT.
const keyPair = crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
) as Promise<CryptoKeyPair>;
let privatePem = "";
beforeAll(async () => {
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", (await keyPair).privateKey)).toString("base64");
  privatePem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
});
const saKeyJson = () => {
  const sa = JSON.parse(fx("service-account.json")) as Record<string, string>;
  return JSON.stringify({ ...sa, private_key: privatePem });
};

function jsonResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { "Content-Type": "application/json" } });
}

function memorySecrets(initial: Record<string, string> = {}): SecretStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
  };
}

async function publicKey(): Promise<CryptoKey> {
  return (await keyPair).publicKey;
}

test("service account: signs an RS256 JWT that verifies with the public key", async () => {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse(fx("token-response.json")));
  const now = 1_800_000_000_000;
  const provider = createTokenProvider("service-account", { keyJson: saKeyJson() }, { fetch, now: () => now });

  const token = await provider.getToken();
  expect(token).toEqual({ token: "ya29.c.test-service-account-token", expiresAt: now + 3599 * 1000 });

  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe("https://oauth2.googleapis.com/token");
  const form = new URLSearchParams(String(init!.body));
  expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [h, c, s] = form.get("assertion")!.split(".") as [string, string, string];
  const header = JSON.parse(new TextDecoder().decode(base64urlDecode(h)));
  const claims = JSON.parse(new TextDecoder().decode(base64urlDecode(c)));
  expect(header).toEqual({ alg: "RS256", typ: "JWT", kid: "test-key-id" });
  expect(claims).toEqual({
    iss: "dbui-reader@dbui-test.iam.gserviceaccount.com",
    scope: "https://www.googleapis.com/auth/bigquery",
    aud: "https://oauth2.googleapis.com/token",
    iat: 1_800_000_000,
    exp: 1_800_003_600,
  });
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", await publicKey(), base64urlDecode(s), new TextEncoder().encode(`${h}.${c}`));
  expect(ok).toBe(true);
});

test("service account: key read from a file handle on every refresh", async () => {
  const readFile = vi.fn(async () => saKeyJson());
  const fetch = vi.fn(async () => jsonResponse(fx("token-response.json")));
  let now = 1_000_000;
  const provider = createTokenProvider("service-account", { keyFileHandleId: "h1" }, { fetch, readFile, now: () => now });
  await provider.getToken();
  await provider.getToken();
  expect(fetch).toHaveBeenCalledTimes(1); // cached
  now += 3599 * 1000 - REFRESH_MARGIN_MS + 1; // inside the refresh margin
  await provider.getToken();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(readFile).toHaveBeenCalledTimes(2);
  expect(readFile).toHaveBeenCalledWith("h1");
});

test("caching: concurrent callers share one request", async () => {
  let calls = 0;
  const p = new CachingTokenProvider(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return { token: `t${calls}`, expiresAt: Date.now() + 3600_000 };
  });
  const [a, b] = await Promise.all([p.getToken(), p.getToken()]);
  expect(a.token).toBe("t1");
  expect(b.token).toBe("t1");
  await p.invalidate();
  expect((await p.getToken()).token).toBe("t2");
});

test("adc: authorized_user refresh-token flow", async () => {
  const fetch = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => jsonResponse(fx("token-response.json")));
  const provider = createTokenProvider("adc", { adcJson: fx("adc-authorized-user.json") }, { fetch });
  expect((await provider.getToken()).token).toBe("ya29.c.test-service-account-token");
  const form = new URLSearchParams(String(fetch.mock.calls[0]![1]!.body));
  expect(Object.fromEntries(form)).toEqual({
    grant_type: "refresh_token",
    refresh_token: "1//0test-refresh-token-not-real",
    client_id: "000000000000-testclientid.apps.googleusercontent.com",
    client_secret: "test-client-secret",
  });
});

test("adc: a service_account file uses the JWT flow", async () => {
  const fetch = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => jsonResponse(fx("token-response.json")));
  const provider = createTokenProvider("adc", { adcFileHandleId: "h" }, { fetch, readFile: async () => saKeyJson() });
  await provider.getToken();
  expect(new URLSearchParams(String(fetch.mock.calls[0]![1]!.body)).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
});

test("impersonation: calls generateAccessToken with the base token", async () => {
  const fetch = vi.fn(async (url: string | URL | Request, _i?: RequestInit) =>
    String(url).includes("iamcredentials") ? jsonResponse(fx("generate-access-token-response.json")) : jsonResponse(fx("token-response.json")),
  );
  const provider = createTokenProvider(
    "impersonate",
    { base: { method: "service-account", options: { keyJson: saKeyJson() } }, targetServiceAccount: "target@p.iam.gserviceaccount.com" },
    { fetch },
  );
  const token = await provider.getToken();
  expect(token).toEqual({ token: "ya29.c.test-impersonated-token", expiresAt: Date.parse("2026-10-29T18:30:00Z") });
  const [url, init] = fetch.mock.calls[1]!;
  expect(url).toBe("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/target%40p.iam.gserviceaccount.com:generateAccessToken");
  expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer ya29.c.test-service-account-token");
  expect(JSON.parse(String(init!.body))).toEqual({ scope: ["https://www.googleapis.com/auth/bigquery"], lifetime: "3600s" });
  // Base token asked for cloud-platform scope, which iamcredentials needs.
  const assertion = new URLSearchParams(String(fetch.mock.calls[0]![1]!.body)).get("assertion")!;
  const claims = JSON.parse(new TextDecoder().decode(base64urlDecode(assertion.split(".")[1]!)));
  expect(claims.scope).toBe("https://www.googleapis.com/auth/cloud-platform");
});

test("chrome profile: uses chrome.identity and drops Chrome's cached token on invalidate", async () => {
  const identity: IdentityApi = {
    getAuthToken: vi.fn(async () => ({ token: "chrome-token" })),
    removeCachedAuthToken: vi.fn(async () => undefined),
    launchWebAuthFlow: vi.fn(),
    getRedirectURL: () => "",
  };
  const provider = createTokenProvider("chrome-profile", {}, { identity });
  expect((await provider.getToken()).token).toBe("chrome-token");
  expect(identity.getAuthToken).toHaveBeenCalledWith({ interactive: true, scopes: ["https://www.googleapis.com/auth/bigquery"] });
  await provider.invalidate!();
  expect(identity.removeCachedAuthToken).toHaveBeenCalledWith({ token: "chrome-token" });
});

test("web auth: PKCE sign-in stores the refresh token, then refreshes without a window", async () => {
  const secrets = memorySecrets();
  let authUrl = "";
  const identity: IdentityApi = {
    getAuthToken: vi.fn(),
    removeCachedAuthToken: vi.fn(),
    getRedirectURL: (p) => `https://abcdef.chromiumapp.org/${p ?? ""}`,
    launchWebAuthFlow: vi.fn(async ({ url }) => {
      authUrl = url;
      const state = new URL(url).searchParams.get("state");
      return `https://abcdef.chromiumapp.org/oauth2?code=4/0test-code&state=${state}`;
    }),
  };
  const bodies: URLSearchParams[] = [];
  const fetch = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
    bodies.push(new URLSearchParams(String(init!.body)));
    return jsonResponse(JSON.stringify({ access_token: `at${bodies.length}`, expires_in: 3600, refresh_token: bodies.length === 1 ? "rt-1" : undefined }));
  });
  let now = 0;
  const provider = createTokenProvider("web-auth", { refreshTokenRef: "c_1_refresh" }, { identity, secrets, fetch, now: () => now });

  expect((await provider.getToken()).token).toBe("at1");
  const q = new URL(authUrl).searchParams;
  expect(q.get("code_challenge_method")).toBe("S256");
  expect(q.get("access_type")).toBe("offline");
  expect(bodies[0]!.get("grant_type")).toBe("authorization_code");
  expect(bodies[0]!.get("code")).toBe("4/0test-code");
  // The verifier hashes to the challenge sent in the auth URL.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodies[0]!.get("code_verifier")!));
  expect(Buffer.from(digest).toString("base64url")).toBe(q.get("code_challenge"));
  expect(secrets.map.get("c_1_refresh")).toBe("rt-1");

  now += 3600_000;
  expect((await provider.getToken()).token).toBe("at2");
  expect(bodies[1]!.get("grant_type")).toBe("refresh_token");
  expect(identity.launchWebAuthFlow).toHaveBeenCalledTimes(1);
});

test("web auth: a revoked refresh token is forgotten; non-interactive asks to sign in", async () => {
  const secrets = memorySecrets({ r: "old" });
  const fetch = vi.fn(async () => jsonResponse(fx("invalid-grant-response.json"), 400));
  const provider = createTokenProvider("web-auth", { refreshTokenRef: "r", interactive: false }, { secrets, fetch });
  await expect(provider.getToken()).rejects.toMatchObject({ code: "needs_sign_in" });
  expect(secrets.map.has("r")).toBe(false);
});

test("pasted token: returned until it expires", async () => {
  let now = 0;
  const provider = createTokenProvider("access-token", { token: " ya29.pasted ", expiresAt: 1000 }, { now: () => now });
  expect(await provider.getToken()).toEqual({ token: "ya29.pasted", expiresAt: 1000 });
  now = 1000;
  await expect(provider.getToken()).rejects.toBeInstanceOf(AuthError);
});

test("pkce pair: verifier is 43 url-safe chars", async () => {
  const { verifier, challenge } = await pkcePair();
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("chrome profile: a missing OAuth client becomes an actionable error", async () => {
  const identity: IdentityApi = {
    getAuthToken: vi.fn(async () => {
      throw new Error("Invalid OAuth2 Client ID.");
    }),
    removeCachedAuthToken: vi.fn(async () => undefined),
    launchWebAuthFlow: vi.fn(),
    getRedirectURL: () => "",
  };
  const provider = createTokenProvider("chrome-profile", {}, { identity });
  await expect(provider.getToken()).rejects.toMatchObject({ code: "oauth_client_missing" });
  await expect(provider.getToken()).rejects.toThrow(/gcloud login.*Paste a token/);
});
