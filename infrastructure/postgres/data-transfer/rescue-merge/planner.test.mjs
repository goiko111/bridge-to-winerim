import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateApplyGate,
  canonicalJson,
  planRescueMerge,
  rescueMergeSourcePayloadSha256,
  REVIEWED_POLICY_CONTRACT,
  REVIEWED_POLICY_SHA256,
  sanitizePosConnection,
  sha256,
} from "./planner.mjs";
import {
  BLOCKING_ACTION_TYPES,
  POS_CONNECTION_SANITIZATION,
  RESCUE_MERGE_POLICY_VERSION,
  SOURCE_TABLES,
  TABLE_DEPENDENCIES,
  TABLE_POLICIES,
} from "./policies.mjs";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);

function context(tables, overrides = {}) {
  const artifactOverrides = overrides.artifact || {};
  return {
    source: {
      environment: "lovable-production",
      isolationLevel: "REPEATABLE READ",
      readOnly: true,
      exportedSnapshot: true,
      snapshotAt: "2026-08-03T12:00:00.000Z",
      watermark: {
        walLsn: "16/B374D848",
        snapshotIdSha256: DIGEST_C,
        databaseIdentitySha256: DIGEST_A,
        capturedAt: "2026-08-03T12:00:00.000Z",
      },
    },
    target: {
      environment: "rescue-production",
      isolationLevel: "REPEATABLE READ",
      readOnly: true,
      exportedSnapshot: true,
      snapshotAt: "2026-08-03T12:01:00.000Z",
      watermark: {
        walLsn: "16/B374D900",
        snapshotIdSha256: DIGEST_B,
        databaseIdentitySha256: DIGEST_B,
        capturedAt: "2026-08-03T12:01:00.000Z",
      },
    },
    cutoverAt: "2026-08-03T10:00:00.000Z",
    plannedAt: "2026-08-03T12:05:00.000Z",
    ...overrides,
    artifact: {
      storageClass: "external-encrypted",
      encrypted: true,
      manifestSha256: DIGEST_A,
      payloadSha256: rescueMergeSourcePayloadSha256(tables),
      reviewedPolicyVersion: RESCUE_MERGE_POLICY_VERSION,
      reviewedPolicySha256: REVIEWED_POLICY_SHA256,
      ...artifactOverrides,
    },
  };
}

function inertConnection() {
  return sanitizePosConnection({
    id: "connection-1",
    location_name: "Example",
    provider: "agora",
    base_url: "https://redacted.invalid",
    api_token: "",
    enabled: false,
    catalog_sync_enabled: false,
    write_mode: "NONE",
    sync_mode: "PULL_ONLY",
    created_at: "2026-08-03T08:00:00.000Z",
    updated_at: "2026-08-03T09:00:00.000Z",
  });
}

function dependencyClosedTables(initialTables) {
  const tables = structuredClone(initialTables);
  const addDependencies = (table) => {
    for (const dependency of TABLE_DEPENDENCIES[table] || []) {
      if (!tables[dependency]) {
        tables[dependency] = dependency === "pos_connections"
          ? { source: [], target: [inertConnection()] }
          : { source: [], target: [] };
      }
      addDependencies(dependency);
    }
  };
  for (const table of Object.keys(tables)) addDependencies(table);
  return tables;
}

function scopedPlan(initialTables, contextOverrides = {}) {
  const tables = dependencyClosedTables(initialTables);
  return planRescueMerge({
    context: context(tables, {
      ...contextOverrides,
      scope: { mode: "dependency-closed", tables: Object.keys(tables).sort() },
    }),
    tables,
  });
}

function emptyFullTables() {
  return Object.fromEntries(SOURCE_TABLES.map((table) => [table, { source: [], target: [] }]));
}

function sale(overrides = {}) {
  return {
    id: "source-sale-1",
    connection_id: "connection-1",
    provider_doc_id: "invoice-100",
    business_day: "2026-08-02",
    doc_type: "Invoice",
    total_amount: "25.00",
    total_tax: "2.27",
    total_net: "22.73",
    line_count: 1,
    raw_json: { Number: "100", Serie: "A" },
    created_at: "2026-08-03T09:00:00.000Z",
    ...overrides,
  };
}

test("plans a pre-cutover missing sale as insert and never deletes target-only sales", () => {
  const plan = scopedPlan({
    sales_events: {
      source: [sale()],
      target: [sale({ id: "target-only", provider_doc_id: "invoice-200", created_at: "2026-08-03T11:00:00.000Z" })],
    },
  });

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.counts.INSERT_MISSING, 1);
  assert.equal(plan.actions.filter(({ table, type }) => table === "sales_events" && type === "KEEP_TARGET_ONLY").length, 1);
  assert.equal(plan.mergeSafe, true);
});

test("deduplicates an identical overlapping sale by natural key without overwriting target", () => {
  const source = sale();
  const target = sale({ id: "target-sale-9", created_at: "2026-08-03T09:30:00.000Z" });
  const plan = scopedPlan({
    sales_events: { source: [source], target: [target] },
  });

  assert.equal(plan.counts.IDENTICAL_NOOP, 1);
  assert.equal(plan.identityAliases.length, 1);
  assert.deepEqual(plan.identityAliases[0].sourcePrimaryKey, ["source-sale-1"]);
  assert.deepEqual(plan.identityAliases[0].targetPrimaryKey, ["target-sale-9"]);
  assert.equal(plan.counts.INSERT_MISSING || 0, 0);
});

test("blocks duplicate source sales even when their business payload is identical", () => {
  const plan = scopedPlan({
    sales_events: {
      source: [sale(), sale({ id: "source-sale-duplicate" })],
      target: [],
    },
  });

  assert.equal(plan.counts.SOURCE_DUPLICATE_NATURAL_KEY, 1);
  assert.equal(plan.mergeSafe, false);
  assert.equal(plan.counts.INSERT_MISSING || 0, 0);
});

test("blocks and digests every target-only duplicate row", () => {
  const plan = scopedPlan({
    sales_events: {
      source: [],
      target: [
        sale({ id: "target-sale-a", total_amount: "25.00" }),
        sale({ id: "target-sale-b", total_amount: "30.00" }),
      ],
    },
  });
  const duplicateActions = plan.actions.filter(({ table, type }) => (
    table === "sales_events" && type === "TARGET_DUPLICATE_KEY"
  ));
  const duplicateBlockers = plan.blockers.filter(({ table, type }) => (
    table === "sales_events" && type === "TARGET_DUPLICATE_KEY"
  ));

  assert.equal(plan.mergeSafe, false);
  assert.equal(duplicateActions.length, 2);
  assert.equal(duplicateBlockers.length, 2);
  assert.equal(new Set(duplicateActions.map(({ targetSha256 }) => targetSha256)).size, 2);
  assert.ok(duplicateBlockers.every(({ targetSha256 }) => /^[a-f0-9]{64}$/.test(targetSha256)));
  assert.match(plan.targetRowsSha256, /^[a-f0-9]{64}$/);
});

test("blocks conflicting source and target sales with the same provider document", () => {
  const plan = scopedPlan({
    sales_events: {
      source: [sale()],
      target: [sale({ id: "target-sale-1", total_amount: "30.00" })],
    },
  });

  assert.equal(plan.counts.CONFLICT_SOURCE_TARGET, 1);
  assert.equal(plan.mergeSafe, false);
  assert.equal(plan.counts.INSERT_MISSING || 0, 0);
});

test("protects a fresher target catalog row instead of replacing it", () => {
  const source = {
    id: "source-product",
    connection_id: "connection-1",
    provider_product_id: "700100",
    name: "B Wine Old",
    price: "20.00",
    created_at: "2026-08-03T08:00:00.000Z",
    updated_at: "2026-08-03T09:00:00.000Z",
  };
  const target = {
    ...source,
    id: "target-product",
    name: "B Wine Current",
    price: "24.00",
    updated_at: "2026-08-03T11:00:00.000Z",
  };
  const plan = scopedPlan({
    provider_products: { source: [source], target: [target] },
  });

  assert.equal(plan.counts.PROTECT_TARGET_NEWER, 1);
  assert.equal(plan.counts.INSERT_MISSING || 0, 0);
  assert.equal(plan.mergeSafe, false);
});

test("routes post-cutover source receipts to review and preserves the target receipt", () => {
  const source = {
    id: "source-stock",
    connection_id: "connection-1",
    idempotency_key: "invoice-100:line-1:bottle",
    status: "SUCCESS",
    product_name: "B Wine",
    quantity: "1",
    created_at: "2026-08-03T10:30:00.000Z",
  };
  const target = {
    id: "target-stock",
    connection_id: "connection-1",
    idempotency_key: "invoice-200:line-1:bottle",
    status: "SUCCESS",
    product_name: "B Other Wine",
    quantity: "1",
    created_at: "2026-08-03T11:00:00.000Z",
  };
  const plan = scopedPlan({
    stock_sync_log: { source: [source], target: [target] },
  });

  assert.equal(plan.counts.SOURCE_AFTER_CUTOVER_REVIEW, 1);
  assert.equal(plan.actions.filter(({ table, type }) => table === "stock_sync_log" && type === "KEEP_TARGET_ONLY").length, 1);
  assert.equal(plan.counts.INSERT_MISSING || 0, 0);
});

test("does not auto-merge sales lines without a stable provider line identity", () => {
  const plan = scopedPlan({
    sales_events: { source: [], target: [sale()] },
    sales_line_items: {
      source: [{
        id: "line-source",
        sales_event_id: "source-sale-1",
        connection_id: "connection-1",
        provider_product_id: "700100",
        name: "B Wine",
        quantity: "1",
        created_at: "2026-08-03T09:00:00.000Z",
      }],
      target: [],
    },
  });

  assert.equal(plan.counts.MANUAL_REVIEW_REQUIRED, 1);
  assert.equal(plan.mergeSafe, false);
});

test("requires a complete plan or a structurally dependency-closed scope", () => {
  const incompleteTables = { sales_events: { source: [], target: [] } };
  assert.throws(() => planRescueMerge({
    context: context(incompleteTables),
    tables: incompleteTables,
  }), /every reviewed source table/);

  assert.throws(() => planRescueMerge({
    context: context(incompleteTables, { scope: { mode: "dependency-closed", tables: ["sales_events"] } }),
    tables: incompleteTables,
  }), /missing pos_connections/);

  const fullTables = emptyFullTables();
  const fullPlan = planRescueMerge({ context: context(fullTables), tables: fullTables });
  assert.equal(fullPlan.scope.mode, "full");
  assert.equal(fullPlan.requestedTables.length, SOURCE_TABLES.length);
});

test("recomputes the source payload digest and rejects tables detached from the artifact", () => {
  const tables = dependencyClosedTables({ sales_events: { source: [sale()], target: [] } });
  const planContext = context(tables, {
    scope: { mode: "dependency-closed", tables: Object.keys(tables).sort() },
  });
  const first = planRescueMerge({ context: planContext, tables });
  const tamperedTables = structuredClone(tables);
  tamperedTables.sales_events.source[0].total_amount = "999.00";

  assert.throws(() => planRescueMerge({ context: planContext, tables: tamperedTables }),
    /payload SHA-256 does not match/);
  assert.equal(first.artifactPayloadSha256, rescueMergeSourcePayloadSha256(tables));
  assert.equal(first.sourcePayloadSha256, first.artifactPayloadSha256);
  assert.equal(first.artifactBindingSha256, sha256(canonicalJson({
    artifactManifestSha256: DIGEST_A,
    artifactPayloadSha256: first.artifactPayloadSha256,
    cutoverAt: first.cutoverAt,
    requestedTables: first.requestedTables,
    reviewedPolicySha256: REVIEWED_POLICY_SHA256,
    reviewedPolicyVersion: RESCUE_MERGE_POLICY_VERSION,
    scope: first.scope,
    sourceSnapshotAt: first.sourceSnapshotAt,
    sourceWatermark: first.sourceWatermark,
    sourcePayloadSha256: first.sourcePayloadSha256,
  })));
});

test("validates cutover, source snapshot, target snapshot, plan time, and watermark capture ordering", () => {
  const tables = emptyFullTables();
  const cutoverAfterSource = context(tables, { cutoverAt: "2026-08-03T12:00:01.000Z" });
  assert.throws(() => planRescueMerge({ context: cutoverAfterSource, tables }), /cutoverAt/);

  const sourceAfterTarget = structuredClone(context(tables));
  sourceAfterTarget.source.snapshotAt = "2026-08-03T12:02:00.000Z";
  sourceAfterTarget.source.watermark.capturedAt = sourceAfterTarget.source.snapshotAt;
  assert.throws(() => planRescueMerge({ context: sourceAfterTarget, tables }), /source.snapshotAt/);

  const targetAfterPlan = structuredClone(context(tables));
  targetAfterPlan.target.snapshotAt = "2026-08-03T12:06:00.000Z";
  targetAfterPlan.target.watermark.capturedAt = targetAfterPlan.target.snapshotAt;
  assert.throws(() => planRescueMerge({ context: targetAfterPlan, tables }), /target.snapshotAt/);

  const detachedWatermark = structuredClone(context(tables));
  detachedWatermark.source.watermark.capturedAt = "2026-08-03T11:59:59.000Z";
  assert.throws(() => planRescueMerge({ context: detachedWatermark, tables }), /Source watermark/);

  const sameDatabase = structuredClone(context(tables));
  sameDatabase.target.watermark.databaseIdentitySha256 = sameDatabase.source.watermark.databaseIdentitySha256;
  assert.throws(() => planRescueMerge({ context: sameDatabase, tables }), /identities must differ/);
});

test("rejects impossible or non-UTC context timestamps", () => {
  const tables = emptyFullTables();
  const impossible = context(tables, { plannedAt: "2026-02-30T12:05:00.000Z" });
  assert.throws(() => planRescueMerge({ context: impossible, tables }), /real calendar timestamp/);

  const offset = context(tables, { plannedAt: "2026-08-03T14:05:00.000+02:00" });
  assert.throws(() => planRescueMerge({ context: offset, tables }), /ending in Z/);
});

test("fails closed when a present row timestamp is invalid instead of falling back", () => {
  const invalidUpdatedAt = {
    id: "source-product",
    connection_id: "connection-1",
    provider_product_id: "700100",
    name: "B Wine",
    created_at: "2026-08-03T09:00:00.000Z",
    updated_at: "not-a-date",
  };
  assert.throws(() => scopedPlan({
    provider_products: {
      source: [invalidUpdatedAt],
      target: [{ ...invalidUpdatedAt, id: "target-product", updated_at: "2026-08-03T09:30:00.000Z" }],
    },
  }), /provider_products\.source\[0\]\.updated_at/);
});

test("classifies by the maximum configured timestamp regardless of column priority", () => {
  const plan = scopedPlan({
    provider_products: {
      source: [{
        id: "source-product",
        connection_id: "connection-1",
        provider_product_id: "700100",
        name: "B Wine",
        created_at: "2026-08-03T11:00:00.000Z",
        updated_at: "2026-08-03T09:00:00.000Z",
      }],
      target: [],
    },
  });

  assert.equal(plan.counts.SOURCE_AFTER_CUTOVER_REVIEW, 1);
  assert.equal(plan.counts.INSERT_MISSING || 0, 0);
  assert.match(plan.blockers.find(({ table }) => table === "provider_products").reason, /created_at/);
});

test("rejects caller-supplied policies", () => {
  const injectedPolicies = structuredClone(TABLE_POLICIES);
  injectedPolicies.pos_connections.mode = "immutable-insert-only";
  const tables = { pos_connections: { source: [inertConnection()], target: [] } };
  assert.throws(() => planRescueMerge({
    context: context(tables, { scope: { mode: "dependency-closed", tables: ["pos_connections"] } }),
    tables,
    policies: injectedPolicies,
  }), /Caller-supplied merge policies are forbidden/);
});

test("binds the reviewed policy version and digest and rejects digest drift", () => {
  const plan = scopedPlan({ sales_events: { source: [sale()], target: [] } });
  assert.equal(plan.reviewedPolicyVersion, RESCUE_MERGE_POLICY_VERSION);
  assert.equal(plan.reviewedPolicySha256, REVIEWED_POLICY_SHA256);
  assert.match(plan.reviewedPolicySha256, /^[a-f0-9]{64}$/);

  assert.deepEqual(REVIEWED_POLICY_CONTRACT.blockingActionTypes, BLOCKING_ACTION_TYPES);
  assert.deepEqual(REVIEWED_POLICY_CONTRACT.posConnectionSanitization, POS_CONNECTION_SANITIZATION);
  const blockerDrift = structuredClone(REVIEWED_POLICY_CONTRACT);
  blockerDrift.blockingActionTypes = blockerDrift.blockingActionTypes.filter((type) => type !== "TARGET_DUPLICATE_KEY");
  assert.notEqual(sha256(canonicalJson(blockerDrift)), REVIEWED_POLICY_SHA256);
  const sanitizerDrift = structuredClone(REVIEWED_POLICY_CONTRACT);
  sanitizerDrift.posConnectionSanitization.overrides.enabled = true;
  assert.notEqual(sha256(canonicalJson(sanitizerDrift)), REVIEWED_POLICY_SHA256);

  const fullTables = emptyFullTables();
  const drifted = context(fullTables);
  drifted.artifact.reviewedPolicySha256 = DIGEST_D;
  assert.throws(() => planRescueMerge({ context: drifted, tables: fullTables }),
    /policy digest does not match/);
});

test("propagates a parent PK alias to child FKs and blocks unresolved parents", () => {
  const sourceEvent = sale();
  const targetEvent = sale({ id: "target-sale-9", created_at: "2026-08-03T09:30:00.000Z" });
  const sourceLine = {
    id: "line-source",
    sales_event_id: "source-sale-1",
    connection_id: "connection-1",
    provider_product_id: "700100",
    name: "B Wine",
    quantity: "1",
    created_at: "2026-08-03T09:00:00.000Z",
  };
  const aliased = scopedPlan({
    sales_events: { source: [sourceEvent], target: [targetEvent] },
    sales_line_items: { source: [sourceLine], target: [] },
  });
  assert.deepEqual(aliased.foreignKeyRewrites, [{
    table: "sales_line_items",
    sourcePrimaryKey: ["line-source"],
    column: "sales_event_id",
    referencesTable: "sales_events",
    sourceValue: "source-sale-1",
    targetValue: "target-sale-9",
  }]);
  assert.equal(aliased.actions.some(({ type }) => type === "UNRESOLVED_FOREIGN_KEY"), false);

  const unresolved = scopedPlan({
    sales_line_items: { source: [sourceLine], target: [] },
  });
  assert.equal(unresolved.counts.UNRESOLVED_FOREIGN_KEY, 1);
  assert.equal(unresolved.mergeSafe, false);
});

test("requires and validates the webhook connection dependency", () => {
  const webhook = {
    id: "webhook-source",
    connection_id: "missing-connection",
    provider: "agora",
    event_id: "event-1",
    event_type: "sale",
    payload: {},
    created_at: "2026-08-03T09:00:00.000Z",
  };
  const incompleteTables = { webhook_events: { source: [webhook], target: [] } };
  assert.throws(() => planRescueMerge({
    context: context(incompleteTables, {
      scope: { mode: "dependency-closed", tables: ["webhook_events"] },
    }),
    tables: incompleteTables,
  }), /missing pos_connections/);

  const plan = scopedPlan({ webhook_events: { source: [webhook], target: [] } });
  assert.equal(plan.counts.UNRESOLVED_FOREIGN_KEY, 1);
  assert.equal(plan.counts.INSERT_MISSING || 0, 0);
  assert.equal(plan.mergeSafe, false);
});

test("blocks a source connection that has no exact target correspondence", () => {
  const plan = scopedPlan({
    pos_connections: { source: [inertConnection()], target: [] },
  });
  assert.equal(plan.counts.CONNECTION_IDENTITY_UNRESOLVED, 1);
  assert.equal(plan.counts.INSERT_MISSING || 0, 0);
  assert.equal(plan.mergeSafe, false);
});

test("sanitizes and disables source connections before planning an insert", () => {
  const sanitized = sanitizePosConnection({
    id: "connection-1",
    location_name: "Example",
    provider: "agora",
    base_url: "https://pos.example.test",
    api_token: "secret",
    winerim_api_token: "secret-2",
    provider_config: { token: "secret-3" },
    enabled: true,
    catalog_sync_enabled: true,
    write_mode: "XML_IMPORT",
    sync_mode: "BIDIRECTIONAL",
    updated_at: "2026-08-03T09:00:00.000Z",
  });

  assert.equal(sanitized.enabled, false);
  assert.equal(sanitized.catalog_sync_enabled, false);
  assert.equal(sanitized.write_mode, "NONE");
  assert.equal(sanitized.sync_mode, "PULL_ONLY");
  assert.equal(sanitized.base_url, "https://redacted.invalid");
  assert.equal(sanitized.api_token, "");
  assert.equal(sanitized.winerim_api_token, null);
  assert.deepEqual(sanitized.provider_config, {});
});

test("fails closed on provider credentials and unreviewed credential columns", () => {
  const tables = { provider_credentials: { source: [], target: [] } };
  assert.throws(() => planRescueMerge({
    context: context(tables),
    tables,
  }), /excluded/);
  assert.throws(() => sanitizePosConnection({ id: "connection-1", future_secret: "x" }), /Unreviewed credential-like/);
});

test("keeps apply blocked even when the caller asserts every unverified gate", () => {
  const plan = scopedPlan({
    sales_events: { source: [sale()], target: [] },
  });

  assert.equal(evaluateApplyGate(plan).ready, false);
  assert.equal(evaluateApplyGate(plan, {
    apply: true,
    confirmPlanSha256: plan.planSha256,
    confirmArtifactPayloadSha256: plan.artifactPayloadSha256,
    targetSnapshot: {
      environment: "rescue-production",
      capturedAt: "2026-08-03T12:06:00.000Z",
      restorable: true,
      restoreTested: true,
      manifestSha256: DIGEST_C,
      conflictRecheckPlanSha256: plan.planSha256,
    },
  }).ready, false);
  const assertedGate = evaluateApplyGate(plan, {
    apply: true,
    confirmPlanSha256: plan.planSha256,
    confirmArtifactPayloadSha256: plan.artifactPayloadSha256,
    targetSnapshot: {
      environment: "rescue-production",
      capturedAt: "2026-08-03T12:06:00.000Z",
      restorable: true,
      restoreTested: true,
      manifestSha256: DIGEST_C,
      conflictRecheckPlanSha256: plan.planSha256,
    },
  });
  assert.equal(assertedGate.mode, "APPLY_GATE_BLOCKED");
  assert.ok(assertedGate.blockers.includes("VERIFIED_APPLY_EXECUTOR_NOT_IMPLEMENTED"));
  assert.equal(evaluateApplyGate(plan, {
    apply: true,
    confirmPlanSha256: plan.planSha256,
    confirmArtifactPayloadSha256: plan.artifactPayloadSha256,
    targetSnapshot: {
      environment: "rescue-production",
      capturedAt: "2026-08-03T12:06:00.000Z",
      restorable: true,
      restoreTested: false,
      manifestSha256: DIGEST_C,
      conflictRecheckPlanSha256: plan.planSha256,
    },
  }).ready, false);
});

test("is deterministic for logically identical row sets in different orders", () => {
  const sourceRows = [
    sale({ id: "source-b", total_amount: "30.00" }),
    sale({ id: "source-a", total_amount: "25.00" }),
  ];
  const targetRows = [
    sale({ id: "target-b", provider_doc_id: "invoice-200", total_amount: "40.00" }),
    sale({ id: "target-a", provider_doc_id: "invoice-200", total_amount: "35.00" }),
  ];
  const firstTables = dependencyClosedTables({
    sales_events: { source: sourceRows, target: targetRows },
  });
  const secondTables = dependencyClosedTables({
    sales_events: { source: [...sourceRows].reverse(), target: [...targetRows].reverse() },
  });
  const firstContext = context(firstTables, {
    scope: { mode: "dependency-closed", tables: Object.keys(firstTables).sort() },
  });
  const secondContext = context(secondTables, {
    scope: { mode: "dependency-closed", tables: Object.keys(secondTables).sort() },
  });
  const first = planRescueMerge({ context: firstContext, tables: firstTables });
  const second = planRescueMerge({ context: secondContext, tables: secondTables });

  assert.equal(first.artifactPayloadSha256, second.artifactPayloadSha256);
  assert.equal(first.targetRowsSha256, second.targetRowsSha256);
  assert.equal(first.planSha256, second.planSha256);
  assert.deepEqual(first, second);
});
