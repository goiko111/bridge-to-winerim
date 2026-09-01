import { createHash } from "node:crypto";

import {
  BLOCKING_ACTION_TYPES,
  EXCLUDED_SOURCE_TABLES,
  FOREIGN_KEYS,
  POS_CONNECTION_SANITIZATION,
  RESCUE_MERGE_POLICY_VERSION,
  SCHEMA_GAPS,
  SOURCE_TABLES,
  TABLE_DEPENDENCIES,
  TABLE_POLICIES,
} from "./policies.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const WAL_LSN = /^[0-9A-F]+\/[0-9A-F]+$/i;
const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const CREDENTIAL_FIELD = new RegExp(
  POS_CONNECTION_SANITIZATION.credentialFieldPattern,
  POS_CONNECTION_SANITIZATION.credentialFieldFlags,
);
const CONTROLLED_CONNECTION_FIELDS = new Set(POS_CONNECTION_SANITIZATION.controlledCredentialFields);
const BLOCKING_ACTIONS = new Set(BLOCKING_ACTION_TYPES);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseTimestamp(value, label) {
  assert(typeof value === "string", `${label} must be an RFC3339 UTC timestamp`);
  const match = RFC3339_UTC.exec(value);
  assert(match, `${label} must be an RFC3339 UTC timestamp ending in Z`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = ""] = match;
  const components = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const [year, month, day, hour, minute, second] = components;
  const milliseconds = Number(fraction.padEnd(3, "0"));
  assert(month >= 1 && month <= 12
    && day >= 1 && day <= 31
    && hour <= 23
    && minute <= 59
    && second <= 59,
  `${label} must be a valid RFC3339 UTC timestamp`);
  const millis = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds);
  const parsed = new Date(millis);
  assert(parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    && parsed.getUTCHours() === hour
    && parsed.getUTCMinutes() === minute
    && parsed.getUTCSeconds() === second
    && parsed.getUTCMilliseconds() === milliseconds,
  `${label} must be a real calendar timestamp in UTC`);
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

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCanonical(left, right) {
  return compareText(canonicalJson(left), canonicalJson(right));
}

function canonicalTableSide(tables, side) {
  assert(tables && typeof tables === "object" && !Array.isArray(tables), "Tables object is required");
  const projected = {};
  for (const table of Object.keys(tables).sort(compareText)) {
    assert(Array.isArray(tables[table]?.[side]), `${table}.${side} must be an array`);
    projected[table] = tables[table][side]
      .map((row) => structuredClone(row))
      .sort(compareCanonical);
  }
  return {
    schemaVersion: 1,
    side,
    tables: projected,
  };
}

export function rescueMergeSourcePayloadSha256(tables) {
  return sha256(canonicalJson(canonicalTableSide(tables, "source")));
}

function rescueMergeTargetRowsSha256(tables) {
  return sha256(canonicalJson(canonicalTableSide(tables, "target")));
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

function timestampFrom(row, columns, label) {
  let selected = null;
  for (const column of columns || []) {
    if (row[column] === null || row[column] === undefined || row[column] === "") continue;
    const millis = parseTimestamp(row[column], `${label}.${column}`);
    if (!selected || millis > selected.millis) selected = { column, millis, value: row[column] };
  }
  return selected;
}

function validateConfiguredTimestamps(rows, policy, label) {
  const columns = [...new Set([
    ...(policy.boundaryColumns || []),
    ...(policy.freshnessColumns || []),
  ])];
  rows.forEach((row, index) => timestampFrom(row, columns, `${label}[${index}]`));
}

export const REVIEWED_POLICY_CONTRACT = Object.freeze({
  version: RESCUE_MERGE_POLICY_VERSION,
  excludedSourceTables: EXCLUDED_SOURCE_TABLES,
  sourceTables: SOURCE_TABLES,
  tablePolicies: TABLE_POLICIES,
  tableDependencies: TABLE_DEPENDENCIES,
  foreignKeys: FOREIGN_KEYS,
  blockingActionTypes: BLOCKING_ACTION_TYPES,
  posConnectionSanitization: POS_CONNECTION_SANITIZATION,
  timestampSelection: "maximum-valid-configured-timestamp",
  rowOrdering: "canonical-json-code-unit-order",
  targetDuplicateHandling: "block-and-bind-every-duplicate-identity",
});

export const REVIEWED_POLICY_SHA256 = sha256(canonicalJson(REVIEWED_POLICY_CONTRACT));

export function sanitizePosConnection(row) {
  assert(row && typeof row === "object" && !Array.isArray(row), "pos_connections row must be an object");
  for (const field of Object.keys(row)) {
    if (CREDENTIAL_FIELD.test(field) && !CONTROLLED_CONNECTION_FIELDS.has(field)) {
      throw new Error(`Unreviewed credential-like pos_connections field: ${field}`);
    }
  }
  return {
    ...row,
    ...structuredClone(POS_CONNECTION_SANITIZATION.overrides),
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
  const sourceSnapshotAt = parseTimestamp(context.source.snapshotAt, "source.snapshotAt");
  assert(WAL_LSN.test(context.source?.watermark?.walLsn || ""), "Source WAL watermark is required");
  assert(SHA256.test(context.source?.watermark?.snapshotIdSha256 || ""), "Source snapshot identifier digest is required");
  assert(SHA256.test(context.source?.watermark?.databaseIdentitySha256 || ""), "Source database identity digest is required");
  assert(parseTimestamp(context.source?.watermark?.capturedAt, "source.watermark.capturedAt") === sourceSnapshotAt,
    "Source watermark must be captured by the source snapshot");
  assert(context.target?.isolationLevel === "REPEATABLE READ", "Target comparison must use REPEATABLE READ");
  assert(context.target?.readOnly === true, "Target comparison must be read only");
  assert(context.target?.exportedSnapshot === true, "Target comparison must use one exported snapshot");
  const targetSnapshotAt = parseTimestamp(context.target.snapshotAt, "target.snapshotAt");
  assert(WAL_LSN.test(context.target?.watermark?.walLsn || ""), "Target WAL watermark is required");
  assert(SHA256.test(context.target?.watermark?.snapshotIdSha256 || ""), "Target snapshot identifier digest is required");
  assert(SHA256.test(context.target?.watermark?.databaseIdentitySha256 || ""), "Target database identity digest is required");
  assert(parseTimestamp(context.target?.watermark?.capturedAt, "target.watermark.capturedAt") === targetSnapshotAt,
    "Target watermark must be captured by the target snapshot");
  assert(context.source.watermark.databaseIdentitySha256 !== context.target.watermark.databaseIdentitySha256,
    "Source and target database identities must differ");
  const cutoverAt = parseTimestamp(context.cutoverAt, "cutoverAt");
  const plannedAt = parseTimestamp(context.plannedAt, "plannedAt");
  assert(cutoverAt <= sourceSnapshotAt, "cutoverAt must not be later than source.snapshotAt");
  assert(sourceSnapshotAt <= targetSnapshotAt, "source.snapshotAt must not be later than target.snapshotAt");
  assert(targetSnapshotAt <= plannedAt, "target.snapshotAt must not be later than plannedAt");
  assert(context.artifact?.storageClass === "external-encrypted", "Artifact must use external encrypted storage");
  assert(context.artifact?.encrypted === true, "Artifact encryption must be verified");
  assert(SHA256.test(context.artifact?.manifestSha256 || ""), "Artifact manifest SHA-256 is required");
  assert(SHA256.test(context.artifact?.payloadSha256 || ""), "Artifact payload SHA-256 is required");
  assert(context.artifact?.reviewedPolicyVersion === RESCUE_MERGE_POLICY_VERSION,
    "Artifact reviewed policy version does not match this planner");
  assert(SHA256.test(context.artifact?.reviewedPolicySha256 || ""),
    "Artifact reviewed policy SHA-256 is required");
  assert(context.artifact.reviewedPolicySha256 === REVIEWED_POLICY_SHA256,
    "Artifact reviewed policy digest does not match this planner");
  assert(!("databaseUrl" in context.source), "Source database URL must not enter the plan");
  assert(!("databaseUrl" in context.target), "Target database URL must not enter the plan");
  return context;
}

function arraysEqual(left, right) {
  return canonicalJson([...left].sort()) === canonicalJson([...right].sort());
}

function validatePlanScope(context, requestedTables) {
  const scope = context.scope || { mode: "full" };
  if (scope.mode === "full") {
    assert(arraysEqual(requestedTables, SOURCE_TABLES), "Full merge plan must contain every reviewed source table");
    return { mode: "full", tables: [...SOURCE_TABLES].sort() };
  }
  assert(scope.mode === "dependency-closed", "Plan scope must be full or dependency-closed");
  assert(Array.isArray(scope.tables) && arraysEqual(scope.tables, requestedTables),
    "Dependency-closed scope must exactly match requested tables");
  const requested = new Set(requestedTables);
  for (const table of requestedTables) {
    for (const dependency of TABLE_DEPENDENCIES[table] || []) {
      assert(requested.has(dependency), `Dependency-closed scope for ${table} is missing ${dependency}`);
    }
  }
  return { mode: "dependency-closed", tables: [...requestedTables].sort() };
}

function topologicalTables(requestedTables) {
  const requested = new Set(requestedTables);
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  const visit = (table) => {
    if (visited.has(table)) return;
    assert(!visiting.has(table), `Dependency cycle detected at ${table}`);
    visiting.add(table);
    for (const dependency of TABLE_DEPENDENCIES[table] || []) {
      if (requested.has(dependency)) visit(dependency);
    }
    visiting.delete(table);
    visited.add(table);
    ordered.push(table);
  };
  for (const table of [...requestedTables].sort()) visit(table);
  return ordered;
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

function tablePlan(table, rawSourceRows, rawTargetRows, policy, cutoverMillis, foreignKeyIssues = new Map()) {
  const sourceRows = rawSourceRows.map((row) => sanitizeSourceRow(table, row)).sort(compareCanonical);
  const targetRows = rawTargetRows.map((row) => structuredClone(row)).sort(compareCanonical);
  validateConfiguredTimestamps(sourceRows, policy, `${table}.source`);
  validateConfiguredTimestamps(targetRows, policy, `${table}.target`);
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
  const resolutions = new Map();
  const recordedDuplicate = new Set();

  for (const target of targetRows) {
    const targetPk = keyFor(target, policy.primaryKey);
    const targetNatural = keyFor(target, policy.naturalKey);
    const duplicatePrimary = targetPk && targetDuplicatePks.has(targetPk);
    const duplicateNatural = targetNatural && targetDuplicateNaturals.has(targetNatural);
    if (!duplicatePrimary && !duplicateNatural) continue;
    const repeatedIdentities = [
      duplicatePrimary ? "primary key" : null,
      duplicateNatural ? "natural key" : null,
    ].filter(Boolean).join(" and ");
    actions.push(action({
      table,
      type: "TARGET_DUPLICATE_KEY",
      target,
      policy,
      reason: `Target repeats a reviewed ${repeatedIdentities}; every duplicate row is bound into the blocked plan.`,
    }));
  }

  for (const source of sourceRows) {
    const sourcePk = keyFor(source, policy.primaryKey);
    const sourceNatural = keyFor(source, policy.naturalKey);
    assert(sourcePk, `${table} source row is missing primary key fields`);

    const rowForeignKeyIssues = foreignKeyIssues.get(sourcePk) || [];
    if (rowForeignKeyIssues.length) {
      actions.push(action({
        table,
        type: "UNRESOLVED_FOREIGN_KEY",
        source,
        policy,
        reason: rowForeignKeyIssues.map(({ column, referencesTable }) => `${column}->${referencesTable}`).join(", "),
      }));
      continue;
    }

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
        resolutions.set(sourcePk, targetPk);
        continue;
      }
      const sourceFreshness = timestampFrom(source, policy.freshnessColumns, `${table}.source`);
      const targetFreshness = timestampFrom(target, policy.freshnessColumns, `${table}.target`);
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

    if (policy.mode === "identity-required") {
      actions.push(action({
        table,
        type: "CONNECTION_IDENTITY_UNRESOLVED",
        source,
        policy,
        reason: "Source connection UUID has no exact target correspondence; automatic insertion is forbidden.",
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
    const boundary = timestampFrom(source, policy.boundaryColumns, `${table}.source`);
    if (!boundary) {
      actions.push(action({ table, type: "MISSING_SOURCE_WATERMARK", source, policy, reason: "Row has no reviewed timestamp for cutover classification." }));
      continue;
    }
    if (boundary.millis > cutoverMillis) {
      actions.push(action({ table, type: "SOURCE_AFTER_CUTOVER_REVIEW", source, policy, reason: `${boundary.column} is after the explicit cutover.` }));
      continue;
    }
    actions.push(action({ table, type: "INSERT_MISSING", source, policy, reason: "Row is absent in target and belongs to the pre-cutover source window." }));
    resolutions.set(sourcePk, sourcePk);
  }

  for (const target of targetRows) {
    if (matchedTargetRows.has(target)) continue;
    const targetPk = keyFor(target, policy.primaryKey);
    const targetNatural = keyFor(target, policy.naturalKey);
    if ((targetPk && targetPkIndex.get(targetPk)?.length > 1)
        || (targetNatural && targetNaturalIndex.get(targetNatural)?.length > 1)) continue;
    actions.push(action({ table, type: "KEEP_TARGET_ONLY", target, policy, reason: "Target-only rows are never deleted or replaced." }));
  }

  return { actions, aliases, resolutions };
}

function prepareForeignKeys(table, rows, allTables, policies, resolutionsByTable) {
  const policy = policies[table];
  const preparedRows = rows.map((row) => structuredClone(row));
  const issues = new Map();
  const rewrites = [];
  for (const row of preparedRows) {
    const rowPk = keyFor(row, policy.primaryKey);
    assert(rowPk, `${table} source row is missing primary key fields`);
    for (const foreignKey of FOREIGN_KEYS[table] || []) {
      const value = row[foreignKey.column];
      if (value === null || value === undefined || value === "") {
        if (!foreignKey.nullable) {
          const current = issues.get(rowPk) || [];
          current.push(foreignKey);
          issues.set(rowPk, current);
        }
        continue;
      }
      const parentPolicy = policies[foreignKey.referencesTable];
      assert(parentPolicy.primaryKey.length === 1,
        `Foreign-key propagation only supports one-column parent keys: ${foreignKey.referencesTable}`);
      const sourceParentKey = canonicalJson([value]);
      const parentResolution = resolutionsByTable.get(foreignKey.referencesTable)?.get(sourceParentKey) || null;
      if (parentResolution) {
        const [resolvedValue] = JSON.parse(parentResolution);
        if (resolvedValue !== value) {
          rewrites.push({
            table,
            sourcePrimaryKey: JSON.parse(rowPk),
            column: foreignKey.column,
            referencesTable: foreignKey.referencesTable,
            sourceValue: value,
            targetValue: resolvedValue,
          });
          row[foreignKey.column] = resolvedValue;
        }
        continue;
      }
      const parentRows = allTables[foreignKey.referencesTable];
      const parentSourceKeys = new Set(parentRows.source.map((parent) => keyFor(parent, parentPolicy.primaryKey)));
      const parentTargetKeys = new Set(parentRows.target.map((parent) => keyFor(parent, parentPolicy.primaryKey)));
      if (!parentSourceKeys.has(sourceParentKey) && parentTargetKeys.has(sourceParentKey)) continue;
      const current = issues.get(rowPk) || [];
      current.push(foreignKey);
      issues.set(rowPk, current);
    }
  }
  return { preparedRows, issues, rewrites };
}

export function planRescueMerge({ context, tables, ...unsupportedOptions }) {
  assert(!Object.prototype.hasOwnProperty.call(unsupportedOptions, "policies"),
    "Caller-supplied merge policies are forbidden");
  assert(Object.keys(unsupportedOptions).length === 0, "Unsupported rescue merge planner option");
  const policies = TABLE_POLICIES;
  validateMergeContext(context);
  assert(tables && typeof tables === "object" && !Array.isArray(tables), "Tables object is required");
  const requestedTables = Object.keys(tables).sort(compareText);
  for (const table of requestedTables) {
    if (EXCLUDED_SOURCE_TABLES.includes(table)) throw new Error(`${table} is excluded from Lovable exports`);
    assert(policies[table], `No reviewed merge policy for table: ${table}`);
    assert(Array.isArray(tables[table]?.source), `${table}.source must be an array`);
    assert(Array.isArray(tables[table]?.target), `${table}.target must be an array`);
  }
  const scope = validatePlanScope(context, requestedTables);
  const sourcePayloadSha256 = rescueMergeSourcePayloadSha256(tables);
  assert(context.artifact.payloadSha256 === sourcePayloadSha256,
    "Artifact payload SHA-256 does not match the canonical source tables supplied to the planner");
  const targetRowsSha256 = rescueMergeTargetRowsSha256(tables);

  const cutoverMillis = parseTimestamp(context.cutoverAt, "cutoverAt");
  const actions = [];
  const identityAliases = [];
  const foreignKeyRewrites = [];
  const resolutionsByTable = new Map();
  for (const table of topologicalTables(requestedTables)) {
    const prepared = prepareForeignKeys(table, tables[table].source, tables, policies, resolutionsByTable);
    const result = tablePlan(
      table,
      prepared.preparedRows,
      tables[table].target,
      policies[table],
      cutoverMillis,
      prepared.issues,
    );
    actions.push(...result.actions);
    identityAliases.push(...result.aliases);
    foreignKeyRewrites.push(...prepared.rewrites);
    resolutionsByTable.set(table, result.resolutions);
  }

  actions.sort(compareCanonical);
  identityAliases.sort(compareCanonical);
  foreignKeyRewrites.sort(compareCanonical);
  const counts = actions.reduce((summary, item) => {
    summary[item.type] = (summary[item.type] || 0) + 1;
    return summary;
  }, {});
  const blockers = actions.filter((item) => BLOCKING_ACTIONS.has(item.type));
  const artifactBindingSha256 = sha256(canonicalJson({
    artifactManifestSha256: context.artifact.manifestSha256,
    artifactPayloadSha256: context.artifact.payloadSha256,
    reviewedPolicyVersion: RESCUE_MERGE_POLICY_VERSION,
    reviewedPolicySha256: REVIEWED_POLICY_SHA256,
    cutoverAt: context.cutoverAt,
    requestedTables,
    scope,
    sourceSnapshotAt: context.source.snapshotAt,
    sourceWatermark: context.source.watermark,
    sourcePayloadSha256,
  }));
  const unsigned = {
    schemaVersion: 4,
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
    artifactPayloadSha256: context.artifact.payloadSha256,
    sourcePayloadSha256,
    targetRowsSha256,
    artifactBindingSha256,
    reviewedPolicyVersion: RESCUE_MERGE_POLICY_VERSION,
    reviewedPolicySha256: REVIEWED_POLICY_SHA256,
    scope,
    requestedTables,
    counts,
    actions,
    identityAliases,
    foreignKeyRewrites,
    blockers: blockers.map(({ table, type, sourcePrimaryKey, targetPrimaryKey, naturalKeySha256, sourceSha256, targetSha256, reason }) => ({
      table,
      type,
      sourcePrimaryKey,
      targetPrimaryKey,
      naturalKeySha256,
      sourceSha256,
      targetSha256,
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
  confirmArtifactPayloadSha256 = null,
  targetSnapshot = null,
} = {}) {
  const blockers = [];
  if (!apply) blockers.push("APPLY_FLAG_NOT_SET");
  if (plan.mode !== "dry-run") blockers.push("PLAN_WAS_NOT_DRY_RUN");
  if (!plan.mergeSafe) blockers.push("PLAN_HAS_CONFLICTS_OR_MANUAL_ROWS");
  if (!SHA256.test(confirmPlanSha256 || "") || confirmPlanSha256 !== plan.planSha256) {
    blockers.push("PLAN_DIGEST_NOT_CONFIRMED");
  }
  if (!SHA256.test(confirmArtifactPayloadSha256 || "")
      || confirmArtifactPayloadSha256 !== plan.artifactPayloadSha256) {
    blockers.push("ARTIFACT_PAYLOAD_NOT_CONFIRMED");
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
  blockers.push("VERIFIED_APPLY_EXECUTOR_NOT_IMPLEMENTED");
  return {
    ready: false,
    mode: "APPLY_GATE_BLOCKED",
    blockers,
  };
}
