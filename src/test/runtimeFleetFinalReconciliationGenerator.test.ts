import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildFleetFinalReconciliation,
  FleetFinalReconciliationError,
  prepareFleetFinalReconciliation,
} from "../../infrastructure/runtime/prepare-fleet-final-reconciliation.mjs";

const execFileAsync = promisify(execFile);
const CONNECTION_ID = "8466c229-773d-4ad9-a747-9bb862d7ae6b";
const temporaryDirectories: string[] = [];
const scriptPath = resolve(process.cwd(), "infrastructure/runtime/prepare-fleet-final-reconciliation.mjs");

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function line() {
  return {
    providerLineId: "provider-line-1",
    providerProductId: "provider-product-1",
    format: "BOTTLE",
    qty: 1,
    soldAt: "2026-08-04T12:01:00Z",
    mapping: {
      mapped: true,
      status: "CONFIRMED",
      winerimProductId: "wine-1",
      winerimFormat: "BOTTLE",
    },
  };
}

function shadow() {
  return {
    schemaVersion: "agora-shadow-v2",
    connections: [{
      connectionId: CONNECTION_ID,
      cursor: {
        lastBusinessDaySynced: "2026-08-04",
        lastSyncAt: "2026-08-04T12:05:00Z",
      },
      events: [{
        businessDay: "2026-08-04",
        providerDocId: "invoice-1",
        docType: "INVOICE",
        orderId: "order-1",
        soldAt: "2026-08-04T12:00:00Z",
        lines: [line()],
      }],
      receipts: [{
        receiptId: "receipt-1",
        businessDay: "2026-08-04",
        providerDocId: "invoice-1",
        orderId: "order-1",
        status: "SUCCESS",
        live: true,
        stockApplied: true,
        duplicate: false,
        payloadSha256: "a".repeat(64),
      }],
    }],
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

function privateJson(directory: string, name: string, value: unknown, mode = 0o600) {
  const path = join(directory, name);
  const source = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, source, { mode });
  chmodSync(path, mode);
  return { path, source: Buffer.from(source), sha256: sha256(source) };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "fleet-final-reconciliation-"));
  temporaryDirectories.push(directory);
  const source = privateJson(directory, "source-shadow.json", shadow());
  const target = privateJson(directory, "target-shadow.json", shadow());
  const finalTargetRaw = privateJson(directory, "final-target-raw.json", {
    schemaVersion: 2,
    kind: "target-raw-corrected",
    connectionId: CONNECTION_ID,
    target: "own-supabase",
    window: { fromBusinessDay: "2026-08-04", throughBusinessDay: "2026-08-04" },
    capturedAt: "2026-08-04T12:06:00Z",
    marker: [{
      id: CONNECTION_ID,
      provider: "agora",
      enabled: false,
      catalog_sync_enabled: false,
      write_mode: "NONE",
      last_business_day_synced: "2026-08-04",
      last_sync_at: "2026-08-04T12:05:00Z",
      updated_at: "2026-08-04T12:05:00Z",
      provider_config: {},
    }],
    tables: {
      sales_events: [{ id: "event-1", connection_id: CONNECTION_ID, business_day: "2026-08-04" }],
      sales_line_items: [{ id: "line-1", connection_id: CONNECTION_ID }],
      stock_sync_log: [{ id: "receipt-1", connection_id: CONNECTION_ID }],
      product_mappings: [{ id: "mapping-1", connection_id: CONNECTION_ID }],
    },
  });
  const delta = privateJson(directory, "final-delta.json", {
    schemaVersion: 2,
    kind: "fenced-connection-final-delta",
    connectionId: CONNECTION_ID,
    sourceSha256: source.sha256,
    targetRawSha256: sha256("target-before-final-delta"),
    targetCorrectedShadowSha256: target.sha256,
    expected: {
      before: { events: 0, lines: 0, receipts: 0, mappings: 0 },
      after: { events: 1, lines: 1, receipts: 1, mappings: 1 },
      businessDayChanges: 0,
    },
    delta: { events: 1, lines: 1, receipts: 1, mappings: 1 },
    sourceFence: {
      minimumDrainMs: 130_000,
      expectedControlState: true,
      markerBefore: [disabledMarker()],
      markerAfter: [disabledMarker()],
      stable: true,
    },
    cursor: {
      before: { day: "2026-08-03", sync: "2026-08-04T10:00:00Z" },
      after: { day: "2026-08-04", sync: "2026-08-04T12:05:00Z" },
    },
    applySha256: sha256("apply"),
    rollbackSha256: sha256("rollback"),
    readbackSha256: sha256("readback"),
    remoteWrites: 0,
  });
  return {
    directory,
    source,
    target,
    finalTargetRaw,
    delta,
    options: {
      connectionId: CONNECTION_ID,
      sourceShadowPath: source.path,
      targetShadowPath: target.path,
      finalTargetRawPath: finalTargetRaw.path,
      finalDeltaManifestPath: delta.path,
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime fleet final reconciliation generator", () => {
  it("derives the exact activation contract and writes one private local artifact", async () => {
    const data = fixture();
    const outputDirectory = mkdtempSync(join(tmpdir(), "fleet-final-reconciliation-output-"));
    temporaryDirectories.push(outputDirectory);
    const outputPath = join(outputDirectory, "final-reconciliation.json");
    const result = await prepareFleetFinalReconciliation({ ...data.options, outputPath });

    expect(result).toMatchObject({
      status: "RUNTIME_FLEET_FINAL_RECONCILIATION_READY",
      remoteWrites: 0,
      outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(lstatSync(outputPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual({
      version: 1,
      kind: "RUNTIME_FLEET_FINAL_RECONCILIATION",
      connectionId: CONNECTION_ID,
      result: "RECONCILED_EXACT",
      differences: 0,
      finalDeltaManifestSha256: data.delta.sha256,
      sourceRawSha256: data.source.sha256,
      targetRawSha256: data.finalTargetRaw.sha256,
      counts: { events: 1, lines: 1, receipts: 1, mappings: 1 },
      cursor: { day: "2026-08-04", sync: "2026-08-04T12:05:00.000Z" },
    });
    expect(readFileSync(outputPath, "utf8")).not.toContain("invoice-1");
    expect(readFileSync(outputPath, "utf8")).not.toContain("provider-product-1");
  });

  it("fails closed for a shadow difference without creating output", async () => {
    const data = fixture();
    const changed = shadow();
    changed.connections[0].events[0].lines[0].qty = 2;
    const target = privateJson(data.directory, "different-target.json", changed);
    const deltaValue = JSON.parse(data.delta.source.toString("utf8"));
    deltaValue.targetCorrectedShadowSha256 = target.sha256;
    const delta = privateJson(data.directory, "different-delta.json", deltaValue);
    const outputPath = join(data.directory, "must-not-exist.json");

    await expect(prepareFleetFinalReconciliation({
      ...data.options,
      targetShadowPath: target.path,
      finalDeltaManifestPath: delta.path,
      outputPath,
    })).rejects.toMatchObject<Partial<FleetFinalReconciliationError>>({
      code: "RUNTIME_FLEET_FINAL_RECONCILIATION_SHADOWS_NOT_RECONCILED_EXACT",
    });
    expect(() => lstatSync(outputPath)).toThrow();
  });

  it("rejects unbound artifacts, nonzero differences and watermark drift", async () => {
    const unbound = fixture();
    const unboundDelta = JSON.parse(unbound.delta.source.toString("utf8"));
    unboundDelta.sourceSha256 = sha256("different-source");
    const unboundPath = privateJson(unbound.directory, "unbound-delta.json", unboundDelta).path;
    await expect(buildFleetFinalReconciliation({
      ...unbound.options,
      finalDeltaManifestPath: unboundPath,
    })).rejects.toMatchObject({
      code: "RUNTIME_FLEET_FINAL_RECONCILIATION_FINAL_DELTA_CONTRACT_MISMATCH",
    });

    const drift = fixture();
    const driftRaw = JSON.parse(drift.finalTargetRaw.source.toString("utf8"));
    driftRaw.marker[0].last_sync_at = "2026-08-04T12:04:00Z";
    const driftPath = privateJson(drift.directory, "drift-target-raw.json", driftRaw).path;
    await expect(buildFleetFinalReconciliation({
      ...drift.options,
      finalTargetRawPath: driftPath,
    })).rejects.toMatchObject({
      code: "RUNTIME_FLEET_FINAL_RECONCILIATION_FINAL_WATERMARK_MISMATCH",
    });
  });

  it("accepts only private regular input files and an exclusive output outside the repository", async () => {
    const data = fixture();
    const publicSource = privateJson(data.directory, "public-source.json", shadow(), 0o644);
    await expect(buildFleetFinalReconciliation({
      ...data.options,
      sourceShadowPath: publicSource.path,
    })).rejects.toMatchObject({
      code: "RUNTIME_FLEET_FINAL_RECONCILIATION_SOURCE_SHADOW_MUST_BE_PRIVATE_0400_OR_0600",
    });

    const symlinkPath = join(data.directory, "source-link.json");
    symlinkSync(data.source.path, symlinkPath);
    await expect(buildFleetFinalReconciliation({
      ...data.options,
      sourceShadowPath: symlinkPath,
    })).rejects.toMatchObject({
      code: "RUNTIME_FLEET_FINAL_RECONCILIATION_SOURCE_SHADOW_MUST_BE_REGULAR_FILE",
    });

    const insideRepository = resolve(process.cwd(), "final-reconciliation-unsafe.json");
    await expect(prepareFleetFinalReconciliation({
      ...data.options,
      outputPath: insideRepository,
    })).rejects.toMatchObject({
      code: "RUNTIME_FLEET_FINAL_RECONCILIATION_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY",
    });
  });

  it("requires an explicit matching CLI confirmation and emits no identifiers", async () => {
    const data = fixture();
    const outputDirectory = mkdtempSync(join(tmpdir(), "fleet-final-reconciliation-cli-"));
    temporaryDirectories.push(outputDirectory);
    const outputPath = join(outputDirectory, "final-reconciliation.json");
    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      "--render",
      "--connection-id", CONNECTION_ID,
      "--confirm-connection", CONNECTION_ID,
      "--source-shadow", data.source.path,
      "--target-shadow", data.target.path,
      "--final-target-raw", data.finalTargetRaw.path,
      "--final-delta", data.delta.path,
      "--output", outputPath,
    ]);
    expect(JSON.parse(stdout)).toMatchObject({
      status: "RUNTIME_FLEET_FINAL_RECONCILIATION_READY",
      remoteWrites: 0,
    });
    expect(stdout).not.toContain(CONNECTION_ID);
    expect(stdout).not.toContain(outputPath);

    await expect(execFileAsync(process.execPath, [
      scriptPath,
      "--render",
      "--connection-id", CONNECTION_ID,
      "--confirm-connection", "11111111-1111-4111-8111-111111111111",
    ])).rejects.toMatchObject({ code: 2 });
  });
});
