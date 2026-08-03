function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export const RESCUE_MERGE_POLICY_VERSION = "2026-08-03.2";

export const POS_CONNECTION_SANITIZATION = deepFreeze({
  credentialFieldPattern: "(?:token|secret|password|credential|authorization|bearer|api[_-]?key|dsn|(?:^|_)url(?:_|$)|endpoint|provider_config|restaurant_guid)",
  credentialFieldFlags: "i",
  controlledCredentialFields: [
    "api_token",
    "base_url",
    "catalog_endpoint",
    "provider_config",
    "restaurant_guid",
    "winerim_api_token",
  ],
  overrides: {
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
  },
});

export const BLOCKING_ACTION_TYPES = deepFreeze([
  "CONFLICT_SOURCE_TARGET",
  "CONNECTION_IDENTITY_UNRESOLVED",
  "MANUAL_REVIEW_REQUIRED",
  "MISSING_NATURAL_KEY",
  "MISSING_SOURCE_WATERMARK",
  "PROTECT_TARGET_NEWER",
  "SOURCE_AFTER_CUTOVER_REVIEW",
  "SOURCE_DUPLICATE_NATURAL_KEY",
  "SOURCE_DUPLICATE_PRIMARY_KEY",
  "TARGET_DUPLICATE_KEY",
  "UNRESOLVED_FOREIGN_KEY",
]);

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

export const EXCLUDED_SOURCE_TABLES = deepFreeze([
  "provider_credentials",
  "runtime_canary_connections",
  "runtime_connection_credentials",
  "runtime_execution_log",
  "runtime_idempotency",
]);

export const SOURCE_TABLES = deepFreeze([
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

export const TABLE_POLICIES = deepFreeze({
  agora_dispatch_locks: {
    ...manual({
    naturalKey: ["connection_id"],
    reason: "Ephemeral leases must never move between runtimes.",
    }),
    primaryKey: ["connection_id"],
  },
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
    mode: "identity-required",
    primaryKey: ["id"],
    naturalKey: null,
    boundaryColumns: ["updated_at", "created_at"],
    freshnessColumns: ["updated_at", "created_at"],
    compareIgnore: ["created_at", "updated_at"],
    requireNaturalKeyForInsert: false,
    reason: "Connection UUID is the only reliable identity; a source connection without a target correspondence must block.",
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

export const TABLE_DEPENDENCIES = deepFreeze({
  agora_dispatch_locks: ["pos_connections"],
  agora_master_data: ["pos_connections"],
  classification_config: ["pos_connections"],
  connection_alerts: ["pos_connections", "connection_health_checks"],
  connection_health_checks: ["pos_connections"],
  connection_notification_contacts: ["pos_connections"],
  integration_onboarding_requests: ["pos_connections"],
  middleware_incident_email_attempts: ["middleware_incidents", "pos_connections"],
  middleware_incident_events: ["middleware_incidents", "pos_connections"],
  middleware_incidents: ["pos_connections"],
  outbound_tasks: ["pos_connections"],
  pos_connections: [],
  product_mappings: ["pos_connections"],
  provider_capabilities: ["pos_connections"],
  provider_products: ["pos_connections"],
  sales_events: ["pos_connections"],
  sales_line_items: ["sales_events", "pos_connections"],
  stock_sync_log: ["sales_events", "sales_line_items", "pos_connections"],
  user_roles: ["pos_connections"],
  webhook_events: ["pos_connections"],
  wine_family_rules: ["pos_connections"],
  wine_type_family_mappings: ["pos_connections"],
  winerim_push_tracking: ["outbound_tasks", "pos_connections"],
  winerim_wines: ["pos_connections"],
});

export const FOREIGN_KEYS = deepFreeze({
  agora_dispatch_locks: [{ column: "connection_id", referencesTable: "pos_connections", nullable: false }],
  agora_master_data: [{ column: "connection_id", referencesTable: "pos_connections", nullable: false }],
  classification_config: [{ column: "connection_id", referencesTable: "pos_connections", nullable: false }],
  connection_alerts: [
    { column: "connection_id", referencesTable: "pos_connections", nullable: false },
    { column: "last_check_id", referencesTable: "connection_health_checks", nullable: true },
  ],
  connection_health_checks: [{ column: "connection_id", referencesTable: "pos_connections", nullable: false }],
  connection_notification_contacts: [{ column: "connection_id", referencesTable: "pos_connections", nullable: false }],
  integration_onboarding_requests: [{ column: "activated_connection_id", referencesTable: "pos_connections", nullable: true }],
  middleware_incident_email_attempts: [
    { column: "incident_id", referencesTable: "middleware_incidents", nullable: false },
    { column: "connection_id", referencesTable: "pos_connections", nullable: false },
  ],
  middleware_incident_events: [
    { column: "incident_id", referencesTable: "middleware_incidents", nullable: false },
    { column: "connection_id", referencesTable: "pos_connections", nullable: false },
  ],
  middleware_incidents: [{ column: "connection_id", referencesTable: "pos_connections", nullable: false }],
  outbound_tasks: [{ column: "connection_id", referencesTable: "pos_connections", nullable: false }],
  pos_connections: [],
  product_mappings: [{ column: "connection_id", referencesTable: "pos_connections", nullable: false }],
  provider_capabilities: [{ column: "connection_id", referencesTable: "pos_connections", nullable: false }],
  provider_products: [{ column: "connection_id", referencesTable: "pos_connections", nullable: false }],
  sales_events: [{ column: "connection_id", referencesTable: "pos_connections", nullable: false }],
  sales_line_items: [
    { column: "sales_event_id", referencesTable: "sales_events", nullable: false },
    { column: "connection_id", referencesTable: "pos_connections", nullable: false },
  ],
  stock_sync_log: [
    { column: "sales_event_id", referencesTable: "sales_events", nullable: true },
    { column: "sales_line_item_id", referencesTable: "sales_line_items", nullable: true },
    { column: "connection_id", referencesTable: "pos_connections", nullable: false },
  ],
  user_roles: [{ column: "connection_id", referencesTable: "pos_connections", nullable: true }],
  webhook_events: [{ column: "connection_id", referencesTable: "pos_connections", nullable: true }],
  wine_family_rules: [{ column: "connection_id", referencesTable: "pos_connections", nullable: false }],
  wine_type_family_mappings: [{ column: "connection_id", referencesTable: "pos_connections", nullable: false }],
  winerim_push_tracking: [
    { column: "task_id", referencesTable: "outbound_tasks", nullable: true },
    { column: "connection_id", referencesTable: "pos_connections", nullable: false },
  ],
  winerim_wines: [{ column: "connection_id", referencesTable: "pos_connections", nullable: false }],
});

export const SCHEMA_GAPS = deepFreeze([
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
  if (!TABLE_DEPENDENCIES[table]) throw new Error(`Missing rescue merge dependency policy for ${table}`);
  if (!FOREIGN_KEYS[table]) throw new Error(`Missing rescue merge foreign-key policy for ${table}`);
}
