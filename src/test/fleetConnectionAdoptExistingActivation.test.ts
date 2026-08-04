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
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import {
  collectFleetFullCloudflareTopologyAttestation,
  validateFleetFullConsumerTopology,
} from "../../infrastructure/runtime/fleet-full-topology-evidence.mjs";

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
      externalPrivateKeySource: privateKeySource,
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
}, providerConfig: Record<string, unknown> = PROVIDER_CONFIG) {
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
    sha256(canonicalJson(providerConfig)),
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

async function perLaneQueueOwnership({
  deployment,
  privateKeySource,
  publicKeySource,
  outputDirectory,
}: {
  deployment: MutableDeploymentManifest;
  privateKeySource: Buffer;
  publicKeySource: Buffer;
  outputDirectory: string;
}) {
  const accountId = "e75343bb63534d3d029150e90b48ec7c";
  const observedAt = "2026-08-04T14:19:00.000Z";
  const executorDeploymentId = "74444444-4444-4444-8444-444444444444";
  const lanes = {
    catalog: {
      queue: "winerim-rescue-prod-catalog",
      deadLetterQueue: "winerim-rescue-prod-catalog-dead-letter",
      queueId: "a1111111111111111111111111111111",
      consumerWorkerName: deployment.components.catalog.workerName,
      consumerDeploymentId: "71111111-1111-4111-8111-111111111111",
      consumerVersionId: deployment.components.catalog.versionId,
    },
    salesStock: {
      queue: "winerim-rescue-prod-sales",
      deadLetterQueue: "winerim-rescue-prod-sales-dead-letter",
      queueId: "a2222222222222222222222222222222",
      consumerWorkerName: deployment.components.salesStock.workerName,
      consumerDeploymentId: "72222222-2222-4222-8222-222222222222",
      consumerVersionId: deployment.components.salesStock.versionId,
    },
    outbound: {
      queue: "winerim-rescue-prod-outbound",
      deadLetterQueue: "winerim-rescue-prod-outbound-dead-letter",
      queueId: "a3333333333333333333333333333333",
      consumerWorkerName: deployment.components.outbound.workerName,
      consumerDeploymentId: "73333333-3333-4333-8333-333333333333",
      consumerVersionId: deployment.components.outbound.versionId,
    },
  } as const;
  const responseFor = (kind: string) => {
    let result: unknown;
    if (kind === "queue-list") {
      result = Object.values(lanes).map((lane) => ({
        queue_id: lane.queueId,
        queue_name: lane.queue,
      }));
    } else if (kind.startsWith("queue-consumers:")) {
      const lane = lanes[kind.slice("queue-consumers:".length) as keyof typeof lanes];
      result = [{
        consumer_id: "b" + lane.queueId.slice(1),
        type: "worker",
        queue_name: lane.queue,
        script_name: lane.consumerWorkerName,
        dead_letter_queue: lane.deadLetterQueue,
        settings: {
          batch_size: 1,
          max_wait_time_ms: 5_000,
          max_retries: 3,
          max_concurrency: 1,
        },
      }];
    } else if (kind.startsWith("worker-deployments:consumer:")) {
      const lane = lanes[
        kind.slice("worker-deployments:consumer:".length) as keyof typeof lanes
      ];
      result = {
        deployments: [{
          id: lane.consumerDeploymentId,
          versions: [{ percentage: 100, version_id: lane.consumerVersionId }],
        }],
      };
    } else {
      result = {
        deployments: [{
          id: executorDeploymentId,
          versions: [{
            percentage: 100,
            version_id: deployment.components.executor.versionId,
          }],
        }],
      };
    }
    const list = Array.isArray(result) ? result : (result as { deployments: unknown[] }).deployments;
    return new Response(JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result,
      result_info: {
        page: 1,
        per_page: 100,
        count: list.length,
        total_count: list.length,
      },
    }), {
      status: 200,
      headers: {
        date: observedAt,
        "cf-ray": "abc123def456-MAD",
        "content-type": "application/json",
      },
    });
  };
  const fetchImpl = async (url: string) => {
    if (url.endsWith("/queues")) return responseFor("queue-list");
    for (const [key, lane] of Object.entries(lanes)) {
      if (url.endsWith(`/queues/${lane.queueId}/consumers`)) {
        return responseFor(`queue-consumers:${key}`);
      }
      if (url.endsWith(`/workers/scripts/${lane.consumerWorkerName}/deployments`)) {
        return responseFor(`worker-deployments:consumer:${key}`);
      }
    }
    if (url.endsWith("/deployments")) return responseFor("worker-deployments:executor");
    throw new Error("unexpected Cloudflare URL");
  };
  const topologyKey = writePrivate(
    outputDirectory,
    "topology-private.pem",
    privateKeySource,
  );
  const collectorLanes = Object.fromEntries(Object.entries(lanes).map(([key, lane]) => [key, {
    queue: lane.queue,
    deadLetterQueue: lane.deadLetterQueue,
    consumerWorkerName: lane.consumerWorkerName,
    consumerDeploymentId: lane.consumerDeploymentId,
    consumerVersionId: lane.consumerVersionId,
  }]));
  const times = [new Date("2026-08-04T14:18:58.000Z"), new Date(observedAt)];
  const topologyResult = await collectFleetFullCloudflareTopologyAttestation({
    accountId,
    executorWorkerName: deployment.components.executor.workerName,
    executorDeploymentId,
    executorVersionId: deployment.components.executor.versionId,
    lanes: collectorLanes,
    apiToken: "test-cloudflare-api-token-not-a-secret",
    privateKeyPath: topologyKey.path,
    outputPath: join(outputDirectory, "topology-attestation.json"),
    keyId: "cloudflare-topology-test-key",
    fetchImpl,
    now: () => times.shift() ?? new Date(observedAt),
  });
  return validateFleetFullConsumerTopology({
    evidence: topologyResult.attestation,
    verifiedAt: APPROVED_AT,
    accountId,
    executorWorkerName: deployment.components.executor.workerName,
    executorDeploymentId,
    executorVersionId: deployment.components.executor.versionId,
    lanes: collectorLanes,
    trustedPublicKeySha256: sha256(publicKeySource),
  });
}

async function fullLanesFixture(options: Parameters<typeof fixture>[0] = {}) {
  const testFixture = fixture(options);
  testFixture.input.kind = "RUNTIME_FLEET_CONNECTION_FULL_LANES_ACTIVATION";
  testFixture.input.providerConfig = JSON.parse(JSON.stringify(FULL_LANES_PROVIDER_CONFIG));

  const deployment = JSON.parse(testFixture.sources.deployment.toString("utf8"));
  deployment.kind = "runtime-full-lanes-deployment";
  deployment.deploymentId = "runtime-full-lanes-20260804-a";
  deployment.jobs = [...FULL_LANES_JOBS];
  deployment.components = {
    catalog: {
      workerName: "winerim-middleware-runtime-rescue-prod-fleet-catalog",
      versionId: "11111111-1111-4111-8111-111111111111",
      configSha256: sha256("catalog-worker-config"),
    },
    salesStock: {
      workerName: "winerim-middleware-runtime-rescue-prod-fleet-sales-stock",
      versionId: "22222222-2222-4222-8222-222222222222",
      configSha256: sha256("sales-stock-worker-config"),
    },
    outbound: {
      workerName: "winerim-middleware-runtime-rescue-prod-fleet-outbound",
      versionId: "33333333-3333-4333-8333-333333333333",
      configSha256: sha256("outbound-worker-config"),
    },
    executor: {
      workerName: "winerim-middleware-runtime-executor-rescue-prod-fleet-full",
      versionId: "44444444-4444-4444-8444-444444444444",
      configSha256: sha256("executor-worker-config"),
    },
    writerFence: {
      workerName: "winerim-middleware-runtime-writer-fence-rescue-prod-fleet",
      versionId: "55555555-5555-4555-8555-555555555555",
      configSha256: sha256("writer-fence-worker-config"),
    },
    rateLimiter: {
      workerName: "winerim-middleware-outbound-rate-limiter-rescue-prod-fleet",
      versionId: "66666666-6666-4666-8666-666666666666",
      configSha256: sha256("rate-limiter-worker-config"),
    },
  };
  deployment.queueOwnership = await perLaneQueueOwnership({
    deployment,
    privateKeySource: testFixture.documents.externalPrivateKeySource,
    publicKeySource: testFixture.sources.externalPublicKey,
    outputDirectory: dirname(testFixture.inputFile.path),
  });
  testFixture.sources.deployment = Buffer.from(`${JSON.stringify(deployment, null, 2)}\n`);
  testFixture.input.deploymentManifest.sha256 = sha256(testFixture.sources.deployment);
  writeFileSync(testFixture.input.deploymentManifest.path, testFixture.sources.deployment);
  chmodSync(testFixture.input.deploymentManifest.path, 0o600);

  const grant = JSON.parse(testFixture.sources.grant.toString("utf8"));
  grant.activationScope.deploymentManifestSha256 = testFixture.input.deploymentManifest.sha256;
  grant.activationScope.runtimePolicyProfile = "full-lanes-v1";
  grant.activationScope.runtimeJobAllowlist = [...FULL_LANES_JOBS];
  grant.activationScope.runtimePolicySha256 = sha256(canonicalJson(FULL_LANES_PROVIDER_CONFIG));
  const scopePayload = activationScopePayload({
    adoptionBindingSha256: grant.activationScope.adoptionBindingSha256,
    deploymentManifestSha256: grant.activationScope.deploymentManifestSha256,
    finalTargetRawSha256: grant.activationScope.finalTargetRawSha256,
    externalEvidenceSha256: grant.activationScope.externalEvidenceSha256,
    externalEvidencePayloadSha256: grant.activationScope.externalEvidencePayloadSha256,
  }, FULL_LANES_PROVIDER_CONFIG);
  grant.activationScope.bindingSha256 = sha256(scopePayload);
  grant.activationScope.signatureSha256 = createHmac("sha256", testFixture.sources.proof)
    .update(scopePayload)
    .digest("hex");
  testFixture.sources.grant = Buffer.from(`${JSON.stringify(grant, null, 2)}\n`);
  testFixture.input.writerFenceGrant.sha256 = sha256(testFixture.sources.grant);
  writeFileSync(testFixture.input.writerFenceGrant.path, testFixture.sources.grant);
  chmodSync(testFixture.input.writerFenceGrant.path, 0o600);
  testFixture.documents.grantDocument = grant;

  writeFileSync(testFixture.inputFile.path, `${JSON.stringify(testFixture.input, null, 2)}\n`);
  chmodSync(testFixture.inputFile.path, 0o600);
  return testFixture;
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
    expect(activationSql).toContain("public.stock_sync_log");
    expect(activationSql).not.toContain("public.winerim_sync_receipts");
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

describe("fleet adopt-existing full-lanes atomic activation gate", () => {
  it("binds one reviewed generation and activates every full lane atomically", async () => {
    const data = await fullLanesFixture();
    const validated = validate(data);
    const manifest = buildFleetConnectionAdoptExistingActivationManifest(validated);
    const manifestSha256 = sha256(`${JSON.stringify(manifest, null, 2)}\n`);
    const activationSql = renderFleetConnectionAdoptExistingActivationSql({
      activation: validated,
      activationManifestSha256: manifestSha256,
    });
    const deactivationSql = renderFleetConnectionAdoptExistingDeactivationSql({
      activation: validated,
      activationManifestSha256: manifestSha256,
    });

    expect(validated).toMatchObject({
      kind: "RUNTIME_FLEET_CONNECTION_FULL_LANES_ACTIVATION",
      activationMode: "adopt-existing-full-lanes",
      runtimePolicyProfile: "full-lanes-v1",
      runtimeJobAllowlist: FULL_LANES_JOBS,
      connectionPolicy: {
        catalogSyncEnabled: true,
        syncMode: "BIDIRECTIONAL",
        writeMode: "XML_IMPORT",
      },
      providerConfig: FULL_LANES_PROVIDER_CONFIG,
      deploymentManifest: {
        kind: "runtime-full-lanes-deployment",
        jobs: FULL_LANES_JOBS,
        queueOwnership: {
          version: 2,
          executorWorkerName: "winerim-middleware-runtime-executor-rescue-prod-fleet-full",
          executorDeploymentId: "74444444-4444-4444-8444-444444444444",
          executorVersionId: "44444444-4444-4444-8444-444444444444",
          queues: {
            catalog: {
              consumerWorkerName: "winerim-middleware-runtime-rescue-prod-fleet-catalog",
              consumerCount: 1,
              legacyConsumerCount: 0,
              competingConsumerCount: 0,
            },
            salesStock: {
              consumerWorkerName: "winerim-middleware-runtime-rescue-prod-fleet-sales-stock",
              consumerCount: 1,
              legacyConsumerCount: 0,
              competingConsumerCount: 0,
            },
            outbound: {
              consumerWorkerName: "winerim-middleware-runtime-rescue-prod-fleet-outbound",
              consumerCount: 1,
              legacyConsumerCount: 0,
              competingConsumerCount: 0,
            },
          },
        },
      },
      writerFenceGrant: {
        runtimePolicyProfile: "full-lanes-v1",
        runtimeJobAllowlist: FULL_LANES_JOBS,
      },
    });
    expect(manifest).toMatchObject({
      activationMode: "adopt-existing-full-lanes",
      activationAllowed: true,
      rollbackMode: "two-phase-quiesce-then-append-only-retirement",
    });
    expect(activationSql).toContain("SET enabled = true,\n    catalog_sync_enabled = true,\n    sync_mode = 'BIDIRECTIONAL',\n    write_mode = 'XML_IMPORT',\n    backfill_days = 0");
    expect(activationSql).toContain('"runtime_fleet_profile":"full-lanes-v1"');
    expect(activationSql).toContain('"runtime_catalog_enabled":true');
    expect(activationSql).toContain('"runtime_stock_enabled":true');
    expect(activationSql).toContain('"runtime_outbound_enabled":true');
    expect(activationSql).toContain('"runtime_maintenance_enabled":false');
    expect(activationSql).toContain("runtime_full_catalog_scope(uuid) is required");
    expect(activationSql).toContain("queue consumer ownership evidence is not fresh at activation time");
    expect(activationSql).toContain(`NOT public.runtime_full_catalog_scope('${CONNECTION_ID}'::uuid)`);
    expect(activationSql).not.toMatch(/INSERT\s+INTO\s+public\.runtime_catalog_source_scope/i);
    expect(activationSql.match(/UPDATE public\.runtime_canary_connections/g)).toHaveLength(1);
    expect(activationSql).toContain("exact unique PREPARED adopt-existing scope is missing or consumed");
    expect(activationSql).toContain("exact two inactive credential generation is missing");
    expect(activationSql).toContain("reconciled historical watermarks changed after review");
    expect(activationSql).not.toMatch(/DELETE\s+FROM/i);

    expect(deactivationSql).toContain("-- Phase 1: persistently quiesce new runtime intake");
    expect(deactivationSql).toContain("-- Phase 2: retire only after every runtime lease is terminal");
    expect(deactivationSql).toContain('"runtime_fleet_job_allowlist":[]');
    expect(deactivationSql).toContain('"runtime_catalog_enabled":false');
    expect(deactivationSql).toContain("catalog leases remain after quiesce");
    expect(deactivationSql).toContain(`public.runtime_full_catalog_scope('${CONNECTION_ID}'::uuid)`);
    expect(deactivationSql).not.toMatch(/DELETE\s+FROM|activated_at\s*=\s*NULL|status\s*=\s*'PREPARED'/i);
  });

  it("rejects a sales-only grant even when every other full-lanes artifact is exact", async () => {
    const data = await fullLanesFixture();
    const grant = JSON.parse(data.sources.grant.toString("utf8"));
    grant.activationScope.runtimePolicyProfile = "sales-only-v1";
    grant.activationScope.runtimeJobAllowlist = ["sales.auto-sync", "sales.sync-intraday"];
    data.sources.grant = Buffer.from(`${JSON.stringify(grant, null, 2)}\n`);
    data.input.writerFenceGrant.sha256 = sha256(data.sources.grant);

    expect(() => validate(data)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_WRITER_FENCE_SALES_SCOPE_MISMATCH",
    );
  });

  it("rejects incomplete full-lanes config and deployment drift", async () => {
    const incomplete = await fullLanesFixture();
    delete incomplete.input.providerConfig.runtime_outbound_enabled;
    expect(() => validate(incomplete)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_PROVIDER_CONFIG_STRUCTURE",
    );

    const deploymentDrift = await fullLanesFixture();
    replaceDeploymentManifest(deploymentDrift, (deployment) => {
      deployment.jobs = deployment.jobs.slice(0, -1);
    });
    expect(() => validate(deploymentDrift)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_DEPLOYMENT_JOBS",
    );
  });

  it("requires exactly one new consumer and zero legacy or competing consumers per queue", async () => {
    const missingEvidence = await fullLanesFixture();
    replaceDeploymentManifest(missingEvidence, (deployment) => {
      delete deployment.queueOwnership;
    });
    expect(() => validate(missingEvidence)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_DEPLOYMENT_MANIFEST_STRUCTURE",
    );

    for (const [field, value] of [
      ["consumerCount", 2],
      ["legacyConsumerCount", 1],
      ["competingConsumerCount", 1],
    ] as const) {
      const ambiguous = await fullLanesFixture();
      replaceDeploymentManifest(ambiguous, (deployment) => {
        const queueOwnership = deployment.queueOwnership as {
          queues: Record<string, Record<string, unknown>>;
        };
        queueOwnership.queues.catalog[field] = value;
      });
      expect(() => validate(ambiguous)).toThrow(
        "RUNTIME_FLEET_ADOPT_ACTIVATION_QUEUE_OWNERSHIP_ATTESTATION_DRIFT",
      );
    }

    const wrongLaneConsumer = await fullLanesFixture();
    replaceDeploymentManifest(wrongLaneConsumer, (deployment) => {
      const queueOwnership = deployment.queueOwnership as {
        queues: Record<string, Record<string, unknown>>;
      };
      queueOwnership.queues.catalog.consumerWorkerName = deployment.components.executor.workerName;
    });
    expect(() => validate(wrongLaneConsumer)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_QUEUE_OWNERSHIP_ATTESTATION_DRIFT",
    );

    const wrongExecutorAttestation = await fullLanesFixture();
    replaceDeploymentManifest(wrongExecutorAttestation, (deployment) => {
      const queueOwnership = deployment.queueOwnership as { executorWorkerName: string };
      queueOwnership.executorWorkerName = "legacy-executor";
    });
    expect(() => validate(wrongExecutorAttestation)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_QUEUE_OWNERSHIP_ATTESTATION_DRIFT",
    );

    const executorAsLaneComponent = await fullLanesFixture();
    replaceDeploymentManifest(executorAsLaneComponent, (deployment) => {
      deployment.components.catalog.workerName = deployment.components.executor.workerName;
    });
    expect(() => validate(executorAsLaneComponent)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_LANE_CONSUMER_COMPONENTS",
    );
  });

  it("rejects signed evidence when Lovable is not fenced or the drain/readbacks are incomplete", async () => {
    const notFenced = await fullLanesFixture();
    const envelope = JSON.parse(notFenced.sources.externalFence.toString("utf8"));
    envelope.payload.lovable.writerDisabled = false;
    const payloadSource = Buffer.from(JSON.stringify(envelope.payload));
    const signature = sign(null, payloadSource, notFenced.documents.externalPrivateKeySource);
    envelope.signatureBase64 = signature.toString("base64");
    envelope.hashes.payloadSha256 = sha256(payloadSource);
    envelope.hashes.signatureSha256 = sha256(signature);
    notFenced.sources.externalFence = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`);
    notFenced.input.externalWriterFenceEvidence.sha256 = sha256(notFenced.sources.externalFence);
    expect(() => validate(notFenced)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_EXTERNAL_EVIDENCE_SCOPE_MISMATCH",
    );

    const oneReadback = await fullLanesFixture();
    const oneReadbackEnvelope = JSON.parse(oneReadback.sources.externalFence.toString("utf8"));
    oneReadbackEnvelope.payload.readbacks = [oneReadbackEnvelope.payload.readbacks[1]];
    const oneReadbackPayload = Buffer.from(JSON.stringify(oneReadbackEnvelope.payload));
    const oneReadbackSignature = sign(
      null,
      oneReadbackPayload,
      oneReadback.documents.externalPrivateKeySource,
    );
    oneReadbackEnvelope.signatureBase64 = oneReadbackSignature.toString("base64");
    oneReadbackEnvelope.hashes.payloadSha256 = sha256(oneReadbackPayload);
    oneReadbackEnvelope.hashes.signatureSha256 = sha256(oneReadbackSignature);
    oneReadback.sources.externalFence = Buffer.from(`${JSON.stringify(oneReadbackEnvelope, null, 2)}\n`);
    oneReadback.input.externalWriterFenceEvidence.sha256 = sha256(oneReadback.sources.externalFence);
    expect(() => validate(oneReadback)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_EXTERNAL_EVIDENCE_SCOPE_MISMATCH",
    );

    const shortDrain = await fullLanesFixture();
    const fence = JSON.parse(shortDrain.sources.fence.toString("utf8"));
    fence.drain.minimumMs = 129_999;
    shortDrain.sources.fence = Buffer.from(`${JSON.stringify(fence, null, 2)}\n`);
    shortDrain.input.writerFenceEvidence.sha256 = sha256(shortDrain.sources.fence);
    expect(() => validate(shortDrain)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_WRITER_FENCE_NOT_VERIFIABLE",
    );
  });

  it("rejects reconciled-history drift and ambiguous credential generations", async () => {
    const historyDrift = await fullLanesFixture();
    const reconciliation = JSON.parse(historyDrift.sources.reconciliation.toString("utf8"));
    reconciliation.counts.events += 1;
    historyDrift.sources.reconciliation = Buffer.from(`${JSON.stringify(reconciliation, null, 2)}\n`);
    historyDrift.input.finalReconciliationManifest.sha256 = sha256(historyDrift.sources.reconciliation);
    expect(() => validate(historyDrift)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_FINAL_RECONCILIATION_WATERMARK_MISMATCH",
    );

    const ambiguousCredentials = await fullLanesFixture();
    const grant = JSON.parse(ambiguousCredentials.sources.grant.toString("utf8"));
    grant.credentialBundle.credentials.legacy = {
      ...grant.credentialBundle.credentials.agora,
      kind: "legacy",
    };
    ambiguousCredentials.sources.grant = Buffer.from(`${JSON.stringify(grant, null, 2)}\n`);
    ambiguousCredentials.input.writerFenceGrant.sha256 = sha256(ambiguousCredentials.sources.grant);
    expect(() => validate(ambiguousCredentials)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_WRITER_FENCE_CREDENTIAL_BUNDLE_MISMATCH",
    );
  });

  it("keeps cursor/history, credentials and scope ambiguity fail-closed and renders rollback", async () => {
    const staleCursor = await fullLanesFixture({ lastBusinessDaySynced: "2026-08-02" });
    expect(() => validate(staleCursor)).toThrow(
      "RUNTIME_FLEET_ADOPT_ACTIVATION_CURSOR_BEHIND_HISTORY",
    );

    const validated = validate(await fullLanesFixture());
    const manifestSha256 = sha256("full-lanes-manifest-review");
    const activationSql = renderFleetConnectionAdoptExistingActivationSql({
      activation: validated,
      activationManifestSha256: manifestSha256,
    });
    const rollbackSql = renderFleetConnectionAdoptExistingDeactivationSql({
      activation: validated,
      activationManifestSha256: manifestSha256,
    });
    expect(activationSql).toContain("count(DISTINCT credential_kind)");
    expect(activationSql).toContain("WHERE connection_id = '");
    expect(activationSql).toContain("AND status = 'PREPARED'");
    expect(rollbackSql.indexOf("SET enabled = false")).toBeLessThan(
      rollbackSql.indexOf("catalog leases remain after quiesce"),
    );
    expect(rollbackSql.indexOf("COMMIT;")).toBeLessThan(
      rollbackSql.indexOf("-- Phase 2: retire only after every runtime lease is terminal"),
    );
    expect(rollbackSql).toContain("provider_config = '");
    expect(rollbackSql).toContain("status = 'ABORTED'");
    expect(rollbackSql).toContain("Historical receipts, sales, mappings, and catalog outcomes are append-only");
    expect(rollbackSql).not.toMatch(/DELETE\s+FROM/i);
  });
});
