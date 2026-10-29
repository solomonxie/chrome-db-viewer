// Where passwords, tokens and keys live (DESIGN.md §3.7). The rest of the app only keeps a
// secretRef. Never chrome.storage.sync, and secrets never go into IndexedDB or exports.

export type SecretMode = "session" | "browser" | "keychain";

export interface SecretStore {
  readonly kind: SecretMode;
  get(ref: string): Promise<string | null>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

/** "Ask every session": lives only as long as this page. */
export class MemorySecretStore implements SecretStore {
  readonly kind = "session" as const;
  private map = new Map<string, string>();
  async get(ref: string) {
    return this.map.get(ref) ?? null;
  }
  async set(ref: string, value: string) {
    this.map.set(ref, value);
  }
  async delete(ref: string) {
    this.map.delete(ref);
  }
}

/** "Remember in this browser": chrome.storage.local, local profile only. */
export class LocalSecretStore implements SecretStore {
  readonly kind = "browser" as const;
  private key = (ref: string) => `secret:${ref}`;
  async get(ref: string) {
    const k = this.key(ref);
    const got = await chrome.storage.local.get(k);
    const v = got[k];
    return typeof v === "string" ? v : null;
  }
  async set(ref: string, value: string) {
    await chrome.storage.local.set({ [this.key(ref)]: value });
  }
  async delete(ref: string) {
    await chrome.storage.local.remove(this.key(ref));
  }
}

const memory = new MemorySecretStore();
const local = new LocalSecretStore();

export function secretStore(mode: SecretMode): SecretStore {
  // Keychain (via the runner's secret.* ops) is not wired yet; fall back to memory.
  return mode === "browser" ? local : memory;
}

/** Looks in memory first (secrets typed this session), then the browser store. */
export async function readSecret(ref: string, mode: SecretMode): Promise<string | null> {
  const m = await memory.get(ref);
  if (m !== null) return m;
  return mode === "browser" ? local.get(ref) : null;
}

export async function forgetSecret(ref: string): Promise<void> {
  await memory.delete(ref);
  try {
    await local.delete(ref);
  } catch {
    /* not in an extension context */
  }
}

export const sessionSecrets = memory;
