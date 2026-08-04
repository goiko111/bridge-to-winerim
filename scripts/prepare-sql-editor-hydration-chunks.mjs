#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { IMPORT_TABLES } from "../infrastructure/postgres/data-transfer/connection-hydrator/core.mjs";
import { readPlanArtifact } from "../infrastructure/postgres/data-transfer/connection-hydrator/artifacts.mjs";

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (Array.isArray(value) || (value && typeof value === "object")) return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quote(value) {
  if (!IDENTIFIER.test(value)) throw new Error("UNSAFE_IDENTIFIER");
  return `"${value}"`;
}

function renderInsertBatch(table, rows) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  const json = JSON.stringify(rows);
  const tag = `$hydration_${sha256(json).slice(0, 16)}$`;
  if (json.includes(tag)) throw new Error("UNSAFE_JSON_DOLLAR_TAG_COLLISION");
  return `INSERT INTO public.${quote(table)} (${columns.map(quote).join(", ")}) SELECT ${columns.map(quote).join(", ")} FROM jsonb_populate_recordset(NULL::public.${quote(table)}, ${tag}${json}${tag}::jsonb);`;
}

function scopePredicate(table, connectionId) {
  const column = table === "pos_connections" ? "id" : "connection_id";
  return `${quote(column)} = ${sqlLiteral(connectionId)}::uuid`;
}

function inactiveGuard(connectionId, label, { allowMissingConnection = false } = {}) {
  const statePredicate = `enabled IS FALSE
      AND COALESCE(catalog_sync_enabled, FALSE) IS FALSE
      AND write_mode = 'NONE'`;
  const connectionPredicate = allowMissingConnection
    ? `EXISTS (
    SELECT 1 FROM public.pos_connections
    WHERE id = ${sqlLiteral(connectionId)}::uuid
      AND NOT (${statePredicate})
  )`
    : `NOT EXISTS (
    SELECT 1 FROM public.pos_connections
    WHERE id = ${sqlLiteral(connectionId)}::uuid
      AND ${statePredicate}
  )`;
  return `
  IF ${connectionPredicate} THEN RAISE EXCEPTION '${label}_CONNECTION_NOT_INACTIVE'; END IF;
  IF to_regclass('public.runtime_canary_connections') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.runtime_canary_connections WHERE connection_id = $1 AND active'
      INTO runtime_count USING ${sqlLiteral(connectionId)}::uuid;
    IF runtime_count <> 0 THEN RAISE EXCEPTION '${label}_RUNTIME_SCOPE_ACTIVE'; END IF;
  END IF;
  IF to_regclass('public.runtime_connection_credentials') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.runtime_connection_credentials WHERE connection_id = $1 AND active'
      INTO runtime_count USING ${sqlLiteral(connectionId)}::uuid;
    IF runtime_count <> 0 THEN RAISE EXCEPTION '${label}_RUNTIME_CREDENTIAL_ACTIVE'; END IF;
  END IF;`;
}

function renderChunk({ plan, table, rows, before, after, sequence }) {
  const label = `HYDRATION_CHUNK_${String(sequence).padStart(3, "0")}`;
  return `-- ${label}
-- PLAN_SHA256:${plan.planSha256}
BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtext('winerim-connection-hydrator'), hashtext(${sqlLiteral(plan.connectionId)}));
DO $guard$
DECLARE runtime_count bigint;
BEGIN
${inactiveGuard(plan.connectionId, label, { allowMissingConnection: table === "pos_connections" && before === 0 })}
  IF (SELECT count(*) FROM public.${quote(table)} WHERE ${scopePredicate(table, plan.connectionId)}) <> ${before} THEN
    RAISE EXCEPTION '${label}_PREIMAGE_COUNT_MISMATCH:${table}';
  END IF;
END
$guard$;
${renderInsertBatch(table, rows)}
DO $post$
BEGIN
  IF (SELECT count(*) FROM public.${quote(table)} WHERE ${scopePredicate(table, plan.connectionId)}) <> ${after} THEN
    RAISE EXCEPTION '${label}_POSTIMAGE_COUNT_MISMATCH:${table}';
  END IF;
END
$post$;
COMMIT;
SELECT jsonb_build_object('result','HYDRATION_CHUNK_APPLIED','sequence',${sequence},'table',${sqlLiteral(table)},'rows',${rows.length},'total',${after}) AS result;
`;
}

function renderRollback(plan) {
  const deletes = [...IMPORT_TABLES].reverse().map((table) => {
    const ids = plan.rollbackIds[table] || [];
    if (!ids.length) return `-- ${table}: no inserted rows`;
    return `DELETE FROM public.${quote(table)} WHERE id IN (${ids.map((id) => `${sqlLiteral(id)}::uuid`).join(", ")});`;
  }).join("\n");
  return `-- HYDRATION_CHUNK_ROLLBACK
-- PLAN_SHA256:${plan.planSha256}
BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtext('winerim-connection-hydrator'), hashtext(${sqlLiteral(plan.connectionId)}));
DO $guard$
DECLARE runtime_count bigint;
BEGIN
${inactiveGuard(plan.connectionId, "HYDRATION_ROLLBACK")}
END
$guard$;
${deletes}
COMMIT;
SELECT 'HYDRATION_CHUNKS_ROLLED_BACK' AS result;
`;
}

function renderReconcile(plan) {
  const rows = IMPORT_TABLES.map((table) => {
    const expected = Number(plan.targetPreimageCounts[table] || 0) + Number(plan.inserts[table]?.length || 0);
    return `SELECT ${sqlLiteral(table)} AS table_name, count(*)::bigint AS actual, ${expected}::bigint AS expected, count(*) = ${expected} AS matches FROM public.${quote(table)} WHERE ${scopePredicate(table, plan.connectionId)}`;
  });
  return `${rows.join("\nUNION ALL\n")}\nORDER BY table_name;\n`;
}

async function writePrivate(path, value) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(value); } finally { await handle.close(); }
  await chmod(path, 0o600);
  return { bytes: Buffer.byteLength(value), sha256: sha256(value) };
}

function batchesForTable(plan, table, maxBytes) {
  const output = [];
  let rows = [];
  let bytes = 0;
  for (const row of plan.inserts[table]) {
    const statementBytes = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (rows.length && bytes + statementBytes > maxBytes) {
      output.push(rows);
      rows = [];
      bytes = 0;
    }
    rows.push(row);
    bytes += statementBytes;
  }
  if (rows.length) output.push(rows);
  return output;
}

async function main() {
  const planArg = process.argv.find((value) => value.startsWith("--plan-dir="))?.split("=", 2)[1];
  const outputArg = process.argv.find((value) => value.startsWith("--output-dir="))?.split("=", 2)[1];
  const maxArg = process.argv.find((value) => value.startsWith("--max-insert-bytes="))?.split("=", 2)[1] ?? "450000";
  if (!planArg || !outputArg || !isAbsolute(planArg) || !isAbsolute(outputArg)) throw new Error("ABSOLUTE_PATHS_REQUIRED");
  const maxBytes = Number(maxArg);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 50000 || maxBytes > 1000000) throw new Error("INVALID_MAX_INSERT_BYTES");
  const { plan } = await readPlanArtifact(resolve(planArg));
  const outputDir = resolve(outputArg);
  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  await chmod(outputDir, 0o700);
  const chunks = [];
  let sequence = 0;
  for (const table of IMPORT_TABLES) {
    let before = Number(plan.targetPreimageCounts[table] || 0);
    for (const rows of batchesForTable(plan, table, maxBytes)) {
      sequence += 1;
      const after = before + rows.length;
      const filename = `${String(sequence).padStart(3, "0")}-${table}.sql`;
      const rendered = renderChunk({ plan, table, rows, before, after, sequence });
      const written = await writePrivate(join(outputDir, filename), rendered);
      chunks.push({ sequence, filename, table, rows: rows.length, before, after, ...written });
      before = after;
    }
  }
  const rollbackFilename = "rollback-all-exact-ids.sql";
  const reconcileFilename = "reconcile-counts.sql";
  const rollback = await writePrivate(join(outputDir, rollbackFilename), renderRollback(plan));
  const reconcile = await writePrivate(join(outputDir, reconcileFilename), renderReconcile(plan));
  const manifestBody = {
    schemaVersion: 1,
    kind: "sql-editor-inactive-hydration-chunks",
    connectionId: plan.connectionId,
    planSha256: plan.planSha256,
    planDirectory: basename(resolve(planArg)),
    maxInsertBytes: maxBytes,
    chunks,
    rollback: { filename: rollbackFilename, ...rollback },
    reconcile: { filename: reconcileFilename, ...reconcile },
    activationAllowed: false,
  };
  const manifestSource = `${JSON.stringify({ ...manifestBody, manifestSha256: sha256(JSON.stringify(manifestBody)) }, null, 2)}\n`;
  await writePrivate(join(outputDir, "manifest.json"), manifestSource);
  process.stdout.write(`${JSON.stringify({
    result: "SQL_EDITOR_HYDRATION_CHUNKS_READY",
    connectionId: plan.connectionId,
    outputDir,
    chunks: chunks.length,
    rows: chunks.reduce((sum, chunk) => sum + chunk.rows, 0),
    largestChunkBytes: Math.max(...chunks.map((chunk) => chunk.bytes)),
    rollbackBytes: rollback.bytes,
    activationAllowed: false,
  }, null, 2)}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try { await main(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "UNEXPECTED_ERROR"}\n`);
    process.exitCode = 1;
  }
}
