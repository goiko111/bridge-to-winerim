#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { normalizeArtifact } from "./agora-shadow-reconcile.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function readPrivate(path, expectedSha256, label) {
  const target = resolve(path);
  const stat = statSync(target);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error(`${label}_MUST_BE_PRIVATE_0600`);
  const source = readFileSync(target);
  if (!SHA256.test(expectedSha256) || digest(source) !== expectedSha256) throw new Error(`${label}_SHA256_MISMATCH`);
  return { source, value: JSON.parse(source.toString("utf8")) };
}

function oneConnection(artifact, connectionId, label) {
  const normalized = normalizeArtifact(artifact, label);
  if (normalized.connections.size !== 1 || !normalized.connections.has(connectionId)) {
    throw new Error(`${label}_CONNECTION_SCOPE_MISMATCH`);
  }
  const raw = artifact.connections?.[0];
  if (raw?.connectionId !== connectionId || raw?.cursor == null || !Array.isArray(raw.events) || !Array.isArray(raw.receipts)) {
    throw new Error(`${label}_CONTRACT_REJECTED`);
  }
  return { normalized: normalized.connections.get(connectionId), raw };
}

function eventIndex(raw, label, { allowOpenTickets = false } = {}) {
  const index = new Map();
  for (const event of raw.events) {
    const providerDocId = String(event.providerDocId ?? "").trim();
    const businessDay = String(event.businessDay ?? "");
    const docType = String(event.docType ?? "").toUpperCase();
    if (!providerDocId || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay) || !docType) throw new Error(`${label}_EVENT_REJECTED`);
    if (!allowOpenTickets && /^OPEN_?TICKET$/.test(docType)) throw new Error(`${label}_OPEN_TICKET_REPAIR_FORBIDDEN`);
    if (index.has(providerDocId)) throw new Error(`${label}_DUPLICATE_PROVIDER_DOC_ID`);
    index.set(providerDocId, { businessDay, docType, lines: event.lines?.length ?? 0 });
  }
  return index;
}

function materialIndex(map, label, { omitBusinessDay = false } = {}) {
  const index = new Map();
  for (const [key, originalValue] of map) {
    if (!/^\d{4}-\d{2}-\d{2}\|/.test(key)) throw new Error(`${label}_IDENTITY_REJECTED`);
    const identity = key.slice(11);
    if (!identity || index.has(identity)) throw new Error(`${label}_IDENTITY_REJECTED`);
    const value = omitBusinessDay
      ? Object.fromEntries(Object.entries(originalValue).filter(([field]) => field !== "businessDay"))
      : originalValue;
    index.set(identity, value);
  }
  return index;
}

function requireMaterialEquality(sourceMap, targetMap, label, options) {
  const source = materialIndex(sourceMap, `SOURCE_${label}`, options);
  const target = materialIndex(targetMap, `TARGET_${label}`, options);
  if (
    source.size !== target.size
    || [...source].some(([identity, value]) => !target.has(identity) || !isDeepStrictEqual(value, target.get(identity)))
  ) throw new Error(`BUSINESS_DAY_REPAIR_${label}_MATERIAL_MISMATCH`);
}

function withoutBusinessDay(value) {
  if (Array.isArray(value)) return value.map(withoutBusinessDay);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([field]) => field !== "businessDay" && field !== "business_day")
    .map(([field, nested]) => [field, withoutBusinessDay(nested)]));
}

function rawLineIndex(raw, label) {
  const index = new Map();
  for (const event of raw.events) {
    for (const line of event.lines) {
      const identity = JSON.stringify([event.providerDocId, line?.providerLineId]);
      if (!line || typeof line !== "object" || !line.providerLineId || index.has(identity)) {
        throw new Error(`${label}_LINE_IDENTITY_REJECTED`);
      }
      index.set(identity, withoutBusinessDay(line));
    }
  }
  return index;
}

function rawReceiptIndex(raw, label) {
  const index = new Map();
  for (const receipt of raw.receipts) {
    const identity = JSON.stringify([receipt?.providerDocId, receipt?.orderId, receipt?.receiptId]);
    if (!receipt || typeof receipt !== "object" || !receipt.providerDocId || !receipt.orderId || !receipt.receiptId || index.has(identity)) {
      throw new Error(`${label}_RECEIPT_IDENTITY_REJECTED`);
    }
    index.set(identity, withoutBusinessDay(receipt));
  }
  return index;
}

function requireRawMaterialEquality(source, target, label, indexer) {
  const sourceIndex = indexer(source, "SOURCE");
  const targetIndex = indexer(target, "TARGET");
  if (
    sourceIndex.size !== targetIndex.size
    || [...sourceIndex].some(([identity, value]) => !targetIndex.has(identity) || !isDeepStrictEqual(value, targetIndex.get(identity)))
  ) throw new Error(`BUSINESS_DAY_REPAIR_${label}_MATERIAL_MISMATCH`);
}

function cursorValue(value, type, label) {
  if (value == null) return `NULL::${type}`;
  if (typeof value !== "string") throw new Error(`${label}_CURSOR_REJECTED`);
  if (type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label}_CURSOR_REJECTED`);
  if (type === "timestamptz" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${label}_CURSOR_REJECTED`);
  }
  return `${sqlText(value)}::${type}`;
}

function cursorSql(cursor, label) {
  return {
    lastBusinessDaySynced: cursorValue(cursor.lastBusinessDaySynced, "date", label),
    lastSyncAt: cursorValue(cursor.lastSyncAt, "timestamptz", label),
  };
}

function renderCursorUpdate(connectionId, expectedCursor, nextCursor, error) {
  const id = `${sqlText(connectionId)}::uuid`;
  return `DO $cursor$
DECLARE
  updated_rows integer;
BEGIN
  PERFORM 1 FROM public.pos_connections
  WHERE id=${id}
    AND last_business_day_synced IS NOT DISTINCT FROM ${expectedCursor.lastBusinessDaySynced}
    AND last_sync_at IS NOT DISTINCT FROM ${expectedCursor.lastSyncAt}
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '${error}'; END IF;
  UPDATE public.pos_connections
  SET last_business_day_synced=${nextCursor.lastBusinessDaySynced}, last_sync_at=${nextCursor.lastSyncAt}
  WHERE id=${id}
    AND last_business_day_synced IS NOT DISTINCT FROM ${expectedCursor.lastBusinessDaySynced}
    AND last_sync_at IS NOT DISTINCT FROM ${expectedCursor.lastSyncAt};
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  IF updated_rows <> 1 THEN RAISE EXCEPTION '${error}'; END IF;
END
$cursor$;`;
}

function captureGate(artifact, label, target) {
  const capture = artifact.capture;
  if (!capture || capture.sourceMarkerStable !== true) throw new Error(`${label}_CAPTURE_NOT_STABLE`);
  if (target && (capture.mode !== "POSTGRES_REPEATABLE_READ_ONLY" || capture.authoritative !== true)) {
    throw new Error(`${label}_TARGET_NOT_AUTHORITATIVE`);
  }
}

export function buildBusinessDayRepair({
  sourceArtifact,
  targetArtifact,
  sourceSha256,
  targetSha256,
  connectionId,
  expectedEvents,
  expectedLines,
  expectedReceipts,
  expectedOpenTickets = 0,
  allowOpenTickets = false,
}) {
  if (!UUID.test(connectionId)) throw new Error("BUSINESS_DAY_REPAIR_INVALID_CONNECTION_ID");
  captureGate(sourceArtifact, "SOURCE", false);
  captureGate(targetArtifact, "TARGET", true);
  const source = oneConnection(sourceArtifact, connectionId, "SOURCE");
  const target = oneConnection(targetArtifact, connectionId, "TARGET");
  const sourceEvents = eventIndex(source.raw, "SOURCE", { allowOpenTickets });
  const targetEvents = eventIndex(target.raw, "TARGET", { allowOpenTickets });
  const sourceLines = [...sourceEvents.values()].reduce((sum, event) => sum + event.lines, 0);
  const targetLines = [...targetEvents.values()].reduce((sum, event) => sum + event.lines, 0);
  const sourceOpenTickets = [...sourceEvents.values()].filter((event) => /^OPEN_?TICKET$/.test(event.docType)).length;
  const targetOpenTickets = [...targetEvents.values()].filter((event) => /^OPEN_?TICKET$/.test(event.docType)).length;
  if (
    sourceEvents.size !== expectedEvents || targetEvents.size !== expectedEvents
    || sourceLines !== expectedLines || targetLines !== expectedLines
    || source.raw.receipts.length !== expectedReceipts || target.raw.receipts.length !== expectedReceipts
    || source.raw.receipts.some((receipt) => String(receipt.providerDocId ?? "").startsWith("orphan:"))
    || target.raw.receipts.some((receipt) => String(receipt.providerDocId ?? "").startsWith("orphan:"))
    || sourceOpenTickets !== expectedOpenTickets || targetOpenTickets !== expectedOpenTickets
  ) throw new Error("BUSINESS_DAY_REPAIR_WATERMARK_MISMATCH");

  requireMaterialEquality(source.normalized.events, target.normalized.events, "EVENT", { omitBusinessDay: true });
  requireMaterialEquality(source.normalized.lines, target.normalized.lines, "LINE");
  requireMaterialEquality(source.normalized.receipts, target.normalized.receipts, "RECEIPT");
  requireRawMaterialEquality(source.raw, target.raw, "LINE", rawLineIndex);
  requireRawMaterialEquality(source.raw, target.raw, "RECEIPT", rawReceiptIndex);

  const rows = [...sourceEvents.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([providerDocId, sourceEvent]) => {
    const targetEvent = targetEvents.get(providerDocId);
    if (!targetEvent || targetEvent.docType !== sourceEvent.docType) throw new Error("BUSINESS_DAY_REPAIR_EVENT_SET_MISMATCH");
    return { providerDocId, oldDay: targetEvent.businessDay, newDay: sourceEvent.businessDay, docType: sourceEvent.docType };
  });
  if (targetEvents.size !== rows.length) throw new Error("BUSINESS_DAY_REPAIR_EVENT_SET_MISMATCH");
  const changedRows = rows.filter((row) => row.oldDay !== row.newDay).length;
  const sourceCursor = source.normalized.cursor;
  const targetCursor = target.normalized.cursor;
  const sourceCursorSql = cursorSql(sourceCursor, "SOURCE");
  const targetCursorSql = cursorSql(targetCursor, "TARGET");
  const values = rows.map((row) => `    (${sqlText(row.providerDocId)}, ${sqlText(row.oldDay)}::date, ${sqlText(row.newDay)}::date, ${sqlText(row.docType)})`).join(",\n");
  const common = `SET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '30s';\nSELECT pg_advisory_xact_lock(hashtextextended(${sqlText(`business-day-repair:${connectionId}`)}, 0));\nCREATE TEMP TABLE expected_days (provider_doc_id text PRIMARY KEY, old_day date NOT NULL, new_day date NOT NULL, doc_type text NOT NULL) ON COMMIT DROP;\nINSERT INTO expected_days VALUES\n${values};\nDO $gate$\nBEGIN\n  IF (SELECT count(*) FROM expected_days) <> ${expectedEvents} THEN RAISE EXCEPTION 'BUSINESS_DAY_REPAIR_MAP_COUNT'; END IF;\n  IF NOT EXISTS (SELECT 1 FROM public.pos_connections WHERE id=${sqlText(connectionId)}::uuid AND enabled=false AND catalog_sync_enabled=false AND write_mode='NONE') THEN RAISE EXCEPTION 'BUSINESS_DAY_REPAIR_CONNECTION_NOT_INERT'; END IF;\n  IF EXISTS (SELECT 1 FROM public.runtime_canary_connections WHERE connection_id=${sqlText(connectionId)}::uuid AND active=true) THEN RAISE EXCEPTION 'BUSINESS_DAY_REPAIR_RUNTIME_ACTIVE'; END IF;\n  IF EXISTS (SELECT 1 FROM public.runtime_idempotency WHERE connection_id=${sqlText(connectionId)}::uuid) THEN RAISE EXCEPTION 'BUSINESS_DAY_REPAIR_RUNTIME_IDEMPOTENCY_PRESENT'; END IF;\n  IF (SELECT count(*) FROM public.sales_events WHERE connection_id=${sqlText(connectionId)}::uuid) <> ${expectedEvents} THEN RAISE EXCEPTION 'BUSINESS_DAY_REPAIR_EVENT_COUNT'; END IF;\n  IF (SELECT count(*) FROM public.sales_line_items WHERE connection_id=${sqlText(connectionId)}::uuid) <> ${expectedLines} THEN RAISE EXCEPTION 'BUSINESS_DAY_REPAIR_LINE_COUNT'; END IF;\n  IF (SELECT count(*) FROM public.stock_sync_log WHERE connection_id=${sqlText(connectionId)}::uuid) <> ${expectedReceipts} THEN RAISE EXCEPTION 'BUSINESS_DAY_REPAIR_RECEIPT_COUNT'; END IF;\n  IF EXISTS (SELECT 1 FROM public.stock_sync_log WHERE connection_id=${sqlText(connectionId)}::uuid AND sales_event_id IS NULL) THEN RAISE EXCEPTION 'BUSINESS_DAY_REPAIR_ORPHAN_RECEIPT'; END IF;\n  IF (SELECT count(*) FROM public.sales_events WHERE connection_id=${sqlText(connectionId)}::uuid AND upper(doc_type) IN ('OPENTICKET','OPEN_TICKET')) <> ${expectedOpenTickets} THEN RAISE EXCEPTION 'BUSINESS_DAY_REPAIR_OPEN_TICKET_COUNT'; END IF;\nEND\n$gate$;`;
  const apply = `BEGIN ISOLATION LEVEL SERIALIZABLE;\n${common}\nDO $pre$\nBEGIN\n  IF EXISTS (SELECT 1 FROM expected_days expected LEFT JOIN public.sales_events event ON event.connection_id=${sqlText(connectionId)}::uuid AND event.provider_doc_id=expected.provider_doc_id WHERE event.id IS NULL OR event.business_day<>expected.old_day OR upper(event.doc_type)<>expected.doc_type) THEN RAISE EXCEPTION 'BUSINESS_DAY_REPAIR_PREIMAGE_MISMATCH'; END IF;\nEND\n$pre$;\nUPDATE public.sales_events event SET business_day=expected.new_day FROM expected_days expected WHERE event.connection_id=${sqlText(connectionId)}::uuid AND event.provider_doc_id=expected.provider_doc_id AND event.business_day=expected.old_day;\nDO $post$ BEGIN IF (SELECT count(*) FROM public.sales_events event JOIN expected_days expected ON expected.provider_doc_id=event.provider_doc_id WHERE event.connection_id=${sqlText(connectionId)}::uuid AND event.business_day=expected.new_day) <> ${expectedEvents} THEN RAISE EXCEPTION 'BUSINESS_DAY_REPAIR_POSTIMAGE_MISMATCH'; END IF; END $post$;\n${renderCursorUpdate(connectionId, targetCursorSql, sourceCursorSql, "BUSINESS_DAY_REPAIR_CURSOR_PREIMAGE_MISMATCH")}\nCOMMIT;\n`;
  const rollbackValues = rows.map((row) => `    (${sqlText(row.providerDocId)}, ${sqlText(row.newDay)}::date, ${sqlText(row.oldDay)}::date, ${sqlText(row.docType)})`).join(",\n");
  const rollback = `BEGIN ISOLATION LEVEL SERIALIZABLE;\n${common.replace(values, rollbackValues)}\nDO $pre$ BEGIN IF EXISTS (SELECT 1 FROM expected_days expected LEFT JOIN public.sales_events event ON event.connection_id=${sqlText(connectionId)}::uuid AND event.provider_doc_id=expected.provider_doc_id WHERE event.id IS NULL OR event.business_day<>expected.old_day OR upper(event.doc_type)<>expected.doc_type) THEN RAISE EXCEPTION 'BUSINESS_DAY_ROLLBACK_PREIMAGE_MISMATCH'; END IF; END $pre$;\nUPDATE public.sales_events event SET business_day=expected.new_day FROM expected_days expected WHERE event.connection_id=${sqlText(connectionId)}::uuid AND event.provider_doc_id=expected.provider_doc_id AND event.business_day=expected.old_day;\nDO $post$ BEGIN IF (SELECT count(*) FROM public.sales_events event JOIN expected_days expected ON expected.provider_doc_id=event.provider_doc_id WHERE event.connection_id=${sqlText(connectionId)}::uuid AND event.business_day=expected.new_day) <> ${expectedEvents} THEN RAISE EXCEPTION 'BUSINESS_DAY_ROLLBACK_POSTIMAGE_MISMATCH'; END IF; END $post$;\n${renderCursorUpdate(connectionId, sourceCursorSql, targetCursorSql, "BUSINESS_DAY_ROLLBACK_CURSOR_PREIMAGE_MISMATCH")}\nCOMMIT;\n`;
  return { apply, rollback, manifest: { version: 1, connectionId, expectedEvents, expectedLines, expectedReceipts, expectedOpenTickets, allowOpenTickets, changedRows, sourceSha256, targetSha256, sourceCursor, targetCursor } };
}

function argument(name) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function main() {
  const apply = process.argv.includes("--apply");
  const connectionId = argument("--connection-id");
  const sourcePath = argument("--source");
  const targetPath = argument("--target");
  const outputDir = argument("--output-dir");
  const expectedEvents = Number(argument("--expected-events"));
  const expectedLines = Number(argument("--expected-lines"));
  const expectedReceipts = Number(argument("--expected-receipts"));
  const expectedOpenTickets = Number(argument("--expected-open-tickets") ?? "0");
  const allowOpenTickets = process.argv.includes("--allow-open-tickets");
  if (!apply || !connectionId || !sourcePath || !targetPath || !outputDir || !isAbsolute(outputDir)) throw new Error("BUSINESS_DAY_REPAIR_USAGE");
  const relativeOutput = relative(repoRoot, resolve(outputDir));
  if (relativeOutput === "" || (!relativeOutput.startsWith("..") && !relativeOutput.startsWith("/"))) throw new Error("BUSINESS_DAY_REPAIR_OUTPUT_INSIDE_REPOSITORY");
  const sourceSha256 = argument("--source-sha256");
  const targetSha256 = argument("--target-sha256");
  const source = readPrivate(sourcePath, sourceSha256, "SOURCE_ARTIFACT");
  const target = readPrivate(targetPath, targetSha256, "TARGET_ARTIFACT");
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  realpathSync(outputDir);
  const result = buildBusinessDayRepair({ sourceArtifact: source.value, targetArtifact: target.value, sourceSha256, targetSha256, connectionId, expectedEvents, expectedLines, expectedReceipts, expectedOpenTickets, allowOpenTickets });
  const applyPath = resolve(outputDir, "apply.sql");
  const rollbackPath = resolve(outputDir, "rollback.sql");
  writeFileSync(applyPath, result.apply, { mode: 0o600, flag: "wx" });
  writeFileSync(rollbackPath, result.rollback, { mode: 0o600, flag: "wx" });
  chmodSync(applyPath, 0o600); chmodSync(rollbackPath, 0o600);
  const manifest = { ...result.manifest, applySha256: digest(result.apply), rollbackSha256: digest(result.rollback), remoteWrites: 0 };
  const manifestPath = resolve(outputDir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(manifestPath, 0o600);
  process.stdout.write(`${JSON.stringify({ result: "BUSINESS_DAY_REPAIR_PACKAGE_READY", connectionId, changedRows: manifest.changedRows, outputDir, remoteWrites: 0 })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
