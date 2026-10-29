// Google auth for BigQuery (design/DESIGN.md §3.8). One entry point for the connection form:
//   createTokenProvider(method, options, deps)

import {
  IMPERSONATION_BASE_SCOPES,
  AuthError,
  accessTokenProvider,
  adcProvider,
  chromeProfileProvider,
  impersonateProvider,
  serviceAccountProvider,
  webAuthProvider,
} from "./providers";
import type { GoogleAuthDeps, GoogleAuthMethod, MethodOptions, TokenProvider } from "./types";

export * from "./types";
export {
  AuthError,
  CachingTokenProvider,
  REFRESH_MARGIN_MS,
  accessTokenProvider,
  adcProvider,
  chromeIdentity,
  chromeProfileProvider,
  impersonateProvider,
  pkcePair,
  serviceAccountProvider,
  serviceAccountToken,
  webAuthProvider,
} from "./providers";
export { signJwt, base64url, base64urlDecode, pemToDer } from "./jwt";

/** Labels for the connection form, in display order. */
export const GOOGLE_AUTH_METHODS: { method: GoogleAuthMethod; label: string }[] = [
  { method: "chrome-profile", label: "Chrome profile account" },
  { method: "web-auth", label: "Any Google account" },
  { method: "service-account", label: "Service account key (JSON)" },
  { method: "adc", label: "gcloud ADC file" },
  { method: "impersonate", label: "Service account impersonation" },
  { method: "access-token", label: "Paste an access token" },
];

export function createTokenProvider<M extends GoogleAuthMethod>(
  method: M,
  options: MethodOptions[M],
  deps: GoogleAuthDeps = {},
): TokenProvider {
  switch (method) {
    case "chrome-profile":
      return chromeProfileProvider(options as MethodOptions["chrome-profile"], deps);
    case "web-auth":
      return webAuthProvider(options as MethodOptions["web-auth"], deps);
    case "service-account":
      return serviceAccountProvider(options as MethodOptions["service-account"], deps);
    case "adc":
      return adcProvider(options as MethodOptions["adc"], deps);
    case "impersonate": {
      const { base, ...rest } = options as MethodOptions["impersonate"];
      if (!base || (base.method as string) === "impersonate") throw new AuthError("Impersonation needs a base sign-in method", "bad_options");
      if (!rest.targetServiceAccount) throw new AuthError("Enter the service account to impersonate", "bad_options");
      // The base token only calls iamcredentials, which needs cloud-platform scope.
      const baseOptions = { scopes: IMPERSONATION_BASE_SCOPES, ...base.options };
      const baseProvider = createTokenProvider(base.method, baseOptions as never, deps);
      return impersonateProvider(baseProvider, rest, deps);
    }
    case "access-token":
      return accessTokenProvider(options as MethodOptions["access-token"], deps);
    default:
      throw new AuthError(`Unknown Google auth method: ${String(method)}`, "bad_method");
  }
}
