#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

const CONNECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TABLES = Object.freeze([
  "provider_products",
  "product_mappings",
  "agora_master_data",
  "sales_events",
  "sales_line_items",
  "stock_sync_log",
  "winerim_push_tracking",
]);
const EVENT_MUTABLE_FIELDS = Object.freeze([
  "business_day",
  "doc_type",
  "total_amount",
  "total_tax",
  "total_net",
  "line_count",
  "raw_json",
]);

function fail(code) {
  throw new Error(`FINAL_CONVERGENCE_${code}`);
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

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function jsonSql(value, label) {
  const source = JSON.stringify(value);
  const tag = `$${label}_${sha256(source).slice(0, 16)}$`;
  if (source.includes(tag)) fail("JSON_TAG_COLLISION");
  return `${tag}${source}${tag}::jsonb`;
}

function privateFile(path, label) {
  if (!isAbsolute(path)) fail(`${label}_PATH_NOT_ABSOLUTE`);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label}_NOT_REGULAR`);
  if ((metadata.mode & 0o777) !== 0o600) fail(`${label}_NOT_PRIVATE_0600`);
  return readFileSync(path, "utf8");
}

function readRows(directory, table) {
  const source = privateFile(join(directory, "data", `${table}.jsonl`), `${table.toUpperCase()}_SOURCE`);
  const rows = source.trim() ? source.trim().split("\n").map((line) => JSON.parse(line)) : [];
  const byId = new Map();
  for (const row of rows) {
    if (!row?.id || byId.has(row.id)) fail(`${table.toUpperCase()}_INVALID_OR_DUPLICATE_ID`);
    byId.set(row.id, row);
  }
  return { rows, byId, sha256: sha256(source) };
}

function changedKeys(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => canonicalJson(before[key]) !== canonicalJson(after[key]))
    .sort();
}

function compareTable(before, after) {
  const added = [...after.byId.keys()].filter((id) => !before.byId.has(id)).map((id) => after.byId.get(id));
  const removed = [...before.byId.keys()].filter((id) => !after.byId.has(id)).map((id) => before.byId.get(id));
  const changed = [...before.byId.keys()]
    .filter((id) => after.byId.has(id) && canonicalJson(before.byId.get(id)) !== canonicalJson(after.byId.get(id)))
    .map((id) => ({ id, before: before.byId.get(id), after: after.byId.get(id), keys: changedKeys(before.byId.get(id), after.byId.get(id)) }));
  return { added, removed, changed };
}

function idsSql(rows) {
  return rows.map((row) => `${sqlLiteral(row.id)}::uuid`).join(", ");
}

function insertRecordset(table, rows, label) {
  if (!rows.length) return `-- ${table}: no inserts`;
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  return `INSERT INTO public.${table} (${columns.join(", ")})\nSELECT ${columns.join(", ")} FROM jsonb_populate_recordset(NULL::public.${table}, ${jsonSql(rows, label)});`;
}

function inactiveGuard(connectionId, label) {
  return `DO $guard$\nDECLARE runtime_count bigint;\nBEGIN\n  IF NOT EXISTS (\n    SELECT 1 FROM public.pos_connections\n    WHERE id = ${sqlLiteral(connectionId)}::uuid\n      AND enabled IS FALSE\n      AND COALESCE(catalog_sync_enabled, FALSE) IS FALSE\n      AND write_mode = 'NONE'\n  ) THEN RAISE EXCEPTION '${label}_CONNECTION_NOT_INACTIVE'; END IF;\n  IF to_regclass('public.runtime_canary_connections') IS NOT NULL THEN\n    EXECUTE 'SELECT count(*) FROM public.runtime_canary_connections WHERE connection_id = $1 AND active'\n      INTO runtime_count USING ${sqlLiteral(connectionId)}::uuid;\n    IF runtime_count <> 0 THEN RAISE EXCEPTION '${label}_RUNTIME_SCOPE_ACTIVE'; END IF;\n  END IF;\n  IF to_regclass('public.runtime_connection_credentials') IS NOT NULL THEN\n    EXECUTE 'SELECT count(*) FROM public.runtime_connection_credentials WHERE connection_id = $1 AND active'\n      INTO runtime_count USING ${sqlLiteral(connectionId)}::uuid;\n    IF runtime_count <> 0 THEN RAISE EXCEPTION '${label}_RUNTIME_CREDENTIAL_ACTIVE'; END IF;\n  END IF;\nEND\n$guard$;`;
}

function countGuard(connectionId, counts, label) {
  const checks = TABLES.map((table) => `  IF (SELECT count(*) FROM public.${table} WHERE connection_id = ${sqlLiteral(connectionId)}::uuid) <> ${counts[table]} THEN RAISE EXCEPTION '${label}_${table.toUpperCase()}_COUNT_MISMATCH'; END IF;`).join("\n");
  return `DO $counts$\nBEGIN\n${checks}\nEND\n$counts$;`;
}

function exactRowsGuard(table, rows, label) {
  if (!rows.length) return `-- ${table}: no exact-row guard`;
  return `DO $exact$\nBEGIN\n  IF EXISTS (\n    SELECT 1 FROM jsonb_populate_recordset(NULL::public.${table}, ${jsonSql(rows, `${label}_rows`)}) expected\n    WHERE NOT EXISTS (\n      SELECT 1 FROM public.${table} actual\n      WHERE actual.id = expected.id AND to_jsonb(actual) = to_jsonb(expected)\n    )\n  ) THEN RAISE EXCEPTION '${label}_EXACT_ROW_MISMATCH'; END IF;\nEND\n$exact$;`;
}

function absenceGuard(table, rows, label) {
  if (!rows.length) return `-- ${table}: no absence guard`;
  return `DO $absent$\nBEGIN\n  IF EXISTS (SELECT 1 FROM public.${table} WHERE id IN (${idsSql(rows)})) THEN\n    RAISE EXCEPTION '${label}_EXPECTED_IDS_ABSENT';\n  END IF;\nEND\n$absent$;`;
}

function updateEvents(rows) {
  if (!rows.length) return "-- sales_events: no updates";
  const fields = Object.keys(rows[0]).filter((key) => key !== "id").sort();
  return `UPDATE public.sales_events target\nSET ${fields.map((field) => `${field} = source.${field}`).join(", ")}\nFROM jsonb_populate_recordset(NULL::public.sales_events, ${jsonSql(rows, "event_updates")}) source\nWHERE target.id = source.id;`;
}

function updateMasterTimestamp(row) {
  return `UPDATE public.agora_master_data\nSET fetched_at = ${sqlLiteral(row.fetched_at)}::timestamptz, updated_at = ${sqlLiteral(row.updated_at)}::timestamptz\nWHERE id = ${sqlLiteral(row.id)}::uuid;`;
}

function masterTimestampGuard(row, label) {
  return `DO $master$\nBEGIN\n  IF NOT EXISTS (\n    SELECT 1 FROM public.agora_master_data\n    WHERE id = ${sqlLiteral(row.id)}::uuid\n      AND fetched_at IS NOT DISTINCT FROM ${sqlLiteral(row.fetched_at)}::timestamptz\n      AND updated_at IS NOT DISTINCT FROM ${sqlLiteral(row.updated_at)}::timestamptz\n  ) THEN RAISE EXCEPTION '${label}_MASTER_TIMESTAMP_MISMATCH'; END IF;\nEND\n$master$;`;
}

function stockReferenceGuard(rows, label) {
  if (!rows.length) return "-- sales_line_items: no stock-reference guard";
  return `DO $stock_refs$\nBEGIN\n  IF EXISTS (SELECT 1 FROM public.stock_sync_log WHERE sales_line_item_id IN (${idsSql(rows)})) THEN\n    RAISE EXCEPTION '${label}_REMOVED_LINE_REFERENCED_BY_STOCK';\n  END IF;\nEND\n$stock_refs$;`;
}

function deleteRows(table, rows) {
  return rows.length ? `DELETE FROM public.${table} WHERE id IN (${idsSql(rows)});` : `-- ${table}: no deletes`;
}

function buildApply({ connectionId, beforeCounts, afterCounts, events, lines, receipts }) {
  const changedBeforeEvents = events.changed.map((entry) => entry.before);
  const changedAfterEvents = events.changed.map((entry) => entry.after);
  return `-- FINAL_FENCED_CONVERGENCE_APPLY\nBEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE;\nSET LOCAL lock_timeout = '10s';\nSET LOCAL statement_timeout = '5min';\nSELECT pg_advisory_xact_lock(hashtext('winerim-final-convergence'), hashtext(${sqlLiteral(connectionId)}));\n${inactiveGuard(connectionId, "FINAL_CONVERGENCE_APPLY")}\n${countGuard(connectionId, beforeCounts, "FINAL_CONVERGENCE_PREIMAGE")}\n${exactRowsGuard("sales_events", changedBeforeEvents, "FINAL_CONVERGENCE_EVENTS_PREIMAGE")}\n${exactRowsGuard("sales_line_items", lines.removed, "FINAL_CONVERGENCE_LINES_PREIMAGE")}\n${absenceGuard("sales_events", events.added, "FINAL_CONVERGENCE_NEW_EVENTS")}\n${absenceGuard("sales_line_items", lines.added, "FINAL_CONVERGENCE_NEW_LINES")}\n${absenceGuard("stock_sync_log", receipts.added, "FINAL_CONVERGENCE_NEW_RECEIPTS")}\n${stockReferenceGuard(lines.removed, "FINAL_CONVERGENCE")}\n${deleteRows("sales_line_items", lines.removed)}\n${updateEvents(changedAfterEvents)}\n${insertRecordset("sales_events", events.added, "new_events")}\n${insertRecordset("sales_line_items", lines.added, "new_lines")}\n${insertRecordset("stock_sync_log", receipts.added, "new_receipts")}\n${countGuard(connectionId, afterCounts, "FINAL_CONVERGENCE_POSTIMAGE")}\n${exactRowsGuard("sales_events", changedAfterEvents, "FINAL_CONVERGENCE_EVENTS_POSTIMAGE")}\n${exactRowsGuard("sales_line_items", lines.added, "FINAL_CONVERGENCE_LINES_POSTIMAGE")}\nCOMMIT;\nSELECT 'FINAL_FENCED_CONVERGENCE_APPLIED' AS result;\n`;
}

function buildRollback({ connectionId, beforeCounts, afterCounts, events, lines, receipts }) {
  const changedBeforeEvents = events.changed.map((entry) => entry.before);
  const changedAfterEvents = events.changed.map((entry) => entry.after);
  return `-- FINAL_FENCED_CONVERGENCE_ROLLBACK\nBEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE;\nSET LOCAL lock_timeout = '10s';\nSET LOCAL statement_timeout = '5min';\nSELECT pg_advisory_xact_lock(hashtext('winerim-final-convergence'), hashtext(${sqlLiteral(connectionId)}));\n${inactiveGuard(connectionId, "FINAL_CONVERGENCE_ROLLBACK")}\n${countGuard(connectionId, afterCounts, "FINAL_CONVERGENCE_ROLLBACK_PREIMAGE")}\n${exactRowsGuard("sales_events", changedAfterEvents, "FINAL_CONVERGENCE_ROLLBACK_EVENTS")}\n${exactRowsGuard("sales_line_items", lines.added, "FINAL_CONVERGENCE_ROLLBACK_LINES")}\n${exactRowsGuard("stock_sync_log", receipts.added, "FINAL_CONVERGENCE_ROLLBACK_RECEIPTS")}\n${absenceGuard("sales_line_items", lines.removed, "FINAL_CONVERGENCE_OLD_LINES")}\n${deleteRows("stock_sync_log", receipts.added)}\n${deleteRows("sales_line_items", lines.added)}\n${deleteRows("sales_events", events.added)}\n${updateEvents(changedBeforeEvents)}\n${insertRecordset("sales_line_items", lines.removed, "old_lines") }\n${countGuard(connectionId, beforeCounts, "FINAL_CONVERGENCE_ROLLBACK_POSTIMAGE")}\nCOMMIT;\nSELECT 'FINAL_FENCED_CONVERGENCE_ROLLED_BACK' AS result;\n`;
}

function writePrivate(path, source) {
  writeFileSync(path, source, { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
  return { bytes: Buffer.byteLength(source), sha256: sha256(source) };
}

function main() {
  const beforeArg = process.argv.find((value) => value.startsWith("--before-dir="))?.split("=", 2)[1];
  const afterArg = process.argv.find((value) => value.startsWith("--after-dir="))?.split("=", 2)[1];
  const outputArg = process.argv.find((value) => value.startsWith("--output-dir="))?.split("=", 2)[1];
  if (![beforeArg, afterArg, outputArg].every((value) => value && isAbsolute(value))) fail("ABSOLUTE_PATHS_REQUIRED");
  const beforeDir = resolve(beforeArg);
  const afterDir = resolve(afterArg);
  const outputDir = resolve(outputArg);
  if (existsSync(outputDir)) fail("OUTPUT_ALREADY_EXISTS");

  const beforeManifest = JSON.parse(privateFile(join(beforeDir, "manifest.json"), "BEFORE_MANIFEST"));
  const afterManifest = JSON.parse(privateFile(join(afterDir, "manifest.json"), "AFTER_MANIFEST"));
  const connectionId = String(afterManifest.connectionId || afterManifest.connection_id || "").toLowerCase();
  const beforeConnectionId = String(beforeManifest.connectionId || beforeManifest.connection_id || "").toLowerCase();
  if (!CONNECTION_ID.test(connectionId) || connectionId !== beforeConnectionId) fail("CONNECTION_ID_MISMATCH");

  const before = Object.fromEntries(TABLES.map((table) => [table, readRows(beforeDir, table)]));
  const after = Object.fromEntries(TABLES.map((table) => [table, readRows(afterDir, table)]));
  const delta = Object.fromEntries(TABLES.map((table) => [table, compareTable(before[table], after[table])]));

  for (const table of ["provider_products", "product_mappings", "winerim_push_tracking"]) {
    if (delta[table].added.length || delta[table].removed.length || delta[table].changed.length) fail(`${table.toUpperCase()}_DRIFT_NOT_ALLOWED`);
  }
  if (delta.agora_master_data.added.length || delta.agora_master_data.removed.length || delta.agora_master_data.changed.length !== 1) fail("MASTER_DELTA_NOT_TIMESTAMP_ONLY");
  if (canonicalJson(delta.agora_master_data.changed[0].keys) !== canonicalJson(["fetched_at", "updated_at"])) fail("MASTER_CHANGED_FIELDS_NOT_ALLOWED");
  if (delta.sales_events.removed.length) fail("EVENT_REMOVAL_NOT_ALLOWED");
  for (const entry of delta.sales_events.changed) {
    if (entry.keys.some((key) => !EVENT_MUTABLE_FIELDS.includes(key))) fail("EVENT_CHANGED_FIELDS_NOT_ALLOWED");
  }
  if (delta.sales_line_items.changed.length) fail("LINE_CHANGE_IN_PLACE_NOT_ALLOWED");
  if (delta.stock_sync_log.removed.length || delta.stock_sync_log.changed.length) fail("RECEIPT_MUTATION_NOT_ALLOWED");
  const removedLineIds = new Set(delta.sales_line_items.removed.map((row) => row.id));
  const finalStockReferences = after.stock_sync_log.rows.filter((row) => row.sales_line_item_id && removedLineIds.has(row.sales_line_item_id));
  if (finalStockReferences.length) fail("REMOVED_LINE_REFERENCED_BY_FINAL_STOCK");

  const beforeCounts = Object.fromEntries(TABLES.map((table) => [table, before[table].rows.length]));
  const afterCounts = Object.fromEntries(TABLES.map((table) => [table, after[table].rows.length]));
  const context = {
    connectionId,
    beforeCounts,
    afterCounts,
    events: delta.sales_events,
    lines: delta.sales_line_items,
    receipts: delta.stock_sync_log,
  };
  const apply = buildApply(context);
  const rollback = buildRollback(context);
  const reconcile = `${countGuard(connectionId, afterCounts, "FINAL_CONVERGENCE_RECONCILE")}\nSELECT 'FINAL_FENCED_CONVERGENCE_RECONCILED' AS result;\n`;

  mkdirSync(outputDir, { mode: 0o700 });
  chmodSync(outputDir, 0o700);
  const applyArtifact = writePrivate(join(outputDir, "apply-final-convergence.sql"), apply);
  const rollbackArtifact = writePrivate(join(outputDir, "rollback-final-convergence.sql"), rollback);
  const reconcileArtifact = writePrivate(join(outputDir, "reconcile-final-convergence.sql"), reconcile);
  const body = {
    schemaVersion: 1,
    kind: "sql-editor-final-fenced-convergence",
    connectionId,
    beforeDirectory: basename(beforeDir),
    afterDirectory: basename(afterDir),
    beforeCounts,
    afterCounts,
    delta: {
      masterTimestampOnlyChangeIgnored: delta.agora_master_data.changed.length,
      eventsAdded: delta.sales_events.added.length,
      eventsChanged: delta.sales_events.changed.length,
      linesAdded: delta.sales_line_items.added.length,
      linesRemoved: delta.sales_line_items.removed.length,
      receiptsAdded: delta.stock_sync_log.added.length,
      removedLineFinalStockReferences: finalStockReferences.length,
    },
    sourceSha256: Object.fromEntries(TABLES.map((table) => [table, { before: before[table].sha256, after: after[table].sha256 }])),
    apply: { filename: "apply-final-convergence.sql", ...applyArtifact },
    rollback: { filename: "rollback-final-convergence.sql", ...rollbackArtifact },
    reconcile: { filename: "reconcile-final-convergence.sql", ...reconcileArtifact },
    activationAllowed: false,
  };
  const manifestSource = `${JSON.stringify({ ...body, manifestSha256: sha256(canonicalJson(body)) }, null, 2)}\n`;
  writePrivate(join(outputDir, "manifest.json"), manifestSource);
  process.stdout.write(`${JSON.stringify({ result: "FINAL_FENCED_CONVERGENCE_READY", outputDir, ...body.delta, applyBytes: applyArtifact.bytes, rollbackBytes: rollbackArtifact.bytes, activationAllowed: false }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "UNEXPECTED_ERROR"}\n`);
  process.exitCode = 1;
}
