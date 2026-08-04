const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_PLAINTEXT_BYTES = 8 * 1024;

export type RuntimeCredentialKind = "agora" | "winerim";

export type EncryptedRuntimeCredential = Readonly<{
  kind: RuntimeCredentialKind;
  nonceHex: string;
  ciphertextHex: string;
  attestationSha256: string;
}>;

export function validateCredentialScope(input: {
  connectionId: string;
  runId: string;
  keyVersion: string;
}): void {
  if (!UUID_PATTERN.test(input.connectionId)) throw new Error("PROVISION_INVALID_CONNECTION_ID");
  if (!RUN_PATTERN.test(input.runId)) throw new Error("PROVISION_INVALID_RUN_ID");
  if (!KEY_VERSION_PATTERN.test(input.keyVersion)) throw new Error("PROVISION_INVALID_KEY_VERSION");
}

export function validatePlaintextCredential(value: unknown): string {
  if (typeof value !== "string") throw new Error("PROVISION_INVALID_PLAINTEXT");
  const bytes = new TextEncoder().encode(value);
  if (
    bytes.byteLength === 0
    || bytes.byteLength > MAX_PLAINTEXT_BYTES
    || value !== value.trim()
    || /[\r\n]/.test(value)
  ) {
    throw new Error("PROVISION_INVALID_PLAINTEXT");
  }
  return value;
}

export function runtimeCredentialAad(input: {
  connectionId: string;
  kind: RuntimeCredentialKind;
  keyVersion: string;
}): string {
  return [
    "winerim-runtime-credential",
    "1",
    input.connectionId,
    "agora",
    input.kind,
    input.keyVersion,
  ].join("|");
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function strictBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("PROVISION_VAULT_KEY_INVALID");
  }
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytesToBase64(bytes) !== value) throw new Error("PROVISION_VAULT_KEY_INVALID");
  return bytes;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function importVaultEncryptionKey(rawBase64: string): Promise<CryptoKey> {
  const raw = strictBase64(rawBase64);
  try {
    if (raw.byteLength !== 32) throw new Error("PROVISION_VAULT_KEY_INVALID");
    return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
  } finally {
    raw.fill(0);
  }
}

export async function encryptRuntimeCredential(input: {
  connectionId: string;
  kind: RuntimeCredentialKind;
  keyVersion: string;
  plaintext: string;
  key: CryptoKey;
  nonce?: Uint8Array;
}): Promise<EncryptedRuntimeCredential> {
  validateCredentialScope({ connectionId: input.connectionId, runId: "scope-only", keyVersion: input.keyVersion });
  const plaintext = validatePlaintextCredential(input.plaintext);
  const nonce = input.nonce ?? crypto.getRandomValues(new Uint8Array(12));
  if (!(nonce instanceof Uint8Array) || nonce.byteLength !== 12) {
    throw new Error("PROVISION_NONCE_INVALID");
  }
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: nonce,
    additionalData: new TextEncoder().encode(runtimeCredentialAad(input)),
    tagLength: 128,
  }, input.key, new TextEncoder().encode(plaintext)));
  const reference = `runtime-vault://postgres/${input.connectionId}/agora/${input.kind}`;
  const attestationSha256 = await sha256Hex([
    "winerim-runtime-credential-attestation",
    "1",
    reference,
    input.keyVersion,
    "1",
    bytesToBase64(nonce),
    bytesToBase64(ciphertext),
  ].join("|"));
  return {
    kind: input.kind,
    nonceHex: bytesToHex(nonce),
    ciphertextHex: bytesToHex(ciphertext),
    attestationSha256,
  };
}
