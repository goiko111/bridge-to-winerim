import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

import {
  backupRestoreVerificationDigest,
  recalculateTargetRowsSha256,
  RescueMergeError,
} from "./executor.mjs";
import { PostgresRescueMergeDatabase } from "./postgres.mjs";
import { assertSecureRegularFile } from "./secure-files.mjs";

export const RESTORE_TEST_CONFIRMATION = "RESTORE_BACKUP_TO_DISPOSABLE_DATABASE_ONLY";

function fail(code, message = code) {
  throw new RescueMergeError(code, message);
}

function postgresEnvironment(connectionString) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    fail("RESTORE_TEST_DATABASE_URL_INVALID");
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    fail("RESTORE_TEST_DATABASE_URL_INVALID");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName) fail("RESTORE_TEST_DATABASE_NAME_MISSING");
  const env = {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGDATABASE: databaseName,
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
  };
  const sslMode = parsed.searchParams.get("sslmode");
  if (sslMode) env.PGSSLMODE = sslMode;
  return { databaseName, env };
}

function boundedStderr(child) {
  let value = "";
  child.stderr?.on("data", (chunk) => {
    if (value.length < 4_000) value += chunk.toString("utf8");
  });
  return () => value.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]").slice(0, 4_000);
}

async function exitCode(child) {
  const [code, signal] = await once(child, "exit");
  return { code, signal };
}

export async function restorePostgresCustomAge({
  backupArtifactPath,
  connectionString,
  ageIdentityFile,
  expectedDatabaseName,
}) {
  if (!connectionString) fail("RESTORE_TEST_DATABASE_URL_REQUIRED");
  if (!ageIdentityFile) fail("RESTORE_TEST_AGE_IDENTITY_REQUIRED");
  await assertSecureRegularFile(path.resolve(ageIdentityFile), "RESTORE_TEST_AGE_IDENTITY");
  const { databaseName, env } = postgresEnvironment(connectionString);
  if (databaseName !== expectedDatabaseName
    || !/^winerim_restore_test_[a-z0-9_]+$/.test(databaseName)) {
    fail("RESTORE_TEST_DATABASE_NOT_DISPOSABLE");
  }

  const decrypt = spawn("age", [
    "--decrypt",
    "--identity",
    path.resolve(ageIdentityFile),
    backupArtifactPath,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const restore = spawn("pg_restore", [
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
    "--exit-on-error",
    `--dbname=${databaseName}`,
  ], { env, stdio: ["pipe", "ignore", "pipe"] });
  const decryptStderr = boundedStderr(decrypt);
  const restoreStderr = boundedStderr(restore);
  decrypt.stdout.pipe(restore.stdin);
  const [decryptExit, restoreExit] = await Promise.all([exitCode(decrypt), exitCode(restore)]);
  if (decryptExit.code !== 0 || restoreExit.code !== 0) {
    fail(
      "BACKUP_AUTOMATIC_RESTORE_FAILED",
      `Automatic disposable restore failed: age=${decryptExit.code ?? decryptExit.signal}; pg_restore=${restoreExit.code ?? restoreExit.signal}; ${decryptStderr()} ${restoreStderr()}`,
    );
  }
  return { databaseName, restored: true };
}

export async function verifyBackupRestoreAutomatically({
  backupManifest,
  backupArtifactVerification,
  plan,
  plannerInput,
  connectionString,
  ageIdentityFile,
  confirmation,
  now = new Date(),
  restoreRunner = restorePostgresCustomAge,
  databaseFactory = ({ connectionString: url }) => new PostgresRescueMergeDatabase({ connectionString: url }),
}) {
  if (confirmation !== RESTORE_TEST_CONFIRMATION) fail("RESTORE_TEST_CONFIRMATION_REQUIRED");
  if (backupManifest?.artifact?.format !== "postgres-custom-age") {
    fail("BACKUP_RESTORE_FORMAT_UNSUPPORTED");
  }
  if (backupArtifactVerification?.sha256 !== backupManifest.artifact.sha256
    || backupArtifactVerification?.bytes !== backupManifest.artifact.bytes) {
    fail("BACKUP_RESTORE_ARTIFACT_NOT_VERIFIED");
  }
  await restoreRunner({
    backupArtifactPath: backupArtifactVerification.artifactPath,
    connectionString,
    ageIdentityFile,
    expectedDatabaseName: backupManifest.restoreTest.disposableDatabaseName,
  });

  const database = databaseFactory({ connectionString });
  let transactionStarted = false;
  try {
    await database.connect();
    await database.beginRepeatableReadOnly();
    transactionStarted = true;
    const disposableDatabaseIdentitySha256 = await database.databaseIdentitySha256();
    if (disposableDatabaseIdentitySha256
      !== backupManifest.restoreTest.disposableDatabaseIdentitySha256) {
      fail("BACKUP_RESTORE_DATABASE_IDENTITY_MISMATCH");
    }
    if (disposableDatabaseIdentitySha256 === backupManifest.databaseIdentitySha256) {
      fail("BACKUP_RESTORE_DATABASE_IS_PRODUCTION");
    }
    const restoredRows = await database.readTables(plan.requestedTables);
    const targetRowsSha256 = recalculateTargetRowsSha256(plannerInput, restoredRows);
    if (targetRowsSha256 !== plan.targetRowsSha256) {
      fail("BACKUP_RESTORE_TARGET_ROWS_MISMATCH");
    }
    await database.rollback();
    transactionStarted = false;
    const verification = {
      schemaVersion: 1,
      result: "AUTOMATIC_DISPOSABLE_RESTORE_VERIFIED",
      backupManifestSha256: backupManifest.manifestSha256,
      backupArtifactSha256: backupManifest.artifact.sha256,
      backupArtifactBytes: backupManifest.artifact.bytes,
      disposableDatabaseIdentitySha256,
      targetRowsSha256,
      planSha256: plan.planSha256,
      verifiedAt: now.toISOString(),
    };
    return {
      ...verification,
      verificationSha256: backupRestoreVerificationDigest(verification),
    };
  } finally {
    if (transactionStarted) await database.rollback().catch(() => undefined);
    await database.close().catch(() => undefined);
  }
}
