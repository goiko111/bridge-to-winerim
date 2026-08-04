import {
  createHash,
  createHmac,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import { prepareWriterFenceGrant } from "../../infrastructure/runtime/prepare-writer-fence-grant.mjs";
// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import { validateFleetConnectionAdoptExistingActivationInput } from "../../infrastructure/runtime/prepare-fleet-connection-activation.mjs";

const CONNECTION_ID = "e465872a-bff5-43de-8e4c-fe4986f0fd4f";
const RUN_ID = "vinatea-cutover-b";
const ISSUED_AT = "2026-08-04T14:10:00.000Z";
const EXPIRES_AT = "2026-08-04T15:10:00.000Z";
const PROJECT_ID = "a61b5b89-4c36-44fc-aaf2-9c7c3f3cfd8d";
const PROOF = "fixture-proof-secret-with-more-than-32-bytes";
const ADOPTION_BINDING_SHA256 = "c".repeat(64);
const DEPLOYMENT_MANIFEST_SHA256 = "d".repeat(64);
const FINAL_TARGET_RAW_SHA256 = "e".repeat(64);
const INTERNAL_FENCE_EVIDENCE_SHA256 = "f".repeat(64);
const INTERNAL_SOURCE_PASS_SHA256 = "1".repeat(64);
const PROVIDER_CONFIG = {
  runtime_sales_job_allowlist: ["sales.auto-sync", "sales.sync-intraday"],
  intraday_sales_sync_enabled: true,
  open_tickets_sync_enabled: false,
  open_tickets_stock_sync_enabled: false,
};
const FULL_LANES_JOBS = [
  "sales.auto-sync",
  "sales.sync-intraday",
  "catalog.fetch-winerim",
  "catalog.sync-master",
  "outbound.process",
];
const FULL_LANES_PROVIDER_CONFIG = {
  runtime_fleet_profile: "full-lanes-v1",
  runtime_fleet_job_allowlist: FULL_LANES_JOBS,
  runtime_sales_job_allowlist: ["sales.auto-sync", "sales.sync-intraday"],
  intraday_sales_sync_enabled: true,
  open_tickets_sync_enabled: false,
  open_tickets_stock_sync_enabled: false,
  runtime_catalog_enabled: true,
  runtime_stock_enabled: true,
  runtime_outbound_enabled: true,
  runtime_maintenance_enabled: false,
};
const temporaryDirectories: string[] = [];

type EvidenceOptions = {
  fenceMode?: "lovable-disabled-no-agora-rotation" | "agora-credential-rotated";
  observedAt?: string;
  readbackTimes?: string[];
  removedFromLovable?: boolean;
  credentialUnavailable?: boolean;
  invalidSignature?: boolean;
  invalidEnvelopeHash?: boolean;
};

function temporaryDirectory(label: string) {
  const directory = mkdtempSync(join(tmpdir(), `${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(source: Buffer | string) {
  return createHash("sha256").update(source).digest("hex");
}

function writePrivate(directory: string, name: string, source: Buffer | string) {
  const path = join(directory, name);
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, source: bytes, sha256: sha256(bytes) };
}

function writePrivateJson(directory: string, name: string, value: unknown) {
  return writePrivate(directory, name, `${JSON.stringify(value, null, 2)}\n`);
}

function writeEvidence(directory: string, options: EvidenceOptions = {}) {
  const fenceMode = options.fenceMode ?? "lovable-disabled-no-agora-rotation";
  const observedAt = options.observedAt ?? "2026-08-04T14:08:00.000Z";
  const readbackTimes = options.readbackTimes ?? [
    "2026-08-04T14:02:10.000Z",
    observedAt,
  ];
  const keyPair = generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" });
  const payload = {
    evidenceType: "lovable-writer-fence",
    connectionId: CONNECTION_ID,
    source: {
      provider: "lovable-cloud",
      projectId: PROJECT_ID,
      collectorRunId: "vinatea-external-observer-20260804-b",
    },
    fenceMode,
    fenceAppliedAt: "2026-08-04T14:00:00.000Z",
    observedAt,
    lovable: {
      writerDisabled: true,
      cronDisabled: true,
      edgeMutationDisabled: true,
    },
    agoraCredential: fenceMode === "lovable-disabled-no-agora-rotation"
      ? { rotated: false, removedFromLovable: options.removedFromLovable ?? true }
      : {
        rotated: true,
        rotatedAt: "2026-08-04T14:00:00.000Z",
        oldCredentialProbeStatus: 401,
      },
    readbacks: readbackTimes.map((readbackObservedAt) => ({
      observedAt: readbackObservedAt,
      status: "FENCED_HEALTHY",
      writerDisabled: true,
      cronDisabled: true,
      edgeMutationDisabled: true,
      agoraCredentialUnavailableToLovable: options.credentialUnavailable ?? true,
    })),
  };
  const signedPayload = options.invalidSignature
    ? { ...payload, observedAt: "2026-08-04T14:07:59.000Z" }
    : payload;
  const signature = sign(null, Buffer.from(JSON.stringify(signedPayload)), keyPair.privateKey);
  const payloadSha256 = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const publicKeySource = Buffer.from(publicKey);
  const evidenceSource = Buffer.from(`${JSON.stringify({
    version: 1,
    algorithm: "Ed25519",
    keyId: "lovable-fence-observer-v1",
    payload,
    signatureBase64: signature.toString("base64"),
    publicKeyPem: publicKeySource.toString("utf8"),
    hashes: {
      readbacksSourceSha256: createHash("sha256").update(JSON.stringify(payload.readbacks)).digest("hex"),
      publicKeySha256: createHash("sha256").update(publicKeySource).digest("hex"),
      payloadSha256: options.invalidEnvelopeHash ? "0".repeat(64) : payloadSha256,
      signatureSha256: createHash("sha256").update(signature).digest("hex"),
    },
  }, null, 2)}\n`);
  const evidencePath = join(directory, "writer-fence-evidence.json");
  const publicKeyPath = join(directory, "writer-fence-observer.pem");
  writeFileSync(evidencePath, evidenceSource, { mode: 0o600 });
  writeFileSync(publicKeyPath, publicKeySource, { mode: 0o600 });
  return {
    evidencePath,
    evidenceSha256: createHash("sha256").update(evidenceSource).digest("hex"),
    evidenceSource,
    publicKeyPath,
    publicKeySha256: createHash("sha256").update(publicKeySource).digest("hex"),
    publicKeySource,
  };
}

type GrantBindings = {
  evidence?: ReturnType<typeof writeEvidence>;
  adoptionBindingSha256?: string;
  deploymentManifestSha256?: string;
  finalTargetRawSha256?: string;
  internalFenceEvidenceSha256?: string;
  internalSourcePassSha256?: string;
};

function grantEnvironment(
  directory: string,
  evidenceOptions: EvidenceOptions = {},
  bindings: GrantBindings = {},
) {
  const evidence = bindings.evidence ?? writeEvidence(directory, evidenceOptions);
  return {
    CANARY_CONNECTION_ID: CONNECTION_ID,
    CANARY_RUN_ID: RUN_ID,
    CANARY_HOLDER_ID: "vinatea-release-b",
    CANARY_WRITER_FENCE_PROOF: PROOF,
    CANARY_FENCE_ISSUED_AT: ISSUED_AT,
    CANARY_FENCE_EXPIRES_AT: EXPIRES_AT,
    WRITER_FENCE_MODE: "adopt-existing-sales-no-legacy-writer",
    RUNTIME_VAULT_KEY_VERSION: "fleet-v1-20260804",
    CANARY_AGORA_CREDENTIAL_VERSION: "a".repeat(64),
    CANARY_WINERIM_CREDENTIAL_VERSION: "b".repeat(64),
    CANARY_ADOPT_EXISTING_ACTIVE_CONNECTION_COUNT: "0",
    CANARY_ADOPT_EXISTING_ACTIVE_CREDENTIAL_COUNT: "0",
    CANARY_ADOPT_EXISTING_ACTIVE_SCOPE_COUNT: "0",
    CANARY_ADOPT_EXISTING_PRIOR_RUN_COUNT: "3",
    CANARY_ADOPT_EXISTING_ACTIVE_PRODUCER_COUNT: "0",
    CANARY_ADOPT_EXISTING_ACTIVE_CONSUMER_COUNT: "0",
    CANARY_RUNTIME_JOBS: JSON.stringify(["sales.auto-sync", "sales.sync-intraday"]),
    CANARY_RUNTIME_LANE: "sales",
    CANARY_RUNTIME_OPEN_TICKETS_ENABLED: "false",
    CANARY_RUNTIME_CATALOG_ENABLED: "false",
    CANARY_RUNTIME_STOCK_ENABLED: "false",
    CANARY_RUNTIME_OUTBOUND_ENABLED: "false",
    CANARY_RUNTIME_MAINTENANCE_ENABLED: "false",
    CANARY_ADOPTION_BINDING_SHA256: bindings.adoptionBindingSha256 ?? ADOPTION_BINDING_SHA256,
    CANARY_DEPLOYMENT_MANIFEST_SHA256: bindings.deploymentManifestSha256 ?? DEPLOYMENT_MANIFEST_SHA256,
    CANARY_FINAL_TARGET_RAW_SHA256: bindings.finalTargetRawSha256 ?? FINAL_TARGET_RAW_SHA256,
    CANARY_WRITER_FENCE_EVIDENCE_SHA256: bindings.internalFenceEvidenceSha256 ?? INTERNAL_FENCE_EVIDENCE_SHA256,
    CANARY_WRITER_FENCE_SOURCE_PASS_SHA256: bindings.internalSourcePassSha256 ?? INTERNAL_SOURCE_PASS_SHA256,
    CANARY_WRITER_FENCE_VERIFIED_AT: "2026-08-04T14:08:00.000Z",
    NO_LEGACY_WRITER_EXTERNAL_EVIDENCE: evidence.evidencePath,
    NO_LEGACY_WRITER_EXTERNAL_EVIDENCE_SHA256: evidence.evidenceSha256,
    NO_LEGACY_WRITER_EXTERNAL_PUBLIC_KEY: evidence.publicKeyPath,
    NO_LEGACY_WRITER_EXTERNAL_PUBLIC_KEY_SHA256: evidence.publicKeySha256,
  };
}

function fullLanesGrantEnvironment(
  directory: string,
  overrides: Record<string, string> = {},
) {
  return {
    ...grantEnvironment(directory),
    WRITER_FENCE_MODE: "adopt-existing-full-lanes-no-legacy-writer",
    CANARY_RUNTIME_JOBS: JSON.stringify(FULL_LANES_JOBS),
    CANARY_RUNTIME_LANE: "full-lanes",
    CANARY_RUNTIME_CATALOG_ENABLED: "true",
    CANARY_RUNTIME_STOCK_ENABLED: "true",
    CANARY_RUNTIME_OUTBOUND_ENABLED: "true",
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("adopt-existing sales writer-fence grant", () => {
  it("generates a v3 grant from fresh no-rotation Ed25519 evidence", () => {
    const directory = temporaryDirectory("writer-fence-adopt-existing");
    const output = join(directory, "writer-fence-grant.json");
    const result = prepareWriterFenceGrant({
      environment: grantEnvironment(directory),
      output,
    });

    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(result.grant);
    expect(result.grant).toMatchObject({
      version: 3,
      grantType: "adopt-existing-sales",
      credentialBundle: {
        version: 1,
        credentials: {
          agora: { kind: "agora", attestationSha256: "a".repeat(64) },
          winerim: { kind: "winerim", attestationSha256: "b".repeat(64) },
        },
      },
      writerHistory: {
        mode: "adopt-existing-sales",
        verifiedAt: "2026-08-04T14:08:00.000Z",
        evidenceSha256: INTERNAL_FENCE_EVIDENCE_SHA256,
        cloudflareEvidenceSha256: INTERNAL_SOURCE_PASS_SHA256,
        externalEvidence: {
          fenceMode: "lovable-disabled-no-agora-rotation",
          removedFromLovable: true,
          readbackObservedAt: [
            "2026-08-04T14:02:10.000Z",
            "2026-08-04T14:08:00.000Z",
          ],
        },
      },
      activationScope: {
        version: 1,
        kind: "adopt-existing-sales",
        adoptionBindingSha256: ADOPTION_BINDING_SHA256,
        deploymentManifestSha256: DEPLOYMENT_MANIFEST_SHA256,
        finalTargetRawSha256: FINAL_TARGET_RAW_SHA256,
        runtimePolicySha256: createHash("sha256").update(canonicalJson(PROVIDER_CONFIG)).digest("hex"),
      },
    });
    expect(result.grant).not.toHaveProperty("runtimeScope");
    expect(result.grant.writerHistory).not.toHaveProperty("absence");
    const scope = result.grant.activationScope;
    const scopePayload = [
      "winerim-writer-fence-adopt-existing-sales",
      "1",
      CONNECTION_ID,
      RUN_ID,
      "vinatea-release-b",
      ISSUED_AT,
      EXPIRES_AT,
      ADOPTION_BINDING_SHA256,
      DEPLOYMENT_MANIFEST_SHA256,
      FINAL_TARGET_RAW_SHA256,
      scope.externalEvidenceSha256,
      scope.externalEvidencePayloadSha256,
      scope.runtimePolicySha256,
    ].join("|");
    expect(scope.bindingSha256).toBe(createHash("sha256").update(scopePayload).digest("hex"));
    expect(scope.signatureSha256).toBe(createHmac("sha256", PROOF).update(scopePayload).digest("hex"));
  });

  it("is accepted structurally by the real GO_LOCAL adopt-existing activator", () => {
    const directory = temporaryDirectory("writer-fence-go-local-integration");
    chmodSync(directory, 0o700);
    const deployment = writePrivateJson(directory, "deployment.json", {
      version: 1,
      kind: "runtime-sales-deployment",
      deploymentId: "runtime-sales-20260804-writer-fence-integration",
      jobs: ["sales.auto-sync", "sales.sync-intraday"],
      components: {
        runtime: {
          workerName: "middleware-runtime-fleet-sales",
          versionId: "11111111-1111-4111-8111-111111111111",
          configSha256: sha256("runtime-worker-config"),
        },
        executor: {
          workerName: "middleware-runtime-executor-fleet-sales",
          versionId: "22222222-2222-4222-8222-222222222222",
          configSha256: sha256("executor-worker-config"),
        },
        writerFence: {
          workerName: "middleware-runtime-writer-fence-fleet",
          versionId: "33333333-3333-4333-8333-333333333333",
          configSha256: sha256("writer-fence-worker-config"),
        },
      },
    });
    const targetCorrectedShadowSha256 = sha256("target-corrected-shadow-semantic");
    const finalTargetRaw = writePrivateJson(directory, "final-target-raw.json", {
      schemaVersion: 2,
      kind: "target-raw-corrected",
      connectionId: CONNECTION_ID,
      target: "piyvadlzagtracciquap",
      window: { fromBusinessDay: "2026-07-05", throughBusinessDay: "2026-08-03" },
      capturedAt: "2026-08-04T14:08:10.000Z",
      marker: [{
        id: CONNECTION_ID,
        provider: "agora",
        enabled: false,
        catalog_sync_enabled: false,
        write_mode: "NONE",
        last_business_day_synced: "2026-08-03",
        last_sync_at: "2026-08-04T13:40:25.722Z",
        updated_at: "2026-08-04T13:40:25.722Z",
        provider_config: {},
      }],
      tables: {
        sales_events: Array.from({ length: 133 }, (_, index) => ({
          id: `event-${index}`,
          connection_id: CONNECTION_ID,
          business_day: index === 132 ? "2026-08-03" : "2026-07-05",
        })),
        sales_line_items: Array.from({ length: 1406 }, (_, index) => ({
          id: `line-${index}`,
          connection_id: CONNECTION_ID,
        })),
        stock_sync_log: Array.from({ length: 47 }, (_, index) => ({
          id: `receipt-${index}`,
          connection_id: CONNECTION_ID,
        })),
        product_mappings: Array.from({ length: 247 }, (_, index) => ({
          id: `mapping-${index}`,
          connection_id: CONNECTION_ID,
        })),
      },
    });
    const adoptionBase = {
      version: 3,
      kind: "AGORA_SHADOW_RECONCILIATION_EVIDENCE",
      schemaVersion: "agora-shadow-v2",
      connectionId: CONNECTION_ID,
      exportManifestSha256: sha256("source-export-manifest"),
      reconciliationManifestSha256: sha256("source-reconciliation-manifest"),
      reconciliationReportSha256: sha256("source-reconciliation-report"),
      sourceDatasetSha256: sha256("source-dataset"),
      targetDatasetSha256: sha256("target-dataset"),
      reconciliationStatus: "RECONCILED_EXACT",
      watermarks: {
        salesEvents: 133,
        salesLineItems: 1406,
        maxBusinessDay: "2026-08-03",
        lastBusinessDaySynced: "2026-08-03",
        lastSyncAt: "2026-08-04T13:40:25.722Z",
      },
    };
    const adoption = {
      ...adoptionBase,
      bindingSha256: sha256([
      "winerim-runtime-adopt-existing",
      "3",
      adoptionBase.kind,
      adoptionBase.schemaVersion,
      adoptionBase.connectionId,
      adoptionBase.exportManifestSha256,
      adoptionBase.reconciliationManifestSha256,
      adoptionBase.reconciliationReportSha256,
      adoptionBase.sourceDatasetSha256,
      adoptionBase.targetDatasetSha256,
      String(adoptionBase.watermarks.salesEvents),
      String(adoptionBase.watermarks.salesLineItems),
      adoptionBase.watermarks.maxBusinessDay,
      adoptionBase.watermarks.lastBusinessDaySynced,
      adoptionBase.watermarks.lastSyncAt,
      ].join("|")),
    };
    const keyVersion = "fleet-v1-20260804";
    const agoraAttestation = "a".repeat(64);
    const winerimAttestation = "b".repeat(64);
    const credentialSetSha256 = sha256([
      "winerim-runtime-credential-set",
      "1",
      CONNECTION_ID,
      RUN_ID,
      keyVersion,
      agoraAttestation,
      winerimAttestation,
    ].join("|"));
    const credential = writePrivateJson(directory, "credentials.json", {
      version: 3,
      connectionId: CONNECTION_ID,
      runId: RUN_ID,
      keyVersion,
      mode: "adopt-existing",
      active: false,
      sqlSha256: sha256("credential-provisioning-sql"),
      credentialAttestations: { agora: agoraAttestation, winerim: winerimAttestation },
      credentialSetSha256,
      adoption,
      scopeGenerationMode: "bootstrap",
      activationAllowed: false,
      activationBlockReason: "ADOPT_EXISTING_ACTIVATION_REQUIRES_SEPARATE_REVIEWED_GATE",
    });
    const disabledMarker = {
      id: CONNECTION_ID,
      provider: "agora",
      enabled: false,
      catalog_sync_enabled: false,
      scheduler: {
        intraday_sales_sync_enabled: false,
        open_tickets_stock_sync_enabled: false,
        open_tickets_sync_enabled: false,
      },
    };
    const finalDeltaDocument = {
      schemaVersion: 2,
      kind: "fenced-connection-final-delta",
      connectionId: CONNECTION_ID,
      sourceSha256: sha256("fenced-source-raw"),
      targetRawSha256: sha256("target-before-final-delta"),
      targetCorrectedShadowSha256,
      expected: {
        before: { events: 129, lines: 1360, receipts: 43, mappings: 247 },
        after: { events: 133, lines: 1406, receipts: 47, mappings: 247 },
        businessDayChanges: 0,
      },
      delta: { events: 4, lines: 46, receipts: 4, mappings: 0 },
      sourceFence: {
        minimumDrainMs: 130_000,
        expectedControlState: true,
        markerBefore: [disabledMarker],
        markerAfter: [disabledMarker],
        stable: true,
      },
      cursor: {
        before: { day: "2026-08-03", sync: "2026-08-04T11:25:12.711Z" },
        after: { day: "2026-08-03", sync: "2026-08-04T13:40:25.722Z" },
      },
      applySha256: sha256("final-delta-apply"),
      rollbackSha256: sha256("final-delta-rollback"),
      readbackSha256: sha256("final-delta-readback"),
      remoteWrites: 0,
    };
    const delta = writePrivateJson(directory, "final-delta.json", finalDeltaDocument);
    const reconciliation = writePrivateJson(directory, "final-reconciliation.json", {
      version: 1,
      kind: "RUNTIME_FLEET_FINAL_RECONCILIATION",
      connectionId: CONNECTION_ID,
      result: "RECONCILED_EXACT",
      differences: 0,
      finalDeltaManifestSha256: delta.sha256,
      sourceRawSha256: finalDeltaDocument.sourceSha256,
      targetRawSha256: finalTargetRaw.sha256,
      counts: finalDeltaDocument.expected.after,
      cursor: { day: "2026-08-03", sync: "2026-08-04T13:40:25.722Z" },
    });
    const sourcePassSha256 = sha256("stable-source-pass");
    const internalFenceDocument = {
      schemaVersion: 1,
      kind: "lovable-writer-fence-applied-evidence",
      connectionId: CONNECTION_ID,
      readback: {
        connectionId: CONNECTION_ID,
        provider: "agora",
        enabled: false,
        catalogSyncEnabled: false,
        scheduler: {
          intradaySalesSyncEnabled: false,
          openTicketsStockSyncEnabled: false,
          openTicketsSyncEnabled: false,
        },
        expectedControlState: true,
        fencedAt: "2026-08-04T14:00:00.000Z",
        verifiedAt: "2026-08-04T14:08:00.000Z",
      },
      readbackSemanticSha256: sha256("internal-readback"),
      preparedFenceManifestSha256: sha256("prepared-fence"),
      applySqlSha256: sha256("fence-apply"),
      rollbackSqlSha256: sha256("fence-rollback"),
      drain: { minimumMs: 130_000, capture1At: "2026-08-04T14:02:10.000Z", satisfied: true },
      sourcePasses: {
        count: 2,
        semanticSha256: [sourcePassSha256, sourcePassSha256],
        identical: true,
        stableMarkers: true,
        counts: [finalDeltaDocument.expected.after, finalDeltaDocument.expected.after],
      },
      correctedDelta: {
        manifestSha256: delta.sha256,
        applySha256: finalDeltaDocument.applySha256,
        rollbackSha256: finalDeltaDocument.rollbackSha256,
        expected: finalDeltaDocument.expected,
        delta: finalDeltaDocument.delta,
        disposablePostgres17ApplyRollback: "PASS",
      },
      targetBackup: {
        manifestSha256: sha256("target-backup"),
        publicTables: 31,
        encryptedAtRest: true,
      },
      status: "FENCED_DRAINED_STABLE_DELTA_TESTED_OWN_WRITER_INACTIVE",
    };
    const internalFence = writePrivateJson(directory, "internal-fence.json", internalFenceDocument);
    const externalFence = writeEvidence(directory);
    const proof = writePrivate(directory, "writer-fence-proof.txt", PROOF);
    const grantOutput = join(directory, "generated-writer-fence-grant.json");
    const generated = prepareWriterFenceGrant({
      environment: grantEnvironment(directory, {}, {
        evidence: externalFence,
        adoptionBindingSha256: adoption.bindingSha256,
        deploymentManifestSha256: deployment.sha256,
        finalTargetRawSha256: finalTargetRaw.sha256,
        internalFenceEvidenceSha256: internalFence.sha256,
        internalSourcePassSha256: sourcePassSha256,
      }),
      output: grantOutput,
    });
    const grantSource = readFileSync(grantOutput);
    const input = {
      version: 3,
      kind: "RUNTIME_FLEET_CONNECTION_ADOPT_EXISTING_ACTIVATION",
      connectionId: CONNECTION_ID,
      runId: RUN_ID,
      keyVersion,
      approvedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      deactivationStaleLeaseCutoffSeconds: 900,
      providerConfig: PROVIDER_CONFIG,
      providerConfigSnapshot: {},
      deploymentManifest: { path: deployment.path, sha256: deployment.sha256 },
      finalTargetRaw: { path: finalTargetRaw.path, sha256: finalTargetRaw.sha256 },
      credentialProvisioningManifest: { path: credential.path, sha256: credential.sha256 },
      finalDeltaManifest: { path: delta.path, sha256: delta.sha256 },
      finalReconciliationManifest: { path: reconciliation.path, sha256: reconciliation.sha256 },
      writerFenceEvidence: { path: internalFence.path, sha256: internalFence.sha256 },
      externalWriterFenceEvidence: {
        path: externalFence.evidencePath,
        sha256: externalFence.evidenceSha256,
      },
      externalWriterFencePublicKey: {
        path: externalFence.publicKeyPath,
        sha256: externalFence.publicKeySha256,
      },
      writerFenceGrant: { path: grantOutput, sha256: generated.grantSha256 },
      writerFenceProof: { path: proof.path, sha256: proof.sha256 },
    };

    expect(validateFleetConnectionAdoptExistingActivationInput({
      input,
      deploymentManifestSource: deployment.source,
      finalTargetRawSource: finalTargetRaw.source,
      credentialProvisioningManifestSource: credential.source,
      finalDeltaManifestSource: delta.source,
      finalReconciliationManifestSource: reconciliation.source,
      writerFenceEvidenceSource: internalFence.source,
      externalWriterFenceEvidenceSource: externalFence.evidenceSource,
      externalWriterFencePublicKeySource: externalFence.publicKeySource,
      writerFenceGrantSource: grantSource,
      writerFenceProofSource: proof.source,
    })).toMatchObject({
      connectionId: CONNECTION_ID,
      finalTargetRawSha256: finalTargetRaw.sha256,
      finalTargetRaw: {
        schemaVersion: 2,
        kind: "target-raw-corrected",
        fileSha256: finalTargetRaw.sha256,
        targetCorrectedShadowSha256,
      },
      runtimePolicySha256: generated.grant.activationScope.runtimePolicySha256,
      writerFenceGrant: {
        activationScopeBindingSha256: generated.grant.activationScope.bindingSha256,
      },
    });
    expect(finalTargetRaw.sha256).not.toBe(targetCorrectedShadowSha256);
  });

  it.each([
    ["extra job", { CANARY_RUNTIME_JOBS: JSON.stringify([
      "sales.auto-sync",
      "sales.sync-intraday",
      "sales.sync-open-tickets",
    ]) }, "WRITER_FENCE_GRANT_ADOPT_EXISTING_SALES_JOBS_REQUIRED"],
    ["wrong lane", { CANARY_RUNTIME_LANE: "catalog" }, "WRITER_FENCE_GRANT_ADOPT_EXISTING_SALES_LANE_REQUIRED"],
    ["open tickets enabled", { CANARY_RUNTIME_OPEN_TICKETS_ENABLED: "true" }, "WRITER_FENCE_GRANT_ADOPT_EXISTING_NON_SALES_FEATURE_MUST_BE_DISABLED"],
    ["active connection", { CANARY_ADOPT_EXISTING_ACTIVE_CONNECTION_COUNT: "1" }, "WRITER_FENCE_GRANT_ADOPT_EXISTING_ACTIVE_STATE_MUST_BE_ZERO"],
    ["negative prior runs", { CANARY_ADOPT_EXISTING_PRIOR_RUN_COUNT: "-1" }, "WRITER_FENCE_GRANT_ADOPT_EXISTING_PRIOR_RUN_COUNT_INVALID"],
  ])("fails closed for %s", (_label, overrides, expectedError) => {
    const directory = temporaryDirectory("writer-fence-adopt-existing-scope");
    expect(() => prepareWriterFenceGrant({
      environment: { ...grantEnvironment(directory), ...overrides },
      output: join(directory, "must-not-exist.json"),
    })).toThrow(expectedError);
  });

  it.each([
    ["one readback", { readbackTimes: ["2026-08-04T14:08:00.000Z"] }, undefined, "WRITER_FENCE_GRANT_EXTERNAL_NO_ROTATION_REQUIRES_TWO_READBACKS"],
    ["credential retained", { removedFromLovable: false }, undefined, "WRITER_FENCE_GRANT_EXTERNAL_NO_ROTATION_REQUIRES_TWO_READBACKS"],
    ["credential available", { credentialUnavailable: false }, undefined, "WRITER_FENCE_GRANT_EXTERNAL_READBACK_NOT_HEALTHY_AFTER_DRAIN"],
    ["invalid signature", { invalidSignature: true }, undefined, "WRITER_FENCE_GRANT_EXTERNAL_EVIDENCE_SIGNATURE_INVALID"],
    ["invalid activation-envelope hash", { invalidEnvelopeHash: true }, undefined, "WRITER_FENCE_GRANT_EXTERNAL_EVIDENCE_ACTIVATION_ENVELOPE_INVALID"],
    ["invalid timestamp", { observedAt: "not-a-timestamp", readbackTimes: ["2026-08-04T14:02:10.000Z", "not-a-timestamp"] }, undefined, "WRITER_FENCE_GRANT_INVALID_EXTERNAL_EVIDENCE_OBSERVED_AT"],
    ["stale evidence", {}, { CANARY_FENCE_ISSUED_AT: "2026-08-04T14:30:00.000Z", CANARY_FENCE_EXPIRES_AT: "2026-08-04T15:30:00.000Z" }, "WRITER_FENCE_GRANT_BOOTSTRAP_EVIDENCE_MUST_BE_FRESH"],
    ["rotated credential mode", { fenceMode: "agora-credential-rotated" }, undefined, "WRITER_FENCE_GRANT_ADOPT_EXISTING_REQUIRES_NO_ROTATION_EVIDENCE"],
  ])("rejects %s evidence", (_label, evidenceOptions, environmentOverrides, expectedError) => {
    const directory = temporaryDirectory("writer-fence-adopt-existing-evidence");
    expect(() => prepareWriterFenceGrant({
      environment: {
        ...grantEnvironment(directory, evidenceOptions as EvidenceOptions),
        ...(environmentOverrides ?? {}),
      },
      output: join(directory, "must-not-exist.json"),
    })).toThrow(expectedError);
  });

  it("rejects an evidence artifact hash mismatch", () => {
    const directory = temporaryDirectory("writer-fence-adopt-existing-hash");
    expect(() => prepareWriterFenceGrant({
      environment: {
        ...grantEnvironment(directory),
        NO_LEGACY_WRITER_EXTERNAL_EVIDENCE_SHA256: "f".repeat(64),
      },
      output: join(directory, "must-not-exist.json"),
    })).toThrow("WRITER_FENCE_GRANT_EXTERNAL_EVIDENCE_SHA256_MISMATCH");
  });

  it("rejects activation bindings and internal/external fence time drift", () => {
    const invalidBindingDirectory = temporaryDirectory("writer-fence-invalid-activation-binding");
    expect(() => prepareWriterFenceGrant({
      environment: {
        ...grantEnvironment(invalidBindingDirectory),
        CANARY_ADOPTION_BINDING_SHA256: "not-a-sha256",
      },
      output: join(invalidBindingDirectory, "must-not-exist.json"),
    })).toThrow("WRITER_FENCE_GRANT_INVALID_CANARY_ADOPTION_BINDING_SHA256");

    const timeDriftDirectory = temporaryDirectory("writer-fence-time-drift");
    expect(() => prepareWriterFenceGrant({
      environment: {
        ...grantEnvironment(timeDriftDirectory),
        CANARY_WRITER_FENCE_VERIFIED_AT: "2026-08-04T14:07:59.000Z",
      },
      output: join(timeDriftDirectory, "must-not-exist.json"),
    })).toThrow("WRITER_FENCE_GRANT_ADOPT_EXISTING_EVIDENCE_TIME_MISMATCH");
  });

  it("keeps the existing legacy writer-revoked grant compatible", () => {
    const directory = temporaryDirectory("writer-fence-legacy-compatible");
    const result = prepareWriterFenceGrant({
      environment: {
        CANARY_CONNECTION_ID: CONNECTION_ID,
        CANARY_RUN_ID: RUN_ID,
        CANARY_HOLDER_ID: "vinatea-release-b",
        CANARY_WRITER_FENCE_PROOF: PROOF,
        CANARY_FENCE_ISSUED_AT: ISSUED_AT,
        CANARY_FENCE_EXPIRES_AT: EXPIRES_AT,
        WRITER_FENCE_MODE: "legacy-writer-revoked",
        CANARY_EXCLUSIVE_CREDENTIAL_REF: `runtime-vault://postgres/${CONNECTION_ID}/agora/winerim`,
        CANARY_EXCLUSIVE_CREDENTIAL_VERSION: "b".repeat(64),
        LEGACY_WRITER_REVOKED_AT: "2026-08-04T14:00:00.000Z",
        LEGACY_WRITER_NEGATIVE_PROBE_STATUS: "401",
        LEGACY_WRITER_EVIDENCE_SHA256: "c".repeat(64),
      },
      output: join(directory, "legacy-writer-fence-grant.json"),
    });
    expect(result.grant).toMatchObject({
      version: 1,
      legacyWriter: {
        revokedAt: "2026-08-04T14:00:00.000Z",
        negativeProbeStatus: 401,
        evidenceSha256: "c".repeat(64),
      },
    });
    expect(result.grant).not.toHaveProperty("runtimeScope");
    expect(result.grant).not.toHaveProperty("writerHistory");
  });
});

describe("adopt-existing full-lanes writer-fence grant", () => {
  it("binds the exact five-job full-lanes policy into the signed activation scope", () => {
    const directory = temporaryDirectory("writer-fence-adopt-full-lanes");
    const output = join(directory, "writer-fence-grant.json");
    const result = prepareWriterFenceGrant({
      environment: fullLanesGrantEnvironment(directory),
      output,
    });

    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(result.grant).toMatchObject({
      version: 3,
      grantType: "adopt-existing-sales",
      writerHistory: { mode: "adopt-existing-sales" },
      activationScope: {
        version: 1,
        kind: "adopt-existing-sales",
        runtimePolicyProfile: "full-lanes-v1",
        runtimeJobAllowlist: FULL_LANES_JOBS,
        runtimePolicySha256: createHash("sha256")
          .update(canonicalJson(FULL_LANES_PROVIDER_CONFIG))
          .digest("hex"),
      },
    });
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(result.grant);
  });

  it.each([
    ["missing job", {
      CANARY_RUNTIME_JOBS: JSON.stringify(FULL_LANES_JOBS.slice(0, -1)),
    }, "WRITER_FENCE_GRANT_ADOPT_EXISTING_FULL_LANES_JOBS_REQUIRED"],
    ["reordered jobs", {
      CANARY_RUNTIME_JOBS: JSON.stringify([
        "sales.auto-sync",
        "sales.sync-intraday",
        "catalog.sync-master",
        "catalog.fetch-winerim",
        "outbound.process",
      ]),
    }, "WRITER_FENCE_GRANT_ADOPT_EXISTING_FULL_LANES_JOBS_REQUIRED"],
    ["wrong lane", {
      CANARY_RUNTIME_LANE: "sales",
    }, "WRITER_FENCE_GRANT_ADOPT_EXISTING_FULL_LANES_LANE_REQUIRED"],
    ["catalog closed", {
      CANARY_RUNTIME_CATALOG_ENABLED: "false",
    }, "WRITER_FENCE_GRANT_ADOPT_EXISTING_FULL_LANES_FEATURES_REQUIRED"],
    ["stock closed", {
      CANARY_RUNTIME_STOCK_ENABLED: "false",
    }, "WRITER_FENCE_GRANT_ADOPT_EXISTING_FULL_LANES_FEATURES_REQUIRED"],
    ["outbound closed", {
      CANARY_RUNTIME_OUTBOUND_ENABLED: "false",
    }, "WRITER_FENCE_GRANT_ADOPT_EXISTING_FULL_LANES_FEATURES_REQUIRED"],
    ["open tickets opened", {
      CANARY_RUNTIME_OPEN_TICKETS_ENABLED: "true",
    }, "WRITER_FENCE_GRANT_ADOPT_EXISTING_FULL_LANES_FEATURES_REQUIRED"],
    ["maintenance opened", {
      CANARY_RUNTIME_MAINTENANCE_ENABLED: "true",
    }, "WRITER_FENCE_GRANT_ADOPT_EXISTING_FULL_LANES_FEATURES_REQUIRED"],
  ])("rejects %s fail-closed", (_label, overrides, expectedError) => {
    const directory = temporaryDirectory("writer-fence-adopt-full-lanes-drift");
    expect(() => prepareWriterFenceGrant({
      environment: fullLanesGrantEnvironment(directory, overrides),
      output: join(directory, "writer-fence-grant.json"),
    })).toThrow(expectedError);
  });
});
