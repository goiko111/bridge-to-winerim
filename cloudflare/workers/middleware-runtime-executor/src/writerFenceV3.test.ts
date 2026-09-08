import { describe, expect, it, vi } from "vitest";

import type { DatabaseAdapter, QueryResult } from "../../middleware-api/src/db";
import type { SecretTextPort } from "../../middleware-runtime/src/adapters/http";
import type { RuntimeCredentialAttestation } from "../../middleware-runtime/src/executor/vault";
import {
  sha256Hex,
  writerFenceCredentialBinding,
  writerFenceCredentialBundleDigests,
  writerFenceFleetCredentialBinding,
  type WriterFenceCredentialKind,
  type WriterFenceGrantV3,
} from "../../../canary-failclosed/src/writerFence";
import {
  assertExclusiveWriterFence,
  type MiddlewareRuntimeExecutorEnv,
  type WriterFenceExecutionScope,
} from "./worker";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "fleet-run-a";
const OTHER_RUN_ID = "fleet-run-b";
const HOLDER_ID = "fleet-holder-a";
const KEY_VERSION = "vault-v1";
const PROOF = "fleet-proof-secret-with-at-least-thirty-two-bytes";

type Fixture = Awaited<ReturnType<typeof fixture>>;

function result<Row extends Record<string, unknown>>(rows: Row[]): QueryResult<Row> {
  return { rows, rowCount: rows.length };
}

function attestation(
  kind: WriterFenceCredentialKind,
  version: string,
  connectionId = CONNECTION_ID,
): RuntimeCredentialAttestation {
  return Object.freeze({
    reference: `runtime-vault://postgres/${connectionId}/agora/${kind}`,
    version,
    connectionId,
    provider: "agora",
    kind,
  });
}

function secretPort(value: RuntimeCredentialAttestation): SecretTextPort {
  return Object.freeze({
    read: async () => `secret-${value.kind}`,
    attestation: () => value,
  }) as SecretTextPort;
}

async function fleetGrant(nowMs = Date.now()) {
  const agoraVersion = await sha256Hex("fixture-agora-attestation");
  const winerimVersion = await sha256Hex("fixture-winerim-attestation");
  const agora = attestation("agora", agoraVersion);
  const winerim = attestation("winerim", winerimVersion);
  const issuedAt = new Date(nowMs - 30_000).toISOString();
  const expiresAt = new Date(nowMs + 30 * 60_000).toISOString();
  const credentials = {
    agora: {
      kind: "agora" as const,
      reference: agora.reference,
      version: agora.version,
      attestationSha256: agora.version,
      binding: await writerFenceFleetCredentialBinding({
        credential: { ...agora, runId: RUN_ID },
        connectionId: CONNECTION_ID,
        runId: RUN_ID,
      }),
    },
    winerim: {
      kind: "winerim" as const,
      reference: winerim.reference,
      version: winerim.version,
      attestationSha256: winerim.version,
      binding: await writerFenceFleetCredentialBinding({
        credential: { ...winerim, runId: RUN_ID },
        connectionId: CONNECTION_ID,
        runId: RUN_ID,
      }),
    },
  };
  const generationSha256 = await sha256Hex([
    "winerim-runtime-credential-set",
    "1",
    CONNECTION_ID,
    RUN_ID,
    KEY_VERSION,
    credentials.agora.attestationSha256,
    credentials.winerim.attestationSha256,
  ].join("|"));
  const digests = await writerFenceCredentialBundleDigests({
    proof: PROOF,
    connectionId: CONNECTION_ID,
    runId: RUN_ID,
    holderId: HOLDER_ID,
    issuedAt,
    expiresAt,
    bundle: {
      version: 1,
      keyVersion: KEY_VERSION,
      generationSha256,
      credentials,
    },
  });
  const grant: WriterFenceGrantV3 = {
    version: 3,
    connectionId: CONNECTION_ID,
    runId: RUN_ID,
    holderId: HOLDER_ID,
    proofSha256: await sha256Hex(PROOF),
    credentialBundle: {
      version: 1,
      keyVersion: KEY_VERSION,
      generationSha256,
      credentials,
      ...digests,
    },
    legacyWriter: {
      revokedAt: new Date(nowMs - 60_000).toISOString(),
      negativeProbeStatus: 401,
      evidenceSha256: await sha256Hex("legacy-writer-revoked"),
    },
    issuedAt,
    expiresAt,
  };
  return { grant, rawGrant: JSON.stringify(grant), generationSha256, agora, winerim };
}

async function fixture(options: {
  activeCredentialSetSha256?: string;
  rawGrant?: string;
  leaseResponse?: (input: Record<string, unknown>) => Promise<Response> | Response;
} = {}) {
  const nowMs = Date.now();
  const material = await fleetGrant(nowMs);
  const rawGrant = options.rawGrant ?? material.rawGrant;
  const activeCredentialSetSha256 = options.activeCredentialSetSha256 ?? material.generationSha256;
  const query = vi.fn(async () => result([{
    connection_id: CONNECTION_ID,
    run_id: RUN_ID,
    writer_fence_grant_sha256: await sha256Hex(rawGrant),
    credential_set_sha256: activeCredentialSetSha256,
  }]));
  const database = {
    query,
    transaction: vi.fn(),
  } as unknown as DatabaseAdapter;
  const leaseRequests: Record<string, unknown>[] = [];
  const defaultLeaseResponse = async (input: Record<string, unknown>) => {
    const selected = input.credential as RuntimeCredentialAttestation & { runId: string };
    return new Response(JSON.stringify({
      connectionId: input.connectionId,
      runId: input.runId,
      holderId: input.holderId,
      fencingToken: selected.kind === "agora" ? 11 : 22,
      credentialReference: selected.reference,
      credentialVersion: selected.version,
      credentialBinding: await writerFenceFleetCredentialBinding({
        credential: selected,
        connectionId: String(input.connectionId),
        runId: String(input.runId),
      }),
      credentialKind: selected.kind,
      credentialAttestationSha256: selected.version,
      credentialBundleSha256: material.grant.credentialBundle.bundleSha256,
      requestNonce: input.requestNonce,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const leaseFetch = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    leaseRequests.push(input);
    return (options.leaseResponse ?? defaultLeaseResponse)(input);
  });
  const env: MiddlewareRuntimeExecutorEnv = {
    ENVIRONMENT: "rescue-production",
    RUNTIME_MODE: "fleet-executor",
    CANARY_WRITER_FENCE_GRANT: { get: async () => rawGrant },
    CANARY_WRITER_FENCE_PROOF: { get: async () => PROOF },
    WRITER_FENCE: { fetch: leaseFetch },
  };
  const executionScope: WriterFenceExecutionScope = {
    connectionId: CONNECTION_ID,
    runId: RUN_ID,
    holderId: HOLDER_ID,
    credentialSetSha256: material.generationSha256,
    env,
  };
  return {
    ...material,
    nowMs,
    database,
    env,
    executionScope,
    leaseFetch,
    leaseRequests,
  };
}

async function authorize(
  configured: Fixture,
  kind: WriterFenceCredentialKind,
  credential = kind === "agora" ? configured.agora : configured.winerim,
) {
  return assertExclusiveWriterFence(
    configured.env,
    configured.database,
    CONNECTION_ID,
    secretPort(credential),
    () => configured.nowMs,
    kind,
    false,
    configured.executionScope,
  );
}

describe("fleet executor writer fence v3", () => {
  it("acquires independent Agora and Winerim leases with selected attestations", async () => {
    const configured = await fixture();

    await expect(authorize(configured, "agora")).resolves.toMatchObject({
      credentialKind: "agora",
      fencingToken: 11,
      credentialAttestationSha256: configured.agora.version,
    });
    await expect(authorize(configured, "winerim")).resolves.toMatchObject({
      credentialKind: "winerim",
      fencingToken: 22,
      credentialAttestationSha256: configured.winerim.version,
    });

    expect(configured.leaseRequests.map((request) => (
      (request.credential as RuntimeCredentialAttestation).kind
    ))).toEqual(["agora", "winerim"]);
    expect(configured.leaseRequests.every((request) => (
      request.rawGrant === configured.rawGrant
      && typeof request.requestNonce === "string"
      && String(request.requestNonce).length > 0
    ))).toBe(true);
  });

  it("rejects credential substitution before requesting a lease", async () => {
    const configured = await fixture();
    const substituted = attestation("winerim", await sha256Hex("substituted-secret"));

    await expect(authorize(configured, "winerim", substituted)).rejects.toThrow(
      "WRITER_FENCE_ACTIVE_CREDENTIAL_MISMATCH",
    );
    expect(configured.leaseFetch).not.toHaveBeenCalled();
  });

  it("rejects an attestation selected for the wrong credential kind", async () => {
    const configured = await fixture();

    await expect(authorize(configured, "agora", configured.winerim)).rejects.toThrow(
      "WRITER_FENCE_CREDENTIAL_SCOPE_MISMATCH",
    );
    expect(configured.leaseFetch).not.toHaveBeenCalled();
  });

  it("rejects active credential-set drift before requesting a lease", async () => {
    const configured = await fixture({ activeCredentialSetSha256: "f".repeat(64) });

    await expect(authorize(configured, "winerim")).rejects.toThrow(
      "WRITER_FENCE_ACTIVE_CREDENTIAL_SET_MISMATCH",
    );
    expect(configured.leaseFetch).not.toHaveBeenCalled();
  });

  it("fails closed when the lease is absent", async () => {
    const configured = await fixture({
      leaseResponse: () => new Response("held", { status: 409 }),
    });

    await expect(authorize(configured, "winerim")).rejects.toThrow("WRITER_FENCE_LEASE_DENIED_409");
  });

  it("rejects an expired lease response", async () => {
    const configured = await fixture({
      leaseResponse: async (input) => {
        const selected = input.credential as RuntimeCredentialAttestation & { runId: string };
        return new Response(JSON.stringify({
          connectionId: CONNECTION_ID,
          runId: RUN_ID,
          holderId: HOLDER_ID,
          fencingToken: 1,
          credentialReference: selected.reference,
          credentialVersion: selected.version,
          credentialBinding: await writerFenceFleetCredentialBinding({
            credential: selected,
            connectionId: CONNECTION_ID,
            runId: RUN_ID,
          }),
          credentialKind: selected.kind,
          credentialAttestationSha256: selected.version,
          credentialBundleSha256: configured.grant.credentialBundle.bundleSha256,
          requestNonce: input.requestNonce,
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        }), { status: 200 });
      },
    });

    await expect(authorize(configured, "winerim")).rejects.toThrow("WRITER_FENCE_LEASE_RESPONSE_INVALID");
  });

  it.each([
    ["connection", OTHER_CONNECTION_ID, RUN_ID],
    ["run", CONNECTION_ID, OTHER_RUN_ID],
  ])("rejects a lease bound to another %s", async (_label, connectionId, runId) => {
    const configured = await fixture({
      leaseResponse: async (input) => {
        const selected = input.credential as RuntimeCredentialAttestation & { runId: string };
        return new Response(JSON.stringify({
          connectionId,
          runId,
          holderId: HOLDER_ID,
          fencingToken: 1,
          credentialReference: selected.reference,
          credentialVersion: selected.version,
          credentialBinding: await writerFenceFleetCredentialBinding({
            credential: selected,
            connectionId: CONNECTION_ID,
            runId: RUN_ID,
          }),
          credentialKind: selected.kind,
          credentialAttestationSha256: selected.version,
          credentialBundleSha256: configured.grant.credentialBundle.bundleSha256,
          requestNonce: input.requestNonce,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }), { status: 200 });
      },
    });

    await expect(authorize(configured, "winerim")).rejects.toThrow("WRITER_FENCE_LEASE_RESPONSE_INVALID");
  });

  it("rejects a replayed lease nonce", async () => {
    let previousNonce: unknown;
    const configured = await fixture({
      leaseResponse: async (input) => {
        const selected = input.credential as RuntimeCredentialAttestation & { runId: string };
        const responseNonce = previousNonce ?? input.requestNonce;
        previousNonce = input.requestNonce;
        return new Response(JSON.stringify({
          connectionId: CONNECTION_ID,
          runId: RUN_ID,
          holderId: HOLDER_ID,
          fencingToken: 1,
          credentialReference: selected.reference,
          credentialVersion: selected.version,
          credentialBinding: await writerFenceFleetCredentialBinding({
            credential: selected,
            connectionId: CONNECTION_ID,
            runId: RUN_ID,
          }),
          credentialKind: selected.kind,
          credentialAttestationSha256: selected.version,
          credentialBundleSha256: configured.grant.credentialBundle.bundleSha256,
          requestNonce: responseNonce,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }), { status: 200 });
      },
    });

    await expect(authorize(configured, "winerim")).resolves.toBeTruthy();
    await expect(authorize(configured, "winerim")).rejects.toThrow(
      "WRITER_FENCE_LEASE_FLEET_BINDING_MISMATCH",
    );
  });

  it("requires grant v3 in fleet mode and never falls back to one legacy credential", async () => {
    const configured = await fixture();
    const legacyAttestation = configured.winerim;
    const rawGrant = JSON.stringify({
      version: 1,
      connectionId: CONNECTION_ID,
      runId: RUN_ID,
      holderId: HOLDER_ID,
      proofSha256: await sha256Hex(PROOF),
      exclusiveCredentialRef: legacyAttestation.reference,
      credentialVersion: legacyAttestation.version,
      credentialBinding: await writerFenceCredentialBinding(legacyAttestation),
      legacyWriter: {
        revokedAt: new Date(configured.nowMs - 60_000).toISOString(),
        negativeProbeStatus: 401,
        evidenceSha256: await sha256Hex("legacy-writer-revoked"),
      },
      issuedAt: new Date(configured.nowMs - 30_000).toISOString(),
      expiresAt: new Date(configured.nowMs + 30 * 60_000).toISOString(),
    });
    const legacy = await fixture({ rawGrant });

    await expect(authorize(legacy, "winerim")).rejects.toThrow("WRITER_FENCE_FLEET_GRANT_V3_REQUIRED");
    expect(legacy.leaseFetch).not.toHaveBeenCalled();
  });
});
