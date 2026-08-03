const immutable = ({ naturalKey = null, boundary = "created_at", reason = null } = {}) => ({
  mode: "immutable-insert-only",
  primaryKey: ["id"],
  naturalKey,
  boundaryColumns: boundary ? [boundary] : [],
  freshnessColumns: boundary ? [boundary] : [],
  compareIgnore: ["id", "created_at", "updated_at"],
  requireNaturalKeyForInsert: Boolean(naturalKey),
  reason,
});

const mutable = ({ naturalKey, boundary = "updated_at", reason = null }) => ({
  mode: "mutable-insert-only",
  primaryKey: ["id"],
  naturalKey,
  boundaryColumns: [boundary, "created_at"],
  freshnessColumns: [boundary, "fetched_at", "created_at"],
  compareIgnore: ["id", "created_at", "updated_at"],
  requireNaturalKeyForInsert: true,
  reason,
});

const manual = ({ naturalKey = null, reason }) => ({
  mode: "manual-review-only",
  primaryKey: ["id"],
  naturalKey,
  boundaryColumns: ["updated_at", "created_at"],
  freshnessColumns: ["updated_at", "created_at"],
  compareIgnore: ["id", "created_at", "updated_at"],
  requireNaturalKeyForInsert: true,
  reason,
});

export const EXCLUDED_SOURCE_TABLES = Object.freeze([
  "provider_credentials",
  "runtime_canary_connections",
  "runtime_connection_credentials",
  "runtime_execution_log",
  "runtime_idempotency",
]);

export const SOURCE_TABLES = Object.freeze([
  "agora_dispatch_locks",
  "agora_master_data",
  "classification_config",
  "connection_alerts",
  "connection_health_checks",
  "connection_notification_contacts",
  "integration_onboarding_requests",
  "middleware_incident_email_attempts",
  "middleware_incident_events",
  "middleware_incidents",
  "outbound_tasks",
  "pos_connections",
  "product_mappings",
  "provider_capabilities",
  "provider_products",
  "sales_events",
  "sales_line_items",
  "stock_sync_log",
  "user_roles",
  "webhook_events",
  "wine_family_rules",
  "wine_type_family_mappings",
  "winerim_push_tracking",
  "winerim_wines",
]);

export const TABLE_POLICIES = Object.freeze({
  agora_dispatch_locks: manual({
    naturalKey: ["connection_id"],
    reason: "Ephemeral leases must never move between runtimes.",
  }),
  agora_master_data: mutable({
    naturalKey: ["connection_id"],
    boundary: "fetched_at",
    reason: "A target snapshot is authoritative when it is fresher.",
  }),
  classification_config: mutable({ naturalKey: ["connection_id"] }),
  connection_alerts: manual({
    reason: "Only open alerts have a partial natural-key constraint; closed alerts do not.",
  }),
  connection_health_checks: manual({
    reason: "Observations have UUIDs but no durable cross-environment natural key.",
  }),
  connection_notification_contacts: manual({
    naturalKey: ["connection_id", "channel", "target"],
    reason: "Contains contact routing and requires a separate privacy review.",
  }),
  integration_onboarding_requests: manual({
    reason: "Lifecycle rows have no immutable external request key.",
  }),
  middleware_incident_email_attempts: manual({
    reason: "Email attempts have no provider-level idempotency constraint.",
  }),
  middleware_incident_events: manual({
    reason: "Incident events have no immutable external event key.",
  }),
  middleware_incidents: manual({
    reason: "The dedupe key is unique only while an incident is unresolved.",
  }),
  outbound_tasks: manual({
    reason: "Queue tasks are mutable and have no immutable idempotency key.",
  }),
  pos_connections: {
    mode: "sanitized-insert-only",
    primaryKey: ["id"],
    naturalKey: null,
    boundaryColumns: ["updated_at", "created_at"],
    freshnessColumns: ["updated_at", "created_at"],
    compareIgnore: ["created_at", "updated_at"],
    requireNaturalKeyForInsert: false,
    reason: "Connection UUID is the only reliable identity; inserted rows remain inert and redacted.",
  },
  product_mappings: mutable({ naturalKey: ["connection_id", "provider_product_id"] }),
  provider_capabilities: mutable({ naturalKey: ["connection_id"] }),
  provider_products: mutable({ naturalKey: ["connection_id", "provider_product_id"] }),
  sales_events: immutable({
    naturalKey: ["connection_id", "provider_doc_id"],
    reason: "The database enforces this provider document identity.",
  }),
  sales_line_items: manual({
    reason: "The old event/product unique key was dropped and no provider line id or ordinal replaced it.",
  }),
  stock_sync_log: {
    ...immutable({ naturalKey: ["connection_id", "idempotency_key"] }),
    reason: "Only non-null idempotency keys can be merged automatically; the database constraint is partial.",
  },
  user_roles: manual({
    reason: "Rows depend on auth.users identities that are not transferred by this lane.",
  }),
  webhook_events: immutable({ naturalKey: ["provider", "event_id"] }),
  wine_family_rules: mutable({ naturalKey: ["connection_id", "family_name"] }),
  wine_type_family_mappings: mutable({ naturalKey: ["connection_id", "mapping_key"] }),
  winerim_push_tracking: mutable({
    naturalKey: ["connection_id", "winerim_wine_id", "format"],
    reason: "Target receipts and verification state are never overwritten.",
  }),
  winerim_wines: mutable({ naturalKey: ["connection_id", "winerim_id"] }),
});

export const SCHEMA_GAPS = Object.freeze([
  {
    table: "pos_connections",
    code: "NO_CROSS_ENVIRONMENT_NATURAL_KEY",
    impact: "A renamed or independently recreated connection cannot be matched automatically when UUIDs differ.",
    requiredChange: "Add an immutable integration_key shared by Lovable and rescue-production.",
  },
  {
    table: "sales_line_items",
    code: "NO_PROVIDER_LINE_ID_OR_ORDINAL",
    impact: "Equivalent lines with different UUIDs cannot be distinguished from legitimate repeated products.",
    requiredChange: "Persist a stable provider_line_id or invoice line ordinal and enforce uniqueness with the sales event.",
  },
  {
    table: "stock_sync_log",
    code: "NULLABLE_PARTIAL_IDEMPOTENCY_KEY",
    impact: "FAILED, SKIPPED, and older rows without an idempotency key cannot be deduplicated safely.",
    requiredChange: "Backfill a durable claim key and enforce an immutable uniqueness rule for every stock attempt.",
  },
  {
    table: "outbound_tasks",
    code: "NO_IMMUTABLE_TASK_KEY",
    impact: "The same logical task can exist under different UUIDs and mutable statuses.",
    requiredChange: "Add a stable task_key or payload fingerprint scoped by connection and operation.",
  },
  {
    table: "agora_master_data",
    code: "NO_SOURCE_VERSION_VECTOR",
    impact: "Timestamp freshness cannot prove causality when source and target clocks or writers diverge.",
    requiredChange: "Store provider revision/digest and the fetch watermark for each master snapshot.",
  },
  {
    table: "mutable_catalog_tables",
    code: "NO_ROW_OWNERSHIP_OR_VERSION_VECTOR",
    impact: "Divergent catalog or mapping rows require manual conflict resolution even when one timestamp looks newer.",
    requiredChange: "Add source_owner, source_revision, and immutable payload digest columns.",
  },
  {
    table: "user_roles",
    code: "AUTH_IDENTITY_NOT_PORTABLE",
    impact: "Role rows cannot be applied until auth user identities are reconciled separately.",
    requiredChange: "Define an auth migration map and verify every referenced user before role import.",
  },
]);

for (const table of SOURCE_TABLES) {
  if (!TABLE_POLICIES[table]) throw new Error(`Missing rescue merge policy for ${table}`);
}
