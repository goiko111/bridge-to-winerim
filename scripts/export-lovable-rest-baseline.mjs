#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ARTIFACT_SCHEMA = "agora-shadow-v2";
const MANIFEST_SCHEMA = "lovable-rest-baseline-v1";
const SOURCE = "lovable-production";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const RETRYABLE = new Set([429, 500, 502, 503, 504, 520, 522, 523, 524]);
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_WINDOW_DAYS = 31;
const MAX_CONNECTIONS = 50;
const EVENT_BATCH_SIZE = 50;

export class RestBaselineError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RestBaselineError";
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

function integer(value, label, { min, max }) {
  if (!/^\d+$/.test(String(value))) throw new RestBaselineError("CLI_USAGE", `${label} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new RestBaselineError("CLI_USAGE", `${label} must be between ${min} and ${max}`);
  }
  return number;
}

function validDay(value, label) {
  if (!DAY.test(value || "")) throw new RestBaselineError("CLI_USAGE", `${label} must be YYYY-MM-DD`);
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new RestBaselineError("CLI_USAGE", `${label} is not a valid date`);
  }
  return timestamp;
}

function windowDays(from, through) {
  return Math.floor((validDay(through, "--through-business-day") - validDay(from, "--from-business-day")) / 86400000) + 1;
}

export function parseArgs(argv) {
  const options = {
    apply: false,
    connectionIds: [],
    pageSize: 500,
    minIntervalMs: 500,
    requestTimeoutMs: 15000,
    maxAttempts: 5,
    maxRequests: 10000,
    maxRowsPerConnection: 250000,
    passes: 1,
    passDelayMs: 2000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") {
      options.apply = true;
      continue;
    }
    const [name, inline] = token.split("=", 2);
    const valued = new Set([
      "--output-dir", "--connection-id", "--from-business-day", "--through-business-day",
      "--confirm-source", "--page-size", "--min-interval-ms", "--request-timeout-ms",
      "--max-attempts", "--max-requests", "--max-rows-per-connection", "--passes", "--pass-delay-ms",
    ]);
    if (!valued.has(name)) throw new RestBaselineError("CLI_USAGE", `Unexpected argument: ${token}`);
    const value = inline ?? argv[index + 1];
    if (!value || (!inline && value.startsWith("--"))) {
      throw new RestBaselineError("CLI_USAGE", `Missing value for ${name}`);
    }
    if (inline === undefined) index += 1;
    if (name === "--connection-id") options.connectionIds.push(value);
    else if (name === "--output-dir") options.outputDir = value;
    else if (name === "--from-business-day") options.fromBusinessDay = value;
    else if (name === "--through-business-day") options.throughBusinessDay = value;
    else if (name === "--confirm-source") options.confirmSource = value;
    else if (name === "--page-size") options.pageSize = integer(value, name, { min: 1, max: 1000 });
    else if (name === "--min-interval-ms") options.minIntervalMs = integer(value, name, { min: 250, max: 10000 });
    else if (name === "--request-timeout-ms") options.requestTimeoutMs = integer(value, name, { min: 1000, max: 120000 });
    else if (name === "--max-attempts") options.maxAttempts = integer(value, name, { min: 1, max: 8 });
    else if (name === "--max-requests") options.maxRequests = integer(value, name, { min: 10, max: 100000 });
    else if (name === "--max-rows-per-connection") options.maxRowsPerConnection = integer(value, name, { min: 100, max: 1000000 });
    else if (name === "--passes") options.passes = integer(value, name, { min: 1, max: 2 });
    else if (name === "--pass-delay-ms") options.passDelayMs = integer(value, name, { min: 0, max: 60000 });
  }

  options.connectionIds = [...new Set(options.connectionIds.map((id) => id.toLowerCase()))].sort();
  if (!options.outputDir || !isAbsolute(options.outputDir)) {
    throw new RestBaselineError("CLI_USAGE", "--output-dir must be an absolute path");
  }
  if (!options.connectionIds.length || options.connectionIds.length > MAX_CONNECTIONS
      || options.connectionIds.some((id) => !UUID.test(id))) {
    throw new RestBaselineError("CLI_USAGE", `Provide 1-${MAX_CONNECTIONS} valid --connection-id values`);
  }
  const days = windowDays(options.fromBusinessDay, options.throughBusinessDay);
  if (days < 1 || days > MAX_WINDOW_DAYS) {
    throw new RestBaselineError("CLI_USAGE", `Business-day window must contain 1-${MAX_WINDOW_DAYS} days`);
  }
  if (options.apply && options.confirmSource !== SOURCE) {
    throw new RestBaselineError("CLI_USAGE", `--apply requires --confirm-source=${SOURCE}`);
  }
  return options;
}

function retryAfterMs(value, nowMs) {
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Math.min(30000, Math.ceil(Number(value) * 1000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? 0 : Math.max(0, Math.min(30000, date - nowMs));
}

function contentRangeTotal(value) {
  const match = String(value || "").match(/^(?:\d+-\d+|\*)\/(\d+|\*)$/);
  return match && match[1] !== "*" ? Number(match[1]) : null;
}

function safeIso(value, fallback) {
  const source = value || fallback;
  if (!source) throw new RestBaselineError("INVALID_SOURCE", "A source timestamp is missing");
  if (source instanceof Date) {
    const timestamp = source.getTime();
    if (Number.isNaN(timestamp)) throw new RestBaselineError("INVALID_SOURCE", "A source timestamp is invalid");
    return source.toISOString();
  }
  const withZone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(String(source))
    ? `${source}Z`
    : String(source);
  const timestamp = Date.parse(withZone);
  if (Number.isNaN(timestamp)) throw new RestBaselineError("INVALID_SOURCE", "A source timestamp is invalid");
  return new Date(timestamp).toISOString();
}

function compactDecimal(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new RestBaselineError("INVALID_SOURCE", "A source quantity is invalid");
  return String(Object.is(number, -0) ? 0 : number);
}

function chunk(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function valueAt(record, path) {
  let current = record;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = current[key];
  }
  return current;
}

function nullableBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function nullableText(value) {
  return value === undefined || value === null || value === "" ? null : String(value);
}

function salesImportSummary(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) return {};
  const liveImport = valueAt(response, ["salesImport"]);
  const backfill = valueAt(response, ["salesImportBackfill"]);
  const selected = liveImport && typeof liveImport === "object" ? liveImport
    : backfill && typeof backfill === "object" ? backfill
      : {};
  const responseLines = valueAt(selected, ["response", "sales"]);
  const lineArray = Array.isArray(responseLines) ? responseLines : [];
  const duplicate = lineArray.length && lineArray.every((line) => line?.duplicate === true)
    ? true
    : lineArray.length && lineArray.some((line) => line?.duplicate === false)
      ? false
      : null;
  return {
    orderId: selected.orderId === undefined || selected.orderId === null ? null : String(selected.orderId),
    live: nullableBoolean(selected.live) ?? (selected === backfill ? false : null),
    stockApplied: nullableBoolean(selected.stockApplied),
    duplicate,
  };
}

export function createRestClient({
  baseUrl,
  apiKey,
  pageSize = 500,
  minIntervalMs = 500,
  requestTimeoutMs = 15000,
  maxAttempts = 5,
  maxRequests = 10000,
  maxRows = 250000,
  fetchImpl = globalThis.fetch,
  sleepImpl = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  nowImpl = () => Date.now(),
}) {
  if (!baseUrl || !apiKey) throw new RestBaselineError("MISSING_ENV", "LOVABLE_REST_URL and LOVABLE_REST_KEY are required");
  if (typeof fetchImpl !== "function") throw new RestBaselineError("INVALID_INPUT", "fetch implementation is required");
  const origin = new URL(baseUrl);
  if (origin.protocol !== "https:" && origin.hostname !== "127.0.0.1" && origin.hostname !== "localhost") {
    throw new RestBaselineError("UNSAFE_URL", "REST URL must use HTTPS");
  }
  let lastRequestAt = Number.NEGATIVE_INFINITY;
  const metrics = { requests: 0, retries: 0, rateLimitRetries: 0, rows: 0 };

  async function requestPage({ table, select, filters = {}, afterId = null, limit = pageSize }) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (metrics.requests >= maxRequests) throw new RestBaselineError("REQUEST_BUDGET", "REST request budget exhausted");
      const delay = Math.max(0, minIntervalMs - (nowImpl() - lastRequestAt));
      if (delay) await sleepImpl(delay);
      lastRequestAt = nowImpl();
      metrics.requests += 1;

      const url = new URL(`rest/v1/${table}`, `${origin.toString().replace(/\/$/, "")}/`);
      url.searchParams.set("select", select);
      for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
      if (afterId) url.searchParams.set("id", `gt.${afterId}`);
      url.searchParams.set("order", "id.asc");
      url.searchParams.set("limit", String(limit));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      let response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: {
            apikey: apiKey,
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
            Prefer: "count=exact",
          },
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeout);
        if (attempt === maxAttempts) throw new RestBaselineError("REST_UNAVAILABLE", "REST request failed after retries");
        metrics.retries += 1;
        await sleepImpl(Math.min(30000, 500 * (2 ** (attempt - 1))));
        continue;
      }
      clearTimeout(timeout);
      if (!response.ok) {
        if (!RETRYABLE.has(response.status) || attempt === maxAttempts) {
          throw new RestBaselineError("REST_STATUS", `REST request failed with HTTP ${response.status}`, { status: response.status });
        }
        metrics.retries += 1;
        if (response.status === 429) metrics.rateLimitRetries += 1;
        const wait = Math.max(retryAfterMs(response.headers.get("Retry-After"), nowImpl()), Math.min(30000, 500 * (2 ** (attempt - 1))));
        await sleepImpl(wait);
        continue;
      }
      let rows;
      try {
        rows = await response.json();
      } catch {
        throw new RestBaselineError("INVALID_SOURCE", "REST response is not valid JSON");
      }
      if (!Array.isArray(rows)) throw new RestBaselineError("INVALID_SOURCE", "REST response must be an array");
      metrics.rows += rows.length;
      if (metrics.rows > maxRows) throw new RestBaselineError("ROW_BUDGET", "REST row budget exhausted");
      return { rows, total: contentRangeTotal(response.headers.get("Content-Range")) };
    }
    throw new RestBaselineError("REST_UNAVAILABLE", "REST request failed");
  }

  async function fetchAllById(spec) {
    const rows = [];
    const seen = new Set();
    let afterId = null;
    while (true) {
      const { rows: page, total } = await requestPage({ ...spec, afterId });
      let previousId = afterId;
      for (const row of page) {
        const id = String(row?.id || "");
        if (!id || seen.has(id) || (previousId && id <= previousId)) {
          throw new RestBaselineError("UNSTABLE_PAGINATION", "REST keyset pagination returned an unstable id sequence");
        }
        seen.add(id);
        rows.push(row);
        previousId = id;
      }
      const requested = spec.limit || pageSize;
      const hasMore = page.length === requested || (total !== null && total > page.length);
      if (!hasMore) break;
      if (!page.length) throw new RestBaselineError("UNSTABLE_PAGINATION", "REST reported more rows but returned an empty page");
      afterId = String(page[page.length - 1].id);
    }
    return rows;
  }

  return { fetchAllById, metrics };
}

async function connectionMarker(client, connectionId) {
  const rows = await client.fetchAllById({
    table: "pos_connections",
    select: "id,last_business_day_synced,last_sync_at,updated_at",
    filters: { id: `eq.${connectionId}` },
    limit: 2,
  });
  if (rows.length !== 1 || String(rows[0].id).toLowerCase() !== connectionId.toLowerCase()) {
    throw new RestBaselineError("CONNECTION_SCOPE", "Connection readback did not return exactly the requested id", { connectionId });
  }
  return rows[0];
}

function markerValue(row) {
  return {
    lastBusinessDaySynced: row.last_business_day_synced ?? null,
    lastSyncAt: row.last_sync_at ? safeIso(row.last_sync_at) : null,
    updatedAt: row.updated_at ? safeIso(row.updated_at) : null,
  };
}

function mappingIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    const key = `${String(row.provider_product_id || "")}|${String(row.format_type || "UNKNOWN").toUpperCase()}`;
    const values = index.get(key) || [];
    values.push(row);
    index.set(key, values);
  }
  return index;
}

function mappingForLine(row, index) {
  const format = String(row.format || "UNKNOWN").toUpperCase();
  const key = `${String(row.provider_product_id || "")}|${format}`;
  const candidates = index.get(key) || [];
  const exact = candidates.filter((candidate) => String(candidate.winerim_wine_id || "") === String(row.winerim_product_id || ""));
  const candidate = exact.length === 1 ? exact[0] : null;
  const mapped = row.mapped === true && Boolean(row.winerim_product_id);
  return {
    mapped,
    status: candidate ? String(candidate.status || (mapped ? "MAPPED" : "UNMAPPED"))
      : row.mapped === true && !row.winerim_product_id ? "INCONSISTENT_SOURCE"
        : mapped ? "MAPPED" : "UNMAPPED",
    winerimProductId: mapped ? String(row.winerim_product_id) : null,
    winerimFormat: mapped ? format : null,
  };
}

function portableLineFingerprint(row, event) {
  const soldAt = safeIso(row.provider_sold_at, row.created_at || event.created_at);
  return sha256(canonicalJson({
    providerProductId: row.provider_product_id ? String(row.provider_product_id) : null,
    name: String(row.name || ""),
    family: String(row.family || ""),
    format: String(row.format || "UNKNOWN").toUpperCase(),
    qty: compactDecimal(row.quantity),
    unitPrice: compactDecimal(row.unit_price ?? 0),
    totalAmount: compactDecimal(row.total_amount ?? 0),
    soldAt,
  }));
}

function portableEventLines(rows, event, mappingsByProduct) {
  const occurrences = new Map();
  return rows
    .map((row) => ({ row, fingerprint: portableLineFingerprint(row, event) }))
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint))
    .map(({ row, fingerprint }) => {
      const occurrence = (occurrences.get(fingerprint) || 0) + 1;
      occurrences.set(fingerprint, occurrence);
      return {
        providerLineId: `content:${fingerprint}:${occurrence}`,
        providerProductId: row.provider_product_id
          ? String(row.provider_product_id)
          : `unidentified:${fingerprint}`,
        format: String(row.format || "UNKNOWN").toUpperCase(),
        qty: compactDecimal(row.quantity),
        soldAt: safeIso(row.provider_sold_at, row.created_at || event.created_at),
        mapping: mappingForLine(row, mappingsByProduct),
      };
    });
}

function receiptForRow(row, eventsById, fromBusinessDay, occurrence = 1) {
  const related = row.sales_event_id ? eventsById.get(String(row.sales_event_id)) : null;
  const summary = salesImportSummary(row.winerim_response);
  const businessDay = String(related?.business_day || valueAt(row.winerim_response, ["businessDay"]) || fromBusinessDay);
  const providerDocId = String(related?.provider_doc_id || "orphan");
  const orderId = summary.orderId || `event:${providerDocId}`;
  const stockMaterial = {
    stockId: nullableText(row.stock_id),
    quantity: compactDecimal(row.quantity),
    variant: nullableText(row.variant)?.toUpperCase() ?? null,
    winerimProductId: nullableText(row.winerim_product_id),
    providerProductId: nullableText(row.provider_product_id),
    syncedAt: nullableText(row.synced_at) ? safeIso(row.synced_at) : null,
  };
  const payloadSha256 = sha256(canonicalJson({
    winerimResponse: row.winerim_response ?? null,
    stockMaterial,
  }));
  const portableFingerprint = sha256(canonicalJson({
    businessDay,
    providerDocId,
    orderId,
    status: String(row.status || "UNKNOWN"),
    createdAt: safeIso(row.created_at),
    live: summary.live,
    stockApplied: summary.stockApplied,
    duplicate: summary.duplicate,
    payloadSha256,
    ...stockMaterial,
  }));
  const receiptId = String(row.idempotency_key || `content:${portableFingerprint}:${occurrence}`);
  return {
    receiptId,
    businessDay,
    providerDocId: related?.provider_doc_id ? providerDocId : `orphan:${portableFingerprint.slice(0, 24)}`,
    orderId,
    status: String(row.status || "UNKNOWN"),
    live: summary.live,
    stockApplied: summary.stockApplied,
    duplicate: summary.duplicate,
    payloadSha256,
  };
}

function portableReceipts(rows, eventsById, fromBusinessDay) {
  const occurrences = new Map();
  return rows
    .map((row) => {
      const candidate = receiptForRow(row, eventsById, fromBusinessDay);
      return { row, fingerprint: candidate.receiptId };
    })
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint))
    .map(({ row, fingerprint }) => {
      if (!fingerprint.startsWith("content:")) return receiptForRow(row, eventsById, fromBusinessDay);
      const occurrence = (occurrences.get(fingerprint) || 0) + 1;
      occurrences.set(fingerprint, occurrence);
      return receiptForRow(row, eventsById, fromBusinessDay, occurrence);
    });
}

export async function captureConnection({
  client,
  connectionId,
  fromBusinessDay,
  throughBusinessDay,
  now = () => new Date(),
}) {
  const metricsBefore = { ...client.metrics };
  const captureStartedAt = now().toISOString();
  const before = await connectionMarker(client, connectionId);
  const mappings = await client.fetchAllById({
    table: "product_mappings",
    select: "id,provider_product_id,winerim_wine_id,status,format_type,updated_at",
    filters: { connection_id: `eq.${connectionId}` },
  });
  const events = await client.fetchAllById({
    table: "sales_events",
    select: "id,provider_doc_id,business_day,doc_type,created_at",
    filters: {
      connection_id: `eq.${connectionId}`,
      business_day: `gte.${fromBusinessDay}`,
      and: `(business_day.lte.${throughBusinessDay})`,
    },
  });
  const eventIds = events.map(({ id }) => String(id));
  const lines = [];
  const receipts = [];
  for (const ids of chunk(eventIds, EVENT_BATCH_SIZE)) {
    lines.push(...await client.fetchAllById({
      table: "sales_line_items",
      select: "id,sales_event_id,provider_product_id,name,family,format,quantity,unit_price,total_amount,provider_sold_at,created_at,mapped,winerim_product_id",
      filters: { connection_id: `eq.${connectionId}`, sales_event_id: `in.(${ids.join(",")})` },
    }));
    receipts.push(...await client.fetchAllById({
      table: "stock_sync_log",
      select: "id,sales_event_id,idempotency_key,status,created_at,winerim_response,stock_id,quantity,variant,winerim_product_id,provider_product_id,synced_at",
      filters: { connection_id: `eq.${connectionId}`, sales_event_id: `in.(${ids.join(",")})` },
    }));
  }
  receipts.push(...await client.fetchAllById({
    table: "stock_sync_log",
    select: "id,sales_event_id,idempotency_key,status,created_at,winerim_response,stock_id,quantity,variant,winerim_product_id,provider_product_id,synced_at",
    filters: {
      connection_id: `eq.${connectionId}`,
      sales_event_id: "is.null",
      created_at: `gte.${fromBusinessDay}T00:00:00Z`,
      and: `(created_at.lte.${throughBusinessDay}T23:59:59.999Z)`,
    },
  }));
  const after = await connectionMarker(client, connectionId);
  const captureEndedAt = now().toISOString();

  const mappingsByProduct = mappingIndex(mappings);
  const linesByEvent = new Map();
  for (const row of lines) {
    const eventId = String(row.sales_event_id);
    const values = linesByEvent.get(eventId) || [];
    values.push(row);
    linesByEvent.set(eventId, values);
  }
  const normalizedEvents = events.map((event) => {
    const eventLines = linesByEvent.get(String(event.id)) || [];
    const soldAt = eventLines.find((line) => line.provider_sold_at)?.provider_sold_at || event.created_at;
    return {
      businessDay: String(event.business_day),
      providerDocId: String(event.provider_doc_id),
      docType: String(event.doc_type || "UNKNOWN").toUpperCase(),
      soldAt: safeIso(soldAt, event.created_at),
      lines: portableEventLines(eventLines, event, mappingsByProduct),
    };
  });
  const eventsById = new Map(events.map((event) => [String(event.id), event]));
  const normalizedReceipts = portableReceipts(receipts, eventsById, fromBusinessDay);
  const cursor = {
    ...markerValue(after),
    baselineFromBusinessDay: fromBusinessDay,
    baselineThroughBusinessDay: throughBusinessDay,
  };
  const artifact = {
    schemaVersion: ARTIFACT_SCHEMA,
    capture: {
      mode: "OBSERVATIONAL_READ_ONLY",
      authoritative: false,
      captureStartedAt,
      captureEndedAt,
      sourceMarkerStable: canonicalJson(markerValue(before)) === canonicalJson(markerValue(after)),
      consistencyBlocker: "REST_NON_TRANSACTIONAL_AND_WRITER_NOT_FENCED",
    },
    connections: [{ connectionId, cursor, events: normalizedEvents, receipts: normalizedReceipts }],
  };
  const semanticSha256 = sha256(canonicalJson({ schemaVersion: ARTIFACT_SCHEMA, connections: artifact.connections }));
  const metrics = Object.fromEntries(Object.keys(client.metrics).map((key) => [key, client.metrics[key] - metricsBefore[key]]));
  return {
    artifact,
    semanticSha256,
    summary: {
      connectionId,
      events: normalizedEvents.length,
      lines: normalizedEvents.reduce((total, event) => total + event.lines.length, 0),
      receipts: normalizedReceipts.length,
      mappings: mappings.length,
      sourceMarkerStable: artifact.capture.sourceMarkerStable,
      metrics,
    },
  };
}

async function writePrivateJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_ARTIFACT_BYTES) {
    throw new RestBaselineError("ARTIFACT_TOO_LARGE", "A per-connection artifact exceeds 64 MiB; use a smaller date window");
  }
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

async function syncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function exportRestBaseline({ options, client, now = () => new Date(), sleepImpl = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)) }) {
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { mode: 0o700 });
  await mkdir(join(outputDir, "connections"), { mode: 0o700 });
  const manifestConnections = [];
  for (const connectionId of options.connectionIds) {
    const connectionDir = join(outputDir, "connections", connectionId);
    await mkdir(connectionDir, { mode: 0o700 });
    const passes = [];
    for (let pass = 1; pass <= options.passes; pass += 1) {
      if (pass > 1 && options.passDelayMs) await sleepImpl(options.passDelayMs);
      const captured = await captureConnection({
        client,
        connectionId,
        fromBusinessDay: options.fromBusinessDay,
        throughBusinessDay: options.throughBusinessDay,
        now,
      });
      const file = join("connections", connectionId, `pass-${pass}.json`);
      const written = await writePrivateJson(join(outputDir, file), captured.artifact);
      passes.push({ file, ...written, semanticSha256: captured.semanticSha256, ...captured.summary });
    }
    manifestConnections.push({
      connectionId,
      passes,
      identicalSemanticPasses: passes.length === 2 ? passes[0].semanticSha256 === passes[1].semanticSha256 : null,
      mergeEligible: false,
      consistencyBlocker: "REST_NON_TRANSACTIONAL_AND_WRITER_NOT_FENCED",
    });
    await syncDirectory(connectionDir);
  }
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA,
    source: SOURCE,
    generatedAt: now().toISOString(),
    mode: "OBSERVATIONAL_READ_ONLY",
    networkWrites: false,
    databaseWrites: false,
    window: { fromBusinessDay: options.fromBusinessDay, throughBusinessDay: options.throughBusinessDay },
    rateLimit: {
      concurrency: 1,
      pageSize: options.pageSize,
      minIntervalMs: options.minIntervalMs,
      maxAttempts: options.maxAttempts,
      maxRequests: options.maxRequests,
      maxRowsPerConnection: options.maxRowsPerConnection,
    },
    consistency: {
      authoritative: false,
      safeDuringService: true,
      blockedForRestoreMergeOrCursorAdvance: true,
      reason: "PostgREST pages and tables do not share a transaction snapshot while Lovable can still write",
    },
    connections: manifestConnections,
  };
  const manifestSha256 = sha256(canonicalJson(manifest));
  const written = await writePrivateJson(join(outputDir, "manifest.json"), { ...manifest, manifestSha256 });
  await syncDirectory(join(outputDir, "connections"));
  await syncDirectory(outputDir);
  return {
    result: "REST_BASELINE_OBSERVATIONAL_READY",
    outputDir,
    manifestSha256,
    manifestFileSha256: written.sha256,
    connections: manifestConnections.length,
    passes: options.passes,
    writes: { remote: false, localArtifacts: true },
  };
}

function publicPlan(options) {
  return {
    result: "REST_BASELINE_PLAN",
    source: SOURCE,
    connectionIds: options.connectionIds,
    window: { fromBusinessDay: options.fromBusinessDay, throughBusinessDay: options.throughBusinessDay },
    passes: options.passes,
    rateLimit: {
      concurrency: 1,
      pageSize: options.pageSize,
      minIntervalMs: options.minIntervalMs,
      maxAttempts: options.maxAttempts,
      maxRequests: options.maxRequests,
      maxRowsPerConnection: options.maxRowsPerConnection,
    },
    safeDuringService: ["sequential GET", "private local artifacts", "observational reconciliation"],
    blockedByConsistency: ["restore", "merge", "cursor advance", "writer activation", "authoritative cutover baseline"],
    networkReads: false,
    remoteWrites: false,
    localWrites: false,
  };
}

function sanitizedFailure(error) {
  return {
    result: "REST_BASELINE_BLOCKED",
    error: {
      code: error instanceof RestBaselineError ? error.code : "UNEXPECTED_ERROR",
      message: error instanceof RestBaselineError ? error.message : "Unexpected baseline failure",
      ...(error instanceof RestBaselineError ? error.details : {}),
    },
    remoteWrites: false,
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options.apply) {
      process.stdout.write(`${JSON.stringify(publicPlan(options), null, 2)}\n`);
      return;
    }
    const client = createRestClient({
      baseUrl: process.env.LOVABLE_REST_URL,
      apiKey: process.env.LOVABLE_REST_KEY,
      pageSize: options.pageSize,
      minIntervalMs: options.minIntervalMs,
      requestTimeoutMs: options.requestTimeoutMs,
      maxAttempts: options.maxAttempts,
      maxRequests: options.maxRequests,
      maxRows: options.maxRowsPerConnection * options.connectionIds.length,
    });
    const result = await exportRestBaseline({ options, client });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(sanitizedFailure(error), null, 2)}\n`);
    process.exitCode = error instanceof RestBaselineError && error.code === "CLI_USAGE" ? 2 : 5;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) await main();
