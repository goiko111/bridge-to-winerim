import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, sha256 } from "./planner.mjs";

function assertOwnerOnly(stat, label) {
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label}_PERMISSIONS_NOT_OWNER_ONLY`);
}

export async function assertSecureRegularFile(filePath, label) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}_NOT_REGULAR_FILE`);
  assertOwnerOnly(stat, label);
  return stat;
}

export async function readSecureJson(filePath, label) {
  await assertSecureRegularFile(filePath, label);
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function fileSha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function resolveSecureRelativeFile(containerPath, relativePath, label) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)
    || relativePath.split(/[\\/]/).includes("..")) {
    throw new Error(`${label}_PATH_INVALID`);
  }
  const containerDir = await realpath(path.dirname(containerPath));
  const filePath = path.resolve(containerDir, relativePath);
  const fileRealPath = await realpath(filePath);
  if (fileRealPath !== filePath || !fileRealPath.startsWith(`${containerDir}${path.sep}`)) {
    throw new Error(`${label}_ESCAPES_CONTAINER_DIRECTORY`);
  }
  const stat = await assertSecureRegularFile(fileRealPath, label);
  return { filePath: fileRealPath, stat };
}

export function sourceExportBindingPayload(artifact) {
  const plannerInput = artifact?.plannerInput;
  const sourceExport = artifact?.sourceExport;
  return {
    schemaVersion: 1,
    sourceExportSha256: sourceExport?.sha256,
    sourceExportBytes: sourceExport?.bytes,
    plannerInputSha256: sha256(canonicalJson(plannerInput)),
    artifactManifestSha256: plannerInput?.context?.artifact?.manifestSha256,
    artifactPayloadSha256: plannerInput?.context?.artifact?.payloadSha256,
    sourceSnapshotIdSha256: plannerInput?.context?.source?.watermark?.snapshotIdSha256,
    sourceDatabaseIdentitySha256: plannerInput?.context?.source?.watermark?.databaseIdentitySha256,
  };
}

export function sourceExportBindingSha256(artifact) {
  return sha256(canonicalJson(sourceExportBindingPayload(artifact)));
}

export function sourceExportVerificationDigest(verification) {
  const unsigned = structuredClone(verification);
  delete unsigned.verificationSha256;
  return sha256(canonicalJson(unsigned));
}

export async function verifySourceExportArtifact(artifact, artifactPath) {
  if (artifact?.schemaVersion !== 2 || !artifact.plannerInput || !artifact.sourceExport) {
    throw new Error("SOURCE_ARTIFACT_SCHEMA_UNSUPPORTED");
  }
  const bindingPayload = sourceExportBindingPayload(artifact);
  if (artifact.sourceExport.plannerInputSha256 !== bindingPayload.plannerInputSha256) {
    throw new Error("SOURCE_EXPORT_PLANNER_INPUT_DIGEST_MISMATCH");
  }
  const bindingSha256 = sourceExportBindingSha256(artifact);
  if (artifact.sourceExport.bindingSha256 !== bindingSha256) {
    throw new Error("SOURCE_EXPORT_BINDING_DIGEST_MISMATCH");
  }
  const { filePath, stat } = await resolveSecureRelativeFile(
    artifactPath,
    artifact.sourceExport.relativePath,
    "SOURCE_EXPORT",
  );
  if (!Number.isSafeInteger(artifact.sourceExport.bytes) || artifact.sourceExport.bytes <= 0
    || stat.size !== artifact.sourceExport.bytes) {
    throw new Error("SOURCE_EXPORT_SIZE_MISMATCH");
  }
  const actualSha256 = await fileSha256(filePath);
  if (actualSha256 !== artifact.sourceExport.sha256) {
    throw new Error("SOURCE_EXPORT_DIGEST_MISMATCH");
  }
  const verification = {
    schemaVersion: 1,
    result: "SOURCE_EXPORT_BYTES_AND_PLANNER_INPUT_BOUND",
    sourceExportSha256: actualSha256,
    sourceExportBytes: stat.size,
    plannerInputSha256: bindingPayload.plannerInputSha256,
    bindingSha256,
  };
  return {
    ...verification,
    verificationSha256: sourceExportVerificationDigest(verification),
    sourceExportPath: filePath,
  };
}

export async function verifyBackupArtifact(manifest, manifestPath) {
  const { filePath: artifactRealPath, stat } = await resolveSecureRelativeFile(
    manifestPath,
    manifest.artifact.relativePath,
    "BACKUP_ARTIFACT",
  );
  if (stat.size !== manifest.artifact.bytes) throw new Error("BACKUP_ARTIFACT_SIZE_MISMATCH");
  if (await fileSha256(artifactRealPath) !== manifest.artifact.sha256) {
    throw new Error("BACKUP_ARTIFACT_DIGEST_MISMATCH");
  }
  return { artifactPath: artifactRealPath, bytes: stat.size, sha256: manifest.artifact.sha256 };
}

export async function ensureSecureOutputDirectory(outputDir) {
  try {
    await mkdir(outputDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stat = await lstat(outputDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("OUTPUT_DIRECTORY_NOT_SECURE");
  assertOwnerOnly(stat, "OUTPUT_DIRECTORY");
  await chmod(outputDir, 0o700);
}

export async function writeSecureJson(outputDir, filename, value) {
  await ensureSecureOutputDirectory(outputDir);
  const outputPath = path.join(outputDir, filename);
  const handle = await open(outputPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(outputPath, 0o600);
  return outputPath;
}
