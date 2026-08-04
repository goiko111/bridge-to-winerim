import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import {
  prepareRetiredCredentialEnvelopeReuse,
  retiredCredentialEnvelopeReusePlan,
} from "../../infrastructure/runtime/prepare-retired-credential-envelope-reuse.mjs";
// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import {
  runtimeCredentialSetSha256,
} from "../../infrastructure/runtime/prepare-runtime-credential-provisioning.mjs";

const CONNECTION_ID = "e465872a-bff5-43de-8e4c-fe4986f0fd4f";
const SOURCE_RUN_ID = "vinatea-cutover-b";
const TARGET_RUN_ID = "vinatea-cutover-c";
const KEY_VERSION = "fleet-v1-20260804";
const NOW = new Date("2026-08-04T12:00:00.000Z");
const ATTESTATIONS = {
  agora: "a".repeat(64),
  winerim: "b".repeat(64),
};

function sha256(source: Buffer | string) {
  return createHash("sha256").update(source).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

function privateJson(directory: string, name: string, value: unknown) {
  const path = join(directory, name);
  const source = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(path, source, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, source, sha256: sha256(source) };
}

type FixtureOptions = {
  sourceCaptureEndedAt?: string;
  sourceKeyVersion?: string;
  targetAuthoritative?: boolean;
  targetConsistencyBlocker?: string | null;
};

function fixture(options: FixtureOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "retired-envelope-reuse-"));
  chmodSync(directory, 0o700);
  const connection = {
    connectionId: CONNECTION_ID,
    cursor: {
      lastBusinessDaySynced: "2026-08-03",
      lastSyncAt: "2026-08-04T11:55:00.000Z",
    },
    events: [{
      businessDay: "2026-08-03",
      providerDocId: "invoice-1",
      docType: "INVOICE",
      orderId: "order-1",
      soldAt: "2026-08-03T20:00:00.000Z",
      lines: [{
        providerLineId: "line-1",
        providerProductId: "product-1",
        format: "BOTTLE",
        qty: 1,
        soldAt: "2026-08-03T20:00:00.000Z",
        mapping: {
          mapped: true,
          status: "CONFIRMED",
          winerimProductId: "47593",
          format: "BOTTLE",
        },
      }],
    }],
    receipts: [{
      receiptId: "receipt-1",
      businessDay: "2026-08-03",
      providerDocId: "invoice-1",
      orderId: "order-1",
      status: "SUCCESS",
      live: true,
      stockApplied: true,
      duplicate: false,
      payloadSha256: "c".repeat(64),
    }],
  };
  const sourceArtifact = {
    schemaVersion: "agora-shadow-v2",
    capture: {
      mode: "OBSERVATIONAL_READ_ONLY",
      authoritative: false,
      captureStartedAt: "2026-08-04T11:54:00.000Z",
      captureEndedAt: options.sourceCaptureEndedAt ?? "2026-08-04T11:55:00.000Z",
      sourceMarkerStable: true,
      consistencyBlocker: "REST_NON_TRANSACTIONAL_AND_WRITER_NOT_FENCED",
    },
    connections: [connection],
  };
  const targetArtifact = {
    schemaVersion: "agora-shadow-v2",
    capture: {
      mode: "POSTGRES_REPEATABLE_READ_ONLY",
      authoritative: options.targetAuthoritative ?? true,
      captureStartedAt: "2026-08-04T11:54:00.000Z",
      captureEndedAt: "2026-08-04T11:55:00.000Z",
      sourceMarkerStable: true,
      consistencyBlocker: options.targetConsistencyBlocker ?? null,
    },
    connections: [connection],
  };
  const source = privateJson(directory, "source.json", sourceArtifact);
  const target = privateJson(directory, "target.json", targetArtifact);
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
      events: 1,
      lines: 1,
      receipts: 1,
    }],
    differences: [],
    inputs: { lovableSha256: source.sha256, ownSha256: target.sha256 },
  };
  const reconciliation = privateJson(directory, "reconciliation.json", {
    ...reportBody,
    reportSha256: sha256(canonicalJson(reportBody)),
  });
  const sourceKeyVersion = options.sourceKeyVersion ?? KEY_VERSION;
  const sourceCredentialSetSha256 = runtimeCredentialSetSha256({
    connectionId: CONNECTION_ID,
    runId: SOURCE_RUN_ID,
    keyVersion: sourceKeyVersion,
    credentials: [
      { kind: "agora", attestationSha256: ATTESTATIONS.agora },
      { kind: "winerim", attestationSha256: ATTESTATIONS.winerim },
    ],
  });
  const sourceCredentialManifest = privateJson(directory, "source-credentials.manifest.json", {
    version: 3,
    connectionId: CONNECTION_ID,
    runId: SOURCE_RUN_ID,
    keyVersion: sourceKeyVersion,
    mode: "adopt-existing",
    active: false,
    sqlSha256: "d".repeat(64),
    credentialAttestations: ATTESTATIONS,
    credentialSetSha256: sourceCredentialSetSha256,
    adoption: { kind: "AGORA_SHADOW_RECONCILIATION_EVIDENCE" },
    adoptionCursorPolicy: {},
    scopeGenerationMode: "bootstrap",
    activationAllowed: false,
    activationBlockReason: "ADOPT_EXISTING_ACTIVATION_REQUIRES_SEPARATE_REVIEWED_GATE",
  });
  const input = {
    version: 1,
    kind: "RUNTIME_RETIRED_CREDENTIAL_ENVELOPE_REUSE",
    connectionId: CONNECTION_ID,
    sourceRunId: SOURCE_RUN_ID,
    targetRunId: TARGET_RUN_ID,
    expectedKeyVersion: KEY_VERSION,
    sourceCredentialManifest: {
      path: sourceCredentialManifest.path,
      sha256: sourceCredentialManifest.sha256,
    },
    adoptionEvidence: {
      exportManifestPath: source.path,
      exportManifestSha256: source.sha256,
      targetManifestPath: target.path,
      targetManifestSha256: target.sha256,
      reconciliationManifestPath: reconciliation.path,
      reconciliationManifestSha256: reconciliation.sha256,
    },
  };
  const inputArtifact = privateJson(directory, "input.json", input);
  return {
    directory,
    input,
    inputPath: inputArtifact.path,
    sourceCredentialManifest,
    output: join(directory, "rendered", "runtime-credentials.sql"),
  };
}

describe("retired runtime credential envelope reuse", () => {
  it("prepares a private PREPARED generation through transactional INSERT SELECT", () => {
    const testFixture = fixture();
    const result = prepareRetiredCredentialEnvelopeReuse({
      inputPath: testFixture.inputPath,
      output: testFixture.output,
      now: NOW,
    });
    const sql = readFileSync(result.output, "utf8");
    const manifestSource = readFileSync(result.manifestPath, "utf8");
    const manifest = JSON.parse(manifestSource);

    expect(result).toMatchObject({
      status: "RUNTIME_RETIRED_ENVELOPE_REUSE_PREPARED",
      remoteMutations: 0,
      plaintextRead: false,
      connectionId: CONNECTION_ID,
      sourceRunId: SOURCE_RUN_ID,
      runId: TARGET_RUN_ID,
      keyVersion: KEY_VERSION,
      activationAllowed: false,
    });
    expect(statSync(result.output).mode & 0o777).toBe(0o600);
    expect(statSync(result.manifestPath).mode & 0o777).toBe(0o600);
    expect(sha256(sql)).toBe(result.sqlSha256);
    expect(sha256(manifestSource)).toBe(result.manifestSha256);
    expect(manifest).toMatchObject({
      version: 3,
      connectionId: CONNECTION_ID,
      runId: TARGET_RUN_ID,
      keyVersion: KEY_VERSION,
      mode: "adopt-existing",
      active: false,
      sqlSha256: result.sqlSha256,
      credentialAttestations: ATTESTATIONS,
      activationAllowed: false,
      envelopeReuse: {
        version: 1,
        kind: "RETIRED_CREDENTIAL_ENVELOPE_REUSE",
        method: "POSTGRES_INSERT_SELECT_NO_PLAINTEXT",
        sourceRunId: SOURCE_RUN_ID,
        sourceCredentialManifestSha256: testFixture.sourceCredentialManifest.sha256,
        algorithm: "AES-256-GCM",
        aadVersion: 1,
        aadRunIndependent: true,
        evidenceMaxAgeSeconds: 900,
        plaintextRead: false,
        remoteMutations: 0,
      },
    });
    expect(manifest.credentialSetSha256).not.toBe(manifest.envelopeReuse.sourceCredentialSetSha256);
    expect(manifest.envelopeReuse.aad.agora.value).toBe(
      `winerim-runtime-credential|1|${CONNECTION_ID}|agora|agora|${KEY_VERSION}`,
    );
    expect(manifest.envelopeReuse.aad.winerim.value).toBe(
      `winerim-runtime-credential|1|${CONNECTION_ID}|agora|winerim|${KEY_VERSION}`,
    );
    expect(JSON.stringify(manifest.envelopeReuse.aad)).not.toContain(SOURCE_RUN_ID);
    expect(JSON.stringify(manifest.envelopeReuse.aad)).not.toContain(TARGET_RUN_ID);

    expect(sql).toMatch(/BEGIN;[\s\S]*COMMIT;/);
    expect(sql).toContain("INSERT INTO public.runtime_connection_credentials");
    expect(sql).toContain("FROM public.runtime_connection_credentials");
    expect(sql).toContain(`AND run_id = '${SOURCE_RUN_ID}'`);
    expect(sql).toContain(`'${TARGET_RUN_ID}',\n  algorithm`);
    expect(sql).toContain("status = 'RETIRED'");
    expect(sql).toContain("activated_at IS NOT NULL");
    expect(sql).toContain("retired_at IS NOT NULL");
    expect(sql).toContain("retired_at >= activated_at");
    expect(sql).toContain("source generation does not contain exactly two compatible retired envelopes");
    expect(sql).toContain("retired envelope byte-for-byte readback mismatch");
    expect(sql).not.toMatch(/\bUPDATE\b|\bDELETE\b/);
    expect(sql).not.toContain("decode(");
  });

  it("rejects stale adoption evidence before creating output", () => {
    const testFixture = fixture({ sourceCaptureEndedAt: "2026-08-04T11:30:00.000Z" });
    expect(() => prepareRetiredCredentialEnvelopeReuse({
      inputPath: testFixture.inputPath,
      output: testFixture.output,
      now: NOW,
    })).toThrow("RUNTIME_RETIRED_ENVELOPE_REUSE_EXPORT_MANIFEST_CAPTURE_STALE");
    expect(() => statSync(testFixture.output)).toThrow();
  });

  it("rejects non-authoritative target evidence", () => {
    const testFixture = fixture({
      targetAuthoritative: false,
      targetConsistencyBlocker: "NOT_REPEATABLE_READ",
    });
    expect(() => prepareRetiredCredentialEnvelopeReuse({
      inputPath: testFixture.inputPath,
      output: testFixture.output,
      now: NOW,
    })).toThrow("RUNTIME_RETIRED_ENVELOPE_REUSE_TARGET_MANIFEST_CAPTURE_NOT_STABLE");
  });

  it("rejects keyVersion drift and forged source-manifest hashes", () => {
    const keyDrift = fixture({ sourceKeyVersion: "fleet-v2" });
    expect(() => prepareRetiredCredentialEnvelopeReuse({
      inputPath: keyDrift.inputPath,
      output: keyDrift.output,
      now: NOW,
    })).toThrow("RUNTIME_RETIRED_ENVELOPE_REUSE_SOURCE_MANIFEST_SCOPE_MISMATCH");

    const forgedHash = fixture();
    forgedHash.input.sourceCredentialManifest.sha256 = "0".repeat(64);
    writeFileSync(forgedHash.inputPath, `${JSON.stringify(forgedHash.input)}\n`, { mode: 0o600 });
    expect(() => prepareRetiredCredentialEnvelopeReuse({
      inputPath: forgedHash.inputPath,
      output: forgedHash.output,
      now: NOW,
    })).toThrow("RUNTIME_RETIRED_ENVELOPE_REUSE_SOURCE_CREDENTIAL_MANIFEST_SHA256_MISMATCH");
  });

  it("rejects plaintext-shaped input expansion and public evidence files", () => {
    const expanded = fixture();
    const unsafeInput = { ...expanded.input, credentials: { agora: "plaintext" } };
    writeFileSync(expanded.inputPath, `${JSON.stringify(unsafeInput)}\n`, { mode: 0o600 });
    expect(() => prepareRetiredCredentialEnvelopeReuse({
      inputPath: expanded.inputPath,
      output: expanded.output,
      now: NOW,
    })).toThrow("RUNTIME_RETIRED_ENVELOPE_REUSE_INVALID_INPUT_KEYS");

    const publicManifest = fixture();
    chmodSync(publicManifest.sourceCredentialManifest.path, 0o644);
    expect(() => prepareRetiredCredentialEnvelopeReuse({
      inputPath: publicManifest.inputPath,
      output: publicManifest.output,
      now: NOW,
    })).toThrow("RUNTIME_RETIRED_ENVELOPE_REUSE_SOURCE_CREDENTIAL_MANIFEST_MUST_BE_PRIVATE_0600");
  });

  it("rejects outputs inside the repository and preserves plan-only defaults", () => {
    const testFixture = fixture();
    expect(() => prepareRetiredCredentialEnvelopeReuse({
      inputPath: testFixture.inputPath,
      output: join(process.cwd(), "unsafe-runtime-credentials.sql"),
      now: NOW,
    })).toThrow("RUNTIME_RETIRED_ENVELOPE_REUSE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
    expect(retiredCredentialEnvelopeReusePlan()).toMatchObject({
      status: "RUNTIME_RETIRED_ENVELOPE_REUSE_PLAN_ONLY",
      remoteMutations: 0,
      plaintextRead: false,
      outputMode: "private-0600",
      sqlMethod: "INSERT_SELECT_FROM_EXACT_RETIRED_GENERATION",
      evidenceMaxAgeSeconds: 900,
      requiredLifecycle: {
        sourceScope: "RETIRED_AFTER_ACTIVATION",
        sourceCredentials: "EXACTLY_TWO_INACTIVE_ACTIVATED_AND_RETIRED",
        targetScope: "ABSENT_THEN_PREPARED_INACTIVE",
      },
    });
  });

  it("rejects a public output parent without changing its permissions", () => {
    const testFixture = fixture();
    const publicParent = mkdtempSync(join(tmpdir(), "retired-envelope-public-output-"));
    chmodSync(publicParent, 0o755);
    expect(() => prepareRetiredCredentialEnvelopeReuse({
      inputPath: testFixture.inputPath,
      output: join(publicParent, "runtime-credentials.sql"),
      now: NOW,
    })).toThrow("RUNTIME_RETIRED_ENVELOPE_REUSE_OUTPUT_PARENT_MUST_BE_PRIVATE_0700");
    expect(statSync(publicParent).mode & 0o777).toBe(0o755);
  });
});
