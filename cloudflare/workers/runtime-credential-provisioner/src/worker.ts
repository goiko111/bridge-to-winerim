import { verifyAccessIdentity, type AccessDependencies } from "./access";
import { RuntimeCredentialChallenge, type ChallengeBinding } from "./challengeStore";
import {
  encryptRuntimeCredential,
  importVaultEncryptionKey,
  validateCredentialScope,
  validatePlaintextCredential,
} from "./crypto";

type SecretsStoreSecretLike = Readonly<{ get(): Promise<string> }>;
type DurableStubLike = Readonly<{ fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }>;
type DurableNamespaceLike = Readonly<{
  idFromName(name: string): unknown;
  get(id: unknown): DurableStubLike;
}>;

export type RuntimeCredentialProvisionerEnv = Readonly<{
  PROVISIONING_ENABLED?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  ACCESS_MAX_TOKEN_TTL_SECONDS?: string;
  OPERATOR_KEY_ID?: string;
  OPERATOR_PUBLIC_KEY_JWK?: string;
  CHALLENGE_TTL_SECONDS?: string;
  RUNTIME_VAULT_KEY_VERSION?: string;
  RUNTIME_VAULT_KEY?: SecretsStoreSecretLike;
  RUNTIME_CREDENTIAL_CHALLENGES?: DurableNamespaceLike;
}>;

type WorkerDependencies = AccessDependencies & Readonly<{
  now?: () => number;
  randomUuid?: () => string;
  randomNonce?: () => Uint8Array;
}>;

type ChallengeRequest = Readonly<{
  version: 1;
  connectionId: string;
  runId: string;
  keyVersion: string;
}>;

type ProvisionRequest = Readonly<ChallengeRequest & {
  challengeId: string;
  challengeNonce: string;
  expiresAt: string;
  credentials: Readonly<{ agora: string; winerim: string }>;
}>;

const MAX_REQUEST_BYTES = 20 * 1024;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "pragma": "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}

function exactKeys(value: unknown, expected: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("OPERATOR_SIGNATURE_REJECTED");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function readBody(request: Request): Promise<Uint8Array> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new Error("REQUEST_MEDIA_TYPE_REJECTED");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new Error("REQUEST_TOO_LARGE");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_REQUEST_BYTES) {
    throw new Error("REQUEST_TOO_LARGE");
  }
  return bytes;
}

function parseJson<T>(bytes: Uint8Array): T {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch {
    throw new Error("REQUEST_JSON_REJECTED");
  }
}

function positiveInteger(value: string | undefined, min: number, max: number, label: string): number {
  if (!/^\d+$/.test(value ?? "")) throw new Error(label);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(label);
  return parsed;
}

function validateEnvironment(env: RuntimeCredentialProvisionerEnv): {
  accessMaxTtlSeconds: number;
  challengeTtlSeconds: number;
  keyVersion: string;
  operatorKeyId: string;
  operatorJwk: JsonWebKey;
} {
  if (env.PROVISIONING_ENABLED !== "true") throw new Error("PROVISIONING_DISABLED");
  if (typeof env.RUNTIME_VAULT_KEY?.get !== "function") throw new Error("VAULT_BINDING_MISSING");
  if (!env.RUNTIME_CREDENTIAL_CHALLENGES) throw new Error("CHALLENGE_STORE_MISSING");
  const accessMaxTtlSeconds = positiveInteger(
    env.ACCESS_MAX_TOKEN_TTL_SECONDS,
    60,
    3_600,
    "ACCESS_CONFIG_INVALID",
  );
  const challengeTtlSeconds = positiveInteger(
    env.CHALLENGE_TTL_SECONDS,
    30,
    120,
    "CHALLENGE_CONFIG_INVALID",
  );
  const keyVersion = String(env.RUNTIME_VAULT_KEY_VERSION ?? "").trim();
  const operatorKeyId = String(env.OPERATOR_KEY_ID ?? "").trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(operatorKeyId)) throw new Error("OPERATOR_CONFIG_INVALID");
  let operatorJwk: JsonWebKey;
  try {
    operatorJwk = JSON.parse(String(env.OPERATOR_PUBLIC_KEY_JWK ?? "")) as JsonWebKey;
  } catch {
    throw new Error("OPERATOR_CONFIG_INVALID");
  }
  if (operatorJwk.kty !== "OKP" || operatorJwk.crv !== "Ed25519" || !operatorJwk.x || operatorJwk.d) {
    throw new Error("OPERATOR_CONFIG_INVALID");
  }
  validateCredentialScope({
    connectionId: "00000000-0000-4000-8000-000000000000",
    runId: "config-check",
    keyVersion,
  });
  return { accessMaxTtlSeconds, challengeTtlSeconds, keyVersion, operatorKeyId, operatorJwk };
}

function validateChallengeRequest(value: unknown, expectedKeyVersion: string): ChallengeRequest {
  if (!exactKeys(value, ["version", "connectionId", "runId", "keyVersion"])) {
    throw new Error("CHALLENGE_REQUEST_REJECTED");
  }
  const request = value as unknown as ChallengeRequest;
  if (request.version !== 1 || request.keyVersion !== expectedKeyVersion) {
    throw new Error("CHALLENGE_REQUEST_REJECTED");
  }
  validateCredentialScope(request);
  return request;
}

function validateProvisionRequest(value: unknown, expectedKeyVersion: string): ProvisionRequest {
  if (!exactKeys(value, [
    "version",
    "challengeId",
    "challengeNonce",
    "expiresAt",
    "connectionId",
    "runId",
    "keyVersion",
    "credentials",
  ])) throw new Error("PROVISION_REQUEST_REJECTED");
  const request = value as unknown as ProvisionRequest;
  if (
    request.version !== 1
    || request.keyVersion !== expectedKeyVersion
    || !/^[0-9a-f-]{36}$/i.test(request.challengeId)
    || !/^[A-Za-z0-9_-]{43}$/.test(request.challengeNonce)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(request.expiresAt)
    || !exactKeys(request.credentials, ["agora", "winerim"])
  ) throw new Error("PROVISION_REQUEST_REJECTED");
  validateCredentialScope(request);
  validatePlaintextCredential(request.credentials.agora);
  validatePlaintextCredential(request.credentials.winerim);
  return request;
}

async function verifyOperatorSignature(
  body: Uint8Array,
  request: Request,
  expectedKeyId: string,
  publicJwk: JsonWebKey,
): Promise<void> {
  if (request.headers.get("x-operator-key-id") !== expectedKeyId) {
    throw new Error("OPERATOR_SIGNATURE_REJECTED");
  }
  const signature = decodeBase64Url(request.headers.get("x-operator-signature")?.trim() ?? "");
  if (signature.byteLength !== 64) throw new Error("OPERATOR_SIGNATURE_REJECTED");
  const key = await crypto.subtle.importKey("jwk", publicJwk, { name: "Ed25519" }, false, ["verify"]);
  if (!await crypto.subtle.verify("Ed25519", key, signature, body)) {
    throw new Error("OPERATOR_SIGNATURE_REJECTED");
  }
}

async function durableCall(
  env: RuntimeCredentialProvisionerEnv,
  challengeId: string,
  pathname: "/internal/issue" | "/internal/consume",
  binding: ChallengeBinding,
): Promise<void> {
  const namespace = env.RUNTIME_CREDENTIAL_CHALLENGES!;
  const stub = namespace.get(namespace.idFromName(challengeId));
  const response = await stub.fetch(`https://challenge.internal${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(binding),
  });
  if (!response.ok) throw new Error("CHALLENGE_REJECTED");
}

export function createRuntimeCredentialProvisionerWorker(dependencies: WorkerDependencies = {}) {
  return {
    async fetch(request: Request, env: RuntimeCredentialProvisionerEnv): Promise<Response> {
      if (request.method !== "POST") return json(404, { error: "not_found" });
      let config: ReturnType<typeof validateEnvironment>;
      try {
        config = validateEnvironment(env);
      } catch {
        return json(503, { error: "provisioning_unavailable" });
      }

      let identity: Awaited<ReturnType<typeof verifyAccessIdentity>>;
      try {
        identity = await verifyAccessIdentity(request, {
          audience: String(env.CF_ACCESS_AUD ?? ""),
          teamDomain: String(env.CF_ACCESS_TEAM_DOMAIN ?? ""),
          maxTokenTtlSeconds: config.accessMaxTtlSeconds,
        }, dependencies);
      } catch {
        return json(401, { error: "access_identity_required" });
      }

      const pathname = new URL(request.url).pathname;
      if (pathname === "/v1/challenges") {
        try {
          if (request.headers.get("x-operator-key-id") !== config.operatorKeyId) {
            throw new Error("OPERATOR_KEY_REJECTED");
          }
          const body = validateChallengeRequest(parseJson(await readBody(request)), config.keyVersion);
          const now = dependencies.now?.() ?? Date.now();
          const challengeId = dependencies.randomUuid?.() ?? crypto.randomUUID();
          const nonce = dependencies.randomNonce?.() ?? crypto.getRandomValues(new Uint8Array(32));
          if (nonce.byteLength !== 32) throw new Error("CHALLENGE_RANDOMNESS_REJECTED");
          const binding: ChallengeBinding = {
            version: 1,
            challengeId,
            challengeNonce: base64Url(nonce),
            connectionId: body.connectionId,
            runId: body.runId,
            keyVersion: body.keyVersion,
            operatorKeyId: config.operatorKeyId,
            principalSha256: identity.principalSha256,
            expiresAt: new Date(now + config.challengeTtlSeconds * 1_000).toISOString(),
          };
          await durableCall(env, challengeId, "/internal/issue", binding);
          return json(201, {
            version: 1,
            challengeId: binding.challengeId,
            challengeNonce: binding.challengeNonce,
            expiresAt: binding.expiresAt,
            connectionId: binding.connectionId,
            runId: binding.runId,
            keyVersion: binding.keyVersion,
          });
        } catch {
          return json(422, { error: "challenge_rejected" });
        }
      }

      if (pathname === "/v1/provision") {
        let bodyBytes: Uint8Array;
        let body: ProvisionRequest;
        try {
          bodyBytes = await readBody(request);
          await verifyOperatorSignature(bodyBytes, request, config.operatorKeyId, config.operatorJwk);
          body = validateProvisionRequest(parseJson(bodyBytes), config.keyVersion);
          const binding: ChallengeBinding = {
            version: 1,
            challengeId: body.challengeId,
            challengeNonce: body.challengeNonce,
            connectionId: body.connectionId,
            runId: body.runId,
            keyVersion: body.keyVersion,
            operatorKeyId: config.operatorKeyId,
            principalSha256: identity.principalSha256,
            expiresAt: body.expiresAt,
          };
          await durableCall(env, body.challengeId, "/internal/consume", binding);
        } catch {
          return json(403, { error: "provisioning_rejected" });
        }

        try {
          const key = await importVaultEncryptionKey(await env.RUNTIME_VAULT_KEY!.get());
          const credentials = await Promise.all((["agora", "winerim"] as const).map((kind) => (
            encryptRuntimeCredential({
              connectionId: body.connectionId,
              kind,
              keyVersion: body.keyVersion,
              plaintext: body.credentials[kind],
              key,
            })
          )));
          return json(200, {
            version: 1,
            schema: "runtime-credential-provisioning-v1",
            connectionId: body.connectionId,
            runId: body.runId,
            keyVersion: body.keyVersion,
            credentials,
          });
        } catch {
          return json(503, { error: "vault_operation_failed" });
        }
      }

      return json(404, { error: "not_found" });
    },
  };
}

export { RuntimeCredentialChallenge };
export default createRuntimeCredentialProvisionerWorker();
