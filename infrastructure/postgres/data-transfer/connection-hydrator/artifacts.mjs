import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  CONNECTION_HYDRATOR_SCHEMA_VERSION,
  IMPORT_TABLES,
  canonicalJson,
  canonicalize,
  sha256,
} from "./core.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertOwnerOnly(stat, label) {
  assert((stat.mode & 0o077) === 0, `${label}_PERMISSIONS_NOT_OWNER_ONLY`);
}

async function ensureSecureDirectory(outputDir) {
  try {
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stat = await lstat(outputDir);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), "ARTIFACT_DIRECTORY_UNSAFE");
  await chmod(outputDir, 0o700);
  assertOwnerOnly(await lstat(outputDir), "ARTIFACT_DIRECTORY");
}

export async function writeSecureText(outputDir, filename, value) {
  await ensureSecureDirectory(outputDir);
  const outputPath = path.join(outputDir, filename);
  const parent = path.dirname(outputPath);
  await ensureSecureDirectory(parent);
  const handle = await open(outputPath, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(outputPath, 0o600);
  return outputPath;
}

export async function writeSecureJson(outputDir, filename, value) {
  return writeSecureText(outputDir, filename, `${JSON.stringify(value, null, 2)}\n`);
}

async function injectFault(faultInjector, stage) {
  if (faultInjector) await faultInjector(stage);
}

async function fsyncFile(filePath, faultInjector, stagePrefix) {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
    await injectFault(faultInjector, `${stagePrefix}:after-file-fsync`);
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(directoryPath, faultInjector, stagePrefix) {
  await injectFault(faultInjector, `${stagePrefix}:before-directory-fsync`);
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await injectFault(faultInjector, `${stagePrefix}:after-directory-fsync`);
}

async function unlinkIfPresent(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function publishExclusiveDurableJson(directoryPath, outputPath, value, faultInjector, stagePrefix) {
  const temporaryPath = path.join(directoryPath, `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await injectFault(faultInjector, `${stagePrefix}:after-temp-fsync`);
    await chmod(temporaryPath, 0o600);
    await injectFault(faultInjector, `${stagePrefix}:after-temp-chmod`);
    await injectFault(faultInjector, `${stagePrefix}:before-link`);
    await link(temporaryPath, outputPath);
    await injectFault(faultInjector, `${stagePrefix}:after-link`);
    await chmod(outputPath, 0o600);
    await injectFault(faultInjector, `${stagePrefix}:after-chmod`);
    await fsyncFile(outputPath, faultInjector, stagePrefix);
    await fsyncDirectory(directoryPath, faultInjector, stagePrefix);
  } finally {
    if (handle) await handle.close();
    await unlinkIfPresent(temporaryPath);
  }
}

async function replaceDurableJson(directoryPath, outputPath, value, faultInjector, stagePrefix) {
  const temporaryPath = path.join(directoryPath, `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle = await open(temporaryPath, "wx", 0o600);
  let renamed = false;
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await injectFault(faultInjector, `${stagePrefix}:after-temp-fsync`);
    await chmod(temporaryPath, 0o600);
    await injectFault(faultInjector, `${stagePrefix}:after-temp-chmod`);
    await injectFault(faultInjector, `${stagePrefix}:before-rename`);
    await rename(temporaryPath, outputPath);
    renamed = true;
    await injectFault(faultInjector, `${stagePrefix}:after-rename`);
    await chmod(outputPath, 0o600);
    await injectFault(faultInjector, `${stagePrefix}:after-chmod`);
    await fsyncFile(outputPath, faultInjector, stagePrefix);
    await fsyncDirectory(directoryPath, faultInjector, stagePrefix);
  } finally {
    if (handle) await handle.close();
    if (!renamed) await unlinkIfPresent(temporaryPath);
  }
}

async function readSecureJsonIfPresent(outputDir, filename, label) {
  try {
    const file = await secureArtifactFile(outputDir, filename, label);
    return JSON.parse(await readFile(file.path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function journalBinding(filename, metadata) {
  assert(metadata && typeof metadata === "object", "RESULT_JOURNAL_METADATA_REQUIRED");
  const immutable = canonicalize({
    schemaVersion: 1,
    kind: "connection-hydrator-result-journal",
    operation: metadata.operation,
    finalFilename: filename,
    connectionId: metadata.connectionId,
    planSha256: metadata.planSha256,
    planManifestSha256: metadata.planManifestSha256,
    targetIdentitySha256: metadata.targetIdentitySha256,
  });
  assert(["HYDRATE", "ROLLBACK"].includes(immutable.operation), "RESULT_JOURNAL_OPERATION_INVALID");
  for (const [field, value] of Object.entries({
    connectionId: immutable.connectionId,
    planSha256: immutable.planSha256,
    targetIdentitySha256: immutable.targetIdentitySha256,
  })) {
    assert(typeof value === "string" && value.length > 0, `RESULT_JOURNAL_${field.toUpperCase()}_INVALID`);
  }
  return { ...immutable, journalId: sha256(immutable) };
}

function assertJournalMatches(journal, expected) {
  assert(journal && typeof journal === "object", "RESULT_JOURNAL_INVALID");
  for (const [field, value] of Object.entries(expected)) {
    assert(journal[field] === value, `RESULT_JOURNAL_CONFLICT:${field}`);
  }
  assert(["PREPARED", "FINALIZED"].includes(journal.state), "RESULT_JOURNAL_STATE_INVALID");
}

export async function prepareAtomicResultArtifact(
  outputDir,
  filename,
  { validateExisting, metadata, faultInjector = null },
) {
  assert(/^[a-z0-9][a-z0-9._-]+$/i.test(filename), "RESULT_ARTIFACT_FILENAME_INVALID");
  assert(typeof validateExisting === "function", "RESULT_ARTIFACT_VALIDATOR_REQUIRED");
  await ensureSecureDirectory(outputDir);
  const outputPath = path.join(outputDir, filename);
  const existing = await readSecureJsonIfPresent(outputDir, filename, "RESULT_ARTIFACT_EXISTING");
  if (existing) validateExisting(existing);

  const expectedJournal = journalBinding(filename, metadata);
  const journalFilename = `${filename}.journal.json`;
  const journalPath = path.join(outputDir, journalFilename);
  let journal = await readSecureJsonIfPresent(outputDir, journalFilename, "RESULT_JOURNAL_EXISTING");
  const resumedPrepared = journal?.state === "PREPARED";
  if (journal) {
    assertJournalMatches(journal, expectedJournal);
  } else {
    const prepared = canonicalize({
      ...expectedJournal,
      state: "PREPARED",
      preparedAt: new Date().toISOString(),
    });
    try {
      await publishExclusiveDurableJson(outputDir, journalPath, prepared, faultInjector, "journal-prepared");
      journal = prepared;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      journal = await readSecureJsonIfPresent(outputDir, journalFilename, "RESULT_JOURNAL_EXISTING");
      assertJournalMatches(journal, expectedJournal);
    }
  }
  await fsyncFile(journalPath, faultInjector, "existing-journal");
  await fsyncDirectory(outputDir, faultInjector, "existing-journal");

  if (journal.state === "FINALIZED" && !existing) throw new Error("RESULT_JOURNAL_FINALIZED_WITHOUT_RECEIPT");

  const finalizeJournal = async (value) => {
    const finalizedJournal = canonicalize({
      ...expectedJournal,
      state: "FINALIZED",
      preparedAt: journal.preparedAt,
      finalizedAt: new Date().toISOString(),
      resultSha256: sha256(value),
    });
    await replaceDurableJson(outputDir, journalPath, finalizedJournal, faultInjector, "journal-finalized");
    journal = finalizedJournal;
  };

  if (existing) {
    await fsyncFile(outputPath, faultInjector, "existing-result");
    await fsyncDirectory(outputDir, faultInjector, "existing-result");
    if (journal.state === "FINALIZED") {
      assert(journal.resultSha256 === sha256(existing), "RESULT_JOURNAL_RECEIPT_DIGEST_MISMATCH");
    } else {
      await finalizeJournal(existing);
    }
  }

  let finalized = Boolean(existing);
  return {
    existing,
    journal,
    resumedPrepared,
    async finalize(value) {
      assert(!finalized, "RESULT_ARTIFACT_ALREADY_FINALIZED");
      validateExisting(value);
      const racedExisting = await readSecureJsonIfPresent(outputDir, filename, "RESULT_ARTIFACT_EXISTING");
      if (racedExisting) {
        validateExisting(racedExisting);
        await fsyncFile(outputPath, faultInjector, "existing-result");
        await fsyncDirectory(outputDir, faultInjector, "existing-result");
        await finalizeJournal(racedExisting);
        finalized = true;
        return { path: outputPath, value: racedExisting, reusedExisting: true };
      }
      try {
        await publishExclusiveDurableJson(outputDir, outputPath, value, faultInjector, "result");
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const concurrentResult = await readSecureJsonIfPresent(outputDir, filename, "RESULT_ARTIFACT_EXISTING");
        validateExisting(concurrentResult);
        await fsyncFile(outputPath, faultInjector, "existing-result");
        await fsyncDirectory(outputDir, faultInjector, "existing-result");
        await finalizeJournal(concurrentResult);
        finalized = true;
        return { path: outputPath, value: concurrentResult, reusedExisting: true };
      }
      await finalizeJournal(value);
      finalized = true;
      return { path: outputPath, value, reusedExisting: false };
    },
  };
}

async function fileSha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function secureArtifactFile(rootDir, relativePath, label) {
  assert(typeof relativePath === "string" && relativePath && !path.isAbsolute(relativePath), `${label}_PATH_INVALID`);
  assert(!relativePath.split(/[\\/]/).includes(".."), `${label}_PATH_TRAVERSAL`);
  const root = await realpath(rootDir);
  const candidate = path.resolve(root, relativePath);
  const actual = await realpath(candidate);
  assert(actual.startsWith(`${root}${path.sep}`), `${label}_PATH_ESCAPE`);
  const stat = await lstat(actual);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label}_NOT_REGULAR_FILE`);
  assertOwnerOnly(stat, label);
  return { path: actual, stat };
}

export async function writeSourceArtifact(source, outputDir) {
  await ensureSecureDirectory(outputDir);
  const files = [];
  for (const table of IMPORT_TABLES) {
    const relativePath = `data/${table}.jsonl`;
    const content = source.tables[table].map((row) => canonicalJson(row)).join("\n") + (source.tables[table].length ? "\n" : "");
    const outputPath = await writeSecureText(outputDir, relativePath, content);
    files.push({
      table,
      relativePath,
      bytes: (await lstat(outputPath)).size,
      sha256: await fileSha256(outputPath),
      rowsSha256: source.tableDigests[table].rowsSha256,
      rowCount: source.tableDigests[table].rowCount,
    });
  }
  const outboundPath = await writeSecureJson(outputDir, "outbound-classification.json", source.outbound);
  const manifestBody = canonicalize({
    schemaVersion: CONNECTION_HYDRATOR_SCHEMA_VERSION,
    kind: "connection-inactive-hydration-source-manifest",
    connectionId: source.connectionId,
    watermark: source.watermark,
    redactions: source.redactions,
    payloadSha256: source.payloadSha256,
    files,
    outbound: {
      relativePath: "outbound-classification.json",
      bytes: (await lstat(outboundPath)).size,
      sha256: await fileSha256(outboundPath),
      rowsSha256: source.outbound.rowsSha256,
      classifiedCount: source.outbound.classifiedCount,
      importedCount: 0,
    },
  });
  const manifest = { ...manifestBody, manifestSha256: sha256(manifestBody) };
  await writeSecureJson(outputDir, "manifest.json", manifest);
  return manifest;
}

function parseJsonLines(content, label) {
  const lines = content.split("\n").filter(Boolean);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${label}_INVALID_JSON_LINE:${index + 1}`);
    }
  });
}

export async function readSourceArtifact(artifactDir) {
  const manifestFile = await secureArtifactFile(artifactDir, "manifest.json", "SOURCE_MANIFEST");
  const manifest = JSON.parse(await readFile(manifestFile.path, "utf8"));
  assert(manifest.schemaVersion === CONNECTION_HYDRATOR_SCHEMA_VERSION, "SOURCE_MANIFEST_VERSION_UNSUPPORTED");
  const unsigned = structuredClone(manifest);
  delete unsigned.manifestSha256;
  assert(manifest.manifestSha256 === sha256(unsigned), "SOURCE_MANIFEST_DIGEST_MISMATCH");
  assert(Array.isArray(manifest.files) && manifest.files.length === IMPORT_TABLES.length, "SOURCE_MANIFEST_FILE_SCOPE_INVALID");
  const tables = {};
  for (const expectedTable of IMPORT_TABLES) {
    const descriptor = manifest.files.find(({ table }) => table === expectedTable);
    assert(descriptor, `SOURCE_FILE_MISSING:${expectedTable}`);
    const file = await secureArtifactFile(artifactDir, descriptor.relativePath, `SOURCE_${expectedTable.toUpperCase()}`);
    assert(file.stat.size === descriptor.bytes, `SOURCE_FILE_SIZE_MISMATCH:${expectedTable}`);
    assert(await fileSha256(file.path) === descriptor.sha256, `SOURCE_FILE_DIGEST_MISMATCH:${expectedTable}`);
    const rows = parseJsonLines(await readFile(file.path, "utf8"), expectedTable);
    assert(rows.length === descriptor.rowCount, `SOURCE_ROW_COUNT_MISMATCH:${expectedTable}`);
    assert(sha256(rows) === descriptor.rowsSha256, `SOURCE_ROWS_DIGEST_MISMATCH:${expectedTable}`);
    tables[expectedTable] = rows;
  }
  const outboundFile = await secureArtifactFile(artifactDir, manifest.outbound.relativePath, "SOURCE_OUTBOUND_CLASSIFICATION");
  assert(outboundFile.stat.size === manifest.outbound.bytes, "SOURCE_OUTBOUND_SIZE_MISMATCH");
  assert(await fileSha256(outboundFile.path) === manifest.outbound.sha256, "SOURCE_OUTBOUND_DIGEST_MISMATCH");
  const outbound = JSON.parse(await readFile(outboundFile.path, "utf8"));
  assert(outbound.importedCount === 0, "SOURCE_OUTBOUND_IMPORT_NOT_ZERO");
  assert(outbound.rowsSha256 === manifest.outbound.rowsSha256, "SOURCE_OUTBOUND_ROWS_DIGEST_MISMATCH");
  const source = canonicalize({
    schemaVersion: manifest.schemaVersion,
    kind: "connection-inactive-hydration-source",
    connectionId: manifest.connectionId,
    watermark: manifest.watermark,
    redactions: manifest.redactions,
    tableDigests: Object.fromEntries(manifest.files.map((file) => [file.table, { rowCount: file.rowCount, rowsSha256: file.rowsSha256 }])),
    tables,
    outbound,
    payloadSha256: manifest.payloadSha256,
  });
  assert(source.payloadSha256 === sha256({ connectionId: source.connectionId, tables, outbound }), "SOURCE_PAYLOAD_DIGEST_MISMATCH");
  return { source, manifest };
}

export async function writePlanArtifact({ plan, sourceManifest, outputDir, hydrationSql, rollbackSql, reconcileSql }) {
  await ensureSecureDirectory(outputDir);
  const planBody = canonicalize({
    ...plan,
    sourceManifestSha256: sourceManifest.manifestSha256,
  });
  const boundPlan = { ...planBody, boundPlanSha256: sha256(planBody) };
  await writeSecureJson(outputDir, "plan.json", boundPlan);
  await writeSecureText(outputDir, "hydrate.sql", hydrationSql);
  await writeSecureText(outputDir, "rollback.sql", rollbackSql);
  await writeSecureText(outputDir, "reconcile.sql", reconcileSql);
  const descriptors = [];
  for (const relativePath of ["plan.json", "hydrate.sql", "rollback.sql", "reconcile.sql"]) {
    const file = await secureArtifactFile(outputDir, relativePath, `PLAN_${relativePath.toUpperCase().replaceAll(".", "_")}`);
    descriptors.push({ relativePath, bytes: file.stat.size, sha256: await fileSha256(file.path) });
  }
  const manifestBody = canonicalize({
    schemaVersion: CONNECTION_HYDRATOR_SCHEMA_VERSION,
    kind: "connection-inactive-hydration-plan-manifest",
    connectionId: plan.connectionId,
    planSha256: plan.planSha256,
    boundPlanSha256: boundPlan.boundPlanSha256,
    sourceManifestSha256: sourceManifest.manifestSha256,
    files: descriptors,
  });
  const manifest = { ...manifestBody, manifestSha256: sha256(manifestBody) };
  await writeSecureJson(outputDir, "manifest.json", manifest);
  return { plan: boundPlan, manifest };
}

export async function readPlanArtifact(planDir) {
  const manifestFile = await secureArtifactFile(planDir, "manifest.json", "PLAN_MANIFEST");
  const manifest = JSON.parse(await readFile(manifestFile.path, "utf8"));
  const unsignedManifest = structuredClone(manifest);
  delete unsignedManifest.manifestSha256;
  assert(manifest.manifestSha256 === sha256(unsignedManifest), "PLAN_MANIFEST_DIGEST_MISMATCH");
  for (const descriptor of manifest.files) {
    const file = await secureArtifactFile(planDir, descriptor.relativePath, "PLAN_FILE");
    assert(file.stat.size === descriptor.bytes, `PLAN_FILE_SIZE_MISMATCH:${descriptor.relativePath}`);
    assert(await fileSha256(file.path) === descriptor.sha256, `PLAN_FILE_DIGEST_MISMATCH:${descriptor.relativePath}`);
  }
  const plan = JSON.parse(await readFile(path.join(planDir, "plan.json"), "utf8"));
  const unsignedPlan = structuredClone(plan);
  delete unsignedPlan.boundPlanSha256;
  assert(plan.boundPlanSha256 === sha256(unsignedPlan), "BOUND_PLAN_DIGEST_MISMATCH");
  assert(plan.planSha256 === manifest.planSha256, "PLAN_SHA256_MANIFEST_MISMATCH");
  return { plan, manifest };
}
