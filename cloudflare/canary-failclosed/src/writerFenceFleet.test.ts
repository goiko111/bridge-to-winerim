import { describe, expect, it, vi } from "vitest";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
  SqlStatement,
} from "../../workers/middleware-api/src/db";
import {
  acquireExclusiveWriterFence,
  authorizeWriterFenceMutation,
  parseWriterFenceGrant,
  sha256Hex,
  validateActiveWriterFenceGrant,
  validateWriterFenceGrant,
  writerFenceCredentialBundleDigests,
  writerFenceFleetCredentialBinding,
  type WriterFenceCredentialAttestation,
  type WriterFenceCredentialKind,
  type WriterFenceGrantV3,
} from "./writerFence";
import { ConnectionWriterFence } from "./writerFenceWorker";

const connectionId = "11111111-1111-4111-8111-111111111111";
const otherConnectionId = "22222222-2222-4222-8222-222222222222";
const runId = "fleet-vinatea-a";
const holderId = "fleet-executor-a";
const proof = "fleet-proof-known-only-by-the-runtime-123456789";
const issuedAt = "2026-08-04T12:00:00.000Z";
const expiresAt = "2026-08-04T13:00:00.000Z";

function attestation(
  kind: WriterFenceCredentialKind,
  version = kind === "agora" ? "a".repeat(64) : "b".repeat(64),
): Required<WriterFenceCredentialAttestation> {
  return {
    connectionId,
    runId,
    provider: "agora",
    kind,
    reference: `runtime-vault://postgres/${connectionId}/agora/${kind}`,
    version,
  };
}

async function fleetGrant(): Promise<WriterFenceGrantV3> {
  const agoraAttestation = attestation("agora");
  const winerimAttestation = attestation("winerim");
  const keyVersion = "v1";
  const credentials = {
    agora: {
      kind: "agora" as const,
      reference: agoraAttestation.reference,
      version: agoraAttestation.version,
      attestationSha256: agoraAttestation.version,
      binding: await writerFenceFleetCredentialBinding({
        credential: agoraAttestation,
        connectionId,
        runId,
      }),
    },
    winerim: {
      kind: "winerim" as const,
      reference: winerimAttestation.reference,
      version: winerimAttestation.version,
      attestationSha256: winerimAttestation.version,
      binding: await writerFenceFleetCredentialBinding({
        credential: winerimAttestation,
        connectionId,
        runId,
      }),
    },
  };
  const generationSha256 = await sha256Hex([
    "winerim-runtime-credential-set",
    "1",
    connectionId,
    runId,
    keyVersion,
    credentials.agora.attestationSha256,
    credentials.winerim.attestationSha256,
  ].join("|"));
  const unsignedBundle = {
    version: 1 as const,
    keyVersion,
    generationSha256,
    credentials,
  };
  const digests = await writerFenceCredentialBundleDigests({
    proof,
    connectionId,
    runId,
    holderId,
    issuedAt,
    expiresAt,
    bundle: unsignedBundle,
  });
  return {
    version: 3,
    connectionId,
    runId,
    holderId,
    proofSha256: await sha256Hex(proof),
    credentialBundle: { ...unsignedBundle, ...digests },
    legacyWriter: {
      revokedAt: "2026-08-04T11:58:00.000Z",
      negativeProbeStatus: 401,
      evidenceSha256: "c".repeat(64),
    },
    issuedAt,
    expiresAt,
  };
}

async function adoptExistingFleetGrant(): Promise<WriterFenceGrantV3> {
  const { legacyWriter: _legacyWriter, ...base } = await fleetGrant();
  const externalEvidence = {
    artifactSha256: "d".repeat(64),
    publicKeySha256: "e".repeat(64),
    payloadSha256: "f".repeat(64),
    signatureSha256: "1".repeat(64),
    keyId: "lovable-fence-observer-v1",
    projectId: "33333333-3333-4333-8333-333333333333",
    collectorRunId: "vinatea-external-observer-a",
    fenceMode: "lovable-disabled-no-agora-rotation" as const,
    fenceAppliedAt: "2026-08-04T11:50:00.000Z",
    observedAt: "2026-08-04T11:59:55.000Z",
    readbackObservedAt: [
      "2026-08-04T11:59:45.000Z",
      "2026-08-04T11:59:55.000Z",
    ] as [string, string],
    removedFromLovable: true as const,
  };
  const activationScope = {
    version: 1 as const,
    kind: "adopt-existing-sales" as const,
    adoptionBindingSha256: "2".repeat(64),
    deploymentManifestSha256: "3".repeat(64),
    finalTargetRawSha256: "4".repeat(64),
    externalEvidenceSha256: externalEvidence.artifactSha256,
    externalEvidencePayloadSha256: externalEvidence.payloadSha256,
    runtimePolicySha256: "5".repeat(64),
    bindingSha256: "",
    signatureSha256: "",
  };
  const payload = [
    "winerim-writer-fence-adopt-existing-sales",
    "1",
    connectionId,
    runId,
    holderId,
    issuedAt,
    expiresAt,
    activationScope.adoptionBindingSha256,
    activationScope.deploymentManifestSha256,
    activationScope.finalTargetRawSha256,
    activationScope.externalEvidenceSha256,
    activationScope.externalEvidencePayloadSha256,
    activationScope.runtimePolicySha256,
  ].join("|");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(proof),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return {
    ...base,
    grantType: "adopt-existing-sales",
    writerHistory: {
      mode: "adopt-existing-sales",
      verifiedAt: externalEvidence.observedAt,
      evidenceSha256: "6".repeat(64),
      cloudflareEvidenceSha256: "7".repeat(64),
      externalEvidence,
    },
    activationScope: {
      ...activationScope,
      bindingSha256: await sha256Hex(payload),
      signatureSha256: [...new Uint8Array(signature)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    },
  };
}

function activeScopeDatabase(grantSha256: string, credentialSetSha256: string): DatabaseAdapter {
  const query: DatabaseAdapter["query"] = async <Row extends Record<string, unknown>>(
    statement: SqlStatement,
  ) => {
    if (!statement.text.includes("FROM public.runtime_canary_connections")) {
      return { rows: [], rowCount: 0 } as QueryResult<Row>;
    }
    return {
      rows: [{
        connection_id: connectionId,
        run_id: runId,
        writer_fence_grant_sha256: grantSha256,
        credential_set_sha256: credentialSetSha256,
      }] as unknown as Row[],
      rowCount: 1,
    };
  };
  return {
    query,
    transaction: async <T>(work: (transaction: DatabaseTransaction) => Promise<T>) => work({ query }),
  };
}

function memoryStorage() {
  const values = new Map<string, unknown>();
  type MemoryStorage = {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    transaction<T>(callback: (transaction: MemoryStorage) => Promise<T>): Promise<T>;
  };
  const storage: MemoryStorage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => { values.set(key, value); },
    transaction: async <T>(callback: (transaction: typeof storage) => Promise<T>) => callback(storage),
  };
  return { storage, values };
}

async function workerFixture() {
  const grant = await fleetGrant();
  const rawGrant = JSON.stringify(grant);
  const activeGrantSha256 = await sha256Hex(rawGrant);
  const { storage, values } = memoryStorage();
  const worker = new ConnectionWriterFence(
    { storage },
    {
      CONNECTION_WRITER_FENCE: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => new Response(null, { status: 501 }) }),
      },
    },
    {
      database: () => activeScopeDatabase(
        activeGrantSha256,
        grant.credentialBundle.generationSha256,
      ),
    },
  );
  return { grant, rawGrant, worker, values };
}

function acquireRequest(input: {
  rawGrant: string;
  credential: Required<WriterFenceCredentialAttestation>;
  nonce: string;
  requestConnectionId?: string;
  requestRunId?: string;
}) {
  return new Request("https://writer-fence.internal/v1/leases/acquire", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-writer-fence-proof": proof,
    },
    body: JSON.stringify({
      connectionId: input.requestConnectionId ?? connectionId,
      runId: input.requestRunId ?? runId,
      holderId,
      ttlSeconds: 90,
      rawGrant: input.rawGrant,
      credential: input.credential,
      requestNonce: input.nonce,
    }),
  });
}

describe("fleet writer-fence credential bundle", () => {
  it("validates the signed per-connection bundle against the active credential generation", async () => {
    const grant = await fleetGrant();
    const rawGrant = JSON.stringify(grant);
    const parsed = parseWriterFenceGrant(rawGrant);
    expect(parsed.version).toBe(3);
    await expect(validateWriterFenceGrant({
      grant: parsed,
      proof,
      connectionId,
      runId,
      holderId,
      nowMs: Date.parse("2026-08-04T12:30:00.000Z"),
    })).resolves.toBeUndefined();
    await expect(validateActiveWriterFenceGrant({
      rawGrant,
      proof,
      evidence: {
        connectionId,
        runId,
        writerFenceGrantSha256: await sha256Hex(rawGrant),
        credentialSetSha256: grant.credentialBundle.generationSha256,
      },
      connectionId,
      runId,
      holderId,
      nowMs: Date.parse("2026-08-04T12:30:00.000Z"),
    })).resolves.toMatchObject({ version: 3, connectionId, runId });
  });

  it("accepts the signed adopt-existing-sales writer history and rejects scope drift", async () => {
    const grant = await adoptExistingFleetGrant();
    const rawGrant = JSON.stringify(grant);
    await expect(validateActiveWriterFenceGrant({
      rawGrant,
      proof,
      evidence: {
        connectionId,
        runId,
        writerFenceGrantSha256: await sha256Hex(rawGrant),
        credentialSetSha256: grant.credentialBundle.generationSha256,
      },
      connectionId,
      runId,
      holderId,
      nowMs: Date.parse("2026-08-04T12:30:00.000Z"),
    })).resolves.toMatchObject({
      version: 3,
      grantType: "adopt-existing-sales",
      writerHistory: { mode: "adopt-existing-sales" },
    });

    await expect(validateWriterFenceGrant({
      grant: {
        ...grant,
        activationScope: {
          ...grant.activationScope!,
          runtimePolicySha256: "8".repeat(64),
        },
      },
      proof,
      connectionId,
      runId,
      holderId,
      nowMs: Date.parse("2026-08-04T12:30:00.000Z"),
    })).rejects.toThrow("WRITER_FENCE_GRANT_ADOPT_EXISTING_SCOPE_SIGNATURE_MISMATCH");

    expect(() => parseWriterFenceGrant(JSON.stringify({
      ...grant,
      writerHistory: {
        ...grant.writerHistory!,
        absence: { activeConnectionCount: 0 },
      },
    }))).toThrow("WRITER_FENCE_GRANT_ADOPT_EXISTING_EXTERNAL_EVIDENCE_REJECTED");

    const equalReadbackGrant = structuredClone(grant);
    if (equalReadbackGrant.writerHistory?.mode === "adopt-existing-sales") {
      equalReadbackGrant.writerHistory.externalEvidence.readbackObservedAt[0] =
        equalReadbackGrant.writerHistory.externalEvidence.readbackObservedAt[1];
    }
    expect(() => parseWriterFenceGrant(JSON.stringify(equalReadbackGrant))).toThrow(
      "WRITER_FENCE_GRANT_ADOPT_EXISTING_EVIDENCE_ORDER_REJECTED",
    );

    const legacyGrant = await fleetGrant();
    expect(() => parseWriterFenceGrant(JSON.stringify({
      ...legacyGrant,
      grantType: "adopt-existing-sales",
      activationScope: grant.activationScope,
    }))).toThrow("WRITER_FENCE_GRANT_LEGACY_ADOPT_FIELDS_FORBIDDEN");
  });

  it("fails closed on bundle tampering, generation drift, expiry and cross-connection scope", async () => {
    const grant = await fleetGrant();
    await expect(validateWriterFenceGrant({
      grant: {
        ...grant,
        credentialBundle: {
          ...grant.credentialBundle,
          credentials: {
            ...grant.credentialBundle.credentials,
            winerim: {
              ...grant.credentialBundle.credentials.winerim,
              attestationSha256: "d".repeat(64),
              version: "d".repeat(64),
            },
          },
        },
      },
      proof,
      connectionId,
      runId,
      holderId,
      nowMs: Date.parse("2026-08-04T12:30:00.000Z"),
    })).rejects.toThrow();
    const rawGrant = JSON.stringify(grant);
    await expect(validateActiveWriterFenceGrant({
      rawGrant,
      proof,
      evidence: {
        connectionId,
        runId,
        writerFenceGrantSha256: await sha256Hex(rawGrant),
        credentialSetSha256: "e".repeat(64),
      },
      connectionId,
      runId,
      holderId,
      nowMs: Date.parse("2026-08-04T12:30:00.000Z"),
    })).rejects.toThrow("WRITER_FENCE_ACTIVE_CREDENTIAL_SET_MISMATCH");
    await expect(validateWriterFenceGrant({
      grant,
      proof,
      connectionId,
      runId,
      holderId,
      nowMs: Date.parse(expiresAt),
    })).rejects.toThrow("WRITER_FENCE_GRANT_EXPIRED");
    await expect(validateWriterFenceGrant({
      grant,
      proof,
      connectionId: otherConnectionId,
      runId,
      holderId,
      nowMs: Date.parse("2026-08-04T12:30:00.000Z"),
    })).rejects.toThrow("WRITER_FENCE_CONNECTION_MISMATCH");
  });

  it("issues independent Agora and Winerim leases and binds mutation authorization to each kind", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-04T12:30:00.000Z");
    try {
      const { rawGrant, worker, values } = await workerFixture();
      const agora = attestation("agora");
      const winerim = attestation("winerim");
      const agoraResponse = await worker.fetch(acquireRequest({
        rawGrant,
        credential: agora,
        nonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }));
      const winerimResponse = await worker.fetch(acquireRequest({
        rawGrant,
        credential: winerim,
        nonce: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }));
      expect(agoraResponse.status).toBe(200);
      expect(winerimResponse.status).toBe(200);
      const agoraLease = await agoraResponse.json();
      const winerimLease = await winerimResponse.json();
      expect(agoraLease).toMatchObject({ credentialKind: "agora", fencingToken: 1 });
      expect(winerimLease).toMatchObject({ credentialKind: "winerim", fencingToken: 1 });
      expect(values.has("lease:agora")).toBe(true);
      expect(values.has("lease:winerim")).toBe(true);
      await expect(authorizeWriterFenceMutation({
        lease: agoraLease,
        credential: agora,
        nowMs: Date.parse("2026-08-04T12:30:10.000Z"),
      })).resolves.toMatchObject({ credentialKind: "agora" });
      await expect(authorizeWriterFenceMutation({
        lease: agoraLease,
        credential: winerim,
        nowMs: Date.parse("2026-08-04T12:30:10.000Z"),
      })).rejects.toThrow("WRITER_FENCE_CREDENTIAL_KIND_DRIFT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the selected attestation and per-connection grant through the fleet client", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-04T12:30:00.000Z");
    try {
      const grant = await fleetGrant();
      const rawGrant = JSON.stringify(grant);
      const credential = attestation("winerim");
      const lease = await acquireExclusiveWriterFence({
        env: {
          CANARY_WRITER_FENCE_PROOF: { get: async () => proof },
          CANARY_WRITER_FENCE_GRANT: { get: async () => rawGrant },
          WRITER_FENCE: {
            fetch: async (_input, init) => {
              const body = JSON.parse(String(init?.body)) as {
                rawGrant: string;
                credential: Required<WriterFenceCredentialAttestation>;
                requestNonce: string;
              };
              expect(body.rawGrant).toBe(rawGrant);
              expect(body.credential).toEqual(credential);
              expect(body.requestNonce).toMatch(/^[0-9a-f-]{36}$/i);
              const allowed = grant.credentialBundle.credentials.winerim;
              return Response.json({
                connectionId,
                runId,
                holderId,
                fencingToken: 4,
                credentialReference: allowed.reference,
                credentialVersion: allowed.version,
                credentialBinding: allowed.binding,
                credentialKind: "winerim",
                credentialAttestationSha256: allowed.attestationSha256,
                credentialBundleSha256: grant.credentialBundle.bundleSha256,
                requestNonce: body.requestNonce,
                expiresAt: "2026-08-04T12:31:00.000Z",
              });
            },
          },
        },
        connectionId,
        runId,
        holderId,
        credential,
        ttlSeconds: 90,
      });
      expect(lease).toMatchObject({
        credentialKind: "winerim",
        credentialAttestationSha256: credential.version,
        fencingToken: 4,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects cross-credential substitution and request replay without replacing a valid lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-04T12:30:00.000Z");
    try {
      const { rawGrant, worker, values } = await workerFixture();
      const nonce = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const first = await worker.fetch(acquireRequest({
        rawGrant,
        credential: attestation("agora"),
        nonce,
      }));
      expect(first.status).toBe(200);

      const replay = await worker.fetch(acquireRequest({
        rawGrant,
        credential: attestation("agora"),
        nonce,
      }));
      expect(replay.status).toBe(403);
      await expect(replay.json()).resolves.toMatchObject({ error: "WRITER_FENCE_REQUEST_REPLAY_REJECTED" });

      const substituted = await worker.fetch(acquireRequest({
        rawGrant,
        credential: { ...attestation("agora"), version: "f".repeat(64) },
        nonce: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      }));
      expect(substituted.status).toBe(403);
      await expect(substituted.json()).resolves.toMatchObject({
        error: "WRITER_FENCE_FLEET_CREDENTIAL_ATTESTATION_MISMATCH",
      });
      expect((values.get("lease:agora") as { credentialVersion: string }).credentialVersion)
        .toBe(attestation("agora").version);
      expect([...values.keys()].filter((key) => key.startsWith("requestNonce:"))).toHaveLength(0);
      expect(values.get("requestNonces:agora")).toEqual([{
        nonce,
        observedAt: Date.parse("2026-08-04T12:30:00.000Z"),
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a per-connection bundle replayed under another connection or run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-04T12:30:00.000Z");
    try {
      const { rawGrant, worker } = await workerFixture();
      const wrongConnection = await worker.fetch(acquireRequest({
        rawGrant,
        credential: attestation("agora"),
        nonce: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        requestConnectionId: otherConnectionId,
      }));
      expect(wrongConnection.status).toBe(403);
      await expect(wrongConnection.json()).resolves.toMatchObject({ error: "WRITER_FENCE_ACTIVE_SCOPE_MISMATCH" });

      const wrongRun = await worker.fetch(acquireRequest({
        rawGrant,
        credential: attestation("winerim"),
        nonce: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        requestRunId: "fleet-other-run",
      }));
      expect(wrongRun.status).toBe(403);
      await expect(wrongRun.json()).resolves.toMatchObject({ error: "WRITER_FENCE_ACTIVE_SCOPE_MISMATCH" });
    } finally {
      vi.useRealTimers();
    }
  });
});
