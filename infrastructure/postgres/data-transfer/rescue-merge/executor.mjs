import {
  canonicalJson,
  planRescueMerge,
  sha256,
} from "./planner.mjs";
import {
  FOREIGN_KEYS,
  TABLE_DEPENDENCIES,
  TABLE_POLICIES,
} from "./policies.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MAX_BACKUP_AGE_MS = 24 * 60 * 60 * 1000;

export const APPLY_CONFIRMATION = "APPLY_INSERT_MISSING_ONLY_TO_RESCUE_PRODUCTION";
export const ADVISORY_LOCK_NAMESPACE = "infrastructure/postgres/data-transfer/rescue-merge";
export const FORBIDDEN_APPLY_TABLES = Object.freeze([
  "outbound_tasks",
  "provider_credentials",
  "runtime_canary_connections",
  "runtime_connection_credentials",
  "runtime_execution_log",
  "runtime_idempotency",
]);

const FORBIDDEN_TABLE_SET = new Set(FORBIDDEN_APPLY_TABLES);
const CREDENTIAL_FIELD = /(?:token|secret|password|authorization|bearer|credential|api[_-]?key)/i;

export class RescueMergeError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "RescueMergeError";
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new RescueMergeError(code, message);
}

function assert(condition, code, message = code) {
  if (!condition) fail(code, message);
}

function clone(value) {
  return structuredClone(value);
}

function parseTimestamp(value, code) {
  assert(typeof value === "string" && RFC3339_UTC.test(value), code);
  const millis = Date.parse(value);
  assert(Number.isFinite(millis), code);
  return millis;
}

function primaryKeyFor(table, row) {
  const fields = TABLE_POLICIES[table]?.primaryKey || [];
  const values = fields.map((field) => row[field]);
  if (!fields.length || values.some((value) => value === null || value === undefined || value === "")) return null;
  return canonicalJson(values);
}

function semanticDigest(table, row) {
  const ignored = new Set(TABLE_POLICIES[table]?.compareIgnore || []);
  const semantic = Object.fromEntries(Object.entries(row).filter(([key]) => !ignored.has(key)));
  return sha256(canonicalJson(semantic));
}

function hasCredentialMaterial(value, path = []) {
  if (Array.isArray(value)) {
    return value.some((item, index) => hasCredentialMaterial(item, [...path, String(index)]));
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = [...path, key];
    if (CREDENTIAL_FIELD.test(key)) return nestedPath.join(".");
    const found = hasCredentialMaterial(nested, nestedPath);
    if (found) return found;
  }
  return null;
}

function topologicalTables(tables) {
  const requested = new Set(tables);
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  const visit = (table) => {
    if (visited.has(table)) return;
    assert(!visiting.has(table), "DEPENDENCY_CYCLE");
    visiting.add(table);
    for (const dependency of TABLE_DEPENDENCIES[table] || []) {
      if (requested.has(dependency)) visit(dependency);
    }
    visiting.delete(table);
    visited.add(table);
    ordered.push(table);
  };
  for (const table of [...tables].sort()) visit(table);
  return ordered;
}

function applyForeignKeyRewrites(plannerInput, plan) {
  const sourceByTable = Object.fromEntries(Object.entries(plannerInput.tables).map(([table, sides]) => [
    table,
    sides.source.map((row) => clone(row)),
  ]));
  for (const rewrite of plan.foreignKeyRewrites || []) {
    const rows = sourceByTable[rewrite.table] || [];
    const policy = TABLE_POLICIES[rewrite.table];
    const key = canonicalJson(rewrite.sourcePrimaryKey);
    const matches = rows.filter((row) => primaryKeyFor(rewrite.table, row) === key);
    assert(matches.length === 1, "FOREIGN_KEY_REWRITE_ROW_NOT_UNIQUE");
    const foreignKey = (FOREIGN_KEYS[rewrite.table] || []).find(({ column, referencesTable }) => (
      column === rewrite.column && referencesTable === rewrite.referencesTable
    ));
    assert(Boolean(foreignKey), "FOREIGN_KEY_REWRITE_NOT_REVIEWED");
    assert(matches[0][rewrite.column] === rewrite.sourceValue, "FOREIGN_KEY_REWRITE_SOURCE_DRIFT");
    matches[0][rewrite.column] = rewrite.targetValue;
  }
  return sourceByTable;
}

export function backupManifestDigest(manifest) {
  const unsigned = clone(manifest);
  delete unsigned.manifestSha256;
  return sha256(canonicalJson(unsigned));
}

export function validateBackupManifest(manifest, plan, {
  confirmManifestSha256,
  now = new Date(),
} = {}) {
  assert(manifest?.schemaVersion === 1, "BACKUP_MANIFEST_SCHEMA_UNSUPPORTED");
  assert(manifest.environment === "rescue-production", "BACKUP_TARGET_ENVIRONMENT_MISMATCH");
  assert(manifest.storageClass === "external-encrypted" && manifest.encrypted === true,
    "BACKUP_NOT_EXTERNAL_ENCRYPTED");
  assert(manifest.restorable === true && manifest.restoreTested === true,
    "BACKUP_NOT_RESTORE_TESTED");
  assert(SHA256.test(manifest.manifestSha256 || "")
    && manifest.manifestSha256 === backupManifestDigest(manifest), "BACKUP_MANIFEST_DIGEST_MISMATCH");
  assert(confirmManifestSha256 === manifest.manifestSha256, "BACKUP_MANIFEST_NOT_EXPLICITLY_CONFIRMED");
  assert(SHA256.test(manifest.databaseIdentitySha256 || "")
    && manifest.databaseIdentitySha256 === plan.targetWatermark.databaseIdentitySha256,
  "BACKUP_DATABASE_IDENTITY_MISMATCH");
  assert(manifest.targetRowsSha256 === plan.targetRowsSha256, "BACKUP_TARGET_ROWS_MISMATCH");
  assert(manifest.conflictRecheckPlanSha256 === plan.planSha256, "BACKUP_PLAN_BINDING_MISMATCH");
  const capturedAt = parseTimestamp(manifest.capturedAt, "BACKUP_CAPTURE_TIME_INVALID");
  const restoreTestedAt = parseTimestamp(manifest.restoreTestedAt, "BACKUP_RESTORE_TEST_TIME_INVALID");
  const nowMillis = now.getTime();
  assert(capturedAt >= Date.parse(plan.plannedAt), "BACKUP_PREDATES_PLAN");
  assert(restoreTestedAt >= capturedAt && restoreTestedAt <= nowMillis, "BACKUP_RESTORE_TEST_TIME_INVALID");
  assert(nowMillis - capturedAt <= MAX_BACKUP_AGE_MS, "BACKUP_TOO_OLD");
  assert(manifest.artifact && typeof manifest.artifact.relativePath === "string"
    && manifest.artifact.relativePath.length > 0
    && !manifest.artifact.relativePath.startsWith("/")
    && !manifest.artifact.relativePath.split(/[\\/]/).includes(".."),
  "BACKUP_ARTIFACT_PATH_INVALID");
  assert(SHA256.test(manifest.artifact.sha256 || "")
    && Number.isSafeInteger(manifest.artifact.bytes)
    && manifest.artifact.bytes > 0,
  "BACKUP_ARTIFACT_ATTESTATION_INVALID");
  return clone(manifest);
}

export function validatePlannerBundle({ plan, plannerInput }) {
  assert(plan?.schemaVersion === 4 && plan.mode === "dry-run", "PLAN_SCHEMA_OR_MODE_INVALID");
  assert(plannerInput && typeof plannerInput === "object", "PLANNER_INPUT_REQUIRED");
  const recomputed = planRescueMerge(plannerInput);
  assert(recomputed.planSha256 === plan.planSha256, "PLAN_RECOMPUTE_DIGEST_MISMATCH");
  assert(canonicalJson(recomputed) === canonicalJson(plan), "PLAN_RECOMPUTE_CONTENT_MISMATCH");
  assert(plan.mergeSafe === true && plan.blockers.length === 0, "PLAN_HAS_BLOCKERS");
  assert(plan.reviewedPolicySha256 === recomputed.reviewedPolicySha256, "PLAN_POLICY_DIGEST_MISMATCH");
  return recomputed;
}

export function prepareInsertRows({ plan, plannerInput }) {
  validatePlannerBundle({ plan, plannerInput });
  const sourceByTable = applyForeignKeyRewrites(plannerInput, plan);
  const actions = plan.actions.filter(({ type }) => type === "INSERT_MISSING");
  assert(actions.length > 0, "PLAN_HAS_NO_INSERTS");
  const rows = [];
  for (const action of actions) {
    assert(!FORBIDDEN_TABLE_SET.has(action.table) && !action.table.startsWith("runtime_"),
      "FORBIDDEN_TABLE_INSERT");
    assert(TABLE_POLICIES[action.table], "UNREVIEWED_TABLE_INSERT");
    const actionKey = canonicalJson(action.sourcePrimaryKey);
    const matches = (sourceByTable[action.table] || []).filter((row) => (
      primaryKeyFor(action.table, row) === actionKey
      && semanticDigest(action.table, row) === action.sourceSha256
    ));
    assert(matches.length === 1, "INSERT_SOURCE_ROW_NOT_UNIQUE_OR_HASH_DRIFT");
    const credentialPath = hasCredentialMaterial(matches[0]);
    assert(!credentialPath, "CREDENTIAL_MATERIAL_IN_INSERT_ROW",
      `Credential-like material is forbidden in insert row ${action.table}:${credentialPath}`);
    rows.push({
      table: action.table,
      row: clone(matches[0]),
      sourcePrimaryKey: clone(action.sourcePrimaryKey),
      sourceSha256: action.sourceSha256,
    });
  }
  const order = new Map(topologicalTables(plan.requestedTables).map((table, index) => [table, index]));
  rows.sort((left, right) => {
    const tableOrder = (order.get(left.table) ?? Number.MAX_SAFE_INTEGER)
      - (order.get(right.table) ?? Number.MAX_SAFE_INTEGER);
    return tableOrder || canonicalJson(left.row).localeCompare(canonicalJson(right.row));
  });
  return rows;
}

export function evaluateExecutorApplyGate({
  plan,
  plannerInput,
  backupManifest,
  apply = false,
  confirmApply = null,
  confirmPlanSha256 = null,
  confirmArtifactPayloadSha256 = null,
  confirmBackupManifestSha256 = null,
  now = new Date(),
}) {
  const blockers = [];
  try {
    validatePlannerBundle({ plan, plannerInput });
  } catch (error) {
    blockers.push(error.code || "PLAN_VALIDATION_FAILED");
  }
  if (!apply) blockers.push("APPLY_FLAG_NOT_SET");
  if (confirmApply !== APPLY_CONFIRMATION) blockers.push("APPLY_PHRASE_NOT_CONFIRMED");
  if (confirmPlanSha256 !== plan?.planSha256) blockers.push("PLAN_DIGEST_NOT_CONFIRMED");
  if (confirmArtifactPayloadSha256 !== plan?.artifactPayloadSha256) {
    blockers.push("ARTIFACT_PAYLOAD_NOT_CONFIRMED");
  }
  try {
    validateBackupManifest(backupManifest, plan, {
      confirmManifestSha256: confirmBackupManifestSha256,
      now,
    });
  } catch (error) {
    blockers.push(error.code || "BACKUP_VALIDATION_FAILED");
  }
  try {
    prepareInsertRows({ plan, plannerInput });
  } catch (error) {
    blockers.push(error.code || "INSERT_SET_VALIDATION_FAILED");
  }
  return {
    ready: blockers.length === 0,
    mode: blockers.length === 0 ? "APPLY_GATE_READY" : "APPLY_GATE_BLOCKED",
    blockers: [...new Set(blockers)],
  };
}

function plannerInputWithTargetRows(plannerInput, targetRows) {
  const updated = clone(plannerInput);
  for (const table of Object.keys(updated.tables)) {
    assert(Array.isArray(targetRows[table]), "TARGET_RECHECK_TABLE_MISSING");
    updated.tables[table].target = clone(targetRows[table]);
  }
  return updated;
}

function expectedPostApplyRows(targetRows, inserts) {
  const expected = clone(targetRows);
  for (const { table, row } of inserts) expected[table].push(clone(row));
  return expected;
}

export async function executeRescueMerge({
  plan,
  plannerInput,
  backupManifest,
  confirmations,
  database,
  now = new Date(),
}) {
  const gate = evaluateExecutorApplyGate({
    plan,
    plannerInput,
    backupManifest,
    apply: true,
    confirmApply: confirmations?.apply,
    confirmPlanSha256: confirmations?.planSha256,
    confirmArtifactPayloadSha256: confirmations?.artifactPayloadSha256,
    confirmBackupManifestSha256: confirmations?.backupManifestSha256,
    now,
  });
  assert(gate.ready, "APPLY_GATE_BLOCKED", gate.blockers.join(","));
  const inserts = prepareInsertRows({ plan, plannerInput });
  let transactionStarted = false;
  let committed = false;
  try {
    await database.connect();
    await database.beginSerializable();
    transactionStarted = true;
    await database.acquireAdvisoryLock(ADVISORY_LOCK_NAMESPACE);

    const databaseIdentitySha256 = await database.databaseIdentitySha256();
    assert(databaseIdentitySha256 === plan.targetWatermark.databaseIdentitySha256,
      "LIVE_DATABASE_IDENTITY_MISMATCH");
    assert(databaseIdentitySha256 === backupManifest.databaseIdentitySha256,
      "LIVE_BACKUP_DATABASE_IDENTITY_MISMATCH");

    const beforeRows = await database.readTables(plan.requestedTables);
    const recheckedInput = plannerInputWithTargetRows(plannerInput, beforeRows);
    const recheckedPlan = planRescueMerge(recheckedInput);
    assert(recheckedPlan.targetRowsSha256 === plan.targetRowsSha256, "TARGET_SNAPSHOT_ROWS_DRIFT");
    assert(recheckedPlan.planSha256 === plan.planSha256, "TARGET_CONFLICT_RECHECK_PLAN_DRIFT");
    assert(canonicalJson(recheckedPlan) === canonicalJson(plan), "TARGET_CONFLICT_RECHECK_CONTENT_DRIFT");

    for (const insert of inserts) {
      const inserted = await database.insertRow(insert.table, insert.row);
      assert(inserted === 1, "INSERT_COUNT_MISMATCH");
    }

    const afterRows = await database.readTables(plan.requestedTables);
    const expectedRows = expectedPostApplyRows(beforeRows, inserts);
    const expectedPostPlan = planRescueMerge(plannerInputWithTargetRows(plannerInput, expectedRows));
    const actualPostPlan = planRescueMerge(plannerInputWithTargetRows(plannerInput, afterRows));
    assert(actualPostPlan.targetRowsSha256 === expectedPostPlan.targetRowsSha256,
      "POST_RECONCILIATION_TARGET_DIGEST_MISMATCH");
    assert((actualPostPlan.counts.INSERT_MISSING || 0) === 0,
      "POST_RECONCILIATION_INSERTS_REMAIN");
    assert(actualPostPlan.blockers.length === 0 && actualPostPlan.mergeSafe === true,
      "POST_RECONCILIATION_BLOCKED");
    const insertedNoops = actualPostPlan.actions.filter(({ type, sourcePrimaryKey, sourceSha256, table }) => (
      type === "IDENTICAL_NOOP"
      && inserts.some((insert) => insert.table === table
        && canonicalJson(insert.sourcePrimaryKey) === canonicalJson(sourcePrimaryKey)
        && insert.sourceSha256 === sourceSha256)
    ));
    assert(insertedNoops.length === inserts.length, "POST_RECONCILIATION_INSERT_IDENTITY_MISMATCH");

    await database.commit();
    committed = true;
    return {
      schemaVersion: 1,
      result: "APPLIED_INSERT_MISSING_ONLY",
      planSha256: plan.planSha256,
      artifactPayloadSha256: plan.artifactPayloadSha256,
      backupManifestSha256: backupManifest.manifestSha256,
      databaseIdentitySha256,
      advisoryLockNamespaceSha256: sha256(ADVISORY_LOCK_NAMESPACE),
      insertedCount: inserts.length,
      insertedByTable: inserts.reduce((counts, { table }) => {
        counts[table] = (counts[table] || 0) + 1;
        return counts;
      }, {}),
      beforeTargetRowsSha256: recheckedPlan.targetRowsSha256,
      afterTargetRowsSha256: actualPostPlan.targetRowsSha256,
      postReconciliation: "EXACT_PRE_COMMIT",
      rollback: "NOT_REQUIRED",
    };
  } catch (error) {
    if (transactionStarted && !committed) {
      try {
        await database.rollback();
      } catch {
        throw new RescueMergeError("ROLLBACK_FAILED", "Automatic transaction rollback failed");
      }
    }
    if (error instanceof RescueMergeError) throw error;
    throw new RescueMergeError("DATABASE_EXECUTION_FAILED", "Database execution failed; transaction rolled back");
  } finally {
    await database.close().catch(() => undefined);
  }
}
