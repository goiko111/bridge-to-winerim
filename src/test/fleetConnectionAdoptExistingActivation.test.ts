import {
  createHash,
  createHmac,
  generateKeyPairSync,
} from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import { buildExternalWriterFenceEvidence } from "../../infrastructure/runtime/prepare-external-writer-fence-evidence.mjs";
// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import { validateExternalBootstrapWriterFenceEvidence } from "../../infrastructure/runtime/prepare-writer-fence-grant.mjs";
// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import {
  buildFleetConnectionAdoptExistingActivationManifest,
  fleetConnectionAdoptExistingActivationPlan,
  prepareFleetConnectionAdoptExistingActivation,
  renderFleetConnectionAdoptExistingActivationSql,
  renderFleetConnectionAdoptExistingDeactivationSql,
  validateFleetConnectionAdoptExistingActivationInput,
} from "../../infrastructure/runtime/prepare-fleet-connection-activation.mjs";

const CONNECTION_ID = "e465872a-bff5-43de-8e4c-fe4986f0fd4f";
const LOVABLE_PROJECT_ID = "a61b5b89-4c36-44fc-aaf2-9c7c3f3cfd8d";
const RUN_ID = "vinatea-cutover-b";
const KEY_VERSION = "fleet-v2-20260804";
const APPROVED_AT = "2026-08-04T14:20:00.000Z";
const EXPIRES_AT = "2026-08-04T16:20:00.000Z";
const AGORA_ATTESTATION = sha256("real-agora-credential-attestation");
const WINERIM_ATTESTATION = sha256("real-winerim-credential-attestation");
const PROVIDER_CONFIG = {
  runtime_sales_job_allowlist: ["sales.auto-sync", "sales.sync-intraday"],
  intraday_sales_sync_enabled: true,
  open_tickets_sync_enabled: false,
  open_tickets_stock_sync_enabled: false,
};
const PROVIDER_CONFIG_SNAPSHOT = {
  catalog_policy: { source: "pre-activation" },
  runtime_sales_job_allowlist: ["legacy.sales-job"],
  intraday_sales_sync_enabled: false,
  open_tickets_sync_enabled: true,
  open_tickets_stock_sync_enabled: false,
};

type AdoptionFixture = {
  version: number;
  kind: string;
  schemaVersion: string;
  connectionId: string;
  exportManifestSha256: string;
  reconciliationManifestSha256: string;
  reconciliationReportSha256: string;
  sourceDatasetSha256: string;
  targetDatasetSha256: string;
  reconciliationStatus: string;
  watermarks: {
    salesEvents: number;
    salesLineItems: number;
    maxBusinessDay: string;
    lastBusinessDaySynced: string;
    lastSyncAt: string;
  };
  bindingSha256?: string;
};

type FinalDeltaManifestFixture = {
  sourceSha256: string;
  expected: {
    after: { events: number; lines: number; receipts: number; mappings: number };
  };
};

type CredentialBundleFixture = Record<"agora" | "winerim", {
  kind: string;
  reference: string;
  version: string;
  attestationSha256: string;
  binding: string;
}>;

function sha256(source: Buffer | string) {
  return createHash("sha256").update(source).digest("hex");
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

function adoptionBinding(adoption: AdoptionFixture) {
  return sha256([
    "winerim-runtime-adopt-existing",
    "3",
    adoption.kind,
    adoption.schemaVersion,
    adoption.connectionId,
    adoption.exportManifestSha256,
    adoption.reconciliationManifestSha256,
    adoption.reconciliationReportSha256,
    adoption.sourceDatasetSha256,
    adoption.targetDatasetSha256,
    String(adoption.watermarks.salesEvents),
    String(adoption.watermarks.salesLineItems),
    adoption.watermarks.maxBusinessDay,
    adoption.watermarks.lastBusinessDaySynced,
    adoption.watermarks.lastSyncAt,
  ].join("|"));
}

function credentialSetSha256() {
  return sha256([
    "winerim-runtime-credential-set",
    "1",
    CONNECTION_ID,
    RUN_ID,
    KEY_VERSION,
    AGORA_ATTESTATION,
    WINERIM_ATTESTATION,
  ].join("|"));
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

function fixture({
  maxBusinessDay = "2026-08-04",
  lastBusinessDaySynced = "2026-08-03",
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "fleet-adopt-activation-"));
  chmodSync(directory, 0o700);

  const deployment = writePrivateJson(directory, "deployment.manifest.json", {
    version: 1,
    kind: "runtime-sales-deployment",
    deploymentId: "runtime-sales-20260804-a",
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
    window: { fromBusinessDay: "2026-07-05", throughBusinessDay: maxBusinessDay },
    capturedAt: "2026-08-04T14:19:10.694Z",
    marker: [{
      id: CONNECTION_ID,
      provider: "agora",
      enabled: false,
      catalog_sync_enabled: false,
      write_mode: "NONE",
      last_business_day_synced: lastBusinessDaySynced,
      last_sync_at: "2026-08-04T13:40:25.722Z",
      updated_at: "2026-08-04T13:40:25.722Z",
      provider_config: JSON.parse(JSON.stringify(PROVIDER_CONFIG_SNAPSHOT)),
    }],
    tables: {
      sales_events: Array.from({ length: 133 }, (_, index) => ({
        id: `event-${index}`,
        connection_id: CONNECTION_ID,
        business_day: index === 132 ? maxBusinessDay : "2026-07-05",
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
  const adoption: AdoptionFixture = {
    version: 3,
    kind: "AGORA_SHADOW_RECONCILIATION_EVIDENCE",
    schemaVersion: "agora-shadow-v2",
    connectionId: CONNECTION_ID,
    exportManifestSha256: sha256("source-export-manifest"),
    reconciliationManifestSha256: sha256("source-reconciliation-manifest"),
    reconciliationReportSha256: sha256("source-reconciliation-report"),
    sourceDatasetSha256: sha256("source-dataset"),
    targetDatasetSha256: sha256("adoption-target-dataset-before-final-delta"),
    reconciliationStatus: "RECONCILED_EXACT",
    watermarks: {
      salesEvents: 133,
      salesLineItems: 1406,
      maxBusinessDay,
      lastBusinessDaySynced,
      lastSyncAt: "2026-08-04T13:40:25.722Z",
    },
  };
  adoption.bindingSha256 = adoptionBinding(adoption);
  const credentialManifest = {
    version: 3,
    connectionId: CONNECTION_ID,
    runId: RUN_ID,
    keyVersion: KEY_VERSION,
    mode: "adopt-existing",
    active: false,
    sqlSha256: sha256("credential-provisioning-sql"),
    credentialAttestations: { agora: AGORA_ATTESTATION, winerim: WINERIM_ATTESTATION },
    credentialSetSha256: credentialSetSha256(),
    adoption,
    scopeGenerationMode: "bootstrap",
    activationAllowed: false,
    activationBlockReason: "ADOPT_EXISTING_ACTIVATION_REQUIRES_SEPARATE_REVIEWED_GATE",
  };
  const credential = writePrivateJson(directory, "credentials.manifest.json", credentialManifest);

  const finalDeltaManifest = {
    schemaVersion: 2,
    kind: "fenced-connection-final-delta",
    connectionId: CONNECTION_ID,
    generatedAt: "2026-08-04T14:12:49.159Z",
    sourceSha256: sha256("fenced-source-raw"),
    targetRawSha256: sha256("target-before-final-delta"),
    targetCorrectedShadowSha256,
    window: { fromBusinessDay: "2026-07-05", throughBusinessDay: "2026-08-04" },
    expected: {
      before: { events: 129, lines: 1360, receipts: 43, mappings: 247 },
      after: { events: 133, lines: 1406, receipts: 47, mappings: 247 },
      businessDayChanges: 0,
    },
    delta: { events: 4, lines: 46, receipts: 4, mappings: 0 },
    sourceFence: {
      minimumDrainMs: 130000,
      expectedControlState: true,
      markerBefore: [disabledMarker()],
      markerAfter: [disabledMarker()],
      stable: true,
    },
    cursor: {
      before: { day: "2026-08-03", sync: "2026-08-04T11:25:12.711Z" },
      after: { day: lastBusinessDaySynced, sync: "2026-08-04T13:40:25.722+00:00" },
    },
    eventIds: Array.from({ length: 4 }, (_, index) => `event-${index}`),
    lineIds: Array.from({ length: 46 }, (_, index) => `line-${index}`),
    receiptIds: Array.from({ length: 4 }, (_, index) => `receipt-${index}`),
    applySha256: sha256("final-delta-apply-sql"),
    rollbackSha256: sha256("final-delta-rollback-sql"),
    readbackSha256: sha256("final-delta-readback"),
    remoteWrites: 0,
  };
  const delta = writePrivateJson(directory, "final-delta.manifest.json", finalDeltaManifest);
  const reconciliationManifest = {
    version: 1,
    kind: "RUNTIME_FLEET_FINAL_RECONCILIATION",
    connectionId: CONNECTION_ID,
    result: "RECONCILED_EXACT",
    differences: 0,
    finalDeltaManifestSha256: delta.sha256,
    sourceRawSha256: finalDeltaManifest.sourceSha256,
    targetRawSha256: finalTargetRaw.sha256,
    counts: finalDeltaManifest.expected.after,
    cursor: { day: lastBusinessDaySynced, sync: "2026-08-04T13:40:25.722Z" },
  };
  const reconciliation = writePrivateJson(directory, "final-reconciliation.json", reconciliationManifest);
  const fenceEvidence = internalFenceEvidence(delta.sha256, finalDeltaManifest);
  const fence = writePrivateJson(directory, "writer-fence.json", fenceEvidence);

  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeySource = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }));
  const externalBuilt = buildExternalWriterFenceEvidence({
    payload: {
      evidenceType: "lovable-writer-fence",
      connectionId: CONNECTION_ID,
      source: {
        provider: "lovable-cloud",
        projectId: LOVABLE_PROJECT_ID,
        collectorRunId: "external-fence-observation-a",
      },
      fenceMode: "lovable-disabled-no-agora-rotation",
      fenceAppliedAt: "2026-08-04T14:10:00.000Z",
      observedAt: "2026-08-04T14:19:00.000Z",
      lovable: { writerDisabled: true, cronDisabled: true, edgeMutationDisabled: true },
      agoraCredential: { rotated: false, removedFromLovable: true },
      readbacks: [
        healthyReadback("2026-08-04T14:12:10.000Z"),
        healthyReadback("2026-08-04T14:19:00.000Z"),
      ],
    },
    privateKeySource,
    keyId: "lovable-fence-ed25519-20260804",
    readbacksSourceSha256: sha256("independent-readbacks-source"),
    referenceTime: APPROVED_AT,
  });
  const externalEvidence = writePrivate(directory, "external-writer-fence.json", externalBuilt.artifactSource);
  const externalPublicKey = writePrivate(directory, "external-writer-fence-public.pem", externalBuilt.publicKeySource);
  const externalBinding = {
    ...validateExternalBootstrapWriterFenceEvidence({
      artifactSource: externalEvidence.source,
      artifactSha256: externalEvidence.sha256,
      publicKeySource: externalPublicKey.source,
      publicKeySha256: externalPublicKey.sha256,
      connectionId: CONNECTION_ID,
      referenceTime: APPROVED_AT,
    }),
    removedFromLovable: true,
  };

  const proofSource = Buffer.from("fixture-proof-secret-that-is-longer-than-thirty-two-bytes");
  const proof = writePrivate(directory, "writer-fence-proof.txt", proofSource);
  const credentials = credentialBundleEntries();
  const bundlePayload = credentialBundlePayload(credentials);
  const scopePayload = activationScopePayload({
    adoptionBindingSha256: adoption.bindingSha256,
    deploymentManifestSha256: deployment.sha256,
    finalTargetRawSha256: finalTargetRaw.sha256,
    externalEvidenceSha256: externalEvidence.sha256,
    externalEvidencePayloadSha256: externalBinding.payloadSha256,
  });
  const grantDocument = {
    version: 3,
    grantType: "adopt-existing-sales",
    connectionId: CONNECTION_ID,
    runId: RUN_ID,
    holderId: "fleet-release-a",
    proofSha256: proof.sha256,
    issuedAt: APPROVED_AT,
    expiresAt: EXPIRES_AT,
    credentialBundle: {
      version: 1,
      keyVersion: KEY_VERSION,
      generationSha256: credentialSetSha256(),
      credentials,
      bundleSha256: sha256(bundlePayload),
      signatureSha256: createHmac("sha256", proofSource).update(bundlePayload).digest("hex"),
    },
    writerHistory: {
      mode: "adopt-existing-sales",
      verifiedAt: fenceEvidence.readback.verifiedAt,
      evidenceSha256: fence.sha256,
      cloudflareEvidenceSha256: fenceEvidence.sourcePasses.semanticSha256[0],
      externalEvidence: externalBinding,
    },
    activationScope: {
      version: 1,
      kind: "adopt-existing-sales",
      adoptionBindingSha256: adoption.bindingSha256,
      deploymentManifestSha256: deployment.sha256,
      finalTargetRawSha256: finalTargetRaw.sha256,
      externalEvidenceSha256: externalEvidence.sha256,
      externalEvidencePayloadSha256: externalBinding.payloadSha256,
      runtimePolicySha256: sha256(canonicalJson(PROVIDER_CONFIG)),
      bindingSha256: sha256(scopePayload),
      signatureSha256: createHmac("sha256", proofSource).update(scopePayload).digest("hex"),
    },
  };
  const grant = writePrivateJson(directory, "writer-fence-grant.json", grantDocument);
  const input = {
    version: 3,
    kind: "RUNTIME_FLEET_CONNECTION_ADOPT_EXISTING_ACTIVATION",
    connectionId: CONNECTION_ID,
    runId: RUN_ID,
    keyVersion: KEY_VERSION,
    approvedAt: APPROVED_AT,
    expiresAt: EXPIRES_AT,
    deactivationStaleLeaseCutoffSeconds: 900,
    providerConfig: JSON.parse(JSON.stringify(PROVIDER_CONFIG)),
    providerConfigSnapshot: JSON.parse(JSON.stringify(PROVIDER_CONFIG_SNAPSHOT)),
    deploymentManifest: reference(deployment),
    finalTargetRaw: reference(finalTargetRaw),
    credentialProvisioningManifest: reference(credential),
    finalDeltaManifest: reference(delta),
    finalReconciliationManifest: reference(reconciliation),
    writerFenceEvidence: reference(fence),
    externalWriterFenceEvidence: reference(externalEvidence),
    externalWriterFencePublicKey: reference(externalPublicKey),
    writerFenceGrant: reference(grant),
    writerFenceProof: reference(proof),
  };
  const inputFile = writePrivateJson(directory, "activation-input.json", input);
  return {
    input,
    inputFile,
    sources: {
      deployment: deployment.source,
      finalTargetRaw: finalTargetRaw.source,
      credential: credential.source,
      delta: delta.source,
      reconciliation: reconciliation.source,
      fence: fence.source,
      externalFence: externalEvidence.source,
      externalPublicKey: externalPublicKey.source,
      grant: grant.source,
      proof: proof.source,
    },
    documents: {
      credentialManifest,
      finalDeltaManifest,
      fenceEvidence,
      grantDocument,
      targetCorrectedShadowSha256,
    },
  };
}

function disabledMarker() {
  return {
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
}

function healthyReadback(observedAt: string) {
  return {
    observedAt,
    status: "FENCED_HEALTHY",
    writerDisabled: true,
    cronDisabled: true,
    edgeMutationDisabled: true,
    agoraCredentialUnavailableToLovable: true,
  };
}

function reference(artifact: { path: string; sha256: string }) {
  return { path: artifact.path, sha256: artifact.sha256 };
}

function credentialBundleEntries() {
  return Object.fromEntries([
    ["agora", AGORA_ATTESTATION],
    ["winerim", WINERIM_ATTESTATION],
  ].map(([kind, version]) => {
    const credentialReference = `runtime-vault://postgres/${CONNECTION_ID}/agora/${kind}`;
    return [kind, {
      kind,
      reference: credentialReference,
      version,
      attestationSha256: version,
      binding: sha256([
        "winerim-writer-fence-fleet-credential",
        "1",
        CONNECTION_ID,
        RUN_ID,
        "agora",
        kind,
        credentialReference,
        version,
      ].join("|")),
    }];
  }));
}

function credentialBundlePayload(credentials: CredentialBundleFixture) {
  return [
    "winerim-writer-fence-credential-bundle",
    "1",
    CONNECTION_ID,
    RUN_ID,
    "fleet-release-a",
    APPROVED_AT,
    EXPIRES_AT,
    KEY_VERSION,
    credentialSetSha256(),
    credentials.agora.kind,
    credentials.agora.reference,
    credentials.agora.version,
    credentials.agora.attestationSha256,
    credentials.agora.binding,
    credentials.winerim.kind,
    credentials.winerim.reference,
    credentials.winerim.version,
    credentials.winerim.attestationSha256,
    credentials.winerim.binding,
  ].join("|");
}

function activationScopePayload(values: {
  adoptionBindingSha256: string;
  deploymentManifestSha256: string;
  finalTargetRawSha256: string;
  externalEvidenceSha256: string;
  externalEvidencePayloadSha256: string;
}) {
  return [
    "winerim-writer-fence-adopt-existing-sales",
    "1",
    CONNECTION_ID,
    RUN_ID,
    "fleet-release-a",
    APPROVED_AT,
    EXPIRES_AT,
    values.adoptionBindingSha256,
    values.deploymentManifestSha256,
    values.finalTargetRawSha256,
    values.externalEvidenceSha256,
    values.externalEvidencePayloadSha256,
    sha256(canonicalJson(PROVIDER_CONFIG)),
  ].join("|");
}

function internalFenceEvidence(
  deltaSha256: string,
  finalDeltaManifest: FinalDeltaManifestFixture,
) {
  const counts = finalDeltaManifest.expected.after;
  return {
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
      fencedAt: "2026-08-04T14:10:00.000Z",
      verifiedAt: "2026-08-04T14:19:00.000Z",
      source: "authenticated read-only",
    },
    readbackSemanticSha256: sha256("internal-readback"),
    preparedFenceManifestSha256: sha256("prepared-fence-manifest"),
    applySqlSha256: sha256("fence-apply-sql"),
    rollbackSqlSha256: sha256("fence-rollback-sql"),
    drain: { minimumMs: 130000, capture1At: "2026-08-04T14:13:00.000Z", satisfied: true },
    sourcePasses: {
      count: 2,
      semanticSha256: [sha256("stable-source-pass"), sha256("stable-source-pass")],
      identical: true,
      stableMarkers: true,
      counts: [counts, counts],
    },
    correctedDelta: {
      manifestSha256: deltaSha256,
      applySha256: finalDeltaManifest.applySha256,
      rollbackSha256: finalDeltaManifest.rollbackSha256,
      expected: finalDeltaManifest.expected,
      delta: finalDeltaManifest.delta,
      disposablePostgres17ApplyRollback: "PASS",
    },
    targetBackup: {
      manifestSha256: sha256("target-backup-manifest"),
      path: "backup-before-delta",
      publicTables: 31,
      encryptedAtRest: true,
    },
    status: "FENCED_DRAINED_STABLE_DELTA_TESTED_OWN_WRITER_INACTIVE",
  };
}

function validate(testFixture: ReturnType<typeof fixture>) {
  return validateFleetConnectionAdoptExistingActivationInput({
    input: testFixture.input,
    deploymentManifestSource: testFixture.sources.deployment,
    finalTargetRawSource: testFixture.sources.finalTargetRaw,
    credentialProvisioningManifestSource: testFixture.sources.credential,
    finalDeltaManifestSource: testFixture.sources.delta,
    finalReconciliationManifestSource: testFixture.sources.reconciliation,
    writerFenceEvidenceSource: testFixture.sources.fence,
    externalWriterFenceEvidenceSource: testFixture.sources.externalFence,
    externalWriterFencePublicKeySource: testFixture.sources.externalPublicKey,
    writerFenceGrantSource: testFixture.sources.grant,
    writerFenceProofSource: testFixture.sources.proof,
  });
}

type MutableDeploymentManifest = {
  version: number;
  kind: string;
  deploymentId: string;
  jobs: string[];
  components: Record<string, {
    workerName: string;
    versionId: string;
    configSha256: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

function replaceDeploymentManifest(
  testFixture: ReturnType<typeof fixture>,
  mutate: (manifest: MutableDeploymentManifest) => void,
) {
  const manifest = JSON.parse(
    testFixture.sources.deployment.toString("utf8"),
  ) as MutableDeploymentManifest;
  mutate(manifest);
  testFixture.sources.deployment = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  testFixture.input.deploymentManifest.sha256 = sha256(testFixture.sources.deployment);
}

describe("fleet adopt-existing-sales connection activation gate", () => {
  it("accepts real Ed25519 evidence and renders the exact sales-only activation", () => {
    const data = fixture();
    const validated = validate(data);
    const manifest = buildFleetConnectionAdoptExistingActivationManifest(validated);
    const localReviewManifestSha256 = sha256(`${JSON.stringify(manifest, null, 2)}\n`);
    const activationSql = renderFleetConnectionAdoptExistingActivationSql({
      activation: validated,
      activationManifestSha256: localReviewManifestSha256,
    });
    const deactivationSql = renderFleetConnectionAdoptExistingDeactivationSql({
      activation: validated,
      activationManifestSha256: localReviewManifestSha256,
    });

    expect(validated).toMatchObject({
      connectionId: CONNECTION_ID,
      deploymentManifestSha256: data.input.deploymentManifest.sha256,
      deploymentManifest: {
        version: 1,
        kind: "runtime-sales-deployment",
        deploymentId: "runtime-sales-20260804-a",
        jobs: ["sales.auto-sync", "sales.sync-intraday"],
        components: {
          runtime: { versionId: "11111111-1111-4111-8111-111111111111" },
          executor: { versionId: "22222222-2222-4222-8222-222222222222" },
          writerFence: { versionId: "33333333-3333-4333-8333-333333333333" },
        },
      },
      finalTargetRawSha256: data.input.finalTargetRaw.sha256,
      finalTargetRaw: {
        contract: "fenced-target-raw-v1",
        kind: "target-raw-corrected",
        maxBusinessDay: "2026-08-04",
        cursorDay: "2026-08-03",
        fileSha256: data.input.finalTargetRaw.sha256,
        targetCorrectedShadowSha256: data.documents.targetCorrectedShadowSha256,
        adoptionTargetDatasetSha256: data.documents.credentialManifest.adoption.targetDatasetSha256,
        semanticLineage: "FINAL_DELTA_CORRECTED_SUCCESSOR",
      },
      providerConfig: PROVIDER_CONFIG,
      providerConfigSnapshot: PROVIDER_CONFIG_SNAPSHOT,
      providerConfigSnapshotSha256: sha256(canonicalJson(PROVIDER_CONFIG_SNAPSHOT)),
      externalWriterFence: { removedFromLovable: true, readbackObservedAt: expect.any(Array) },
      writerFenceGrant: { activationScopeBindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(validated.externalWriterFence.readbackObservedAt).toHaveLength(2);
    expect(data.documents.targetCorrectedShadowSha256).not.toBe(data.input.finalTargetRaw.sha256);
    expect(activationSql).toContain(`deployment_manifest_sha256 = '${data.input.deploymentManifest.sha256}'`);
    expect(activationSql).not.toContain(`deployment_manifest_sha256 = '${localReviewManifestSha256}'`);
    expect(activationSql).toContain('"runtime_sales_job_allowlist":["sales.auto-sync","sales.sync-intraday"]');
    expect(activationSql).toContain(`COALESCE(provider_config, '{}'::jsonb) = '${canonicalJson(PROVIDER_CONFIG_SNAPSHOT)}'::jsonb`);
    expect(deactivationSql).toContain("-- Phase 1: persistently quiesce new runtime intake");
    expect(deactivationSql).toContain("-- Phase 2: retire only after every runtime lease is terminal");
    expect(deactivationSql).toContain("SET status = 'TERMINAL'");
    expect(deactivationSql).toContain("staleLeaseCutoffSeconds', 900");
    expect(deactivationSql).toContain("updated_at <= statement_timestamp() - interval '900 seconds'");
    expect(deactivationSql).toContain("runtime leases remain after quiesce; rerun retirement after they drain");
    expect(deactivationSql).toContain(`provider_config = '${canonicalJson(PROVIDER_CONFIG_SNAPSHOT)}'::jsonb`);
    expect(deactivationSql.indexOf("SET enabled = false")).toBeLessThan(
      deactivationSql.indexOf("runtime leases remain after quiesce"),
    );
    expect(deactivationSql.indexOf("COMMIT;")).toBeLessThan(
      deactivationSql.indexOf("-- Phase 2: retire only after every runtime lease is terminal"),
    );
    expect(deactivationSql.indexOf("runtime leases remain after quiesce")).toBeLessThan(
      deactivationSql.indexOf("UPDATE public.runtime_connection_credentials"),
    );
  });

  it("reads every bound artifact and writes one private atomic package", () => {
    const data = fixture();
    const outputDir = join(mkdtempSync(join(tmpdir(), "fleet-adopt-output-")), "package");
    const result = prepareFleetConnectionAdoptExistingActivation({
      inputPath: data.inputFile.path,
      outputDir,
    });
    expect(result).toMatchObject({
      status: "RUNTIME_FLEET_ADOPT_EXISTING_ACTIVATION_PACKAGE_READY",
      remoteMutations: 0,
      connectionId: CONNECTION_ID,
    });
    expect(statSync(outputDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(outputDir).sort()).toEqual([
      "fleet-connection-adopt-existing.activation.sql",
      "fleet-connection-adopt-existing.deactivation.sql",
      "fleet-connection-adopt-existing.manifest.json",
    ]);
    for (const path of [result.activationSqlPath, result.deactivationSqlPath, result.manifestPath]) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const packageManifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    expect(packageManifest.deploymentManifestSha256).toBe(data.input.deploymentManifest.sha256);
    expect(packageManifest.providerConfigSnapshot).toEqual(PROVIDER_CONFIG_SNAPSHOT);
    expect(packageManifest.providerConfigSnapshotSha256).toBe(
      sha256(canonicalJson(PROVIDER_CONFIG_SNAPSHOT)),
    );
    expect(packageManifest.rollbackMode).toBe(
      "two-phase-quiesce-then-append-only-retirement",
    );
    expect(packageManifest.rollbackPhases).toEqual([
      "quiesce-intake",
      "drain-leases-and-retire",
    ]);
    expect(packageManifest.finalTargetRawSha256).toBe(data.input.finalTargetRaw.sha256);
    expect(packageManifest.finalTargetRaw.targetCorrectedShadowSha256).toBe(
      data.documents.targetCorrectedShadowSha256,
    );
  });

  it("accepts a same-day or one-day intraday cursor and rejects larger lag", () => {
    expect(validate(fixture()).adoption.watermarks.cursorLagDays).toBe(1);
    expect(validate(fixture({ lastBusinessDaySynced: "2026-08-04" })).adoption.watermarks.cursorLagDays).toBe(0);
    expect(() => validate(fixture({ lastBusinessDaySynced: "2026-08-02" }))).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_CURSOR_BEHIND_HISTORY",
    );
  });

  it("binds rollback provider_config to the fenced pre-activation snapshot", () => {
    const driftedSnapshot = fixture();
    driftedSnapshot.input.providerConfigSnapshot.catalog_policy.source = "unreviewed";
    expect(() => validate(driftedSnapshot)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_PROVIDER_CONFIG_SNAPSHOT_MISMATCH",
    );

    const invalidSnapshot = fixture();
    invalidSnapshot.input.providerConfigSnapshot = [];
    expect(() => validate(invalidSnapshot)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_PROVIDER_CONFIG_SNAPSHOT",
    );
  });

  it("fails closed on external signature, removal and readback mismatches", () => {
    const badSignature = fixture();
    const envelope = JSON.parse(badSignature.sources.externalFence.toString("utf8"));
    envelope.signatureBase64 = Buffer.alloc(64, 1).toString("base64");
    badSignature.sources.externalFence = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`);
    badSignature.input.externalWriterFenceEvidence.sha256 = sha256(badSignature.sources.externalFence);
    expect(() => validate(badSignature)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_EXTERNAL_EVIDENCE_SIGNATURE_INVALID",
    );

    const notRemoved = fixture();
    const removedEnvelope = JSON.parse(notRemoved.sources.externalFence.toString("utf8"));
    removedEnvelope.payload.agoraCredential.removedFromLovable = false;
    notRemoved.sources.externalFence = Buffer.from(`${JSON.stringify(removedEnvelope, null, 2)}\n`);
    notRemoved.input.externalWriterFenceEvidence.sha256 = sha256(notRemoved.sources.externalFence);
    expect(() => validate(notRemoved)).toThrow();

    const oneReadback = fixture();
    const readbackEnvelope = JSON.parse(oneReadback.sources.externalFence.toString("utf8"));
    readbackEnvelope.payload.readbacks = [readbackEnvelope.payload.readbacks[1]];
    oneReadback.sources.externalFence = Buffer.from(`${JSON.stringify(readbackEnvelope, null, 2)}\n`);
    oneReadback.input.externalWriterFenceEvidence.sha256 = sha256(oneReadback.sources.externalFence);
    expect(() => validate(oneReadback)).toThrow();
  });

  it("rejects bootstrap grants and unsigned sales-scope drift", () => {
    const bootstrap = fixture();
    const bootstrapGrant = JSON.parse(bootstrap.sources.grant.toString("utf8"));
    bootstrapGrant.grantType = "bootstrap-catalog";
    bootstrapGrant.writerHistory.mode = "bootstrap-no-legacy-writer";
    bootstrapGrant.writerHistory.absence = { priorRunCount: 0 };
    bootstrap.sources.grant = Buffer.from(`${JSON.stringify(bootstrapGrant, null, 2)}\n`);
    bootstrap.input.writerFenceGrant.sha256 = sha256(bootstrap.sources.grant);
    expect(() => validate(bootstrap)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_WRITER_FENCE_GRANT_SCOPE_MISMATCH",
    );

    const scopeDrift = fixture();
    const driftedGrant = JSON.parse(scopeDrift.sources.grant.toString("utf8"));
    driftedGrant.activationScope.finalTargetRawSha256 = sha256("forged-target");
    scopeDrift.sources.grant = Buffer.from(`${JSON.stringify(driftedGrant, null, 2)}\n`);
    scopeDrift.input.writerFenceGrant.sha256 = sha256(scopeDrift.sources.grant);
    expect(() => validate(scopeDrift)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_WRITER_FENCE_SALES_SCOPE_MISMATCH",
    );
  });

  it("rejects unbound deployment/target artifacts and unsafe policy widening", () => {
    const deploymentDrift = fixture();
    deploymentDrift.sources.deployment = Buffer.from("tampered deployment");
    expect(() => validate(deploymentDrift)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_DEPLOYMENT_MANIFEST_SHA256_MISMATCH",
    );

    const targetDrift = fixture();
    targetDrift.sources.finalTargetRaw = Buffer.from("tampered target");
    expect(() => validate(targetDrift)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_FINAL_TARGET_RAW_SHA256_MISMATCH",
    );

    const invalidRawContract = fixture();
    const invalidRaw = JSON.parse(invalidRawContract.sources.finalTargetRaw.toString("utf8"));
    invalidRaw.kind = "unfenced-target-raw";
    invalidRawContract.sources.finalTargetRaw = Buffer.from(`${JSON.stringify(invalidRaw, null, 2)}\n`);
    invalidRawContract.input.finalTargetRaw.sha256 = sha256(invalidRawContract.sources.finalTargetRaw);
    expect(() => validate(invalidRawContract)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_FENCED_TARGET_RAW_V1",
    );

    const semanticDrift = fixture();
    const driftedDelta = JSON.parse(semanticDrift.sources.delta.toString("utf8"));
    driftedDelta.targetCorrectedShadowSha256 = "not-a-sha256";
    semanticDrift.sources.delta = Buffer.from(`${JSON.stringify(driftedDelta, null, 2)}\n`);
    semanticDrift.input.finalDeltaManifest.sha256 = sha256(semanticDrift.sources.delta);
    expect(() => validate(semanticDrift)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_FINAL_DELTA_MANIFEST",
    );

    const openTickets = fixture();
    openTickets.input.providerConfig.open_tickets_sync_enabled = true;
    expect(() => validate(openTickets)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_SALES_ALLOWLIST",
    );
  });

  it("rejects deployment manifest key, job and component drift", () => {
    const extraTopLevel = fixture();
    replaceDeploymentManifest(extraTopLevel, (manifest) => {
      manifest.notes = "not reviewed";
    });
    expect(() => validate(extraTopLevel)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_DEPLOYMENT_MANIFEST_STRUCTURE",
    );

    for (const [field, value] of [
      ["version", 2],
      ["kind", "runtime-catalog-deployment"],
      ["deploymentId", "invalid deployment id"],
    ] as const) {
      const invalidIdentity = fixture();
      replaceDeploymentManifest(invalidIdentity, (manifest) => {
        manifest[field] = value;
      });
      expect(() => validate(invalidIdentity)).toThrow(
        "RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_DEPLOYMENT_MANIFEST",
      );
    }

    for (const jobs of [
      ["sales.auto-sync"],
      ["sales.auto-sync", "sales.sync-intraday", "catalog.sync"],
    ]) {
      const invalidJobs = fixture();
      replaceDeploymentManifest(invalidJobs, (manifest) => {
        manifest.jobs = jobs;
      });
      expect(() => validate(invalidJobs)).toThrow(
        "RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_DEPLOYMENT_JOBS",
      );
    }

    const missingComponent = fixture();
    replaceDeploymentManifest(missingComponent, (manifest) => {
      delete manifest.components.executor;
    });
    expect(() => validate(missingComponent)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_DEPLOYMENT_COMPONENTS_STRUCTURE",
    );

    const extraComponent = fixture();
    replaceDeploymentManifest(extraComponent, (manifest) => {
      manifest.components.catalog = manifest.components.runtime;
    });
    expect(() => validate(extraComponent)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_DEPLOYMENT_COMPONENTS_STRUCTURE",
    );
  });

  it("rejects deployment component extra fields and invalid UUID/hash values", () => {
    const extraComponentField = fixture();
    replaceDeploymentManifest(extraComponentField, (manifest) => {
      manifest.components.runtime.route = "/runtime";
    });
    expect(() => validate(extraComponentField)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_DEPLOYMENT_COMPONENT_RUNTIME_STRUCTURE",
    );

    const invalidUuid = fixture();
    replaceDeploymentManifest(invalidUuid, (manifest) => {
      manifest.components.executor.versionId = "not-a-uuid";
    });
    expect(() => validate(invalidUuid)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_DEPLOYMENT_COMPONENT",
    );

    const invalidHash = fixture();
    replaceDeploymentManifest(invalidHash, (manifest) => {
      manifest.components.writerFence.configSha256 = "not-a-sha256";
    });
    expect(() => validate(invalidHash)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_DEPLOYMENT_COMPONENT",
    );
  });

  it("keeps replay, nonempty history and plan gates fail-closed", () => {
    const data = fixture();
    const validated = validate(data);
    const manifest = buildFleetConnectionAdoptExistingActivationManifest(validated);
    const manifestSha256 = sha256(JSON.stringify(manifest));
    const activationSql = renderFleetConnectionAdoptExistingActivationSql({
      activation: validated,
      activationManifestSha256: manifestSha256,
    });
    const deactivationSql = renderFleetConnectionAdoptExistingDeactivationSql({
      activation: validated,
      activationManifestSha256: manifestSha256,
    });
    expect(activationSql).toContain("exact unique PREPARED adopt-existing scope is missing or consumed");
    expect(activationSql).toContain("exact two inactive credential generation is missing");
    expect(activationSql).not.toMatch(/DELETE\s+FROM/i);
    expect(deactivationSql).toContain("exact active generation is missing, mismatched, or already consumed");
    expect(deactivationSql).not.toMatch(/DELETE\s+FROM|activated_at\s*=\s*NULL|status\s*=\s*'PREPARED'/i);
    expect(fleetConnectionAdoptExistingActivationPlan()).toMatchObject({
      remoteMutations: 0,
      activationMode: "adopt-existing-sales",
      requiresExternalEd25519WriterFence: true,
      rollbackMode: "two-phase-quiesce-then-append-only-retirement",
      rollbackPhases: ["quiesce-intake", "drain-leases-and-retire"],
    });
  });
});
