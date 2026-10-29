// Shared types for Google auth (design/DESIGN.md §3.8).
// Every sign-in method yields short-lived access tokens through one TokenProvider.

export interface AccessToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface TokenProvider {
  getToken(signal?: AbortSignal): Promise<AccessToken>;
  /** Drops any cached token, e.g. after a 401. The next getToken() fetches a fresh one. */
  invalidate?(): Promise<void>;
}

export type GoogleAuthMethod =
  | "chrome-profile"
  | "web-auth"
  | "service-account"
  | "adc"
  | "impersonate"
  | "access-token";

export const BIGQUERY_SCOPE = "https://www.googleapis.com/auth/bigquery";
export const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const IAM_CREDENTIALS_URL = "https://iamcredentials.googleapis.com/v1";

/**
 * OAuth client for the "Any Google account" flow. Placeholder: replace with the real
 * client id (and secret, if Google issues one for the client type) before release.
 */
export const OAUTH_CLIENT_ID = "REPLACE_ME.apps.googleusercontent.com";

/** Where refresh tokens and keys are kept (runner Keychain or chrome.storage.local, §3.7). */
export interface SecretStore {
  get(ref: string): Promise<string | null>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

/** The parts of chrome.identity the providers use; injectable for tests. */
export interface IdentityApi {
  getAuthToken(details: { interactive?: boolean; scopes?: string[] }): Promise<{ token?: string } | string | undefined>;
  removeCachedAuthToken(details: { token: string }): Promise<void>;
  launchWebAuthFlow(details: { url: string; interactive?: boolean }): Promise<string | undefined>;
  getRedirectURL(path?: string): string;
}

export interface GoogleAuthDeps {
  fetch?: typeof fetch;
  identity?: IdentityApi;
  secrets?: SecretStore;
  /** Reads a picked file (service-account key, ADC JSON) from its stored handle id. */
  readFile?: (handleId: string) => Promise<string>;
  now?: () => number;
}

export interface ChromeProfileOptions {
  interactive?: boolean;
  scopes?: string[];
}

export interface WebAuthOptions {
  /** Key in the SecretStore where the refresh token is kept. Required. */
  refreshTokenRef: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  /** Allow opening the Google sign-in window when there is no usable refresh token. */
  interactive?: boolean;
  loginHint?: string;
}

/** A service-account key file as downloaded from the Cloud Console. */
export interface ServiceAccountKey {
  type: "service_account";
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
  project_id?: string;
}

export interface AuthorizedUserCredentials {
  type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
  quota_project_id?: string;
}

export interface ServiceAccountOptions {
  /** Key JSON as text or parsed object. */
  keyJson?: string | ServiceAccountKey;
  /** Handle id of the key file; read on every refresh so the key stays on disk. */
  keyFileHandleId?: string;
  /** SecretStore key holding the key JSON. */
  keySecretRef?: string;
  scopes?: string[];
}

export interface AdcOptions {
  /** application_default_credentials.json as text or parsed object. */
  adcJson?: string | AuthorizedUserCredentials | ServiceAccountKey;
  adcFileHandleId?: string;
  scopes?: string[];
}

export interface ImpersonateOptions {
  /** The provider whose token calls iamcredentials (needs roles/iam.serviceAccountTokenCreator). */
  base: { method: Exclude<GoogleAuthMethod, "impersonate">; options: Record<string, unknown> };
  targetServiceAccount: string;
  delegates?: string[];
  scopes?: string[];
  /** Default 3600. */
  lifetimeSeconds?: number;
}

export interface AccessTokenOptions {
  token: string;
  /** Epoch ms. Defaults to one hour from creation. */
  expiresAt?: number;
}

export interface MethodOptions {
  "chrome-profile": ChromeProfileOptions;
  "web-auth": WebAuthOptions;
  "service-account": ServiceAccountOptions;
  adc: AdcOptions;
  impersonate: ImpersonateOptions;
  "access-token": AccessTokenOptions;
}
