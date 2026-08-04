import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const TABLE_NAMES = [
  "sales_events",
  "sales_line_items",
  "stock_sync_log",
  "product_mappings",
];
const SECRET_KEY_PATTERN = /(?:^|[_-])(?:api[_-]?token|winerim[_-]?(?:api[_-]?)?token|token|secret|password|authorization|bearer|credentials?|private[_-]?key)(?:$|[_-])/i;
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/;
const BEARER_PATTERN = /(?:^|\s)Bearer\s+[A-Za-z0-9._~+/-]+/i;
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

function required(environment, name) {
  const value = String(environment[name] ?? "").trim();
  if (!value) throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_MISSING_${name}`);
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
    throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_INVALID_${label}`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_INVALID_${label}_STRUCTURE`);
  }
}

function canonicalTimestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_INVALID_${label}`);
  }
  return { milliseconds: parsed, iso: new Date(parsed).toISOString() };
}

function canonicalDate(value, label) {
  if (!DATE_PATTERN.test(value ?? "")) {
    throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_INVALID_${label}`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_INVALID_${label}`);
  }
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_INVALID_${label}`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_INVALID_${label}`);
  }
  return value;
}

function isOutsideRepository(path) {
  const candidate = relative(repoRoot, path);
  return candidate !== "" && (candidate.startsWith("..") || candidate.startsWith("/"));
}

function readPrivateFile(path, expectedSha256, label) {
  if (!isAbsolute(path)) {
    throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_${label}_PATH_MUST_BE_ABSOLUTE`);
  }
  if (!SHA256_PATTERN.test(expectedSha256 ?? "")) {
    throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_INVALID_${label}_SHA256`);
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_${label}_MUST_BE_REGULAR_FILE`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_${label}_MUST_BE_PRIVATE_0600`);
  }
  if (metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) {
    throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_${label}_INVALID_SIZE`);
  }
  const source = readFileSync(path);
  if (sha256(source) !== expectedSha256) {
    throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_${label}_SHA256_MISMATCH`);
  }
  return source;
}

function parseJson(source, label) {
  try {
    return JSON.parse(Buffer.from(source).toString("utf8"));
  } catch {
    throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_INVALID_${label}_JSON`);
  }
}

function artifactReference(value, label) {
  exactKeys(value, ["path", "sha256"], label);
  const path = String(value.path ?? "").trim();
  const digest = String(value.sha256 ?? "").trim().toLowerCase();
  if (!isAbsolute(path)) {
    throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_${label}_PATH_MUST_BE_ABSOLUTE`);
  }
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_INVALID_${label}_SHA256`);
  }
  return { path, sha256: digest };
}

function validateSafeJson(value, path = "$", depth = 0) {
  if (depth > 32) {
    throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_OUTPUT_TOO_DEEP");
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_OUTPUT_NONFINITE_NUMBER");
    }
    return;
  }
  if (typeof value === "string") {
    if (value.includes("\0") || PRIVATE_KEY_PATTERN.test(value) || BEARER_PATTERN.test(value)) {
      throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_SECRET_VALUE_AT_${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateSafeJson(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_INVALID_OUTPUT_VALUE");
  }
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    if (SECRET_KEY_PATTERN.test(normalized)) {
      throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_SECRET_KEY_AT_${path}.${key}`);
    }
    validateSafeJson(nested, `${path}.${key}`, depth + 1);
  }
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

function validateAdoptionManifest(manifest, connectionId) {
  if (
    manifest?.version !== 3
    || manifest.mode !== "adopt-existing"
    || manifest.active !== false
    || manifest.connectionId !== connectionId
    || manifest.activationAllowed !== false
  ) {
    throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_INVALID_CREDENTIAL_MANIFEST");
  }
  const adoption = manifest.adoption;
  if (
    adoption?.version !== 3
    || adoption.kind !== "AGORA_SHADOW_RECONCILIATION_EVIDENCE"
    || adoption.schemaVersion !== "agora-shadow-v2"
    || adoption.connectionId !== connectionId
    || adoption.reconciliationStatus !== "RECONCILED_EXACT"
    || !SHA256_PATTERN.test(adoption.exportManifestSha256 ?? "")
    || !SHA256_PATTERN.test(adoption.reconciliationManifestSha256 ?? "")
    || !SHA256_PATTERN.test(adoption.reconciliationReportSha256 ?? "")
    || !SHA256_PATTERN.test(adoption.sourceDatasetSha256 ?? "")
    || !SHA256_PATTERN.test(adoption.targetDatasetSha256 ?? "")
    || adoption.sourceDatasetSha256 === adoption.targetDatasetSha256
    || !SHA256_PATTERN.test(adoption.bindingSha256 ?? "")
  ) {
    throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_INVALID_ADOPTION_EVIDENCE");
  }
  const salesEvents = positiveInteger(adoption.watermarks?.salesEvents, "ADOPTION_SALES_EVENTS");
  const salesLineItems = positiveInteger(
    adoption.watermarks?.salesLineItems,
    "ADOPTION_SALES_LINE_ITEMS",
  );
  const maxBusinessDay = canonicalDate(
    adoption.watermarks?.maxBusinessDay,
    "ADOPTION_MAX_BUSINESS_DAY",
  );
  const lastBusinessDaySynced = canonicalDate(
    adoption.watermarks?.lastBusinessDaySynced,
    "ADOPTION_CURSOR_DAY",
  );
  const lastSyncAt = canonicalTimestamp(adoption.watermarks?.lastSyncAt, "ADOPTION_LAST_SYNC_AT").iso;
  const lagDays = (
    Date.parse(`${maxBusinessDay}T00:00:00.000Z`)
    - Date.parse(`${lastBusinessDaySynced}T00:00:00.000Z`)
  ) / (24 * 60 * 60 * 1_000);
  if (!Number.isInteger(lagDays) || lagDays < 0 || lagDays > 1) {
    throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_INVALID_ADOPTION_CURSOR");
  }
  const normalized = {
    ...adoption,
    watermarks: {
      ...adoption.watermarks,
      salesEvents,
      salesLineItems,
      maxBusinessDay,
      lastBusinessDaySynced,
      lastSyncAt,
    },
  };
  if (adoptionBindingSha256(normalized) !== adoption.bindingSha256) {
    throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_ADOPTION_BINDING_MISMATCH");
  }
  return normalized;
}

function validateRows(rows, table, connectionId) {
  if (!Array.isArray(rows)) {
    throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_INVALID_${table.toUpperCase()}_ROWS`);
  }
  const seenIds = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row) || row.connection_id !== connectionId) {
      throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_CONNECTION_MISMATCH");
    }
    if (typeof row.id === "string" && row.id.length > 0) {
      if (seenIds.has(row.id)) {
        throw new Error(`RUNTIME_FLEET_FENCED_TARGET_RAW_DUPLICATE_${table.toUpperCase()}_ID`);
      }
      seenIds.add(row.id);
    }
    validateSafeJson(row, `$.tables.${table}`);
  }
  return rows
    .map((row) => JSON.parse(canonicalJson(row)))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function validateRelationships(tables) {
  const eventIds = new Set(tables.sales_events.map((row) => row.id).filter(Boolean));
  for (const row of tables.sales_line_items) {
    if (row.sales_event_id != null && !eventIds.has(row.sales_event_id)) {
      throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_ORPHAN_SALES_LINE_ITEM");
    }
  }
  for (const row of tables.stock_sync_log) {
    if (row.sales_event_id != null && !eventIds.has(row.sales_event_id)) {
      throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_ORPHAN_STOCK_SYNC_LOG");
    }
  }
}

export function validateFleetFencedTargetRawInput({ input, artifacts }) {
  exactKeys(input, [
    "version",
    "kind",
    "contract",
    "connectionId",
    "target",
    "capturedAt",
    "window",
    "expectedProviderConfigSha256",
    "credentialProvisioningManifest",
    "marker",
    "tables",
  ], "INPUT");
  if (
    input.version !== 1
    || input.kind !== "RUNTIME_FLEET_FENCED_TARGET_RAW_INPUT"
    || input.contract !== "fenced-target-raw-v1"
    || !UUID_PATTERN.test(input.connectionId ?? "")
    || input.connectionId !== input.connectionId.toLowerCase()
    || !IDENTIFIER_PATTERN.test(input.target ?? "")
    || !SHA256_PATTERN.test(input.expectedProviderConfigSha256 ?? "")
  ) {
    throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_INVALID_INPUT_CONTRACT");
  }
  exactKeys(input.window, ["fromBusinessDay", "throughBusinessDay"], "WINDOW");
  exactKeys(input.tables, TABLE_NAMES, "TABLE_REFERENCES");
  const capturedAt = canonicalTimestamp(input.capturedAt, "CAPTURED_AT");
  const fromBusinessDay = canonicalDate(input.window.fromBusinessDay, "FROM_BUSINESS_DAY");
  const throughBusinessDay = canonicalDate(input.window.throughBusinessDay, "THROUGH_BUSINESS_DAY");
  if (fromBusinessDay > throughBusinessDay) {
    throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_INVALID_WINDOW");
  }
  const adoption = validateAdoptionManifest(
    artifacts.credentialProvisioningManifest,
    input.connectionId,
  );
  const markerRows = artifacts.marker;
  if (!Array.isArray(markerRows) || markerRows.length !== 1) {
    throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_MARKER_MISMATCH");
  }
  const marker = markerRows[0];
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
  ], "MARKER");
  if (
    marker.id !== input.connectionId
    || marker.provider !== "agora"
    || marker.enabled !== false
    || marker.catalog_sync_enabled !== false
    || marker.write_mode !== "NONE"
    || !marker.provider_config
    || typeof marker.provider_config !== "object"
    || Array.isArray(marker.provider_config)
  ) {
    throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_MARKER_MISMATCH");
  }
  validateSafeJson(marker, "$.marker[0]");
  const cursorDay = canonicalDate(marker.last_business_day_synced, "CURSOR_DAY");
  const cursorSync = canonicalTimestamp(marker.last_sync_at, "CURSOR_SYNC").iso;
  const markerUpdatedAt = canonicalTimestamp(marker.updated_at, "MARKER_UPDATED_AT");
  if (capturedAt.milliseconds < markerUpdatedAt.milliseconds) {
    throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_CAPTURE_PRECEDES_MARKER");
  }
  if (sha256(canonicalJson(marker.provider_config)) !== input.expectedProviderConfigSha256) {
    throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_PROVIDER_CONFIG_SHA256_MISMATCH");
  }

  const tables = Object.fromEntries(TABLE_NAMES.map((table) => [
    table,
    validateRows(artifacts.tables[table], table, input.connectionId),
  ]));
  validateRelationships(tables);
  positiveInteger(tables.sales_events.length, "EVENT_COUNT");
  positiveInteger(tables.sales_line_items.length, "LINE_COUNT");
  nonnegativeInteger(tables.stock_sync_log.length, "RECEIPT_COUNT");
  nonnegativeInteger(tables.product_mappings.length, "MAPPING_COUNT");
  const businessDays = tables.sales_events.map((row) => (
    canonicalDate(row.business_day, "EVENT_BUSINESS_DAY")
  ));
  if (businessDays.some((day) => day < fromBusinessDay || day > throughBusinessDay)) {
    throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_EVENT_OUTSIDE_WINDOW");
  }
  const maxBusinessDay = businessDays.reduce(
    (latest, current) => current > latest ? current : latest,
    businessDays[0],
  );
  if (
    throughBusinessDay !== adoption.watermarks.maxBusinessDay
    || maxBusinessDay !== adoption.watermarks.maxBusinessDay
    || tables.sales_events.length !== adoption.watermarks.salesEvents
    || tables.sales_line_items.length !== adoption.watermarks.salesLineItems
  ) {
    throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_WATERMARK_MISMATCH");
  }
  if (
    cursorDay !== adoption.watermarks.lastBusinessDaySynced
    || cursorSync !== adoption.watermarks.lastSyncAt
  ) {
    throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_CURSOR_MISMATCH");
  }
  return {
    connectionId: input.connectionId.toLowerCase(),
    target: input.target,
    capturedAt: capturedAt.iso,
    window: { fromBusinessDay, throughBusinessDay },
    marker: [JSON.parse(canonicalJson(marker))],
    tables,
    adoptionBindingSha256: adoption.bindingSha256,
  };
}

export function buildFleetFencedTargetRawArtifact(validated) {
  const artifact = {
    schemaVersion: 2,
    kind: "target-raw-corrected",
    connectionId: validated.connectionId,
    target: validated.target,
    window: validated.window,
    capturedAt: validated.capturedAt,
    marker: validated.marker,
    tables: validated.tables,
  };
  validateSafeJson(artifact);
  return artifact;
}

function validateOutputPath(outputPath) {
  if (!isAbsolute(outputPath)) {
    throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_OUTPUT_PATH_MUST_BE_ABSOLUTE");
  }
  const target = resolve(outputPath);
  if (!isOutsideRepository(target)) {
    throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  if (existsSync(target)) {
    throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_OUTPUT_ALREADY_EXISTS");
  }
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const realParent = realpathSync(parent);
  if (!isOutsideRepository(realParent)) {
    throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  return { target, realParent };
}

function readReferencedArtifacts(input) {
  const credentialReference = artifactReference(
    input.credentialProvisioningManifest,
    "CREDENTIAL_PROVISIONING_MANIFEST",
  );
  const markerReference = artifactReference(input.marker, "MARKER");
  exactKeys(input.tables, TABLE_NAMES, "TABLE_REFERENCES");
  const tableReferences = Object.fromEntries(TABLE_NAMES.map((table) => [
    table,
    artifactReference(input.tables[table], table.toUpperCase()),
  ]));
  return {
    credentialProvisioningManifest: parseJson(readPrivateFile(
      credentialReference.path,
      credentialReference.sha256,
      "CREDENTIAL_PROVISIONING_MANIFEST",
    ), "CREDENTIAL_PROVISIONING_MANIFEST"),
    marker: parseJson(readPrivateFile(
      markerReference.path,
      markerReference.sha256,
      "MARKER",
    ), "MARKER"),
    tables: Object.fromEntries(TABLE_NAMES.map((table) => [
      table,
      parseJson(readPrivateFile(
        tableReferences[table].path,
        tableReferences[table].sha256,
        table.toUpperCase(),
      ), table.toUpperCase()),
    ])),
  };
}

export function fleetFencedTargetRawPlan() {
  return {
    status: "RUNTIME_FLEET_FENCED_TARGET_RAW_PLAN_ONLY",
    contract: "fenced-target-raw-v1",
    remoteMutations: 0,
    activationAllowed: false,
    requiredEnvironment: [
      "RUNTIME_FLEET_FENCED_TARGET_RAW_INPUT",
      "RUNTIME_FLEET_FENCED_TARGET_RAW_EXPECTED_INPUT_SHA256",
      "RUNTIME_FLEET_FENCED_TARGET_RAW_OUTPUT",
    ],
  };
}

export function prepareFleetFencedTargetRaw({
  environment = process.env,
  inputPath,
  expectedInputSha256,
  outputPath,
}) {
  const resolvedInputPath = resolve(
    inputPath ?? required(environment, "RUNTIME_FLEET_FENCED_TARGET_RAW_INPUT"),
  );
  const expectedHash = String(
    expectedInputSha256
      ?? required(environment, "RUNTIME_FLEET_FENCED_TARGET_RAW_EXPECTED_INPUT_SHA256"),
  ).trim().toLowerCase();
  const destination = outputPath ?? required(environment, "RUNTIME_FLEET_FENCED_TARGET_RAW_OUTPUT");
  const inputSource = readPrivateFile(resolvedInputPath, expectedHash, "INPUT");
  const input = parseJson(inputSource, "INPUT");
  const artifacts = readReferencedArtifacts(input);
  const validated = validateFleetFencedTargetRawInput({ input, artifacts });
  const artifact = buildFleetFencedTargetRawArtifact(validated);
  const artifactSource = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  if (artifactSource.length > MAX_INPUT_BYTES) {
    throw new Error("RUNTIME_FLEET_FENCED_TARGET_RAW_OUTPUT_TOO_LARGE");
  }
  const outputSha256 = sha256(artifactSource);
  const { target, realParent } = validateOutputPath(destination);
  const staging = mkdtempSync(join(realParent, `.${basename(target)}.tmp-`));
  chmodSync(staging, 0o700);
  try {
    const stagingPath = join(staging, basename(target));
    writeFileSync(stagingPath, artifactSource, { mode: 0o600, flag: "wx" });
    chmodSync(stagingPath, 0o600);
    linkSync(stagingPath, target);
    unlinkSync(stagingPath);
    rmSync(staging, { recursive: true, force: true });
    return {
      status: "RUNTIME_FLEET_FENCED_TARGET_RAW_READY",
      contract: "fenced-target-raw-v1",
      remoteMutations: 0,
      activationAllowed: false,
      connectionId: validated.connectionId,
      outputPath: target,
      outputSha256,
      inputSha256: expectedHash,
      adoptionBindingSha256: validated.adoptionBindingSha256,
      counts: {
        events: artifact.tables.sales_events.length,
        lines: artifact.tables.sales_line_items.length,
        receipts: artifact.tables.stock_sync_log.length,
        mappings: artifact.tables.product_mappings.length,
      },
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function argument(name) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function main() {
  if (!process.argv.includes("--render")) {
    process.stdout.write(`${JSON.stringify(fleetFencedTargetRawPlan(), null, 2)}\n`);
    return;
  }
  const result = prepareFleetFencedTargetRaw({
    inputPath: argument("--input"),
    expectedInputSha256: argument("--expected-input-sha256"),
    outputPath: argument("--output"),
  });
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
