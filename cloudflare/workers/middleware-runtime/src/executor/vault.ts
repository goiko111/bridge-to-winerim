import { sql, type DatabaseAdapter } from "../../../middleware-api/src/db";
import type { SecretTextPort } from "../adapters/http";
import type {
  RuntimeConnectionConfigurationPort,
  RuntimeCredentialAccessPort,
  RuntimeCredentialKind,
} from "./composition";

const AES_GCM_NONCE_BYTES = 12;
const AES_256_KEY_BYTES = 32;
const MAX_SECRET_BYTES = 8 * 1024;
const RUNTIME_CREDENTIAL_REFERENCE_PREFIX = "runtime-vault://postgres";

type RuntimeConnectionRow = Record<string, unknown> & {
  connection_id: unknown;
  provider: unknown;
  enabled: unknown;
  base_url: unknown;
};

type RuntimeCredentialRow = Record<string, unknown> & {
  connection_id: unknown;
  provider: unknown;
  credential_kind: unknown;
  algorithm: unknown;
  key_version: unknown;
  aad_version: unknown;
  ciphertext_base64: unknown;
  nonce_base64: unknown;
  active: unknown;
};

export type RuntimeVaultSecretBinding = Readonly<{
  get(): Promise<string>;
}>;

export type RuntimeCredentialVaultOptions = Readonly<{
  masterKey: RuntimeVaultSecretBinding;
  keyVersion: string;
}>;

export type RuntimeCredentialAttestation = Readonly<{
  reference: string;
  version: string;
  connectionId: string;
  provider: string;
  kind: RuntimeCredentialKind;
}>;

export type RuntimeAttestedSecretTextPort = SecretTextPort & Readonly<{
  attestation(): RuntimeCredentialAttestation;
}>;

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function decodeBase64(value: unknown): Uint8Array {
  // PostgreSQL encode(bytea, 'base64') wraps long values at 76 characters.
  // Accept only ASCII base64 whitespace before applying the strict alphabet.
  const encoded = text(value).replace(/[\t\n\r ]+/g, "");
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("RUNTIME_VAULT_INVALID_CIPHERTEXT");
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalizedBase64(value: unknown): string {
  return text(value).replace(/[\t\n\r ]+/g, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function credentialAttestation(
  row: RuntimeCredentialRow,
): Promise<RuntimeCredentialAttestation> {
  const connectionId = text(row.connection_id);
  const provider = text(row.provider).toLowerCase();
  const kind = text(row.credential_kind) as RuntimeCredentialKind;
  const keyVersion = text(row.key_version);
  const aadVersion = Number(row.aad_version);
  const reference = `${RUNTIME_CREDENTIAL_REFERENCE_PREFIX}/${connectionId}/${provider}/${kind}`;
  const version = await sha256Hex([
    "winerim-runtime-credential-attestation",
    "1",
    reference,
    keyVersion,
    String(aadVersion),
    normalizedBase64(row.nonce_base64),
    normalizedBase64(row.ciphertext_base64),
  ].join("|"));
  return Object.freeze({ reference, version, connectionId, provider, kind });
}

export function runtimeCredentialAttestation(
  credential: SecretTextPort,
): RuntimeCredentialAttestation {
  const candidate = credential as Partial<RuntimeAttestedSecretTextPort>;
  if (typeof candidate.attestation !== "function") {
    throw new Error("RUNTIME_VAULT_ATTESTATION_MISSING");
  }
  const attestation = candidate.attestation();
  if (
    !attestation
    || !attestation.reference.startsWith(`${RUNTIME_CREDENTIAL_REFERENCE_PREFIX}/`)
    || !/^[a-f0-9]{64}$/.test(attestation.version)
    || !attestation.connectionId
    || attestation.provider !== "agora"
    || !["agora", "winerim"].includes(attestation.kind)
  ) {
    throw new Error("RUNTIME_VAULT_ATTESTATION_INVALID");
  }
  return attestation;
}

function credentialAad(input: {
  connectionId: string;
  provider: string;
  kind: RuntimeCredentialKind;
  keyVersion: string;
  aadVersion: number;
}): Uint8Array {
  return new TextEncoder().encode([
    "winerim-runtime-credential",
    String(input.aadVersion),
    input.connectionId,
    input.provider.toLowerCase(),
    input.kind,
    input.keyVersion,
  ].join("|"));
}

async function importMasterKey(binding: RuntimeVaultSecretBinding): Promise<CryptoKey> {
  const raw = decodeBase64(await binding.get());
  if (raw.byteLength !== AES_256_KEY_BYTES) {
    throw new Error("RUNTIME_VAULT_INVALID_MASTER_KEY");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
}

async function decryptCredential(
  row: RuntimeCredentialRow,
  options: RuntimeCredentialVaultOptions,
): Promise<string> {
  const connectionId = text(row.connection_id);
  const provider = text(row.provider).toLowerCase();
  const kind = text(row.credential_kind) as RuntimeCredentialKind;
  const keyVersion = text(row.key_version);
  const aadVersion = Number(row.aad_version);
  if (
    !connectionId
    || provider !== "agora"
    || !["agora", "winerim"].includes(kind)
    || keyVersion !== options.keyVersion
    || aadVersion !== 1
    || row.active !== true
    || text(row.algorithm) !== "AES-256-GCM"
  ) {
    throw new Error("RUNTIME_VAULT_SCOPE_REJECTED");
  }

  const nonce = decodeBase64(row.nonce_base64);
  const ciphertext = decodeBase64(row.ciphertext_base64);
  if (nonce.byteLength !== AES_GCM_NONCE_BYTES || ciphertext.byteLength <= 16) {
    throw new Error("RUNTIME_VAULT_INVALID_CIPHERTEXT");
  }
  const key = await importMasterKey(options.masterKey);
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: nonce,
    additionalData: credentialAad({ connectionId, provider, kind, keyVersion, aadVersion }),
    tagLength: 128,
  }, key, ciphertext);
  if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_SECRET_BYTES) {
    throw new Error("RUNTIME_VAULT_INVALID_PLAINTEXT");
  }
  const value = new TextDecoder("utf-8", { fatal: true }).decode(plaintext).trim();
  if (!value || /[\r\n]/.test(value)) throw new Error("RUNTIME_VAULT_INVALID_PLAINTEXT");
  return value;
}

export function createPostgresRuntimeConnectionPort(
  database: DatabaseAdapter,
): RuntimeConnectionConfigurationPort {
  return {
    async load(connectionId) {
      const result = await database.query<RuntimeConnectionRow>(sql`
        SELECT id::text AS connection_id, provider, enabled, base_url
        FROM public.pos_connections
        WHERE id = ${connectionId}::uuid
        LIMIT 2
      `);
      if (result.rowCount !== 1) return null;
      const row = result.rows[0];
      return {
        connectionId: text(row.connection_id),
        provider: text(row.provider),
        enabled: row.enabled === true,
        baseUrl: text(row.base_url),
      };
    },
  };
}

export function createPostgresEncryptedCredentialPort(
  database: DatabaseAdapter,
  options: RuntimeCredentialVaultOptions,
): RuntimeCredentialAccessPort {
  return {
    async open(input): Promise<SecretTextPort | null> {
      const result = await database.query<RuntimeCredentialRow>(sql`
        SELECT
          connection_id::text,
          provider,
          credential_kind,
          algorithm,
          key_version,
          aad_version,
          encode(ciphertext, 'base64') AS ciphertext_base64,
          encode(nonce, 'base64') AS nonce_base64,
          active
        FROM public.runtime_connection_credentials
        WHERE connection_id = ${input.connectionId}::uuid
          AND provider = ${input.provider.toLowerCase()}
          AND credential_kind = ${input.kind}
          AND active = true
        LIMIT 2
      `);
      if (result.rowCount !== 1) return null;
      const row = result.rows[0];
      if (
        text(row.connection_id) !== input.connectionId
        || text(row.provider).toLowerCase() !== input.provider.toLowerCase()
        || text(row.credential_kind) !== input.kind
      ) {
        return null;
      }
      const value = await decryptCredential(row, options);
      const attestation = await credentialAttestation(row);
      return Object.freeze({
        read: () => value,
        attestation: () => attestation,
      }) as RuntimeAttestedSecretTextPort;
    },
  };
}
