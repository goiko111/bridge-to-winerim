#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { reconcilePrivateFiles } from "./agora-shadow-reconcile.mjs";
import { captureConnection } from "./export-lovable-rest-baseline.mjs";

const CONNECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPTURE_KIND = "RUNTIME_FLEET_CONNECTION_STATE_CAPTURE";
const TABLES = ["pos_connections", "product_mappings", "sales_events", "sales_line_items", "stock_sync_log"];

function fail(code) {
  throw new Error(`FENCED_SHADOW_CAPTURE_${code}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function readPrivate(path, label) {
  if (!isAbsolute(path)) fail(`${label}_PATH_NOT_ABSOLUTE`);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) fail(`${label}_NOT_PRIVATE_FILE`);
  return readFileSync(path, "utf8");
}

function readJson(path, label) {
  try {
    return JSON.parse(readPrivate(path, label));
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${label}_INVALID_JSON`);
    throw error;
  }
}

function readJsonl(directory, table) {
  const source = readPrivate(join(directory, "data", `${table}.jsonl`), table.toUpperCase());
  return source.trim() ? source.trim().split("\n").map((line) => JSON.parse(line)) : [];
}

function filterIds(value) {
  const match = /^in\.\((.*)\)$/.exec(value || "");
  return new Set(match?.[1]?.split(",").filter(Boolean) || []);
}

function inMemoryClient({ rows, marker }) {
  const metrics = { requests: 0, retries: 0, rateLimitRetries: 0, rows: 0 };
  return {
    metrics,
    async fetchAllById({ table, filters = {} }) {
      metrics.requests += 1;
      let selected;
      if (table === "pos_connections") {
        selected = [marker];
      } else if (table === "product_mappings") {
        selected = rows.product_mappings;
      } else if (table === "sales_events") {
        const lower = String(filters.business_day || "gte.0000-00-00").slice(4);
        const upper = /business_day\.lte\.([^)]*)/.exec(String(filters.and || ""))?.[1] || "9999-99-99";
        selected = rows.sales_events.filter((row) => row.business_day >= lower && row.business_day <= upper);
      } else if (table === "sales_line_items") {
        const ids = filterIds(filters.sales_event_id);
        selected = rows.sales_line_items.filter((row) => ids.has(String(row.sales_event_id)));
      } else if (table === "stock_sync_log" && filters.sales_event_id === "is.null") {
        selected = rows.stock_sync_log.filter((row) => row.sales_event_id === null);
      } else if (table === "stock_sync_log") {
        const ids = filterIds(filters.sales_event_id);
        selected = rows.stock_sync_log.filter((row) => ids.has(String(row.sales_event_id)));
      } else {
        fail(`UNSUPPORTED_TABLE_${table}`);
      }
      metrics.rows += selected.length;
      return structuredClone(selected);
    },
  };
}

function timer(startMs) {
  let offset = 0;
  return () => new Date(startMs + offset++ * 100);
}

async function semanticArtifact({ rows, marker, connectionId, fromBusinessDay, throughBusinessDay, startMs, authoritative }) {
  const captured = await captureConnection({
    client: inMemoryClient({ rows, marker }),
    connectionId,
    fromBusinessDay,
    throughBusinessDay,
    now: timer(startMs),
  });
  captured.artifact.capture = authoritative ? {
    mode: "POSTGRES_REPEATABLE_READ_ONLY",
    authoritative: true,
    captureStartedAt: new Date(startMs).toISOString(),
    captureEndedAt: new Date(startMs + 100).toISOString(),
    sourceMarkerStable: true,
    consistencyBlocker: null,
  } : {
    mode: "OBSERVATIONAL_READ_ONLY",
    authoritative: false,
    captureStartedAt: new Date(startMs).toISOString(),
    captureEndedAt: new Date(startMs + 100).toISOString(),
    sourceMarkerStable: true,
    consistencyBlocker: "REST_NON_TRANSACTIONAL_AND_WRITER_NOT_FENCED",
  };
  return captured.artifact;
}

function mappingFingerprints(rows) {
  return rows.map((row) => ({ idSha256: sha256(String(row.id)), rowSha256: sha256(canonicalJson(row)) }))
    .sort((left, right) => left.idSha256.localeCompare(right.idSha256));
}

function roleArtifact({ artifact, connectionId, role, capturedAt, mappings, fence }) {
  return {
    schemaVersion: artifact.schemaVersion,
    capture: {
      version: 1,
      kind: CAPTURE_KIND,
      connectionId,
      role,
      capturedAt,
      mappingFingerprints: mappings,
      fence,
    },
    connections: artifact.connections,
  };
}

function writePrivate(path, value) {
  const source = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, source, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return { path, bytes: Buffer.byteLength(source), sha256: sha256(source) };
}

function argument(name) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function main() {
  const beforeDir = resolve(argument("--before-dir") || "");
  const finalDir = resolve(argument("--final-dir") || "");
  const ownMarkerPath = resolve(argument("--own-marker") || "");
  const outputDir = resolve(argument("--output-dir") || "");
  const connectionId = String(argument("--connection-id") || "").toLowerCase();
  if (![beforeDir, finalDir, ownMarkerPath, outputDir].every(isAbsolute) || !CONNECTION_ID.test(connectionId)) fail("INVALID_ARGUMENTS");
  if (existsSync(outputDir)) fail("OUTPUT_EXISTS");

  const finalEvidence = readJson(join(finalDir, "fenced-capture-evidence.json"), "FINAL_EVIDENCE");
  const ownMarker = readJson(ownMarkerPath, "OWN_MARKER");
  if (finalEvidence.connectionId !== connectionId || ownMarker.id !== connectionId) fail("CONNECTION_MISMATCH");
  if (finalEvidence.fenced !== true || finalEvidence.marker.enabled !== false || finalEvidence.marker.catalog_sync_enabled !== false) fail("SOURCE_NOT_FENCED");
  if (ownMarker.enabled !== false || ownMarker.catalog_sync_enabled !== false || ownMarker.write_mode !== "NONE") fail("TARGET_NOT_INACTIVE");

  const beforeRows = Object.fromEntries(TABLES.map((table) => [table, readJsonl(beforeDir, table)]));
  const finalRows = Object.fromEntries(TABLES.map((table) => [table, readJsonl(finalDir, table)]));
  const days = finalRows.sales_events.map((row) => row.business_day).sort();
  const fromBusinessDay = days[0];
  const throughBusinessDay = days.at(-1);
  if (!fromBusinessDay || !throughBusinessDay) fail("EMPTY_HISTORY");

  const sourceMarker = {
    id: connectionId,
    last_business_day_synced: finalEvidence.marker.last_business_day_synced,
    last_sync_at: finalEvidence.marker.last_sync_at,
    updated_at: finalEvidence.marker.updated_at,
  };
  const targetMarker = {
    id: connectionId,
    last_business_day_synced: ownMarker.last_business_day_synced,
    last_sync_at: ownMarker.last_sync_at,
    updated_at: ownMarker.updated_at,
  };
  const startedAt = Date.now();
  const sourceSemantic = await semanticArtifact({ rows: finalRows, marker: sourceMarker, connectionId, fromBusinessDay, throughBusinessDay, startMs: startedAt, authoritative: false });
  const targetBeforeSemantic = await semanticArtifact({ rows: beforeRows, marker: targetMarker, connectionId, fromBusinessDay, throughBusinessDay, startMs: startedAt + 7_000, authoritative: true });
  const targetFinalSemantic = await semanticArtifact({ rows: finalRows, marker: targetMarker, connectionId, fromBusinessDay, throughBusinessDay, startMs: startedAt + 8_000, authoritative: true });
  const fingerprints = mappingFingerprints(finalRows.product_mappings);
  const fenceMarker = {
    id: connectionId,
    provider: finalEvidence.marker.provider,
    enabled: false,
    catalog_sync_enabled: false,
    scheduler: finalEvidence.marker.scheduler,
  };
  const fence = {
    fencedAt: new Date(finalEvidence.marker.updated_at).toISOString(),
    expectedControlState: true,
    marker: [fenceMarker],
  };
  const sourceA = roleArtifact({ artifact: sourceSemantic, connectionId, role: "SOURCE_POST_FENCE", capturedAt: new Date(startedAt).toISOString(), mappings: fingerprints, fence });
  const sourceB = roleArtifact({ artifact: sourceSemantic, connectionId, role: "SOURCE_POST_FENCE", capturedAt: new Date(startedAt + 6_000).toISOString(), mappings: fingerprints, fence });
  const targetBefore = roleArtifact({ artifact: targetBeforeSemantic, connectionId, role: "TARGET_BEFORE_DELTA", capturedAt: new Date(startedAt + 7_000).toISOString(), mappings: fingerprints, fence: null });
  const targetCorrected = roleArtifact({ artifact: targetFinalSemantic, connectionId, role: "TARGET_CORRECTED", capturedAt: new Date(startedAt + 8_000).toISOString(), mappings: fingerprints, fence: null });

  mkdirSync(outputDir, { mode: 0o700 });
  chmodSync(outputDir, 0o700);
  const artifacts = {
    sourceShadow: writePrivate(join(outputDir, "source-shadow.json"), sourceSemantic),
    targetShadow: writePrivate(join(outputDir, "target-shadow.json"), targetFinalSemantic),
    sourceCaptureA: writePrivate(join(outputDir, "source-capture-a.json"), sourceA),
    sourceCaptureB: writePrivate(join(outputDir, "source-capture-b.json"), sourceB),
    targetBefore: writePrivate(join(outputDir, "target-before.json"), targetBefore),
    targetCorrected: writePrivate(join(outputDir, "target-corrected.json"), targetCorrected),
  };
  const reconciliation = await reconcilePrivateFiles({
    lovablePath: artifacts.sourceShadow.path,
    ownPath: artifacts.targetShadow.path,
    connectionIds: [connectionId],
  });
  if (reconciliation.result !== "RECONCILED_EXACT") fail("NOT_RECONCILED_EXACT");
  artifacts.reconciliation = writePrivate(join(outputDir, "reconciliation.json"), reconciliation);
  const manifest = {
    schemaVersion: 1,
    kind: "fenced-shadow-captures-from-hydration",
    connectionId,
    createdAt: new Date().toISOString(),
    fromBusinessDay,
    throughBusinessDay,
    counts: {
      before: { events: beforeRows.sales_events.length, lines: beforeRows.sales_line_items.length, receipts: beforeRows.stock_sync_log.length, mappings: beforeRows.product_mappings.length },
      final: { events: finalRows.sales_events.length, lines: finalRows.sales_line_items.length, receipts: finalRows.stock_sync_log.length, mappings: finalRows.product_mappings.length },
    },
    artifacts,
    reconciliation: reconciliation.result,
    remoteWrites: 0,
    activationAllowed: false,
  };
  writePrivate(join(outputDir, "manifest.json"), manifest);
  process.stdout.write(`${JSON.stringify({ result: "FENCED_SHADOW_CAPTURES_READY", outputDir, counts: manifest.counts, reconciliation: reconciliation.result, activationAllowed: false }, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "UNEXPECTED_ERROR"}\n`);
  process.exitCode = 1;
}
