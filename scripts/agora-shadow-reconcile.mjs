#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SCHEMA_VERSION = "agora-shadow-v2";
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const PRIVATE_MODES = new Set([0o400, 0o600]);
const SECRET_KEY = /(api[-_]?token|access[-_]?token|refresh[-_]?token|secret|password|authorization|cookie|database[-_]?url|private[-_]?key)/i;

export class ShadowReconcileError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ShadowReconcileError";
    this.code = code;
    this.details = details;
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function aliases(record, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(record, name)) return record[name];
  }
  return undefined;
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ShadowReconcileError("INVALID_INPUT", `${label} must be an object`);
  }
  return value;
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new ShadowReconcileError("INVALID_INPUT", `${label} must be an array`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ShadowReconcileError("INVALID_INPUT", `${label} must be a non-empty string`);
  }
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 512) {
    throw new ShadowReconcileError("INVALID_INPUT", `${label} must be a non-empty string of at most 512 characters`);
  }
  return normalized;
}

function optionalString(value, label) {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, label);
}

function normalizedBusinessDay(value, label) {
  const day = requiredString(value, label);
  const parsed = Date.parse(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)
      || Number.isNaN(parsed)
      || new Date(parsed).toISOString().slice(0, 10) !== day) {
    throw new ShadowReconcileError("INVALID_INPUT", `${label} must be a valid YYYY-MM-DD date`);
  }
  return day;
}

function normalizedTimestamp(value, label) {
  const timestamp = requiredString(value, label);
  const milliseconds = Date.parse(timestamp);
  if (Number.isNaN(milliseconds)) {
    throw new ShadowReconcileError("INVALID_INPUT", `${label} must be an ISO-8601 timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function normalizedDecimal(value, label) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ShadowReconcileError("INVALID_INPUT", `${label} must be a decimal`);
  }
  const source = typeof value === "number" ? String(value) : value.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(source)) {
    throw new ShadowReconcileError("INVALID_INPUT", `${label} must be a finite decimal`);
  }
  const number = Number(source);
  if (!Number.isFinite(number)) throw new ShadowReconcileError("INVALID_INPUT", `${label} must be finite`);
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new ShadowReconcileError("INVALID_INPUT", `${label} unsafe integers must be encoded as decimal strings`);
  }
  if (Object.is(number, -0)) return "0";
  return String(number);
}

function normalizedBoolean(value, label, { nullable = false } = {}) {
  if (nullable && (value === undefined || value === null)) return null;
  if (typeof value !== "boolean") throw new ShadowReconcileError("INVALID_INPUT", `${label} must be boolean`);
  return value;
}

function safeCursorValue(value, keyPath) {
  if (value === null) return null;
  if (["string", "number", "boolean"].includes(typeof value)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new ShadowReconcileError("INVALID_INPUT", `${keyPath} contains a non-finite number`);
    }
    if (/business.*day|day.*synced/i.test(keyPath) && typeof value === "string") {
      return normalizedBusinessDay(value, keyPath);
    }
    if (/(?:^|\.)(?:last_?sync_?at|updated_?at|observed_?at|watermark_?at)$/i.test(keyPath) && typeof value === "string") {
      return normalizedTimestamp(value, keyPath);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => safeCursorValue(entry, `${keyPath}[${index}]`));
  const record = assertRecord(value, keyPath);
  const output = {};
  for (const key of Object.keys(record).sort()) {
    if (SECRET_KEY.test(key)) throw new ShadowReconcileError("SECRET_FIELD", `${keyPath} contains a forbidden credential field`);
    output[key] = safeCursorValue(record[key], `${keyPath}.${key}`);
  }
  return output;
}

function normalizeMapping(line, label) {
  const embedded = aliases(line, ["mapping"]);
  const mapping = embedded === undefined ? {} : assertRecord(embedded, `${label}.mapping`);
  const mappedRaw = aliases(mapping, ["mapped"])
    ?? aliases(line, ["mapped"])
    ?? (String(aliases(mapping, ["status", "mappingStatus", "mapping_status"])
      ?? aliases(line, ["mappingStatus", "mapping_status"])
      ?? "").toUpperCase() === "MAPPED");
  const mapped = normalizedBoolean(mappedRaw, `${label}.mapping.mapped`);
  const status = requiredString(
    aliases(mapping, ["status", "mappingStatus", "mapping_status"])
      ?? aliases(line, ["mappingStatus", "mapping_status"])
      ?? (mapped ? "MAPPED" : "UNMAPPED"),
    `${label}.mapping.status`,
  ).toUpperCase();
  const winerimProductId = optionalString(
    aliases(mapping, ["winerimProductId", "winerim_product_id", "winerimWineId", "winerim_wine_id"])
      ?? aliases(line, ["winerimProductId", "winerim_product_id", "winerimWineId", "winerim_wine_id"]),
    `${label}.mapping.winerimProductId`,
  );
  const winerimFormat = optionalString(
    aliases(mapping, ["format", "winerimFormat", "winerim_format"])
      ?? aliases(line, ["winerimFormat", "winerim_format"]),
    `${label}.mapping.winerimFormat`,
  );
  if (mapped && !winerimProductId) {
    throw new ShadowReconcileError("AMBIGUOUS_INPUT", "Mapped line has no Winerim product identity", {
      entity: "line",
    });
  }
  if (!mapped && winerimProductId) {
    throw new ShadowReconcileError("AMBIGUOUS_INPUT", "Unmapped line has a Winerim product identity", {
      entity: "line",
    });
  }
  return {
    mapped,
    status,
    winerimProductId,
    winerimFormat: winerimFormat?.toUpperCase() ?? null,
  };
}

function lineIdentity(line, label) {
  const providerLineId = aliases(line, ["providerLineId", "provider_line_id"]);
  if (providerLineId === undefined || providerLineId === null || providerLineId === "") {
    throw new ShadowReconcileError("AMBIGUOUS_INPUT", "Line has no portable providerLineId", {
      entity: "line",
    });
  }
  return `providerLineId:${requiredString(providerLineId, `${label}.providerLineId`)}`;
}

function normalizeLine(lineInput, label, eventContext) {
  const line = assertRecord(lineInput, label);
  const id = lineIdentity(line, label);
  const providerProductId = requiredString(
    aliases(line, ["providerProductId", "provider_product_id"]),
    `${label}.providerProductId`,
  );
  const format = requiredString(aliases(line, ["format"]), `${label}.format`).toUpperCase();
  const qty = normalizedDecimal(aliases(line, ["qty", "quantity"]), `${label}.qty`);
  const soldAt = normalizedTimestamp(
    aliases(line, ["soldAt", "sold_at"]) ?? eventContext.soldAt,
    `${label}.soldAt`,
  );
  return {
    key: `${eventContext.eventKey}|${id}`,
    value: {
      providerProductId,
      format,
      qty,
      soldAt,
      mapping: normalizeMapping(line, label),
    },
  };
}

function normalizeEvent(eventInput, label) {
  const event = assertRecord(eventInput, label);
  const businessDay = normalizedBusinessDay(
    aliases(event, ["businessDay", "business_day"]),
    `${label}.businessDay`,
  );
  const providerDocId = requiredString(
    aliases(event, ["providerDocId", "provider_doc_id"]),
    `${label}.providerDocId`,
  );
  const orderId = optionalString(aliases(event, ["orderId", "order_id"]), `${label}.orderId`);
  const soldAt = normalizedTimestamp(aliases(event, ["soldAt", "sold_at"]), `${label}.soldAt`);
  const docType = requiredString(aliases(event, ["docType", "doc_type"]), `${label}.docType`).toUpperCase();
  const eventKey = `${businessDay}|${providerDocId}`;
  const lines = assertArray(aliases(event, ["lines", "lineItems", "line_items"]), `${label}.lines`)
    .map((line, index) => normalizeLine(line, `${label}.lines[${index}]`, { eventKey, soldAt }));
  return {
    key: eventKey,
    value: { businessDay, docType, soldAt, orderId },
    lines,
  };
}

function normalizeReceipt(receiptInput, label) {
  const receipt = assertRecord(receiptInput, label);
  const businessDay = normalizedBusinessDay(
    aliases(receipt, ["businessDay", "business_day"]),
    `${label}.businessDay`,
  );
  const providerDocId = requiredString(
    aliases(receipt, ["providerDocId", "provider_doc_id"]),
    `${label}.providerDocId`,
  );
  const orderId = requiredString(aliases(receipt, ["orderId", "order_id"]), `${label}.orderId`);
  const receiptId = requiredString(
    aliases(receipt, ["receiptId", "receipt_id", "idempotencyKey", "idempotency_key", "id"]),
    `${label}.receiptId`,
  );
  const payloadSha256 = optionalString(
    aliases(receipt, ["payloadSha256", "payload_sha256"]),
    `${label}.payloadSha256`,
  );
  if (payloadSha256 && !/^[a-f0-9]{64}$/i.test(payloadSha256)) {
    throw new ShadowReconcileError("INVALID_INPUT", `${label}.payloadSha256 must be SHA-256 hex`);
  }
  return {
    key: `${businessDay}|${providerDocId}|${orderId}|${receiptId}`,
    value: {
      status: requiredString(aliases(receipt, ["status"]), `${label}.status`).toUpperCase(),
      live: normalizedBoolean(aliases(receipt, ["live"]), `${label}.live`, { nullable: true }),
      stockApplied: normalizedBoolean(
        aliases(receipt, ["stockApplied", "stock_applied"]),
        `${label}.stockApplied`,
        { nullable: true },
      ),
      duplicate: normalizedBoolean(aliases(receipt, ["duplicate"]), `${label}.duplicate`, { nullable: true }),
      payloadSha256: payloadSha256?.toLowerCase() ?? null,
    },
  };
}

function insertUnique(map, entry, connectionId, entity) {
  if (map.has(entry.key)) {
    throw new ShadowReconcileError("AMBIGUOUS_INPUT", `Duplicate ${entity} identity`, {
      connectionId,
      entity,
      keySha256: sha256(entry.key),
    });
  }
  map.set(entry.key, entry.value);
}

function normalizeConnection(connectionInput, label) {
  const connection = assertRecord(connectionInput, label);
  const connectionId = requiredString(
    aliases(connection, ["connectionId", "connection_id"]),
    `${label}.connectionId`,
  );
  const cursorInput = aliases(connection, ["cursor"]);
  const cursorRecord = safeCursorValue(assertRecord(cursorInput, `${label}.cursor`), `${label}.cursor`);
  const cursor = {
    lastBusinessDaySynced: aliases(cursorRecord, ["lastBusinessDaySynced", "last_business_day_synced"]),
    lastSyncAt: aliases(cursorRecord, ["lastSyncAt", "last_sync_at"]),
    baselineFromBusinessDay: aliases(cursorRecord, ["baselineFromBusinessDay", "baseline_from_business_day"]),
    baselineThroughBusinessDay: aliases(cursorRecord, ["baselineThroughBusinessDay", "baseline_through_business_day"]),
  };
  const events = new Map();
  const lines = new Map();
  assertArray(aliases(connection, ["events", "salesEvents", "sales_events"]), `${label}.events`)
    .forEach((eventInput, index) => {
      const event = normalizeEvent(eventInput, `${label}.events[${index}]`);
      insertUnique(events, event, connectionId, "event");
      event.lines.forEach((line) => insertUnique(lines, line, connectionId, "line"));
    });
  const receipts = new Map();
  assertArray(aliases(connection, ["receipts", "stockReceipts", "stock_receipts"]), `${label}.receipts`)
    .forEach((receipt, index) => insertUnique(
      receipts,
      normalizeReceipt(receipt, `${label}.receipts[${index}]`),
      connectionId,
      "receipt",
    ));
  return { connectionId, cursor, events, lines, receipts };
}

export function normalizeArtifact(input, sourceLabel = "artifact") {
  const artifact = assertRecord(input, sourceLabel);
  if (artifact.schemaVersion !== SCHEMA_VERSION) {
    throw new ShadowReconcileError("INVALID_INPUT", `${sourceLabel}.schemaVersion must equal ${SCHEMA_VERSION}`);
  }
  const connections = new Map();
  assertArray(artifact.connections, `${sourceLabel}.connections`).forEach((connectionInput, index) => {
    const connection = normalizeConnection(connectionInput, `${sourceLabel}.connections[${index}]`);
    if (connections.has(connection.connectionId)) {
      throw new ShadowReconcileError("AMBIGUOUS_INPUT", "Duplicate connection identity", {
        connectionId: connection.connectionId,
        entity: "connection",
      });
    }
    connections.set(connection.connectionId, connection);
  });
  if (!connections.size) throw new ShadowReconcileError("INVALID_INPUT", `${sourceLabel}.connections cannot be empty`);
  return { schemaVersion: SCHEMA_VERSION, connections };
}

function differingPaths(left, right, prefix = "") {
  if (canonicalJson(left) === canonicalJson(right)) return [];
  if (!left || !right || typeof left !== "object" || typeof right !== "object"
      || Array.isArray(left) || Array.isArray(right)) return [prefix || "$value"];
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.flatMap((key) => differingPaths(left[key], right[key], prefix ? `${prefix}.${key}` : key));
}

function compareMaps(connectionId, entity, lovableMap, ownMap) {
  const keys = [...new Set([...lovableMap.keys(), ...ownMap.keys()])].sort();
  const differences = [];
  for (const key of keys) {
    const inLovable = lovableMap.has(key);
    const inOwn = ownMap.has(key);
    if (!inLovable || !inOwn) {
      differences.push({
        connectionId,
        entity,
        keySha256: sha256(key),
        kind: inLovable ? "MISSING_IN_OWN" : "MISSING_IN_LOVABLE",
        fields: [],
      });
      continue;
    }
    const fields = differingPaths(lovableMap.get(key), ownMap.get(key));
    if (fields.length) {
      differences.push({
        connectionId,
        entity,
        keySha256: sha256(key),
        kind: "VALUE_MISMATCH",
        fields,
      });
    }
  }
  return differences;
}

function withDigest(report) {
  const canonical = canonicalJson(report);
  return { ...report, reportSha256: sha256(canonical) };
}

export function reconcileArtifacts(lovableInput, ownInput, options = {}) {
  const lovable = normalizeArtifact(lovableInput, "lovable");
  const own = normalizeArtifact(ownInput, "own");
  const requested = options.connectionIds?.length
    ? [...new Set(options.connectionIds.map((value) => requiredString(value, "connectionId")))].sort()
    : [...new Set([...lovable.connections.keys(), ...own.connections.keys()])].sort();
  if (!requested.length) throw new ShadowReconcileError("INVALID_INPUT", "No connection scope selected");

  const differences = [];
  const connections = [];
  for (const connectionId of requested) {
    const left = lovable.connections.get(connectionId);
    const right = own.connections.get(connectionId);
    if (!left || !right) {
      differences.push({
        connectionId,
        entity: "connection",
        keySha256: sha256(connectionId),
        kind: left ? "MISSING_IN_OWN" : "MISSING_IN_LOVABLE",
        fields: [],
      });
      connections.push({ connectionId, status: "DIFFERENT", events: 0, lines: 0, receipts: 0 });
      continue;
    }
    const beforeCount = differences.length;
    const cursorFields = differingPaths(left.cursor, right.cursor);
    if (cursorFields.length) {
      differences.push({
        connectionId,
        entity: "cursor",
        keySha256: sha256(`${connectionId}|cursor`),
        kind: "VALUE_MISMATCH",
        fields: cursorFields,
      });
    }
    differences.push(...compareMaps(connectionId, "event", left.events, right.events));
    differences.push(...compareMaps(connectionId, "line", left.lines, right.lines));
    differences.push(...compareMaps(connectionId, "receipt", left.receipts, right.receipts));
    connections.push({
      connectionId,
      status: differences.length === beforeCount ? "RECONCILED_EXACT" : "DIFFERENT",
      events: left.events.size,
      lines: left.lines.size,
      receipts: left.receipts.size,
    });
  }

  differences.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return withDigest({
    schemaVersion: SCHEMA_VERSION,
    result: differences.length ? "BLOCKED_DIFFERENCES" : "RECONCILED_EXACT",
    dryRun: true,
    writes: false,
    scope: { connectionCount: requested.length, connectionIds: requested },
    summary: {
      reconciledConnections: connections.filter(({ status }) => status === "RECONCILED_EXACT").length,
      differingConnections: connections.filter(({ status }) => status !== "RECONCILED_EXACT").length,
      differences: differences.length,
    },
    connections,
    differences,
  });
}

async function readPrivateJson(filePath, sourceLabel) {
  const resolved = path.resolve(filePath);
  const linkInfo = await lstat(resolved);
  if (linkInfo.isSymbolicLink()) {
    throw new ShadowReconcileError("UNSAFE_FILE", `${sourceLabel} artifact must not be a symlink`);
  }
  const handle = await open(resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ShadowReconcileError("UNSAFE_FILE", `${sourceLabel} artifact must be a regular file`);
    const mode = info.mode & 0o777;
    if (!PRIVATE_MODES.has(mode)) {
      throw new ShadowReconcileError("UNSAFE_FILE", `${sourceLabel} artifact mode must be 0400 or 0600`);
    }
    if (info.size > MAX_ARTIFACT_BYTES) {
      throw new ShadowReconcileError("UNSAFE_FILE", `${sourceLabel} artifact exceeds 64 MiB`);
    }
    const bytes = await handle.readFile();
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new ShadowReconcileError("INVALID_INPUT", `${sourceLabel} artifact is not valid JSON`);
    }
    return { parsed, sha256: sha256(bytes) };
  } finally {
    await handle.close();
  }
}

export async function reconcilePrivateFiles({ lovablePath, ownPath, connectionIds = [] }) {
  const lovable = await readPrivateJson(lovablePath, "lovable");
  const own = await readPrivateJson(ownPath, "own");
  const report = reconcileArtifacts(lovable.parsed, own.parsed, { connectionIds });
  const { reportSha256: _semanticDigest, ...body } = report;
  return withDigest({
    ...body,
    inputs: {
      lovableSha256: lovable.sha256,
      ownSha256: own.sha256,
    },
  });
}

function parseArgs(argv) {
  const options = { connectionIds: [], dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (["--lovable", "--own", "--connection-id"].includes(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new ShadowReconcileError("CLI_USAGE", `Missing value for ${token}`);
      index += 1;
      if (token === "--lovable") options.lovablePath = value;
      else if (token === "--own") options.ownPath = value;
      else options.connectionIds.push(value);
      continue;
    }
    throw new ShadowReconcileError("CLI_USAGE", "Unexpected command-line argument");
  }
  if (!options.dryRun) throw new ShadowReconcileError("CLI_USAGE", "--dry-run is required; this command never writes");
  if (!options.lovablePath || !options.ownPath) {
    throw new ShadowReconcileError("CLI_USAGE", "--lovable and --own are required");
  }
  return options;
}

function sanitizedFailure(error) {
  const code = error instanceof ShadowReconcileError ? error.code : "UNEXPECTED_ERROR";
  const result = code === "AMBIGUOUS_INPUT" ? "BLOCKED_AMBIGUITY" : "BLOCKED_INPUT";
  const safeDetails = error instanceof ShadowReconcileError ? error.details : {};
  return withDigest({
    schemaVersion: SCHEMA_VERSION,
    result,
    dryRun: true,
    writes: false,
    error: {
      code,
      message: error instanceof ShadowReconcileError ? error.message : "Unexpected reconciliation failure",
      ...safeDetails,
    },
  });
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = await reconcilePrivateFiles({
      lovablePath: options.lovablePath,
      ownPath: options.ownPath,
      connectionIds: options.connectionIds,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.result !== "RECONCILED_EXACT") process.exitCode = 4;
  } catch (error) {
    const report = sanitizedFailure(error);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = error instanceof ShadowReconcileError && error.code === "CLI_USAGE" ? 2 : 5;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) await main();
