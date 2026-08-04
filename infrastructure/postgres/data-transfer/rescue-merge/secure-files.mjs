import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";

function assertOwnerOnly(stat, label) {
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label}_PERMISSIONS_NOT_OWNER_ONLY`);
}

async function assertSecureRegularFile(filePath, label) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}_NOT_REGULAR_FILE`);
  assertOwnerOnly(stat, label);
  return stat;
}

export async function readSecureJson(filePath, label) {
  await assertSecureRegularFile(filePath, label);
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function fileSha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyBackupArtifact(manifest, manifestPath) {
  const manifestDir = await realpath(path.dirname(manifestPath));
  const artifactPath = path.resolve(manifestDir, manifest.artifact.relativePath);
  const artifactRealPath = await realpath(artifactPath);
  if (artifactRealPath !== artifactPath || !artifactRealPath.startsWith(`${manifestDir}${path.sep}`)) {
    throw new Error("BACKUP_ARTIFACT_ESCAPES_MANIFEST_DIRECTORY");
  }
  const stat = await assertSecureRegularFile(artifactRealPath, "BACKUP_ARTIFACT");
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
