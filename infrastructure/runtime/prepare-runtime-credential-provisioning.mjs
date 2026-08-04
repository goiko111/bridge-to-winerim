import {
  createCipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson as shadowCanonicalJson,
  normalizeArtifact as normalizeShadowArtifact,
  reconcileArtifacts,
} from "../../scripts/agora-shadow-reconcile.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHADOW_SCHEMA_VERSION = "agora-shadow-v2";
const SHADOW_REPORT_KEYS = [
  "connections",
  "differences",
  "dryRun",
  "inputs",
  "reportSha256",
  "result",
  "schemaVersion",
  "scope",
  "summary",
  "writes",
];
const MAX_PLAINTEXT_BYTES = 8 * 1024;
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

function required(environment, name) {
  const value = String(environment[name] ?? "").trim();
  if (!value) throw new Error(`RUNTIME_CREDENTIAL_PROVISION_MISSING_${name}`);
  return value;
}

function decodeMasterKey(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_MASTER_KEY_BASE64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_MASTER_KEY_MUST_BE_32_BYTES");
  }
  return decoded;
}

function exactSha256(source, expected, label) {
  if (!SHA256_PATTERN.test(expected)) {
    throw new Error(`RUNTIME_CREDENTIAL_PROVISION_INVALID_${label}_SHA256`);
  }
  const actual = createHash("sha256").update(source).digest("hex");
  if (actual !== expected) {
    throw new Error(`RUNTIME_CREDENTIAL_PROVISION_${label}_SHA256_MISMATCH`);
  }
  return actual;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`RUNTIME_CREDENTIAL_PROVISION_INVALID_${label}`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`RUNTIME_CREDENTIAL_PROVISION_INVALID_${label}`);
  }
  return value;
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`RUNTIME_CREDENTIAL_PROVISION_INVALID_${label}`);
  }
  return value;
}

function canonicalDate(value, label) {
  if (!DATE_PATTERN.test(value ?? "")) {
    throw new Error(`RUNTIME_CREDENTIAL_PROVISION_INVALID_${label}`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`RUNTIME_CREDENTIAL_PROVISION_INVALID_${label}`);
  }
  return value;
}

function exactObjectKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`RUNTIME_CREDENTIAL_PROVISION_INVALID_${label}`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`RUNTIME_CREDENTIAL_PROVISION_INVALID_${label}_STRUCTURE`);
  }
}

function parseJsonBuffer(source, label) {
  try {
    return JSON.parse(source.toString("utf8"));
  } catch {
    throw new Error(`RUNTIME_CREDENTIAL_PROVISION_INVALID_${label}_JSON`);
  }
}

function validateShadowCapture(artifact, label, { target = false } = {}) {
  exactObjectKeys(artifact.capture, [
    "authoritative",
    "captureEndedAt",
    "captureStartedAt",
    "consistencyBlocker",
    "mode",
    "sourceMarkerStable",
  ], `${label}_CAPTURE`);
  const startedAt = canonicalTimestamp(artifact.capture.captureStartedAt, `${label}_CAPTURE_STARTED_AT`);
  const endedAt = canonicalTimestamp(artifact.capture.captureEndedAt, `${label}_CAPTURE_ENDED_AT`);
  if (endedAt < startedAt || artifact.capture.sourceMarkerStable !== true) {
    throw new Error(`RUNTIME_CREDENTIAL_PROVISION_INVALID_${label}_CAPTURE`);
  }
  if (target) {
    if (
      artifact.capture.mode !== "POSTGRES_REPEATABLE_READ_ONLY"
      || artifact.capture.authoritative !== true
      || artifact.capture.consistencyBlocker !== null
    ) {
      throw new Error("RUNTIME_CREDENTIAL_PROVISION_TARGET_CAPTURE_NOT_AUTHORITATIVE");
    }
    return;
  }
  if (
    artifact.capture.mode !== "OBSERVATIONAL_READ_ONLY"
    || artifact.capture.authoritative !== false
    || artifact.capture.consistencyBlocker !== "REST_NON_TRANSACTIONAL_AND_WRITER_NOT_FENCED"
  ) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_SOURCE_CAPTURE_CONTRACT_REJECTED");
  }
}

function shadowArtifactWatermarks(sourceArtifact, connectionId, label, options = {}) {
  exactObjectKeys(sourceArtifact, ["schemaVersion", "capture", "connections"], label);
  validateShadowCapture(sourceArtifact, label, options);
  if (
    sourceArtifact.schemaVersion !== SHADOW_SCHEMA_VERSION
    || !Array.isArray(sourceArtifact.connections)
    || sourceArtifact.connections.length !== 1
  ) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_SHADOW_SOURCE_CONTRACT");
  }
  let normalized;
  try {
    normalized = normalizeShadowArtifact(sourceArtifact, label);
  } catch {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_SHADOW_SOURCE_CONNECTION");
  }
  const connection = normalized.connections.get(connectionId);
  if (!connection || normalized.connections.size !== 1) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_SHADOW_SOURCE_CONNECTION");
  }
  const salesEvents = positiveSafeInteger(connection.events.size, "ADOPTION_SALES_EVENTS");
  const salesLineItems = connection.lines.size;
  positiveSafeInteger(salesLineItems, "ADOPTION_SALES_LINE_ITEMS");
  const maxBusinessDay = [...connection.events.values()]
    .map((event) => canonicalDate(event.businessDay, "ADOPTION_EVENT_BUSINESS_DAY"))
    .sort()
    .at(-1);
  const lastBusinessDaySynced = canonicalDate(
    connection.cursor.lastBusinessDaySynced,
    "ADOPTION_CURSOR_DAY",
  );
  const lastSyncAt = canonicalTimestamp(
    connection.cursor.lastSyncAt,
    "ADOPTION_LAST_SYNC_AT",
  );
  if (lastBusinessDaySynced < maxBusinessDay) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_ADOPTION_CURSOR_BEHIND_SALES");
  }
  return {
    salesEvents,
    salesLineItems,
    receipts: connection.receipts.size,
    maxBusinessDay,
    lastBusinessDaySynced,
    lastSyncAt,
  };
}

function validateShadowReport(report, connectionId, sourceDatasetSha256) {
  exactObjectKeys(report, SHADOW_REPORT_KEYS, "SHADOW_REPORT");
  exactObjectKeys(report.scope, ["connectionCount", "connectionIds"], "SHADOW_REPORT_SCOPE");
  exactObjectKeys(
    report.summary,
    ["reconciledConnections", "differingConnections", "differences"],
    "SHADOW_REPORT_SUMMARY",
  );
  exactObjectKeys(report.inputs, ["lovableSha256", "ownSha256"], "SHADOW_REPORT_INPUTS");
  if (
    report.schemaVersion !== SHADOW_SCHEMA_VERSION
    || report.result !== "RECONCILED_EXACT"
    || report.dryRun !== true
    || report.writes !== false
    || report.scope.connectionCount !== 1
    || !Array.isArray(report.scope.connectionIds)
    || report.scope.connectionIds.length !== 1
    || report.scope.connectionIds[0] !== connectionId
    || report.summary.reconciledConnections !== 1
    || report.summary.differingConnections !== 0
    || report.summary.differences !== 0
    || !Array.isArray(report.differences)
    || report.differences.length !== 0
    || !Array.isArray(report.connections)
    || report.connections.length !== 1
  ) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_ADOPTION_RECONCILIATION_NOT_EXACT");
  }
  const connection = report.connections[0];
  exactObjectKeys(
    connection,
    ["connectionId", "status", "events", "lines", "receipts"],
    "SHADOW_REPORT_CONNECTION",
  );
  if (connection.connectionId !== connectionId || connection.status !== "RECONCILED_EXACT") {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_ADOPTION_RECONCILIATION_NOT_EXACT");
  }
  if (
    !SHA256_PATTERN.test(report.inputs.lovableSha256 ?? "")
    || !SHA256_PATTERN.test(report.inputs.ownSha256 ?? "")
    || report.inputs.lovableSha256 !== sourceDatasetSha256
    || report.inputs.lovableSha256 === report.inputs.ownSha256
  ) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_SHADOW_REPORT_DATASET_HASHES");
  }
  if (!SHA256_PATTERN.test(report.reportSha256 ?? "")) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_SHADOW_REPORT_SHA256");
  }
  const { reportSha256, ...reportBody } = report;
  const expectedReportSha256 = createHash("sha256")
    .update(shadowCanonicalJson(reportBody))
    .digest("hex");
  if (reportSha256 !== expectedReportSha256) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_SHADOW_REPORT_SHA256_MISMATCH");
  }
  return {
    connection,
    reportSha256,
    sourceDatasetSha256: report.inputs.lovableSha256,
    targetDatasetSha256: report.inputs.ownSha256,
  };
}

function adoptionBindingSha256(adoption) {
  return createHash("sha256").update([
    "winerim-runtime-adopt-existing",
    "3",
    adoption.kind,
    adoption.schemaVersion,
    adoption.connectionId,
    adoption.exportManifestSha256,
    adoption.reconciliationManifestSha256,
    adoption.reconciliationReportSha256,
    adoption.sourceDatasetSha256,
    adoption.targetDatasetSha256,
    String(adoption.watermarks.salesEvents),
    String(adoption.watermarks.salesLineItems),
    adoption.watermarks.maxBusinessDay,
    adoption.watermarks.lastBusinessDaySynced,
    adoption.watermarks.lastSyncAt,
  ].join("|")).digest("hex");
}

export function validateAdoptExistingEvidence({
  connectionId,
  exportManifestSource,
  exportManifestSha256,
  targetManifestSource,
  targetManifestSha256,
  reconciliationManifestSource,
  reconciliationManifestSha256,
}) {
  if (!UUID_PATTERN.test(connectionId)) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_CONNECTION_ID");
  }
  if (!Buffer.isBuffer(exportManifestSource) || exportManifestSource.length === 0) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_EMPTY_EXPORT_MANIFEST");
  }
  const verifiedExportSha256 = exactSha256(
    exportManifestSource,
    exportManifestSha256,
    "EXPORT_MANIFEST",
  );
  if (!Buffer.isBuffer(targetManifestSource) || targetManifestSource.length === 0) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_EMPTY_TARGET_MANIFEST");
  }
  const verifiedTargetSha256 = exactSha256(
    targetManifestSource,
    targetManifestSha256,
    "TARGET_MANIFEST",
  );
  if (!Buffer.isBuffer(reconciliationManifestSource) || reconciliationManifestSource.length === 0) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_EMPTY_RECONCILIATION_MANIFEST");
  }
  const verifiedReconciliationSha256 = exactSha256(
    reconciliationManifestSource,
    reconciliationManifestSha256,
    "RECONCILIATION_MANIFEST",
  );

  const sourceArtifact = parseJsonBuffer(exportManifestSource, "SHADOW_SOURCE");
  const watermarks = shadowArtifactWatermarks(sourceArtifact, connectionId, "SHADOW_SOURCE");
  const targetArtifact = parseJsonBuffer(targetManifestSource, "SHADOW_TARGET");
  const targetWatermarks = shadowArtifactWatermarks(
    targetArtifact,
    connectionId,
    "SHADOW_TARGET",
    { target: true },
  );
  const reconciliation = parseJsonBuffer(
    reconciliationManifestSource,
    "RECONCILIATION_MANIFEST",
  );
  const report = validateShadowReport(reconciliation, connectionId, verifiedExportSha256);
  if (report.targetDatasetSha256 !== verifiedTargetSha256) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_SHADOW_REPORT_TARGET_SHA256_MISMATCH");
  }
  const recomputedReconciliation = reconcileArtifacts(sourceArtifact, targetArtifact);
  if (
    recomputedReconciliation.result !== "RECONCILED_EXACT"
    || recomputedReconciliation.summary.differences !== 0
    || recomputedReconciliation.differences.length !== 0
    || recomputedReconciliation.connections.length !== 1
    || recomputedReconciliation.connections[0].connectionId !== connectionId
    || recomputedReconciliation.connections[0].status !== "RECONCILED_EXACT"
  ) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_ADOPTION_RECONCILIATION_NOT_EXACT");
  }
  if (
    report.connection.events !== watermarks.salesEvents
    || report.connection.lines !== watermarks.salesLineItems
    || report.connection.receipts !== watermarks.receipts
    || targetWatermarks.salesEvents !== watermarks.salesEvents
    || targetWatermarks.salesLineItems !== watermarks.salesLineItems
    || targetWatermarks.receipts !== watermarks.receipts
    || targetWatermarks.maxBusinessDay !== watermarks.maxBusinessDay
    || targetWatermarks.lastBusinessDaySynced !== watermarks.lastBusinessDaySynced
  ) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_SHADOW_REPORT_WATERMARK_MISMATCH");
  }

  const adoption = {
    version: 3,
    kind: "AGORA_SHADOW_RECONCILIATION_EVIDENCE",
    schemaVersion: SHADOW_SCHEMA_VERSION,
    connectionId,
    exportManifestSha256: verifiedExportSha256,
    reconciliationManifestSha256: verifiedReconciliationSha256,
    reconciliationReportSha256: report.reportSha256,
    sourceDatasetSha256: report.sourceDatasetSha256,
    targetDatasetSha256: report.targetDatasetSha256,
    reconciliationStatus: "RECONCILED_EXACT",
    watermarks: {
      salesEvents: watermarks.salesEvents,
      salesLineItems: watermarks.salesLineItems,
      maxBusinessDay: watermarks.maxBusinessDay,
      lastBusinessDaySynced: watermarks.lastBusinessDaySynced,
      lastSyncAt: watermarks.lastSyncAt,
    },
  };
  return { ...adoption, bindingSha256: adoptionBindingSha256(adoption) };
}

function validateAdoptionObject(adoption, connectionId) {
  if (
    adoption?.version !== 3
    || adoption?.kind !== "AGORA_SHADOW_RECONCILIATION_EVIDENCE"
    || adoption?.schemaVersion !== SHADOW_SCHEMA_VERSION
    || adoption?.connectionId !== connectionId
    || !SHA256_PATTERN.test(adoption?.exportManifestSha256 ?? "")
    || !SHA256_PATTERN.test(adoption?.reconciliationManifestSha256 ?? "")
    || !SHA256_PATTERN.test(adoption?.reconciliationReportSha256 ?? "")
    || !SHA256_PATTERN.test(adoption?.sourceDatasetSha256 ?? "")
    || !SHA256_PATTERN.test(adoption?.targetDatasetSha256 ?? "")
    || adoption?.sourceDatasetSha256 === adoption?.targetDatasetSha256
    || !SHA256_PATTERN.test(adoption?.bindingSha256 ?? "")
    || adoption?.reconciliationStatus !== "RECONCILED_EXACT"
  ) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_ADOPTION_EVIDENCE");
  }
  positiveSafeInteger(adoption.watermarks.salesEvents, "ADOPTION_SALES_EVENTS");
  positiveSafeInteger(adoption.watermarks.salesLineItems, "ADOPTION_SALES_LINE_ITEMS");
  canonicalDate(adoption.watermarks.maxBusinessDay, "ADOPTION_MAX_BUSINESS_DAY");
  canonicalDate(adoption.watermarks.lastBusinessDaySynced, "ADOPTION_CURSOR_DAY");
  canonicalTimestamp(adoption.watermarks.lastSyncAt, "ADOPTION_LAST_SYNC_AT");
  if (adoption.watermarks.lastBusinessDaySynced < adoption.watermarks.maxBusinessDay) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_ADOPTION_CURSOR_BEHIND_SALES");
  }
  if (adoptionBindingSha256(adoption) !== adoption.bindingSha256) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_ADOPTION_BINDING_MISMATCH");
  }
}

export function runtimeCredentialAad({ connectionId, kind, keyVersion }) {
  return [
    "winerim-runtime-credential",
    "1",
    connectionId,
    "agora",
    kind,
    keyVersion,
  ].join("|");
}

export function encryptRuntimeCredential({
  connectionId,
  kind,
  keyVersion,
  plaintext,
  masterKey,
  nonce = randomBytes(12),
}) {
  if (!UUID_PATTERN.test(connectionId)) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_CONNECTION_ID");
  }
  if (!KEY_VERSION_PATTERN.test(keyVersion)) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_KEY_VERSION");
  }
  if (!new Set(["agora", "winerim"]).has(kind)) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_KIND");
  }
  const plaintextBytes = Buffer.byteLength(plaintext, "utf8");
  if (
    plaintextBytes === 0
    || plaintextBytes > MAX_PLAINTEXT_BYTES
    || plaintext !== plaintext.trim()
    || /[\r\n]/.test(plaintext)
  ) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_PLAINTEXT_LENGTH");
  }
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_MASTER_KEY_MUST_BE_32_BYTES");
  }
  if (!Buffer.isBuffer(nonce) || nonce.length !== 12) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_NONCE_MUST_BE_12_BYTES");
  }

  const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
  cipher.setAAD(Buffer.from(runtimeCredentialAad({ connectionId, kind, keyVersion }), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const reference = `runtime-vault://postgres/${connectionId}/agora/${kind}`;
  return {
    kind,
    nonceHex: nonce.toString("hex"),
    ciphertextHex: ciphertext.toString("hex"),
    attestationSha256: createHash("sha256").update([
      "winerim-runtime-credential-attestation",
      "1",
      reference,
      keyVersion,
      "1",
      nonce.toString("base64"),
      ciphertext.toString("base64"),
    ].join("|")).digest("hex"),
  };
}

export function runtimeCredentialSetSha256({ connectionId, runId, keyVersion, credentials }) {
  const byKind = Object.fromEntries(credentials.map((credential) => [credential.kind, credential]));
  if (!byKind.agora || !byKind.winerim) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_REQUIRES_AGORA_AND_WINERIM");
  }
  return createHash("sha256").update([
    "winerim-runtime-credential-set",
    "1",
    connectionId,
    runId,
    keyVersion,
    byKind.agora.attestationSha256,
    byKind.winerim.attestationSha256,
  ].join("|")).digest("hex");
}

export function renderCredentialProvisioningSql({
  connectionId,
  runId,
  keyVersion,
  credentials,
  mode = "bootstrap",
  adoption,
}) {
  if (!UUID_PATTERN.test(connectionId)) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_CONNECTION_ID");
  }
  if (!RUN_PATTERN.test(runId)) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_RUN_ID");
  }
  if (!KEY_VERSION_PATTERN.test(keyVersion)) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_KEY_VERSION");
  }
  if (!new Set(["bootstrap", "rotate", "adopt-existing"]).has(mode)) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_MODE");
  }
  if (mode === "adopt-existing") validateAdoptionObject(adoption, connectionId);
  if (mode !== "adopt-existing" && adoption !== undefined) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_UNEXPECTED_ADOPTION_EVIDENCE");
  }
  if (credentials.length !== 2 || credentials.map(({ kind }) => kind).sort().join(",") !== "agora,winerim") {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_REQUIRES_AGORA_AND_WINERIM");
  }
  for (const credential of credentials) {
    if (!/^[a-f0-9]{24}$/.test(credential.nonceHex)) {
      throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_NONCE_HEX");
    }
    if (!/^[a-f0-9]{34,32768}$/.test(credential.ciphertextHex)) {
      throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_CIPHERTEXT_HEX");
    }
    if (!/^[a-f0-9]{64}$/.test(credential.attestationSha256)) {
      throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_ATTESTATION_SHA256");
    }
  }

  const values = [...credentials]
    .sort((left, right) => left.kind.localeCompare(right.kind))
    .map((credential) => `(
    '${connectionId}'::uuid,
    'agora',
    '${credential.kind}',
    '${runId}',
    'AES-256-GCM',
    '${keyVersion}',
    1,
    decode('${credential.ciphertextHex}', 'hex'),
    decode('${credential.nonceHex}', 'hex'),
    '${credential.attestationSha256}',
    false
  )`).join(",\n  ");

  const scopeGenerationMode = mode === "adopt-existing" ? "bootstrap" : mode;
  const scopeNote = mode === "adopt-existing"
    ? `adopt-existing:v3:${adoption.bindingSha256}`
    : `rescue-canary-run:${runId}`;
  const adoptionSql = mode === "adopt-existing" ? `
  IF (
    SELECT count(*) FROM public.sales_events
    WHERE connection_id = '${connectionId}'::uuid
  ) <> ${adoption.watermarks.salesEvents} THEN
    RAISE EXCEPTION 'adopt-existing sales event watermark mismatch';
  END IF;
  IF (
    SELECT count(*) FROM public.sales_line_items
    WHERE connection_id = '${connectionId}'::uuid
  ) <> ${adoption.watermarks.salesLineItems} THEN
    RAISE EXCEPTION 'adopt-existing sales line watermark mismatch';
  END IF;
  IF COALESCE((
    SELECT max(business_day)::text FROM public.sales_events
    WHERE connection_id = '${connectionId}'::uuid
  ), '') <> '${adoption.watermarks.maxBusinessDay}' THEN
    RAISE EXCEPTION 'adopt-existing sales day watermark mismatch';
  END IF;
  IF COALESCE((
    SELECT last_business_day_synced::text FROM public.pos_connections
    WHERE id = '${connectionId}'::uuid
  ), '') <> '${adoption.watermarks.lastBusinessDaySynced}' THEN
    RAISE EXCEPTION 'adopt-existing cursor day watermark mismatch';
  END IF;
  IF COALESCE((
    SELECT to_char(last_sync_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    FROM public.pos_connections
    WHERE id = '${connectionId}'::uuid
  ), '') <> '${adoption.watermarks.lastSyncAt}' THEN
    RAISE EXCEPTION 'adopt-existing sync timestamp watermark mismatch';
  END IF;
` : "";

  return `BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20s';
SELECT pg_advisory_xact_lock(hashtextextended('runtime-canary-control-plane', 0));

LOCK TABLE public.pos_connections,
  public.runtime_canary_connections,
  public.runtime_connection_credentials
  IN SHARE ROW EXCLUSIVE MODE;

DO $provision_runtime_credentials$
DECLARE
  candidate_count integer;
  existing_credentials integer;
  incomplete_versions integer;
  existing_run_rows integer;
  active_scopes integer;
  active_credentials integer;
  operational_rows integer;
BEGIN
  SELECT count(*) INTO candidate_count
  FROM public.pos_connections
  WHERE id = '${connectionId}'::uuid
    AND provider = 'agora'
    AND enabled = false
    AND catalog_sync_enabled = false
    AND sync_mode = 'PULL_ONLY'
    AND write_mode = 'NONE'
    AND backfill_days = 0;
  IF candidate_count <> 1 THEN
    RAISE EXCEPTION 'credential candidate is missing or not inert';
  END IF;

  SELECT count(*) INTO existing_credentials
  FROM public.runtime_connection_credentials
  WHERE connection_id = '${connectionId}'::uuid;
  SELECT count(*) INTO existing_run_rows
  FROM public.runtime_connection_credentials
  WHERE connection_id = '${connectionId}'::uuid
    AND run_id = '${runId}';
  IF existing_run_rows <> 0 OR EXISTS (
    SELECT 1 FROM public.runtime_canary_connections WHERE run_id = '${runId}'
  ) THEN
    RAISE EXCEPTION 'requested canary run already exists';
  END IF;
  IF '${mode}' = 'bootstrap' AND existing_credentials <> 0 THEN
    RAISE EXCEPTION 'credential vault is not empty; use versioned rotate mode';
  END IF;
  IF '${mode}' IN ('rotate', 'adopt-existing') AND existing_credentials <> 0 THEN
    IF existing_credentials < 2 THEN
      RAISE EXCEPTION 'credential rotation requires a complete retired generation';
    END IF;
    SELECT count(*) INTO incomplete_versions
    FROM (
      SELECT credentials.run_id
      FROM public.runtime_connection_credentials credentials
      LEFT JOIN public.runtime_canary_connections scope
        ON scope.connection_id = credentials.connection_id
       AND scope.run_id = credentials.run_id
      WHERE credentials.connection_id = '${connectionId}'::uuid
      GROUP BY credentials.run_id, scope.status, scope.active, scope.retired_at
      HAVING count(*) <> 2
        OR count(DISTINCT credentials.credential_kind) <> 2
        OR bool_or(credentials.active)
        OR scope.status IS NULL
        OR scope.status NOT IN ('RETIRED', 'ABORTED')
        OR scope.active IS DISTINCT FROM false
        OR scope.retired_at IS NULL
    ) invalid_generation;
    IF incomplete_versions <> 0 THEN
      RAISE EXCEPTION 'credential history is incomplete or still active';
    END IF;
  END IF;
${adoptionSql}

  SELECT count(*) INTO active_scopes
  FROM public.runtime_canary_connections
  WHERE connection_id = '${connectionId}'::uuid
    AND active = true;
  SELECT count(*) INTO active_credentials
  FROM public.runtime_connection_credentials
  WHERE connection_id = '${connectionId}'::uuid
    AND active = true;
  IF active_scopes <> 0 OR active_credentials <> 0 THEN
    RAISE EXCEPTION 'runtime canary or credential is already active for connection';
  END IF;

  IF '${mode}' = 'bootstrap' THEN
    SELECT
      (SELECT count(*) FROM public.sales_events WHERE connection_id = '${connectionId}'::uuid)
      + (SELECT count(*) FROM public.sales_line_items WHERE connection_id = '${connectionId}'::uuid)
      + (SELECT count(*) FROM public.stock_sync_log WHERE connection_id = '${connectionId}'::uuid)
      + (SELECT count(*) FROM public.outbound_tasks WHERE connection_id = '${connectionId}'::uuid)
      + (SELECT count(*) FROM public.runtime_execution_log WHERE connection_id = '${connectionId}'::uuid)
      + (SELECT count(*) FROM public.runtime_idempotency WHERE connection_id = '${connectionId}'::uuid)
    INTO operational_rows;
    IF operational_rows <> 0 THEN
      RAISE EXCEPTION 'credential bootstrap candidate has operational rows';
    END IF;
  END IF;
END;
$provision_runtime_credentials$;

INSERT INTO public.runtime_canary_connections (
  connection_id, run_id, generation_mode, active, note, status
) VALUES (
  '${connectionId}'::uuid,
  '${runId}',
  '${scopeGenerationMode}',
  false,
  '${scopeNote}',
  'PREPARED'
);

INSERT INTO public.runtime_connection_credentials (
  connection_id,
  provider,
  credential_kind,
  run_id,
  algorithm,
  key_version,
  aad_version,
  ciphertext,
  nonce,
  attestation_sha256,
  active
) VALUES
  ${values};

DO $verify_runtime_credentials$
BEGIN
  IF (
    SELECT count(*)
    FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND active = false
      AND key_version = '${keyVersion}'
      AND credential_kind IN ('agora', 'winerim')
  ) <> 2 THEN
    RAISE EXCEPTION 'inactive credential readback failed';
  END IF;
  IF (
    SELECT count(*)
    FROM public.runtime_canary_connections
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND generation_mode = '${scopeGenerationMode}'
      AND note = '${scopeNote}'
      AND status = 'PREPARED'
      AND active = false
  ) <> 1 THEN
    RAISE EXCEPTION 'prepared canary scope readback failed';
  END IF;
END;
$verify_runtime_credentials$;

COMMIT;
`;
}

export function credentialProvisioningPlan() {
  return {
    status: "RUNTIME_CREDENTIAL_PROVISION_PLAN_ONLY",
    remoteMutations: 0,
    writesPlaintext: false,
    insertsActiveCredentials: false,
    requiredEnvironment: [
      "CANARY_CONNECTION_ID",
      "CANARY_RUN_ID",
      "RUNTIME_VAULT_KEY_VERSION",
      "RUNTIME_VAULT_MASTER_KEY",
      "RUNTIME_AGORA_CREDENTIAL",
      "RUNTIME_WINERIM_CREDENTIAL",
    ],
    modes: {
      bootstrap: "requires no prior credential rows and no operational rows",
      rotate: "requires complete inactive historical generations and preserves them",
      "adopt-existing": "requires exact export/reconciliation hashes and exact imported sales/cursor watermarks",
    },
    adoptExistingEnvironment: [
      "RUNTIME_ADOPT_EXPORT_MANIFEST",
      "RUNTIME_ADOPT_EXPORT_MANIFEST_SHA256",
      "RUNTIME_ADOPT_TARGET_MANIFEST",
      "RUNTIME_ADOPT_TARGET_MANIFEST_SHA256",
      "RUNTIME_ADOPT_RECONCILIATION_MANIFEST",
      "RUNTIME_ADOPT_RECONCILIATION_MANIFEST_SHA256",
    ],
    renderGate: "--render --mode=<bootstrap|rotate|adopt-existing> --confirm-connection=<UUID> --output=/secure/path/credentials.sql",
  };
}

export function prepareCredentialProvisioning({ environment = process.env, output, mode = "bootstrap" }) {
  const connectionId = required(environment, "CANARY_CONNECTION_ID");
  const runId = required(environment, "CANARY_RUN_ID");
  const keyVersion = required(environment, "RUNTIME_VAULT_KEY_VERSION");
  if (!UUID_PATTERN.test(connectionId)) throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_CONNECTION_ID");
  if (!RUN_PATTERN.test(runId)) throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_RUN_ID");
  if (!KEY_VERSION_PATTERN.test(keyVersion)) throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_KEY_VERSION");
  let adoption;
  if (mode === "adopt-existing") {
    const exportManifestSource = readFileSync(required(environment, "RUNTIME_ADOPT_EXPORT_MANIFEST"));
    const targetManifestSource = readFileSync(required(environment, "RUNTIME_ADOPT_TARGET_MANIFEST"));
    const reconciliationManifestSource = readFileSync(
      required(environment, "RUNTIME_ADOPT_RECONCILIATION_MANIFEST"),
    );
    adoption = validateAdoptExistingEvidence({
      connectionId,
      exportManifestSource,
      exportManifestSha256: required(environment, "RUNTIME_ADOPT_EXPORT_MANIFEST_SHA256"),
      targetManifestSource,
      targetManifestSha256: required(environment, "RUNTIME_ADOPT_TARGET_MANIFEST_SHA256"),
      reconciliationManifestSource,
      reconciliationManifestSha256: required(
        environment,
        "RUNTIME_ADOPT_RECONCILIATION_MANIFEST_SHA256",
      ),
    });
  }
  const masterKey = decodeMasterKey(required(environment, "RUNTIME_VAULT_MASTER_KEY"));
  let credentials;
  try {
    credentials = [
      encryptRuntimeCredential({
        connectionId,
        kind: "agora",
        keyVersion,
        plaintext: required(environment, "RUNTIME_AGORA_CREDENTIAL"),
        masterKey,
      }),
      encryptRuntimeCredential({
        connectionId,
        kind: "winerim",
        keyVersion,
        plaintext: required(environment, "RUNTIME_WINERIM_CREDENTIAL"),
        masterKey,
      }),
    ];
  } finally {
    masterKey.fill(0);
  }

  const target = resolve(output);
  const relativeTarget = relative(repoRoot, target);
  if (relativeTarget === "" || (!relativeTarget.startsWith("..") && !relativeTarget.startsWith("/"))) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const realParent = realpathSync(dirname(target));
  const realRelativeParent = relative(repoRoot, realParent);
  if (
    realRelativeParent === ""
    || (!realRelativeParent.startsWith("..") && !realRelativeParent.startsWith("/"))
  ) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  const sql = renderCredentialProvisioningSql({ connectionId, runId, keyVersion, credentials, mode, adoption });
  writeFileSync(target, sql, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(target, 0o600);
  const artifactSha256 = createHash("sha256").update(sql).digest("hex");
  const credentialAttestations = Object.fromEntries(
    credentials.map(({ kind, attestationSha256 }) => [kind, attestationSha256]),
  );
  const credentialSetSha256 = runtimeCredentialSetSha256({ connectionId, runId, keyVersion, credentials });
  const manifestPath = `${target}.manifest.json`;
  const manifestSource = `${JSON.stringify({
    version: mode === "adopt-existing" ? 3 : 1,
    connectionId,
    runId,
    keyVersion,
    mode,
    active: false,
    sqlSha256: artifactSha256,
    credentialAttestations,
    credentialSetSha256,
    ...(adoption ? {
      adoption,
      scopeGenerationMode: "bootstrap",
      activationAllowed: false,
      activationBlockReason: "ADOPT_EXISTING_ACTIVATION_REQUIRES_SEPARATE_REVIEWED_GATE",
    } : {}),
  }, null, 2)}\n`;
  writeFileSync(manifestPath, manifestSource, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(manifestPath, 0o600);
  return {
    status: "RUNTIME_CREDENTIAL_PROVISION_ARTIFACT_READY",
    remoteMutations: 0,
    connectionId,
    runId,
    keyVersion,
    mode,
    active: false,
    activationAllowed: false,
    output: target,
    artifactSha256,
    credentialAttestations,
    credentialSetSha256,
    manifestPath,
    manifestSha256: createHash("sha256").update(manifestSource).digest("hex"),
  };
}

function argument(name) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function main() {
  if (!process.argv.includes("--render")) {
    process.stdout.write(`${JSON.stringify(credentialProvisioningPlan(), null, 2)}\n`);
    return;
  }
  const connectionId = required(process.env, "CANARY_CONNECTION_ID");
  if (argument("--confirm-connection") !== connectionId) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_CONNECTION_CONFIRMATION_REQUIRED");
  }
  const output = argument("--output");
  if (!output) throw new Error("RUNTIME_CREDENTIAL_PROVISION_OUTPUT_REQUIRED");
  const mode = argument("--mode") ?? "bootstrap";
  const result = prepareCredentialProvisioning({ output, mode });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
