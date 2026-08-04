#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { reconcilePrivateFiles } from "../../scripts/agora-shadow-reconcile.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PRIVATE_MODES = new Set([0o400, 0o600]);
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MIN_WRITER_DRAIN_MS = 130_000;
const COUNT_KEYS = ["events", "lines", "receipts", "mappings"];
const TARGET_TABLES = {
  events: "sales_events",
  lines: "sales_line_items",
  receipts: "stock_sync_log",
  mappings: "product_mappings",
};
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

export class FleetFinalReconciliationError extends Error {
  constructor(code) {
    super(code);
    this.name = "FleetFinalReconciliationError";
    this.code = code;
  }
}

function fail(code) {
  throw new FleetFinalReconciliationError(`RUNTIME_FLEET_FINAL_RECONCILIATION_${code}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`INVALID_${label}`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`INVALID_${label}_STRUCTURE`);
  }
}

function normalizedConnectionId(value) {
  const connectionId = String(value ?? "").trim().toLowerCase();
  if (!UUID_PATTERN.test(connectionId)) fail("INVALID_CONNECTION_ID");
  return connectionId;
}

function canonicalDate(value, label) {
  if (!DATE_PATTERN.test(value ?? "")) fail(`INVALID_${label}`);
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    fail(`INVALID_${label}`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`INVALID_${label}`);
  return new Date(parsed).toISOString();
}

function nonnegativeInteger(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) fail(`INVALID_${label}`);
  return value;
}

function validateCounts(value, label, { requireHistory = false } = {}) {
  exactKeys(value, COUNT_KEYS, label);
  return {
    events: nonnegativeInteger(value.events, `${label}_EVENTS`, { positive: requireHistory }),
    lines: nonnegativeInteger(value.lines, `${label}_LINES`, { positive: requireHistory }),
    receipts: nonnegativeInteger(value.receipts, `${label}_RECEIPTS`),
    mappings: nonnegativeInteger(value.mappings, `${label}_MAPPINGS`),
  };
}

function isOutsideRepository(path) {
  const candidate = relative(repoRoot, path);
  return candidate !== "" && (candidate.startsWith("..") || candidate.startsWith("/"));
}

function readPrivateJson(pathValue, label) {
  if (!isAbsolute(pathValue ?? "")) fail(`${label}_PATH_MUST_BE_ABSOLUTE`);
  const path = resolve(pathValue);
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail(`${label}_NOT_FOUND`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${label}_MUST_BE_REGULAR_FILE`);
  if (!PRIVATE_MODES.has(metadata.mode & 0o777)) fail(`${label}_MUST_BE_PRIVATE_0400_OR_0600`);
  if (metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) fail(`${label}_INVALID_SIZE`);

  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = lstatSync(path);
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      fail(`${label}_CHANGED_DURING_OPEN`);
    }
    const source = readFileSync(descriptor);
    let value;
    try {
      value = JSON.parse(source.toString("utf8"));
    } catch {
      fail(`INVALID_${label}_JSON`);
    }
    return { path, source, sha256: sha256(source), value };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function matchingShadowConnection(shadow, connectionId, label) {
  if (!shadow || typeof shadow !== "object" || !Array.isArray(shadow.connections)) {
    fail(`INVALID_${label}_SHADOW`);
  }
  const matches = shadow.connections.filter((entry) => (
    String(entry?.connectionId ?? entry?.connection_id ?? "").trim().toLowerCase() === connectionId
  ));
  if (matches.length !== 1) fail(`${label}_SHADOW_CONNECTION_SCOPE_MISMATCH`);
  return matches[0];
}

function shadowCursor(connection, label) {
  const cursor = connection?.cursor;
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) fail(`INVALID_${label}_CURSOR`);
  const day = cursor.lastBusinessDaySynced ?? cursor.last_business_day_synced;
  const sync = cursor.lastSyncAt ?? cursor.last_sync_at;
  return {
    day: canonicalDate(day, `${label}_CURSOR_DAY`),
    sync: canonicalTimestamp(sync, `${label}_CURSOR_SYNC`),
  };
}

function disabledFenceMarker(marker, connectionId) {
  return marker?.id === connectionId
    && marker.provider === "agora"
    && marker.enabled === false
    && marker.catalog_sync_enabled === false
    && marker.scheduler?.intraday_sales_sync_enabled === false
    && marker.scheduler?.open_tickets_stock_sync_enabled === false
    && marker.scheduler?.open_tickets_sync_enabled === false;
}

function validateFinalDelta(manifest, {
  connectionId,
  sourceShadowSha256,
  targetShadowSha256,
}) {
  if (
    manifest?.schemaVersion !== 2
    || manifest?.kind !== "fenced-connection-final-delta"
    || manifest.connectionId !== connectionId
    || manifest.sourceSha256 !== sourceShadowSha256
    || manifest.targetCorrectedShadowSha256 !== targetShadowSha256
    || !SHA256_PATTERN.test(manifest.targetRawSha256 ?? "")
    || !SHA256_PATTERN.test(manifest.applySha256 ?? "")
    || !SHA256_PATTERN.test(manifest.rollbackSha256 ?? "")
    || !SHA256_PATTERN.test(manifest.readbackSha256 ?? "")
    || manifest.remoteWrites !== 0
    || manifest.expected?.businessDayChanges !== 0
    || manifest.sourceFence?.minimumDrainMs < MIN_WRITER_DRAIN_MS
    || manifest.sourceFence?.expectedControlState !== true
    || manifest.sourceFence?.stable !== true
  ) {
    fail("FINAL_DELTA_CONTRACT_MISMATCH");
  }
  const before = validateCounts(manifest.expected.before, "FINAL_DELTA_BEFORE");
  const after = validateCounts(manifest.expected.after, "FINAL_DELTA_AFTER", { requireHistory: true });
  const delta = validateCounts(manifest.delta, "FINAL_DELTA_DELTA");
  for (const key of COUNT_KEYS) {
    if (before[key] + delta[key] !== after[key]) fail("FINAL_DELTA_ARITHMETIC_MISMATCH");
  }
  if (
    !Array.isArray(manifest.sourceFence.markerBefore)
    || manifest.sourceFence.markerBefore.length !== 1
    || !Array.isArray(manifest.sourceFence.markerAfter)
    || manifest.sourceFence.markerAfter.length !== 1
    || !disabledFenceMarker(manifest.sourceFence.markerBefore[0], connectionId)
    || !disabledFenceMarker(manifest.sourceFence.markerAfter[0], connectionId)
  ) {
    fail("FINAL_DELTA_FENCE_MISMATCH");
  }
  return {
    after,
    cursor: {
      day: canonicalDate(manifest.cursor?.after?.day, "FINAL_DELTA_CURSOR_DAY"),
      sync: canonicalTimestamp(manifest.cursor?.after?.sync, "FINAL_DELTA_CURSOR_SYNC"),
    },
  };
}

function validateFinalTargetRaw(raw, connectionId) {
  exactKeys(raw, [
    "schemaVersion",
    "kind",
    "connectionId",
    "target",
    "window",
    "capturedAt",
    "marker",
    "tables",
  ], "FINAL_TARGET_RAW");
  if (
    raw.schemaVersion !== 2
    || raw.kind !== "target-raw-corrected"
    || raw.connectionId !== connectionId
    || typeof raw.target !== "string"
    || !raw.target.trim()
  ) {
    fail("FINAL_TARGET_RAW_CONTRACT_MISMATCH");
  }
  canonicalTimestamp(raw.capturedAt, "FINAL_TARGET_RAW_CAPTURED_AT");
  exactKeys(raw.window, ["fromBusinessDay", "throughBusinessDay"], "FINAL_TARGET_RAW_WINDOW");
  const fromBusinessDay = canonicalDate(raw.window.fromBusinessDay, "FINAL_TARGET_RAW_FROM_DAY");
  const throughBusinessDay = canonicalDate(raw.window.throughBusinessDay, "FINAL_TARGET_RAW_THROUGH_DAY");
  if (fromBusinessDay > throughBusinessDay) fail("FINAL_TARGET_RAW_INVALID_WINDOW");
  exactKeys(raw.tables, Object.values(TARGET_TABLES), "FINAL_TARGET_RAW_TABLES");
  const counts = {};
  for (const [countKey, table] of Object.entries(TARGET_TABLES)) {
    const rows = raw.tables[table];
    if (!Array.isArray(rows)) fail("FINAL_TARGET_RAW_TABLES_MISMATCH");
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row) || row.connection_id !== connectionId) {
        fail("FINAL_TARGET_RAW_CONNECTION_SCOPE_MISMATCH");
      }
    }
    counts[countKey] = rows.length;
  }
  const validatedCounts = validateCounts(counts, "FINAL_TARGET_RAW_COUNTS", { requireHistory: true });
  if (!Array.isArray(raw.marker) || raw.marker.length !== 1) fail("FINAL_TARGET_RAW_MARKER_MISMATCH");
  const marker = raw.marker[0];
  if (
    marker?.id !== connectionId
    || marker.provider !== "agora"
    || marker.enabled !== false
    || marker.catalog_sync_enabled !== false
    || marker.write_mode !== "NONE"
  ) {
    fail("FINAL_TARGET_RAW_MARKER_MISMATCH");
  }
  const cursor = {
    day: canonicalDate(marker.last_business_day_synced, "FINAL_TARGET_RAW_CURSOR_DAY"),
    sync: canonicalTimestamp(marker.last_sync_at, "FINAL_TARGET_RAW_CURSOR_SYNC"),
  };
  canonicalTimestamp(marker.updated_at, "FINAL_TARGET_RAW_UPDATED_AT");
  const businessDays = raw.tables.sales_events.map((event) => (
    canonicalDate(event.business_day, "FINAL_TARGET_RAW_EVENT_BUSINESS_DAY")
  ));
  const maxBusinessDay = businessDays.reduce((latest, day) => day > latest ? day : latest);
  if (maxBusinessDay !== throughBusinessDay) fail("FINAL_TARGET_RAW_WATERMARK_MISMATCH");
  const cursorLagDays = (
    Date.parse(`${maxBusinessDay}T00:00:00.000Z`)
    - Date.parse(`${cursor.day}T00:00:00.000Z`)
  ) / 86_400_000;
  if (!Number.isInteger(cursorLagDays) || cursorLagDays < 0 || cursorLagDays > 1) {
    fail("FINAL_TARGET_RAW_CURSOR_MISMATCH");
  }
  return { counts: validatedCounts, cursor };
}

function validateReconciliationReport(report, {
  connectionId,
  counts,
  sourceShadowSha256,
  targetShadowSha256,
}) {
  if (
    report?.schemaVersion !== "agora-shadow-v2"
    || report.result !== "RECONCILED_EXACT"
    || report.dryRun !== true
    || report.writes !== false
    || report.summary?.reconciledConnections !== 1
    || report.summary?.differingConnections !== 0
    || report.summary?.differences !== 0
    || !Array.isArray(report.differences)
    || report.differences.length !== 0
    || report.scope?.connectionCount !== 1
    || canonicalJson(report.scope?.connectionIds) !== canonicalJson([connectionId])
    || report.inputs?.lovableSha256 !== sourceShadowSha256
    || report.inputs?.ownSha256 !== targetShadowSha256
    || !Array.isArray(report.connections)
    || report.connections.length !== 1
  ) {
    fail("SHADOWS_NOT_RECONCILED_EXACT");
  }
  const connection = report.connections[0];
  if (
    connection.connectionId !== connectionId
    || connection.status !== "RECONCILED_EXACT"
    || connection.events !== counts.events
    || connection.lines !== counts.lines
    || connection.receipts !== counts.receipts
    || !SHA256_PATTERN.test(report.reportSha256 ?? "")
  ) {
    fail("SHADOW_RECONCILIATION_COUNTS_MISMATCH");
  }
}

export async function buildFleetFinalReconciliation({
  connectionId: connectionIdValue,
  sourceShadowPath,
  targetShadowPath,
  finalTargetRawPath,
  finalDeltaManifestPath,
}) {
  const connectionId = normalizedConnectionId(connectionIdValue);
  const sourceShadow = readPrivateJson(sourceShadowPath, "SOURCE_SHADOW");
  const targetShadow = readPrivateJson(targetShadowPath, "TARGET_SHADOW");
  const finalTargetRaw = readPrivateJson(finalTargetRawPath, "FINAL_TARGET_RAW");
  const finalDeltaManifest = readPrivateJson(finalDeltaManifestPath, "FINAL_DELTA_MANIFEST");
  const sourceConnection = matchingShadowConnection(sourceShadow.value, connectionId, "SOURCE");
  const targetConnection = matchingShadowConnection(targetShadow.value, connectionId, "TARGET");
  const sourceCursor = shadowCursor(sourceConnection, "SOURCE_SHADOW");
  const targetCursor = shadowCursor(targetConnection, "TARGET_SHADOW");
  if (canonicalJson(sourceCursor) !== canonicalJson(targetCursor)) fail("SHADOW_CURSOR_MISMATCH");

  let report;
  try {
    report = await reconcilePrivateFiles({
      lovablePath: sourceShadow.path,
      ownPath: targetShadow.path,
      connectionIds: [connectionId],
    });
  } catch {
    fail("SHADOW_RECONCILIATION_BLOCKED");
  }
  const targetRaw = validateFinalTargetRaw(finalTargetRaw.value, connectionId);
  const finalDelta = validateFinalDelta(finalDeltaManifest.value, {
    connectionId,
    sourceShadowSha256: sourceShadow.sha256,
    targetShadowSha256: targetShadow.sha256,
  });
  validateReconciliationReport(report, {
    connectionId,
    counts: finalDelta.after,
    sourceShadowSha256: sourceShadow.sha256,
    targetShadowSha256: targetShadow.sha256,
  });
  if (
    canonicalJson(finalDelta.after) !== canonicalJson(targetRaw.counts)
    || canonicalJson(finalDelta.cursor) !== canonicalJson(targetRaw.cursor)
    || canonicalJson(finalDelta.cursor) !== canonicalJson(targetCursor)
  ) {
    fail("FINAL_WATERMARK_MISMATCH");
  }
  return {
    version: 1,
    kind: "RUNTIME_FLEET_FINAL_RECONCILIATION",
    connectionId,
    result: "RECONCILED_EXACT",
    differences: 0,
    finalDeltaManifestSha256: finalDeltaManifest.sha256,
    sourceRawSha256: sourceShadow.sha256,
    targetRawSha256: finalTargetRaw.sha256,
    counts: finalDelta.after,
    cursor: finalDelta.cursor,
  };
}

function validateOutputPath(outputPath) {
  if (!isAbsolute(outputPath ?? "")) fail("OUTPUT_PATH_MUST_BE_ABSOLUTE");
  const target = resolve(outputPath);
  if (!isOutsideRepository(target)) fail("OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  if (existsSync(target)) fail("OUTPUT_ALREADY_EXISTS");
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const realParent = realpathSync(parent);
  if (!isOutsideRepository(realParent)) fail("OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  if ((lstatSync(realParent).mode & 0o077) !== 0) fail("OUTPUT_PARENT_MUST_BE_PRIVATE_0700");
  return { target, realParent };
}

function writePrivateExclusive(target, realParent, source) {
  const staging = join(realParent, `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(
      staging,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, source);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(staging, 0o600);
    linkSync(staging, target);
    unlinkSync(staging);
    chmodSync(target, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(staging)) unlinkSync(staging);
    throw error;
  }
}

export async function prepareFleetFinalReconciliation(options) {
  const manifest = await buildFleetFinalReconciliation(options);
  const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
  const { target, realParent } = validateOutputPath(options.outputPath);
  writePrivateExclusive(target, realParent, manifestSource);
  return {
    status: "RUNTIME_FLEET_FINAL_RECONCILIATION_READY",
    remoteWrites: 0,
    outputSha256: sha256(manifestSource),
    manifest,
  };
}

export function fleetFinalReconciliationPlan() {
  return {
    status: "RUNTIME_FLEET_FINAL_RECONCILIATION_PLAN_ONLY",
    remoteWrites: 0,
    outputMode: "0600",
    requiresExactPrivateShadows: true,
    requiresExactFinalDelta: true,
    requiresExactFinalTargetRaw: true,
    renderGate: "--render --connection-id=<UUID> --confirm-connection=<UUID> --source-shadow=/private/source.json --target-shadow=/private/target.json --final-target-raw=/private/target-raw.json --final-delta=/private/final-delta.json --output=/private/new-file.json",
  };
}

function parseArgs(argv) {
  if (!argv.length) return { plan: true };
  const options = { render: false };
  const names = new Map([
    ["--connection-id", "connectionId"],
    ["--confirm-connection", "confirmConnection"],
    ["--source-shadow", "sourceShadowPath"],
    ["--target-shadow", "targetShadowPath"],
    ["--final-target-raw", "finalTargetRawPath"],
    ["--final-delta", "finalDeltaManifestPath"],
    ["--output", "outputPath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--render") {
      if (options.render) fail("CLI_DUPLICATE_RENDER");
      options.render = true;
      continue;
    }
    const name = names.get(token);
    const value = argv[index + 1];
    if (!name || !value || value.startsWith("--") || options[name] !== undefined) {
      fail("CLI_USAGE");
    }
    options[name] = value;
    index += 1;
  }
  if (!options.render || [...names.values()].some((name) => options[name] === undefined)) {
    fail("CLI_USAGE");
  }
  const connectionId = normalizedConnectionId(options.connectionId);
  if (normalizedConnectionId(options.confirmConnection) !== connectionId) fail("CONFIRMATION_MISMATCH");
  return { ...options, connectionId };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.plan) {
      process.stdout.write(`${JSON.stringify(fleetFinalReconciliationPlan(), null, 2)}\n`);
      return;
    }
    const result = await prepareFleetFinalReconciliation(options);
    process.stdout.write(`${JSON.stringify({
      status: result.status,
      remoteWrites: result.remoteWrites,
      outputSha256: result.outputSha256,
    }, null, 2)}\n`);
  } catch (error) {
    const code = error instanceof FleetFinalReconciliationError
      ? error.code
      : "RUNTIME_FLEET_FINAL_RECONCILIATION_UNEXPECTED_ERROR";
    process.stderr.write(`${JSON.stringify({ status: "BLOCKED", remoteWrites: 0, error: code })}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) await main();
