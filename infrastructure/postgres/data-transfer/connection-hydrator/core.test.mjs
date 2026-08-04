import test from "node:test";
import assert from "node:assert/strict";

import {
  IMPORT_TABLES,
  buildHydrationPlan,
  buildSourceSnapshot,
  classifyHydrationTarget,
  classifyRollbackTarget,
  reconcilePlan,
  renderHydrationSql,
  renderRollbackSql,
  sanitizePosConnection,
  sha256,
  targetRowsSha256,
} from "./core.mjs";

const CONNECTION_ID = "e465872a-bff5-43de-8e4c-fe4986f0fd4f";
const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const LINE_ID = "10000000-0000-4000-8000-000000000002";

function rawTables() {
  return {
    pos_connections: [{
      id: CONNECTION_ID,
      location_name: "Fixture Agora",
      provider: "agora",
      base_url: "http://private.example:8984",
      api_token: "agora-secret-value",
      winerim_api_token: "winerim-secret-value",
      sync_mode: "BIDIRECTIONAL",
      sync_frequency_minutes: 5,
      backfill_days: 7,
      enabled: true,
      catalog_sync_enabled: true,
      write_mode: "XML_IMPORT",
      provider_config: { ApiToken: "nested-secret", route: "/api" },
      restaurant_guid: "private-guid",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-04T10:00:00.000Z",
      auto_create_families: true,
      write_bottle: true,
      write_glass: true,
      auto_push_on_create: true,
      auto_push_on_update: true,
      auto_push_bottle: true,
      auto_push_glass: true,
      require_manual_review_before_push: false,
      auto_push_verified_ready: true,
      estimated_glasses_per_bottle: 6,
      selected_sale_center_ids: [1],
      consecutive_failures: 2,
    }],
    provider_products: [{
      id: "20000000-0000-4000-8000-000000000001",
      connection_id: CONNECTION_ID,
      provider_product_id: "500100",
      name: "B Example",
      family: "TINTOS WINERIM",
      raw_payload: { Name: "B Example", authorization: "Bearer should-not-leak" },
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-04T10:00:00.000Z",
    }],
    product_mappings: [{
      id: "30000000-0000-4000-8000-000000000001",
      connection_id: CONNECTION_ID,
      provider_product_id: "500100",
      provider_product_name: "B Example",
      winerim_wine_id: "100",
      match_method: "EXACT",
      status: "CONFIRMED",
      format_type: "BOTTLE",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-04T10:00:00.000Z",
    }],
    agora_master_data: [{
      id: "40000000-0000-4000-8000-000000000001",
      connection_id: CONNECTION_ID,
      families_json: [{ Id: 1, Name: "TINTOS WINERIM" }],
      products_summary_json: [{ Id: 500100 }],
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-04T10:00:00.000Z",
    }],
    sales_events: [{
      id: EVENT_ID,
      connection_id: CONNECTION_ID,
      provider_doc_id: "A-100",
      business_day: "2026-08-04",
      doc_type: "Invoice",
      total_amount: "20.00",
      total_tax: "2.00",
      total_net: "18.00",
      line_count: 1,
      raw_json: { Number: "100", api_token: "must-redact" },
      created_at: "2026-08-04T10:00:00.000Z",
    }],
    sales_line_items: [{
      id: LINE_ID,
      sales_event_id: EVENT_ID,
      connection_id: CONNECTION_ID,
      provider_product_id: "500100",
      name: "B Example",
      quantity: "1",
      unit_price: "20.00",
      total_amount: "20.00",
      vat_rate: "10",
      is_wine_candidate: true,
      mapped: true,
      created_at: "2026-08-04T10:00:00.000Z",
    }],
    stock_sync_log: [{
      id: "50000000-0000-4000-8000-000000000001",
      connection_id: CONNECTION_ID,
      sales_event_id: EVENT_ID,
      sales_line_item_id: LINE_ID,
      product_name: "B Example",
      quantity: "1",
      status: "SUCCESS",
      winerim_response: { success: true, token: "must-redact" },
      idempotency_key: "stock:A-100:500100",
      created_at: "2026-08-04T10:00:00.000Z",
    }],
    winerim_push_tracking: [{
      id: "60000000-0000-4000-8000-000000000001",
      connection_id: CONNECTION_ID,
      winerim_wine_id: "100",
      format: "BOTTLE",
      source: "WINERIM",
      sync_status: "VERIFIED",
      task_id: "70000000-0000-4000-8000-000000000001",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-04T10:00:00.000Z",
    }],
    outbound_tasks: [{
      id: "70000000-0000-4000-8000-000000000001",
      connection_id: CONNECTION_ID,
      task_type: "AGORA_XML_UPSERT_PRODUCT",
      payload_json: { ApiToken: "never-export-payload" },
      status: "QUEUED",
      attempts: 1,
      max_attempts: 5,
      last_error: "Authorization: bearer-secret POS_DOWN",
      created_at: "2026-08-04T10:00:00.000Z",
      updated_at: "2026-08-04T10:01:00.000Z",
    }],
  };
}

function source() {
  return buildSourceSnapshot({
    connectionId: CONNECTION_ID,
    rawTables: rawTables(),
    watermark: {
      capturedAt: "2026-08-04T10:05:00.000Z",
      walLsn: "0/123456",
      snapshotSha256: "a".repeat(64),
      databaseIdentitySha256: "b".repeat(64),
    },
  });
}

function emptyTarget() {
  return Object.fromEntries(IMPORT_TABLES.map((table) => [table, []]));
}

test("sanitizes connection credentials and forces every execution switch inactive", () => {
  const sanitized = sanitizePosConnection(rawTables().pos_connections[0]);
  assert.equal(sanitized.enabled, false);
  assert.equal(sanitized.catalog_sync_enabled, false);
  assert.equal(sanitized.write_mode, "NONE");
  assert.equal(sanitized.sync_mode, "PULL_ONLY");
  assert.equal(sanitized.api_token, "");
  assert.equal(sanitized.winerim_api_token, null);
  assert.equal(sanitized.base_url, "https://redacted.invalid");
  assert.equal(sanitized.provider_config, null);
  assert.equal(sanitized.last_business_day_synced, null);
});

test("exports queue debt only as redacted classification and severs task foreign keys", () => {
  const snapshot = source();
  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.outbound.importedCount, 0);
  assert.equal(snapshot.outbound.byDisposition.EXCLUDED_LIVE_DEBT_REVIEW, 1);
  assert.equal(snapshot.outbound.rows[0].errorClass, "POS_DOWN");
  assert.equal(snapshot.tables.winerim_push_tracking[0].task_id, null);
  for (const secret of ["agora-secret-value", "winerim-secret-value", "nested-secret", "never-export-payload", "bearer-secret", "must-redact", "should-not-leak"]) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  }
});

test("plans insert-only hydration, produces bounded rollback and reconciles exact rows", () => {
  const snapshot = source();
  const target = emptyTarget();
  const plan = buildHydrationPlan({
    source: snapshot,
    targetTables: target,
    targetWatermark: { capturedAt: "2026-08-04T10:06:00.000Z", databaseIdentitySha256: "c".repeat(64) },
    runtimeActivity: { activeScopes: 0, activeCredentials: 0, activeCatalogScopes: 0 },
  });
  assert.equal(plan.inserts.pos_connections.length, 1);
  assert.equal(plan.inserts.outbound_tasks, undefined);
  assert.equal(plan.rollbackIds.sales_events.length, 1);
  assert.match(plan.planSha256, /^[0-9a-f]{64}$/);

  const hydrateSql = renderHydrationSql(plan);
  assert.match(hydrateSql, /jsonb_populate_record/);
  assert.match(hydrateSql, /enabled IS FALSE/);
  assert.match(hydrateSql, /TARGET_PREIMAGE_SHA256/);
  assert.match(hydrateSql, /HYDRATION_PREIMAGE_COUNT_MISMATCH/);
  assert.match(hydrateSql, /HYDRATION_PREIMAGE_RUNTIME_SCOPE_ACTIVE/);
  assert.match(hydrateSql, /scope\.run_id = canary\.run_id/);
  assert.match(hydrateSql, /RUNTIME_CATALOG_SCOPE_RUN_ID_ORPHANED/);
  assert.doesNotMatch(hydrateSql, /runtime_catalog_source_scope WHERE connection_id = \$1 AND active/);
  assert.doesNotMatch(hydrateSql, /ON CONFLICT|DO UPDATE|outbound_tasks/i);
  assert.doesNotMatch(hydrateSql, /agora-secret-value|winerim-secret-value|never-export-payload/);

  const rollbackSql = renderRollbackSql(plan);
  assert.match(rollbackSql, new RegExp(EVENT_ID));
  assert.match(rollbackSql, /ROLLBACK_REFUSES_ACTIVE_CONNECTION/);
  assert.match(rollbackSql, /ROLLBACK_POSTCONDITION_COUNT_MISMATCH/);
  assert.doesNotMatch(rollbackSql, /TRUNCATE/);

  const hydrated = Object.fromEntries(IMPORT_TABLES.map((table) => [table, structuredClone(plan.inserts[table])]));
  const reconciliation = reconcilePlan(plan, hydrated, { activeScopes: 0, activeCredentials: 0, activeCatalogScopes: 0 });
  assert.equal(reconciliation.ok, true);
  assert.notEqual(targetRowsSha256(hydrated), plan.targetPreimageSha256);
});

test("classifies repeated hydrate and rollback against exact preimage/postimage", () => {
  const snapshot = source();
  const target = emptyTarget();
  const runtimeActivity = { activeScopes: 0, activeCredentials: 0, activeCatalogScopes: 0 };
  const plan = buildHydrationPlan({
    source: snapshot,
    targetTables: target,
    targetWatermark: { capturedAt: "2026-08-04T10:06:00.000Z", databaseIdentitySha256: "c".repeat(64) },
    runtimeActivity,
  });
  assert.deepEqual(classifyHydrationTarget(plan, target, runtimeActivity), {
    state: "PREIMAGE",
    idempotentReplay: false,
    reconciliation: null,
  });

  const hydrated = Object.fromEntries(IMPORT_TABLES.map((table) => [table, structuredClone(plan.inserts[table])]));
  const hydrateReplay = classifyHydrationTarget(plan, hydrated, runtimeActivity);
  assert.equal(hydrateReplay.state, "POSTIMAGE_EXACT");
  assert.equal(hydrateReplay.idempotentReplay, true);
  assert.equal(hydrateReplay.reconciliation.ok, true);

  const rollback = classifyRollbackTarget(plan, hydrated, runtimeActivity);
  assert.equal(rollback.state, "POSTIMAGE_EXACT");
  assert.equal(rollback.idempotentReplay, false);
  assert.equal(rollback.reconciliation.ok, true);
  assert.deepEqual(classifyRollbackTarget(plan, target, runtimeActivity), {
    state: "PREIMAGE_EXACT",
    idempotentReplay: true,
    reconciliation: null,
  });
});

test("fails closed on active destinations and UUID or natural-key collisions", () => {
  const snapshot = source();
  const activeTarget = emptyTarget();
  activeTarget.pos_connections = [{ ...snapshot.tables.pos_connections[0], enabled: true }];
  assert.throws(() => buildHydrationPlan({
    source: snapshot,
    targetTables: activeTarget,
    targetWatermark: {},
  }), /TARGET_CONNECTION_ENABLED/);

  const collisionTarget = emptyTarget();
  collisionTarget.pos_connections = [snapshot.tables.pos_connections[0]];
  collisionTarget.sales_events = [{
    ...snapshot.tables.sales_events[0],
    id: "90000000-0000-4000-8000-000000000001",
  }];
  assert.throws(() => buildHydrationPlan({
    source: snapshot,
    targetTables: collisionTarget,
    targetWatermark: {},
  }), /TARGET_CONFLICTS.*NATURAL_KEY_CONFLICT/);
});

test("source payload digest changes for an idempotency or business row change", () => {
  const first = source();
  const changed = rawTables();
  changed.stock_sync_log[0].idempotency_key = "stock:A-100:500100:changed";
  const second = buildSourceSnapshot({
    connectionId: CONNECTION_ID,
    rawTables: changed,
    watermark: first.watermark,
  });
  assert.notEqual(first.payloadSha256, second.payloadSha256);
  assert.notEqual(sha256(first.tables.stock_sync_log), sha256(second.tables.stock_sync_log));
});
