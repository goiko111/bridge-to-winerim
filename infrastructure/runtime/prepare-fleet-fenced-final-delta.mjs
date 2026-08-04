#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  normalizeArtifact,
  reconcileArtifacts,
} from "../../scripts/agora-shadow-reconcile.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MIN_WRITER_DRAIN_MS = 130 * 1_000;
const MIN_CAPTURE_SEPARATION_MS = 5 * 1_000;
const MAX_CAPTURE_AGE_MS = 15 * 60 * 1_000;
const CAPTURE_KIND = "RUNTIME_FLEET_CONNECTION_STATE_CAPTURE";
const FINAL_DELTA_KIND = "fenced-connection-final-delta";
const COUNT_KEYS = Object.freeze(["events", "lines", "receipts", "mappings"]);
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

function fail(code) {
  throw new Error(`RUNTIME_FLEET_FENCED_FINAL_DELTA_${code}`);
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`INVALID_${label}`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`INVALID_${label}_STRUCTURE`);
  }
}

function canonicalTimestamp(value, label) {
  const milliseconds = Date.parse(value ?? "");
  if (!Number.isFinite(milliseconds)) fail(`INVALID_${label}`);
  return { milliseconds, iso: new Date(milliseconds).toISOString() };
}

function canonicalDate(value, label) {
  if (!DATE_PATTERN.test(value ?? "")) fail(`INVALID_${label}`);
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value) {
    fail(`INVALID_${label}`);
  }
  return value;
}

function outsideRepository(path) {
  const candidate = relative(repoRoot, path);
  return candidate !== "" && (candidate.startsWith("..") || candidate.startsWith("/"));
}

function readPrivateRegularFile(path, label) {
  if (!isAbsolute(path)) fail(`${label}_PATH_MUST_BE_ABSOLUTE`);
  const resolved = resolve(path);
  if (!outsideRepository(resolved)) fail(`${label}_MUST_BE_OUTSIDE_REPOSITORY`);
  const metadata = lstatSync(resolved);
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${label}_MUST_BE_REGULAR_FILE`);
  let descriptor;
  try {
    descriptor = openSync(resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) fail(`${label}_MUST_BE_REGULAR_FILE`);
    if ((opened.mode & 0o777) !== 0o600) fail(`${label}_MUST_BE_PRIVATE_0600`);
    if (opened.size <= 0 || opened.size > MAX_INPUT_BYTES) fail(`${label}_INVALID_SIZE`);
    const source = readFileSync(descriptor);
    if (source.length !== opened.size) fail(`${label}_CHANGED_DURING_READ`);
    return source;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseJson(source, label) {
  try {
    return JSON.parse(source.toString("utf8"));
  } catch {
    fail(`INVALID_${label}_JSON`);
  }
}

function canonicalMappingFingerprints(value, label) {
  if (!Array.isArray(value)) fail(`INVALID_${label}`);
  const fingerprints = value.map((entry, index) => {
    exactKeys(entry, ["idSha256", "rowSha256"], `${label}_${index}`);
    const idSha256 = String(entry.idSha256 ?? "").toLowerCase();
    const rowSha256 = String(entry.rowSha256 ?? "").toLowerCase();
    if (!SHA256_PATTERN.test(idSha256) || !SHA256_PATTERN.test(rowSha256)) {
      fail(`INVALID_${label}_${index}`);
    }
    return { idSha256, rowSha256 };
  }).sort((left, right) => left.idSha256.localeCompare(right.idSha256));
  if (fingerprints.some((entry, index) => index > 0 && entry.idSha256 === fingerprints[index - 1].idSha256)) {
    fail(`DUPLICATE_${label}`);
  }
  return fingerprints;
}

function validateDisabledMarker(marker, connectionId, label) {
  exactKeys(
    marker,
    ["id", "provider", "enabled", "catalog_sync_enabled", "scheduler"],
    label,
  );
  exactKeys(
    marker.scheduler,
    ["intraday_sales_sync_enabled", "open_tickets_stock_sync_enabled", "open_tickets_sync_enabled"],
    `${label}_SCHEDULER`,
  );
  if (
    marker.id !== connectionId
    || marker.provider !== "agora"
    || marker.enabled !== false
    || marker.catalog_sync_enabled !== false
    || marker.scheduler.intraday_sales_sync_enabled !== false
    || marker.scheduler.open_tickets_stock_sync_enabled !== false
    || marker.scheduler.open_tickets_sync_enabled !== false
  ) {
    fail(`${label}_NOT_FENCED`);
  }
  return JSON.parse(canonicalJson(marker));
}

function captureEvidence(artifact, { connectionId, role, label }) {
  exactKeys(
    artifact.capture,
    ["version", "kind", "connectionId", "role", "capturedAt", "mappingFingerprints", "fence"],
    `${label}_CAPTURE`,
  );
  if (
    artifact.capture.version !== 1
    || artifact.capture.kind !== CAPTURE_KIND
    || artifact.capture.connectionId !== connectionId
    || artifact.capture.role !== role
  ) {
    fail(`INVALID_${label}_CAPTURE_IDENTITY`);
  }
  const capturedAt = canonicalTimestamp(artifact.capture.capturedAt, `${label}_CAPTURED_AT`);
  const mappingFingerprints = canonicalMappingFingerprints(
    artifact.capture.mappingFingerprints,
    `${label}_MAPPING_FINGERPRINTS`,
  );
  if (role === "SOURCE_POST_FENCE") {
    exactKeys(
      artifact.capture.fence,
      ["fencedAt", "expectedControlState", "marker"],
      `${label}_FENCE`,
    );
    if (artifact.capture.fence.expectedControlState !== true) fail(`${label}_FENCE_CONTROL_STATE_NOT_CONFIRMED`);
    const fencedAt = canonicalTimestamp(artifact.capture.fence.fencedAt, `${label}_FENCED_AT`);
    if (!Array.isArray(artifact.capture.fence.marker) || artifact.capture.fence.marker.length !== 1) {
      fail(`${label}_FENCE_MARKER_MUST_HAVE_ONE_ROW`);
    }
    return {
      capturedAt,
      mappingFingerprints,
      fence: {
        fencedAt,
        marker: [validateDisabledMarker(artifact.capture.fence.marker[0], connectionId, `${label}_MARKER`)],
      },
    };
  }
  if (artifact.capture.fence !== null) fail(`${label}_TARGET_FENCE_MUST_BE_NULL`);
  return { capturedAt, mappingFingerprints, fence: null };
}

function normalizedConnection(artifact, connectionId, label) {
  let normalized;
  try {
    normalized = normalizeArtifact(artifact, label);
  } catch {
    fail(`INVALID_${label}_SHADOW`);
  }
  if (normalized.connections.size !== 1 || !normalized.connections.has(connectionId)) {
    fail(`${label}_MUST_CONTAIN_EXACT_CONNECTION`);
  }
  return normalized.connections.get(connectionId);
}

function mapEntries(map) {
  return [...map.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function connectionSnapshot(artifact, source, { connectionId, role, label }) {
  if (artifact?.schemaVersion !== "agora-shadow-v2") fail(`INVALID_${label}_SHADOW_VERSION`);
  const evidence = captureEvidence(artifact, { connectionId, role, label });
  const connection = normalizedConnection(artifact, connectionId, label);
  const eventEntries = mapEntries(connection.events);
  const lineEntries = mapEntries(connection.lines);
  const receiptEntries = mapEntries(connection.receipts);
  const businessDays = eventEntries.map(([, event]) => canonicalDate(event.businessDay, `${label}_BUSINESS_DAY`));
  const lastBusinessDaySynced = canonicalDate(
    connection.cursor.lastBusinessDaySynced,
    `${label}_LAST_BUSINESS_DAY_SYNCED`,
  );
  const lastSyncAt = canonicalTimestamp(connection.cursor.lastSyncAt, `${label}_LAST_SYNC_AT`).iso;
  const counts = {
    events: eventEntries.length,
    lines: lineEntries.length,
    receipts: receiptEntries.length,
    mappings: evidence.mappingFingerprints.length,
  };
  const maxBusinessDay = businessDays.length ? businessDays.reduce((left, right) => left > right ? left : right) : null;
  const minBusinessDay = businessDays.length ? businessDays.reduce((left, right) => left < right ? left : right) : null;
  const semanticBody = {
    connectionId,
    cursor: { lastBusinessDaySynced, lastSyncAt },
    events: eventEntries,
    lines: lineEntries,
    receipts: receiptEntries,
    mappings: evidence.mappingFingerprints,
  };
  return {
    rawSha256: sha256(source),
    semanticSha256: sha256(canonicalJson(semanticBody)),
    capturedAt: evidence.capturedAt,
    fence: evidence.fence,
    counts,
    watermarks: { maxBusinessDay, lastBusinessDaySynced, lastSyncAt },
    window: { fromBusinessDay: minBusinessDay, throughBusinessDay: maxBusinessDay },
    maps: {
      events: connection.events,
      lines: connection.lines,
      receipts: connection.receipts,
      mappings: new Map(evidence.mappingFingerprints.map((entry) => [entry.idSha256, entry.rowSha256])),
    },
  };
}

function assertSame(left, right, label) {
  if (canonicalJson(left) !== canonicalJson(right)) fail(`${label}_MISMATCH`);
}

function assertMapSubset(before, after, label) {
  for (const [key, value] of before.entries()) {
    if (!after.has(key) || canonicalJson(after.get(key)) !== canonicalJson(value)) {
      fail(`NON_APPEND_ONLY_${label}`);
    }
  }
}

function assertExactReconciliation(leftArtifact, rightArtifact, connectionId, label) {
  let report;
  try {
    report = reconcileArtifacts(leftArtifact, rightArtifact, { connectionIds: [connectionId] });
  } catch {
    fail(`${label}_RECONCILIATION_FAILED`);
  }
  if (
    report.result !== "RECONCILED_EXACT"
    || report.writes !== false
    || report.summary.differences !== 0
    || report.connections.length !== 1
    || report.connections[0].connectionId !== connectionId
    || report.connections[0].status !== "RECONCILED_EXACT"
  ) {
    fail(`${label}_NOT_RECONCILED_EXACT`);
  }
  return report.reportSha256;
}

function deltaCounts(before, after) {
  const delta = {};
  for (const key of COUNT_KEYS) {
    const value = after[key] - before[key];
    if (!Number.isSafeInteger(value) || value < 0) fail(`NEGATIVE_OR_UNSAFE_DELTA_${key.toUpperCase()}`);
    delta[key] = value;
  }
  return delta;
}

function validateChronology({ first, second, targetBefore, targetCorrected, generatedAt }) {
  if (first.fence.fencedAt.iso !== second.fence.fencedAt.iso) fail("SOURCE_FENCE_TIMESTAMP_DRIFT");
  const drainObservedMs = first.capturedAt.milliseconds - first.fence.fencedAt.milliseconds;
  const captureSeparationMs = second.capturedAt.milliseconds - first.capturedAt.milliseconds;
  if (drainObservedMs < MIN_WRITER_DRAIN_MS) fail("SOURCE_DRAIN_WINDOW_NOT_SATISFIED");
  if (captureSeparationMs < MIN_CAPTURE_SEPARATION_MS) fail("SOURCE_CAPTURES_TOO_CLOSE");
  if (targetCorrected.capturedAt.milliseconds < second.capturedAt.milliseconds) {
    fail("TARGET_CORRECTED_CAPTURE_PRECEDES_STABLE_SOURCE");
  }
  if (targetBefore.capturedAt.milliseconds > targetCorrected.capturedAt.milliseconds) {
    fail("TARGET_CAPTURE_ORDER_INVALID");
  }
  if (generatedAt.milliseconds < targetCorrected.capturedAt.milliseconds) fail("GENERATED_AT_PRECEDES_EVIDENCE");
  if (generatedAt.milliseconds - second.capturedAt.milliseconds > MAX_CAPTURE_AGE_MS) {
    fail("SOURCE_CAPTURE_EVIDENCE_STALE");
  }
  return { drainObservedMs, captureSeparationMs };
}

export function buildFleetFencedFinalDelta({
  connectionId,
  sourceCaptureASource,
  sourceCaptureBSource,
  targetBeforeSource,
  targetCorrectedShadowSource,
  applySource,
  rollbackSource,
  readbackSource,
  generatedAt = new Date().toISOString(),
}) {
  const normalizedConnectionId = String(connectionId ?? "").trim().toLowerCase();
  if (!UUID_PATTERN.test(normalizedConnectionId)) fail("INVALID_CONNECTION_ID");
  for (const [label, source] of [
    ["SOURCE_CAPTURE_A", sourceCaptureASource],
    ["SOURCE_CAPTURE_B", sourceCaptureBSource],
    ["TARGET_BEFORE", targetBeforeSource],
    ["TARGET_CORRECTED_SHADOW", targetCorrectedShadowSource],
    ["APPLY", applySource],
    ["ROLLBACK", rollbackSource],
    ["READBACK", readbackSource],
  ]) {
    if (!Buffer.isBuffer(source) || source.length === 0) fail(`INVALID_${label}_SOURCE`);
  }
  const generated = canonicalTimestamp(generatedAt, "GENERATED_AT");
  const artifacts = {
    sourceA: parseJson(sourceCaptureASource, "SOURCE_CAPTURE_A"),
    sourceB: parseJson(sourceCaptureBSource, "SOURCE_CAPTURE_B"),
    targetBefore: parseJson(targetBeforeSource, "TARGET_BEFORE"),
    targetCorrected: parseJson(targetCorrectedShadowSource, "TARGET_CORRECTED_SHADOW"),
  };
  const sourceA = connectionSnapshot(artifacts.sourceA, sourceCaptureASource, {
    connectionId: normalizedConnectionId,
    role: "SOURCE_POST_FENCE",
    label: "SOURCE_CAPTURE_A",
  });
  const sourceB = connectionSnapshot(artifacts.sourceB, sourceCaptureBSource, {
    connectionId: normalizedConnectionId,
    role: "SOURCE_POST_FENCE",
    label: "SOURCE_CAPTURE_B",
  });
  const targetBefore = connectionSnapshot(artifacts.targetBefore, targetBeforeSource, {
    connectionId: normalizedConnectionId,
    role: "TARGET_BEFORE_DELTA",
    label: "TARGET_BEFORE",
  });
  const targetCorrected = connectionSnapshot(artifacts.targetCorrected, targetCorrectedShadowSource, {
    connectionId: normalizedConnectionId,
    role: "TARGET_CORRECTED",
    label: "TARGET_CORRECTED",
  });

  const sourceStabilityReportSha256 = assertExactReconciliation(
    artifacts.sourceA,
    artifacts.sourceB,
    normalizedConnectionId,
    "SOURCE_CAPTURES",
  );
  assertSame(sourceA.counts, sourceB.counts, "SOURCE_CAPTURE_COUNTS");
  assertSame(sourceA.watermarks, sourceB.watermarks, "SOURCE_CAPTURE_WATERMARKS");
  assertSame(sourceA.window, sourceB.window, "SOURCE_CAPTURE_WINDOW");
  assertSame(mapEntries(sourceA.maps.mappings), mapEntries(sourceB.maps.mappings), "SOURCE_CAPTURE_MAPPINGS");
  assertSame(sourceA.fence.marker, sourceB.fence.marker, "SOURCE_FENCE_MARKER");
  if (sourceA.semanticSha256 !== sourceB.semanticSha256) fail("SOURCE_CAPTURE_SEMANTIC_HASH_MISMATCH");
  if (sourceB.counts.events <= 0 || sourceB.counts.lines <= 0 || !sourceB.watermarks.maxBusinessDay) {
    fail("SOURCE_CAPTURE_HISTORY_REQUIRED");
  }

  const targetReconciliationReportSha256 = assertExactReconciliation(
    artifacts.sourceB,
    artifacts.targetCorrected,
    normalizedConnectionId,
    "TARGET_CORRECTED",
  );
  assertSame(sourceB.counts, targetCorrected.counts, "TARGET_CORRECTED_COUNTS");
  assertSame(sourceB.watermarks, targetCorrected.watermarks, "TARGET_CORRECTED_WATERMARKS");
  assertSame(
    mapEntries(sourceB.maps.mappings),
    mapEntries(targetCorrected.maps.mappings),
    "TARGET_CORRECTED_MAPPINGS",
  );

  for (const key of ["events", "lines", "receipts", "mappings"]) {
    assertMapSubset(targetBefore.maps[key], sourceB.maps[key], key.toUpperCase());
  }
  const delta = deltaCounts(targetBefore.counts, sourceB.counts);
  const chronology = validateChronology({
    first: sourceA,
    second: sourceB,
    targetBefore,
    targetCorrected,
    generatedAt: generated,
  });
  const manifest = {
    schemaVersion: 2,
    kind: FINAL_DELTA_KIND,
    connectionId: normalizedConnectionId,
    generatedAt: generated.iso,
    sourceSha256: sourceB.rawSha256,
    targetRawSha256: targetBefore.rawSha256,
    targetCorrectedShadowSha256: targetCorrected.rawSha256,
    window: sourceB.window,
    expected: {
      before: targetBefore.counts,
      after: sourceB.counts,
      businessDayChanges: 0,
    },
    delta,
    sourceFence: {
      minimumDrainMs: MIN_WRITER_DRAIN_MS,
      expectedControlState: true,
      markerBefore: sourceA.fence.marker,
      markerAfter: sourceB.fence.marker,
      stable: true,
      fencedAt: sourceA.fence.fencedAt.iso,
      capture1At: sourceA.capturedAt.iso,
      capture2At: sourceB.capturedAt.iso,
      drainObservedMs: chronology.drainObservedMs,
      captureSeparationMs: chronology.captureSeparationMs,
      captureSha256: [sourceA.rawSha256, sourceB.rawSha256],
      semanticSha256: [sourceA.semanticSha256, sourceB.semanticSha256],
      reconciliationReportSha256: sourceStabilityReportSha256,
    },
    cursor: {
      before: {
        day: targetBefore.watermarks.lastBusinessDaySynced,
        sync: targetBefore.watermarks.lastSyncAt,
      },
      after: {
        day: sourceB.watermarks.lastBusinessDaySynced,
        sync: sourceB.watermarks.lastSyncAt,
      },
    },
    applySha256: sha256(applySource),
    rollbackSha256: sha256(rollbackSource),
    readbackSha256: sha256(readbackSource),
    evidence: {
      sourceCaptureSha256: [sourceA.rawSha256, sourceB.rawSha256],
      sourceSemanticSha256: sourceB.semanticSha256,
      sourceWatermarks: sourceB.watermarks,
      targetBeforeSha256: targetBefore.rawSha256,
      targetCorrectedShadowSha256: targetCorrected.rawSha256,
      targetCorrectedSemanticSha256: targetCorrected.semanticSha256,
      targetReconciliationReportSha256,
    },
    remoteWrites: 0,
  };
  return Object.freeze(manifest);
}

function writePrivateAtomic(path, source) {
  if (!isAbsolute(path)) fail("OUTPUT_PATH_MUST_BE_ABSOLUTE");
  const destination = resolve(path);
  if (!outsideRepository(destination)) fail("OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  if (existsSync(destination)) fail("OUTPUT_ALREADY_EXISTS");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const parentMetadata = lstatSync(dirname(destination));
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) fail("OUTPUT_PARENT_MUST_BE_DIRECTORY");
  if ((parentMetadata.mode & 0o077) !== 0) fail("OUTPUT_PARENT_MUST_BE_PRIVATE");
  const realParent = realpathSync(dirname(destination));
  if (!outsideRepository(realParent)) fail("OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, source, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
    chmodSync(destination, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return destination;
}

export function prepareFleetFencedFinalDelta({
  connectionId,
  sourceCaptureAPath,
  sourceCaptureBPath,
  targetBeforePath,
  targetCorrectedShadowPath,
  applyPath,
  rollbackPath,
  readbackPath,
  outputPath,
  generatedAt,
}) {
  const manifest = buildFleetFencedFinalDelta({
    connectionId,
    sourceCaptureASource: readPrivateRegularFile(sourceCaptureAPath, "SOURCE_CAPTURE_A"),
    sourceCaptureBSource: readPrivateRegularFile(sourceCaptureBPath, "SOURCE_CAPTURE_B"),
    targetBeforeSource: readPrivateRegularFile(targetBeforePath, "TARGET_BEFORE"),
    targetCorrectedShadowSource: readPrivateRegularFile(
      targetCorrectedShadowPath,
      "TARGET_CORRECTED_SHADOW",
    ),
    applySource: readPrivateRegularFile(applyPath, "APPLY"),
    rollbackSource: readPrivateRegularFile(rollbackPath, "ROLLBACK"),
    readbackSource: readPrivateRegularFile(readbackPath, "READBACK"),
    generatedAt,
  });
  const source = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestPath = writePrivateAtomic(outputPath, source);
  return Object.freeze({
    status: "RUNTIME_FLEET_FENCED_FINAL_DELTA_READY",
    connectionId: manifest.connectionId,
    manifestPath,
    manifestSha256: sha256(source),
    sourceRawSha256: manifest.sourceSha256,
    sourceSemanticSha256: manifest.evidence.sourceSemanticSha256,
    targetCorrectedShadowSha256: manifest.targetCorrectedShadowSha256,
    remoteMutations: 0,
  });
}

function parseCli(argv) {
  const accepted = new Map([
    ["--connection-id=", "connectionId"],
    ["--source-capture-a=", "sourceCaptureAPath"],
    ["--source-capture-b=", "sourceCaptureBPath"],
    ["--target-before=", "targetBeforePath"],
    ["--target-corrected-shadow=", "targetCorrectedShadowPath"],
    ["--apply=", "applyPath"],
    ["--rollback=", "rollbackPath"],
    ["--readback=", "readbackPath"],
    ["--output=", "outputPath"],
    ["--generated-at=", "generatedAt"],
  ]);
  const required = new Set([...accepted.values()].filter((key) => key !== "generatedAt"));
  const values = {};
  for (const argument of argv) {
    const entry = [...accepted].find(([prefix]) => argument.startsWith(prefix));
    if (!entry) fail("CLI_ARGUMENT_REJECTED");
    const [prefix, key] = entry;
    if (values[key]) fail("CLI_ARGUMENT_DUPLICATED");
    const value = argument.slice(prefix.length);
    if (!value) fail("CLI_ARGUMENT_EMPTY");
    values[key] = key.endsWith("Path") ? resolve(value) : value;
  }
  if ([...required].some((key) => !values[key])) fail("CLI_ARGUMENT_MISSING");
  return values;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === scriptPath) {
  try {
    const result = prepareFleetFencedFinalDelta(parseCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
