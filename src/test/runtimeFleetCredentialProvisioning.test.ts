import { createHash } from "node:crypto";
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
import {
  buildFleetLogicalManifest,
  fleetCredentialProvisioningPlan,
  prepareFleetCredentialProvisioning,
  validateFleetProvisioningInput,
} from "../../infrastructure/runtime/prepare-fleet-credential-provisioning.mjs";

const CONNECTION_A = "11111111-1111-4111-8111-111111111111";
const CONNECTION_B = "22222222-2222-4222-8222-222222222222";
const KEY_VERSION = "fleet-v1";
const MASTER_KEY = Buffer.alloc(32, 9).toString("base64");

function sha256(source: Buffer) {
  return createHash("sha256").update(source).digest("hex");
}

function canonicalTestJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalTestJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalTestJson(record[key])}`
  )).join(",")}}`;
}

function fixtureConnection(directory: string, connectionId: string, suffix: string) {
  const eventCount = suffix === "a" ? 42 : 17;
  const lineCount = suffix === "a" ? 137 : 51;
  const events = Array.from({ length: eventCount }, (_, eventIndex) => {
    const baseLines = Math.floor(lineCount / eventCount);
    const extraLines = eventIndex < (lineCount % eventCount) ? 1 : 0;
    return {
      businessDay: "2026-08-03",
      providerDocId: `${suffix}-invoice-${eventIndex}`,
      docType: "INVOICE",
      orderId: `${suffix}-order-${eventIndex}`,
      soldAt: "2026-08-03T20:00:00.000Z",
      lines: Array.from({ length: baseLines + extraLines }, (_, lineIndex) => ({
        providerLineId: `${suffix}-line-${eventIndex}-${lineIndex}`,
        providerProductId: `${suffix}-product-${eventIndex}-${lineIndex}`,
        format: "BOTTLE",
        qty: 1,
        soldAt: "2026-08-03T20:00:00.000Z",
        mapping: { mapped: false, status: "UNMAPPED" },
      })),
    };
  });
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
      connectionId,
      cursor: {
        lastBusinessDaySynced: "2026-08-03",
        lastSyncAt: "2026-08-04T11:55:00.000Z",
      },
      events,
      receipts: [{
        receiptId: `${suffix}-receipt-1`,
        businessDay: "2026-08-03",
        providerDocId: `${suffix}-invoice-0`,
        orderId: `${suffix}-order-0`,
        status: "SUCCESS",
        live: true,
        stockApplied: true,
        duplicate: false,
        payloadSha256: "a".repeat(64),
      }],
    }],
  };
  const exportSource = Buffer.from(`${JSON.stringify(sourceArtifact)}\n`);
  const exportManifestSha256 = sha256(exportSource);
  const exportManifestPath = join(directory, `export-${suffix}.json`);
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
  const targetSource = Buffer.from(`${JSON.stringify(targetArtifact)}\n`);
  const targetManifestSha256 = sha256(targetSource);
  const targetManifestPath = join(directory, `target-${suffix}.json`);
  const reportBody = {
    schemaVersion: "agora-shadow-v2",
    result: "RECONCILED_EXACT",
    dryRun: true,
    writes: false,
    scope: { connectionCount: 1, connectionIds: [connectionId] },
    summary: { reconciledConnections: 1, differingConnections: 0, differences: 0 },
    connections: [{
      connectionId,
      status: "RECONCILED_EXACT",
      events: eventCount,
      lines: lineCount,
      receipts: 1,
    }],
    differences: [],
    inputs: {
      lovableSha256: exportManifestSha256,
      ownSha256: targetManifestSha256,
    },
  };
  const reconciliation = {
    ...reportBody,
    reportSha256: sha256(Buffer.from(canonicalTestJson(reportBody))),
  };
  const reconciliationSource = Buffer.from(`${JSON.stringify(reconciliation)}\n`);
  const reconciliationManifestPath = join(directory, `reconciliation-${suffix}.json`);
  writeFileSync(exportManifestPath, exportSource, { mode: 0o600 });
  writeFileSync(targetManifestPath, targetSource, { mode: 0o600 });
  writeFileSync(reconciliationManifestPath, reconciliationSource, { mode: 0o600 });

  return {
    connectionId,
    runId: `fleet-20260804-${suffix}`,
    credentials: {
      agora: `fixture-agora-secret-${suffix}`,
      winerim: `fixture-winerim-secret-${suffix}`,
    },
    targetEvidence: {
      rowExists: true,
      provider: "agora",
      enabled: false,
      catalogSyncEnabled: false,
      syncMode: "PULL_ONLY",
      writeMode: "NONE",
      backfillDays: 0,
      operationallyInert: true,
      sanitized: true,
      credentialVaultRows: 0,
      salesEvents: eventCount,
      salesLineItems: lineCount,
      maxBusinessDay: "2026-08-03",
      lastBusinessDaySynced: "2026-08-03",
      lastSyncAt: "2026-08-04T11:55:00.000Z",
    },
    adoptionEvidence: {
      exportManifestPath,
      exportManifestSha256,
      targetManifestPath,
      targetManifestSha256,
      reconciliationManifestPath,
      reconciliationManifestSha256: sha256(reconciliationSource),
    },
  };
}

function fixtureInput() {
  const directory = mkdtempSync(join(tmpdir(), "runtime-fleet-input-"));
  chmodSync(directory, 0o700);
  const connections = [
    fixtureConnection(directory, CONNECTION_B, "b"),
    fixtureConnection(directory, CONNECTION_A, "a"),
  ];
  const inputPath = join(directory, "fleet.json");
  writeFileSync(inputPath, `${JSON.stringify({ version: 1, connections }, null, 2)}\n`, {
    mode: 0o600,
  });
  return { directory, connections, inputPath };
}

function environment(inputPath: string, outputDir: string, masterKey = MASTER_KEY) {
  return {
    RUNTIME_FLEET_CREDENTIAL_INPUT_JSON: inputPath,
    RUNTIME_FLEET_CREDENTIAL_OUTPUT_DIR: outputDir,
    RUNTIME_VAULT_KEY_VERSION: KEY_VERSION,
    RUNTIME_VAULT_MASTER_KEY: masterKey,
  };
}

describe("fleet runtime credential provisioning", () => {
  it("writes one inactive private package per connection without secret disclosure", () => {
    const fixture = fixtureInput();
    const outputDir = join(mkdtempSync(join(tmpdir(), "runtime-fleet-parent-")), "artifacts");
    const result = prepareFleetCredentialProvisioning({
      environment: environment(fixture.inputPath, outputDir),
    });

    expect(result).toMatchObject({
      status: "RUNTIME_FLEET_CREDENTIAL_PROVISION_ARTIFACTS_READY",
      connectionCount: 2,
      remoteMutations: 0,
      active: false,
      activationAllowed: false,
    });
    expect(statSync(outputDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(outputDir).sort()).toEqual([
      CONNECTION_A,
      CONNECTION_B,
      "fleet-credentials.logical-manifest.json",
    ]);
    expect(statSync(result.logicalManifestPath).mode & 0o777).toBe(0o600);
    const logicalManifest = JSON.parse(readFileSync(result.logicalManifestPath, "utf8"));
    expect(logicalManifest.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reconciliationReportSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        sourceDatasetSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        targetDatasetSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]));

    const allSources: string[] = [readFileSync(result.logicalManifestPath, "utf8")];
    for (const artifact of result.artifacts) {
      expect(statSync(join(outputDir, artifact.connectionId)).mode & 0o777).toBe(0o700);
      expect(statSync(artifact.output).mode & 0o777).toBe(0o600);
      expect(statSync(artifact.manifestPath).mode & 0o777).toBe(0o600);
      const sql = readFileSync(artifact.output, "utf8");
      const manifest = readFileSync(artifact.manifestPath, "utf8");
      expect(sql).toContain("active = false");
      expect(sql).toContain("adopt-existing requires an empty credential vault");
      expect(sql).toContain(
        `WHERE connection_id = '${artifact.connectionId}'::uuid\n    AND active = true`,
      );
      expect(sql).toContain("runtime canary or credential is already active for connection");
      expect(manifest).toContain('"activationAllowed": false');
      expect(manifest).toContain('"schemaVersion": "agora-shadow-v2"');
      expect(manifest).toContain('"reconciliationReportSha256"');
      expect(manifest).toContain('"sourceDatasetSha256"');
      expect(manifest).toContain('"targetDatasetSha256"');
      allSources.push(sql, manifest);
    }
    const serialized = `${JSON.stringify(result)}\n${allSources.join("\n")}`;
    for (const connection of fixture.connections) {
      expect(serialized).not.toContain(connection.credentials.agora);
      expect(serialized).not.toContain(connection.credentials.winerim);
    }
    expect(serialized).not.toContain(MASTER_KEY);
    expect(fleetCredentialProvisioningPlan()).toMatchObject({
      remoteMutations: 0,
      writesPlaintext: false,
      insertsActiveCredentials: false,
      activationAllowed: false,
    });
  });

  it("rejects duplicate connection ids before creating an output directory", () => {
    const fixture = fixtureInput();
    const duplicate = { ...fixture.connections[1], runId: "fleet-20260804-duplicate" };
    const inputPath = join(fixture.directory, "duplicate.json");
    writeFileSync(inputPath, `${JSON.stringify({
      version: 1,
      connections: [fixture.connections[0], fixture.connections[0], duplicate],
    })}\n`, { mode: 0o600 });
    const outputDir = join(mkdtempSync(join(tmpdir(), "runtime-fleet-duplicate-")), "artifacts");

    expect(() => prepareFleetCredentialProvisioning({
      environment: environment(inputPath, outputDir),
    })).toThrow("RUNTIME_FLEET_CREDENTIAL_PROVISION_DUPLICATE_CONNECTION_ID");
    expect(() => statSync(outputDir)).toThrow();
  });

  it.each([
    ["enabled", { enabled: true }],
    ["inert", { operationallyInert: false }],
    ["sanitized", { sanitized: false }],
    ["vault", { credentialVaultRows: 1 }],
    ["watermark", { salesEvents: 999 }],
  ])("rejects unsafe %s target evidence", (_label, targetOverride) => {
    const fixture = fixtureInput();
    fixture.connections[0].targetEvidence = {
      ...fixture.connections[0].targetEvidence,
      ...targetOverride,
    };
    expect(() => validateFleetProvisioningInput({
      version: 1,
      connections: fixture.connections,
    })).toThrow(/TARGET_NOT_INERT_SANITIZED|TARGET_EVIDENCE_MISMATCH/);
  });

  it("rejects invalid input, public files and evidence hash mismatches", () => {
    const fixture = fixtureInput();
    const invalidJson = join(fixture.directory, "invalid.json");
    writeFileSync(invalidJson, "{", { mode: 0o600 });
    expect(() => prepareFleetCredentialProvisioning({
      environment: environment(
        invalidJson,
        join(mkdtempSync(join(tmpdir(), "runtime-fleet-invalid-")), "artifacts"),
      ),
    })).toThrow("RUNTIME_FLEET_CREDENTIAL_PROVISION_INVALID_INPUT_JSON");

    chmodSync(fixture.inputPath, 0o644);
    expect(() => prepareFleetCredentialProvisioning({
      environment: environment(
        fixture.inputPath,
        join(mkdtempSync(join(tmpdir(), "runtime-fleet-public-")), "artifacts"),
      ),
    })).toThrow("RUNTIME_FLEET_CREDENTIAL_PROVISION_INPUT_JSON_MUST_BE_PRIVATE_0600");
    chmodSync(fixture.inputPath, 0o600);

    fixture.connections[0].adoptionEvidence.exportManifestSha256 = "0".repeat(64);
    expect(() => validateFleetProvisioningInput({ version: 1, connections: fixture.connections }))
      .toThrow("RUNTIME_CREDENTIAL_PROVISION_EXPORT_MANIFEST_SHA256_MISMATCH");
  });

  it("keeps the logical manifest deterministic across input order and encryption keys", () => {
    const fixture = fixtureInput();
    const first = validateFleetProvisioningInput({ version: 1, connections: fixture.connections });
    const second = validateFleetProvisioningInput({
      version: 1,
      connections: [...fixture.connections].reverse(),
    });
    const firstManifest = buildFleetLogicalManifest({ keyVersion: KEY_VERSION, connections: first });
    const secondManifest = buildFleetLogicalManifest({ keyVersion: KEY_VERSION, connections: second });

    expect(firstManifest).toEqual(secondManifest);
    expect(firstManifest.logicalManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(firstManifest)).not.toContain(fixture.connections[0].credentials.agora);
    expect(JSON.stringify(firstManifest)).not.toContain(Buffer.alloc(32, 1).toString("base64"));

    const firstOutput = join(mkdtempSync(join(tmpdir(), "runtime-fleet-key-a-")), "artifacts");
    const secondOutput = join(mkdtempSync(join(tmpdir(), "runtime-fleet-key-b-")), "artifacts");
    const firstResult = prepareFleetCredentialProvisioning({
      environment: environment(fixture.inputPath, firstOutput, Buffer.alloc(32, 1).toString("base64")),
    });
    const secondResult = prepareFleetCredentialProvisioning({
      environment: environment(fixture.inputPath, secondOutput, Buffer.alloc(32, 2).toString("base64")),
    });
    expect(readFileSync(firstResult.logicalManifestPath, "utf8"))
      .toBe(readFileSync(secondResult.logicalManifestPath, "utf8"));
    expect(readFileSync(firstResult.artifacts[0].output, "utf8"))
      .not.toBe(readFileSync(secondResult.artifacts[0].output, "utf8"));
  });

  it("refuses repository outputs and existing destinations", () => {
    const fixture = fixtureInput();
    expect(() => prepareFleetCredentialProvisioning({
      environment: environment(fixture.inputPath, join(process.cwd(), "fleet-artifacts")),
    })).toThrow("RUNTIME_FLEET_CREDENTIAL_PROVISION_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");

    const existing = mkdtempSync(join(tmpdir(), "runtime-fleet-existing-"));
    expect(() => prepareFleetCredentialProvisioning({
      environment: environment(fixture.inputPath, existing),
    })).toThrow("RUNTIME_FLEET_CREDENTIAL_PROVISION_OUTPUT_ALREADY_EXISTS");
  });
});
