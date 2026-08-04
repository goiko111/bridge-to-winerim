import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  APPLY_CONFIRMATION,
  backupManifestDigest,
  evaluateExecutorApplyGate,
  executeRescueMerge,
  prepareInsertRows,
  RescueMergeError,
} from "./executor.mjs";
import {
  canonicalJson,
  planRescueMerge,
  rescueMergeSourcePayloadSha256,
  REVIEWED_POLICY_SHA256,
  sanitizePosConnection,
  sha256,
} from "./planner.mjs";
import { RESCUE_MERGE_POLICY_VERSION } from "./policies.mjs";

const execFileAsync = promisify(execFile);
const TARGET_IDENTITY = "b".repeat(64);
const SOURCE_IDENTITY = "a".repeat(64);

function connection() {
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

function sale(overrides = {}) {
  return {
    id: "sale-source-1",
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

function plannerInput({ sourceSale = sale(), targetSales = [] } = {}) {
  const tables = {
    pos_connections: { source: [], target: [connection()] },
    sales_events: { source: sourceSale ? [sourceSale] : [], target: targetSales },
  };
  return {
    context: {
      source: {
        environment: "lovable-production",
        isolationLevel: "REPEATABLE READ",
        readOnly: true,
        exportedSnapshot: true,
        snapshotAt: "2026-08-03T12:00:00.000Z",
        watermark: {
          walLsn: "16/B374D848",
          snapshotIdSha256: "c".repeat(64),
          databaseIdentitySha256: SOURCE_IDENTITY,
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
          snapshotIdSha256: "d".repeat(64),
          databaseIdentitySha256: TARGET_IDENTITY,
          capturedAt: "2026-08-03T12:01:00.000Z",
        },
      },
      cutoverAt: "2026-08-03T10:00:00.000Z",
      plannedAt: "2026-08-03T12:05:00.000Z",
      scope: { mode: "dependency-closed", tables: ["pos_connections", "sales_events"] },
      artifact: {
        storageClass: "external-encrypted",
        encrypted: true,
        manifestSha256: "e".repeat(64),
        payloadSha256: rescueMergeSourcePayloadSha256(tables),
        reviewedPolicyVersion: RESCUE_MERGE_POLICY_VERSION,
        reviewedPolicySha256: REVIEWED_POLICY_SHA256,
      },
    },
    tables,
  };
}

function backupManifest(plan, overrides = {}) {
  const manifest = {
    schemaVersion: 1,
    environment: "rescue-production",
    storageClass: "external-encrypted",
    encrypted: true,
    restorable: true,
    restoreTested: true,
    capturedAt: "2026-08-03T12:06:00.000Z",
    restoreTestedAt: "2026-08-03T12:07:00.000Z",
    databaseIdentitySha256: TARGET_IDENTITY,
    targetRowsSha256: plan.targetRowsSha256,
    conflictRecheckPlanSha256: plan.planSha256,
    artifact: {
      relativePath: "target-backup.age",
      sha256: sha256("encrypted-backup"),
      bytes: Buffer.byteLength("encrypted-backup"),
    },
    ...overrides,
  };
  manifest.manifestSha256 = backupManifestDigest(manifest);
  return manifest;
}

function confirmations(plan, backup) {
  return {
    apply: APPLY_CONFIRMATION,
    planSha256: plan.planSha256,
    artifactPayloadSha256: plan.artifactPayloadSha256,
    backupManifestSha256: backup.manifestSha256,
  };
}

class MockDatabase {
  constructor({ targetRows, identity = TARGET_IDENTITY, mutateAfterInsert = false, failInsert = false }) {
    this.targetRows = structuredClone(targetRows);
    this.identity = identity;
    this.mutateAfterInsert = mutateAfterInsert;
    this.failInsert = failInsert;
    this.events = [];
    this.snapshot = null;
  }

  async connect() { this.events.push("connect"); }
  async beginSerializable() {
    this.events.push("begin:serializable");
    this.snapshot = structuredClone(this.targetRows);
  }
  async acquireAdvisoryLock() { this.events.push("lock:advisory-xact"); }
  async databaseIdentitySha256() { this.events.push("identity"); return this.identity; }
  async readTables(tables) {
    this.events.push("read");
    return Object.fromEntries(tables.map((table) => [table, structuredClone(this.targetRows[table] || [])]));
  }
  async insertRow(table, row) {
    this.events.push(`insert:${table}`);
    if (this.failInsert) throw new Error("fixture insert failure");
    this.targetRows[table].push(structuredClone(row));
    if (this.mutateAfterInsert) this.targetRows[table].at(-1).total_amount = "999.00";
    return 1;
  }
  async commit() { this.events.push("commit"); }
  async rollback() {
    this.events.push("rollback");
    this.targetRows = structuredClone(this.snapshot);
  }
  async close() { this.events.push("close"); }
}

function readyFixture() {
  const input = plannerInput();
  const plan = planRescueMerge(input);
  const backup = backupManifest(plan);
  return { input, plan, backup };
}

test("dry-run is the default and the apply gate requires every explicit confirmation", () => {
  const { input, plan, backup } = readyFixture();
  const blocked = evaluateExecutorApplyGate({
    plan,
    plannerInput: input,
    backupManifest: backup,
    now: new Date("2026-08-03T12:08:00.000Z"),
  });
  assert.equal(blocked.ready, false);
  assert.ok(blocked.blockers.includes("APPLY_FLAG_NOT_SET"));
  assert.ok(blocked.blockers.includes("APPLY_PHRASE_NOT_CONFIRMED"));
  assert.ok(blocked.blockers.includes("PLAN_DIGEST_NOT_CONFIRMED"));
  assert.ok(blocked.blockers.includes("ARTIFACT_PAYLOAD_NOT_CONFIRMED"));
  assert.ok(blocked.blockers.includes("BACKUP_MANIFEST_NOT_EXPLICITLY_CONFIRMED"));
});

test("opens the executor gate only for a recomputed safe plan and verified backup", () => {
  const { input, plan, backup } = readyFixture();
  const gate = evaluateExecutorApplyGate({
    plan,
    plannerInput: input,
    backupManifest: backup,
    apply: true,
    confirmApply: APPLY_CONFIRMATION,
    confirmPlanSha256: plan.planSha256,
    confirmArtifactPayloadSha256: plan.artifactPayloadSha256,
    confirmBackupManifestSha256: backup.manifestSha256,
    now: new Date("2026-08-03T12:08:00.000Z"),
  });
  assert.deepEqual(gate, { ready: true, mode: "APPLY_GATE_READY", blockers: [] });
});

test("executes advisory-locked serializable insert-only apply and exact pre-commit reconciliation", async () => {
  const { input, plan, backup } = readyFixture();
  const database = new MockDatabase({
    targetRows: Object.fromEntries(Object.entries(input.tables).map(([table, sides]) => [table, sides.target])),
  });
  const result = await executeRescueMerge({
    plan,
    plannerInput: input,
    backupManifest: backup,
    confirmations: confirmations(plan, backup),
    database,
    now: new Date("2026-08-03T12:08:00.000Z"),
  });
  assert.equal(result.result, "APPLIED_INSERT_MISSING_ONLY");
  assert.equal(result.insertedCount, 1);
  assert.deepEqual(result.insertedByTable, { sales_events: 1 });
  assert.deepEqual(database.events, [
    "connect",
    "begin:serializable",
    "lock:advisory-xact",
    "identity",
    "read",
    "insert:sales_events",
    "read",
    "commit",
    "close",
  ]);
});

test("rolls back automatically when the target changed after planning", async () => {
  const { input, plan, backup } = readyFixture();
  const drifted = structuredClone(input.tables);
  drifted.sales_events.target.push(sale({ id: "target-new", provider_doc_id: "invoice-200" }));
  const database = new MockDatabase({
    targetRows: Object.fromEntries(Object.entries(drifted).map(([table, sides]) => [table, sides.target])),
  });
  await assert.rejects(() => executeRescueMerge({
    plan,
    plannerInput: input,
    backupManifest: backup,
    confirmations: confirmations(plan, backup),
    database,
    now: new Date("2026-08-03T12:08:00.000Z"),
  }), (error) => error instanceof RescueMergeError && error.code === "TARGET_SNAPSHOT_ROWS_DRIFT");
  assert.ok(database.events.includes("rollback"));
  assert.ok(!database.events.some((event) => event.startsWith("insert:")));
});

test("rolls back before commit when exact post-reconciliation detects trigger-like drift", async () => {
  const { input, plan, backup } = readyFixture();
  const database = new MockDatabase({
    targetRows: Object.fromEntries(Object.entries(input.tables).map(([table, sides]) => [table, sides.target])),
    mutateAfterInsert: true,
  });
  await assert.rejects(() => executeRescueMerge({
    plan,
    plannerInput: input,
    backupManifest: backup,
    confirmations: confirmations(plan, backup),
    database,
    now: new Date("2026-08-03T12:08:00.000Z"),
  }), (error) => error instanceof RescueMergeError
    && ["POST_RECONCILIATION_TARGET_DIGEST_MISMATCH", "POST_RECONCILIATION_BLOCKED"].includes(error.code));
  assert.ok(database.events.includes("rollback"));
  assert.ok(!database.events.includes("commit"));
  assert.equal(database.targetRows.sales_events.length, 0);
});

test("rejects credential-shaped nested material even in an otherwise insertable row", () => {
  const input = plannerInput({ sourceSale: sale({ raw_json: { api_token: "must-not-copy" } }) });
  const plan = planRescueMerge(input);
  assert.throws(() => prepareInsertRows({ plan, plannerInput: input }), (error) => (
    error instanceof RescueMergeError && error.code === "CREDENTIAL_MATERIAL_IN_INSERT_ROW"
  ));
});

test("schema gaps remain fail-closed for sales lines without provider identity", () => {
  const input = plannerInput();
  input.tables.sales_line_items = {
    source: [{
      id: "line-1",
      sales_event_id: "sale-source-1",
      connection_id: "connection-1",
      provider_product_id: "700100",
      name: "B Wine",
      quantity: "1",
      created_at: "2026-08-03T09:00:00.000Z",
    }],
    target: [],
  };
  input.context.scope.tables.push("sales_line_items");
  input.context.scope.tables.sort();
  input.context.artifact.payloadSha256 = rescueMergeSourcePayloadSha256(input.tables);
  const plan = planRescueMerge(input);
  assert.equal(plan.mergeSafe, false);
  assert.equal(plan.counts.MANUAL_REVIEW_REQUIRED, 1);
  assert.throws(() => prepareInsertRows({ plan, plannerInput: input }), /PLAN_HAS_BLOCKERS/);
});

test("backup binding fails closed on target or plan mismatch", () => {
  const { input, plan } = readyFixture();
  const backup = backupManifest(plan, { targetRowsSha256: "f".repeat(64) });
  const gate = evaluateExecutorApplyGate({
    plan,
    plannerInput: input,
    backupManifest: backup,
    apply: true,
    confirmApply: APPLY_CONFIRMATION,
    confirmPlanSha256: plan.planSha256,
    confirmArtifactPayloadSha256: plan.artifactPayloadSha256,
    confirmBackupManifestSha256: backup.manifestSha256,
    now: new Date("2026-08-03T12:08:00.000Z"),
  });
  assert.equal(gate.ready, false);
  assert.ok(gate.blockers.includes("BACKUP_TARGET_ROWS_MISMATCH"));
});

test("CLI stays offline by default and writes owner-only artifacts", async () => {
  const { input, plan, backup } = readyFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "rescue-merge-cli-"));
  const outputDir = path.join(root, "output");
  const files = {
    plan: path.join(root, "plan.json"),
    artifact: path.join(root, "artifact.json"),
    backup: path.join(root, "backup.json"),
    backupArtifact: path.join(root, "target-backup.age"),
  };
  await writeFile(files.plan, `${JSON.stringify(plan)}\n`, { mode: 0o600 });
  await writeFile(files.artifact, `${JSON.stringify({ schemaVersion: 1, plannerInput: input })}\n`, { mode: 0o600 });
  await writeFile(files.backupArtifact, "encrypted-backup", { mode: 0o600 });
  await writeFile(files.backup, `${JSON.stringify(backup)}\n`, { mode: 0o600 });
  await Promise.all(Object.values(files).map((file) => chmod(file, 0o600)));

  const { stdout } = await execFileAsync(process.execPath, [
    new URL("./cli.mjs", import.meta.url).pathname,
    "--plan", files.plan,
    "--artifact", files.artifact,
    "--backup-manifest", files.backup,
    "--output-dir", outputDir,
  ], {
    env: { ...process.env, RESCUE_MERGE_TARGET_DATABASE_URL: "" },
  });
  const report = JSON.parse(stdout);
  assert.equal(report.result, "DRY_RUN_READY_APPLY_NOT_REQUESTED");
  assert.equal(report.connectedToDatabase, false);
  const reportStat = await stat(path.join(outputDir, "rescue-merge-dry-run.json"));
  assert.equal(reportStat.mode & 0o777, 0o600);
  assert.equal((await stat(outputDir)).mode & 0o777, 0o700);
  assert.equal(JSON.parse(await readFile(path.join(outputDir, "rescue-merge-dry-run.json"), "utf8")).insertCount, 1);
});

test("planner and apply artifacts remain deterministic", () => {
  const { input, plan } = readyFixture();
  const reversed = structuredClone(input);
  reversed.tables.pos_connections.target.reverse();
  assert.equal(planRescueMerge(reversed).planSha256, plan.planSha256);
  assert.equal(canonicalJson(prepareInsertRows({ plan, plannerInput: input })),
    canonicalJson(prepareInsertRows({ plan, plannerInput: reversed })));
});
