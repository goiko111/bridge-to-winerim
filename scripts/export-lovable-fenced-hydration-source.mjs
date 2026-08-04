#!/usr/bin/env node

import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  IMPORT_TABLES,
  SOURCE_TABLES,
  buildSourceSnapshot,
  canonicalJson,
} from "../infrastructure/postgres/data-transfer/connection-hydrator/core.mjs";
import {
  writeSecureJson,
  writeSourceArtifact,
} from "../infrastructure/postgres/data-transfer/connection-hydrator/artifacts.mjs";
import {
  RestBaselineError,
  createRestClient,
} from "./export-lovable-rest-baseline.mjs";

const SOURCE = "lovable-production";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

function parseArgs(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") {
      options.apply = true;
      continue;
    }
    const [name, inline] = token.split("=", 2);
    if (!["--connection-id", "--output-dir", "--confirm-source"].includes(name)) {
      throw new Error(`UNEXPECTED_ARGUMENT:${token}`);
    }
    const value = inline ?? argv[index + 1];
    if (!value || (!inline && value.startsWith("--"))) throw new Error(`MISSING_ARGUMENT:${name}`);
    if (inline === undefined) index += 1;
    options[name.slice(2).replaceAll("-", "_")] = value;
  }
  const connectionId = String(options.connection_id ?? "").trim().toLowerCase();
  if (!UUID.test(connectionId)) throw new Error("INVALID_CONNECTION_ID");
  if (!options.output_dir || !isAbsolute(options.output_dir)) throw new Error("OUTPUT_DIR_MUST_BE_ABSOLUTE");
  if (options.apply && options.confirm_source !== SOURCE) throw new Error("SOURCE_CONFIRMATION_MISMATCH");
  return { ...options, connectionId, outputDir: resolve(options.output_dir) };
}

function scheduler(config) {
  const value = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  return {
    intraday_sales_sync_enabled: value.intraday_sales_sync_enabled === true,
    open_tickets_stock_sync_enabled: value.open_tickets_stock_sync_enabled === true,
    open_tickets_sync_enabled: value.open_tickets_sync_enabled === true,
  };
}

function safeMarker(row) {
  return {
    id: row.id,
    provider: String(row.provider ?? "").toLowerCase(),
    enabled: row.enabled,
    catalog_sync_enabled: row.catalog_sync_enabled,
    scheduler: scheduler(row.provider_config),
    last_business_day_synced: row.last_business_day_synced,
    last_sync_at: row.last_sync_at,
    updated_at: row.updated_at,
  };
}

function assertFenced(marker, connectionId) {
  if (
    marker.id !== connectionId
    || marker.provider !== "agora"
    || marker.enabled !== false
    || marker.catalog_sync_enabled !== false
    || marker.scheduler.intraday_sales_sync_enabled
    || marker.scheduler.open_tickets_stock_sync_enabled
    || marker.scheduler.open_tickets_sync_enabled
  ) {
    throw new Error("SOURCE_NOT_FENCED");
  }
}

async function fetchMarker(client, connectionId) {
  const rows = await client.fetchAllById({
    table: "pos_connections",
    select: "*",
    filters: { id: `eq.${connectionId}` },
    limit: 2,
  });
  if (rows.length !== 1) throw new Error("SOURCE_CONNECTION_COUNT_INVALID");
  return { raw: rows[0], safe: safeMarker(rows[0]) };
}

async function capture({ client, connectionId }) {
  const startedAt = new Date().toISOString();
  const before = await fetchMarker(client, connectionId);
  assertFenced(before.safe, connectionId);
  const rawTables = { pos_connections: [before.raw] };
  for (const table of SOURCE_TABLES) {
    if (table === "pos_connections") continue;
    rawTables[table] = await client.fetchAllById({
      table,
      select: "*",
      filters: { connection_id: `eq.${connectionId}` },
    });
  }
  const after = await fetchMarker(client, connectionId);
  assertFenced(after.safe, connectionId);
  if (canonicalJson(before.safe) !== canonicalJson(after.safe)) throw new Error("SOURCE_MARKER_CHANGED_DURING_CAPTURE");
  rawTables.pos_connections = [after.raw];
  const capturedAt = new Date().toISOString();
  const source = buildSourceSnapshot({
    connectionId,
    rawTables,
    watermark: {
      capturedAt,
      walLsn: "REST_FENCED_NO_WAL_LSN",
      snapshotSha256: sha256(rawTables),
      databaseIdentitySha256: sha256({ source: SOURCE, connectionId }),
    },
  });
  return {
    source,
    evidence: {
      schemaVersion: 1,
      kind: "lovable-fenced-hydration-rest-capture",
      connectionId,
      startedAt,
      capturedAt,
      source: SOURCE,
      remoteWrites: false,
      fenced: true,
      marker: before.safe,
      markerSha256: sha256(before.safe),
      rawTableCounts: Object.fromEntries(SOURCE_TABLES.map((table) => [table, rawTables[table].length])),
      sanitizedPayloadSha256: source.payloadSha256,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.apply) {
    process.stdout.write(`${JSON.stringify({
      result: "LOVABLE_FENCED_HYDRATION_SOURCE_PLAN",
      connectionId: options.connectionId,
      outputDir: options.outputDir,
      remoteWrites: false,
      requiredFence: true,
    }, null, 2)}\n`);
    return;
  }
  const client = createRestClient({
    baseUrl: process.env.LOVABLE_REST_URL,
    apiKey: process.env.LOVABLE_REST_KEY,
    pageSize: 500,
    minIntervalMs: 300,
    requestTimeoutMs: 10000,
    maxAttempts: 5,
    maxRequests: 2000,
    maxRows: 300000,
  });
  const captured = await capture({ client, connectionId: options.connectionId });
  const manifest = await writeSourceArtifact(captured.source, options.outputDir);
  await writeSecureJson(options.outputDir, "fenced-capture-evidence.json", {
    ...captured.evidence,
    sourceManifestSha256: manifest.manifestSha256,
  });
  process.stdout.write(`${JSON.stringify({
    result: "LOVABLE_FENCED_HYDRATION_SOURCE_READY",
    connectionId: options.connectionId,
    outputDir: options.outputDir,
    payloadSha256: captured.source.payloadSha256,
    sourceManifestSha256: manifest.manifestSha256,
    tables: Object.fromEntries(IMPORT_TABLES.map((table) => [table, captured.source.tables[table].length])),
    outboundClassified: captured.source.outbound.classifiedCount,
    remoteWrites: false,
  }, null, 2)}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof RestBaselineError ? error.code : error instanceof Error ? error.message : "UNEXPECTED_ERROR"}\n`);
    process.exitCode = 1;
  }
}
