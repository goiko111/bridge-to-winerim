import {
  createPrivateKey,
  generateKeyPairSync,
  sign as nodeSign,
} from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  prepareCredentialProvisioning,
  runtimeCredentialAttestationSha256,
  validateEncryptedCredentialArtifact,
} from "../../../../infrastructure/runtime/prepare-runtime-credential-provisioning.mjs";
import {
  provisionRuntimeCredentialsViaWorker,
} from "../../../../infrastructure/runtime/provision-runtime-credentials-via-worker.mjs";
import { runtimeCredentialProvisionerLifecyclePlan } from "../../../../infrastructure/runtime/plan-runtime-credential-provisioner.mjs";
import { RuntimeCredentialChallenge } from "./challengeStore";
import { runtimeCredentialAad } from "./crypto";
import {
  createRuntimeCredentialProvisionerWorker,
  type RuntimeCredentialProvisionerEnv,
} from "./worker";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "new-connection-a";
const KEY_VERSION = "fleet-v1";
const ACCESS_AUD = "credential-provisioner-test-audience";
const ACCESS_ISSUER = "https://credential-test.cloudflareaccess.com";
const OPERATOR_KEY_ID = "operator-test-v1";

type Stored = Map<string, unknown>;

class MemoryStorage {
  readonly values: Stored = new Map();
  alarmAt: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
  }

  async setAlarm(timestamp: number | Date): Promise<void> {
    this.alarmAt = timestamp instanceof Date ? timestamp.getTime() : timestamp;
  }

  async transaction<T>(callback: (transaction: Pick<MemoryStorage, "get" | "put">) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

function challengeNamespace() {
  const instances = new Map<string, RuntimeCredentialChallenge>();
  return {
    idFromName: (name: string) => name,
    get: (id: unknown) => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const key = String(id);
        if (!instances.has(key)) {
          instances.set(key, new RuntimeCredentialChallenge({ storage: new MemoryStorage() }));
        }
        return instances.get(key)!.fetch(new Request(input, init));
      },
    }),
  };
}

function base64Url(value: ArrayBuffer | Record<string, unknown>): string {
  return Buffer.from(
    value instanceof ArrayBuffer ? new Uint8Array(value) : JSON.stringify(value),
  ).toString("base64url");
}

async function accessIdentity(options: { audience?: string; ttlSeconds?: number } = {}) {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  Object.assign(publicJwk, { kid: "access-test-key", alg: "RS256", use: "sig" });
  const now = Math.floor(Date.now() / 1_000);
  const header = base64Url({ alg: "RS256", kid: "access-test-key" });
  const payload = base64Url({
    aud: options.audience ?? ACCESS_AUD,
    iss: ACCESS_ISSUER,
    sub: "operator-subject",
    email: "ops@example.test",
    iat: now,
    exp: now + (options.ttlSeconds ?? 600),
  });
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return { token: `${signingInput}.${base64Url(signature)}`, publicJwk };
}

function operatorIdentity() {
  const pair = generateKeyPairSync("ed25519");
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  const privatePem = pair.privateKey.export({ format: "pem", type: "pkcs8" });
  return { privateKey: pair.privateKey, privatePem, publicJwk };
}

function environment(input: {
  accessJwk: JsonWebKey;
  operatorJwk: JsonWebKey;
  vaultGet?: () => Promise<string>;
  enabled?: string;
}) {
  return {
    PROVISIONING_ENABLED: input.enabled ?? "true",
    CF_ACCESS_AUD: ACCESS_AUD,
    CF_ACCESS_TEAM_DOMAIN: ACCESS_ISSUER,
    ACCESS_MAX_TOKEN_TTL_SECONDS: "900",
    OPERATOR_KEY_ID,
    OPERATOR_PUBLIC_KEY_JWK: JSON.stringify(input.operatorJwk),
    CHALLENGE_TTL_SECONDS: "90",
    RUNTIME_VAULT_KEY_VERSION: KEY_VERSION,
    RUNTIME_VAULT_KEY: { get: input.vaultGet ?? (async () => Buffer.alloc(32, 9).toString("base64")) },
    RUNTIME_CREDENTIAL_CHALLENGES: challengeNamespace(),
    accessJwk: input.accessJwk,
  };
}

async function provisionFixture(options: {
  vaultGet?: () => Promise<string>;
  accessAudience?: string;
  accessTtlSeconds?: number;
  signatureValid?: boolean;
  enabled?: string;
} = {}) {
  const access = await accessIdentity({
    audience: options.accessAudience,
    ttlSeconds: options.accessTtlSeconds,
  });
  const operator = operatorIdentity();
  const envWithKey = environment({
    accessJwk: access.publicJwk,
    operatorJwk: operator.publicJwk,
    vaultGet: options.vaultGet,
    enabled: options.enabled,
  });
  const { accessJwk, ...env } = envWithKey;
  const worker = createRuntimeCredentialProvisionerWorker({
    fetchKeys: async () => [accessJwk],
  });
  const commonHeaders = {
    "content-type": "application/json",
    "CF-Access-Jwt-Assertion": access.token,
    "x-operator-key-id": OPERATOR_KEY_ID,
  };
  const challengeResponse = await worker.fetch(new Request("https://provision.test/v1/challenges", {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      version: 1,
      connectionId: CONNECTION_ID,
      runId: RUN_ID,
      keyVersion: KEY_VERSION,
    }),
  }), env);
  if (!challengeResponse.ok) return { worker, env, operator, commonHeaders, challengeResponse };
  const challenge = await challengeResponse.json() as Record<string, unknown>;
  const requestBody = Buffer.from(JSON.stringify({
    ...challenge,
    credentials: {
      agora: "fixture-agora-plaintext",
      winerim: "fixture-winerim-plaintext",
    },
  }));
  const signature = options.signatureValid === false
    ? Buffer.alloc(64, 1).toString("base64url")
    : nodeSign(null, requestBody, operator.privateKey).toString("base64url");
  const provisionRequest = () => new Request("https://provision.test/v1/provision", {
    method: "POST",
    headers: { ...commonHeaders, "x-operator-signature": signature },
    body: requestBody,
  });
  const provisionResponse = await worker.fetch(provisionRequest(), env);
  return {
    worker,
    env,
    operator,
    commonHeaders,
    challengeResponse,
    challenge,
    requestBody,
    provisionRequest,
    provisionResponse,
  };
}

describe("runtime credential provisioner", () => {
  it("produces ciphertext compatible with the current runtime and SQL tooling", async () => {
    const fixture = await provisionFixture();
    expect(fixture.challengeResponse.status).toBe(201);
    expect(fixture.provisionResponse?.status).toBe(200);
    const artifact = await fixture.provisionResponse!.json() as {
      version: number;
      schema: string;
      connectionId: string;
      runId: string;
      keyVersion: string;
      credentials: Array<{
        kind: "agora" | "winerim";
        nonceHex: string;
        ciphertextHex: string;
        attestationSha256: string;
      }>;
    };
    expect(Object.keys(artifact).sort()).toEqual([
      "connectionId",
      "credentials",
      "keyVersion",
      "runId",
      "schema",
      "version",
    ]);
    expect(JSON.stringify(artifact)).not.toContain("fixture-agora-plaintext");
    expect(JSON.stringify(artifact)).not.toContain("fixture-winerim-plaintext");

    const key = await crypto.subtle.importKey(
      "raw",
      Buffer.alloc(32, 9),
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    for (const credential of artifact.credentials) {
      const plaintext = await crypto.subtle.decrypt({
        name: "AES-GCM",
        iv: Buffer.from(credential.nonceHex, "hex"),
        additionalData: new TextEncoder().encode(runtimeCredentialAad({
          connectionId: CONNECTION_ID,
          kind: credential.kind,
          keyVersion: KEY_VERSION,
        })),
        tagLength: 128,
      }, key, Buffer.from(credential.ciphertextHex, "hex"));
      expect(new TextDecoder().decode(plaintext)).toBe(`fixture-${credential.kind}-plaintext`);
      expect(credential.attestationSha256).toBe(runtimeCredentialAttestationSha256({
        connectionId: CONNECTION_ID,
        kind: credential.kind,
        keyVersion: KEY_VERSION,
        nonceHex: credential.nonceHex,
        ciphertextHex: credential.ciphertextHex,
      }));
    }

    const directory = mkdtempSync(join(tmpdir(), "remote-credential-sql-"));
    chmodSync(directory, 0o700);
    const encryptedPath = join(directory, "encrypted.json");
    const sqlPath = join(directory, "credentials.sql");
    writeFileSync(encryptedPath, `${JSON.stringify(artifact)}\n`, { mode: 0o600 });
    const result = prepareCredentialProvisioning({
      output: sqlPath,
      environment: {
        CANARY_CONNECTION_ID: CONNECTION_ID,
        CANARY_RUN_ID: RUN_ID,
        RUNTIME_VAULT_KEY_VERSION: KEY_VERSION,
        RUNTIME_ENCRYPTED_CREDENTIALS_FILE: encryptedPath,
      },
    });
    expect(result).toMatchObject({
      credentialSource: "cloudflare-worker",
      active: false,
      remoteMutations: 0,
    });
    const sql = readFileSync(sqlPath, "utf8");
    expect(sql).toContain(artifact.credentials[0].ciphertextHex);
    expect(sql).not.toContain("fixture-agora-plaintext");
    expect(sql).not.toContain("fixture-winerim-plaintext");
  });

  it("consumes a challenge exactly once before reading Secrets Store", async () => {
    const vaultGet = vi.fn(async () => Buffer.alloc(32, 9).toString("base64"));
    const fixture = await provisionFixture({ vaultGet });
    expect(fixture.provisionResponse?.status).toBe(200);
    expect(vaultGet).toHaveBeenCalledTimes(1);
    const replay = await fixture.worker!.fetch(fixture.provisionRequest!(), fixture.env!);
    expect(replay.status).toBe(403);
    expect(vaultGet).toHaveBeenCalledTimes(1);
    expect(await replay.text()).not.toContain("fixture-agora-plaintext");
  });

  it("rejects missing factors, oversized Access lifetimes and disabled operation", async () => {
    const invalidSignature = await provisionFixture({ signatureValid: false });
    expect(invalidSignature.provisionResponse?.status).toBe(403);

    const wrongAudience = await provisionFixture({ accessAudience: "wrong-audience" });
    expect(wrongAudience.challengeResponse.status).toBe(401);

    const oversizedAccessLifetime = await provisionFixture({ accessTtlSeconds: 901 });
    expect(oversizedAccessLifetime.challengeResponse.status).toBe(401);

    const disabled = await provisionFixture({ enabled: "false" });
    expect(disabled.challengeResponse.status).toBe(503);
  });

  it("burns the one-shot challenge when Secrets Store fails", async () => {
    const vaultGet = vi.fn(async () => { throw new Error("sensitive vault diagnostic"); });
    const fixture = await provisionFixture({ vaultGet });
    expect(fixture.provisionResponse?.status).toBe(503);
    await expect(fixture.provisionResponse?.json()).resolves.toEqual({ error: "vault_operation_failed" });
    const replay = await fixture.worker!.fetch(fixture.provisionRequest!(), fixture.env!);
    expect(replay.status).toBe(403);
    expect(vaultGet).toHaveBeenCalledTimes(1);
    expect(await replay.text()).not.toContain("sensitive vault diagnostic");
  });

  it("rejects expired challenges and never logs plaintext", async () => {
    const storage = new MemoryStorage();
    const durable = new RuntimeCredentialChallenge({ storage });
    const binding = {
      version: 1 as const,
      challengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      challengeNonce: "a".repeat(43),
      connectionId: CONNECTION_ID,
      runId: RUN_ID,
      keyVersion: KEY_VERSION,
      operatorKeyId: OPERATOR_KEY_ID,
      principalSha256: "b".repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const issued = await durable.fetch(new Request("https://challenge.internal/internal/issue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(binding),
    }));
    expect(issued.status).toBe(201);
    await storage.put("challenge", {
      ...binding,
      expiresAt: "2000-01-01T00:00:00.000Z",
      consumedAt: null,
    });
    const expired = await durable.fetch(new Request("https://challenge.internal/internal/consume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...binding, expiresAt: "2000-01-01T00:00:00.000Z" }),
    }));
    expect(expired.status).toBe(409);

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fixture = await provisionFixture();
    expect(fixture.provisionResponse?.status).toBe(200);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects forged encrypted artifacts and mixed local/remote sources", async () => {
    const fixture = await provisionFixture();
    const artifact = await fixture.provisionResponse!.json() as Record<string, unknown>;
    const forged = structuredClone(artifact) as {
      credentials: Array<{ attestationSha256: string }>;
    };
    forged.credentials[0].attestationSha256 = "f".repeat(64);
    expect(() => validateEncryptedCredentialArtifact({
      source: Buffer.from(JSON.stringify(forged)),
      connectionId: CONNECTION_ID,
      runId: RUN_ID,
      keyVersion: KEY_VERSION,
    })).toThrow("RUNTIME_CREDENTIAL_PROVISION_ENCRYPTED_ARTIFACT_ATTESTATION_MISMATCH");

    const directory = mkdtempSync(join(tmpdir(), "mixed-credential-source-"));
    chmodSync(directory, 0o700);
    const encryptedPath = join(directory, "encrypted.json");
    writeFileSync(encryptedPath, `${JSON.stringify(artifact)}\n`, { mode: 0o600 });
    expect(() => prepareCredentialProvisioning({
      output: join(directory, "credentials.sql"),
      environment: {
        CANARY_CONNECTION_ID: CONNECTION_ID,
        CANARY_RUN_ID: RUN_ID,
        RUNTIME_VAULT_KEY_VERSION: KEY_VERSION,
        RUNTIME_ENCRYPTED_CREDENTIALS_FILE: encryptedPath,
        RUNTIME_VAULT_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
      },
    })).toThrow("RUNTIME_CREDENTIAL_PROVISION_MIXED_CREDENTIAL_SOURCES_REJECTED");
  });

  it("runs the local client without writing plaintext or reading the vault key locally", async () => {
    const access = await accessIdentity();
    const operator = operatorIdentity();
    const envWithKey = environment({ accessJwk: access.publicJwk, operatorJwk: operator.publicJwk });
    const { accessJwk, ...workerEnv } = envWithKey;
    const worker = createRuntimeCredentialProvisionerWorker({ fetchKeys: async () => [accessJwk] });
    const directory = mkdtempSync(join(tmpdir(), "remote-credential-client-"));
    chmodSync(directory, 0o700);
    const inputPath = join(directory, "input.json");
    const keyPath = join(directory, "operator.pem");
    const outputPath = join(directory, "encrypted.json");
    writeFileSync(inputPath, `${JSON.stringify({
      version: 1,
      connectionId: CONNECTION_ID,
      runId: RUN_ID,
      keyVersion: KEY_VERSION,
      credentials: {
        agora: "client-agora-plaintext",
        winerim: "client-winerim-plaintext",
      },
    })}\n`, { mode: 0o600 });
    writeFileSync(keyPath, operator.privatePem, { mode: 0o600 });
    const fetcher = (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" || input instanceof URL ? input : input.url;
      return worker.fetch(new Request(url, init), workerEnv);
    };
    const result = await provisionRuntimeCredentialsViaWorker({
      environment: {
        RUNTIME_CREDENTIAL_PROVISIONER_URL: "https://provision.test",
        CF_ACCESS_JWT: access.token,
        RUNTIME_CREDENTIAL_OPERATOR_KEY_ID: OPERATOR_KEY_ID,
      },
      inputPath,
      outputPath,
      operatorKeyPath: keyPath,
      fetcher,
    });
    expect(result).toMatchObject({
      status: "REMOTE_CREDENTIAL_PROVISION_ARTIFACT_READY",
      plaintextWritten: false,
      vaultKeyReadLocally: false,
    });
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    const output = readFileSync(outputPath, "utf8");
    expect(output).not.toContain("client-agora-plaintext");
    expect(output).not.toContain("client-winerim-plaintext");
    expect(output).not.toContain(access.token);
  });

  it("ships an explicit fail-closed deployment, rollback and retirement plan", () => {
    const plan = runtimeCredentialProvisionerLifecyclePlan();
    expect(plan.productionChangesPerformed).toBe(false);
    expect(plan.deployment.join(" ")).toContain("PROVISIONING_ENABLED=false");
    expect(plan.rollback.join(" ")).toContain("PROVISIONING_ENABLED=false");
    expect(plan.retirement.join(" ")).toContain("Delete the provisioner Worker");
    expect(plan.failClosedAssertions).toEqual(expect.arrayContaining([
      expect.stringContaining("Ed25519"),
      expect.stringContaining("atomically consumed"),
    ]));
  });
});
