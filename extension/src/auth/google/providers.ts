// TokenProviders for each BigQuery sign-in method (design/DESIGN.md §3.8).

import { base64url, signJwt } from "./jwt";
import {
  BIGQUERY_SCOPE,
  CLOUD_PLATFORM_SCOPE,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  IAM_CREDENTIALS_URL,
  OAUTH_CLIENT_ID,
  type AccessToken,
  type AccessTokenOptions,
  type AdcOptions,
  type AuthorizedUserCredentials,
  type ChromeProfileOptions,
  type GoogleAuthDeps,
  type IdentityApi,
  type ImpersonateOptions,
  type ServiceAccountKey,
  type ServiceAccountOptions,
  type TokenProvider,
  type WebAuthOptions,
} from "./types";

/** Refresh this long before a token expires so a query never starts with a dying token. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** chrome.identity doesn't report expiry; Google access tokens live one hour. */
const DEFAULT_LIFETIME_MS = 3600 * 1000;

export class AuthError extends Error {
  constructor(message: string, public code?: string, public detail?: unknown) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Caches the inner provider's token until REFRESH_MARGIN_MS before expiry, and shares one
 * in-flight request between concurrent callers.
 */
export class CachingTokenProvider implements TokenProvider {
  private cached: AccessToken | null = null;
  private inflight: Promise<AccessToken> | null = null;

  constructor(
    private readonly fetchToken: (signal?: AbortSignal) => Promise<AccessToken>,
    private readonly now: () => number = Date.now,
    private readonly onInvalidate?: (token: AccessToken | null) => Promise<void>,
  ) {}

  async getToken(signal?: AbortSignal): Promise<AccessToken> {
    signal?.throwIfAborted();
    if (this.cached && this.cached.expiresAt - REFRESH_MARGIN_MS > this.now()) return this.cached;
    if (!this.inflight) {
      this.inflight = this.fetchToken(signal)
        .then((t) => {
          this.cached = t;
          return t;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  async invalidate(): Promise<void> {
    const old = this.cached;
    this.cached = null;
    await this.onInvalidate?.(old);
  }
}

function fetchFn(deps: GoogleAuthDeps): typeof fetch {
  return deps.fetch ?? ((...args) => globalThis.fetch(...args));
}

async function postForm(
  deps: GoogleAuthDeps,
  url: string,
  form: Record<string, string>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await fetchFn(deps)(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = String(body.error_description ?? body.error ?? `HTTP ${res.status}`);
    throw new AuthError(`Google token request failed: ${msg}`, String(body.error ?? res.status), body);
  }
  return body;
}

function tokenFromResponse(body: Record<string, unknown>, now: number): AccessToken {
  if (typeof body.access_token !== "string") throw new AuthError("Token response had no access_token", "bad_response", body);
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : Number(body.expires_in ?? 3600);
  return { token: body.access_token, expiresAt: now + expiresIn * 1000 };
}

function parseJson<T>(value: string | T, what: string): T {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new AuthError(`${what} is not valid JSON`, "bad_json");
  }
}

// --- Chrome profile account ---------------------------------------------------------------

export function chromeIdentity(): IdentityApi {
  if (typeof chrome === "undefined" || !chrome.identity) throw new AuthError("chrome.identity is not available", "no_identity");
  return {
    getAuthToken: (d) => chrome.identity.getAuthToken(d) as Promise<{ token?: string }>,
    removeCachedAuthToken: (d) => chrome.identity.removeCachedAuthToken(d),
    launchWebAuthFlow: (d) => chrome.identity.launchWebAuthFlow(d),
    getRedirectURL: (p) => chrome.identity.getRedirectURL(p),
  };
}

export function chromeProfileProvider(opts: ChromeProfileOptions, deps: GoogleAuthDeps = {}): CachingTokenProvider {
  const now = deps.now ?? Date.now;
  const identity = () => deps.identity ?? chromeIdentity();
  return new CachingTokenProvider(
    async () => {
      let res: Awaited<ReturnType<ReturnType<typeof identity>["getAuthToken"]>>;
      try {
        res = await identity().getAuthToken({ interactive: opts.interactive ?? true, scopes: opts.scopes ?? [BIGQUERY_SCOPE] });
      } catch (e) {
        // Chrome raises this when the manifest has no oauth2.client_id registered for this extension ID.
        if (/oauth2|client id/i.test(String((e as Error)?.message ?? e))) {
          throw new AuthError(
            "Chrome sign-in isn't set up in this build (it needs an OAuth client registered for this extension). Choose \"gcloud login\" or \"Paste a token\" instead.",
            "oauth_client_missing",
          );
        }
        throw e;
      }
      const token = typeof res === "string" ? res : res?.token;
      if (!token) throw new AuthError("Chrome did not return a token. Sign in to Chrome or allow access.", "no_token");
      return { token, expiresAt: now() + DEFAULT_LIFETIME_MS };
    },
    now,
    // Chrome caches its own tokens; drop the stale one there too, or getAuthToken returns it again.
    async (old) => {
      if (old) await identity().removeCachedAuthToken({ token: old.token });
    },
  );
}

// --- Any Google account: web auth flow with PKCE ------------------------------------------

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function webAuthProvider(opts: WebAuthOptions, deps: GoogleAuthDeps = {}): CachingTokenProvider {
  const now = deps.now ?? Date.now;
  const clientId = opts.clientId ?? OAUTH_CLIENT_ID;
  const scopes = opts.scopes ?? [BIGQUERY_SCOPE];
  if (!deps.secrets) throw new AuthError("The web auth flow needs a secret store for its refresh token", "no_secret_store");
  const secrets = deps.secrets;
  const withSecret = (form: Record<string, string>) => (opts.clientSecret ? { ...form, client_secret: opts.clientSecret } : form);

  async function signIn(signal?: AbortSignal): Promise<AccessToken> {
    const identity = deps.identity ?? chromeIdentity();
    const redirectUri = identity.getRedirectURL("oauth2");
    const { verifier, challenge } = await pkcePair();
    const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      state,
    });
    if (opts.loginHint) params.set("login_hint", opts.loginHint);
    const redirected = await identity.launchWebAuthFlow({ url: `${GOOGLE_AUTH_URL}?${params}`, interactive: true });
    if (!redirected) throw new AuthError("Sign-in was cancelled", "cancelled");
    const back = new URL(redirected).searchParams;
    if (back.get("error")) throw new AuthError(`Sign-in failed: ${back.get("error")}`, back.get("error") ?? undefined);
    if (back.get("state") !== state) throw new AuthError("Sign-in state mismatch", "state_mismatch");
    const code = back.get("code");
    if (!code) throw new AuthError("Sign-in returned no code", "no_code");
    const body = await postForm(
      deps,
      GOOGLE_TOKEN_URL,
      withSecret({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri }),
      signal,
    );
    if (typeof body.refresh_token === "string") await secrets.set(opts.refreshTokenRef, body.refresh_token);
    return tokenFromResponse(body, now());
  }

  return new CachingTokenProvider(async (signal) => {
    const refresh = await secrets.get(opts.refreshTokenRef);
    if (refresh) {
      try {
        const body = await postForm(
          deps,
          GOOGLE_TOKEN_URL,
          withSecret({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId }),
          signal,
        );
        return tokenFromResponse(body, now());
      } catch (e) {
        // A revoked refresh token: forget it and sign in again if allowed.
        if (!(e instanceof AuthError && e.code === "invalid_grant")) throw e;
        await secrets.delete(opts.refreshTokenRef);
      }
    }
    if (opts.interactive === false) throw new AuthError("Not signed in. Sign in from the connection settings.", "needs_sign_in");
    return signIn(signal);
  }, now);
}

// --- Service account key ------------------------------------------------------------------

export async function serviceAccountToken(
  key: ServiceAccountKey,
  scopes: string[],
  deps: GoogleAuthDeps,
  signal?: AbortSignal,
): Promise<AccessToken> {
  const now = (deps.now ?? Date.now)();
  const iat = Math.floor(now / 1000);
  const aud = key.token_uri ?? GOOGLE_TOKEN_URL;
  const assertion = await signJwt(
    key.private_key_id ? { kid: key.private_key_id } : {},
    { iss: key.client_email, scope: scopes.join(" "), aud, iat, exp: iat + 3600 },
    key.private_key,
  );
  const body = await postForm(deps, aud, { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }, signal);
  return tokenFromResponse(body, now);
}

function checkServiceAccountKey(key: ServiceAccountKey): ServiceAccountKey {
  if (key.type !== "service_account" || !key.client_email || !key.private_key) {
    throw new AuthError("Not a service-account key file (expected type, client_email and private_key)", "bad_key");
  }
  return key;
}

export function serviceAccountProvider(opts: ServiceAccountOptions, deps: GoogleAuthDeps = {}): CachingTokenProvider {
  const scopes = opts.scopes ?? [BIGQUERY_SCOPE];
  async function loadKey(): Promise<ServiceAccountKey> {
    if (opts.keyJson) return checkServiceAccountKey(parseJson<ServiceAccountKey>(opts.keyJson, "Service-account key"));
    if (opts.keyFileHandleId) {
      if (!deps.readFile) throw new AuthError("No file reader for the key file handle", "no_file_reader");
      return checkServiceAccountKey(parseJson<ServiceAccountKey>(await deps.readFile(opts.keyFileHandleId), "Service-account key"));
    }
    if (opts.keySecretRef) {
      const text = await deps.secrets?.get(opts.keySecretRef);
      if (!text) throw new AuthError("Service-account key not found in the secret store", "no_key");
      return checkServiceAccountKey(parseJson<ServiceAccountKey>(text, "Service-account key"));
    }
    throw new AuthError("Pick a service-account key file", "no_key");
  }
  return new CachingTokenProvider(async (signal) => serviceAccountToken(await loadKey(), scopes, deps, signal), deps.now);
}

// --- gcloud ADC file ----------------------------------------------------------------------

export function adcProvider(opts: AdcOptions, deps: GoogleAuthDeps = {}): CachingTokenProvider {
  const scopes = opts.scopes ?? [BIGQUERY_SCOPE];
  const now = deps.now ?? Date.now;
  async function load(): Promise<AuthorizedUserCredentials | ServiceAccountKey> {
    if (opts.adcJson) return parseJson<AuthorizedUserCredentials | ServiceAccountKey>(opts.adcJson, "ADC file");
    if (opts.adcFileHandleId) {
      if (!deps.readFile) throw new AuthError("No file reader for the ADC file handle", "no_file_reader");
      return parseJson<AuthorizedUserCredentials | ServiceAccountKey>(await deps.readFile(opts.adcFileHandleId), "ADC file");
    }
    throw new AuthError("Pick application_default_credentials.json", "no_adc");
  }
  return new CachingTokenProvider(async (signal) => {
    const creds = await load();
    if (creds.type === "service_account") return serviceAccountToken(checkServiceAccountKey(creds), scopes, deps, signal);
    if (creds.type === "authorized_user") {
      // gcloud's user credentials carry their own scopes; Google ignores a scope param here.
      const body = await postForm(
        deps,
        GOOGLE_TOKEN_URL,
        { grant_type: "refresh_token", refresh_token: creds.refresh_token, client_id: creds.client_id, client_secret: creds.client_secret },
        signal,
      );
      return tokenFromResponse(body, now());
    }
    throw new AuthError(
      `ADC type "${(creds as { type?: string }).type}" needs the runner (workload identity federation)`,
      "unsupported_adc",
    );
  }, now);
}

// --- Service account impersonation --------------------------------------------------------

export function impersonateProvider(base: TokenProvider, opts: Omit<ImpersonateOptions, "base">, deps: GoogleAuthDeps = {}): CachingTokenProvider {
  const now = deps.now ?? Date.now;
  return new CachingTokenProvider(async (signal) => {
    const { token } = await base.getToken(signal);
    const name = encodeURIComponent(opts.targetServiceAccount);
    const res = await fetchFn(deps)(`${IAM_CREDENTIALS_URL}/projects/-/serviceAccounts/${name}:generateAccessToken`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: opts.scopes ?? [BIGQUERY_SCOPE],
        lifetime: `${opts.lifetimeSeconds ?? 3600}s`,
        ...(opts.delegates?.length ? { delegates: opts.delegates.map((d) => `projects/-/serviceAccounts/${d}`) } : {}),
      }),
      signal,
    });
    const body = (await res.json().catch(() => ({}))) as { accessToken?: string; expireTime?: string; error?: { message?: string; status?: string } };
    if (!res.ok || !body.accessToken) {
      throw new AuthError(`Impersonation failed: ${body.error?.message ?? `HTTP ${res.status}`}`, body.error?.status, body);
    }
    const expiresAt = body.expireTime ? Date.parse(body.expireTime) : now() + (opts.lifetimeSeconds ?? 3600) * 1000;
    return { token: body.accessToken, expiresAt };
  }, now);
}

/** Base providers for impersonation need a scope that can call iamcredentials. */
export const IMPERSONATION_BASE_SCOPES = [CLOUD_PLATFORM_SCOPE];

// --- Pasted token -------------------------------------------------------------------------

export function accessTokenProvider(opts: AccessTokenOptions, deps: GoogleAuthDeps = {}): TokenProvider {
  const now = deps.now ?? Date.now;
  const expiresAt = opts.expiresAt ?? now() + DEFAULT_LIFETIME_MS;
  const token = opts.token.trim();
  if (!token) throw new AuthError("Paste an access token", "no_token");
  return {
    async getToken() {
      // No margin here: a pasted token can't be refreshed, so use it to the end.
      if (now() >= expiresAt) throw new AuthError("The pasted access token has expired. Paste a new one.", "expired");
      return { token, expiresAt };
    },
  };
}
