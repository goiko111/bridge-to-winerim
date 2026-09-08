#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

import {
  canonicalJson,
  captureConnection,
  sha256,
} from "./export-lovable-rest-baseline.mjs";

const { Client } = pg;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const EXPECTED_TARGET = "piyvadlzagtracciquap";
const MAX_BYTES = 64 * 1024 * 1024;

export class PostgresShadowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PostgresShadowError";
    this.code = code;
  }
}

function requiredValue(argv, index, inline, name) {
  const value = inline ?? argv[index + 1];
  if (!value || (!inline && value.startsWith("--"))) {
    throw new PostgresShadowError("CLI_USAGE", `Missing value for ${name}`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") {
      options.apply = true;
      continue;
    }
    const [name, inline] = token.split("=", 2);
    const allowed = new Set([
      "--output", "--connection-id", "--from-business-day",
      "--through-business-day", "--confirm-target-ref",
    ]);
    if (!allowed.has(name)) throw new PostgresShadowError("CLI_USAGE", `Unexpected argument: ${token}`);
    const value = requiredValue(argv, index, inline, name);
    if (inline === undefined) index += 1;
    if (name === "--output") options.output = value;
    else if (name === "--connection-id") options.connectionId = value.toLowerCase();
    else if (name === "--from-business-day") options.fromBusinessDay = value;
    else if (name === "--through-business-day") options.throughBusinessDay = value;
    else if (name === "--confirm-target-ref") options.confirmTargetRef = value;
  }
  if (!options.output || !isAbsolute(options.output)) {
    throw new PostgresShadowError("CLI_USAGE", "--output must be an absolute path");
  }
  if (!UUID.test(options.connectionId || "")) {
    throw new PostgresShadowError("CLI_USAGE", "--connection-id must be a UUID");
  }
  if (!DAY.test(options.fromBusinessDay || "") || !DAY.test(options.throughBusinessDay || "")
      || options.fromBusinessDay > options.throughBusinessDay) {
    throw new PostgresShadowError("CLI_USAGE", "Business-day bounds must be valid YYYY-MM-DD values");
  }
  if (options.apply && options.confirmTargetRef !== EXPECTED_TARGET) {
    throw new PostgresShadowError("CLI_USAGE", `--apply requires --confirm-target-ref=${EXPECTED_TARGET}`);
  }
  return options;
}

function eq(filters, name) {
  const value = String(filters?.[name] || "");
  if (!value.startsWith("eq.")) throw new PostgresShadowError("QUERY_SCOPE", `Missing eq filter for ${name}`);
  return value.slice(3);
}

function lowerBound(filters, name) {
  const value = String(filters?.[name] || "");
  if (!value.startsWith("gte.")) throw new PostgresShadowError("QUERY_SCOPE", `Missing gte filter for ${name}`);
  return value.slice(4);
}

function upperBound(filters, name) {
  const match = String(filters?.and || "").match(new RegExp(`^\\(${name}\\.lte\\.(.+)\\)$`));
  if (!match) throw new PostgresShadowError("QUERY_SCOPE", `Missing lte filter for ${name}`);
  return match[1];
}

function idsFilter(filters) {
  const match = String(filters?.sales_event_id || "").match(/^in\.\(([^)]+)\)$/);
  if (!match) throw new PostgresShadowError("QUERY_SCOPE", "Missing sales_event_id list");
  const ids = match[1].split(",");
  if (!ids.length || ids.some((id) => !UUID.test(id))) {
    throw new PostgresShadowError("QUERY_SCOPE", "Invalid sales_event_id list");
  }
  return ids;
}

export function createPostgresShadowClient(client) {
  const metrics = { requests: 0, retries: 0, rateLimitRetries: 0, rows: 0 };
  const dateText = (value) => value instanceof Date
    ? [
      String(value.getFullYear()).padStart(4, "0"),
      String(value.getMonth() + 1).padStart(2, "0"),
      String(value.getDate()).padStart(2, "0"),
    ].join("-")
    : value;
  async function query(text, values) {
    metrics.requests += 1;
    const result = await client.query(text, values);
    metrics.rows += result.rows.length;
    return result.rows;
  }

  async function fetchAllById({ table, filters = {} }) {
    const connectionId = eq(filters, table === "pos_connections" ? "id" : "connection_id");
    let rows;
    if (table === "pos_connections") {
      rows = await query(
        `SELECT id, last_business_day_synced, last_sync_at, updated_at
           FROM public.pos_connections
          WHERE id = $1::uuid
          ORDER BY id`,
        [connectionId],
      );
      rows = rows.map((row) => ({
        ...row,
        last_business_day_synced: dateText(row.last_business_day_synced),
      }));
    } else if (table === "product_mappings") {
      rows = await query(
        `SELECT id, provider_product_id, winerim_wine_id, status, format_type, updated_at
           FROM public.product_mappings
          WHERE connection_id = $1::uuid
          ORDER BY id`,
        [connectionId],
      );
    } else if (table === "sales_events") {
      rows = await query(
        `SELECT id, provider_doc_id, business_day, doc_type, created_at
           FROM public.sales_events
          WHERE connection_id = $1::uuid
            AND business_day >= $2::date
            AND business_day <= $3::date
          ORDER BY id`,
        [connectionId, lowerBound(filters, "business_day"), upperBound(filters, "business_day")],
      );
      rows = rows.map((row) => ({ ...row, business_day: dateText(row.business_day) }));
    } else if (table === "sales_line_items") {
      rows = await query(
        `SELECT id, sales_event_id, provider_product_id, name, family, format,
                quantity, unit_price, total_amount,
                to_char(provider_sold_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS provider_sold_at,
                created_at,
                mapped, winerim_product_id
           FROM public.sales_line_items
          WHERE connection_id = $1::uuid
            AND sales_event_id = ANY($2::uuid[])
          ORDER BY id`,
        [connectionId, idsFilter(filters)],
      );
    } else if (table === "stock_sync_log" && filters.sales_event_id === "is.null") {
      rows = await query(
        `SELECT id, sales_event_id, idempotency_key, status, created_at, winerim_response,
                stock_id, quantity, variant, winerim_product_id, provider_product_id, synced_at
           FROM public.stock_sync_log
          WHERE connection_id = $1::uuid
            AND sales_event_id IS NULL
            AND created_at >= $2::timestamptz
            AND created_at <= $3::timestamptz
          ORDER BY id`,
        [connectionId, lowerBound(filters, "created_at"), upperBound(filters, "created_at")],
      );
    } else if (table === "stock_sync_log") {
      rows = await query(
        `SELECT id, sales_event_id, idempotency_key, status, created_at, winerim_response,
                stock_id, quantity, variant, winerim_product_id, provider_product_id, synced_at
           FROM public.stock_sync_log
          WHERE connection_id = $1::uuid
            AND sales_event_id = ANY($2::uuid[])
          ORDER BY id`,
        [connectionId, idsFilter(filters)],
      );
    } else {
      throw new PostgresShadowError("QUERY_SCOPE", `Unsupported table: ${table}`);
    }
    return rows;
  }
  return { fetchAllById, metrics };
}

async function writePrivateJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.length > MAX_BYTES) throw new PostgresShadowError("ARTIFACT_TOO_LARGE", "Artifact exceeds 64 MiB");
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
  return sha256(bytes);
}

export async function exportPostgresShadow({ options, client, now = () => new Date() }) {
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY DEFERRABLE");
  try {
    const captured = await captureConnection({
      client: createPostgresShadowClient(client),
      connectionId: options.connectionId,
      fromBusinessDay: options.fromBusinessDay,
      throughBusinessDay: options.throughBusinessDay,
      now,
    });
    captured.artifact.capture = {
      mode: "POSTGRES_REPEATABLE_READ_ONLY",
      authoritative: true,
      captureStartedAt: captured.artifact.capture.captureStartedAt,
      captureEndedAt: captured.artifact.capture.captureEndedAt,
      sourceMarkerStable: captured.artifact.capture.sourceMarkerStable,
      consistencyBlocker: null,
    };
    await client.query("COMMIT");
    const semanticSha256 = sha256(canonicalJson({
      schemaVersion: captured.artifact.schemaVersion,
      connections: captured.artifact.connections,
    }));
    const fileSha256 = await writePrivateJson(resolve(options.output), captured.artifact);
    return {
      result: "POSTGRES_SHADOW_READY",
      connectionId: options.connectionId,
      semanticSha256,
      fileSha256,
      summary: captured.summary,
      writes: { remote: false, localArtifact: true },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.apply) {
    process.stdout.write(`${JSON.stringify({
      result: "POSTGRES_SHADOW_PLAN",
      connectionId: options.connectionId,
      window: [options.fromBusinessDay, options.throughBusinessDay],
      output: options.output,
      remoteWrites: false,
    })}\n`);
    return;
  }
  const databaseUrl = String(process.env.SHADOW_DATABASE_URL || "");
  if (!databaseUrl) throw new PostgresShadowError("MISSING_ENV", "SHADOW_DATABASE_URL is required");
  const client = new Client({ connectionString: databaseUrl, application_name: "winerim-shadow-readonly" });
  await client.connect();
  try {
    process.stdout.write(`${JSON.stringify(await exportPostgresShadow({ options, client }))}\n`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof PostgresShadowError ? error.code : "POSTGRES_SHADOW_FAILED"}\n`);
    process.exitCode = 1;
  });
}
