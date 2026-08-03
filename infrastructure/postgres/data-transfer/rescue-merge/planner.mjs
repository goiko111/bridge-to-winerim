import { createHash } from "node:crypto";

import {
  EXCLUDED_SOURCE_TABLES,
  SCHEMA_GAPS,
  TABLE_POLICIES,
} from "./policies.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const WAL_LSN = /^[0-9A-F]+\/[0-9A-F]+$/i;
const CREDENTIAL_FIELD = /(?:token|secret|password|credential|authorization|bearer|api[_-]?key|dsn|(?:^|_)url(?:_|$)|endpoint|provider_config|restaurant_guid)/i;
const CONTROLLED_CONNECTION_FIELDS = new Set([
  "api_token",
  "base_url",
  "catalog_endpoint",
  "provider_config",
  "restaurant_guid",
  "winerim_api_token",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseTimestamp(value, label) {
  const millis = Date.parse(value);
  assert(Number.isFinite(millis), `${label} must be an ISO timestamp`);
  return millis;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function rowDigest(row) {
  return sha256(canonicalJson(row));
}

function keyFor(row, fields) {
  if (!fields?.length) return null;
  const values = fields.map((field) => row[field]);
  if (values.some((value) => value === null || value === undefined || value === "")) return null;
  return canonicalJson(values);
}

function publicKey(key) {
  return key ? sha256(key) : null;
}

function semanticRow(row, policy) {
  const ignored = new Set(policy.compareIgnore || []);
  return Object.fromEntries(Object.entries(row).filter(([key]) => !ignored.has(key)));
}

function semanticDigest(row, policy) {
  return rowDigest(semanticRow(row, policy));
}

function timestampFrom(row, columns) {
  for (const column of columns || []) {
    if (row[column] === null || row[column] === undefined || row[column] === "") continue;
    const millis = Date.parse(row[column]);
    if (Number.isFinite(millis)) return { column, millis, value: row[column] };
  }
  return null;
}

export function sanitizePosConnection(row) {
  assert(row && typeof row === "object" && !Array.isArray(row), "pos_connections row must be an object");
  for (const field of Object.keys(row)) {
    if (CREDENTIAL_FIELD.test(field) && !CONTROLLED_CONNECTION_FIELDS.has(field)) {
      throw new Error(`Unreviewed credential-like pos_connections field: ${field}`);
    }
  }
  return {
    ...row,
    api_token: "",
    auto_create_families: false,
    auto_push_bottle: false,
    auto_push_glass: false,
    auto_push_on_create: false,
    auto_push_on_update: false,
    auto_push_verified_ready: false,
    base_url: "https://redacted.invalid",
    catalog_endpoint: null,
    catalog_sync_enabled: false,
    circuit_breaker_paused_until: null,
    circuit_breaker_reason: null,
    consecutive_failures: 0,
    enabled: false,
    last_business_day_synced: null,
    last_catalog_sync_at: null,
    last_sync_at: null,
    provider_config: {},
    restaurant_guid: null,
    selected_sale_center_ids: [],
    sync_mode: "PULL_ONLY",
    winerim_api_token: null,
    write_bottle: false,
    write_glass: false,
    write_mode: "NONE",
  };
}

function sanitizeSourceRow(table, row) {
  return table === "pos_connections" ? sanitizePosConnection(row) : structuredClone(row);
}

export function validateMergeContext(context) {
  assert(context && typeof context === "object", "Merge context is required");
  assert(context.source?.environment === "lovable-production", "Source must be lovable-production");
  assert(context.target?.environment === "rescue-production", "Target must be rescue-production");
  assert(context.source?.isolationLevel === "REPEATABLE READ", "Source export must use REPEATABLE READ");
  assert(context.source?.readOnly === true, "Source export must be read only");
  assert(context.source?.exportedSnapshot === true, "Source export must use one exported snapshot");
  parseTimestamp(context.source.snapshotAt, "source.snapshotAt");
  assert(WAL_LSN.test(context.source?.watermark?.walLsn || ""), "Source WAL watermark is required");
  assert(SHA256.test(context.source?.watermark?.snapshotIdSha256 || ""), "Source snapshot identifier digest is required");
  assert(context.target?.isolationLevel === "REPEATABLE READ", "Target comparison must use REPEATABLE READ");
  assert(context.target?.readOnly === true, "Target comparison must be read only");
  assert(context.target?.exportedSnapshot === true, "Target comparison must use one exported snapshot");
  parseTimestamp(context.target.snapshotAt, "target.snapshotAt");
  assert(WAL_LSN.test(context.target?.watermark?.walLsn || ""), "Target WAL watermark is required");
  assert(SHA256.test(context.target?.watermark?.snapshotIdSha256 || ""), "Target snapshot identifier digest is required");
  parseTimestamp(context.cutoverAt, "cutoverAt");
  parseTimestamp(context.plannedAt, "plannedAt");
  assert(context.artifact?.storageClass === "external-encrypted", "Artifact must use external encrypted storage");
  assert(context.artifact?.encrypted === true, "Artifact encryption must be verified");
  assert(SHA256.test(context.artifact?.manifestSha256 || ""), "Artifact manifest SHA-256 is required");
  assert(SHA256.test(context.artifact?.payloadSha256 || ""), "Artifact payload SHA-256 is required");
  assert(!("databaseUrl" in context.source), "Source database URL must not enter the plan");
  assert(!("databaseUrl" in context.target), "Target database URL must not enter the plan");
  return context;
}

function duplicateIndexes(rows, keyFields) {
  const index = new Map();
  for (const row of rows) {
    const key = keyFor(row, keyFields);
    if (!key) continue;
    const existing = index.get(key) || [];
    existing.push(row);
    index.set(key, existing);
  }
  return index;
}

function duplicateKeys(index) {
  return new Set([...index.entries()].filter(([, rows]) => rows.length > 1).map(([key]) => key));
}

function action({ table, type, source = null, target = null, policy, reason }) {
  const sourcePrimary = source ? keyFor(source, policy.primaryKey) : null;
  const targetPrimary = target ? keyFor(target, policy.primaryKey) : null;
  const natural = source ? keyFor(source, policy.naturalKey) : target ? keyFor(target, policy.naturalKey) : null;
  return {
    table,
    type,
    sourcePrimaryKey: sourcePrimary ? JSON.parse(sourcePrimary) : null,
    targetPrimaryKey: targetPrimary ? JSON.parse(targetPrimary) : null,
    naturalKeySha256: publicKey(natural),
    sourceSha256: source ? semanticDigest(source, policy) : null,
    targetSha256: target ? semanticDigest(target, policy) : null,
    reason,
  };
}

function tablePlan(table, rawSourceRows, rawTargetRows, policy, cutoverMillis) {
  const sourceRows = rawSourceRows.map((row) => sanitizeSourceRow(table, row));
  const targetRows = rawTargetRows.map((row) => structuredClone(row));
  const sourcePkIndex = duplicateIndexes(sourceRows, policy.primaryKey);
  const targetPkIndex = duplicateIndexes(targetRows, policy.primaryKey);
  const sourceNaturalIndex = duplicateIndexes(sourceRows, policy.naturalKey);
  const targetNaturalIndex = duplicateIndexes(targetRows, policy.naturalKey);
  const sourceDuplicatePks = duplicateKeys(sourcePkIndex);
  const targetDuplicatePks = duplicateKeys(targetPkIndex);
  const sourceDuplicateNaturals = duplicateKeys(sourceNaturalIndex);
  const targetDuplicateNaturals = duplicateKeys(targetNaturalIndex);
  const actions = [];
  const matchedTargetRows = new Set();
  const aliases = [];
  const recordedDuplicate = new Set();

  for (const source of sourceRows) {
    const sourcePk = keyFor(source, policy.primaryKey);
    const sourceNatural = keyFor(source, policy.naturalKey);
    assert(sourcePk, `${table} source row is missing primary key fields`);

    if (sourceDuplicatePks.has(sourcePk)) {
      const marker = `source-pk:${sourcePk}`;
      if (!recordedDuplicate.has(marker)) {
        actions.push(action({ table, type: "SOURCE_DUPLICATE_PRIMARY_KEY", source, policy, reason: "Source artifact repeats a primary key." }));
        recordedDuplicate.add(marker);
      }
      continue;
    }
    if (sourceNatural && sourceDuplicateNaturals.has(sourceNatural)) {
      const marker = `source-natural:${sourceNatural}`;
      if (!recordedDuplicate.has(marker)) {
        actions.push(action({ table, type: "SOURCE_DUPLICATE_NATURAL_KEY", source, policy, reason: "Source artifact repeats a natural key." }));
        recordedDuplicate.add(marker);
      }
      continue;
    }

    let target = targetPkIndex.get(sourcePk)?.[0] || null;
    if (!target && sourceNatural) target = targetNaturalIndex.get(sourceNatural)?.[0] || null;
    if (target) {
      const targetPk = keyFor(target, policy.primaryKey);
      const targetNatural = keyFor(target, policy.naturalKey);
      if (targetDuplicatePks.has(targetPk) || (targetNatural && targetDuplicateNaturals.has(targetNatural))) {
        actions.push(action({ table, type: "TARGET_DUPLICATE_KEY", source, target, policy, reason: "Target contains more than one row for this identity." }));
        continue;
      }
      matchedTargetRows.add(target);
      if (semanticDigest(source, policy) === semanticDigest(target, policy)) {
        actions.push(action({ table, type: "IDENTICAL_NOOP", source, target, policy, reason: "Source and target are semantically identical." }));
        if (sourcePk !== targetPk) {
          aliases.push({
            table,
            sourcePrimaryKey: JSON.parse(sourcePk),
            targetPrimaryKey: JSON.parse(targetPk),
            naturalKeySha256: publicKey(sourceNatural),
          });
        }
        continue;
      }
      const sourceFreshness = timestampFrom(source, policy.freshnessColumns);
      const targetFreshness = timestampFrom(target, policy.freshnessColumns);
      const targetIsNewer = sourceFreshness && targetFreshness && targetFreshness.millis > sourceFreshness.millis;
      actions.push(action({
        table,
        type: targetIsNewer ? "PROTECT_TARGET_NEWER" : "CONFLICT_SOURCE_TARGET",
        source,
        target,
        policy,
        reason: targetIsNewer
          ? `Target ${targetFreshness.column} is newer; source is never allowed to overwrite it.`
          : "Rows share an identity but differ; automatic overwrite is forbidden.",
      }));
      continue;
    }

    if (policy.mode === "manual-review-only") {
      actions.push(action({ table, type: "MANUAL_REVIEW_REQUIRED", source, policy, reason: policy.reason }));
      continue;
    }
    if (policy.requireNaturalKeyForInsert && !sourceNatural) {
      actions.push(action({ table, type: "MISSING_NATURAL_KEY", source, policy, reason: "Automatic insert needs a complete natural key." }));
      continue;
    }
    const boundary = timestampFrom(source, policy.boundaryColumns);
    if (!boundary) {
      actions.push(action({ table, type: "MISSING_SOURCE_WATERMARK", source, policy, reason: "Row has no reviewed timestamp for cutover classification." }));
      continue;
    }
    if (boundary.millis > cutoverMillis) {
      actions.push(action({ table, type: "SOURCE_AFTER_CUTOVER_REVIEW", source, policy, reason: `${boundary.column} is after the explicit cutover.` }));
      continue;
    }
    actions.push(action({ table, type: "INSERT_MISSING", source, policy, reason: "Row is absent in target and belongs to the pre-cutover source window." }));
  }

  for (const target of targetRows) {
    if (matchedTargetRows.has(target)) continue;
    const targetPk = keyFor(target, policy.primaryKey);
    const targetNatural = keyFor(target, policy.naturalKey);
    if ((targetPk && targetPkIndex.get(targetPk)?.length > 1)
        || (targetNatural && targetNaturalIndex.get(targetNatural)?.length > 1)) continue;
    actions.push(action({ table, type: "KEEP_TARGET_ONLY", target, policy, reason: "Target-only rows are never deleted or replaced." }));
  }

  return { actions, aliases };
}

const BLOCKING_ACTIONS = new Set([
  "CONFLICT_SOURCE_TARGET",
  "MANUAL_REVIEW_REQUIRED",
  "MISSING_NATURAL_KEY",
  "MISSING_SOURCE_WATERMARK",
  "PROTECT_TARGET_NEWER",
  "SOURCE_AFTER_CUTOVER_REVIEW",
  "SOURCE_DUPLICATE_NATURAL_KEY",
  "SOURCE_DUPLICATE_PRIMARY_KEY",
  "TARGET_DUPLICATE_KEY",
]);

export function planRescueMerge({ context, tables, policies = TABLE_POLICIES }) {
  validateMergeContext(context);
  assert(tables && typeof tables === "object" && !Array.isArray(tables), "Tables object is required");
  const requestedTables = Object.keys(tables).sort();
  for (const table of requestedTables) {
    if (EXCLUDED_SOURCE_TABLES.includes(table)) throw new Error(`${table} is excluded from Lovable exports`);
    assert(policies[table], `No reviewed merge policy for table: ${table}`);
    assert(Array.isArray(tables[table]?.source), `${table}.source must be an array`);
    assert(Array.isArray(tables[table]?.target), `${table}.target must be an array`);
  }

  const cutoverMillis = parseTimestamp(context.cutoverAt, "cutoverAt");
  const actions = [];
  const identityAliases = [];
  for (const table of requestedTables) {
    const result = tablePlan(table, tables[table].source, tables[table].target, policies[table], cutoverMillis);
    actions.push(...result.actions);
    identityAliases.push(...result.aliases);
  }

  actions.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  identityAliases.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const counts = actions.reduce((summary, item) => {
    summary[item.type] = (summary[item.type] || 0) + 1;
    return summary;
  }, {});
  const blockers = actions.filter((item) => BLOCKING_ACTIONS.has(item.type));
  const unsigned = {
    schemaVersion: 1,
    mode: "dry-run",
    sourceEnvironment: context.source.environment,
    targetEnvironment: context.target.environment,
    cutoverAt: context.cutoverAt,
    plannedAt: context.plannedAt,
    sourceSnapshotAt: context.source.snapshotAt,
    sourceWatermark: context.source.watermark,
    targetSnapshotAt: context.target.snapshotAt,
    targetWatermark: context.target.watermark,
    artifactManifestSha256: context.artifact.manifestSha256,
    targetSnapshot: context.targetSnapshot || null,
    requestedTables,
    counts,
    actions,
    identityAliases,
    blockers: blockers.map(({ table, type, sourcePrimaryKey, naturalKeySha256, reason }) => ({
      table,
      type,
      sourcePrimaryKey,
      naturalKeySha256,
      reason,
    })),
    mergeSafe: blockers.length === 0,
    schemaGaps: SCHEMA_GAPS,
  };
  return { ...unsigned, planSha256: sha256(canonicalJson(unsigned)) };
}

export function evaluateApplyGate(plan, {
  apply = false,
  confirmPlanSha256 = null,
  targetSnapshot = null,
} = {}) {
  const blockers = [];
  if (!apply) blockers.push("APPLY_FLAG_NOT_SET");
  if (plan.mode !== "dry-run") blockers.push("PLAN_WAS_NOT_DRY_RUN");
  if (!plan.mergeSafe) blockers.push("PLAN_HAS_CONFLICTS_OR_MANUAL_ROWS");
  if (!SHA256.test(confirmPlanSha256 || "") || confirmPlanSha256 !== plan.planSha256) {
    blockers.push("PLAN_DIGEST_NOT_CONFIRMED");
  }
  const targetSnapshotTime = Date.parse(targetSnapshot?.capturedAt || "");
  const plannedAt = Date.parse(plan.plannedAt);
  if (targetSnapshot?.environment !== "rescue-production"
      || !targetSnapshot?.restorable
      || !targetSnapshot?.restoreTested
      || !SHA256.test(targetSnapshot?.manifestSha256 || "")
      || !Number.isFinite(targetSnapshotTime)
      || targetSnapshotTime < plannedAt
      || targetSnapshot?.conflictRecheckPlanSha256 !== plan.planSha256) {
    blockers.push("RESTORABLE_TARGET_SNAPSHOT_REQUIRED");
  }
  return {
    ready: blockers.length === 0,
    mode: blockers.length === 0 ? "APPLY_GATE_OPEN" : "APPLY_GATE_CLOSED",
    blockers,
  };
}
