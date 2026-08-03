import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateApplyGate,
  planRescueMerge,
  sanitizePosConnection,
} from "./planner.mjs";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

function context(overrides = {}) {
  return {
    source: {
      environment: "lovable-production",
      isolationLevel: "REPEATABLE READ",
      readOnly: true,
      exportedSnapshot: true,
      snapshotAt: "2026-08-03T12:00:00.000Z",
      watermark: { walLsn: "16/B374D848", snapshotIdSha256: DIGEST_C },
    },
    target: {
      environment: "rescue-production",
      isolationLevel: "REPEATABLE READ",
      readOnly: true,
      exportedSnapshot: true,
      snapshotAt: "2026-08-03T12:01:00.000Z",
      watermark: { walLsn: "16/B374D900", snapshotIdSha256: DIGEST_B },
    },
    artifact: {
      storageClass: "external-encrypted",
      encrypted: true,
      manifestSha256: DIGEST_A,
      payloadSha256: DIGEST_B,
    },
    cutoverAt: "2026-08-03T10:00:00.000Z",
    plannedAt: "2026-08-03T12:05:00.000Z",
    ...overrides,
  };
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
  const plan = planRescueMerge({
    context: context(),
    tables: {
      sales_events: {
        source: [sale()],
        target: [sale({ id: "target-only", provider_doc_id: "invoice-200", created_at: "2026-08-03T11:00:00.000Z" })],
      },
    },
  });

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.counts.INSERT_MISSING, 1);
  assert.equal(plan.counts.KEEP_TARGET_ONLY, 1);
  assert.equal(plan.mergeSafe, true);
});

test("deduplicates an identical overlapping sale by natural key without overwriting target", () => {
  const source = sale();
  const target = sale({ id: "target-sale-9", created_at: "2026-08-03T09:30:00.000Z" });
  const plan = planRescueMerge({
    context: context(),
    tables: { sales_events: { source: [source], target: [target] } },
  });

  assert.equal(plan.counts.IDENTICAL_NOOP, 1);
  assert.equal(plan.identityAliases.length, 1);
  assert.deepEqual(plan.identityAliases[0].sourcePrimaryKey, ["source-sale-1"]);
  assert.deepEqual(plan.identityAliases[0].targetPrimaryKey, ["target-sale-9"]);
  assert.equal(plan.counts.INSERT_MISSING || 0, 0);
});

test("blocks duplicate source sales even when their business payload is identical", () => {
  const plan = planRescueMerge({
    context: context(),
    tables: {
      sales_events: {
        source: [sale(), sale({ id: "source-sale-duplicate" })],
        target: [],
      },
    },
  });

  assert.equal(plan.counts.SOURCE_DUPLICATE_NATURAL_KEY, 1);
  assert.equal(plan.mergeSafe, false);
  assert.equal(plan.counts.INSERT_MISSING || 0, 0);
});

test("blocks conflicting source and target sales with the same provider document", () => {
  const plan = planRescueMerge({
    context: context(),
    tables: {
      sales_events: {
        source: [sale()],
        target: [sale({ id: "target-sale-1", total_amount: "30.00" })],
      },
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
  const plan = planRescueMerge({
    context: context(),
    tables: { provider_products: { source: [source], target: [target] } },
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
  const plan = planRescueMerge({
    context: context(),
    tables: { stock_sync_log: { source: [source], target: [target] } },
  });

  assert.equal(plan.counts.SOURCE_AFTER_CUTOVER_REVIEW, 1);
  assert.equal(plan.counts.KEEP_TARGET_ONLY, 1);
  assert.equal(plan.counts.INSERT_MISSING || 0, 0);
});

test("does not auto-merge sales lines without a stable provider line identity", () => {
  const plan = planRescueMerge({
    context: context(),
    tables: {
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
    },
  });

  assert.equal(plan.counts.MANUAL_REVIEW_REQUIRED, 1);
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
  assert.throws(() => planRescueMerge({
    context: context(),
    tables: { provider_credentials: { source: [], target: [] } },
  }), /excluded/);
  assert.throws(() => sanitizePosConnection({ id: "connection-1", future_secret: "x" }), /Unreviewed credential-like/);
});

test("requires a tested rollback snapshot and exact plan digest before apply", () => {
  const plan = planRescueMerge({
    context: context(),
    tables: { sales_events: { source: [sale()], target: [] } },
  });

  assert.equal(evaluateApplyGate(plan).ready, false);
  assert.equal(evaluateApplyGate(plan, {
    apply: true,
    confirmPlanSha256: plan.planSha256,
    targetSnapshot: {
      environment: "rescue-production",
      capturedAt: "2026-08-03T12:06:00.000Z",
      restorable: true,
      restoreTested: true,
      manifestSha256: DIGEST_C,
      conflictRecheckPlanSha256: plan.planSha256,
    },
  }).ready, true);
  assert.equal(evaluateApplyGate(plan, {
    apply: true,
    confirmPlanSha256: plan.planSha256,
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

test("is deterministic for identical inputs", () => {
  const input = {
    context: context(),
    tables: { sales_events: { source: [sale()], target: [] } },
  };
  assert.deepEqual(planRescueMerge(input), planRescueMerge(input));
});
