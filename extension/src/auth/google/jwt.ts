// RS256 JWTs for service-account keys, signed with WebCrypto (no dependencies).

export function base64url(bytes: Uint8Array | string): string {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let bin = "";
  for (const b of data) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** PEM "PRIVATE KEY" (PKCS#8) → DER bytes. */
export function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  if (/BEGIN RSA PRIVATE KEY/.test(pem)) {
    throw new Error("PKCS#1 keys are not supported; Google service-account keys are PKCS#8 (BEGIN PRIVATE KEY)");
  }
  const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

export async function signJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  privateKeyPem: string,
): Promise<string> {
  const key = await importPrivateKey(privateKeyPem);
  const input = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT", ...header }))}.${base64url(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${base64url(new Uint8Array(sig))}`;
}
