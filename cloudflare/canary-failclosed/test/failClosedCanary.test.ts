import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
  SqlStatement,
} from "../../workers/middleware-api/src/db";
import { RuntimeEnvelopeV1 } from "../../workers/middleware-runtime/src/contracts";
import { observeCanaryDlqBatch } from "../src/dlqObserver";
import {
  CanaryQueueMessageLike,
  guardExclusiveCanaryBatch,
  resolveExclusiveCanaryJobLane,
  runtimePayloadSha256,
} from "../src/exclusiveScope";
import {
  acquireExclusiveWriterFence,
  authorizeWriterFenceMutation,
  parseWriterFenceGrant,
  sha256Hex,
  validateWriterFenceGrant,
  writerFenceCredentialBinding,
  WriterFenceGrantV1,
  WriterFenceGrantV2,
} from "../src/writerFence";
import { ConnectionWriterFence } from "../src/writerFenceWorker";

const connectionId = "11111111-1111-4111-8111-111111111111";
const runId = "run-20260803-a";
const queueName = `winerim-rescue-prod-canary-${runId}`;

function envelope(overrides: Partial<RuntimeEnvelopeV1> = {}): RuntimeEnvelopeV1 {
  return {
    name: "winerim.middleware.runtime",
    version: 1,
    messageId: "message-1",
    idempotencyKey: "idem-1",
    connectionId,
    lane: "sales-import",
    job: "winerim.sales-import-live",
    retryProfile: "WINERIM_MUTATION",
    attempt: 0,
    maxAttempts: 3,
    createdAt: "2026-08-03T06:00:00.000Z",
    availableAt: "2026-08-03T06:00:00.000Z",
    source: { kind: "queue", eventId: `canary:${runId}:message-1` },
    payload: {},
    ...overrides,
  };
}

function message(body: unknown = envelope()): CanaryQueueMessageLike & {
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
} {
  return { id: "queue-message-1", attempts: 1, body, ack: vi.fn(), retry: vi.fn() };
}

async function scope() {
  const reviewed = envelope();
  return {
    queueName,
    connectionId,
    runId,
    messageId: reviewed.messageId,
    idempotencyKey: reviewed.idempotencyKey,
    payloadSha256: await runtimePayloadSha256(reviewed.payload),
    job: "winerim.sales-import-live" as const,
    lane: "sales-import" as const,
  };
}

function catalogEnvelope(overrides: Partial<RuntimeEnvelopeV1> = {}): RuntimeEnvelopeV1 {
  return envelope({
    lane: "catalog",
    job: "catalog.sync-master",
    retryProfile: "POS_OUTBOUND",
    maxAttempts: 5,
    payload: { winerimWineIds: ["1"], formatTypes: ["BOTTLE"] },
    ...overrides,
  });
}

async function catalogScope() {
  const reviewed = catalogEnvelope();
  return {
    queueName,
    connectionId,
    runId,
    messageId: reviewed.messageId,
    idempotencyKey: reviewed.idempotencyKey,
    payloadSha256: await runtimePayloadSha256(reviewed.payload),
    job: "catalog.sync-master" as const,
    lane: "catalog" as const,
  };
}

function activeScopeDatabase(writerFenceGrantSha256: string): DatabaseAdapter {
  const query = vi.fn(async <Row extends Record<string, unknown>>(statement: SqlStatement) => {
    if (!statement.text.includes("FROM public.runtime_canary_connections")) {
      return { rows: [], rowCount: 0 } as QueryResult<Row>;
    }
    return {
      rows: [{
        connection_id: connectionId,
        run_id: runId,
        writer_fence_grant_sha256: writerFenceGrantSha256,
      }] as Row[],
      rowCount: 1,
    };
  });
  return {
    query,
    transaction: async <T>(work: (transaction: DatabaseTransaction) => Promise<T>) => work({ query }),
  };
}

describe("exclusive physical canary queue", () => {
  it("defaults to the live-sales scope and accepts only the allowlisted catalog pair", () => {
    expect(resolveExclusiveCanaryJobLane(undefined, undefined)).toEqual({
      job: "winerim.sales-import-live",
      lane: "sales-import",
    });
    expect(resolveExclusiveCanaryJobLane("catalog.sync-master", "catalog")).toEqual({
      job: "catalog.sync-master",
      lane: "catalog",
    });
    expect(resolveExclusiveCanaryJobLane("catalog.sync-master", "sales-import")).toBeNull();
    expect(resolveExclusiveCanaryJobLane("outbound.process", "outbound-queue")).toBeNull();
  });

  it("accepts only the exact physical queue, connection, lane, job and run", async () => {
    const accepted = message();
    const result = await guardExclusiveCanaryBatch({ queue: queueName, messages: [accepted] }, await scope());
    expect(result.accepted).toEqual([accepted]);
    expect(result.rejected).toBe(0);
    expect(accepted.ack).not.toHaveBeenCalled();
    expect(accepted.retry).not.toHaveBeenCalled();
  });

  it("never acknowledges an out-of-scope connection", async () => {
    const foreign = message(envelope({ connectionId: "22222222-2222-4222-8222-222222222222" }));
    const result = await guardExclusiveCanaryBatch({ queue: queueName, messages: [foreign] }, await scope());
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toBe(1);
    expect(foreign.ack).not.toHaveBeenCalled();
    expect(foreign.retry).toHaveBeenCalledTimes(1);
  });

  it("routes a physical queue mismatch toward DLQ instead of dropping it", async () => {
    const foreign = message();
    await guardExclusiveCanaryBatch({ queue: "winerim-rescue-prod-sales", messages: [foreign] }, await scope());
    expect(foreign.ack).not.toHaveBeenCalled();
    expect(foreign.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
  });

  it("rejects a second payload even when queue, connection, job and run match", async () => {
    const altered = message(envelope({ payload: { quantity: 2 } }));
    const result = await guardExclusiveCanaryBatch(
      { queue: queueName, messages: [altered] },
      await scope(),
    );
    expect(result.accepted).toHaveLength(0);
    expect(altered.ack).not.toHaveBeenCalled();
    expect(altered.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
  });

  it("accepts one exact catalog envelope and rejects a sales envelope from that run", async () => {
    const accepted = message(catalogEnvelope());
    const catalogResult = await guardExclusiveCanaryBatch(
      { queue: queueName, messages: [accepted] },
      await catalogScope(),
    );
    expect(catalogResult.accepted).toEqual([accepted]);

    const rejected = message(envelope());
    const salesResult = await guardExclusiveCanaryBatch(
      { queue: queueName, messages: [rejected] },
      await catalogScope(),
    );
    expect(salesResult.accepted).toHaveLength(0);
    expect(rejected.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
  });
});

describe("connection writer fence", () => {
  it("fails closed without the lease service or exclusive proof binding", async () => {
    await expect(acquireExclusiveWriterFence({
      env: {}, connectionId, runId, holderId: "deploy-a",
    })).rejects.toThrow("WRITER_FENCE_SERVICE_BINDING_MISSING");
    await expect(acquireExclusiveWriterFence({
      env: { WRITER_FENCE: { fetch: vi.fn() } }, connectionId, runId, holderId: "deploy-a",
    })).rejects.toThrow("WRITER_FENCE_EXCLUSIVE_CREDENTIAL_BINDING_MISSING");
  });

  it("fails closed when the connection lease is denied", async () => {
    await expect(acquireExclusiveWriterFence({
      env: {
        WRITER_FENCE: { fetch: vi.fn(async () => new Response("held", { status: 409 })) },
        CANARY_WRITER_FENCE_PROOF: { get: vi.fn(async () => "x".repeat(40)) },
      },
      connectionId,
      runId,
      holderId: "deploy-a",
    })).rejects.toThrow("WRITER_FENCE_LEASE_DENIED_409");
  });

  it("accepts a valid unexpired lease response", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const credential = {
      reference: `runtime-vault://postgres/${connectionId}/agora/winerim`,
      version: "a".repeat(64),
    };
    const credentialBinding = await writerFenceCredentialBinding(credential);
    const lease = await acquireExclusiveWriterFence({
      env: {
        WRITER_FENCE: {
          fetch: vi.fn(async () => Response.json({
            connectionId,
            runId,
            holderId: "deploy-a",
            fencingToken: 7,
            credentialReference: credential.reference,
            credentialVersion: credential.version,
            credentialBinding,
            expiresAt,
          })),
        },
        CANARY_WRITER_FENCE_PROOF: { get: vi.fn(async () => "x".repeat(40)) },
      },
      connectionId,
      runId,
      holderId: "deploy-a",
    });
    expect(lease.fencingToken).toBe(7);
  });

  it("binds the lease to the exact opened credential reference and version", async () => {
    const credential = {
      reference: `runtime-vault://postgres/${connectionId}/agora/winerim`,
      version: "b".repeat(64),
    };
    const credentialBinding = await writerFenceCredentialBinding(credential);
    const authorization = await authorizeWriterFenceMutation({
      lease: {
        connectionId,
        runId,
        holderId: "deploy-a",
        fencingToken: 11,
        credentialReference: credential.reference,
        credentialVersion: credential.version,
        credentialBinding,
        expiresAt: "2026-08-03T06:31:00.000Z",
      },
      credential,
      nowMs: Date.parse("2026-08-03T06:30:00.000Z"),
    });

    expect(authorization).toMatchObject({
      fencingToken: 11,
      credentialReference: credential.reference,
      credentialVersion: credential.version,
      credentialBinding,
      authorizedAt: "2026-08-03T06:30:00.000Z",
      expiresAt: "2026-08-03T06:31:00.000Z",
    });
  });

  it("fails closed on credential drift or a lease too close to expiry", async () => {
    const credential = {
      reference: `runtime-vault://postgres/${connectionId}/agora/winerim`,
      version: "c".repeat(64),
    };
    const baseLease = {
      connectionId,
      runId,
      holderId: "deploy-a",
      fencingToken: 12,
      credentialReference: credential.reference,
      credentialVersion: credential.version,
      credentialBinding: await writerFenceCredentialBinding(credential),
      expiresAt: "2026-08-03T06:30:14.999Z",
    };
    await expect(authorizeWriterFenceMutation({
      lease: { ...baseLease, credentialReference: `${credential.reference}-other` },
      credential,
      nowMs: Date.parse("2026-08-03T06:30:00.000Z"),
    })).rejects.toThrow("WRITER_FENCE_CREDENTIAL_REFERENCE_DRIFT");
    await expect(authorizeWriterFenceMutation({
      lease: { ...baseLease, credentialVersion: "d".repeat(64) },
      credential,
      nowMs: Date.parse("2026-08-03T06:30:00.000Z"),
    })).rejects.toThrow("WRITER_FENCE_CREDENTIAL_VERSION_DRIFT");
    await expect(authorizeWriterFenceMutation({
      lease: { ...baseLease, credentialBinding: "e".repeat(64) },
      credential,
      nowMs: Date.parse("2026-08-03T06:30:00.000Z"),
    })).rejects.toThrow("WRITER_FENCE_CREDENTIAL_BINDING_DRIFT");
    await expect(authorizeWriterFenceMutation({
      lease: baseLease,
      credential,
      nowMs: Date.parse("2026-08-03T06:30:00.000Z"),
    })).rejects.toThrow("WRITER_FENCE_LEASE_TOO_CLOSE_TO_EXPIRY");
    await expect(authorizeWriterFenceMutation({
      lease: { ...baseLease, expiresAt: "2026-08-03T06:30:15.000Z" },
      credential,
      nowMs: Date.parse("2026-08-03T06:30:00.000Z"),
    })).resolves.toMatchObject({ fencingToken: 12 });
  });

  it("requires evidence that the legacy writer credential is revoked", async () => {
    const proof = "proof-only-known-by-the-new-runtime-1234567890";
    const credential = {
      reference: `runtime-vault://postgres/${connectionId}/agora/winerim`,
      version: "b".repeat(64),
    };
    const grant: WriterFenceGrantV1 = {
      version: 1,
      connectionId,
      runId,
      holderId: "deploy-a",
      proofSha256: await sha256Hex(proof),
      exclusiveCredentialRef: credential.reference,
      credentialVersion: credential.version,
      credentialBinding: await writerFenceCredentialBinding(credential),
      legacyWriter: {
        revokedAt: "2026-08-03T05:59:00.000Z",
        negativeProbeStatus: 401,
        evidenceSha256: "a".repeat(64),
      },
      issuedAt: "2026-08-03T06:00:00.000Z",
      expiresAt: "2026-08-03T07:00:00.000Z",
    };
    await expect(validateWriterFenceGrant({
      grant,
      proof,
      connectionId,
      runId,
      holderId: "deploy-a",
      nowMs: Date.parse("2026-08-03T06:30:00.000Z"),
    })).resolves.toBeUndefined();

    expect(() => parseWriterFenceGrant(JSON.stringify({
      ...grant,
      legacyWriter: { ...grant.legacyWriter, negativeProbeStatus: 200 },
    }))).toThrow("WRITER_FENCE_GRANT_LEGACY_NEGATIVE_PROBE_REQUIRED");
    expect(() => parseWriterFenceGrant(JSON.stringify({
      ...grant,
      exclusiveCredentialRef: "same-token-used-by-lovable",
    }))).toThrow("WRITER_FENCE_GRANT_EXCLUSIVE_CREDENTIAL_REQUIRED");

    await expect(validateWriterFenceGrant({
      grant: { ...grant, expiresAt: grant.issuedAt },
      proof,
      connectionId,
      runId,
      holderId: "deploy-a",
      nowMs: Date.parse("2026-08-03T06:00:00.000Z"),
    })).rejects.toThrow("WRITER_FENCE_GRANT_WINDOW_INVALID");
  });

  it("accepts exact fresh bootstrap absence evidence without inventing a legacy 401", async () => {
    const proof = "bootstrap-proof-only-known-by-runtime-123456789";
    const credential = {
      reference: `runtime-vault://postgres/${connectionId}/agora/agora`,
      version: "e".repeat(64),
    };
    const grant: WriterFenceGrantV2 = {
      version: 2,
      connectionId,
      runId,
      holderId: "deploy-a",
      proofSha256: await sha256Hex(proof),
      exclusiveCredentialRef: credential.reference,
      credentialVersion: credential.version,
      credentialBinding: await writerFenceCredentialBinding(credential),
      writerHistory: {
        mode: "bootstrap-no-legacy-writer",
        verifiedAt: "2026-08-03T05:58:00.000Z",
        evidenceSha256: "a".repeat(64),
        cloudflareEvidenceSha256: "b".repeat(64),
        absence: {
          activeConnectionCount: 0,
          activeCredentialCount: 0,
          activeScopeCount: 0,
          priorRunCount: 0,
          activeProducerCount: 0,
          activeConsumerCount: 0,
        },
      },
      issuedAt: "2026-08-03T06:00:00.000Z",
      expiresAt: "2026-08-03T07:00:00.000Z",
    };
    const parsed = parseWriterFenceGrant(JSON.stringify(grant));
    expect(parsed.version).toBe(2);
    expect(parsed).not.toHaveProperty("legacyWriter");
    await expect(validateWriterFenceGrant({
      grant: parsed,
      proof,
      connectionId,
      runId,
      holderId: "deploy-a",
      nowMs: Date.parse("2026-08-03T06:30:00.000Z"),
    })).resolves.toBeUndefined();

    expect(() => parseWriterFenceGrant(JSON.stringify({
      ...grant,
      writerHistory: {
        ...grant.writerHistory,
        absence: { ...grant.writerHistory.absence, activeProducerCount: 1 },
      },
    }))).toThrow("WRITER_FENCE_GRANT_BOOTSTRAP_ABSENCE_REQUIRED");
    expect(() => parseWriterFenceGrant(JSON.stringify({
      ...grant,
      legacyWriter: {
        revokedAt: "2026-08-03T05:59:00.000Z",
        negativeProbeStatus: 401,
        evidenceSha256: "c".repeat(64),
      },
    }))).toThrow("WRITER_FENCE_GRANT_BOOTSTRAP_LEGACY_EVIDENCE_FORBIDDEN");
    expect(() => parseWriterFenceGrant(JSON.stringify({
      ...grant,
      exclusiveCredentialRef: `runtime-vault://postgres/${connectionId}/agora/winerim`,
    }))).toThrow("WRITER_FENCE_GRANT_BOOTSTRAP_AGORA_CREDENTIAL_REQUIRED");
    await expect(validateWriterFenceGrant({
      grant: {
        ...grant,
        writerHistory: { ...grant.writerHistory, verifiedAt: "2026-08-03T05:40:00.000Z" },
      },
      proof,
      connectionId,
      runId,
      holderId: "deploy-a",
      nowMs: Date.parse("2026-08-03T06:30:00.000Z"),
    })).rejects.toThrow("WRITER_FENCE_BOOTSTRAP_EVIDENCE_STALE");
  });

  it("keeps the real credential version separate in a generated grant", async () => {
    const directory = mkdtempSync(join(tmpdir(), "writer-fence-grant-"));
    const output = join(directory, "grant.json");
    const proof = "generated-proof-only-known-by-runtime-123456789";
    const credentialReference = `runtime-vault://postgres/${connectionId}/agora/winerim`;
    const credentialVersion = "f".repeat(64);
    try {
      const stdout = execFileSync(process.execPath, [
        resolve("infrastructure/runtime/prepare-writer-fence-grant.mjs"),
        `--output=${output}`,
      ], {
        cwd: resolve("."),
        env: {
          ...process.env,
          CANARY_CONNECTION_ID: connectionId,
          CANARY_RUN_ID: runId,
          CANARY_HOLDER_ID: "deploy-a",
          CANARY_WRITER_FENCE_PROOF: proof,
          CANARY_EXCLUSIVE_CREDENTIAL_REF: credentialReference,
          CANARY_EXCLUSIVE_CREDENTIAL_VERSION: credentialVersion,
          LEGACY_WRITER_REVOKED_AT: "2026-08-03T05:59:00.000Z",
          LEGACY_WRITER_NEGATIVE_PROBE_STATUS: "401",
          LEGACY_WRITER_EVIDENCE_SHA256: "a".repeat(64),
          CANARY_FENCE_ISSUED_AT: "2026-08-03T06:00:00.000Z",
          CANARY_FENCE_EXPIRES_AT: "2026-08-03T07:00:00.000Z",
        },
        stdio: "pipe",
      }).toString("utf8");
      const source = readFileSync(output);
      const announcedSha256 = stdout.match(/sha256=([a-f0-9]{64})/)?.[1];
      expect(announcedSha256).toBe(createHash("sha256").update(source).digest("hex"));
      const grant = parseWriterFenceGrant(source.toString("utf8"));
      expect(grant.credentialVersion).toBe(credentialVersion);
      expect(grant.credentialBinding).toBe(await writerFenceCredentialBinding({
        reference: credentialReference,
        version: credentialVersion,
      }));
      await expect(validateWriterFenceGrant({
        grant,
        proof,
        connectionId,
        runId,
        holderId: "deploy-a",
        nowMs: Date.parse("2026-08-03T06:30:00.000Z"),
      })).resolves.toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects legacy zero counters without signed external writer evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "writer-fence-bootstrap-grant-"));
    const output = join(directory, "grant.json");
    const proof = "bootstrap-generated-proof-only-known-by-runtime-123";
    const credentialReference = `runtime-vault://postgres/${connectionId}/agora/agora`;
    try {
      expect(() => execFileSync(process.execPath, [
          resolve("infrastructure/runtime/prepare-writer-fence-grant.mjs"),
          `--output=${output}`,
        ], {
          cwd: resolve("."),
          env: {
            ...process.env,
            WRITER_FENCE_MODE: "bootstrap-no-legacy-writer",
            CANARY_CONNECTION_ID: connectionId,
            CANARY_RUN_ID: runId,
            CANARY_HOLDER_ID: "deploy-a",
            CANARY_WRITER_FENCE_PROOF: proof,
            CANARY_EXCLUSIVE_CREDENTIAL_REF: credentialReference,
            CANARY_EXCLUSIVE_CREDENTIAL_VERSION: "f".repeat(64),
            CANARY_RUNTIME_JOB: "catalog.sync-master",
            CANARY_RUNTIME_LANE: "catalog",
            CANARY_CATALOG_PRODUCT_ID: "500001",
            NO_LEGACY_WRITER_VERIFIED_AT: "2026-08-03T05:58:00.000Z",
            NO_LEGACY_WRITER_EVIDENCE_SHA256: "a".repeat(64),
            NO_LEGACY_WRITER_CLOUDFLARE_EVIDENCE_SHA256: "b".repeat(64),
            NO_LEGACY_WRITER_ACTIVE_CONNECTION_COUNT: "0",
            NO_LEGACY_WRITER_ACTIVE_CREDENTIAL_COUNT: "0",
            NO_LEGACY_WRITER_ACTIVE_SCOPE_COUNT: "0",
            NO_LEGACY_WRITER_PRIOR_RUN_COUNT: "0",
            NO_LEGACY_WRITER_ACTIVE_PRODUCER_COUNT: "0",
            NO_LEGACY_WRITER_ACTIVE_CONSUMER_COUNT: "0",
            CANARY_FENCE_ISSUED_AT: "2026-08-03T06:00:00.000Z",
            CANARY_FENCE_EXPIRES_AT: "2026-08-03T07:00:00.000Z",
          },
          stdio: "pipe",
        })).toThrow(/NO_LEGACY_WRITER_EXTERNAL_EVIDENCE_SHA256/);
      expect(() => readFileSync(output, "utf8")).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("leases the grant credential fields and rejects active credential drift", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-03T06:30:00.000Z");
    try {
      const proof = "proof-only-known-by-the-new-runtime-1234567890";
      const credential = {
        reference: `runtime-vault://postgres/${connectionId}/agora/winerim`,
        version: "1".repeat(64),
      };
      const createGrant = async (version: string): Promise<WriterFenceGrantV1> => ({
        version: 1,
        connectionId,
        runId,
        holderId: "deploy-a",
        proofSha256: await sha256Hex(proof),
        exclusiveCredentialRef: credential.reference,
        credentialVersion: version,
        credentialBinding: await writerFenceCredentialBinding({ ...credential, version }),
        legacyWriter: {
          revokedAt: "2026-08-03T05:59:00.000Z",
          negativeProbeStatus: 401,
          evidenceSha256: "a".repeat(64),
        },
        issuedAt: "2026-08-03T06:00:00.000Z",
        expiresAt: "2026-08-03T07:00:00.000Z",
      });
      let rawGrant = JSON.stringify(await createGrant(credential.version));
      const activeGrantSha256 = await sha256Hex(rawGrant);
      const values = new Map<string, unknown>();
      const storage = {
        get: async <T>(key: string) => values.get(key) as T | undefined,
        put: async <T>(key: string, value: T) => { values.set(key, value); },
        transaction: async <T>(callback: (transaction: typeof storage) => Promise<T>) => callback(storage),
      };
      const worker = new ConnectionWriterFence(
        { storage },
        {
          CONNECTION_WRITER_FENCE: {
            idFromName: (name: string) => name,
            get: () => ({ fetch: async () => new Response(null, { status: 501 }) }),
          },
          WRITER_FENCE_GRANT: { get: async () => rawGrant },
        },
        { database: () => activeScopeDatabase(activeGrantSha256) },
      );
      const request = () => new Request("https://writer-fence.internal/v1/leases/acquire", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-writer-fence-proof": proof,
        },
        body: JSON.stringify({ connectionId, runId, holderId: "deploy-a", ttlSeconds: 90 }),
      });

      const acquired = await worker.fetch(request());
      expect(acquired.status).toBe(200);
      await expect(acquired.json()).resolves.toMatchObject({
        credentialReference: credential.reference,
        credentialVersion: credential.version,
        credentialBinding: await writerFenceCredentialBinding(credential),
        fencingToken: 1,
      });

      rawGrant = JSON.stringify(await createGrant("2".repeat(64)));
      const drifted = await worker.fetch(request());
      expect(drifted.status).toBe(403);
      await expect(drifted.json()).resolves.toMatchObject({ error: "WRITER_FENCE_ACTIVE_GRANT_MISMATCH" });
      expect((values.get("lease") as { credentialVersion: string }).credentialVersion).toBe(credential.version);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects any grant or proof pair that differs from the immutable active scope", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-03T06:30:00.000Z");
    try {
      const proof = "proof-only-known-by-the-new-runtime-1234567890";
      const credential = {
        reference: `runtime-vault://postgres/${connectionId}/agora/winerim`,
        version: "7".repeat(64),
      };
      const grant: WriterFenceGrantV1 = {
        version: 1,
        connectionId,
        runId,
        holderId: "deploy-a",
        proofSha256: await sha256Hex(proof),
        exclusiveCredentialRef: credential.reference,
        credentialVersion: credential.version,
        credentialBinding: await writerFenceCredentialBinding(credential),
        legacyWriter: {
          revokedAt: "2026-08-03T05:59:00.000Z",
          negativeProbeStatus: 401,
          evidenceSha256: "a".repeat(64),
        },
        issuedAt: "2026-08-03T06:00:00.000Z",
        expiresAt: "2026-08-03T07:00:00.000Z",
      };
      const activeRawGrant = JSON.stringify(grant);
      const activeGrantSha256 = await sha256Hex(activeRawGrant);
      const swappedProof = "different-proof-only-known-by-runtime-123456789";
      const cases = [
        {
          rawGrant: JSON.stringify({
            ...grant,
            legacyWriter: { ...grant.legacyWriter, evidenceSha256: "b".repeat(64) },
          }),
          proof,
        },
        { rawGrant: JSON.stringify({ ...grant, issuedAt: "2026-08-03T06:00:01.000Z" }), proof },
        { rawGrant: JSON.stringify({ ...grant, expiresAt: "2026-08-03T07:00:01.000Z" }), proof },
        {
          rawGrant: JSON.stringify({ ...grant, proofSha256: await sha256Hex(swappedProof) }),
          proof: swappedProof,
        },
      ];

      for (const drift of cases) {
        const values = new Map<string, unknown>();
        const storage = {
          get: async <T>(key: string) => values.get(key) as T | undefined,
          put: async <T>(key: string, value: T) => { values.set(key, value); },
          transaction: async <T>(callback: (transaction: typeof storage) => Promise<T>) => callback(storage),
        };
        const worker = new ConnectionWriterFence(
          { storage },
          {
            CONNECTION_WRITER_FENCE: {
              idFromName: (name: string) => name,
              get: () => ({ fetch: async () => new Response(null, { status: 501 }) }),
            },
            WRITER_FENCE_GRANT: { get: async () => drift.rawGrant },
          },
          { database: () => activeScopeDatabase(activeGrantSha256) },
        );
        const response = await worker.fetch(new Request("https://writer-fence.internal/v1/leases/acquire", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-writer-fence-proof": drift.proof,
          },
          body: JSON.stringify({ connectionId, runId, holderId: "deploy-a", ttlSeconds: 90 }),
        }));

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: "WRITER_FENCE_ACTIVE_GRANT_MISMATCH" });
        expect(values.has("lease")).toBe(false);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("observable canary DLQ", () => {
  it("acknowledges only after archive and alarm enqueue both succeed", async () => {
    const dlqMessage = message();
    const archive = vi.fn(async () => ({}));
    const send = vi.fn(async () => undefined);
    await observeCanaryDlqBatch(
      { queue: `${queueName}-dlq`, messages: [dlqMessage] },
      {
        CANARY_DLQ_ARCHIVE: { put: archive },
        CANARY_DLQ_ALERTS: { send },
        CANARY_DLQ_QUEUE_NAME: `${queueName}-dlq`,
        CANARY_ALARM_QUEUE_NAME: `${queueName}-alarms`,
      },
    );
    expect(archive).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(dlqMessage.ack).toHaveBeenCalledTimes(1);
    expect(dlqMessage.retry).not.toHaveBeenCalled();
  });

  it("retries and never acknowledges when the archive or alarm path fails", async () => {
    const dlqMessage = message();
    await observeCanaryDlqBatch(
      { queue: `${queueName}-dlq`, messages: [dlqMessage] },
      {
        CANARY_DLQ_ARCHIVE: { put: vi.fn(async () => { throw new Error("r2 unavailable"); }) },
        CANARY_DLQ_ALERTS: { send: vi.fn(async () => undefined) },
        CANARY_DLQ_QUEUE_NAME: `${queueName}-dlq`,
        CANARY_ALARM_QUEUE_NAME: `${queueName}-alarms`,
      },
    );
    expect(dlqMessage.ack).not.toHaveBeenCalled();
    expect(dlqMessage.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });

  it("reuses the deterministic archive key when alert delivery retries later", async () => {
    vi.useFakeTimers();
    try {
      const dlqMessage = message();
      const retriedDlqMessage = { ...message(dlqMessage.body), attempts: 2 };
      const archive = vi.fn(async (_key: string) => ({}));
      const send = vi.fn(async (_body: unknown) => { throw new Error("alarm queue unavailable"); });
      const dlqQueue = `${queueName}-dlq`;
      const env = {
        CANARY_DLQ_ARCHIVE: { put: archive },
        CANARY_DLQ_ALERTS: { send },
        CANARY_DLQ_QUEUE_NAME: dlqQueue,
        CANARY_ALARM_QUEUE_NAME: `${queueName}-alarms`,
      };

      vi.setSystemTime("2026-08-03T06:00:00.000Z");
      await observeCanaryDlqBatch({ queue: dlqQueue, messages: [dlqMessage] }, env);
      vi.setSystemTime("2026-08-03T06:05:00.000Z");
      await observeCanaryDlqBatch({ queue: dlqQueue, messages: [retriedDlqMessage] }, env);

      const bodySha256 = await sha256Hex(JSON.stringify(dlqMessage.body));
      const expectedKey = `dlq/${dlqQueue}/${dlqMessage.id}-${bodySha256}.json`;
      expect(archive.mock.calls.map(([key]) => key)).toEqual([expectedKey, expectedKey]);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[0]?.[0]).toEqual(send.mock.calls[1]?.[0]);
      expect(send.mock.calls[0]?.[0]).toMatchObject({
        alarmId: expect.stringMatching(/^[a-f0-9]{64}$/),
        observedAt: "2026-08-03T06:00:00.000Z",
      });
      expect(dlqMessage.ack).not.toHaveBeenCalled();
      expect(retriedDlqMessage.ack).not.toHaveBeenCalled();
      expect(dlqMessage.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
      expect(retriedDlqMessage.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    } finally {
      vi.useRealTimers();
    }
  });
});
