#!/usr/bin/env node
import path from "node:path";

import {
  APPLY_CONFIRMATION,
  evaluateExecutorApplyGate,
  executeRescueMerge,
  prepareInsertRows,
  reconcileAmbiguousCommit,
  RescueMergeError,
  validateBackupManifest,
  validatePlannerBundle,
} from "./executor.mjs";
import {
  readSecureJson,
  verifyBackupArtifact,
  verifySourceExportArtifact,
  writeSecureJson,
} from "./secure-files.mjs";
import {
  RESTORE_TEST_CONFIRMATION,
  verifyBackupRestoreAutomatically,
} from "./restore-verifier.mjs";

function parseArgs(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`UNEXPECTED_ARGUMENT:${token}`);
    const key = token.slice(2);
    if (key === "apply") {
      options.apply = true;
      continue;
    }
    if (key === "database-url" || key.endsWith("-url")) throw new Error("DATABASE_URL_ARGUMENT_FORBIDDEN");
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`MISSING_ARGUMENT_VALUE:${key}`);
    options[key] = value;
  }
  return options;
}

function required(options, key) {
  if (!options[key]) throw new Error(`REQUIRED_ARGUMENT_MISSING:${key}`);
  return options[key];
}

function safeError(error) {
  const code = error instanceof RescueMergeError ? error.code : "LOCAL_EXECUTOR_ERROR";
  return { code, message: String(error?.message || code).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]").slice(0, 1000) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const planPath = path.resolve(required(options, "plan"));
  const artifactPath = path.resolve(required(options, "artifact"));
  const backupManifestPath = path.resolve(required(options, "backup-manifest"));
  const outputDir = path.resolve(required(options, "output-dir"));
  const plan = await readSecureJson(planPath, "PLAN_ARTIFACT");
  const artifact = await readSecureJson(artifactPath, "SOURCE_ARTIFACT");
  const backupManifest = await readSecureJson(backupManifestPath, "BACKUP_MANIFEST");
  const sourceExportVerification = await verifySourceExportArtifact(artifact, artifactPath);
  const plannerInput = artifact.plannerInput;
  validatePlannerBundle({ plan, plannerInput });
  const inserts = prepareInsertRows({ plan, plannerInput });
  validateBackupManifest(backupManifest, plan, {
    confirmManifestSha256: options["confirm-backup-manifest-sha256"] || backupManifest.manifestSha256,
  });
  const backupArtifactVerification = await verifyBackupArtifact(backupManifest, backupManifestPath);
  const backupRestoreVerification = await verifyBackupRestoreAutomatically({
    backupManifest,
    backupArtifactVerification,
    plan,
    plannerInput,
    connectionString: process.env.RESCUE_MERGE_RESTORE_TEST_DATABASE_URL,
    ageIdentityFile: process.env.RESCUE_MERGE_BACKUP_AGE_IDENTITY_FILE,
    confirmation: options["confirm-restore-test"],
  });

  if (!options.apply) {
    const report = {
      schemaVersion: 1,
      result: "DRY_RUN_READY_APPLY_NOT_REQUESTED",
      connectedToTargetDatabase: false,
      connectedToDisposableRestoreDatabase: true,
      planSha256: plan.planSha256,
      artifactPayloadSha256: plan.artifactPayloadSha256,
      sourceExportVerificationSha256: sourceExportVerification.verificationSha256,
      backupManifestSha256: backupManifest.manifestSha256,
      backupRestoreVerificationSha256: backupRestoreVerification.verificationSha256,
      insertCount: inserts.length,
      insertByTable: inserts.reduce((counts, { table }) => {
        counts[table] = (counts[table] || 0) + 1;
        return counts;
      }, {}),
      applyConfirmationRequired: APPLY_CONFIRMATION,
      restoreTestConfirmationRequired: RESTORE_TEST_CONFIRMATION,
    };
    const reportPath = await writeSecureJson(outputDir, "rescue-merge-dry-run.json", report);
    process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
    return;
  }

  const confirmations = {
    apply: options["confirm-apply"],
    planSha256: options["confirm-plan-sha256"],
    artifactPayloadSha256: options["confirm-artifact-payload-sha256"],
    backupManifestSha256: options["confirm-backup-manifest-sha256"],
  };
  const gate = evaluateExecutorApplyGate({
    plan,
    plannerInput,
    sourceExportVerification,
    backupManifest,
    backupRestoreVerification,
    apply: true,
    confirmApply: confirmations.apply,
    confirmPlanSha256: confirmations.planSha256,
    confirmArtifactPayloadSha256: confirmations.artifactPayloadSha256,
    confirmBackupManifestSha256: confirmations.backupManifestSha256,
  });
  if (!gate.ready) throw new RescueMergeError("APPLY_GATE_BLOCKED", gate.blockers.join(","));
  const connectionString = process.env.RESCUE_MERGE_TARGET_DATABASE_URL;
  if (!connectionString) throw new Error("RESCUE_MERGE_TARGET_DATABASE_URL_REQUIRED");
  const { PostgresRescueMergeDatabase } = await import("./postgres.mjs");
  const database = new PostgresRescueMergeDatabase({ connectionString });
  try {
    const report = await executeRescueMerge({
      plan,
      plannerInput,
      sourceExportVerification,
      backupManifest,
      backupRestoreVerification,
      confirmations,
      database,
    });
    const reportPath = await writeSecureJson(outputDir, "rescue-merge-apply.json", report);
    process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
  } catch (error) {
    if (error instanceof RescueMergeError && error.code === "COMMIT_OUTCOME_AMBIGUOUS") {
      const reconciliationDatabase = new PostgresRescueMergeDatabase({ connectionString });
      let reconciliation;
      try {
        reconciliation = await reconcileAmbiguousCommit({
          plan,
          plannerInput,
          database: reconciliationDatabase,
        });
      } catch (reconciliationError) {
        reconciliation = {
          schemaVersion: 1,
          result: "COMMIT_OUTCOME_AMBIGUOUS_RECONCILIATION_FAILED",
          retryBlocked: true,
          restoreBlocked: true,
          ...safeError(reconciliationError),
        };
      }
      const report = {
        schemaVersion: 1,
        result: reconciliation.result,
        originalError: safeError(error),
        reconciliation,
      };
      const reportPath = await writeSecureJson(
        outputDir,
        "rescue-merge-commit-reconciliation.json",
        report,
      );
      process.stderr.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }
    const failure = {
      schemaVersion: 1,
      result: error instanceof RescueMergeError && error.code === "ROLLBACK_FAILED"
        ? "APPLY_FAILED_ROLLBACK_UNCONFIRMED"
        : "APPLY_FAILED_BEFORE_COMMIT_ROLLED_BACK",
      planSha256: plan.planSha256,
      ...safeError(error),
    };
    const reportPath = await writeSecureJson(outputDir, "rescue-merge-failure.json", failure);
    process.stderr.write(`${JSON.stringify({ ...failure, reportPath }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify(safeError(error), null, 2)}\n`);
  process.exitCode = 1;
});
