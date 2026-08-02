#!/usr/bin/env node
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  applyArtifactAtomically,
  assertRollbackReconciled,
  assertSourceGate,
  assertTargetGate,
  buildSafePlan,
  createExportArtifact,
  expectedTargetTables,
  inspectTarget,
  loadTransferConfig,
  readAndVerifyArtifact,
  readState,
  reconcileTarget,
  redactError,
  targetReplaceTables,
  writeState,
} from "../infrastructure/postgres/data-transfer/toolkit.mjs";

function parseArgs(argv) {
  const command = argv[0] || "plan";
  const options = {};
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (["apply", "read-live", "local-test", "resume"].includes(key)) options[key] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
      options[key] = value;
    }
  }
  return { command, options };
}

function requireOption(options, name) {
  const value = options[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function databaseUrl(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required and must not be passed on the command line`);
  return value;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function restoreAndReconcileBackup({ targetUrl, backupDir, backupManifest, config, state, reason }) {
  const artifactDir = path.join(backupDir, "target-before");
  await applyArtifactAtomically({
    databaseUrl: targetUrl,
    artifactDir,
    config,
    manifestTables: targetReplaceTables(config),
    replaceTables: targetReplaceTables(config),
  });
  let reconciliation;
  try {
    reconciliation = await reconcileTarget({
      databaseUrl: targetUrl,
      sourceManifest: backupManifest,
      config,
      tables: targetReplaceTables(config),
    });
    assertRollbackReconciled(reconciliation);
  } catch {
    await writeState(path.join(backupDir, "import-state.json"), {
      ...state,
      phase: "ROLLBACK_FAILED",
      reason,
      rollbackFailureReason: "BACKUP_MANIFEST_RECONCILIATION_FAILED",
      rollbackManifestSha256: backupManifest.manifestSha256,
    });
    throw new Error("Rollback restore was applied but did not reconcile with the digest-verified backup manifest");
  }
  const rolledBackState = await writeState(path.join(backupDir, "import-state.json"), {
    ...state,
    phase: "ROLLED_BACK",
    reason,
    rollbackManifestSha256: backupManifest.manifestSha256,
  });
  return { reconciliation, state: rolledBackState };
}

async function exportCommand(config, options) {
  const artifactDir = path.resolve(requireOption(options, "artifact-dir"));
  if (!options.apply) {
    print({ result: "EXPORT_DRY_RUN", artifactDir, ...buildSafePlan(config) });
    return;
  }
  const sourceUrl = databaseUrl("LOVABLE_DATABASE_URL");
  assertSourceGate(sourceUrl, options["confirm-source"], config);
  const artifact = await createExportArtifact({ databaseUrl: sourceUrl, outputDir: artifactDir, config });
  print({
    result: "EXPORT_ARTIFACT_READY",
    artifactDir,
    manifestSha256: artifact.manifest.manifestSha256,
    snapshotAt: artifact.manifest.snapshotAt,
    snapshotLsn: artifact.manifest.snapshotLsn,
    tables: artifact.manifest.tables.map(({ table, rowCount, sha256 }) => ({ table, rowCount, sha256 })),
  });
}

async function reconcileCommand(config, options) {
  const artifactDir = path.resolve(requireOption(options, "artifact-dir"));
  const { manifest } = await readAndVerifyArtifact(artifactDir, config.sourceTables, config);
  if (!options["read-live"]) {
    print({ result: "RECONCILE_OFFLINE_ARTIFACT_OK", manifestSha256: manifest.manifestSha256, tables: manifest.tables.length });
    return;
  }
  const targetUrl = databaseUrl("STAGING_DATABASE_URL");
  const localTest = options["local-test"] === true && process.env.WINERIM_DATA_TRANSFER_ALLOW_LOCAL_TEST === "1";
  assertTargetGate(targetUrl, options["confirm-target-ref"], config, null, { localTest });
  const result = await reconcileTarget({ databaseUrl: targetUrl, sourceManifest: manifest, config });
  print({ result: result.ok ? "RECONCILE_OK" : "RECONCILE_MISMATCH", ...result });
  if (!result.ok) process.exitCode = 4;
}

async function importCommand(config, options) {
  const artifactDir = path.resolve(requireOption(options, "artifact-dir"));
  const backupDir = path.resolve(requireOption(options, "backup-dir"));
  const statePath = path.join(backupDir, "import-state.json");
  const { manifest } = await readAndVerifyArtifact(artifactDir, config.sourceTables, config);
  if (options["confirm-manifest"] !== manifest.manifestSha256) throw new Error("Source manifest confirmation gate failed");
  if (!options.apply) {
    const existingState = await readState(statePath);
    print({
      result: "IMPORT_DRY_RUN",
      artifactDir,
      backupDir,
      manifestSha256: manifest.manifestSha256,
      replaceTables: targetReplaceTables(config),
      resumePhase: existingState?.phase || null,
      writes: false,
    });
    return;
  }

  const sourceUrl = process.env.LOVABLE_DATABASE_URL || null;
  const targetUrl = databaseUrl("STAGING_DATABASE_URL");
  const localTest = options["local-test"] === true && process.env.WINERIM_DATA_TRANSFER_ALLOW_LOCAL_TEST === "1";
  assertTargetGate(targetUrl, options["confirm-target-ref"], config, sourceUrl, { localTest });
  const inspection = await inspectTarget(targetUrl, config);
  if (inspection.sourceSchemaSha256 !== manifest.schemaSha256) {
    throw new Error(`Target/source schema fingerprint mismatch: source=${manifest.schemaSha256} target=${inspection.sourceSchemaSha256}`);
  }
  const busyRuntime = Object.entries(inspection.runtimeCounts).filter(([, count]) => count !== 0);
  if (busyRuntime.length) throw new Error(`Runtime tables are not empty: ${busyRuntime.map(([table, count]) => `${table}=${count}`).join(",")}`);

  let state = await readState(statePath);
  if (state && !options.resume) throw new Error("Backup directory already has state; pass --resume after reviewing it");
  if (state && (state.sourceManifestSha256 !== manifest.manifestSha256
      || path.resolve(state.artifactDir) !== artifactDir
      || path.resolve(state.backupDir) !== backupDir)) {
    throw new Error("Resume state does not match the requested source artifact and backup directory");
  }

  if (state?.phase === "RECONCILED") {
    const existing = await reconcileTarget({ databaseUrl: targetUrl, sourceManifest: manifest, config });
    if (!existing.ok) throw new Error("Previously reconciled target has drifted; refusing automatic overwrite or rollback");
    print({ result: "IMPORT_ALREADY_RECONCILED", manifestSha256: manifest.manifestSha256, reconciliation: existing });
    return;
  }

  if (state?.phase === "IMPORT_APPLIED") {
    const existing = await reconcileTarget({ databaseUrl: targetUrl, sourceManifest: manifest, config });
    if (existing.ok) {
      await writeState(statePath, { ...state, phase: "RECONCILED" });
      print({ result: "IMPORT_RESUMED_RECONCILED", manifestSha256: manifest.manifestSha256, reconciliation: existing });
      return;
    }
    const previous = await readAndVerifyArtifact(path.join(backupDir, "target-before"), targetReplaceTables(config), config);
    await restoreAndReconcileBackup({
      targetUrl,
      backupDir,
      backupManifest: previous.manifest,
      config,
      state,
      reason: "RESUME_RECONCILIATION_FAILED",
    });
    throw new Error("Interrupted import did not reconcile; staging target restored from its pre-import snapshot");
  }

  let backup;
  if (!state) {
    await mkdir(backupDir, { recursive: false, mode: 0o700 });
    state = await writeState(statePath, {
      phase: "PLANNED",
      sourceManifestSha256: manifest.manifestSha256,
      artifactDir,
      backupDir,
    });
  } else if (state.phase === "PLANNED") {
    if (await pathExists(path.join(backupDir, "target-before"))) {
      throw new Error("Planned resume found an incomplete target snapshot; use a new backup directory after secure disposal review");
    }
  }

  if (!backup && state?.phase === "PLANNED") {
    backup = await createExportArtifact({
      databaseUrl: targetUrl,
      outputDir: path.join(backupDir, "target-before"),
      config,
      tables: targetReplaceTables(config),
      kind: "staging-target-backup",
      exactInventory: true,
    });
    state = await writeState(statePath, {
      phase: "TARGET_SNAPSHOT_READY",
      sourceManifestSha256: manifest.manifestSha256,
      targetBackupManifestSha256: backup.manifest.manifestSha256,
      artifactDir,
      backupDir,
    });
  } else if (!backup) {
    if (!["TARGET_SNAPSHOT_READY", "ROLLED_BACK"].includes(state.phase)) {
      throw new Error(`Unsupported resume phase: ${state.phase}`);
    }
    const verified = await readAndVerifyArtifact(path.join(backupDir, "target-before"), targetReplaceTables(config), config);
    backup = { manifest: verified.manifest };
    if (state.targetBackupManifestSha256 !== backup.manifest.manifestSha256) {
      throw new Error("Resume target backup manifest mismatch");
    }
  }

  await applyArtifactAtomically({
    databaseUrl: targetUrl,
    artifactDir,
    config,
    manifestTables: config.sourceTables,
    replaceTables: targetReplaceTables(config),
  });
  state = await writeState(statePath, {
    phase: "IMPORT_APPLIED",
    sourceManifestSha256: manifest.manifestSha256,
    targetBackupManifestSha256: backup.manifest.manifestSha256,
    artifactDir,
    backupDir,
  });

  const reconciliation = await reconcileTarget({ databaseUrl: targetUrl, sourceManifest: manifest, config });
  if (!reconciliation.ok) {
    await restoreAndReconcileBackup({
      targetUrl,
      backupDir,
      backupManifest: backup.manifest,
      config,
      state,
      reason: "POST_IMPORT_RECONCILIATION_FAILED",
    });
    throw new Error("Post-import reconciliation failed; staging target restored from its pre-import snapshot");
  }
  await writeState(statePath, {
    phase: "RECONCILED",
    sourceManifestSha256: manifest.manifestSha256,
    targetBackupManifestSha256: backup.manifest.manifestSha256,
    artifactDir,
    backupDir,
  });
  print({ result: "IMPORT_RECONCILED", manifestSha256: manifest.manifestSha256, reconciliation });
}

async function rollbackCommand(config, options) {
  const backupDir = path.resolve(requireOption(options, "backup-dir"));
  const statePath = path.join(backupDir, "import-state.json");
  const state = await readState(statePath);
  if (!state) throw new Error("Rollback state not found");
  const artifactDir = path.join(backupDir, "target-before");
  const { manifest } = await readAndVerifyArtifact(artifactDir, targetReplaceTables(config), config);
  if (state.targetBackupManifestSha256 && state.targetBackupManifestSha256 !== manifest.manifestSha256) {
    throw new Error("Rollback state does not match the digest-verified target backup manifest");
  }
  if (options["confirm-manifest"] !== manifest.manifestSha256) throw new Error("Rollback manifest confirmation gate failed");
  if (!options.apply) {
    print({ result: "ROLLBACK_DRY_RUN", backupDir, manifestSha256: manifest.manifestSha256, writes: false });
    return;
  }
  const targetUrl = databaseUrl("STAGING_DATABASE_URL");
  const localTest = options["local-test"] === true && process.env.WINERIM_DATA_TRANSFER_ALLOW_LOCAL_TEST === "1";
  assertTargetGate(targetUrl, options["confirm-target-ref"], config, null, { localTest });
  await inspectTarget(targetUrl, config);
  const rollback = await restoreAndReconcileBackup({
    targetUrl,
    backupDir,
    backupManifest: manifest,
    config,
    state,
    reason: "MANUAL_ROLLBACK",
  });
  print({ result: "ROLLBACK_APPLIED", manifestSha256: manifest.manifestSha256, reconciliation: rollback.reconciliation });
}

async function statusCommand(config, options) {
  const backupDir = path.resolve(requireOption(options, "backup-dir"));
  const state = await readState(path.join(backupDir, "import-state.json"));
  print({ result: "IMPORT_STATUS", state, expectedTargetTables: expectedTargetTables(config) });
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const config = await loadTransferConfig(options.config);
  if (command === "plan") print({ result: "TRANSFER_PLAN", ...buildSafePlan(config) });
  else if (command === "export") await exportCommand(config, options);
  else if (command === "import") await importCommand(config, options);
  else if (command === "reconcile") await reconcileCommand(config, options);
  else if (command === "rollback") await rollbackCommand(config, options);
  else if (command === "status") await statusCommand(config, options);
  else throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`EXPORT_RECONCILE_FAILED: ${redactError(error instanceof Error ? error.message : error)}\n`);
  process.exitCode = 1;
});
