#!/usr/bin/env node
import path from "node:path";

import {
  HYDRATE_CONFIRMATION,
  IMPORT_TABLES,
  ROLLBACK_CONFIRMATION,
  buildHydrationPlan,
  buildSourceSnapshot,
  canonicalize,
  classifyHydrationTarget,
  classifyRollbackTarget,
  reconcilePlan,
  renderHydrationSql,
  renderReconcileSql,
  renderRollbackSql,
  targetRowsSha256,
} from "./core.mjs";
import {
  readPlanArtifact,
  readSourceArtifact,
  prepareAtomicResultArtifact,
  writePlanArtifact,
  writeSourceArtifact,
} from "./artifacts.mjs";
import { executeWriteTransaction, runJournaledMutation } from "./operations.mjs";
import { ConnectionHydratorDatabase, isLocalDatabaseUrl } from "./postgres.mjs";

function parseArgs(argv) {
  const command = argv[0] || "help";
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`UNEXPECTED_ARGUMENT:${token}`);
    const key = token.slice(2);
    if (key === "apply") options.apply = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`MISSING_ARGUMENT_VALUE:${key}`);
      options[key] = value;
    }
  }
  return { command, options };
}

function required(options, name) {
  if (!options[name]) throw new Error(`REQUIRED_OPTION_MISSING:${name}`);
  return options[name];
}

function databaseUrl(environmentName) {
  const value = process.env[environmentName];
  if (!value) throw new Error(`${environmentName}_REQUIRED`);
  return value;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function nonLocalApplyGate(databaseUrlValue) {
  if (isLocalDatabaseUrl(databaseUrlValue)) return;
  if (process.env.CONNECTION_HYDRATOR_ALLOW_NONLOCAL_TARGET !== "1") {
    throw new Error("NONLOCAL_TARGET_APPLY_DISABLED");
  }
}

async function withDatabase(connectionString, applicationName, operation) {
  const database = new ConnectionHydratorDatabase({ connectionString, applicationName });
  await database.connect();
  try {
    return await operation(database);
  } finally {
    await database.close();
  }
}

async function exportCommand(options) {
  const connectionId = required(options, "connection-id");
  const outputDir = path.resolve(required(options, "output-dir"));
  const sourceUrl = databaseUrl("CONNECTION_HYDRATOR_SOURCE_DATABASE_URL");
  const source = await withDatabase(sourceUrl, "winerim-connection-hydrator-export", async (database) => {
    await database.beginReadOnly();
    try {
      const [watermark, rawTables] = await Promise.all([
        database.watermark(),
        database.readSourceTables(connectionId),
      ]);
      await database.commit();
      return buildSourceSnapshot({ connectionId, rawTables, watermark });
    } catch (error) {
      await database.rollback();
      throw error;
    }
  });
  const manifest = await writeSourceArtifact(source, outputDir);
  print({
    result: "CONNECTION_SOURCE_ARTIFACT_READY",
    connectionId: source.connectionId,
    outputDir,
    manifestSha256: manifest.manifestSha256,
    payloadSha256: source.payloadSha256,
    tables: manifest.files.map(({ table, rowCount, rowsSha256 }) => ({ table, rowCount, rowsSha256 })),
    outbound: source.outbound.byDisposition,
  });
}

async function verifyCommand(options) {
  const artifactDir = path.resolve(required(options, "artifact-dir"));
  const { source, manifest } = await readSourceArtifact(artifactDir);
  print({
    result: "CONNECTION_SOURCE_ARTIFACT_VERIFIED",
    connectionId: source.connectionId,
    manifestSha256: manifest.manifestSha256,
    payloadSha256: source.payloadSha256,
    outboundImported: source.outbound.importedCount,
  });
}

async function prepareCommand(options) {
  const artifactDir = path.resolve(required(options, "artifact-dir"));
  const outputDir = path.resolve(required(options, "output-dir"));
  const targetUrl = databaseUrl("CONNECTION_HYDRATOR_TARGET_DATABASE_URL");
  const { source, manifest: sourceManifest } = await readSourceArtifact(artifactDir);
  const prepared = await withDatabase(targetUrl, "winerim-connection-hydrator-prepare", async (database) => {
    await database.beginReadOnly();
    try {
      const [targetWatermark, targetTables, runtimeActivity] = await Promise.all([
        database.watermark(),
        database.readTargetTables(source.connectionId),
        database.runtimeActivity(source.connectionId),
      ]);
      for (const table of IMPORT_TABLES) await database.assertRowsFitSchema(table, source.tables[table]);
      const plan = buildHydrationPlan({ source, targetTables, targetWatermark, runtimeActivity });
      await database.commit();
      return plan;
    } catch (error) {
      await database.rollback();
      throw error;
    }
  });
  const result = await writePlanArtifact({
    plan: prepared,
    sourceManifest,
    outputDir,
    hydrationSql: renderHydrationSql(prepared),
    rollbackSql: renderRollbackSql(prepared),
    reconcileSql: renderReconcileSql(prepared),
  });
  print({
    result: "INACTIVE_HYDRATION_PLAN_READY",
    connectionId: prepared.connectionId,
    outputDir,
    planSha256: prepared.planSha256,
    planManifestSha256: result.manifest.manifestSha256,
    inserts: Object.fromEntries(IMPORT_TABLES.map((table) => [table, prepared.inserts[table].length])),
    noops: Object.fromEntries(IMPORT_TABLES.map((table) => [table, prepared.noops[table].length])),
  });
}

function assertApplyConfirmations(options, plan, expectedPhrase) {
  if (!options.apply) throw new Error("APPLY_FLAG_REQUIRED");
  if (options["confirm-action"] !== expectedPhrase) throw new Error("APPLY_CONFIRMATION_MISMATCH");
  if (options["confirm-plan-sha256"] !== plan.planSha256) throw new Error("PLAN_CONFIRMATION_MISMATCH");
  if (options["confirm-target-identity-sha256"] !== plan.targetWatermark.databaseIdentitySha256) {
    throw new Error("TARGET_IDENTITY_CONFIRMATION_MISMATCH");
  }
}

function validateExistingResult(existing, expectedResult, plan) {
  if (!existing || typeof existing !== "object") throw new Error("RESULT_ARTIFACT_INVALID");
  if (existing.result !== expectedResult
    || existing.connectionId !== plan.connectionId
    || existing.planSha256 !== plan.planSha256) {
    throw new Error("RESULT_ARTIFACT_CONFLICT");
  }
}

async function hydrateCommand(options) {
  const planDir = path.resolve(required(options, "plan-dir"));
  const { plan, manifest } = await readPlanArtifact(planDir);
  assertApplyConfirmations(options, plan, HYDRATE_CONFIRMATION);
  const targetUrl = databaseUrl("CONNECTION_HYDRATOR_TARGET_DATABASE_URL");
  nonLocalApplyGate(targetUrl);
  const artifact = await prepareAtomicResultArtifact(planDir, "apply-result.json", {
    validateExisting: (existing) => {
      validateExistingResult(existing, "INACTIVE_HYDRATION_APPLIED", plan);
    },
    metadata: {
      operation: "HYDRATE",
      connectionId: plan.connectionId,
      planSha256: plan.planSha256,
      planManifestSha256: manifest.manifestSha256,
      targetIdentitySha256: plan.targetWatermark.databaseIdentitySha256,
    },
  });
  const execution = await runJournaledMutation({
    artifact,
    executeCommittedMutation: () => withDatabase(targetUrl, "winerim-connection-hydrator-apply", async (database) => (
      executeWriteTransaction(database, async () => {
        await database.acquireLock(plan.connectionId);
        const [targetWatermark, targetTables, runtimeActivity] = await Promise.all([
          database.watermark(),
          database.readTargetTables(plan.connectionId),
          database.runtimeActivity(plan.connectionId),
        ]);
        if (targetWatermark.databaseIdentitySha256 !== plan.targetWatermark.databaseIdentitySha256) throw new Error("TARGET_IDENTITY_CHANGED");
        const targetState = classifyHydrationTarget(plan, targetTables, runtimeActivity);
        if (targetState.idempotentReplay) {
          return {
            inserted: Object.fromEntries(IMPORT_TABLES.map((table) => [table, 0])),
            reconciliation: targetState.reconciliation,
            idempotentReplay: true,
          };
        }
        const inserted = {};
        for (const table of IMPORT_TABLES) inserted[table] = await database.insertRows(table, plan.inserts[table]);
        const afterTables = await database.readTargetTables(plan.connectionId);
        const reconciliation = reconcilePlan(plan, afterTables, await database.runtimeActivity(plan.connectionId));
        if (!reconciliation.ok) {
          throw new Error(`POST_HYDRATION_RECONCILIATION_FAILED:${reconciliation.reconciliationSha256}:${reconciliation.mismatches.slice(0, 20).join(",")}`);
        }
        return { inserted, reconciliation, idempotentReplay: false };
      })
    )),
    buildReceipt: (result, journalContext) => canonicalize({
      result: "INACTIVE_HYDRATION_APPLIED",
      connectionId: plan.connectionId,
      planSha256: plan.planSha256,
      planManifestSha256: manifest.manifestSha256,
      databaseCommitState: "CONFIRMED",
      journalId: journalContext.journalId,
      recoveredFromPreparedJournal: journalContext.recoveredFromPreparedJournal,
      inserted: result.inserted,
      idempotentReplay: result.idempotentReplay,
      reconciliationSha256: result.reconciliation.reconciliationSha256,
    }),
  });
  print(execution.receipt);
}

async function reconcileCommand(options) {
  const planDir = path.resolve(required(options, "plan-dir"));
  const { plan } = await readPlanArtifact(planDir);
  const targetUrl = databaseUrl("CONNECTION_HYDRATOR_TARGET_DATABASE_URL");
  const result = await withDatabase(targetUrl, "winerim-connection-hydrator-reconcile", async (database) => {
    await database.beginReadOnly();
    try {
      const reconciliation = reconcilePlan(
        plan,
        await database.readTargetTables(plan.connectionId),
        await database.runtimeActivity(plan.connectionId),
      );
      await database.commit();
      return reconciliation;
    } catch (error) {
      await database.rollback();
      throw error;
    }
  });
  print({ result: result.ok ? "INACTIVE_HYDRATION_RECONCILED" : "INACTIVE_HYDRATION_MISMATCH", ...result });
  if (!result.ok) process.exitCode = 4;
}

async function rollbackCommand(options) {
  const planDir = path.resolve(required(options, "plan-dir"));
  const { plan, manifest } = await readPlanArtifact(planDir);
  assertApplyConfirmations(options, plan, ROLLBACK_CONFIRMATION);
  const targetUrl = databaseUrl("CONNECTION_HYDRATOR_TARGET_DATABASE_URL");
  nonLocalApplyGate(targetUrl);
  const artifact = await prepareAtomicResultArtifact(planDir, "rollback-result.json", {
    validateExisting: (existing) => {
      validateExistingResult(existing, "INACTIVE_HYDRATION_ROLLED_BACK", plan);
    },
    metadata: {
      operation: "ROLLBACK",
      connectionId: plan.connectionId,
      planSha256: plan.planSha256,
      planManifestSha256: manifest.manifestSha256,
      targetIdentitySha256: plan.targetWatermark.databaseIdentitySha256,
    },
  });
  const execution = await runJournaledMutation({
    artifact,
    executeCommittedMutation: () => withDatabase(targetUrl, "winerim-connection-hydrator-rollback", async (database) => (
      executeWriteTransaction(database, async () => {
        await database.acquireLock(plan.connectionId);
        const targetWatermark = await database.watermark();
        if (targetWatermark.databaseIdentitySha256 !== plan.targetWatermark.databaseIdentitySha256) throw new Error("TARGET_IDENTITY_CHANGED");
        const before = await database.readTargetTables(plan.connectionId);
        const runtimeActivity = await database.runtimeActivity(plan.connectionId);
        const targetState = classifyRollbackTarget(plan, before, runtimeActivity);
        if (targetState.idempotentReplay) {
          return {
            deleted: Object.fromEntries(IMPORT_TABLES.map((table) => [table, 0])),
            idempotentReplay: true,
          };
        }
        const deleted = {};
        for (const table of ["stock_sync_log", "sales_line_items", "winerim_push_tracking", "sales_events", "product_mappings", "provider_products", "agora_master_data", "pos_connections"]) {
          deleted[table] = await database.deleteIds(table, plan.rollbackIds[table] || []);
        }
        const after = await database.readTargetTables(plan.connectionId);
        if (targetRowsSha256(after) !== plan.targetPreimageSha256) throw new Error("ROLLBACK_TARGET_PREIMAGE_MISMATCH");
        return { deleted, idempotentReplay: false };
      })
    )),
    buildReceipt: (result, journalContext) => canonicalize({
      result: "INACTIVE_HYDRATION_ROLLED_BACK",
      connectionId: plan.connectionId,
      planSha256: plan.planSha256,
      planManifestSha256: manifest.manifestSha256,
      databaseCommitState: "CONFIRMED",
      journalId: journalContext.journalId,
      recoveredFromPreparedJournal: journalContext.recoveredFromPreparedJournal,
      deleted: result.deleted,
      idempotentReplay: result.idempotentReplay,
    }),
  });
  print(execution.receipt);
}

function help() {
  print({
    commands: {
      export: "--connection-id UUID --output-dir DIR (uses CONNECTION_HYDRATOR_SOURCE_DATABASE_URL)",
      verify: "--artifact-dir DIR",
      prepare: "--artifact-dir DIR --output-dir DIR (uses CONNECTION_HYDRATOR_TARGET_DATABASE_URL read-only)",
      hydrate: `--plan-dir DIR --apply --confirm-action ${HYDRATE_CONFIRMATION} --confirm-plan-sha256 SHA --confirm-target-identity-sha256 SHA`,
      reconcile: "--plan-dir DIR (read-only)",
      rollback: `--plan-dir DIR --apply --confirm-action ${ROLLBACK_CONFIRMATION} --confirm-plan-sha256 SHA --confirm-target-identity-sha256 SHA`,
    },
    safety: "Database URLs are accepted only through environment variables. Non-local apply additionally requires CONNECTION_HYDRATOR_ALLOW_NONLOCAL_TARGET=1.",
  });
}

const { command, options } = parseArgs(process.argv.slice(2));
try {
  if (command === "export") await exportCommand(options);
  else if (command === "verify") await verifyCommand(options);
  else if (command === "prepare") await prepareCommand(options);
  else if (command === "hydrate") await hydrateCommand(options);
  else if (command === "reconcile") await reconcileCommand(options);
  else if (command === "rollback") await rollbackCommand(options);
  else help();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ result: "CONNECTION_HYDRATOR_FAILED", error: String(error?.message || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[DATABASE_URL_REDACTED]") })}\n`);
  process.exitCode = 1;
}
