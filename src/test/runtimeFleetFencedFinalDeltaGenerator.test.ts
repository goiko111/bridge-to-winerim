import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import {
  buildFleetFencedFinalDelta,
  prepareFleetFencedFinalDelta,
} from "../../infrastructure/runtime/prepare-fleet-fenced-final-delta.mjs";

const CONNECTION_ID = "8466c229-773d-4ad9-a747-9bb862d7ae6b";
const FENCED_AT = "2026-08-04T14:00:00.000Z";
const CAPTURE_A_AT = "2026-08-04T14:02:10.000Z";
const CAPTURE_B_AT = "2026-08-04T14:02:16.000Z";
const TARGET_CORRECTED_AT = "2026-08-04T14:02:20.000Z";
const GENERATED_AT = "2026-08-04T14:02:21.000Z";
const temporaryDirectories: string[] = [];

function sha256(source: Buffer | string) {
  return createHash("sha256").update(source).digest("hex");
}

function marker() {
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

function line(index: number) {
  return {
    providerLineId: `line-${index}`,
    providerProductId: `product-${index}`,
    format: index === 1 ? "BOTTLE" : "GLASS",
    qty: index,
    soldAt: `2026-08-0${index + 2}T12:01:00Z`,
    mapping: {
      mapped: true,
      status: "CONFIRMED",
      winerimProductId: `wine-${index}`,
      winerimFormat: index === 1 ? "BOTTLE" : "GLASS",
    },
  };
}

function event(index: number) {
  const businessDay = `2026-08-0${index + 2}`;
  return {
    businessDay,
    providerDocId: `invoice-${index}`,
    docType: "INVOICE",
    orderId: `order-${index}`,
    soldAt: `${businessDay}T12:00:00Z`,
    lines: [line(index)],
  };
}

function receipt(index: number) {
  return {
    receiptId: `receipt-${index}`,
    businessDay: `2026-08-0${index + 2}`,
    providerDocId: `invoice-${index}`,
    orderId: `order-${index}`,
    status: "SUCCESS",
    live: true,
    stockApplied: true,
    duplicate: false,
    payloadSha256: String(index).repeat(64),
  };
}

function mappingFingerprints(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    idSha256: sha256(`mapping-${index + 1}`),
    rowSha256: sha256(`mapping-row-${index + 1}`),
  }));
}

function shadow({
  role,
  capturedAt,
  count,
  fencedAt = null,
}: {
  role: "SOURCE_POST_FENCE" | "TARGET_BEFORE_DELTA" | "TARGET_CORRECTED";
  capturedAt: string;
  count: number;
  fencedAt?: string | null;
}) {
  const sourceFence = role === "SOURCE_POST_FENCE"
    ? { fencedAt, expectedControlState: true, marker: [marker()] }
    : null;
  const lastIndex = count;
  return {
    schemaVersion: "agora-shadow-v2",
    connections: [{
      connectionId: CONNECTION_ID,
      cursor: {
        lastBusinessDaySynced: `2026-08-0${lastIndex + 2}`,
        lastSyncAt: `2026-08-0${lastIndex + 2}T13:40:25.722Z`,
      },
      events: Array.from({ length: count }, (_, index) => event(index + 1)),
      receipts: Array.from({ length: count }, (_, index) => receipt(index + 1)),
    }],
    capture: {
      version: 1,
      kind: "RUNTIME_FLEET_CONNECTION_STATE_CAPTURE",
      connectionId: CONNECTION_ID,
      role,
      capturedAt,
      mappingFingerprints: mappingFingerprints(count),
      fence: sourceFence,
    },
  };
}

function sources() {
  const sourceA = shadow({
    role: "SOURCE_POST_FENCE",
    capturedAt: CAPTURE_A_AT,
    count: 2,
    fencedAt: FENCED_AT,
  });
  const sourceB = shadow({
    role: "SOURCE_POST_FENCE",
    capturedAt: CAPTURE_B_AT,
    count: 2,
    fencedAt: FENCED_AT,
  });
  const targetBefore = shadow({
    role: "TARGET_BEFORE_DELTA",
    capturedAt: "2026-08-04T13:50:00.000Z",
    count: 1,
  });
  const targetCorrected = shadow({
    role: "TARGET_CORRECTED",
    capturedAt: TARGET_CORRECTED_AT,
    count: 2,
  });
  return {
    connectionId: CONNECTION_ID,
    sourceCaptureASource: Buffer.from(`${JSON.stringify(sourceA, null, 2)}\n`),
    sourceCaptureBSource: Buffer.from(`${JSON.stringify(sourceB, null, 2)}\n`),
    targetBeforeSource: Buffer.from(`${JSON.stringify(targetBefore, null, 2)}\n`),
    targetCorrectedShadowSource: Buffer.from(`${JSON.stringify(targetCorrected, null, 2)}\n`),
    applySource: Buffer.from("begin; -- append-only final delta\ncommit;\n"),
    rollbackSource: Buffer.from("begin; -- remove only inserted ids\ncommit;\n"),
    readbackSource: Buffer.from('{"result":"RECONCILED_EXACT","remoteWrites":0}\n'),
    generatedAt: GENERATED_AT,
  };
}

function privateFile(directory: string, name: string, source: Buffer) {
  const path = join(directory, name);
  writeFileSync(path, source, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function fileFixture() {
  const inputDirectory = mkdtempSync(join(tmpdir(), "fleet-fenced-delta-input-"));
  const outputDirectory = mkdtempSync(join(tmpdir(), "fleet-fenced-delta-output-"));
  temporaryDirectories.push(inputDirectory, outputDirectory);
  chmodSync(inputDirectory, 0o700);
  chmodSync(outputDirectory, 0o700);
  const fixtureSources = sources();
  return {
    connectionId: CONNECTION_ID,
    sourceCaptureAPath: privateFile(inputDirectory, "source-a.json", fixtureSources.sourceCaptureASource),
    sourceCaptureBPath: privateFile(inputDirectory, "source-b.json", fixtureSources.sourceCaptureBSource),
    targetBeforePath: privateFile(inputDirectory, "target-before.json", fixtureSources.targetBeforeSource),
    targetCorrectedShadowPath: privateFile(
      inputDirectory,
      "target-corrected.json",
      fixtureSources.targetCorrectedShadowSource,
    ),
    applyPath: privateFile(inputDirectory, "apply.sql", fixtureSources.applySource),
    rollbackPath: privateFile(inputDirectory, "rollback.sql", fixtureSources.rollbackSource),
    readbackPath: privateFile(inputDirectory, "readback.json", fixtureSources.readbackSource),
    outputPath: join(outputDirectory, "fenced-final-delta.json"),
    generatedAt: GENERATED_AT,
    sources: fixtureSources,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("fleet fenced final delta generator", () => {
  it("builds the activation-compatible v2 artifact from two stable post-fence captures", () => {
    const fixture = sources();
    const manifest = buildFleetFencedFinalDelta(fixture);

    expect(manifest).toMatchObject({
      schemaVersion: 2,
      kind: "fenced-connection-final-delta",
      connectionId: CONNECTION_ID,
      generatedAt: GENERATED_AT,
      sourceSha256: sha256(fixture.sourceCaptureBSource),
      targetRawSha256: sha256(fixture.targetBeforeSource),
      targetCorrectedShadowSha256: sha256(fixture.targetCorrectedShadowSource),
      expected: {
        before: { events: 1, lines: 1, receipts: 1, mappings: 1 },
        after: { events: 2, lines: 2, receipts: 2, mappings: 2 },
        businessDayChanges: 0,
      },
      delta: { events: 1, lines: 1, receipts: 1, mappings: 1 },
      sourceFence: {
        minimumDrainMs: 130_000,
        expectedControlState: true,
        stable: true,
        fencedAt: FENCED_AT,
        capture1At: CAPTURE_A_AT,
        capture2At: CAPTURE_B_AT,
        drainObservedMs: 130_000,
        captureSeparationMs: 6_000,
      },
      cursor: {
        before: { day: "2026-08-03", sync: "2026-08-03T13:40:25.722Z" },
        after: { day: "2026-08-04", sync: "2026-08-04T13:40:25.722Z" },
      },
      applySha256: sha256(fixture.applySource),
      rollbackSha256: sha256(fixture.rollbackSource),
      readbackSha256: sha256(fixture.readbackSource),
      remoteWrites: 0,
    });
    expect(manifest.sourceFence.semanticSha256[0]).toBe(manifest.sourceFence.semanticSha256[1]);
    expect(manifest.sourceFence.captureSha256[0]).not.toBe(manifest.sourceFence.captureSha256[1]);
    expect(JSON.stringify(manifest)).not.toContain("invoice-2");
    expect(JSON.stringify(manifest)).not.toContain("order-2");
  });

  it("writes one immutable 0600 output and reports only hashes and non-secret metadata", () => {
    const fixture = fileFixture();
    const result = prepareFleetFencedFinalDelta(fixture);
    const output = readFileSync(fixture.outputPath);
    const manifest = JSON.parse(output.toString("utf8"));

    expect(result).toMatchObject({
      status: "RUNTIME_FLEET_FENCED_FINAL_DELTA_READY",
      connectionId: CONNECTION_ID,
      manifestPath: fixture.outputPath,
      manifestSha256: sha256(output),
      sourceRawSha256: manifest.sourceSha256,
      sourceSemanticSha256: manifest.evidence.sourceSemanticSha256,
      remoteMutations: 0,
    });
    expect(statSync(fixture.outputPath).mode & 0o777).toBe(0o600);
    expect(() => prepareFleetFencedFinalDelta(fixture)).toThrow(
      "RUNTIME_FLEET_FENCED_FINAL_DELTA_OUTPUT_ALREADY_EXISTS",
    );
  });

  it("fails closed for data drift, mapping drift and a corrected target that is not exact", () => {
    const dataDrift = sources();
    const changedCapture = JSON.parse(dataDrift.sourceCaptureBSource.toString("utf8"));
    changedCapture.connections[0].events[1].lines[0].qty = 7;
    dataDrift.sourceCaptureBSource = Buffer.from(`${JSON.stringify(changedCapture)}\n`);
    expect(() => buildFleetFencedFinalDelta(dataDrift)).toThrow(
      "RUNTIME_FLEET_FENCED_FINAL_DELTA_SOURCE_CAPTURES_NOT_RECONCILED_EXACT",
    );

    const mappingDrift = sources();
    const changedMapping = JSON.parse(mappingDrift.sourceCaptureBSource.toString("utf8"));
    changedMapping.capture.mappingFingerprints[1].rowSha256 = sha256("changed-row");
    mappingDrift.sourceCaptureBSource = Buffer.from(`${JSON.stringify(changedMapping)}\n`);
    expect(() => buildFleetFencedFinalDelta(mappingDrift)).toThrow(
      "RUNTIME_FLEET_FENCED_FINAL_DELTA_SOURCE_CAPTURE_MAPPINGS_MISMATCH",
    );

    const targetDrift = sources();
    const changedTarget = JSON.parse(targetDrift.targetCorrectedShadowSource.toString("utf8"));
    changedTarget.connections[0].events[1].lines[0].format = "BOTTLE";
    targetDrift.targetCorrectedShadowSource = Buffer.from(`${JSON.stringify(changedTarget)}\n`);
    expect(() => buildFleetFencedFinalDelta(targetDrift)).toThrow(
      "RUNTIME_FLEET_FENCED_FINAL_DELTA_TARGET_CORRECTED_NOT_RECONCILED_EXACT",
    );
  });

  it("requires disabled writers, a 130 second drain, capture separation and fresh evidence", () => {
    const writerEnabled = sources();
    const capture = JSON.parse(writerEnabled.sourceCaptureASource.toString("utf8"));
    capture.capture.fence.marker[0].enabled = true;
    writerEnabled.sourceCaptureASource = Buffer.from(`${JSON.stringify(capture)}\n`);
    expect(() => buildFleetFencedFinalDelta(writerEnabled)).toThrow(
      "RUNTIME_FLEET_FENCED_FINAL_DELTA_SOURCE_CAPTURE_A_MARKER_NOT_FENCED",
    );

    const shortDrain = sources();
    const early = JSON.parse(shortDrain.sourceCaptureASource.toString("utf8"));
    early.capture.capturedAt = "2026-08-04T14:02:09.999Z";
    shortDrain.sourceCaptureASource = Buffer.from(`${JSON.stringify(early)}\n`);
    expect(() => buildFleetFencedFinalDelta(shortDrain)).toThrow(
      "RUNTIME_FLEET_FENCED_FINAL_DELTA_SOURCE_DRAIN_WINDOW_NOT_SATISFIED",
    );

    const tooClose = sources();
    const second = JSON.parse(tooClose.sourceCaptureBSource.toString("utf8"));
    second.capture.capturedAt = "2026-08-04T14:02:14.999Z";
    tooClose.sourceCaptureBSource = Buffer.from(`${JSON.stringify(second)}\n`);
    expect(() => buildFleetFencedFinalDelta(tooClose)).toThrow(
      "RUNTIME_FLEET_FENCED_FINAL_DELTA_SOURCE_CAPTURES_TOO_CLOSE",
    );

    const stale = sources();
    stale.generatedAt = "2026-08-04T14:17:16.001Z";
    expect(() => buildFleetFencedFinalDelta(stale)).toThrow(
      "RUNTIME_FLEET_FENCED_FINAL_DELTA_SOURCE_CAPTURE_EVIDENCE_STALE",
    );
  });

  it("rejects mutation of existing target history and a negative delta", () => {
    const changedHistory = sources();
    const target = JSON.parse(changedHistory.targetBeforeSource.toString("utf8"));
    target.connections[0].events[0].lines[0].qty = 9;
    changedHistory.targetBeforeSource = Buffer.from(`${JSON.stringify(target)}\n`);
    expect(() => buildFleetFencedFinalDelta(changedHistory)).toThrow(
      "RUNTIME_FLEET_FENCED_FINAL_DELTA_NON_APPEND_ONLY_LINES",
    );

    const largerTarget = sources();
    const targetWithThree = shadow({
      role: "TARGET_BEFORE_DELTA",
      capturedAt: "2026-08-04T13:50:00.000Z",
      count: 3,
    });
    largerTarget.targetBeforeSource = Buffer.from(`${JSON.stringify(targetWithThree)}\n`);
    expect(() => buildFleetFencedFinalDelta(largerTarget)).toThrow(
      "RUNTIME_FLEET_FENCED_FINAL_DELTA_NON_APPEND_ONLY_EVENTS",
    );
  });

  it("rejects public or symlinked evidence before reading it", () => {
    const publicFixture = fileFixture();
    chmodSync(publicFixture.sourceCaptureAPath, 0o644);
    expect(() => prepareFleetFencedFinalDelta(publicFixture)).toThrow(
      "RUNTIME_FLEET_FENCED_FINAL_DELTA_SOURCE_CAPTURE_A_MUST_BE_PRIVATE_0600",
    );

    const symlinkFixture = fileFixture();
    const linkPath = join(
      symlinkFixture.sourceCaptureAPath.slice(0, symlinkFixture.sourceCaptureAPath.lastIndexOf("/")),
      "source-a-link.json",
    );
    symlinkSync(symlinkFixture.sourceCaptureAPath, linkPath);
    symlinkFixture.sourceCaptureAPath = linkPath;
    expect(() => prepareFleetFencedFinalDelta(symlinkFixture)).toThrow(
      "RUNTIME_FLEET_FENCED_FINAL_DELTA_SOURCE_CAPTURE_A_MUST_BE_REGULAR_FILE",
    );
  });
});
