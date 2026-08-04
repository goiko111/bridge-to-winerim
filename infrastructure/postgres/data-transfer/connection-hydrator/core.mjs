import { createHash } from "node:crypto";

export const CONNECTION_HYDRATOR_SCHEMA_VERSION = 1;
export const HYDRATE_CONFIRMATION = "HYDRATE_INACTIVE_CONNECTION_ONLY";
export const ROLLBACK_CONFIRMATION = "ROLLBACK_INACTIVE_CONNECTION_HYDRATION_ONLY";

export const IMPORT_TABLES = Object.freeze([
  "pos_connections",
  "provider_products",
  "product_mappings",
  "agora_master_data",
  "sales_events",
  "sales_line_items",
  "stock_sync_log",
  "winerim_push_tracking",
]);

export const DATA_TABLES = Object.freeze(IMPORT_TABLES.filter((table) => table !== "pos_connections"));
export const SOURCE_TABLES = Object.freeze([...IMPORT_TABLES, "outbound_tasks"]);
export const DELETE_ORDER = Object.freeze([
  "stock_sync_log",
  "sales_line_items",
  "winerim_push_tracking",
  "sales_events",
  "product_mappings",
  "provider_products",
  "agora_master_data",
  "pos_connections",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const SENSITIVE_KEY = /(?:token|secret|password|credential|authorization|bearer|api[_-]?key|dsn|provider_config|restaurant_guid)/i;
const SENSITIVE_TEXT = /((?:bearer|token|secret|password|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi;

const NATURAL_KEYS = Object.freeze({
  provider_products: ["connection_id", "provider_product_id"],
  product_mappings: ["connection_id", "provider_product_id"],
  agora_master_data: ["connection_id"],
  sales_events: ["connection_id", "provider_doc_id"],
  winerim_push_tracking: ["connection_id", "winerim_wine_id", "format"],
});

const POS_CONNECTION_FIELDS = Object.freeze([
  "id",
  "location_name",
  "provider",
  "sync_frequency_minutes",
  "backfill_days",
  "catalog_product_count",
  "catalog_wine_candidate_count",
  "default_wine_family_name",
  "default_vat_rate",
  "default_bottle_format_name",
  "default_glass_format_name",
  "default_family_id",
  "default_vat_id",
  "default_preparation_type_id",
  "default_preparation_order_id",
  "default_warehouse_id",
  "require_manual_review_before_push",
  "estimated_glasses_per_bottle",
  "created_at",
  "updated_at",
]);

const POS_CONNECTION_INERT_OVERRIDES = Object.freeze({
  base_url: "https://redacted.invalid",
  api_token: "",
  winerim_api_token: null,
  catalog_endpoint: null,
  provider_config: null,
  restaurant_guid: null,
  enabled: false,
  catalog_sync_enabled: false,
  sync_mode: "PULL_ONLY",
  write_mode: "NONE",
  write_bottle: false,
  write_glass: false,
  auto_create_families: false,
  auto_push_on_create: false,
  auto_push_on_update: false,
  auto_push_bottle: false,
  auto_push_glass: false,
  auto_push_verified_ready: false,
  selected_sale_center_ids: [],
  last_sync_at: null,
  last_catalog_sync_at: null,
  last_business_day_synced: null,
  circuit_breaker_paused_until: null,
  circuit_breaker_reason: null,
  consecutive_failures: 0,
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertConnectionId(value) {
  assert(UUID.test(String(value || "")), "CONNECTION_ID_INVALID");
  return String(value).toLowerCase();
}

export function canonicalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

export function redactText(value) {
  if (typeof value !== "string") return value;
  return value.replace(SENSITIVE_TEXT, "$1[REDACTED]");
}

export function sanitizeJson(value) {
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (!value || typeof value !== "object") return redactText(value);
  const sanitized = {};
  for (const [key, nested] of Object.entries(value)) {
    sanitized[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeJson(nested);
  }
  return sanitized;
}

export function sanitizePosConnection(row) {
  const result = {};
  for (const field of POS_CONNECTION_FIELDS) {
    if (Object.hasOwn(row, field)) result[field] = canonicalize(row[field]);
  }
  Object.assign(result, POS_CONNECTION_INERT_OVERRIDES);
  assertConnectionId(result.id);
  assert(String(result.provider || "").toLowerCase() === "agora", "CONNECTION_PROVIDER_NOT_AGORA");
  assert(result.location_name, "CONNECTION_LOCATION_NAME_REQUIRED");
  return canonicalize(result);
}

function sanitizeGenericRow(table, row) {
  const result = {};
  for (const [key, value] of Object.entries(row)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (key === "task_id" && table === "winerim_push_tracking") {
      result.task_id = null;
      continue;
    }
    result[key] = sanitizeJson(value);
  }
  return canonicalize(result);
}

export function sanitizeRow(table, row) {
  assert(IMPORT_TABLES.includes(table), `TABLE_NOT_IMPORTABLE:${table}`);
  const sanitized = table === "pos_connections" ? sanitizePosConnection(row) : sanitizeGenericRow(table, row);
  assert(String(sanitized.connection_id || sanitized.id) !== "undefined", `CONNECTION_ID_MISSING:${table}`);
  return sanitized;
}

function outboundErrorClass(task) {
  const text = `${task.last_error || ""} ${task.blocked_reason || ""}`.toLowerCase();
  if (/pos_down|no responde|unreachable|econnrefused/.test(text)) return "POS_DOWN";
  if (/404|not found/.test(text)) return "HTTP_404";
  if (/timeout|timed out|522/.test(text)) return "TIMEOUT";
  if (/duplicate|already exists|conflict/.test(text)) return "CONFLICT_OR_DUPLICATE";
  if (!text.trim()) return "NO_ERROR_RECORDED";
  return "OTHER_REDACTED";
}

function outboundDisposition(status) {
  const normalized = String(status || "UNKNOWN").toUpperCase();
  if (["QUEUED", "RUNNING", "PENDING"].includes(normalized)) return "EXCLUDED_LIVE_DEBT_REVIEW";
  if (normalized === "BLOCKED") return "EXCLUDED_BLOCKED_REVIEW";
  if (normalized === "FAILED") return "EXCLUDED_FAILED_REVIEW";
  return "EXCLUDED_TERMINAL_OR_HISTORICAL";
}

export function classifyOutboundTasks(tasks) {
  const rows = tasks.map((task) => ({
    id: task.id,
    taskType: task.task_type,
    status: String(task.status || "UNKNOWN").toUpperCase(),
    attempts: task.attempts,
    maxAttempts: task.max_attempts,
    createdAt: canonicalize(task.created_at),
    updatedAt: canonicalize(task.updated_at),
    nextRetryAt: canonicalize(task.next_retry_at),
    errorClass: outboundErrorClass(task),
    disposition: outboundDisposition(task.status),
  })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const byStatus = {};
  const byType = {};
  const byDisposition = {};
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] || 0) + 1;
    byType[row.taskType] = (byType[row.taskType] || 0) + 1;
    byDisposition[row.disposition] = (byDisposition[row.disposition] || 0) + 1;
  }
  return canonicalize({
    importedCount: 0,
    classifiedCount: rows.length,
    byStatus,
    byType,
    byDisposition,
    rows,
    rowsSha256: sha256(rows),
  });
}

function rowKey(row, fields) {
  if (!fields || fields.some((field) => row[field] === null || row[field] === undefined)) return null;
  return canonicalJson(fields.map((field) => row[field]));
}

function assertUnique(table, rows, fields, label) {
  const seen = new Set();
  for (const row of rows) {
    const key = rowKey(row, fields);
    if (key === null) continue;
    assert(!seen.has(key), `${label}_DUPLICATE:${table}:${sha256(key)}`);
    seen.add(key);
  }
}

export function validateSourceRows(connectionId, tables) {
  const normalizedId = assertConnectionId(connectionId);
  assert(Object.keys(tables).every((table) => IMPORT_TABLES.includes(table)), "SOURCE_TABLE_SCOPE_INVALID");
  assert(Array.isArray(tables.pos_connections) && tables.pos_connections.length === 1, "SOURCE_CONNECTION_COUNT_INVALID");
  for (const table of IMPORT_TABLES) {
    const rows = tables[table];
    assert(Array.isArray(rows), `SOURCE_TABLE_MISSING:${table}`);
    for (const row of rows) {
      const rowConnectionId = String(table === "pos_connections" ? row.id : row.connection_id).toLowerCase();
      assert(rowConnectionId === normalizedId, `SOURCE_CONNECTION_SCOPE_BREACH:${table}`);
    }
    assertUnique(table, rows, ["id"], "SOURCE_PRIMARY_KEY");
    if (NATURAL_KEYS[table]) assertUnique(table, rows, NATURAL_KEYS[table], "SOURCE_NATURAL_KEY");
  }
  const eventIds = new Set(tables.sales_events.map((row) => row.id));
  const lineIds = new Set(tables.sales_line_items.map((row) => row.id));
  for (const row of tables.sales_line_items) {
    assert(eventIds.has(row.sales_event_id), `SOURCE_ORPHAN_SALES_LINE:${row.id}`);
  }
  for (const row of tables.stock_sync_log) {
    assert(row.sales_event_id === null || row.sales_event_id === undefined || eventIds.has(row.sales_event_id), `SOURCE_ORPHAN_STOCK_EVENT:${row.id}`);
    assert(row.sales_line_item_id === null || row.sales_line_item_id === undefined || lineIds.has(row.sales_line_item_id), `SOURCE_ORPHAN_STOCK_LINE:${row.id}`);
  }
  const stockKeys = tables.stock_sync_log
    .filter((row) => row.idempotency_key !== null && row.idempotency_key !== undefined)
    .map((row) => ({ ...row, _key: row.idempotency_key }));
  assertUnique("stock_sync_log", stockKeys, ["connection_id", "_key"], "SOURCE_IDEMPOTENCY_KEY");
  return true;
}

export function buildSourceSnapshot({ connectionId, rawTables, watermark }) {
  const id = assertConnectionId(connectionId);
  const tables = {};
  for (const table of IMPORT_TABLES) {
    tables[table] = (rawTables[table] || []).map((row) => sanitizeRow(table, row))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  }
  validateSourceRows(id, tables);
  const outbound = classifyOutboundTasks(rawTables.outbound_tasks || []);
  const tableDigests = Object.fromEntries(IMPORT_TABLES.map((table) => [table, {
    rowCount: tables[table].length,
    rowsSha256: sha256(tables[table]),
  }]));
  return canonicalize({
    schemaVersion: CONNECTION_HYDRATOR_SCHEMA_VERSION,
    kind: "connection-inactive-hydration-source",
    connectionId: id,
    watermark,
    redactions: {
      posConnections: "credentials,endpoints,provider_config,restaurant_guid,cursors,breaker,write-flags",
      jsonPayloads: "recursive credential-like keys and inline authorization values",
      trackingTaskId: "set-null-because-outbound-tasks-are-never-imported",
    },
    tableDigests,
    tables,
    outbound,
    payloadSha256: sha256({ connectionId: id, tables, outbound }),
  });
}

export function assertTargetInactive({ targetConnection, runtimeActivity = {} }) {
  if (!targetConnection) return true;
  assert(targetConnection.enabled === false, "TARGET_CONNECTION_ENABLED");
  assert(targetConnection.catalog_sync_enabled === false || targetConnection.catalog_sync_enabled === null, "TARGET_CATALOG_ENABLED");
  assert(targetConnection.write_mode === "NONE", "TARGET_WRITE_MODE_NOT_NONE");
  assert(Number(runtimeActivity.activeScopes || 0) === 0, "TARGET_RUNTIME_SCOPE_ACTIVE");
  assert(Number(runtimeActivity.activeCredentials || 0) === 0, "TARGET_RUNTIME_CREDENTIAL_ACTIVE");
  assert(Number(runtimeActivity.activeCatalogScopes || 0) === 0, "TARGET_RUNTIME_CATALOG_SCOPE_ACTIVE");
  return true;
}

function targetIndex(rows, fields) {
  const result = new Map();
  for (const row of rows) {
    const key = rowKey(row, fields);
    if (key === null) continue;
    if (result.has(key)) throw new Error(`TARGET_DUPLICATE_KEY:${sha256(key)}`);
    result.set(key, row);
  }
  return result;
}

export function buildHydrationPlan({ source, targetTables, targetWatermark, runtimeActivity = {} }) {
  assert(source?.schemaVersion === CONNECTION_HYDRATOR_SCHEMA_VERSION, "SOURCE_SCHEMA_VERSION_UNSUPPORTED");
  validateSourceRows(source.connectionId, source.tables);
  const targetConnection = (targetTables.pos_connections || [])[0] || null;
  assertTargetInactive({ targetConnection, runtimeActivity });
  if (targetConnection) {
    assert(String(targetConnection.id).toLowerCase() === source.connectionId, "TARGET_CONNECTION_ID_MISMATCH");
    assert(String(targetConnection.provider || "").toLowerCase() === "agora", "TARGET_CONNECTION_PROVIDER_MISMATCH");
  }
  const inserts = {};
  const noops = {};
  const conflicts = [];
  for (const table of IMPORT_TABLES) {
    const sourceRows = source.tables[table];
    const targetRows = targetTables[table] || [];
    const byId = targetIndex(targetRows, ["id"]);
    const byNatural = NATURAL_KEYS[table] ? targetIndex(targetRows, NATURAL_KEYS[table]) : new Map();
    inserts[table] = [];
    noops[table] = [];
    for (const sourceRow of sourceRows) {
      if (table === "pos_connections" && targetConnection) {
        noops[table].push(sourceRow.id);
        continue;
      }
      const idKey = rowKey(sourceRow, ["id"]);
      const naturalKey = rowKey(sourceRow, NATURAL_KEYS[table]);
      const targetById = byId.get(idKey);
      const targetByNatural = naturalKey ? byNatural.get(naturalKey) : null;
      if (targetById) {
        if (canonicalJson(sanitizeRow(table, targetById)) === canonicalJson(sourceRow)) noops[table].push(sourceRow.id);
        else conflicts.push({ table, code: "PRIMARY_KEY_CONFLICT", idSha256: sha256(sourceRow.id) });
        continue;
      }
      if (targetByNatural) {
        conflicts.push({ table, code: "NATURAL_KEY_CONFLICT", naturalKeySha256: sha256(naturalKey) });
        continue;
      }
      inserts[table].push(sourceRow);
    }
  }
  assert(conflicts.length === 0, `TARGET_CONFLICTS:${canonicalJson(conflicts)}`);
  const targetPreimage = canonicalize(Object.fromEntries(IMPORT_TABLES.map((table) => [table,
    (targetTables[table] || []).map((row) => sanitizeRow(table, row)).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
  ])));
  const targetPreimageCounts = Object.fromEntries(IMPORT_TABLES.map((table) => [table, targetPreimage[table].length]));
  const rollbackIds = Object.fromEntries(IMPORT_TABLES.map((table) => [table, inserts[table].map((row) => row.id).sort()]));
  const planBody = canonicalize({
    schemaVersion: CONNECTION_HYDRATOR_SCHEMA_VERSION,
    kind: "connection-inactive-hydration-plan",
    connectionId: source.connectionId,
    sourcePayloadSha256: source.payloadSha256,
    sourceWatermark: source.watermark,
    targetWatermark,
    targetPreimageSha256: sha256(targetPreimage),
    targetPreimageCounts,
    runtimeActivity,
    inserts,
    noops,
    rollbackIds,
  });
  return { ...planBody, planSha256: sha256(planBody) };
}

function quoteIdentifier(value) {
  assert(IDENTIFIER.test(String(value)), "UNSAFE_SQL_IDENTIFIER");
  return `"${value}"`;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (Array.isArray(value)) return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
  if (value && typeof value === "object") return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

function renderInsert(table, row) {
  const columns = Object.keys(row).sort();
  const record = `${sqlLiteral(JSON.stringify(row))}::jsonb`;
  return `INSERT INTO public.${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) SELECT ${columns.map(quoteIdentifier).join(", ")} FROM jsonb_populate_record(NULL::public.${quoteIdentifier(table)}, ${record});`;
}

function sqlUuidList(ids) {
  if (!ids.length) return "NULL::uuid";
  return ids.map((id) => `${sqlLiteral(id)}::uuid`).join(", ");
}

function countPredicate(table, connectionId) {
  const scopeColumn = table === "pos_connections" ? "id" : "connection_id";
  return `SELECT count(*) FROM public.${quoteIdentifier(table)} WHERE ${quoteIdentifier(scopeColumn)} = ${sqlLiteral(connectionId)}::uuid`;
}

function renderCountAssertions(plan, counts, label) {
  return IMPORT_TABLES.map((table) => `
  IF (${countPredicate(table, plan.connectionId)}) <> ${Number(counts[table] || 0)} THEN
    RAISE EXCEPTION '${label}_COUNT_MISMATCH:${table}';
  END IF;`).join("");
}

function renderRuntimeInactiveAssertions(plan, label) {
  return `
  IF to_regclass('public.runtime_canary_connections') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.runtime_canary_connections WHERE connection_id = $1 AND active'
      INTO runtime_active_count USING ${sqlLiteral(plan.connectionId)}::uuid;
    IF runtime_active_count <> 0 THEN RAISE EXCEPTION '${label}_RUNTIME_SCOPE_ACTIVE'; END IF;
  END IF;
  IF to_regclass('public.runtime_connection_credentials') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.runtime_connection_credentials WHERE connection_id = $1 AND active'
      INTO runtime_active_count USING ${sqlLiteral(plan.connectionId)}::uuid;
    IF runtime_active_count <> 0 THEN RAISE EXCEPTION '${label}_RUNTIME_CREDENTIAL_ACTIVE'; END IF;
  END IF;
  IF to_regclass('public.runtime_catalog_source_scope') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.runtime_catalog_source_scope WHERE connection_id = $1 AND active'
      INTO runtime_active_count USING ${sqlLiteral(plan.connectionId)}::uuid;
    IF runtime_active_count <> 0 THEN RAISE EXCEPTION '${label}_RUNTIME_CATALOG_SCOPE_ACTIVE'; END IF;
  END IF;`;
}

export function renderHydrationSql(plan) {
  assert(SHA256.test(plan?.planSha256 || ""), "PLAN_SHA256_INVALID");
  const inserts = IMPORT_TABLES.flatMap((table) => plan.inserts[table].map((row) => renderInsert(table, row))).join("\n");
  return `\\set ON_ERROR_STOP on
-- CONNECTION_HYDRATOR_PLAN_SHA256:${plan.planSha256}
-- TARGET_PREIMAGE_SHA256:${plan.targetPreimageSha256}
BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtext('winerim-connection-hydrator'), hashtext(${sqlLiteral(plan.connectionId)}));

DO $hydration_guard$
DECLARE connection_enabled boolean; catalog_enabled boolean; connection_write_mode text; runtime_active_count bigint;
BEGIN
${renderCountAssertions(plan, plan.targetPreimageCounts, "HYDRATION_PREIMAGE")}
${renderRuntimeInactiveAssertions(plan, "HYDRATION_PREIMAGE")}
  IF EXISTS (SELECT 1 FROM public.pos_connections WHERE id = ${sqlLiteral(plan.connectionId)}::uuid) THEN
    SELECT enabled, catalog_sync_enabled, write_mode
      INTO STRICT connection_enabled, catalog_enabled, connection_write_mode
    FROM public.pos_connections WHERE id = ${sqlLiteral(plan.connectionId)}::uuid FOR UPDATE;
    IF connection_enabled IS DISTINCT FROM FALSE
      OR catalog_enabled IS DISTINCT FROM FALSE
      OR connection_write_mode IS DISTINCT FROM 'NONE' THEN
      RAISE EXCEPTION 'TARGET_CONNECTION_NOT_INACTIVE';
    END IF;
  END IF;
END
$hydration_guard$;

${inserts}

DO $hydration_postcondition$
BEGIN
${renderCountAssertions(plan, Object.fromEntries(IMPORT_TABLES.map((table) => [table,
    Number(plan.targetPreimageCounts[table] || 0) + Number(plan.inserts[table]?.length || 0),
  ])), "HYDRATION_POSTCONDITION")}
  IF NOT EXISTS (
    SELECT 1 FROM public.pos_connections
    WHERE id = ${sqlLiteral(plan.connectionId)}::uuid
      AND enabled IS FALSE
      AND COALESCE(catalog_sync_enabled, FALSE) IS FALSE
      AND write_mode = 'NONE'
  ) THEN
    RAISE EXCEPTION 'HYDRATED_CONNECTION_NOT_INACTIVE';
  END IF;
END
$hydration_postcondition$;
COMMIT;
`;
}

export function renderRollbackSql(plan) {
  assert(SHA256.test(plan?.planSha256 || ""), "PLAN_SHA256_INVALID");
  const deletes = DELETE_ORDER.map((table) => {
    const ids = plan.rollbackIds[table] || [];
    if (!ids.length) return `-- ${table}: no rows inserted by this plan`;
    return `DELETE FROM public.${quoteIdentifier(table)} WHERE id IN (${sqlUuidList(ids)});`;
  }).join("\n");
  return `\\set ON_ERROR_STOP on
-- CONNECTION_HYDRATOR_ROLLBACK_PLAN_SHA256:${plan.planSha256}
-- TARGET_PREIMAGE_SHA256:${plan.targetPreimageSha256}
BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtext('winerim-connection-hydrator'), hashtext(${sqlLiteral(plan.connectionId)}));
DO $rollback_guard$
DECLARE connection_enabled boolean; catalog_enabled boolean; connection_write_mode text; runtime_active_count bigint;
BEGIN
${renderCountAssertions(plan, Object.fromEntries(IMPORT_TABLES.map((table) => [table,
    Number(plan.targetPreimageCounts[table] || 0) + Number(plan.inserts[table]?.length || 0),
  ])), "ROLLBACK_PREIMAGE")}
${renderRuntimeInactiveAssertions(plan, "ROLLBACK_PREIMAGE")}
  SELECT enabled, catalog_sync_enabled, write_mode
    INTO STRICT connection_enabled, catalog_enabled, connection_write_mode
  FROM public.pos_connections WHERE id = ${sqlLiteral(plan.connectionId)}::uuid FOR UPDATE;
  IF connection_enabled IS DISTINCT FROM FALSE
    OR catalog_enabled IS DISTINCT FROM FALSE
    OR connection_write_mode IS DISTINCT FROM 'NONE' THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSES_ACTIVE_CONNECTION';
  END IF;
END
$rollback_guard$;
${deletes}
DO $rollback_postcondition$
BEGIN
${renderCountAssertions(plan, plan.targetPreimageCounts, "ROLLBACK_POSTCONDITION")}
END
$rollback_postcondition$;
COMMIT;
`;
}

export function renderReconcileSql(plan) {
  const statements = IMPORT_TABLES.map((table) => (
    `SELECT ${sqlLiteral(table)} AS table_name, count(*)::bigint AS connection_rows FROM public.${quoteIdentifier(table)} WHERE ${table === "pos_connections" ? "id" : "connection_id"} = ${sqlLiteral(plan.connectionId)}::uuid;`
  )).join("\n");
  return `-- CONNECTION_HYDRATOR_RECONCILE_PLAN_SHA256:${plan.planSha256}\n${statements}\n`;
}

export function reconcilePlan(plan, targetTables, runtimeActivity = {}) {
  const expected = {};
  const actual = {};
  const mismatches = [];
  const targetConnection = (targetTables.pos_connections || [])[0] || null;
  try {
    assertTargetInactive({ targetConnection, runtimeActivity });
  } catch (error) {
    mismatches.push(error.message);
  }
  for (const table of IMPORT_TABLES) {
    const targetById = new Map((targetTables[table] || []).map((row) => [row.id, row]));
    expected[table] = plan.inserts[table].length + (plan.noops[table] || []).length;
    actual[table] = 0;
    for (const row of plan.inserts[table]) {
      const target = targetById.get(row.id);
      if (!target) mismatches.push(`MISSING_ID:${table}:${sha256(row.id)}`);
      else if (canonicalJson(sanitizeRow(table, target)) !== canonicalJson(row)) mismatches.push(`ROW_DIGEST_MISMATCH:${table}:${sha256(row.id)}`);
      else actual[table] += 1;
    }
    for (const id of plan.noops[table] || []) if (targetById.has(id)) actual[table] += 1;
  }
  const result = canonicalize({
    schemaVersion: CONNECTION_HYDRATOR_SCHEMA_VERSION,
    planSha256: plan.planSha256,
    connectionId: plan.connectionId,
    expected,
    actual,
    mismatches,
    ok: mismatches.length === 0,
  });
  return { ...result, reconciliationSha256: sha256(result) };
}

export function targetRowsSha256(targetTables) {
  return sha256(Object.fromEntries(IMPORT_TABLES.map((table) => [table,
    (targetTables[table] || []).map((row) => sanitizeRow(table, row)).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
  ])));
}
