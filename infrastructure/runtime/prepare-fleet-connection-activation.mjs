import { createHash, createHmac, createPublicKey, verify } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_APPROVAL_WINDOW_MS = 2 * 60 * 60 * 1_000;
const MAX_FENCE_EVIDENCE_AGE_MS = 15 * 60 * 1_000;
const MIN_WRITER_DRAIN_MS = 130 * 1_000;
const MIN_EXTERNAL_READBACK_SEPARATION_MS = 5 * 1_000;
const REQUIRED_SALES_JOBS = ["sales.auto-sync", "sales.sync-intraday"];
const REQUIRED_DEPLOYMENT_COMPONENTS = ["runtime", "executor", "writerFence"];
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;
const FENCED_TARGET_RAW_SCHEMA_VERSION = 2;
const FENCED_TARGET_RAW_KIND = "target-raw-corrected";
const FENCED_TARGET_RAW_TABLES = [
  "sales_events",
  "sales_line_items",
  "stock_sync_log",
  "product_mappings",
];
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

function required(environment, name) {
  const value = String(environment[name] ?? "").trim();
  if (!value) throw new Error(`RUNTIME_FLEET_ADOPT_ACTIVATION_MISSING_${name}`);
  return value;
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_${label}`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_${label}_STRUCTURE`);
  }
}

function canonicalTimestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_${label}`);
  }
  return { milliseconds: parsed, iso: new Date(parsed).toISOString() };
}

function canonicalDate(value, label) {
  if (!DATE_PATTERN.test(value ?? "")) {
    throw new Error(`RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_${label}`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_${label}`);
  }
  return value;
}

function cursorLagDays(maxBusinessDay, lastBusinessDaySynced) {
  return (
    Date.parse(`${maxBusinessDay}T00:00:00.000Z`)
    - Date.parse(`${lastBusinessDaySynced}T00:00:00.000Z`)
  ) / ONE_DAY_MS;
}

function validateIntradayCursor(maxBusinessDay, lastBusinessDaySynced) {
  const lagDays = cursorLagDays(maxBusinessDay, lastBusinessDaySynced);
  if (!Number.isInteger(lagDays) || lagDays < 0) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_CURSOR_AHEAD_OF_HISTORY");
  }
  if (lagDays > 1) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_CURSOR_BEHIND_HISTORY");
  }
  return lagDays;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_${label}`);
  }
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_${label}`);
  }
  return value;
}

function isOutsideRepository(path) {
  const candidate = relative(repoRoot, path);
  return candidate !== "" && (candidate.startsWith("..") || candidate.startsWith("/"));
}

function readPrivateFile(path, expectedSha256, label) {
  if (!isAbsolute(path)) {
    throw new Error(`RUNTIME_FLEET_ADOPT_ACTIVATION_${label}_PATH_MUST_BE_ABSOLUTE`);
  }
  if (!SHA256_PATTERN.test(expectedSha256 ?? "")) {
    throw new Error(`RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_${label}_SHA256`);
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`RUNTIME_FLEET_ADOPT_ACTIVATION_${label}_MUST_BE_REGULAR_FILE`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`RUNTIME_FLEET_ADOPT_ACTIVATION_${label}_MUST_BE_PRIVATE_0600`);
  }
  if (metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) {
    throw new Error(`RUNTIME_FLEET_ADOPT_ACTIVATION_${label}_INVALID_SIZE`);
  }
  const source = readFileSync(path);
  if (sha256(source) !== expectedSha256) {
    throw new Error(`RUNTIME_FLEET_ADOPT_ACTIVATION_${label}_SHA256_MISMATCH`);
  }
  return source;
}

function parseJson(source, label) {
  try {
    return JSON.parse(Buffer.from(source).toString("utf8"));
  } catch {
    throw new Error(`RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_${label}_JSON`);
  }
}

function artifactReference(value, label) {
  exactKeys(value, ["path", "sha256"], label);
  const path = String(value.path ?? "").trim();
  const digest = String(value.sha256 ?? "").trim().toLowerCase();
  if (!isAbsolute(path)) {
    throw new Error(`RUNTIME_FLEET_ADOPT_ACTIVATION_${label}_PATH_MUST_BE_ABSOLUTE`);
  }
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error(`RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_${label}_SHA256`);
  }
  return { path, sha256: digest };
}

function adoptionBindingSha256(adoption) {
  return sha256([
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
  ].join("|"));
}

function credentialSetSha256({ connectionId, runId, keyVersion, attestations }) {
  return sha256([
    "winerim-runtime-credential-set",
    "1",
    connectionId,
    runId,
    keyVersion,
    attestations.agora,
    attestations.winerim,
  ].join("|"));
}

function fleetCredentialReference(connectionId, kind) {
  return `runtime-vault://postgres/${connectionId}/agora/${kind}`;
}

function fleetCredentialBinding({ connectionId, runId, kind, version }) {
  return sha256([
    "winerim-writer-fence-fleet-credential",
    "1",
    connectionId,
    runId,
    "agora",
    kind,
    fleetCredentialReference(connectionId, kind),
    version,
  ].join("|"));
}

function runtimePolicySha256(providerConfig) {
  return sha256(canonicalJson(providerConfig));
}

function validateProviderConfig(providerConfig) {
  exactKeys(providerConfig, [
    "runtime_sales_job_allowlist",
    "intraday_sales_sync_enabled",
    "open_tickets_sync_enabled",
    "open_tickets_stock_sync_enabled",
  ], "PROVIDER_CONFIG");
  if (
    canonicalJson(providerConfig.runtime_sales_job_allowlist) !== canonicalJson(REQUIRED_SALES_JOBS)
    || providerConfig.intraday_sales_sync_enabled !== true
    || providerConfig.open_tickets_sync_enabled !== false
    || providerConfig.open_tickets_stock_sync_enabled !== false
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_SALES_ALLOWLIST");
  }
  return {
    runtime_sales_job_allowlist: [...REQUIRED_SALES_JOBS],
    intraday_sales_sync_enabled: true,
    open_tickets_sync_enabled: false,
    open_tickets_stock_sync_enabled: false,
  };
}

function validateProviderConfigSnapshot(providerConfigSnapshot) {
  if (
    !providerConfigSnapshot
    || typeof providerConfigSnapshot !== "object"
    || Array.isArray(providerConfigSnapshot)
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_PROVIDER_CONFIG_SNAPSHOT");
  }
  return JSON.parse(canonicalJson(providerConfigSnapshot));
}

function validateDeploymentManifest(manifest) {
  exactKeys(manifest, [
    "version",
    "kind",
    "deploymentId",
    "jobs",
    "components",
  ], "DEPLOYMENT_MANIFEST");
  if (
    manifest.version !== 1
    || manifest.kind !== "runtime-sales-deployment"
    || !IDENTIFIER_PATTERN.test(manifest.deploymentId ?? "")
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_DEPLOYMENT_MANIFEST");
  }
  if (canonicalJson(manifest.jobs) !== canonicalJson(REQUIRED_SALES_JOBS)) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_DEPLOYMENT_JOBS");
  }
  exactKeys(manifest.components, REQUIRED_DEPLOYMENT_COMPONENTS, "DEPLOYMENT_COMPONENTS");
  const components = {};
  for (const componentName of REQUIRED_DEPLOYMENT_COMPONENTS) {
    const component = manifest.components[componentName];
    exactKeys(
      component,
      ["workerName", "versionId", "configSha256"],
      `DEPLOYMENT_COMPONENT_${componentName.toUpperCase()}`,
    );
    if (
      !IDENTIFIER_PATTERN.test(component.workerName ?? "")
      || !UUID_PATTERN.test(component.versionId ?? "")
      || !SHA256_PATTERN.test(component.configSha256 ?? "")
    ) {
      throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_DEPLOYMENT_COMPONENT");
    }
    components[componentName] = {
      workerName: component.workerName,
      versionId: component.versionId.toLowerCase(),
      configSha256: component.configSha256,
    };
  }
  return {
    version: 1,
    kind: "runtime-sales-deployment",
    deploymentId: manifest.deploymentId,
    jobs: [...REQUIRED_SALES_JOBS],
    components,
  };
}

function validateExternalWriterFenceEvidence({
  artifactSource,
  artifactSha256,
  publicKeySource,
  publicKeySha256,
  connectionId,
  approvedAt,
}) {
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(artifactSource).toString("utf8"));
  } catch {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_EXTERNAL_EVIDENCE_INVALID_JSON");
  }
  if (
    envelope?.version !== 1
    || envelope?.algorithm !== "Ed25519"
    || !IDENTIFIER_PATTERN.test(envelope?.keyId ?? "")
    || typeof envelope?.payload !== "object"
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope?.signatureBase64 ?? "")
    || sha256(Buffer.from(envelope.publicKeyPem ?? "")) !== publicKeySha256
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_EXTERNAL_EVIDENCE_INVALID_ENVELOPE");
  }
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeySource);
  } catch {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_EXTERNAL_PUBLIC_KEY_INVALID");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_EXTERNAL_PUBLIC_KEY_MUST_BE_ED25519");
  }
  const payloadSource = Buffer.from(JSON.stringify(envelope.payload));
  const signature = Buffer.from(envelope.signatureBase64, "base64");
  if (
    !verify(null, payloadSource, publicKey, signature)
    || !SHA256_PATTERN.test(envelope.hashes?.readbacksSourceSha256 ?? "")
    || envelope.hashes?.publicKeySha256 !== publicKeySha256
    || envelope.hashes?.payloadSha256 !== sha256(payloadSource)
    || envelope.hashes?.signatureSha256 !== sha256(signature)
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_EXTERNAL_EVIDENCE_SIGNATURE_INVALID");
  }
  const payload = envelope.payload;
  if (
    payload?.evidenceType !== "lovable-writer-fence"
    || payload.connectionId !== connectionId
    || payload.source?.provider !== "lovable-cloud"
    || !UUID_PATTERN.test(payload.source?.projectId ?? "")
    || !IDENTIFIER_PATTERN.test(payload.source?.collectorRunId ?? "")
    || payload.fenceMode !== "lovable-disabled-no-agora-rotation"
    || payload.lovable?.writerDisabled !== true
    || payload.lovable?.cronDisabled !== true
    || payload.lovable?.edgeMutationDisabled !== true
    || payload.agoraCredential?.rotated !== false
    || payload.agoraCredential?.removedFromLovable !== true
    || !Array.isArray(payload.readbacks)
    || payload.readbacks.length !== 2
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_EXTERNAL_EVIDENCE_SCOPE_MISMATCH");
  }
  const fenceAppliedAt = canonicalTimestamp(payload.fenceAppliedAt, "EXTERNAL_FENCE_APPLIED_AT");
  const observedAt = canonicalTimestamp(payload.observedAt, "EXTERNAL_EVIDENCE_OBSERVED_AT");
  const readbackTimes = payload.readbacks.map((readback, index) => {
    if (
      readback?.status !== "FENCED_HEALTHY"
      || readback.writerDisabled !== true
      || readback.cronDisabled !== true
      || readback.edgeMutationDisabled !== true
      || readback.agoraCredentialUnavailableToLovable !== true
    ) {
      throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_EXTERNAL_READBACK_NOT_HEALTHY");
    }
    return canonicalTimestamp(readback.observedAt, `EXTERNAL_READBACK_${index + 1}`).milliseconds;
  });
  if (
    readbackTimes[0] < fenceAppliedAt.milliseconds + MIN_WRITER_DRAIN_MS
    || readbackTimes[1] - readbackTimes[0] < MIN_EXTERNAL_READBACK_SEPARATION_MS
    || readbackTimes[1] !== observedAt.milliseconds
    || observedAt.milliseconds > approvedAt.milliseconds
    || approvedAt.milliseconds - observedAt.milliseconds > MAX_FENCE_EVIDENCE_AGE_MS
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_EXTERNAL_READBACK_WINDOW_MISMATCH");
  }
  return {
    artifactSha256,
    publicKeySha256,
    payloadSha256: sha256(payloadSource),
    signatureSha256: sha256(signature),
    keyId: envelope.keyId,
    projectId: payload.source.projectId,
    collectorRunId: payload.source.collectorRunId,
    fenceMode: payload.fenceMode,
    fenceAppliedAt: fenceAppliedAt.iso,
    observedAt: observedAt.iso,
    readbackObservedAt: readbackTimes.map((value) => new Date(value).toISOString()),
    removedFromLovable: true,
  };
}

function validateCredentialProvisioningManifest(manifest, { connectionId, runId, keyVersion }) {
  const adoption = manifest?.adoption;
  const attestations = manifest?.credentialAttestations;
  if (
    manifest?.version !== 3
    || manifest.connectionId !== connectionId
    || manifest.runId !== runId
    || manifest.keyVersion !== keyVersion
    || manifest.mode !== "adopt-existing"
    || manifest.active !== false
    || manifest.scopeGenerationMode !== "bootstrap"
    || manifest.activationAllowed !== false
    || manifest.activationBlockReason !== "ADOPT_EXISTING_ACTIVATION_REQUIRES_SEPARATE_REVIEWED_GATE"
    || !SHA256_PATTERN.test(manifest.sqlSha256 ?? "")
    || !SHA256_PATTERN.test(manifest.credentialSetSha256 ?? "")
    || !SHA256_PATTERN.test(attestations?.agora ?? "")
    || !SHA256_PATTERN.test(attestations?.winerim ?? "")
    || adoption?.version !== 3
    || adoption?.kind !== "AGORA_SHADOW_RECONCILIATION_EVIDENCE"
    || adoption?.schemaVersion !== "agora-shadow-v2"
    || adoption?.connectionId !== connectionId
    || adoption?.reconciliationStatus !== "RECONCILED_EXACT"
    || !SHA256_PATTERN.test(adoption?.exportManifestSha256 ?? "")
    || !SHA256_PATTERN.test(adoption?.reconciliationManifestSha256 ?? "")
    || !SHA256_PATTERN.test(adoption?.reconciliationReportSha256 ?? "")
    || !SHA256_PATTERN.test(adoption?.sourceDatasetSha256 ?? "")
    || !SHA256_PATTERN.test(adoption?.targetDatasetSha256 ?? "")
    || adoption.sourceDatasetSha256 === adoption.targetDatasetSha256
    || !SHA256_PATTERN.test(adoption?.bindingSha256 ?? "")
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_CREDENTIAL_MANIFEST_SCOPE_MISMATCH");
  }
  positiveInteger(adoption.watermarks?.salesEvents, "ADOPTION_SALES_EVENTS");
  positiveInteger(adoption.watermarks?.salesLineItems, "ADOPTION_SALES_LINE_ITEMS");
  const maxBusinessDay = canonicalDate(
    adoption.watermarks?.maxBusinessDay,
    "ADOPTION_MAX_BUSINESS_DAY",
  );
  const lastBusinessDaySynced = canonicalDate(
    adoption.watermarks?.lastBusinessDaySynced,
    "ADOPTION_CURSOR_DAY",
  );
  const lastSyncAt = canonicalTimestamp(adoption.watermarks?.lastSyncAt, "ADOPTION_LAST_SYNC_AT").iso;
  const cursorLagDays = validateIntradayCursor(maxBusinessDay, lastBusinessDaySynced);
  if (adoptionBindingSha256(adoption) !== adoption.bindingSha256) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_ADOPTION_BINDING_MISMATCH");
  }
  const recomputedCredentialSet = credentialSetSha256({ connectionId, runId, keyVersion, attestations });
  if (manifest.credentialSetSha256 !== recomputedCredentialSet) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_CREDENTIAL_SET_SHA256_MISMATCH");
  }
  return {
    adoption: {
      ...adoption,
      watermarks: {
        ...adoption.watermarks,
        maxBusinessDay,
        lastBusinessDaySynced,
        lastSyncAt,
        cursorLagDays,
      },
    },
    attestations: { agora: attestations.agora, winerim: attestations.winerim },
    credentialSetSha256: recomputedCredentialSet,
  };
}

function validateCounts(counts, label, { requireHistory = false } = {}) {
  exactKeys(counts, ["events", "lines", "receipts", "mappings"], label);
  const events = requireHistory
    ? positiveInteger(counts.events, `${label}_EVENTS`)
    : nonnegativeInteger(counts.events, `${label}_EVENTS`);
  const lines = requireHistory
    ? positiveInteger(counts.lines, `${label}_LINES`)
    : nonnegativeInteger(counts.lines, `${label}_LINES`);
  return {
    events,
    lines,
    receipts: nonnegativeInteger(counts.receipts, `${label}_RECEIPTS`),
    mappings: nonnegativeInteger(counts.mappings, `${label}_MAPPINGS`),
  };
}

function validateFencedTargetRawV1(raw, { connectionId, adoption }) {
  exactKeys(raw, [
    "schemaVersion",
    "kind",
    "connectionId",
    "target",
    "window",
    "capturedAt",
    "marker",
    "tables",
  ], "FENCED_TARGET_RAW_V1");
  if (
    raw.schemaVersion !== FENCED_TARGET_RAW_SCHEMA_VERSION
    || raw.kind !== FENCED_TARGET_RAW_KIND
    || raw.connectionId !== connectionId
    || !IDENTIFIER_PATTERN.test(raw.target ?? "")
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_FENCED_TARGET_RAW_V1");
  }
  const capturedAt = canonicalTimestamp(raw.capturedAt, "FENCED_TARGET_RAW_CAPTURED_AT").iso;
  exactKeys(raw.window, ["fromBusinessDay", "throughBusinessDay"], "FENCED_TARGET_RAW_WINDOW");
  const fromBusinessDay = canonicalDate(
    raw.window.fromBusinessDay,
    "FENCED_TARGET_RAW_FROM_BUSINESS_DAY",
  );
  const throughBusinessDay = canonicalDate(
    raw.window.throughBusinessDay,
    "FENCED_TARGET_RAW_THROUGH_BUSINESS_DAY",
  );
  if (fromBusinessDay > throughBusinessDay) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_FENCED_TARGET_RAW_WINDOW");
  }
  exactKeys(raw.tables, FENCED_TARGET_RAW_TABLES, "FENCED_TARGET_RAW_TABLES");
  for (const table of FENCED_TARGET_RAW_TABLES) {
    if (!Array.isArray(raw.tables[table])) {
      throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_FENCED_TARGET_RAW_TABLES");
    }
    for (const row of raw.tables[table]) {
      if (!row || typeof row !== "object" || Array.isArray(row) || row.connection_id !== connectionId) {
        throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_FENCED_TARGET_RAW_CONNECTION_MISMATCH");
      }
    }
  }
  const counts = {
    events: raw.tables.sales_events.length,
    lines: raw.tables.sales_line_items.length,
    receipts: raw.tables.stock_sync_log.length,
    mappings: raw.tables.product_mappings.length,
  };
  validateCounts(counts, "FENCED_TARGET_RAW_COUNTS", { requireHistory: true });
  const businessDays = raw.tables.sales_events.map((event) => (
    canonicalDate(event.business_day, "FENCED_TARGET_RAW_EVENT_BUSINESS_DAY")
  ));
  const maxBusinessDay = businessDays.reduce(
    (latest, current) => current > latest ? current : latest,
    businessDays[0],
  );
  if (
    maxBusinessDay !== adoption.watermarks.maxBusinessDay
    || throughBusinessDay !== adoption.watermarks.maxBusinessDay
    || counts.events !== adoption.watermarks.salesEvents
    || counts.lines !== adoption.watermarks.salesLineItems
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_FENCED_TARGET_RAW_WATERMARK_MISMATCH");
  }
  if (!Array.isArray(raw.marker) || raw.marker.length !== 1) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_FENCED_TARGET_RAW_MARKER_MISMATCH");
  }
  const marker = raw.marker[0];
  exactKeys(marker, [
    "id",
    "provider",
    "enabled",
    "catalog_sync_enabled",
    "write_mode",
    "last_business_day_synced",
    "last_sync_at",
    "updated_at",
    "provider_config",
  ], "FENCED_TARGET_RAW_MARKER");
  if (
    marker.id !== connectionId
    || marker.provider !== "agora"
    || marker.enabled !== false
    || marker.catalog_sync_enabled !== false
    || marker.write_mode !== "NONE"
    || !marker.provider_config
    || typeof marker.provider_config !== "object"
    || Array.isArray(marker.provider_config)
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_FENCED_TARGET_RAW_MARKER_MISMATCH");
  }
  const cursorDay = canonicalDate(
    marker.last_business_day_synced,
    "FENCED_TARGET_RAW_CURSOR_DAY",
  );
  const cursorSync = canonicalTimestamp(
    marker.last_sync_at,
    "FENCED_TARGET_RAW_CURSOR_SYNC",
  ).iso;
  canonicalTimestamp(marker.updated_at, "FENCED_TARGET_RAW_MARKER_UPDATED_AT");
  if (
    cursorDay !== adoption.watermarks.lastBusinessDaySynced
    || cursorSync !== adoption.watermarks.lastSyncAt
    || validateIntradayCursor(maxBusinessDay, cursorDay) !== adoption.watermarks.cursorLagDays
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_FENCED_TARGET_RAW_CURSOR_MISMATCH");
  }
  return {
    contract: "fenced-target-raw-v1",
    schemaVersion: raw.schemaVersion,
    kind: raw.kind,
    target: raw.target,
    capturedAt,
    window: { fromBusinessDay, throughBusinessDay },
    counts,
    maxBusinessDay,
    cursorDay,
    cursorSync,
    providerConfig: JSON.parse(canonicalJson(marker.provider_config)),
  };
}

function validateFinalDeltaManifest(manifest, { connectionId, adoption, finalTargetRaw }) {
  if (
    manifest?.schemaVersion !== 2
    || manifest?.kind !== "fenced-connection-final-delta"
    || manifest.connectionId !== connectionId
    || !SHA256_PATTERN.test(manifest.sourceSha256 ?? "")
    || !SHA256_PATTERN.test(manifest.targetRawSha256 ?? "")
    || !SHA256_PATTERN.test(manifest.targetCorrectedShadowSha256 ?? "")
    || !SHA256_PATTERN.test(manifest.applySha256 ?? "")
    || !SHA256_PATTERN.test(manifest.rollbackSha256 ?? "")
    || !SHA256_PATTERN.test(manifest.readbackSha256 ?? "")
    || manifest.remoteWrites !== 0
    || manifest.sourceFence?.minimumDrainMs < MIN_WRITER_DRAIN_MS
    || manifest.sourceFence?.expectedControlState !== true
    || manifest.sourceFence?.stable !== true
    || manifest.expected?.businessDayChanges !== 0
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_FINAL_DELTA_MANIFEST");
  }
  const before = validateCounts(manifest.expected.before, "FINAL_DELTA_BEFORE");
  const after = validateCounts(manifest.expected.after, "FINAL_DELTA_AFTER", { requireHistory: true });
  const delta = validateCounts(manifest.delta, "FINAL_DELTA_DELTA");
  for (const key of ["events", "lines", "receipts", "mappings"]) {
    if (before[key] + delta[key] !== after[key]) {
      throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_FINAL_DELTA_ARITHMETIC_MISMATCH");
    }
  }
  const markerBefore = manifest.sourceFence.markerBefore;
  const markerAfter = manifest.sourceFence.markerAfter;
  if (!Array.isArray(markerBefore) || markerBefore.length !== 1 || !Array.isArray(markerAfter) || markerAfter.length !== 1) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_FINAL_DELTA_FENCE_MARKER_MISMATCH");
  }
  for (const marker of [markerBefore[0], markerAfter[0]]) {
    if (
      marker?.id !== connectionId
      || marker.provider !== "agora"
      || marker.enabled !== false
      || marker.catalog_sync_enabled !== false
      || marker.scheduler?.intraday_sales_sync_enabled !== false
      || marker.scheduler?.open_tickets_stock_sync_enabled !== false
      || marker.scheduler?.open_tickets_sync_enabled !== false
    ) {
      throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_FINAL_DELTA_FENCE_MARKER_MISMATCH");
    }
  }
  const cursorDay = canonicalDate(manifest.cursor?.after?.day, "FINAL_DELTA_CURSOR_DAY");
  const cursorSync = canonicalTimestamp(manifest.cursor?.after?.sync, "FINAL_DELTA_CURSOR_SYNC").iso;
  if (
    after.events !== adoption.watermarks.salesEvents
    || after.lines !== adoption.watermarks.salesLineItems
    || cursorDay !== adoption.watermarks.lastBusinessDaySynced
    || cursorSync !== adoption.watermarks.lastSyncAt
    || canonicalJson(after) !== canonicalJson(finalTargetRaw.counts)
    || cursorDay !== finalTargetRaw.cursorDay
    || cursorSync !== finalTargetRaw.cursorSync
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_FINAL_DELTA_WATERMARK_MISMATCH");
  }
  return {
    before,
    after,
    delta,
    cursorDay,
    cursorSync,
    targetCorrectedShadowSha256: manifest.targetCorrectedShadowSha256,
    adoptionTargetDatasetSha256: adoption.targetDatasetSha256,
    semanticLineage: manifest.targetCorrectedShadowSha256 === adoption.targetDatasetSha256
      ? "ADOPTION_TARGET_UNCHANGED"
      : "FINAL_DELTA_CORRECTED_SUCCESSOR",
  };
}

function validateFinalReconciliation(manifest, {
  connectionId,
  finalDeltaManifestSha256,
  finalDelta,
  sourceRawSha256,
  finalTargetRawSha256,
}) {
  if (
    manifest?.version !== 1
    || manifest?.kind !== "RUNTIME_FLEET_FINAL_RECONCILIATION"
    || manifest.connectionId !== connectionId
    || manifest.result !== "RECONCILED_EXACT"
    || manifest.differences !== 0
    || manifest.finalDeltaManifestSha256 !== finalDeltaManifestSha256
    || manifest.sourceRawSha256 !== sourceRawSha256
    || manifest.targetRawSha256 !== finalTargetRawSha256
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_FINAL_RECONCILIATION_MISMATCH");
  }
  const counts = validateCounts(manifest.counts, "FINAL_RECONCILIATION_COUNTS", { requireHistory: true });
  const cursorDay = canonicalDate(manifest.cursor?.day, "FINAL_RECONCILIATION_CURSOR_DAY");
  const cursorSync = canonicalTimestamp(manifest.cursor?.sync, "FINAL_RECONCILIATION_CURSOR_SYNC").iso;
  if (
    canonicalJson(counts) !== canonicalJson(finalDelta.after)
    || cursorDay !== finalDelta.cursorDay
    || cursorSync !== finalDelta.cursorSync
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_FINAL_RECONCILIATION_WATERMARK_MISMATCH");
  }
  return { counts, cursorDay, cursorSync };
}

function validateWriterFenceEvidence(evidence, {
  connectionId,
  approvedAt,
  finalDeltaManifestSha256,
  finalDeltaManifest,
  finalDelta,
}) {
  if (
    evidence?.schemaVersion !== 1
    || evidence?.kind !== "lovable-writer-fence-applied-evidence"
    || evidence.connectionId !== connectionId
    || evidence.readback?.connectionId !== connectionId
    || evidence.readback?.provider !== "agora"
    || evidence.readback?.enabled !== false
    || evidence.readback?.catalogSyncEnabled !== false
    || evidence.readback?.expectedControlState !== true
    || evidence.readback?.scheduler?.intradaySalesSyncEnabled !== false
    || evidence.readback?.scheduler?.openTicketsStockSyncEnabled !== false
    || evidence.readback?.scheduler?.openTicketsSyncEnabled !== false
    || !SHA256_PATTERN.test(evidence.readbackSemanticSha256 ?? "")
    || !SHA256_PATTERN.test(evidence.preparedFenceManifestSha256 ?? "")
    || !SHA256_PATTERN.test(evidence.applySqlSha256 ?? "")
    || !SHA256_PATTERN.test(evidence.rollbackSqlSha256 ?? "")
    || evidence.drain?.minimumMs < MIN_WRITER_DRAIN_MS
    || evidence.drain?.satisfied !== true
    || evidence.sourcePasses?.count !== 2
    || evidence.sourcePasses?.identical !== true
    || evidence.sourcePasses?.stableMarkers !== true
    || evidence.correctedDelta?.manifestSha256 !== finalDeltaManifestSha256
    || evidence.correctedDelta?.applySha256 !== finalDeltaManifest.applySha256
    || evidence.correctedDelta?.rollbackSha256 !== finalDeltaManifest.rollbackSha256
    || canonicalJson(evidence.correctedDelta?.expected) !== canonicalJson(finalDeltaManifest.expected)
    || canonicalJson(evidence.correctedDelta?.delta) !== canonicalJson(finalDeltaManifest.delta)
    || evidence.correctedDelta?.disposablePostgres17ApplyRollback !== "PASS"
    || !SHA256_PATTERN.test(evidence.targetBackup?.manifestSha256 ?? "")
    || evidence.targetBackup?.encryptedAtRest !== true
    || !Number.isSafeInteger(evidence.targetBackup?.publicTables)
    || evidence.targetBackup.publicTables <= 0
    || evidence.status !== "FENCED_DRAINED_STABLE_DELTA_TESTED_OWN_WRITER_INACTIVE"
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_WRITER_FENCE_NOT_VERIFIABLE");
  }
  const fencedAt = canonicalTimestamp(evidence.readback.fencedAt, "WRITER_FENCE_APPLIED_AT");
  const verifiedAt = canonicalTimestamp(evidence.readback.verifiedAt, "WRITER_FENCE_VERIFIED_AT");
  const firstCaptureAt = canonicalTimestamp(evidence.drain.capture1At, "WRITER_FENCE_CAPTURE_AT");
  if (
    firstCaptureAt.milliseconds < fencedAt.milliseconds + evidence.drain.minimumMs
    || verifiedAt.milliseconds < firstCaptureAt.milliseconds
    || verifiedAt.milliseconds > approvedAt.milliseconds
    || approvedAt.milliseconds - verifiedAt.milliseconds > MAX_FENCE_EVIDENCE_AGE_MS
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_WRITER_FENCE_WINDOW_MISMATCH");
  }
  if (
    !Array.isArray(evidence.sourcePasses.semanticSha256)
    || evidence.sourcePasses.semanticSha256.length !== 2
    || evidence.sourcePasses.semanticSha256.some((value) => !SHA256_PATTERN.test(value))
    || evidence.sourcePasses.semanticSha256[0] !== evidence.sourcePasses.semanticSha256[1]
    || !Array.isArray(evidence.sourcePasses.counts)
    || evidence.sourcePasses.counts.length !== 2
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_WRITER_FENCE_SOURCE_PASSES_MISMATCH");
  }
  for (const counts of evidence.sourcePasses.counts) {
    if (canonicalJson(validateCounts(counts, "WRITER_FENCE_COUNTS", { requireHistory: true })) !== canonicalJson(finalDelta.after)) {
      throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_WRITER_FENCE_SOURCE_PASSES_MISMATCH");
    }
  }
  return {
    fencedAt: fencedAt.iso,
    verifiedAt: verifiedAt.iso,
    sourcePassSha256: evidence.sourcePasses.semanticSha256[0],
  };
}

function validateWriterFenceGrant(grant, proofSource, {
  connectionId,
  runId,
  keyVersion,
  approvedAt,
  expiresAt,
  credentialSetSha256: expectedCredentialSetSha256,
  credentialAttestations,
  writerFenceEvidenceSha256,
  writerFenceEvidence,
  externalWriterFenceEvidence,
  deploymentManifestSha256,
  finalTargetRawSha256,
  providerConfig,
  adoptionBindingSha256: expectedAdoptionBindingSha256,
}) {
  if (!Buffer.isBuffer(proofSource) || proofSource.length < 32 || proofSource.length > 16 * 1024) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_WRITER_FENCE_PROOF_INVALID");
  }
  if (
    grant?.version !== 3
    || grant.grantType !== "adopt-existing-sales"
    || grant.connectionId !== connectionId
    || grant.runId !== runId
    || !IDENTIFIER_PATTERN.test(grant.holderId ?? "")
    || grant.proofSha256 !== sha256(proofSource)
    || Object.prototype.hasOwnProperty.call(grant, "exclusiveCredentialRef")
    || Object.prototype.hasOwnProperty.call(grant, "credentialVersion")
    || Object.prototype.hasOwnProperty.call(grant, "credentialBinding")
    || Object.prototype.hasOwnProperty.call(grant, "legacyWriter")
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_WRITER_FENCE_GRANT_SCOPE_MISMATCH");
  }
  const issuedAt = canonicalTimestamp(grant.issuedAt, "WRITER_FENCE_GRANT_ISSUED_AT");
  const grantExpiresAt = canonicalTimestamp(grant.expiresAt, "WRITER_FENCE_GRANT_EXPIRES_AT");
  if (
    issuedAt.milliseconds > approvedAt.milliseconds
    || approvedAt.milliseconds - issuedAt.milliseconds > MAX_FENCE_EVIDENCE_AGE_MS
    || grantExpiresAt.milliseconds < expiresAt.milliseconds
    || grantExpiresAt.milliseconds <= issuedAt.milliseconds
    || grantExpiresAt.milliseconds - issuedAt.milliseconds > MAX_APPROVAL_WINDOW_MS
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_WRITER_FENCE_GRANT_WINDOW_MISMATCH");
  }
  const bundle = grant.credentialBundle;
  const credentials = bundle?.credentials;
  if (
    bundle?.version !== 1
    || bundle.keyVersion !== keyVersion
    || bundle.generationSha256 !== expectedCredentialSetSha256
    || !SHA256_PATTERN.test(bundle.bundleSha256 ?? "")
    || !SHA256_PATTERN.test(bundle.signatureSha256 ?? "")
    || !credentials
    || Object.keys(credentials).sort().join(",") !== "agora,winerim"
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_WRITER_FENCE_CREDENTIAL_BUNDLE_MISMATCH");
  }
  for (const kind of ["agora", "winerim"]) {
    const credential = credentials[kind];
    const version = credentialAttestations[kind];
    if (
      credential?.kind !== kind
      || credential.reference !== fleetCredentialReference(connectionId, kind)
      || credential.version !== version
      || credential.attestationSha256 !== version
      || credential.binding !== fleetCredentialBinding({ connectionId, runId, kind, version })
    ) {
      throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_WRITER_FENCE_CREDENTIAL_BUNDLE_MISMATCH");
    }
  }
  const bundlePayload = [
    "winerim-writer-fence-credential-bundle",
    "1",
    connectionId,
    runId,
    grant.holderId,
    grant.issuedAt,
    grant.expiresAt,
    keyVersion,
    expectedCredentialSetSha256,
    credentials.agora.kind,
    credentials.agora.reference,
    credentials.agora.version,
    credentials.agora.attestationSha256,
    credentials.agora.binding,
    credentials.winerim.kind,
    credentials.winerim.reference,
    credentials.winerim.version,
    credentials.winerim.attestationSha256,
    credentials.winerim.binding,
  ].join("|");
  if (
    bundle.bundleSha256 !== sha256(bundlePayload)
    || bundle.signatureSha256 !== createHmac("sha256", proofSource).update(bundlePayload).digest("hex")
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_WRITER_FENCE_SIGNATURE_MISMATCH");
  }
  const history = grant.writerHistory;
  if (
    history?.mode !== "adopt-existing-sales"
    || history.verifiedAt !== writerFenceEvidence.verifiedAt
    || history.verifiedAt !== externalWriterFenceEvidence.observedAt
    || history.evidenceSha256 !== writerFenceEvidenceSha256
    || history.cloudflareEvidenceSha256 !== writerFenceEvidence.sourcePassSha256
    || canonicalJson(history.externalEvidence) !== canonicalJson(externalWriterFenceEvidence)
    || Object.prototype.hasOwnProperty.call(history, "absence")
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_WRITER_FENCE_HISTORY_MISMATCH");
  }
  const scope = grant.activationScope;
  if (
    scope?.version !== 1
    || scope.kind !== "adopt-existing-sales"
    || scope.adoptionBindingSha256 !== expectedAdoptionBindingSha256
    || scope.deploymentManifestSha256 !== deploymentManifestSha256
    || scope.finalTargetRawSha256 !== finalTargetRawSha256
    || scope.externalEvidenceSha256 !== externalWriterFenceEvidence.artifactSha256
    || scope.externalEvidencePayloadSha256 !== externalWriterFenceEvidence.payloadSha256
    || scope.runtimePolicySha256 !== runtimePolicySha256(providerConfig)
    || !SHA256_PATTERN.test(scope.bindingSha256 ?? "")
    || !SHA256_PATTERN.test(scope.signatureSha256 ?? "")
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_WRITER_FENCE_SALES_SCOPE_MISMATCH");
  }
  const scopePayload = [
    "winerim-writer-fence-adopt-existing-sales",
    "1",
    connectionId,
    runId,
    grant.holderId,
    grant.issuedAt,
    grant.expiresAt,
    expectedAdoptionBindingSha256,
    deploymentManifestSha256,
    finalTargetRawSha256,
    externalWriterFenceEvidence.artifactSha256,
    externalWriterFenceEvidence.payloadSha256,
    runtimePolicySha256(providerConfig),
  ].join("|");
  if (
    scope.bindingSha256 !== sha256(scopePayload)
    || scope.signatureSha256 !== createHmac("sha256", proofSource).update(scopePayload).digest("hex")
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_WRITER_FENCE_SALES_SCOPE_SIGNATURE_MISMATCH");
  }
  return {
    holderId: grant.holderId,
    proofSha256: grant.proofSha256,
    issuedAt: issuedAt.iso,
    expiresAt: grantExpiresAt.iso,
    bundleSha256: bundle.bundleSha256,
    activationScopeBindingSha256: scope.bindingSha256,
  };
}

export function validateFleetConnectionAdoptExistingActivationInput({
  input,
  deploymentManifestSource,
  finalTargetRawSource,
  credentialProvisioningManifestSource,
  finalDeltaManifestSource,
  finalReconciliationManifestSource,
  writerFenceEvidenceSource,
  externalWriterFenceEvidenceSource,
  externalWriterFencePublicKeySource,
  writerFenceGrantSource,
  writerFenceProofSource,
}) {
  exactKeys(input, [
    "version",
    "kind",
    "connectionId",
    "runId",
    "keyVersion",
    "approvedAt",
    "expiresAt",
    "deactivationStaleLeaseCutoffSeconds",
    "providerConfig",
    "providerConfigSnapshot",
    "deploymentManifest",
    "finalTargetRaw",
    "credentialProvisioningManifest",
    "finalDeltaManifest",
    "finalReconciliationManifest",
    "writerFenceEvidence",
    "externalWriterFenceEvidence",
    "externalWriterFencePublicKey",
    "writerFenceGrant",
    "writerFenceProof",
  ], "INPUT");
  const connectionId = String(input.connectionId ?? "").trim().toLowerCase();
  const runId = String(input.runId ?? "").trim();
  const keyVersion = String(input.keyVersion ?? "").trim();
  if (
    input.version !== 3
    || input.kind !== "RUNTIME_FLEET_CONNECTION_ADOPT_EXISTING_ACTIVATION"
    || !UUID_PATTERN.test(connectionId)
    || !RUN_PATTERN.test(runId)
    || !KEY_VERSION_PATTERN.test(keyVersion)
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_INPUT_CONTRACT");
  }
  const deactivationStaleLeaseCutoffSeconds = positiveInteger(
    input.deactivationStaleLeaseCutoffSeconds,
    "DEACTIVATION_STALE_LEASE_CUTOFF_SECONDS",
  );
  if (deactivationStaleLeaseCutoffSeconds < 60 || deactivationStaleLeaseCutoffSeconds > 86_400) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_DEACTIVATION_STALE_LEASE_CUTOFF_SECONDS");
  }
  const providerConfig = validateProviderConfig(input.providerConfig);
  const providerConfigSnapshot = validateProviderConfigSnapshot(input.providerConfigSnapshot);
  const approvedAt = canonicalTimestamp(input.approvedAt, "APPROVED_AT");
  const expiresAt = canonicalTimestamp(input.expiresAt, "EXPIRES_AT");
  if (
    expiresAt.milliseconds <= approvedAt.milliseconds
    || expiresAt.milliseconds - approvedAt.milliseconds > MAX_APPROVAL_WINDOW_MS
  ) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_WINDOW_MUST_BE_WITHIN_TWO_HOURS");
  }
  const credentialReference = artifactReference(
    input.credentialProvisioningManifest,
    "CREDENTIAL_PROVISIONING_MANIFEST",
  );
  const finalDeltaReference = artifactReference(input.finalDeltaManifest, "FINAL_DELTA_MANIFEST");
  const finalReconciliationReference = artifactReference(
    input.finalReconciliationManifest,
    "FINAL_RECONCILIATION_MANIFEST",
  );
  const writerFenceReference = artifactReference(input.writerFenceEvidence, "WRITER_FENCE_EVIDENCE");
  const deploymentReference = artifactReference(input.deploymentManifest, "DEPLOYMENT_MANIFEST");
  const finalTargetRawReference = artifactReference(input.finalTargetRaw, "FINAL_TARGET_RAW");
  const externalWriterFenceReference = artifactReference(
    input.externalWriterFenceEvidence,
    "EXTERNAL_WRITER_FENCE_EVIDENCE",
  );
  const externalWriterFencePublicKeyReference = artifactReference(
    input.externalWriterFencePublicKey,
    "EXTERNAL_WRITER_FENCE_PUBLIC_KEY",
  );
  const writerFenceGrantReference = artifactReference(input.writerFenceGrant, "WRITER_FENCE_GRANT");
  const writerFenceProofReference = artifactReference(input.writerFenceProof, "WRITER_FENCE_PROOF");
  for (const [source, reference, label] of [
    [deploymentManifestSource, deploymentReference, "DEPLOYMENT_MANIFEST"],
    [finalTargetRawSource, finalTargetRawReference, "FINAL_TARGET_RAW"],
    [credentialProvisioningManifestSource, credentialReference, "CREDENTIAL_PROVISIONING_MANIFEST"],
    [finalDeltaManifestSource, finalDeltaReference, "FINAL_DELTA_MANIFEST"],
    [finalReconciliationManifestSource, finalReconciliationReference, "FINAL_RECONCILIATION_MANIFEST"],
    [writerFenceEvidenceSource, writerFenceReference, "WRITER_FENCE_EVIDENCE"],
    [externalWriterFenceEvidenceSource, externalWriterFenceReference, "EXTERNAL_WRITER_FENCE_EVIDENCE"],
    [externalWriterFencePublicKeySource, externalWriterFencePublicKeyReference, "EXTERNAL_WRITER_FENCE_PUBLIC_KEY"],
    [writerFenceGrantSource, writerFenceGrantReference, "WRITER_FENCE_GRANT"],
    [writerFenceProofSource, writerFenceProofReference, "WRITER_FENCE_PROOF"],
  ]) {
    if (!Buffer.isBuffer(source) || sha256(source) !== reference.sha256) {
      throw new Error(`RUNTIME_FLEET_ADOPT_ACTIVATION_${label}_SHA256_MISMATCH`);
    }
  }
  const deploymentManifest = validateDeploymentManifest(
    parseJson(deploymentManifestSource, "DEPLOYMENT_MANIFEST"),
  );
  const credential = validateCredentialProvisioningManifest(
    parseJson(credentialProvisioningManifestSource, "CREDENTIAL_PROVISIONING_MANIFEST"),
    { connectionId, runId, keyVersion },
  );
  const finalTargetRaw = validateFencedTargetRawV1(
    parseJson(finalTargetRawSource, "FINAL_TARGET_RAW"),
    { connectionId, adoption: credential.adoption },
  );
  if (canonicalJson(finalTargetRaw.providerConfig) !== canonicalJson(providerConfigSnapshot)) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_PROVIDER_CONFIG_SNAPSHOT_MISMATCH");
  }
  const finalDeltaManifest = parseJson(finalDeltaManifestSource, "FINAL_DELTA_MANIFEST");
  const finalDelta = validateFinalDeltaManifest(finalDeltaManifest, {
    connectionId,
    adoption: credential.adoption,
    finalTargetRaw,
  });
  const finalReconciliation = validateFinalReconciliation(
    parseJson(finalReconciliationManifestSource, "FINAL_RECONCILIATION_MANIFEST"),
    {
      connectionId,
      finalDeltaManifestSha256: finalDeltaReference.sha256,
      finalDelta,
      sourceRawSha256: finalDeltaManifest.sourceSha256,
      finalTargetRawSha256: finalTargetRawReference.sha256,
    },
  );
  const externalWriterFence = validateExternalWriterFenceEvidence({
    artifactSource: externalWriterFenceEvidenceSource,
    artifactSha256: externalWriterFenceReference.sha256,
    publicKeySource: externalWriterFencePublicKeySource,
    publicKeySha256: externalWriterFencePublicKeyReference.sha256,
    connectionId,
    approvedAt,
  });
  const writerFence = validateWriterFenceEvidence(
    parseJson(writerFenceEvidenceSource, "WRITER_FENCE_EVIDENCE"),
    {
      connectionId,
      approvedAt,
      finalDeltaManifestSha256: finalDeltaReference.sha256,
      finalDeltaManifest,
      finalDelta,
    },
  );
  const writerFenceGrant = validateWriterFenceGrant(
    parseJson(writerFenceGrantSource, "WRITER_FENCE_GRANT"),
    writerFenceProofSource,
    {
      connectionId,
      runId,
      keyVersion,
      approvedAt,
      expiresAt,
      credentialSetSha256: credential.credentialSetSha256,
      credentialAttestations: credential.attestations,
      writerFenceEvidenceSha256: writerFenceReference.sha256,
      writerFenceEvidence: writerFence,
      externalWriterFenceEvidence: externalWriterFence,
      deploymentManifestSha256: deploymentReference.sha256,
      finalTargetRawSha256: finalTargetRawReference.sha256,
      providerConfig,
      adoptionBindingSha256: credential.adoption.bindingSha256,
    },
  );
  return {
    version: 3,
    kind: input.kind,
    connectionId,
    runId,
    keyVersion,
    approvedAt: approvedAt.iso,
    expiresAt: expiresAt.iso,
    deactivationStaleLeaseCutoffSeconds,
    providerConfig,
    providerConfigSnapshot,
    providerConfigSnapshotSha256: sha256(canonicalJson(providerConfigSnapshot)),
    runtimePolicySha256: runtimePolicySha256(providerConfig),
    scopeNote: `adopt-existing:v3:${credential.adoption.bindingSha256}`,
    deploymentManifestSha256: deploymentReference.sha256,
    deploymentManifest,
    finalTargetRawSha256: finalTargetRawReference.sha256,
    finalTargetRaw: {
      ...finalTargetRaw,
      fileSha256: finalTargetRawReference.sha256,
      targetCorrectedShadowSha256: finalDelta.targetCorrectedShadowSha256,
      adoptionTargetDatasetSha256: finalDelta.adoptionTargetDatasetSha256,
      semanticLineage: finalDelta.semanticLineage,
    },
    credentialProvisioningManifestSha256: credentialReference.sha256,
    finalDeltaManifestSha256: finalDeltaReference.sha256,
    finalReconciliationManifestSha256: finalReconciliationReference.sha256,
    writerFenceEvidenceSha256: writerFenceReference.sha256,
    externalWriterFenceEvidenceSha256: externalWriterFenceReference.sha256,
    externalWriterFencePublicKeySha256: externalWriterFencePublicKeyReference.sha256,
    writerFenceGrantSha256: writerFenceGrantReference.sha256,
    credentialSetSha256: credential.credentialSetSha256,
    credentialAttestations: credential.attestations,
    adoption: credential.adoption,
    finalDelta: {
      sourceRawSha256: finalDeltaManifest.sourceSha256,
      applySha256: finalDeltaManifest.applySha256,
      rollbackSha256: finalDeltaManifest.rollbackSha256,
      readbackSha256: finalDeltaManifest.readbackSha256,
      targetCorrectedShadowSha256: finalDelta.targetCorrectedShadowSha256,
      adoptionTargetDatasetSha256: finalDelta.adoptionTargetDatasetSha256,
      semanticLineage: finalDelta.semanticLineage,
      before: finalDelta.before,
      after: finalDelta.after,
      delta: finalDelta.delta,
    },
    finalReconciliation,
    writerFence,
    externalWriterFence,
    writerFenceGrant,
  };
}

export function buildFleetConnectionAdoptExistingActivationManifest(validated) {
  const core = {
    version: 3,
    kind: "RUNTIME_FLEET_CONNECTION_ADOPT_EXISTING_ACTIVATION_REVIEW",
    activationMode: "adopt-existing-sales",
    activationAllowed: true,
    rollbackMode: "two-phase-quiesce-then-append-only-retirement",
    rollbackPhases: ["quiesce-intake", "drain-leases-and-retire"],
    remoteMutations: 0,
    ...validated,
  };
  return { ...core, logicalManifestSha256: sha256(canonicalJson(core)) };
}

function sqlLiteral(value) {
  return String(value).replaceAll("'", "''");
}

export function renderFleetConnectionAdoptExistingActivationSql({
  activation,
  activationManifestSha256,
}) {
  if (!SHA256_PATTERN.test(activationManifestSha256 ?? "")) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_ACTIVATION_MANIFEST_SHA256");
  }
  const {
    connectionId,
    runId,
    keyVersion,
    approvedAt,
    expiresAt,
    providerConfig,
    providerConfigSnapshot,
    scopeNote,
    deploymentManifestSha256,
    credentialSetSha256,
    credentialAttestations,
    adoption,
    finalDelta,
    writerFence,
    writerFenceGrantSha256,
  } = activation;
  const approved = canonicalTimestamp(approvedAt, "APPROVED_AT");
  const expires = canonicalTimestamp(expiresAt, "EXPIRES_AT");
  const fenceVerified = canonicalTimestamp(writerFence.verifiedAt, "WRITER_FENCE_VERIFIED_AT");
  const providerConfigSnapshotJson = canonicalJson(providerConfigSnapshot);
  const activatedProviderConfigJson = canonicalJson({
    ...providerConfigSnapshot,
    ...providerConfig,
  });
  return `BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20s';
SELECT pg_advisory_xact_lock(hashtextextended('runtime-fleet-connection-activation', 0));

LOCK TABLE public.pos_connections,
  public.runtime_canary_connections,
  public.runtime_connection_credentials
  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.sales_events,
  public.sales_line_items,
  public.stock_sync_log,
  public.product_mappings,
  public.runtime_idempotency
  IN SHARE MODE;

DO $verify_fleet_adopt_existing_activation$
BEGIN
  IF '${approved.iso}'::timestamptz > statement_timestamp()
    OR '${expires.iso}'::timestamptz <= statement_timestamp()
    OR '${expires.iso}'::timestamptz > '${approved.iso}'::timestamptz + interval '2 hours' THEN
    RAISE EXCEPTION 'fleet activation approval window is not currently valid';
  END IF;
  IF statement_timestamp() < '${fenceVerified.iso}'::timestamptz
    OR statement_timestamp() > '${fenceVerified.iso}'::timestamptz + interval '15 minutes' THEN
    RAISE EXCEPTION 'writer fence evidence is not fresh at activation time';
  END IF;
  IF (
    SELECT count(*) FROM public.pos_connections
    WHERE id = '${connectionId}'::uuid
      AND provider = 'agora'
      AND enabled = false
      AND catalog_sync_enabled = false
      AND sync_mode = 'PULL_ONLY'
      AND write_mode = 'NONE'
      AND backfill_days = 0
      AND COALESCE(provider_config, '{}'::jsonb) = '${sqlLiteral(providerConfigSnapshotJson)}'::jsonb
      AND last_business_day_synced::text = '${adoption.watermarks.lastBusinessDaySynced}'
      AND to_char(last_sync_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = '${adoption.watermarks.lastSyncAt}'
  ) <> 1 THEN
    RAISE EXCEPTION 'fleet activation candidate is missing, mutable, or cursor drifted';
  END IF;
  IF (
    SELECT count(*) FROM public.runtime_canary_connections
    WHERE connection_id = '${connectionId}'::uuid
      AND status = 'PREPARED'
      AND active = false
  ) <> 1 OR (
    SELECT count(*) FROM public.runtime_canary_connections
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND generation_mode = 'bootstrap'
      AND note = '${sqlLiteral(scopeNote)}'
      AND status = 'PREPARED'
      AND active = false
      AND approved_at IS NULL
      AND expires_at IS NULL
      AND deployment_manifest_sha256 IS NULL
      AND writer_fence_grant_sha256 IS NULL
      AND credential_set_sha256 IS NULL
      AND activated_at IS NULL
      AND retired_at IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'exact unique PREPARED adopt-existing scope is missing or consumed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.runtime_canary_connections
    WHERE connection_id = '${connectionId}'::uuid AND active = true
  ) OR EXISTS (
    SELECT 1 FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid AND active = true
  ) THEN
    RAISE EXCEPTION 'connection already has an active scope or credential';
  END IF;
  IF (
    SELECT count(*) FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid AND run_id = '${runId}'
  ) <> 2 OR (
    SELECT count(*) FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND provider = 'agora'
      AND key_version = '${keyVersion}'
      AND credential_kind IN ('agora', 'winerim')
      AND active = false
      AND activated_at IS NULL
      AND retired_at IS NULL
  ) <> 2 OR (
    SELECT count(DISTINCT credential_kind) FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid AND run_id = '${runId}'
  ) <> 2 THEN
    RAISE EXCEPTION 'exact two inactive credential generation is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid AND run_id = '${runId}'
      AND credential_kind = 'agora'
      AND attestation_sha256 = '${credentialAttestations.agora}'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid AND run_id = '${runId}'
      AND credential_kind = 'winerim'
      AND attestation_sha256 = '${credentialAttestations.winerim}'
  ) THEN
    RAISE EXCEPTION 'credential attestations do not match the reviewed generation';
  END IF;
  IF (SELECT count(*) FROM public.sales_events WHERE connection_id = '${connectionId}'::uuid) <> ${finalDelta.after.events}
    OR (SELECT count(*) FROM public.sales_line_items WHERE connection_id = '${connectionId}'::uuid) <> ${finalDelta.after.lines}
    OR (SELECT count(*) FROM public.stock_sync_log WHERE connection_id = '${connectionId}'::uuid) <> ${finalDelta.after.receipts}
    OR (SELECT count(*) FROM public.product_mappings WHERE connection_id = '${connectionId}'::uuid) <> ${finalDelta.after.mappings}
    OR COALESCE((SELECT max(business_day)::text FROM public.sales_events WHERE connection_id = '${connectionId}'::uuid), '') <> '${adoption.watermarks.maxBusinessDay}' THEN
    RAISE EXCEPTION 'reconciled historical watermarks changed after review';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.runtime_idempotency
    WHERE connection_id = '${connectionId}'::uuid
      AND status = 'RUNNING'
      AND (lease_expires_at IS NULL OR lease_expires_at > statement_timestamp())
  ) THEN
    RAISE EXCEPTION 'active runtime execution exists for connection';
  END IF;
END;
$verify_fleet_adopt_existing_activation$;

UPDATE public.runtime_connection_credentials
SET active = true,
    activated_at = transaction_timestamp()
WHERE connection_id = '${connectionId}'::uuid
  AND run_id = '${runId}'
  AND key_version = '${keyVersion}'
  AND credential_kind IN ('agora', 'winerim')
  AND active = false
  AND activated_at IS NULL
  AND retired_at IS NULL;

UPDATE public.runtime_canary_connections
SET active = true,
    status = 'ACTIVE',
    approved_at = '${approved.iso}'::timestamptz,
    expires_at = '${expires.iso}'::timestamptz,
    deployment_manifest_sha256 = '${deploymentManifestSha256}',
    writer_fence_grant_sha256 = '${writerFenceGrantSha256}',
    credential_set_sha256 = '${credentialSetSha256}',
    activated_at = transaction_timestamp()
WHERE connection_id = '${connectionId}'::uuid
  AND run_id = '${runId}'
  AND status = 'PREPARED'
  AND active = false;

UPDATE public.pos_connections
SET enabled = true,
    catalog_sync_enabled = false,
    sync_mode = 'PULL_ONLY',
    write_mode = 'NONE',
    backfill_days = 0,
    provider_config = '${sqlLiteral(activatedProviderConfigJson)}'::jsonb
WHERE id = '${connectionId}'::uuid
  AND enabled = false;

DO $readback_fleet_adopt_existing_activation$
BEGIN
  IF (
    SELECT count(*) FROM public.runtime_canary_connections
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND note = '${sqlLiteral(scopeNote)}'
      AND status = 'ACTIVE'
      AND active = true
      AND approved_at = '${approved.iso}'::timestamptz
      AND expires_at = '${expires.iso}'::timestamptz
      AND deployment_manifest_sha256 = '${deploymentManifestSha256}'
      AND writer_fence_grant_sha256 = '${writerFenceGrantSha256}'
      AND credential_set_sha256 = '${credentialSetSha256}'
      AND activated_at IS NOT NULL
      AND retired_at IS NULL
  ) <> 1 OR (
    SELECT count(*) FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND active = true
      AND activated_at IS NOT NULL
      AND retired_at IS NULL
  ) <> 2 OR (
    SELECT count(*) FROM public.pos_connections
    WHERE id = '${connectionId}'::uuid
      AND enabled = true
      AND catalog_sync_enabled = false
      AND sync_mode = 'PULL_ONLY'
      AND write_mode = 'NONE'
      AND backfill_days = 0
      AND provider_config = '${sqlLiteral(activatedProviderConfigJson)}'::jsonb
  ) <> 1 THEN
    RAISE EXCEPTION 'fleet adopt-existing activation readback failed';
  END IF;
END;
$readback_fleet_adopt_existing_activation$;

COMMIT;
`;
}

export function renderFleetConnectionAdoptExistingDeactivationSql({
  activation,
  activationManifestSha256,
}) {
  if (!SHA256_PATTERN.test(activationManifestSha256 ?? "")) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_INVALID_ACTIVATION_MANIFEST_SHA256");
  }
  const {
    connectionId,
    runId,
    credentialSetSha256,
    writerFenceGrantSha256,
    deploymentManifestSha256,
    deactivationStaleLeaseCutoffSeconds,
    providerConfig,
    providerConfigSnapshot,
  } = activation;
  const providerConfigSnapshotJson = canonicalJson(providerConfigSnapshot);
  const activatedProviderConfigJson = canonicalJson({
    ...providerConfigSnapshot,
    ...providerConfig,
  });
  const quiescedProviderConfigJson = canonicalJson({
    ...providerConfigSnapshot,
    ...providerConfig,
    runtime_sales_job_allowlist: [],
    intraday_sales_sync_enabled: false,
    open_tickets_sync_enabled: false,
    open_tickets_stock_sync_enabled: false,
  });
  return `-- Phase 1: persistently quiesce new runtime intake. This phase is re-entrant.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20s';
SELECT pg_advisory_xact_lock(hashtextextended('runtime-fleet-connection-activation', 0));

LOCK TABLE public.pos_connections,
  public.runtime_canary_connections,
  public.runtime_connection_credentials
  IN SHARE ROW EXCLUSIVE MODE;

DO $verify_fleet_adopt_existing_quiesce$
BEGIN
  IF (
    SELECT count(*) FROM public.runtime_canary_connections
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND status = 'ACTIVE'
      AND active = true
      AND deployment_manifest_sha256 = '${deploymentManifestSha256}'
      AND writer_fence_grant_sha256 = '${writerFenceGrantSha256}'
      AND credential_set_sha256 = '${credentialSetSha256}'
      AND activated_at IS NOT NULL
      AND retired_at IS NULL
  ) <> 1 OR (
    SELECT count(*) FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND active = true
      AND activated_at IS NOT NULL
      AND retired_at IS NULL
  ) <> 2 THEN
    RAISE EXCEPTION 'exact active generation is missing, mismatched, or already consumed';
  END IF;
  IF (
    SELECT count(*) FROM public.pos_connections
    WHERE id = '${connectionId}'::uuid
      AND catalog_sync_enabled = false
      AND sync_mode = 'PULL_ONLY'
      AND write_mode = 'NONE'
      AND backfill_days = 0
      AND (
        (enabled = true AND provider_config = '${sqlLiteral(activatedProviderConfigJson)}'::jsonb)
        OR (enabled = false AND provider_config = '${sqlLiteral(quiescedProviderConfigJson)}'::jsonb)
      )
  ) <> 1 THEN
    RAISE EXCEPTION 'fleet connection is neither active nor already quiesced at reviewed configuration';
  END IF;
END;
$verify_fleet_adopt_existing_quiesce$;

UPDATE public.pos_connections
SET enabled = false,
    catalog_sync_enabled = false,
    sync_mode = 'PULL_ONLY',
    write_mode = 'NONE',
    backfill_days = 0,
    provider_config = '${sqlLiteral(quiescedProviderConfigJson)}'::jsonb
WHERE id = '${connectionId}'::uuid
  AND enabled = true
  AND provider_config = '${sqlLiteral(activatedProviderConfigJson)}'::jsonb;

DO $readback_fleet_adopt_existing_quiesce$
BEGIN
  IF (
    SELECT count(*) FROM public.pos_connections
    WHERE id = '${connectionId}'::uuid
      AND enabled = false
      AND catalog_sync_enabled = false
      AND sync_mode = 'PULL_ONLY'
      AND write_mode = 'NONE'
      AND backfill_days = 0
      AND provider_config = '${sqlLiteral(quiescedProviderConfigJson)}'::jsonb
  ) <> 1 THEN
    RAISE EXCEPTION 'fleet adopt-existing quiesce readback failed';
  END IF;
END;
$readback_fleet_adopt_existing_quiesce$;

COMMIT;

-- Phase 2: retire only after every runtime lease is terminal.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20s';
SELECT pg_advisory_xact_lock(hashtextextended('runtime-fleet-connection-activation', 0));

LOCK TABLE public.pos_connections,
  public.runtime_canary_connections,
  public.runtime_connection_credentials
  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.runtime_idempotency IN SHARE ROW EXCLUSIVE MODE;

UPDATE public.runtime_idempotency
SET status = 'TERMINAL',
    lease_expires_at = COALESCE(lease_expires_at, statement_timestamp()),
    result = CASE
      WHEN jsonb_typeof(result) = 'object' THEN result
      WHEN result IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('previousResult', result)
    END || jsonb_build_object(
      'retiredBy', 'fleet-adopt-existing-deactivation',
      'retiredAt', statement_timestamp(),
      'staleLeaseCutoffSeconds', ${deactivationStaleLeaseCutoffSeconds}
    ),
    updated_at = statement_timestamp()
WHERE connection_id = '${connectionId}'::uuid
  AND status = 'RUNNING'
  AND (
    lease_expires_at <= statement_timestamp()
    OR (
      lease_expires_at IS NULL
      AND updated_at <= statement_timestamp() - interval '${deactivationStaleLeaseCutoffSeconds} seconds'
    )
  );

DO $verify_fleet_adopt_existing_retirement$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.runtime_idempotency
    WHERE connection_id = '${connectionId}'::uuid
      AND status = 'RUNNING'
  ) THEN
    RAISE EXCEPTION 'runtime leases remain after quiesce; rerun retirement after they drain';
  END IF;
  IF (
    SELECT count(*) FROM public.pos_connections
    WHERE id = '${connectionId}'::uuid
      AND enabled = false
      AND catalog_sync_enabled = false
      AND sync_mode = 'PULL_ONLY'
      AND write_mode = 'NONE'
      AND backfill_days = 0
      AND provider_config = '${sqlLiteral(quiescedProviderConfigJson)}'::jsonb
  ) <> 1 THEN
    RAISE EXCEPTION 'fleet connection must remain quiesced before retirement';
  END IF;
  IF (
    SELECT count(*) FROM public.runtime_canary_connections
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND status = 'ACTIVE'
      AND active = true
      AND deployment_manifest_sha256 = '${deploymentManifestSha256}'
      AND writer_fence_grant_sha256 = '${writerFenceGrantSha256}'
      AND credential_set_sha256 = '${credentialSetSha256}'
      AND activated_at IS NOT NULL
      AND retired_at IS NULL
  ) <> 1 OR (
    SELECT count(*) FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND active = true
      AND activated_at IS NOT NULL
      AND retired_at IS NULL
  ) <> 2 THEN
    RAISE EXCEPTION 'exact quiesced generation is missing, mismatched, or already consumed';
  END IF;
END;
$verify_fleet_adopt_existing_retirement$;

UPDATE public.runtime_connection_credentials
SET active = false,
    retired_at = transaction_timestamp()
WHERE connection_id = '${connectionId}'::uuid
  AND run_id = '${runId}'
  AND active = true
  AND activated_at IS NOT NULL
  AND retired_at IS NULL;

UPDATE public.runtime_canary_connections
SET active = false,
    status = 'ABORTED',
    retired_at = transaction_timestamp()
WHERE connection_id = '${connectionId}'::uuid
  AND run_id = '${runId}'
  AND status = 'ACTIVE'
  AND active = true
  AND deployment_manifest_sha256 = '${deploymentManifestSha256}';

UPDATE public.pos_connections
SET enabled = false,
    catalog_sync_enabled = false,
    sync_mode = 'PULL_ONLY',
    write_mode = 'NONE',
    backfill_days = 0,
    provider_config = '${sqlLiteral(providerConfigSnapshotJson)}'::jsonb
WHERE id = '${connectionId}'::uuid;

DO $readback_fleet_adopt_existing_deactivation$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid AND active = true
  ) OR EXISTS (
    SELECT 1 FROM public.runtime_canary_connections
    WHERE connection_id = '${connectionId}'::uuid AND active = true
  ) OR EXISTS (
    SELECT 1 FROM public.pos_connections
    WHERE id = '${connectionId}'::uuid
      AND (
        enabled
        OR catalog_sync_enabled
        OR sync_mode <> 'PULL_ONLY'
        OR write_mode <> 'NONE'
        OR backfill_days <> 0
        OR provider_config <> '${sqlLiteral(providerConfigSnapshotJson)}'::jsonb
      )
  ) OR (
    SELECT count(*) FROM public.runtime_canary_connections
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND status = 'ABORTED'
      AND active = false
      AND deployment_manifest_sha256 = '${deploymentManifestSha256}'
      AND writer_fence_grant_sha256 = '${writerFenceGrantSha256}'
      AND credential_set_sha256 = '${credentialSetSha256}'
      AND activated_at IS NOT NULL
      AND retired_at IS NOT NULL
  ) <> 1 OR (
    SELECT count(*) FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND active = false
      AND activated_at IS NOT NULL
      AND retired_at IS NOT NULL
  ) <> 2 THEN
    RAISE EXCEPTION 'fleet adopt-existing retirement readback failed';
  END IF;
END;
$readback_fleet_adopt_existing_deactivation$;

COMMIT;
`;
}

function validateExternalOutput(outputDir) {
  const target = resolve(outputDir);
  if (!isOutsideRepository(target)) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  if (existsSync(target)) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_OUTPUT_ALREADY_EXISTS");
  }
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const realParent = realpathSync(parent);
  if (!isOutsideRepository(realParent)) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  return { target, realParent };
}

export function fleetConnectionAdoptExistingActivationPlan() {
  return {
    status: "RUNTIME_FLEET_ADOPT_EXISTING_ACTIVATION_PLAN_ONLY",
    remoteMutations: 0,
    activationMode: "adopt-existing-sales",
    requiresNonemptyReconciledHistory: true,
    requiresUniquePreparedScope: true,
    requiresExactlyTwoInactiveCredentials: true,
    requiresFreshVerifiableWriterFence: true,
    requiresExternalEd25519WriterFence: true,
    requiredSalesJobs: [...REQUIRED_SALES_JOBS],
    openTicketsEnabled: false,
    rollbackMode: "two-phase-quiesce-then-append-only-retirement",
    rollbackPhases: ["quiesce-intake", "drain-leases-and-retire"],
    renderGate: "--render --input=/private/input.json --output=/private/new-directory --confirm-connection=<UUID>",
  };
}

export function prepareFleetConnectionAdoptExistingActivation({
  environment = process.env,
  inputPath,
  outputDir,
}) {
  const sourcePath = resolve(inputPath ?? required(environment, "RUNTIME_FLEET_ADOPT_ACTIVATION_INPUT_JSON"));
  const destination = outputDir ?? required(environment, "RUNTIME_FLEET_ADOPT_ACTIVATION_OUTPUT_DIR");
  const inputSource = readPrivateFile(
    sourcePath,
    sha256(readFileSync(sourcePath)),
    "INPUT_JSON",
  );
  const input = parseJson(inputSource, "INPUT");
  const references = {
    deployment: artifactReference(input.deploymentManifest, "DEPLOYMENT_MANIFEST"),
    finalTargetRaw: artifactReference(input.finalTargetRaw, "FINAL_TARGET_RAW"),
    credential: artifactReference(input.credentialProvisioningManifest, "CREDENTIAL_PROVISIONING_MANIFEST"),
    delta: artifactReference(input.finalDeltaManifest, "FINAL_DELTA_MANIFEST"),
    reconciliation: artifactReference(input.finalReconciliationManifest, "FINAL_RECONCILIATION_MANIFEST"),
    fence: artifactReference(input.writerFenceEvidence, "WRITER_FENCE_EVIDENCE"),
    externalFence: artifactReference(input.externalWriterFenceEvidence, "EXTERNAL_WRITER_FENCE_EVIDENCE"),
    externalFencePublicKey: artifactReference(
      input.externalWriterFencePublicKey,
      "EXTERNAL_WRITER_FENCE_PUBLIC_KEY",
    ),
    grant: artifactReference(input.writerFenceGrant, "WRITER_FENCE_GRANT"),
    proof: artifactReference(input.writerFenceProof, "WRITER_FENCE_PROOF"),
  };
  const validated = validateFleetConnectionAdoptExistingActivationInput({
    input,
    deploymentManifestSource: readPrivateFile(
      references.deployment.path,
      references.deployment.sha256,
      "DEPLOYMENT_MANIFEST",
    ),
    finalTargetRawSource: readPrivateFile(
      references.finalTargetRaw.path,
      references.finalTargetRaw.sha256,
      "FINAL_TARGET_RAW",
    ),
    credentialProvisioningManifestSource: readPrivateFile(
      references.credential.path,
      references.credential.sha256,
      "CREDENTIAL_PROVISIONING_MANIFEST",
    ),
    finalDeltaManifestSource: readPrivateFile(
      references.delta.path,
      references.delta.sha256,
      "FINAL_DELTA_MANIFEST",
    ),
    finalReconciliationManifestSource: readPrivateFile(
      references.reconciliation.path,
      references.reconciliation.sha256,
      "FINAL_RECONCILIATION_MANIFEST",
    ),
    writerFenceEvidenceSource: readPrivateFile(
      references.fence.path,
      references.fence.sha256,
      "WRITER_FENCE_EVIDENCE",
    ),
    externalWriterFenceEvidenceSource: readPrivateFile(
      references.externalFence.path,
      references.externalFence.sha256,
      "EXTERNAL_WRITER_FENCE_EVIDENCE",
    ),
    externalWriterFencePublicKeySource: readPrivateFile(
      references.externalFencePublicKey.path,
      references.externalFencePublicKey.sha256,
      "EXTERNAL_WRITER_FENCE_PUBLIC_KEY",
    ),
    writerFenceGrantSource: readPrivateFile(
      references.grant.path,
      references.grant.sha256,
      "WRITER_FENCE_GRANT",
    ),
    writerFenceProofSource: readPrivateFile(
      references.proof.path,
      references.proof.sha256,
      "WRITER_FENCE_PROOF",
    ),
  });
  const manifest = buildFleetConnectionAdoptExistingActivationManifest(validated);
  const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
  const activationManifestSha256 = sha256(manifestSource);
  const activationSql = renderFleetConnectionAdoptExistingActivationSql({
    activation: validated,
    activationManifestSha256,
  });
  const deactivationSql = renderFleetConnectionAdoptExistingDeactivationSql({
    activation: validated,
    activationManifestSha256,
  });
  const { target, realParent } = validateExternalOutput(destination);
  const staging = mkdtempSync(join(realParent, `.${basename(target)}.tmp-`));
  chmodSync(staging, 0o700);
  try {
    for (const [name, source] of [
      ["fleet-connection-adopt-existing.activation.sql", activationSql],
      ["fleet-connection-adopt-existing.deactivation.sql", deactivationSql],
      ["fleet-connection-adopt-existing.manifest.json", manifestSource],
    ]) {
      const path = join(staging, name);
      writeFileSync(path, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
      chmodSync(path, 0o600);
    }
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    status: "RUNTIME_FLEET_ADOPT_EXISTING_ACTIVATION_PACKAGE_READY",
    remoteMutations: 0,
    connectionId: validated.connectionId,
    runId: validated.runId,
    outputDir: target,
    activationSqlPath: join(target, "fleet-connection-adopt-existing.activation.sql"),
    deactivationSqlPath: join(target, "fleet-connection-adopt-existing.deactivation.sql"),
    manifestPath: join(target, "fleet-connection-adopt-existing.manifest.json"),
    activationSqlSha256: sha256(activationSql),
    deactivationSqlSha256: sha256(deactivationSql),
    activationManifestSha256,
  };
}

function argument(name) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function main() {
  if (!process.argv.includes("--render")) {
    process.stdout.write(`${JSON.stringify(fleetConnectionAdoptExistingActivationPlan(), null, 2)}\n`);
    return;
  }
  const inputPath = argument("--input");
  const outputDir = argument("--output");
  if (!inputPath) throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_INPUT_REQUIRED");
  if (!outputDir) throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_OUTPUT_REQUIRED");
  const inputSource = readPrivateFile(
    resolve(inputPath),
    sha256(readFileSync(resolve(inputPath))),
    "INPUT_JSON",
  );
  const input = parseJson(inputSource, "INPUT");
  if (argument("--confirm-connection") !== input.connectionId) {
    throw new Error("RUNTIME_FLEET_ADOPT_ACTIVATION_CONNECTION_CONFIRMATION_REQUIRED");
  }
  process.stdout.write(`${JSON.stringify(prepareFleetConnectionAdoptExistingActivation({
    inputPath,
    outputDir,
  }), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
