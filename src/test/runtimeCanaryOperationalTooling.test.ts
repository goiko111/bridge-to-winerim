import {
  createDecipheriv,
  createHash,
  createHmac,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
  SqlStatement,
} from "../../cloudflare/workers/middleware-api/src/db";
import { createPostgresEncryptedCredentialPort } from "../../cloudflare/workers/middleware-runtime/src/executor";
import {
  parseWriterFenceGrant,
  validateWriterFenceGrant,
} from "../../cloudflare/canary-failclosed/src/writerFence";

// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import {
  credentialProvisioningPlan,
  encryptRuntimeCredential,
  prepareCredentialProvisioning,
  renderCredentialProvisioningSql,
  runtimeCredentialAad,
  runtimeCredentialSetSha256,
  validateAdoptExistingEvidence,
} from "../../infrastructure/runtime/prepare-runtime-credential-provisioning.mjs";
// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import {
  prepareRescueCanaryRetirement,
  renderRescueCanaryRetirementSql,
  rescueCanaryRetirementPlan,
} from "../../infrastructure/runtime/prepare-rescue-canary-retirement.mjs";
// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import {
  prepareRescueCanaryActivation,
  renderRescueCanaryActivationSql,
  rescueCanaryActivationPlan,
} from "../../infrastructure/runtime/prepare-rescue-canary-activation.mjs";
// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import {
  prepareWriterFenceGrant,
  validateExternalBootstrapWriterFenceEvidence,
} from "../../infrastructure/runtime/prepare-writer-fence-grant.mjs";

const CONNECTION_ID = "ba44c13a-5f48-4a49-8b3f-04049b244d94";
const KEY_VERSION = "elbejeque-v1";
const APPROVED_AT = "2026-08-03T12:00:00.000Z";
const EXPIRES_AT = "2026-08-03T13:00:00.000Z";
const RETIREMENT_RESOURCES = {
  executorService: "winerim-rescue-executor-elbejeque-a",
  fenceService: "winerim-rescue-fence-elbejeque-a",
  vaultSecretName: "runtime-vault-key-elbejeque-a",
  proofSecretName: "writer-fence-proof-elbejeque-a",
  grantSecretName: "writer-fence-grant-elbejeque-a",
  archiveBucket: "winerim-rescue-canary-ledger",
};
const RETIREMENT_RUN_ID = "elbejeque-20260803-a";
const CREDENTIAL_ATTESTATIONS = { agora: "a".repeat(64), winerim: "b".repeat(64) };
const CREDENTIAL_SET_SHA256 = runtimeCredentialSetSha256({
  connectionId: CONNECTION_ID,
  runId: RETIREMENT_RUN_ID,
  keyVersion: KEY_VERSION,
  credentials: Object.entries(CREDENTIAL_ATTESTATIONS).map(([kind, attestationSha256]) => ({
    kind,
    attestationSha256,
  })),
});
const DEPLOYMENT_CONFIG_SHA256 = {
  consumer: "1".repeat(64),
  executor: "2".repeat(64),
  fence: "3".repeat(64),
  observer: "4".repeat(64),
};
const DEPLOYMENT_BUNDLE_SHA256 = {
  consumer: "5".repeat(64),
  executor: "6".repeat(64),
  fence: "7".repeat(64),
  observer: "8".repeat(64),
};
const EXTERNAL_FENCE_KEY_PAIR = generateKeyPairSync("ed25519");
const EXTERNAL_FENCE_PUBLIC_KEY = EXTERNAL_FENCE_KEY_PAIR.publicKey.export({
  type: "spki",
  format: "pem",
});

type ExternalFenceOptions = {
  fenceMode?: "agora-credential-rotated" | "lovable-disabled-no-agora-rotation";
  observedAt?: string;
  readbacks?: string[];
};

function externalFenceArtifact({
  fenceMode = "lovable-disabled-no-agora-rotation",
  observedAt = "2026-08-03T11:54:00.000Z",
  readbacks,
}: ExternalFenceOptions = {}) {
  const defaultReadbacks = fenceMode === "lovable-disabled-no-agora-rotation"
    ? ["2026-08-03T11:52:10.000Z", observedAt]
    : [observedAt];
  const payload = {
    evidenceType: "lovable-writer-fence",
    connectionId: CONNECTION_ID,
    source: {
      provider: "lovable-cloud",
      projectId: "a61b5b89-4c36-44fc-aaf2-9c7c3f3cfd8d",
      collectorRunId: "external-observer-20260803-a",
    },
    fenceMode,
    fenceAppliedAt: "2026-08-03T11:50:00.000Z",
    observedAt,
    lovable: {
      writerDisabled: true,
      cronDisabled: true,
      edgeMutationDisabled: true,
    },
    agoraCredential: fenceMode === "agora-credential-rotated"
      ? {
        rotated: true,
        rotatedAt: "2026-08-03T11:50:00.000Z",
        oldCredentialProbeStatus: 401,
      }
      : { rotated: false, removedFromLovable: true },
    readbacks: (readbacks ?? defaultReadbacks).map((value) => ({
      observedAt: value,
      status: "FENCED_HEALTHY",
      writerDisabled: true,
      cronDisabled: true,
      edgeMutationDisabled: true,
      agoraCredentialUnavailableToLovable: true,
    })),
  };
  const signature = sign(
    null,
    Buffer.from(JSON.stringify(payload)),
    EXTERNAL_FENCE_KEY_PAIR.privateKey,
  );
  const source = Buffer.from(`${JSON.stringify({
    version: 1,
    algorithm: "Ed25519",
    keyId: "lovable-fence-observer-v1",
    payload,
    signatureBase64: signature.toString("base64"),
  }, null, 2)}\n`);
  return {
    source,
    publicKey: Buffer.from(EXTERNAL_FENCE_PUBLIC_KEY),
    artifactSha256: createHash("sha256").update(source).digest("hex"),
    publicKeySha256: createHash("sha256").update(EXTERNAL_FENCE_PUBLIC_KEY).digest("hex"),
  };
}

function externalFenceSummary(options: ExternalFenceOptions = {}) {
  const artifact = externalFenceArtifact(options);
  return validateExternalBootstrapWriterFenceEvidence({
    artifactSource: artifact.source,
    artifactSha256: artifact.artifactSha256,
    publicKeySource: artifact.publicKey,
    publicKeySha256: artifact.publicKeySha256,
    connectionId: CONNECTION_ID,
    referenceTime: "2026-08-03T11:55:00.000Z",
  });
}

function deploymentManifest() {
  const queueName = `winerim-rescue-prod-canary-${RETIREMENT_RUN_ID}`;
  const exclusiveCredentialRef = `runtime-vault://postgres/${CONNECTION_ID}/agora/winerim`;
  const credentialBinding = createHash("sha256").update([
    "winerim-writer-fence-credential",
    "1",
    exclusiveCredentialRef,
    "b".repeat(64),
  ].join("|")).digest("hex");
  return {
    version: 3,
    runId: RETIREMENT_RUN_ID,
    connectionId: CONNECTION_ID,
    scopeNote: `rescue-canary-run:${RETIREMENT_RUN_ID}`,
    credentialBinding: {
      keyVersion: KEY_VERSION,
      exclusiveAttestationSha256: "b".repeat(64),
      credentialSetSha256: CREDENTIAL_SET_SHA256,
    },
    writerFence: {
      holderId: "release-a",
      proofSha256: "a".repeat(64),
      exclusiveCredentialRef,
      credentialBinding,
    },
    credentialPolicy: {
      exclusiveWriterCredentialKind: "winerim",
      agoraCredentialMode: "shared-read-only",
    },
    mutationPolicy: {
      agoraCatalogApply: false,
      agoraOutboundMutation: false,
      winerimMutation: true,
    },
    resources: {
      queues: {
        input: queueName,
        dlq: `${queueName}-dlq`,
        alarms: `${queueName}-alarms`,
        observerFailures: `${queueName}-observer-failures`,
      },
      workers: {
        consumer: queueName,
        executor: RETIREMENT_RESOURCES.executorService,
        fence: RETIREMENT_RESOURCES.fenceService,
        observer: `winerim-rescue-prod-canary-dlq-observer-${RETIREMENT_RUN_ID}`,
      },
      secrets: {
        vault: RETIREMENT_RESOURCES.vaultSecretName,
        proof: RETIREMENT_RESOURCES.proofSecretName,
        grant: RETIREMENT_RESOURCES.grantSecretName,
      },
      archiveBucket: RETIREMENT_RESOURCES.archiveBucket,
    },
    configSha256: DEPLOYMENT_CONFIG_SHA256,
    bundleSha256: DEPLOYMENT_BUNDLE_SHA256,
  };
}

function catalogDeploymentManifest() {
  const manifest = deploymentManifest();
  const exclusiveCredentialRef = `runtime-vault://postgres/${CONNECTION_ID}/agora/agora`;
  return {
    ...manifest,
    version: 4,
    credentialBinding: {
      ...manifest.credentialBinding,
      exclusiveAttestationSha256: "a".repeat(64),
    },
    writerFence: {
      ...manifest.writerFence,
      exclusiveCredentialRef,
      credentialBinding: createHash("sha256").update([
        "winerim-writer-fence-credential",
        "1",
        exclusiveCredentialRef,
        "a".repeat(64),
      ].join("|")).digest("hex"),
    },
    scopePolicy: {
      job: "catalog.sync-master",
      lane: "catalog",
      maxOperations: 1,
      productId: "500001",
    },
    credentialPolicy: {
      exclusiveWriterCredentialKind: "agora",
      agoraCredentialMode: "exclusive-writer",
    },
    mutationPolicy: {
      agoraCatalogApply: true,
      agoraOutboundMutation: false,
      winerimMutation: false,
    },
  };
}

function salesV4DeploymentManifest() {
  return {
    ...deploymentManifest(),
    version: 4,
    writerFence: {
      ...deploymentManifest().writerFence,
      mode: "legacy-writer-revoked",
    },
    scopePolicy: {
      job: "winerim.sales-import-live",
      lane: "sales-import",
      maxOperations: 1,
      productId: null,
    },
  };
}

function bootstrapCatalogDeploymentManifest() {
  const manifest = catalogDeploymentManifest();
  return {
    ...manifest,
    writerFence: {
      ...manifest.writerFence,
      mode: "bootstrap-no-legacy-writer",
    },
  };
}

function credentialProvisioningManifest(mode = "bootstrap") {
  return {
    version: 1,
    connectionId: CONNECTION_ID,
    runId: RETIREMENT_RUN_ID,
    keyVersion: KEY_VERSION,
    mode,
    active: false,
    sqlSha256: "9".repeat(64),
    credentialAttestations: CREDENTIAL_ATTESTATIONS,
    credentialSetSha256: CREDENTIAL_SET_SHA256,
  };
}

function v3CredentialBundle({
  holderId = "release-a",
  issuedAt = "2026-08-03T11:55:00.000Z",
  expiresAt = EXPIRES_AT,
  proof = "fixture-proof-secret-with-more-than-32-bytes",
} = {}) {
  const credentials = Object.fromEntries(Object.entries(CREDENTIAL_ATTESTATIONS).map(([
    kind,
    attestationSha256,
  ]) => {
    const reference = `runtime-vault://postgres/${CONNECTION_ID}/agora/${kind}`;
    return [kind, {
      kind,
      reference,
      version: attestationSha256,
      attestationSha256,
      binding: createHash("sha256").update([
        "winerim-writer-fence-fleet-credential",
        "1",
        CONNECTION_ID,
        RETIREMENT_RUN_ID,
        "agora",
        kind,
        reference,
        attestationSha256,
      ].join("|")).digest("hex"),
    }];
  }));
  const payload = [
    "winerim-writer-fence-credential-bundle",
    "1",
    CONNECTION_ID,
    RETIREMENT_RUN_ID,
    holderId,
    issuedAt,
    expiresAt,
    KEY_VERSION,
    CREDENTIAL_SET_SHA256,
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
  return {
    version: 1,
    keyVersion: KEY_VERSION,
    generationSha256: CREDENTIAL_SET_SHA256,
    credentials,
    bundleSha256: createHash("sha256").update(payload).digest("hex"),
    signatureSha256: createHmac("sha256", proof).update(payload).digest("hex"),
  };
}

function result<Row extends Record<string, unknown>>(rows: Row[]): QueryResult<Row> {
  return { rows, rowCount: rows.length };
}

function database(rows: Record<string, unknown>[]): DatabaseAdapter {
  const query = async <Row extends Record<string, unknown>>(_statement: SqlStatement) => result(rows as Row[]);
  return {
    query,
    transaction: async <T>(work: (transaction: DatabaseTransaction) => Promise<T>) => work({ query }),
  };
}

describe("fail-closed canary packaging", () => {
  it("pins Wrangler-built bundles and smoke-starts consumer and executor in Workerd", () => {
    const renderer = readFileSync(join(
      process.cwd(),
      "infrastructure/runtime/render-failclosed-canary-configs.mjs",
    ), "utf8");
    const smoke = readFileSync(join(
      process.cwd(),
      "infrastructure/runtime/smoke-failclosed-canary.sh",
    ), "utf8");

    expect(renderer).toContain("node_modules/wrangler/bin/wrangler.js");
    expect(renderer).toContain('"--dry-run"');
    expect(renderer).toContain("FAILCLOSED_CANARY_RENDER_NODE_22_REQUIRED");
    expect(renderer).not.toContain('platform: "node"');
    expect(smoke).toContain("workerd_startup_smoke consumer");
    expect(smoke).toContain("workerd_startup_smoke executor");
    expect(smoke).toContain("FAILCLOSED_CANARY_WORKERD_DYNAMIC_REQUIRE_");
  });
});

describe("runtime credential provisioning tooling", () => {
  function canonicalTestJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalTestJson).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalTestJson(record[key])}`
    )).join(",")}}`;
  }

  function adoptExistingEvidence(overrides: Record<string, unknown> = {}) {
    const events = Array.from({ length: 42 }, (_, eventIndex) => ({
      businessDay: "2026-08-03",
      providerDocId: `invoice-${eventIndex}`,
      docType: "INVOICE",
      orderId: `order-${eventIndex}`,
      soldAt: "2026-08-03T20:00:00.000Z",
      lines: Array.from({ length: eventIndex < 11 ? 4 : 3 }, (_, lineIndex) => ({
        providerLineId: `line-${eventIndex}-${lineIndex}`,
        providerProductId: `product-${eventIndex}-${lineIndex}`,
        format: "BOTTLE",
        qty: 1,
        soldAt: "2026-08-03T20:00:00.000Z",
        mapping: { mapped: false, status: "UNMAPPED" },
      })),
    }));
    const sourceArtifact = {
      schemaVersion: "agora-shadow-v2",
      capture: {
        mode: "OBSERVATIONAL_READ_ONLY",
        authoritative: false,
        captureStartedAt: "2026-08-04T11:54:00.000Z",
        captureEndedAt: "2026-08-04T11:55:00.000Z",
        sourceMarkerStable: true,
        consistencyBlocker: "REST_NON_TRANSACTIONAL_AND_WRITER_NOT_FENCED",
      },
      connections: [{
        connectionId: CONNECTION_ID,
        cursor: {
          lastBusinessDaySynced: "2026-08-03",
          lastSyncAt: "2026-08-04T11:55:00.000Z",
        },
        events,
        receipts: Array.from({ length: 43 }, (_, index) => ({
          receiptId: `receipt-${index}`,
          businessDay: "2026-08-03",
          providerDocId: `invoice-${index}`,
          orderId: `order-${index}`,
          status: "SUCCESS",
          live: true,
          stockApplied: true,
          duplicate: false,
          payloadSha256: "a".repeat(64),
        })),
      }],
    };
    const exportManifestSource = Buffer.from(`${JSON.stringify(sourceArtifact)}\n`);
    const exportManifestSha256 = createHash("sha256").update(exportManifestSource).digest("hex");
    const targetArtifact = {
      ...sourceArtifact,
      capture: {
        mode: "POSTGRES_REPEATABLE_READ_ONLY",
        authoritative: true,
        captureStartedAt: "2026-08-04T11:54:00.000Z",
        captureEndedAt: "2026-08-04T11:55:00.000Z",
        sourceMarkerStable: true,
        consistencyBlocker: null,
      },
    };
    const targetManifestSource = Buffer.from(`${JSON.stringify(targetArtifact)}\n`);
    const targetManifestSha256 = createHash("sha256").update(targetManifestSource).digest("hex");
    const reportBody = {
      schemaVersion: "agora-shadow-v2",
      result: "RECONCILED_EXACT",
      dryRun: true,
      writes: false,
      scope: { connectionCount: 1, connectionIds: [CONNECTION_ID] },
      summary: { reconciledConnections: 1, differingConnections: 0, differences: 0 },
      connections: [{
        connectionId: CONNECTION_ID,
        status: "RECONCILED_EXACT",
        events: 42,
        lines: 137,
        receipts: 43,
      }],
      differences: [],
      inputs: {
        lovableSha256: exportManifestSha256,
        ownSha256: targetManifestSha256,
      },
      ...overrides,
    };
    const reconciliation = {
      ...reportBody,
      reportSha256: createHash("sha256").update(canonicalTestJson(reportBody)).digest("hex"),
    };
    const reconciliationManifestSource = Buffer.from(`${JSON.stringify(reconciliation)}\n`);
    return {
      exportManifestSource,
      exportManifestSha256,
      targetManifestSource,
      targetManifestSha256,
      reconciliationManifestSource,
      reconciliationManifestSha256: createHash("sha256").update(reconciliationManifestSource).digest("hex"),
    };
  }

  it("encrypts with the exact vault AAD and keeps credentials inactive", () => {
    const masterKey = Buffer.alloc(32, 7);
    const nonce = Buffer.alloc(12, 3);
    const encrypted = encryptRuntimeCredential({
      connectionId: CONNECTION_ID,
      kind: "agora",
      keyVersion: KEY_VERSION,
      plaintext: "fixture-agora-token",
      masterKey,
      nonce,
    });
    const ciphertextWithTag = Buffer.from(encrypted.ciphertextHex, "hex");
    const ciphertext = ciphertextWithTag.subarray(0, -16);
    const tag = ciphertextWithTag.subarray(-16);
    const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce);
    decipher.setAAD(Buffer.from(runtimeCredentialAad({
      connectionId: CONNECTION_ID,
      kind: "agora",
      keyVersion: KEY_VERSION,
    })));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");

    expect(plaintext).toBe("fixture-agora-token");
    expect(encrypted.attestationSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("opens the provisioned ciphertext through the production vault port", async () => {
    const masterKey = Buffer.alloc(32, 7);
    const encrypted = encryptRuntimeCredential({
      connectionId: CONNECTION_ID,
      kind: "winerim",
      keyVersion: KEY_VERSION,
      plaintext: "fixture-winerim-token",
      masterKey,
      nonce: Buffer.alloc(12, 3),
    });
    const port = createPostgresEncryptedCredentialPort(database([{
      connection_id: CONNECTION_ID,
      provider: "agora",
      credential_kind: "winerim",
      algorithm: "AES-256-GCM",
      key_version: KEY_VERSION,
      aad_version: 1,
      ciphertext_base64: Buffer.from(encrypted.ciphertextHex, "hex").toString("base64"),
      nonce_base64: Buffer.from(encrypted.nonceHex, "hex").toString("base64"),
      active: true,
    }]), {
      masterKey: { get: async () => masterKey.toString("base64") },
      keyVersion: KEY_VERSION,
      runId: RETIREMENT_RUN_ID,
    });

    const opened = await port.open({ connectionId: CONNECTION_ID, provider: "agora", kind: "winerim" });
    expect(await opened?.read()).toBe("fixture-winerim-token");
    expect(opened?.attestation().version).toBe(encrypted.attestationSha256);
  });

  it("renders a fail-closed insert without plaintext, upsert or activation", () => {
    const credentials = ["agora", "winerim"].map((kind, index) => ({
      kind,
      nonceHex: Buffer.alloc(12, index + 1).toString("hex"),
      ciphertextHex: Buffer.alloc(32, index + 4).toString("hex"),
      attestationSha256: "a".repeat(64),
    }));
    const sql = renderCredentialProvisioningSql({
      connectionId: CONNECTION_ID,
      runId: RETIREMENT_RUN_ID,
      keyVersion: KEY_VERSION,
      credentials,
    });

    expect(sql).toContain("credential vault is not empty; use versioned rotate mode");
    expect(sql).toContain("LOCK TABLE public.pos_connections");
    expect(sql).toContain(`WHERE connection_id = '${CONNECTION_ID}'::uuid`);
    expect(sql).toContain(`run_id = '${RETIREMENT_RUN_ID}'`);
    expect(sql).toContain("active = false");
    expect(sql).toContain("'PULL_ONLY'");
    expect(sql).toContain("'NONE'");
    expect(sql).not.toMatch(/ON CONFLICT|DO UPDATE/i);
    expect(sql.match(/\n {4}false\n/g)).toHaveLength(2);
    expect(sql).not.toContain("fixture-agora-token");
  });

  it("renders an inactive versioned rotation that preserves credential history", () => {
    const credentials = ["agora", "winerim"].map((kind, index) => ({
      kind,
      nonceHex: Buffer.alloc(12, index + 1).toString("hex"),
      ciphertextHex: Buffer.alloc(32, index + 4).toString("hex"),
      attestationSha256: "a".repeat(64),
    }));
    const sql = renderCredentialProvisioningSql({
      connectionId: CONNECTION_ID,
      runId: "elbejeque-20260803-b",
      keyVersion: "elbejeque-v2",
      credentials,
      mode: "rotate",
    });

    expect(sql).toContain("credential rotation requires a complete retired generation");
    expect(sql).toContain("credential rotation history is incomplete or still active");
    expect(sql).not.toMatch(/DELETE\s+FROM|ON CONFLICT|DO UPDATE/i);
    expect(sql.match(/\n {4}false\n/g)).toHaveLength(2);
  });

  it("renders adopt-existing only when exact historical and cursor evidence is bound", () => {
    const evidence = adoptExistingEvidence();
    const adoption = validateAdoptExistingEvidence({ connectionId: CONNECTION_ID, ...evidence });
    const credentials = ["agora", "winerim"].map((kind, index) => ({
      kind,
      nonceHex: Buffer.alloc(12, index + 1).toString("hex"),
      ciphertextHex: Buffer.alloc(32, index + 4).toString("hex"),
      attestationSha256: String.fromCharCode(97 + index).repeat(64),
    }));
    const sql = renderCredentialProvisioningSql({
      connectionId: CONNECTION_ID,
      runId: "imported-20260804-a",
      keyVersion: "imported-v1",
      credentials,
      mode: "adopt-existing",
      adoption,
    });

    expect(sql).toContain("adopt-existing requires an empty credential vault");
    expect(sql).toContain("adopt-existing sales event watermark mismatch");
    expect(sql).toContain(") <> 42 THEN");
    expect(sql).toContain(") <> 137 THEN");
    expect(sql).toContain("'2026-08-03'");
    expect(sql).toContain("'2026-08-04T11:55:00.000Z'");
    expect(sql).toContain(`'adopt-existing:v3:${adoption.bindingSha256}'`);
    expect(sql).toContain("AND enabled = false");
    expect(sql).toContain("AND catalog_sync_enabled = false");
    expect(sql).toContain("active = false");
    expect(sql).toContain(`WHERE connection_id = '${CONNECTION_ID}'::uuid\n    AND active = true`);
    expect(sql).toContain("runtime canary or credential is already active for connection");
    expect(sql).not.toMatch(/ON CONFLICT|DO UPDATE|DELETE\s+FROM/i);
  });

  it("writes an inactive encrypted adopt-existing artifact with exact evidence hashes", () => {
    const directory = mkdtempSync(join(tmpdir(), "runtime-adopt-existing."));
    const output = join(directory, "credentials.sql");
    const exportPath = join(directory, "export-manifest.json");
    const targetPath = join(directory, "target-manifest.json");
    const reconciliationPath = join(directory, "reconciliation.json");
    const evidence = adoptExistingEvidence();
    writeFileSync(exportPath, evidence.exportManifestSource, { mode: 0o600 });
    writeFileSync(targetPath, evidence.targetManifestSource, { mode: 0o600 });
    writeFileSync(reconciliationPath, evidence.reconciliationManifestSource, { mode: 0o600 });
    const result = prepareCredentialProvisioning({
      mode: "adopt-existing",
      output,
      environment: {
        CANARY_CONNECTION_ID: CONNECTION_ID,
        CANARY_RUN_ID: "imported-20260804-a",
        RUNTIME_VAULT_KEY_VERSION: "imported-v1",
        RUNTIME_VAULT_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
        RUNTIME_AGORA_CREDENTIAL: "fixture-agora-sensitive",
        RUNTIME_WINERIM_CREDENTIAL: "fixture-winerim-sensitive",
        RUNTIME_ADOPT_EXPORT_MANIFEST: exportPath,
        RUNTIME_ADOPT_EXPORT_MANIFEST_SHA256: evidence.exportManifestSha256,
        RUNTIME_ADOPT_TARGET_MANIFEST: targetPath,
        RUNTIME_ADOPT_TARGET_MANIFEST_SHA256: evidence.targetManifestSha256,
        RUNTIME_ADOPT_RECONCILIATION_MANIFEST: reconciliationPath,
        RUNTIME_ADOPT_RECONCILIATION_MANIFEST_SHA256: evidence.reconciliationManifestSha256,
      },
    });
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));

    expect(result).toMatchObject({ mode: "adopt-existing", active: false, remoteMutations: 0 });
    expect(manifest).toMatchObject({
      version: 3,
      mode: "adopt-existing",
      active: false,
      activationAllowed: false,
      activationBlockReason: "ADOPT_EXISTING_ACTIVATION_REQUIRES_SEPARATE_REVIEWED_GATE",
      scopeGenerationMode: "bootstrap",
      adoption: {
        version: 3,
        kind: "AGORA_SHADOW_RECONCILIATION_EVIDENCE",
        schemaVersion: "agora-shadow-v2",
        connectionId: CONNECTION_ID,
        exportManifestSha256: evidence.exportManifestSha256,
        reconciliationManifestSha256: evidence.reconciliationManifestSha256,
        reconciliationReportSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        sourceDatasetSha256: evidence.exportManifestSha256,
        targetDatasetSha256: evidence.targetManifestSha256,
        watermarks: { salesEvents: 42, salesLineItems: 137 },
      },
    });
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(statSync(result.manifestPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(output, "utf8")).not.toContain("fixture-agora-sensitive");
    expect(readFileSync(output, "utf8")).not.toContain("fixture-winerim-sensitive");
  });

  it("rejects adopt-existing on hash mismatch, non-v2 reports, dataset self-comparison, or forged bindings", () => {
    const evidence = adoptExistingEvidence();
    expect(() => validateAdoptExistingEvidence({
      connectionId: CONNECTION_ID,
      ...evidence,
      exportManifestSha256: "0".repeat(64),
    })).toThrow("RUNTIME_CREDENTIAL_PROVISION_EXPORT_MANIFEST_SHA256_MISMATCH");

    const legacy = adoptExistingEvidence({ schemaVersion: "agora-shadow-v1" });
    expect(() => validateAdoptExistingEvidence({ connectionId: CONNECTION_ID, ...legacy }))
      .toThrow("RUNTIME_CREDENTIAL_PROVISION_ADOPTION_RECONCILIATION_NOT_EXACT");

    const writes = adoptExistingEvidence({ writes: true });
    expect(() => validateAdoptExistingEvidence({ connectionId: CONNECTION_ID, ...writes }))
      .toThrow("RUNTIME_CREDENTIAL_PROVISION_ADOPTION_RECONCILIATION_NOT_EXACT");

    const selfCompared = adoptExistingEvidence({
      inputs: {
        lovableSha256: adoptExistingEvidence().exportManifestSha256,
        ownSha256: adoptExistingEvidence().exportManifestSha256,
      },
    });
    expect(() => validateAdoptExistingEvidence({ connectionId: CONNECTION_ID, ...selfCompared }))
      .toThrow("RUNTIME_CREDENTIAL_PROVISION_INVALID_SHADOW_REPORT_DATASET_HASHES");

    const forgedDigest = adoptExistingEvidence();
    const forgedReport = JSON.parse(forgedDigest.reconciliationManifestSource.toString("utf8"));
    forgedReport.reportSha256 = "f".repeat(64);
    const forgedReportSource = Buffer.from(`${JSON.stringify(forgedReport)}\n`);
    expect(() => validateAdoptExistingEvidence({
      connectionId: CONNECTION_ID,
      exportManifestSource: forgedDigest.exportManifestSource,
      exportManifestSha256: forgedDigest.exportManifestSha256,
      targetManifestSource: forgedDigest.targetManifestSource,
      targetManifestSha256: forgedDigest.targetManifestSha256,
      reconciliationManifestSource: forgedReportSource,
      reconciliationManifestSha256: createHash("sha256").update(forgedReportSource).digest("hex"),
    })).toThrow("RUNTIME_CREDENTIAL_PROVISION_SHADOW_REPORT_SHA256_MISMATCH");

    const declarativeSource = Buffer.from(`${JSON.stringify({
      version: 1,
      status: "RECONCILED_EXACT",
      connectionId: CONNECTION_ID,
      watermarks: { salesEvents: 42, salesLineItems: 137 },
    })}\n`);
    expect(() => validateAdoptExistingEvidence({
      connectionId: CONNECTION_ID,
      exportManifestSource: declarativeSource,
      exportManifestSha256: createHash("sha256").update(declarativeSource).digest("hex"),
      targetManifestSource: evidence.targetManifestSource,
      targetManifestSha256: evidence.targetManifestSha256,
      reconciliationManifestSource: evidence.reconciliationManifestSource,
      reconciliationManifestSha256: evidence.reconciliationManifestSha256,
    })).toThrow("RUNTIME_CREDENTIAL_PROVISION_INVALID_SHADOW_SOURCE_STRUCTURE");

    const declarativeReportSource = Buffer.from(`${JSON.stringify({
      version: 1,
      status: "RECONCILED_EXACT",
      connectionId: CONNECTION_ID,
      exportManifestSha256: evidence.exportManifestSha256,
      watermarks: { salesEvents: 42, salesLineItems: 137 },
    })}\n`);
    expect(() => validateAdoptExistingEvidence({
      connectionId: CONNECTION_ID,
      exportManifestSource: evidence.exportManifestSource,
      exportManifestSha256: evidence.exportManifestSha256,
      targetManifestSource: evidence.targetManifestSource,
      targetManifestSha256: evidence.targetManifestSha256,
      reconciliationManifestSource: declarativeReportSource,
      reconciliationManifestSha256: createHash("sha256")
        .update(declarativeReportSource)
        .digest("hex"),
    })).toThrow("RUNTIME_CREDENTIAL_PROVISION_INVALID_SHADOW_REPORT_STRUCTURE");

    const adoption = validateAdoptExistingEvidence({ connectionId: CONNECTION_ID, ...evidence });
    const credentials = ["agora", "winerim"].map((kind) => ({
      kind,
      nonceHex: "1".repeat(24),
      ciphertextHex: "2".repeat(64),
      attestationSha256: "3".repeat(64),
    }));
    expect(() => renderCredentialProvisioningSql({
      connectionId: CONNECTION_ID,
      runId: "imported-20260804-a",
      keyVersion: "imported-v1",
      credentials,
      mode: "adopt-existing",
      adoption: { ...adoption, bindingSha256: "f".repeat(64) },
    })).toThrow("RUNTIME_CREDENTIAL_PROVISION_ADOPTION_BINDING_MISMATCH");
    expect(() => renderCredentialProvisioningSql({
      connectionId: CONNECTION_ID,
      runId: "imported-20260804-a",
      keyVersion: "imported-v1",
      credentials,
      mode: "adopt-existing",
    })).toThrow("RUNTIME_CREDENTIAL_PROVISION_INVALID_ADOPTION_EVIDENCE");
  });

  it("writes a private encrypted artifact and returns only non-secret metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "runtime-credential-provision."));
    const output = join(directory, "credentials.sql");
    const environment = {
      CANARY_CONNECTION_ID: CONNECTION_ID,
      CANARY_RUN_ID: RETIREMENT_RUN_ID,
      RUNTIME_VAULT_KEY_VERSION: KEY_VERSION,
      RUNTIME_VAULT_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
      RUNTIME_AGORA_CREDENTIAL: "fixture-agora-sensitive",
      RUNTIME_WINERIM_CREDENTIAL: "fixture-winerim-sensitive",
    };
    const result = prepareCredentialProvisioning({ environment, output });
    const sql = readFileSync(output, "utf8");

    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(result).toMatchObject({ remoteMutations: 0, active: false, connectionId: CONNECTION_ID });
    expect(JSON.stringify(result)).not.toContain(environment.RUNTIME_VAULT_MASTER_KEY);
    expect(JSON.stringify(result)).not.toContain(environment.RUNTIME_AGORA_CREDENTIAL);
    expect(JSON.stringify(result)).not.toContain(environment.RUNTIME_WINERIM_CREDENTIAL);
    expect(sql).not.toContain(environment.RUNTIME_VAULT_MASTER_KEY);
    expect(sql).not.toContain(environment.RUNTIME_AGORA_CREDENTIAL);
    expect(sql).not.toContain(environment.RUNTIME_WINERIM_CREDENTIAL);
    expect(credentialProvisioningPlan()).toMatchObject({ remoteMutations: 0, insertsActiveCredentials: false });
  });

  it("rejects credential artifacts inside the repository", () => {
    expect(() => prepareCredentialProvisioning({
      environment: {
        CANARY_CONNECTION_ID: CONNECTION_ID,
        CANARY_RUN_ID: RETIREMENT_RUN_ID,
        RUNTIME_VAULT_KEY_VERSION: KEY_VERSION,
        RUNTIME_VAULT_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
        RUNTIME_AGORA_CREDENTIAL: "fixture-agora-sensitive",
        RUNTIME_WINERIM_CREDENTIAL: "fixture-winerim-sensitive",
      },
      output: join(process.cwd(), "credential-artifact-must-not-exist.sql"),
    })).toThrow("RUNTIME_CREDENTIAL_PROVISION_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  });
});

describe("writer fence external evidence tooling", () => {
  function grantEnvironment(directory: string, options: ExternalFenceOptions = {}) {
    const artifact = externalFenceArtifact(options);
    const evidencePath = join(directory, "lovable-writer-fence-evidence.json");
    const publicKeyPath = join(directory, "lovable-writer-fence-observer.pem");
    writeFileSync(evidencePath, artifact.source, { mode: 0o600 });
    writeFileSync(publicKeyPath, artifact.publicKey, { mode: 0o600 });
    return {
      environment: {
        CANARY_CONNECTION_ID: CONNECTION_ID,
        CANARY_RUN_ID: RETIREMENT_RUN_ID,
        CANARY_HOLDER_ID: "release-a",
        CANARY_WRITER_FENCE_PROOF: "fixture-proof-secret-with-more-than-32-bytes",
        CANARY_EXCLUSIVE_CREDENTIAL_REF: `runtime-vault://postgres/${CONNECTION_ID}/agora/agora`,
        CANARY_EXCLUSIVE_CREDENTIAL_VERSION: "a".repeat(64),
        RUNTIME_VAULT_KEY_VERSION: KEY_VERSION,
        CANARY_AGORA_CREDENTIAL_VERSION: "a".repeat(64),
        CANARY_WINERIM_CREDENTIAL_VERSION: "b".repeat(64),
        CANARY_BOOTSTRAP_ACTIVE_CONNECTION_COUNT: "0",
        CANARY_BOOTSTRAP_ACTIVE_CREDENTIAL_COUNT: "0",
        CANARY_BOOTSTRAP_ACTIVE_SCOPE_COUNT: "0",
        CANARY_BOOTSTRAP_PRIOR_RUN_COUNT: "0",
        CANARY_BOOTSTRAP_ACTIVE_PRODUCER_COUNT: "0",
        CANARY_BOOTSTRAP_ACTIVE_CONSUMER_COUNT: "0",
        CANARY_FENCE_ISSUED_AT: "2026-08-03T11:55:00.000Z",
        CANARY_FENCE_EXPIRES_AT: EXPIRES_AT,
        WRITER_FENCE_MODE: "bootstrap-no-legacy-writer",
        CANARY_RUNTIME_JOB: "catalog.sync-master",
        CANARY_RUNTIME_LANE: "catalog",
        CANARY_CATALOG_PRODUCT_ID: "500001",
        NO_LEGACY_WRITER_EXTERNAL_EVIDENCE: evidencePath,
        NO_LEGACY_WRITER_EXTERNAL_EVIDENCE_SHA256: artifact.artifactSha256,
        NO_LEGACY_WRITER_EXTERNAL_PUBLIC_KEY: publicKeyPath,
        NO_LEGACY_WRITER_EXTERNAL_PUBLIC_KEY_SHA256: artifact.publicKeySha256,
      },
      artifact,
      evidencePath,
    };
  }

  it("creates a parser-valid v3 bootstrap grant with both credential attestations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "writer-fence-grant."));
    const fixture = grantEnvironment(directory);
    const output = join(directory, "writer-fence-grant.json");
    const result = prepareWriterFenceGrant({ environment: fixture.environment, output });

    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(result.grant).toMatchObject({
      version: 3,
      credentialBundle: {
        version: 1,
        keyVersion: KEY_VERSION,
        credentials: {
          agora: { kind: "agora", attestationSha256: "a".repeat(64) },
          winerim: { kind: "winerim", attestationSha256: "b".repeat(64) },
        },
      },
      writerHistory: {
        mode: "bootstrap-no-legacy-writer",
        absence: {
          activeConnectionCount: 0,
          activeCredentialCount: 0,
          activeScopeCount: 0,
          priorRunCount: 0,
          activeProducerCount: 0,
          activeConsumerCount: 0,
        },
        externalEvidence: {
          artifactSha256: fixture.artifact.artifactSha256,
          fenceMode: "lovable-disabled-no-agora-rotation",
          readbackObservedAt: [
            "2026-08-03T11:52:10.000Z",
            "2026-08-03T11:54:00.000Z",
          ],
        },
      },
    });
    const parsed = parseWriterFenceGrant(readFileSync(output, "utf8"));
    await expect(validateWriterFenceGrant({
      grant: parsed,
      proof: fixture.environment.CANARY_WRITER_FENCE_PROOF,
      connectionId: CONNECTION_ID,
      runId: RETIREMENT_RUN_ID,
      holderId: "release-a",
      nowMs: Date.parse("2026-08-03T11:56:00.000Z"),
    })).resolves.toBeUndefined();
  });

  it("rejects old counters, one no-rotation readback, stale evidence and a tampered payload", () => {
    const directory = mkdtempSync(join(tmpdir(), "writer-fence-reject."));
    const fixture = grantEnvironment(directory);
    const legacyCounterEnvironment = {
      ...fixture.environment,
      NO_LEGACY_WRITER_EXTERNAL_EVIDENCE: "",
      NO_LEGACY_WRITER_EXTERNAL_EVIDENCE_SHA256: "",
      NO_LEGACY_WRITER_ACTIVE_CONNECTION_COUNT: "0",
      NO_LEGACY_WRITER_ACTIVE_CREDENTIAL_COUNT: "0",
      NO_LEGACY_WRITER_ACTIVE_SCOPE_COUNT: "0",
    };
    expect(() => prepareWriterFenceGrant({
      environment: legacyCounterEnvironment,
      output: join(directory, "old-counters-must-not-exist.json"),
    })).toThrow("WRITER_FENCE_GRANT_MISSING_NO_LEGACY_WRITER_EXTERNAL_EVIDENCE_SHA256");

    const oneReadback = grantEnvironment(mkdtempSync(join(tmpdir(), "writer-fence-one-readback.")), {
      readbacks: ["2026-08-03T11:54:00.000Z"],
    });
    expect(() => prepareWriterFenceGrant({
      environment: oneReadback.environment,
      output: join(directory, "one-readback-must-not-exist.json"),
    })).toThrow("WRITER_FENCE_GRANT_EXTERNAL_NO_ROTATION_REQUIRES_TWO_READBACKS");

    expect(() => prepareWriterFenceGrant({
      environment: {
        ...fixture.environment,
        CANARY_FENCE_ISSUED_AT: "2026-08-03T12:20:00.000Z",
      },
      output: join(directory, "stale-must-not-exist.json"),
    })).toThrow("WRITER_FENCE_GRANT_BOOTSTRAP_EVIDENCE_MUST_BE_FRESH");

    const envelope = JSON.parse(readFileSync(fixture.evidencePath, "utf8"));
    envelope.payload.lovable.cronDisabled = false;
    const tamperedSource = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`);
    writeFileSync(fixture.evidencePath, tamperedSource, { mode: 0o600 });
    expect(() => prepareWriterFenceGrant({
      environment: {
        ...fixture.environment,
        NO_LEGACY_WRITER_EXTERNAL_EVIDENCE_SHA256: createHash("sha256")
          .update(tamperedSource)
          .digest("hex"),
      },
      output: join(directory, "tampered-must-not-exist.json"),
    })).toThrow("WRITER_FENCE_GRANT_EXTERNAL_EVIDENCE_SIGNATURE_INVALID");
  });

  it("accepts a rotated Agora credential with a rejected old credential probe", () => {
    const summary = externalFenceSummary({ fenceMode: "agora-credential-rotated" });
    expect(summary).toMatchObject({
      fenceMode: "agora-credential-rotated",
      readbackObservedAt: ["2026-08-03T11:54:00.000Z"],
    });
  });
});

describe("rescue canary activation tooling", () => {
  function writerFenceGrant(kind: "agora" | "winerim" = "winerim") {
    const exclusiveCredentialRef = `runtime-vault://postgres/${CONNECTION_ID}/agora/${kind}`;
    const credentialVersion = kind === "agora" ? "a".repeat(64) : "b".repeat(64);
    return {
      version: 1,
      connectionId: CONNECTION_ID,
      runId: RETIREMENT_RUN_ID,
      holderId: "release-a",
      proofSha256: "a".repeat(64),
      exclusiveCredentialRef,
      credentialVersion,
      credentialBinding: createHash("sha256").update([
        "winerim-writer-fence-credential",
        "1",
        exclusiveCredentialRef,
        credentialVersion,
      ].join("|")).digest("hex"),
      legacyWriter: {
        revokedAt: "2026-08-03T11:50:00.000Z",
        negativeProbeStatus: 401,
        evidenceSha256: "d".repeat(64),
      },
      issuedAt: "2026-08-03T11:55:00.000Z",
      expiresAt: EXPIRES_AT,
    };
  }

  function bootstrapWriterFenceGrant(externalEvidence = externalFenceSummary()) {
    return {
      version: 3,
      connectionId: CONNECTION_ID,
      runId: RETIREMENT_RUN_ID,
      holderId: "release-a",
      proofSha256: "a".repeat(64),
      credentialBundle: v3CredentialBundle(),
      writerHistory: {
        mode: "bootstrap-no-legacy-writer",
        verifiedAt: externalEvidence.observedAt,
        externalEvidence,
      },
      issuedAt: "2026-08-03T11:55:00.000Z",
      expiresAt: EXPIRES_AT,
    };
  }

  it("renders one atomic first-canary activation with exact generation and replay gate", () => {
    const sql = renderRescueCanaryActivationSql({
      connectionId: CONNECTION_ID,
      runId: RETIREMENT_RUN_ID,
      approvedAt: APPROVED_AT,
      expiresAt: EXPIRES_AT,
      keyVersion: KEY_VERSION,
      legacyWriterRevokedAt: "2026-08-03T11:50:00.000Z",
      credentialAttestations: CREDENTIAL_ATTESTATIONS,
      credentialSetSha256: CREDENTIAL_SET_SHA256,
      deploymentManifestSha256: "e".repeat(64),
      writerFenceGrantSha256: "f".repeat(64),
    });

    expect(sql).toContain("LOCK TABLE public.pos_connections");
    expect(sql).toContain(`run_id = '${RETIREMENT_RUN_ID}'`);
    expect(sql).toContain(`key_version = '${KEY_VERSION}'`);
    expect(sql).toContain("interval '130 seconds'");
    expect(sql).toContain("bootstrap canary activation requires zero operational rows");
    expect(sql).toContain("catalog_sync_enabled = false");
    expect(sql).toContain("write_mode = 'NONE'");
    expect(sql).not.toMatch(/DELETE\s+FROM|TRUNCATE|backfill_days\s*=\s*[1-9]/i);
  });

  it("binds activation to exact deployment and revoked-writer evidence", () => {
    const plan = rescueCanaryActivationPlan({
      connectionId: CONNECTION_ID,
      runId: RETIREMENT_RUN_ID,
      approvedAt: APPROVED_AT,
      expiresAt: EXPIRES_AT,
      keyVersion: KEY_VERSION,
      deploymentManifest: deploymentManifest(),
      deploymentManifestSha256: "e".repeat(64),
      writerFenceGrant: writerFenceGrant(),
      writerFenceGrantSha256: "f".repeat(64),
      credentialProvisioningManifest: credentialProvisioningManifest(),
      credentialProvisioningManifestSha256: "8".repeat(64),
      deploymentConfigSha256: DEPLOYMENT_CONFIG_SHA256,
      deploymentBundleSha256: DEPLOYMENT_BUNDLE_SHA256,
    });

    expect(plan).toMatchObject({
      remoteMutations: 0,
      connectionId: CONNECTION_ID,
      runId: RETIREMENT_RUN_ID,
      activation: {
        oneConnection: true,
        catalogDisabled: true,
        exclusiveWriterCredentialKind: "winerim",
        agoraCredentialMode: "shared-read-only",
        firstCanaryRequiresZeroOperationalRows: true,
      },
    });
  });

  it("feeds a generated v3 credential bundle into activation and rejects bundle drift", () => {
    const directory = mkdtempSync(join(tmpdir(), "writer-fence-v3-activation."));
    const proof = "fixture-proof-secret-with-more-than-32-bytes";
    const generated = prepareWriterFenceGrant({
      environment: {
        CANARY_CONNECTION_ID: CONNECTION_ID,
        CANARY_RUN_ID: RETIREMENT_RUN_ID,
        CANARY_HOLDER_ID: "release-a",
        CANARY_WRITER_FENCE_PROOF: proof,
        CANARY_WRITER_FENCE_GRANT_VERSION: "3",
        RUNTIME_VAULT_KEY_VERSION: KEY_VERSION,
        CANARY_AGORA_CREDENTIAL_VERSION: CREDENTIAL_ATTESTATIONS.agora,
        CANARY_WINERIM_CREDENTIAL_VERSION: CREDENTIAL_ATTESTATIONS.winerim,
        CANARY_FENCE_ISSUED_AT: "2026-08-03T11:55:00.000Z",
        CANARY_FENCE_EXPIRES_AT: EXPIRES_AT,
        WRITER_FENCE_MODE: "legacy-writer-revoked",
        LEGACY_WRITER_REVOKED_AT: "2026-08-03T11:50:00.000Z",
        LEGACY_WRITER_NEGATIVE_PROBE_STATUS: "401",
        LEGACY_WRITER_EVIDENCE_SHA256: "d".repeat(64),
      },
      output: join(directory, "writer-fence-grant.json"),
    });
    const manifest = deploymentManifest();
    manifest.writerFence.proofSha256 = generated.grant.proofSha256;
    const activationInput = {
      connectionId: CONNECTION_ID,
      runId: RETIREMENT_RUN_ID,
      approvedAt: APPROVED_AT,
      expiresAt: EXPIRES_AT,
      keyVersion: KEY_VERSION,
      deploymentManifest: manifest,
      deploymentManifestSha256: "e".repeat(64),
      writerFenceGrantSha256: generated.grantSha256,
      credentialProvisioningManifest: credentialProvisioningManifest(),
      credentialProvisioningManifestSha256: "8".repeat(64),
      deploymentConfigSha256: DEPLOYMENT_CONFIG_SHA256,
      deploymentBundleSha256: DEPLOYMENT_BUNDLE_SHA256,
    };

    expect(generated.grant).not.toHaveProperty("exclusiveCredentialRef");
    expect(generated.grant).not.toHaveProperty("credentialVersion");
    expect(generated.grant).not.toHaveProperty("credentialBinding");
    expect(rescueCanaryActivationPlan({
      ...activationInput,
      writerFenceGrant: generated.grant,
    })).toMatchObject({
      credentialSetSha256: CREDENTIAL_SET_SHA256,
      credentialAttestations: CREDENTIAL_ATTESTATIONS,
      activation: { exclusiveWriterCredentialKind: "winerim" },
    });

    expect(() => rescueCanaryActivationPlan({
      ...activationInput,
      writerFenceGrant: {
        ...generated.grant,
        credentialBundle: {
          ...generated.grant.credentialBundle,
          generationSha256: "0".repeat(64),
        },
      },
    })).toThrow("RESCUE_CANARY_ACTIVATION_WRITER_FENCE_CREDENTIAL_GENERATION_MISMATCH");
    expect(() => rescueCanaryActivationPlan({
      ...activationInput,
      writerFenceGrant: {
        ...generated.grant,
        credentialBundle: {
          ...generated.grant.credentialBundle,
          bundleSha256: "0".repeat(64),
        },
      },
    })).toThrow("RESCUE_CANARY_ACTIVATION_WRITER_FENCE_CREDENTIAL_BUNDLE_MISMATCH");
    expect(() => rescueCanaryActivationPlan({
      ...activationInput,
      writerFenceGrant: {
        ...generated.grant,
        exclusiveCredentialRef: manifest.writerFence.exclusiveCredentialRef,
      },
    })).toThrow("RESCUE_CANARY_ACTIVATION_WRITER_FENCE_V3_TOP_LEVEL_CREDENTIAL_FORBIDDEN");
  });

  it.each([
    ["v3", deploymentManifest()],
    ["v4", salesV4DeploymentManifest()],
  ])("keeps live-sales %s compatible with the legacy writer grant", (_version, manifest) => {
    const plan = rescueCanaryActivationPlan({
      connectionId: CONNECTION_ID,
      runId: RETIREMENT_RUN_ID,
      approvedAt: APPROVED_AT,
      expiresAt: EXPIRES_AT,
      keyVersion: KEY_VERSION,
      deploymentManifest: manifest,
      deploymentManifestSha256: "e".repeat(64),
      writerFenceGrant: writerFenceGrant(),
      writerFenceGrantSha256: "f".repeat(64),
      credentialProvisioningManifest: credentialProvisioningManifest(),
      credentialProvisioningManifestSha256: "8".repeat(64),
      deploymentConfigSha256: DEPLOYMENT_CONFIG_SHA256,
      deploymentBundleSha256: DEPLOYMENT_BUNDLE_SHA256,
    });

    expect(plan).toMatchObject({
      writerFenceMode: "legacy-writer-revoked",
      activation: {
        job: "winerim.sales-import-live",
        lane: "sales-import",
        exclusiveWriterCredentialKind: "winerim",
      },
    });
  });

  it("binds a versioned catalog canary to one product and the exclusive Agora credential", () => {
    const plan = rescueCanaryActivationPlan({
      connectionId: CONNECTION_ID,
      runId: RETIREMENT_RUN_ID,
      approvedAt: APPROVED_AT,
      expiresAt: EXPIRES_AT,
      keyVersion: KEY_VERSION,
      deploymentManifest: catalogDeploymentManifest(),
      deploymentManifestSha256: "e".repeat(64),
      writerFenceGrant: writerFenceGrant("agora"),
      writerFenceGrantSha256: "f".repeat(64),
      credentialProvisioningManifest: credentialProvisioningManifest(),
      credentialProvisioningManifestSha256: "8".repeat(64),
      deploymentConfigSha256: DEPLOYMENT_CONFIG_SHA256,
      deploymentBundleSha256: DEPLOYMENT_BUNDLE_SHA256,
    });

    expect(plan.activation).toMatchObject({
      job: "catalog.sync-master",
      lane: "catalog",
      maxOperations: 1,
      productId: "500001",
      catalogDisabled: false,
      exclusiveWriterCredentialKind: "agora",
      agoraCredentialMode: "exclusive-writer",
      winerimMutation: false,
    });
    expect(plan.forbidden).toEqual(expect.arrayContaining([
      "agora-outbound-write",
      "winerim-mutation",
      "shared-queue",
    ]));
    expect(plan.forbidden).not.toContain("agora-catalog-write");
  });

  it("binds a no-legacy bootstrap to signed external evidence and an exclusive Agora scope", () => {
    const externalEvidence = externalFenceSummary();
    const plan = rescueCanaryActivationPlan({
      connectionId: CONNECTION_ID,
      runId: RETIREMENT_RUN_ID,
      approvedAt: APPROVED_AT,
      expiresAt: EXPIRES_AT,
      keyVersion: KEY_VERSION,
      deploymentManifest: bootstrapCatalogDeploymentManifest(),
      deploymentManifestSha256: "e".repeat(64),
      writerFenceGrant: bootstrapWriterFenceGrant(externalEvidence),
      writerFenceGrantSha256: "f".repeat(64),
      credentialProvisioningManifest: credentialProvisioningManifest(),
      credentialProvisioningManifestSha256: "8".repeat(64),
      deploymentConfigSha256: DEPLOYMENT_CONFIG_SHA256,
      deploymentBundleSha256: DEPLOYMENT_BUNDLE_SHA256,
      externalWriterFenceEvidence: externalEvidence,
    });
    const sql = renderRescueCanaryActivationSql({
      connectionId: CONNECTION_ID,
      runId: RETIREMENT_RUN_ID,
      approvedAt: APPROVED_AT,
      expiresAt: EXPIRES_AT,
      keyVersion: KEY_VERSION,
      writerFenceMode: plan.writerFenceMode,
      writerFenceEvidenceAt: plan.writerFenceEvidenceAt,
      credentialAttestations: CREDENTIAL_ATTESTATIONS,
      credentialSetSha256: CREDENTIAL_SET_SHA256,
      deploymentManifestSha256: "e".repeat(64),
      writerFenceGrantSha256: "f".repeat(64),
    });

    expect(plan).toMatchObject({
      writerFenceMode: "bootstrap-no-legacy-writer",
      activation: {
        job: "catalog.sync-master",
        productId: "500001",
        exclusiveWriterCredentialKind: "agora",
      },
    });
    expect(sql).toContain("bootstrap-no-legacy-writer requires zero prior scopes, runs, or credentials");
    expect(sql).toContain(`run_id <> '${RETIREMENT_RUN_ID}'`);
  });

  it("rejects a bootstrap whose external evidence binding changed or uses a sales scope", () => {
    const externalEvidence = externalFenceSummary();
    const base = {
      connectionId: CONNECTION_ID,
      runId: RETIREMENT_RUN_ID,
      approvedAt: APPROVED_AT,
      expiresAt: EXPIRES_AT,
      keyVersion: KEY_VERSION,
      deploymentManifest: bootstrapCatalogDeploymentManifest(),
      deploymentManifestSha256: "e".repeat(64),
      writerFenceGrantSha256: "f".repeat(64),
      credentialProvisioningManifest: credentialProvisioningManifest(),
      credentialProvisioningManifestSha256: "8".repeat(64),
      deploymentConfigSha256: DEPLOYMENT_CONFIG_SHA256,
      deploymentBundleSha256: DEPLOYMENT_BUNDLE_SHA256,
      externalWriterFenceEvidence: externalEvidence,
    };
    const grant = bootstrapWriterFenceGrant(externalEvidence);
    expect(() => rescueCanaryActivationPlan({
      ...base,
      externalWriterFenceEvidence: null,
      writerFenceGrant: grant,
    })).toThrow("RESCUE_CANARY_ACTIVATION_WRITER_FENCE_GRANT_MISMATCH");
    expect(() => rescueCanaryActivationPlan({
      ...base,
      writerFenceGrant: {
        ...grant,
        writerHistory: {
          ...grant.writerHistory,
          externalEvidence: {
            ...grant.writerHistory.externalEvidence,
            artifactSha256: "0".repeat(64),
          },
        },
      },
    })).toThrow("RESCUE_CANARY_ACTIVATION_WRITER_FENCE_GRANT_MISMATCH");

    expect(() => rescueCanaryActivationPlan({
      ...base,
      deploymentManifest: {
        ...salesV4DeploymentManifest(),
        writerFence: {
          ...salesV4DeploymentManifest().writerFence,
          mode: "bootstrap-no-legacy-writer",
        },
      },
      writerFenceGrant: grant,
    })).toThrow("RESCUE_CANARY_ACTIVATION_DEPLOYMENT_MANIFEST_SCOPE_MISMATCH");
  });

  it("rejects activation when the deployment could mutate Agora with a shared credential", () => {
    const unsafe = {
      ...deploymentManifest(),
      mutationPolicy: {
        agoraCatalogApply: true,
        agoraOutboundMutation: false,
        winerimMutation: true,
      },
    };
    expect(() => rescueCanaryActivationPlan({
      connectionId: CONNECTION_ID,
      runId: RETIREMENT_RUN_ID,
      approvedAt: APPROVED_AT,
      expiresAt: EXPIRES_AT,
      keyVersion: KEY_VERSION,
      deploymentManifest: unsafe,
      deploymentManifestSha256: "e".repeat(64),
      writerFenceGrant: writerFenceGrant(),
      writerFenceGrantSha256: "f".repeat(64),
      credentialProvisioningManifest: credentialProvisioningManifest(),
      credentialProvisioningManifestSha256: "8".repeat(64),
      deploymentConfigSha256: DEPLOYMENT_CONFIG_SHA256,
      deploymentBundleSha256: DEPLOYMENT_BUNDLE_SHA256,
    })).toThrow("RESCUE_CANARY_ACTIVATION_DEPLOYMENT_MANIFEST_SCOPE_MISMATCH");
  });

  it("rejects activation before the legacy lease and network drain elapsed", () => {
    const unsafeGrant = {
      ...writerFenceGrant(),
      issuedAt: "2026-08-03T11:51:00.000Z",
    };
    expect(() => rescueCanaryActivationPlan({
      connectionId: CONNECTION_ID,
      runId: RETIREMENT_RUN_ID,
      approvedAt: APPROVED_AT,
      expiresAt: EXPIRES_AT,
      keyVersion: KEY_VERSION,
      deploymentManifest: deploymentManifest(),
      deploymentManifestSha256: "e".repeat(64),
      writerFenceGrant: unsafeGrant,
      writerFenceGrantSha256: "f".repeat(64),
      credentialProvisioningManifest: credentialProvisioningManifest(),
      credentialProvisioningManifestSha256: "8".repeat(64),
      deploymentConfigSha256: DEPLOYMENT_CONFIG_SHA256,
      deploymentBundleSha256: DEPLOYMENT_BUNDLE_SHA256,
    })).toThrow("RESCUE_CANARY_ACTIVATION_WRITER_FENCE_WINDOW_MISMATCH");
  });

  it("rejects a grant whose holder, proof or credential binding differs from the deployment", () => {
    const base = {
      connectionId: CONNECTION_ID,
      runId: RETIREMENT_RUN_ID,
      approvedAt: APPROVED_AT,
      expiresAt: EXPIRES_AT,
      keyVersion: KEY_VERSION,
      deploymentManifest: deploymentManifest(),
      deploymentManifestSha256: "e".repeat(64),
      writerFenceGrantSha256: "f".repeat(64),
      credentialProvisioningManifest: credentialProvisioningManifest(),
      credentialProvisioningManifestSha256: "8".repeat(64),
      deploymentConfigSha256: DEPLOYMENT_CONFIG_SHA256,
      deploymentBundleSha256: DEPLOYMENT_BUNDLE_SHA256,
    };
    expect(() => rescueCanaryActivationPlan({
      ...base,
      writerFenceGrant: { ...writerFenceGrant(), holderId: "release-b" },
    })).toThrow("RESCUE_CANARY_ACTIVATION_WRITER_FENCE_GRANT_MISMATCH");
    expect(() => rescueCanaryActivationPlan({
      ...base,
      writerFenceGrant: { ...writerFenceGrant(), proofSha256: "e".repeat(64) },
    })).toThrow("RESCUE_CANARY_ACTIVATION_WRITER_FENCE_GRANT_MISMATCH");
    expect(() => rescueCanaryActivationPlan({
      ...base,
      writerFenceGrant: { ...writerFenceGrant(), credentialBinding: "c".repeat(64) },
    })).toThrow("RESCUE_CANARY_ACTIVATION_WRITER_FENCE_GRANT_MISMATCH");
    const wrongBindingManifest = deploymentManifest();
    wrongBindingManifest.writerFence.credentialBinding = "c".repeat(64);
    expect(() => rescueCanaryActivationPlan({
      ...base,
      deploymentManifest: wrongBindingManifest,
      writerFenceGrant: { ...writerFenceGrant(), credentialBinding: "c".repeat(64) },
    })).toThrow("RESCUE_CANARY_ACTIVATION_WRITER_FENCE_GRANT_MISMATCH");
  });

  it("renders a rotated activation that preserves prior operational receipts", () => {
    const sql = renderRescueCanaryActivationSql({
      connectionId: CONNECTION_ID,
      runId: "elbejeque-20260803-b",
      approvedAt: APPROVED_AT,
      expiresAt: EXPIRES_AT,
      keyVersion: "elbejeque-v2",
      mode: "rotate",
      legacyWriterRevokedAt: "2026-08-03T11:50:00.000Z",
      credentialAttestations: CREDENTIAL_ATTESTATIONS,
      credentialSetSha256: CREDENTIAL_SET_SHA256,
      deploymentManifestSha256: "e".repeat(64),
      writerFenceGrantSha256: "f".repeat(64),
    });

    expect(sql).toContain("IF 'rotate' = 'bootstrap'");
    expect(sql).toContain("status IN ('RETIRED', 'ABORTED')");
    expect(sql).toContain("rotated canary activation requires prior terminal scope");
    expect(sql).toContain("scope.status NOT IN ('RETIRED', 'ABORTED')");
    expect(sql).toContain("rotated canary activation requires complete terminal history");
  });

  it("feeds a generated v3 grant into the activation artifact and rejects changed evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "runtime-canary-activate."));
    const bundlePaths = Object.fromEntries(Object.keys(DEPLOYMENT_BUNDLE_SHA256).map((key) => {
      const path = join(directory, `worker.${key}.mjs`);
      writeFileSync(path, `fixture-bundle-${key}\n`, { mode: 0o600 });
      return [key, path];
    }));
    const configSources = {};
    const configPaths = Object.fromEntries(Object.keys(DEPLOYMENT_CONFIG_SHA256).map((key) => {
      const path = join(directory, `wrangler.${key}.toml`);
      configSources[key] = `main = "${bundlePaths[key]}"\nno_bundle = true\nfixture = "${key}"\n`;
      writeFileSync(path, configSources[key], { mode: 0o600 });
      return [key, path];
    }));
    const configSha256 = Object.fromEntries(Object.entries(configPaths).map(([key, path]) => [
      key,
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ]));
    const bundleSha256 = Object.fromEntries(Object.entries(bundlePaths).map(([key, path]) => [
      key,
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ]));
    const generatedFence = prepareWriterFenceGrant({
      environment: {
        CANARY_CONNECTION_ID: CONNECTION_ID,
        CANARY_RUN_ID: RETIREMENT_RUN_ID,
        CANARY_HOLDER_ID: "release-a",
        CANARY_WRITER_FENCE_PROOF: "fixture-proof-secret-with-more-than-32-bytes",
        CANARY_WRITER_FENCE_GRANT_VERSION: "3",
        RUNTIME_VAULT_KEY_VERSION: KEY_VERSION,
        CANARY_AGORA_CREDENTIAL_VERSION: CREDENTIAL_ATTESTATIONS.agora,
        CANARY_WINERIM_CREDENTIAL_VERSION: CREDENTIAL_ATTESTATIONS.winerim,
        CANARY_FENCE_ISSUED_AT: "2026-08-03T11:55:00.000Z",
        CANARY_FENCE_EXPIRES_AT: EXPIRES_AT,
        WRITER_FENCE_MODE: "legacy-writer-revoked",
        LEGACY_WRITER_REVOKED_AT: "2026-08-03T11:50:00.000Z",
        LEGACY_WRITER_NEGATIVE_PROBE_STATUS: "401",
        LEGACY_WRITER_EVIDENCE_SHA256: "d".repeat(64),
      },
      output: join(directory, "writer-fence-grant.json"),
    });
    const deployment = deploymentManifest();
    deployment.writerFence.proofSha256 = generatedFence.grant.proofSha256;
    const deploymentSource = `${JSON.stringify({
      ...deployment,
      configSha256,
      bundleSha256,
    }, null, 2)}\n`;
    const deploymentPath = join(directory, "canary-deployment-manifest.json");
    const deploymentSha256 = createHash("sha256").update(deploymentSource).digest("hex");
    writeFileSync(deploymentPath, deploymentSource, { mode: 0o600 });
    const provisioningSource = `${JSON.stringify(credentialProvisioningManifest(), null, 2)}\n`;
    const provisioningPath = join(directory, "runtime-credentials.sql.manifest.json");
    const provisioningSha256 = createHash("sha256").update(provisioningSource).digest("hex");
    writeFileSync(provisioningPath, provisioningSource, { mode: 0o600 });
    const output = join(directory, "activate.sql");
    const environment = {
      CANARY_CONNECTION_ID: CONNECTION_ID,
      CANARY_RUN_ID: RETIREMENT_RUN_ID,
      CANARY_SCOPE_APPROVED_AT: APPROVED_AT,
      CANARY_SCOPE_EXPIRES_AT: EXPIRES_AT,
      RUNTIME_VAULT_KEY_VERSION: KEY_VERSION,
      CANARY_DEPLOYMENT_MANIFEST: deploymentPath,
      CANARY_DEPLOYMENT_MANIFEST_SHA256: deploymentSha256,
      CANARY_WRITER_FENCE_GRANT: generatedFence.path,
      CANARY_WRITER_FENCE_GRANT_SHA256: generatedFence.grantSha256,
      RUNTIME_CREDENTIAL_PROVISIONING_MANIFEST: provisioningPath,
      RUNTIME_CREDENTIAL_PROVISIONING_MANIFEST_SHA256: provisioningSha256,
      CANARY_DEPLOYMENT_CONFIG_CONSUMER: configPaths.consumer,
      CANARY_DEPLOYMENT_CONFIG_EXECUTOR: configPaths.executor,
      CANARY_DEPLOYMENT_CONFIG_FENCE: configPaths.fence,
      CANARY_DEPLOYMENT_CONFIG_OBSERVER: configPaths.observer,
      CANARY_DEPLOYMENT_BUNDLE_CONSUMER: bundlePaths.consumer,
      CANARY_DEPLOYMENT_BUNDLE_EXECUTOR: bundlePaths.executor,
      CANARY_DEPLOYMENT_BUNDLE_FENCE: bundlePaths.fence,
      CANARY_DEPLOYMENT_BUNDLE_OBSERVER: bundlePaths.observer,
    };

    const result = prepareRescueCanaryActivation({ environment, output });
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(result).toMatchObject({ remoteMutations: 0, connectionId: CONNECTION_ID });
    expect(() => prepareRescueCanaryActivation({
      environment: { ...environment, CANARY_WRITER_FENCE_GRANT_SHA256: "0".repeat(64) },
      output: join(directory, "must-not-exist.sql"),
    })).toThrow("RESCUE_CANARY_ACTIVATION_WRITER_FENCE_GRANT_SHA256_MISMATCH");
    writeFileSync(configPaths.executor, `${configSources.executor}# tampered\n`, { mode: 0o600 });
    expect(() => prepareRescueCanaryActivation({
      environment,
      output: join(directory, "tampered-config-must-not-exist.sql"),
    })).toThrow("RESCUE_CANARY_ACTIVATION_DEPLOYMENT_CONFIG_SHA256_MISMATCH");
    writeFileSync(configPaths.executor, configSources.executor, { mode: 0o600 });
    writeFileSync(bundlePaths.executor, "tampered-executor-bundle\n", { mode: 0o600 });
    expect(() => prepareRescueCanaryActivation({
      environment,
      output: join(directory, "tampered-bundle-must-not-exist.sql"),
    })).toThrow("RESCUE_CANARY_ACTIVATION_DEPLOYMENT_BUNDLE_SHA256_MISMATCH");
  });
});

describe("rescue canary retirement tooling", () => {
  it("renders exact deactivation without deleting evidence", () => {
    const sql = renderRescueCanaryRetirementSql({
      connectionId: CONNECTION_ID,
      runId: RETIREMENT_RUN_ID,
      approvedAt: APPROVED_AT,
      deploymentManifestSha256: "e".repeat(64),
    });

    expect(sql).toContain(`approved_at = '${APPROVED_AT}'::timestamptz`);
    expect(sql).toContain(`run_id = '${RETIREMENT_RUN_ID}'`);
    expect(sql).toContain("note = 'rescue-canary-run:elbejeque-20260803-a'");
    expect(sql).toContain("AND active = true");
    expect(sql).toContain("UPDATE public.runtime_connection_credentials");
    expect(sql).toContain("UPDATE public.runtime_canary_connections");
    expect(sql).toContain("SET enabled = false");
    expect(sql).not.toMatch(/DELETE\s+FROM|TRUNCATE|stock_sync_log\s+SET|sales_events\s+SET/i);
  });

  it("writes a private SQL artifact and ordered Cloudflare retirement manifest", () => {
    const directory = mkdtempSync(join(tmpdir(), "runtime-canary-retire."));
    const sourceManifest = `${JSON.stringify(deploymentManifest(), null, 2)}\n`;
    const sourceManifestPath = join(directory, "canary-deployment-manifest.json");
    const sourceManifestSha256 = createHash("sha256").update(sourceManifest).digest("hex");
    writeFileSync(sourceManifestPath, sourceManifest, { encoding: "utf8", mode: 0o600 });
    const environment = {
      CANARY_CONNECTION_ID: CONNECTION_ID,
      CANARY_RUN_ID: RETIREMENT_RUN_ID,
      CANARY_SCOPE_APPROVED_AT: APPROVED_AT,
      CANARY_DEPLOYMENT_MANIFEST: sourceManifestPath,
      CANARY_DEPLOYMENT_MANIFEST_SHA256: sourceManifestSha256,
    };
    const result = prepareRescueCanaryRetirement({ environment, outputDir: directory });
    const plan = rescueCanaryRetirementPlan({
      connectionId: CONNECTION_ID,
      runId: environment.CANARY_RUN_ID,
      approvedAt: APPROVED_AT,
      deploymentManifest: deploymentManifest(),
      deploymentManifestSha256: sourceManifestSha256,
    });

    expect(statSync(result.sqlPath).mode & 0o777).toBe(0o600);
    expect(statSync(result.manifestPath).mode & 0o777).toBe(0o600);
    expect(plan.database).toMatchObject({ behavior: "deactivate-only", preservesEvidence: true });
    expect(plan.cloudflareOrder.map(({ action }) => action)).toEqual([
      "pause-exclusive-consumer",
      "revoke-canary-proof-and-grant-bindings",
      "wait-for-lease-and-network-drain",
      "verify-all-queues-empty-or-archived",
      "apply-reviewed-database-retirement-sql",
      "revoke-canary-vault-binding",
      "delete-dedicated-workers-after-readback",
      "delete-dedicated-queues-after-readback",
      "preserve-dlq-and-alarm-ledger",
    ]);
    expect(plan.cloudflareOrder.flatMap((step) => step.resources ?? [])).toEqual(expect.arrayContaining([
      "winerim-rescue-prod-canary-elbejeque-20260803-a-alarms",
      "winerim-rescue-prod-canary-elbejeque-20260803-a-observer-failures",
      RETIREMENT_RESOURCES.executorService,
      RETIREMENT_RESOURCES.fenceService,
      RETIREMENT_RESOURCES.archiveBucket,
    ]));
    expect(plan.databaseFailureAction).toContain("fresh gate");
  });

  it("accepts legacy v2 manifests only for append-only retirement", () => {
    const manifest = deploymentManifest();
    manifest.version = 2;
    delete manifest.writerFence;
    const plan = rescueCanaryRetirementPlan({
      connectionId: CONNECTION_ID,
      runId: RETIREMENT_RUN_ID,
      approvedAt: APPROVED_AT,
      deploymentManifest: manifest,
      deploymentManifestSha256: "a".repeat(64),
    });

    expect(plan.database).toMatchObject({ behavior: "deactivate-only", deletesRows: false });
  });

  it("rejects a retirement manifest from another run or with a changed hash", () => {
    const manifest = deploymentManifest();
    expect(() => rescueCanaryRetirementPlan({
      connectionId: CONNECTION_ID,
      runId: "elbejeque-20260803-b",
      approvedAt: APPROVED_AT,
      deploymentManifest: manifest,
      deploymentManifestSha256: "a".repeat(64),
    })).toThrow("RESCUE_CANARY_RETIREMENT_DEPLOYMENT_MANIFEST_SCOPE_MISMATCH");

    const directory = mkdtempSync(join(tmpdir(), "runtime-canary-retire-hash."));
    const manifestPath = join(directory, "canary-deployment-manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    expect(() => prepareRescueCanaryRetirement({
      environment: {
        CANARY_CONNECTION_ID: CONNECTION_ID,
        CANARY_RUN_ID: RETIREMENT_RUN_ID,
        CANARY_SCOPE_APPROVED_AT: APPROVED_AT,
        CANARY_DEPLOYMENT_MANIFEST: manifestPath,
        CANARY_DEPLOYMENT_MANIFEST_SHA256: "b".repeat(64),
      },
      outputDir: join(directory, "retire"),
    })).toThrow("RESCUE_CANARY_RETIREMENT_DEPLOYMENT_MANIFEST_SHA256_MISMATCH");
  });
});
