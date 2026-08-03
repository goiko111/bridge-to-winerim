import { createDecipheriv, createHash } from "node:crypto";
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

// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import {
  credentialProvisioningPlan,
  encryptRuntimeCredential,
  prepareCredentialProvisioning,
  renderCredentialProvisioningSql,
  runtimeCredentialAad,
  runtimeCredentialSetSha256,
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

function deploymentManifest() {
  const queueName = `winerim-rescue-prod-canary-${RETIREMENT_RUN_ID}`;
  return {
    version: 2,
    runId: RETIREMENT_RUN_ID,
    connectionId: CONNECTION_ID,
    scopeNote: `rescue-canary-run:${RETIREMENT_RUN_ID}`,
    credentialBinding: {
      keyVersion: KEY_VERSION,
      exclusiveAttestationSha256: "b".repeat(64),
      credentialSetSha256: CREDENTIAL_SET_SHA256,
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
    configSha256: {},
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

describe("runtime credential provisioning tooling", () => {
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

describe("rescue canary activation tooling", () => {
  function writerFenceGrant() {
    return {
      version: 1,
      connectionId: CONNECTION_ID,
      runId: RETIREMENT_RUN_ID,
      holderId: "release-a",
      proofSha256: "a".repeat(64),
      exclusiveCredentialRef: `runtime-vault://postgres/${CONNECTION_ID}/agora/winerim`,
      credentialVersion: "b".repeat(64),
      credentialBinding: "c".repeat(64),
      legacyWriter: {
        revokedAt: "2026-08-03T11:50:00.000Z",
        negativeProbeStatus: 401,
        evidenceSha256: "d".repeat(64),
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
    });

    expect(plan).toMatchObject({
      remoteMutations: 0,
      connectionId: CONNECTION_ID,
      runId: RETIREMENT_RUN_ID,
      activation: {
        oneConnection: true,
        catalogDisabled: true,
        firstCanaryRequiresZeroOperationalRows: true,
      },
    });
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
    })).toThrow("RESCUE_CANARY_ACTIVATION_WRITER_FENCE_WINDOW_MISMATCH");
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

  it("writes a private activation artifact and rejects changed evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "runtime-canary-activate."));
    const deploymentSource = `${JSON.stringify(deploymentManifest(), null, 2)}\n`;
    const deploymentPath = join(directory, "canary-deployment-manifest.json");
    const deploymentSha256 = createHash("sha256").update(deploymentSource).digest("hex");
    const fenceSource = `${JSON.stringify(writerFenceGrant(), null, 2)}\n`;
    const fencePath = join(directory, "writer-fence-grant.json");
    const fenceSha256 = createHash("sha256").update(fenceSource).digest("hex");
    writeFileSync(deploymentPath, deploymentSource, { mode: 0o600 });
    writeFileSync(fencePath, fenceSource, { mode: 0o600 });
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
      CANARY_WRITER_FENCE_GRANT: fencePath,
      CANARY_WRITER_FENCE_GRANT_SHA256: fenceSha256,
      RUNTIME_CREDENTIAL_PROVISIONING_MANIFEST: provisioningPath,
      RUNTIME_CREDENTIAL_PROVISIONING_MANIFEST_SHA256: provisioningSha256,
    };

    const result = prepareRescueCanaryActivation({ environment, output });
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(result).toMatchObject({ remoteMutations: 0, connectionId: CONNECTION_ID });
    expect(() => prepareRescueCanaryActivation({
      environment: { ...environment, CANARY_WRITER_FENCE_GRANT_SHA256: "0".repeat(64) },
      output: join(directory, "must-not-exist.sql"),
    })).toThrow("RESCUE_CANARY_ACTIVATION_WRITER_FENCE_GRANT_SHA256_MISMATCH");
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
