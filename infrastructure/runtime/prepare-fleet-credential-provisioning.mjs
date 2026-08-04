import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  prepareCredentialProvisioning,
  validateAdoptExistingEvidence,
} from "./prepare-runtime-credential-provisioning.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

function required(environment, name) {
  const value = String(environment[name] ?? "").trim();
  if (!value) throw new Error(`RUNTIME_FLEET_CREDENTIAL_PROVISION_MISSING_${name}`);
  return value;
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isOutsideRepository(path) {
  const candidate = relative(repoRoot, path);
  return candidate !== "" && (candidate.startsWith("..") || candidate.startsWith("/"));
}

function readPrivateFile(path, label) {
  if (!isAbsolute(path)) {
    throw new Error(`RUNTIME_FLEET_CREDENTIAL_PROVISION_${label}_PATH_MUST_BE_ABSOLUTE`);
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`RUNTIME_FLEET_CREDENTIAL_PROVISION_${label}_MUST_BE_REGULAR_FILE`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`RUNTIME_FLEET_CREDENTIAL_PROVISION_${label}_MUST_BE_PRIVATE_0600`);
  }
  if (metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) {
    throw new Error(`RUNTIME_FLEET_CREDENTIAL_PROVISION_${label}_INVALID_SIZE`);
  }
  return readFileSync(path);
}

function parsePrivateJson(path) {
  const source = readPrivateFile(path, "INPUT_JSON");
  try {
    return JSON.parse(source.toString("utf8"));
  } catch {
    throw new Error("RUNTIME_FLEET_CREDENTIAL_PROVISION_INVALID_INPUT_JSON");
  }
}

function validateTargetEvidence(target, adoption) {
  if (
    target?.rowExists !== true
    || target?.provider !== "agora"
    || target?.enabled !== false
    || target?.catalogSyncEnabled !== false
    || target?.syncMode !== "PULL_ONLY"
    || target?.writeMode !== "NONE"
    || target?.backfillDays !== 0
    || target?.operationallyInert !== true
    || target?.sanitized !== true
    || target?.credentialVaultRows !== 0
  ) {
    throw new Error("RUNTIME_FLEET_CREDENTIAL_PROVISION_TARGET_NOT_INERT_SANITIZED");
  }
  if (
    target.salesEvents !== adoption.watermarks.salesEvents
    || target.salesLineItems !== adoption.watermarks.salesLineItems
    || target.maxBusinessDay !== adoption.watermarks.maxBusinessDay
    || target.lastBusinessDaySynced !== adoption.watermarks.lastBusinessDaySynced
    || target.lastSyncAt !== adoption.watermarks.lastSyncAt
  ) {
    throw new Error("RUNTIME_FLEET_CREDENTIAL_PROVISION_TARGET_EVIDENCE_MISMATCH");
  }
}

function validateCredential(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || /[\r\n]/.test(value)
  ) {
    throw new Error(`RUNTIME_FLEET_CREDENTIAL_PROVISION_INVALID_${label}_CREDENTIAL`);
  }
}

function validateConnectionEntry(entry, seen) {
  const connectionId = String(entry?.connectionId ?? "").trim().toLowerCase();
  if (!UUID_PATTERN.test(connectionId)) {
    throw new Error("RUNTIME_FLEET_CREDENTIAL_PROVISION_INVALID_CONNECTION_ID");
  }
  if (seen.has(connectionId)) {
    throw new Error("RUNTIME_FLEET_CREDENTIAL_PROVISION_DUPLICATE_CONNECTION_ID");
  }
  seen.add(connectionId);

  const runId = String(entry?.runId ?? "").trim();
  if (!RUN_PATTERN.test(runId)) {
    throw new Error("RUNTIME_FLEET_CREDENTIAL_PROVISION_INVALID_RUN_ID");
  }
  validateCredential(entry?.credentials?.agora, "AGORA");
  validateCredential(entry?.credentials?.winerim, "WINERIM");

  const exportManifestPath = String(entry?.adoptionEvidence?.exportManifestPath ?? "").trim();
  const targetManifestPath = String(entry?.adoptionEvidence?.targetManifestPath ?? "").trim();
  const reconciliationManifestPath = String(
    entry?.adoptionEvidence?.reconciliationManifestPath ?? "",
  ).trim();
  const exportManifestSha256 = String(
    entry?.adoptionEvidence?.exportManifestSha256 ?? "",
  ).trim();
  const targetManifestSha256 = String(
    entry?.adoptionEvidence?.targetManifestSha256 ?? "",
  ).trim();
  const reconciliationManifestSha256 = String(
    entry?.adoptionEvidence?.reconciliationManifestSha256 ?? "",
  ).trim();
  if (!SHA256_PATTERN.test(exportManifestSha256)) {
    throw new Error("RUNTIME_FLEET_CREDENTIAL_PROVISION_INVALID_EXPORT_MANIFEST_SHA256");
  }
  if (!SHA256_PATTERN.test(targetManifestSha256)) {
    throw new Error("RUNTIME_FLEET_CREDENTIAL_PROVISION_INVALID_TARGET_MANIFEST_SHA256");
  }
  if (!SHA256_PATTERN.test(reconciliationManifestSha256)) {
    throw new Error("RUNTIME_FLEET_CREDENTIAL_PROVISION_INVALID_RECONCILIATION_MANIFEST_SHA256");
  }
  const exportManifestSource = readPrivateFile(exportManifestPath, "EXPORT_MANIFEST");
  const targetManifestSource = readPrivateFile(targetManifestPath, "TARGET_MANIFEST");
  const reconciliationManifestSource = readPrivateFile(
    reconciliationManifestPath,
    "RECONCILIATION_MANIFEST",
  );
  const adoption = validateAdoptExistingEvidence({
    connectionId,
    exportManifestSource,
    exportManifestSha256,
    targetManifestSource,
    targetManifestSha256,
    reconciliationManifestSource,
    reconciliationManifestSha256,
  });
  validateTargetEvidence(entry?.targetEvidence, adoption);

  return {
    connectionId,
    runId,
    credentials: {
      agora: entry.credentials.agora,
      winerim: entry.credentials.winerim,
    },
    targetEvidence: {
      rowExists: true,
      provider: "agora",
      enabled: false,
      catalogSyncEnabled: false,
      syncMode: "PULL_ONLY",
      writeMode: "NONE",
      backfillDays: 0,
      operationallyInert: true,
      sanitized: true,
      credentialVaultRows: 0,
      salesEvents: adoption.watermarks.salesEvents,
      salesLineItems: adoption.watermarks.salesLineItems,
      maxBusinessDay: adoption.watermarks.maxBusinessDay,
      lastBusinessDaySynced: adoption.watermarks.lastBusinessDaySynced,
      lastSyncAt: adoption.watermarks.lastSyncAt,
    },
    adoptionEvidence: {
      exportManifestPath,
      exportManifestSha256,
      targetManifestPath,
      targetManifestSha256,
      reconciliationManifestPath,
      reconciliationManifestSha256,
    },
    adoption,
  };
}

export function validateFleetProvisioningInput(input) {
  if (input?.version !== 1 || !Array.isArray(input?.connections) || input.connections.length === 0) {
    throw new Error("RUNTIME_FLEET_CREDENTIAL_PROVISION_INVALID_INPUT_CONTRACT");
  }
  const seen = new Set();
  return input.connections
    .map((entry) => validateConnectionEntry(entry, seen))
    .sort((left, right) => left.connectionId.localeCompare(right.connectionId));
}

export function buildFleetLogicalManifest({ keyVersion, connections }) {
  if (!KEY_VERSION_PATTERN.test(keyVersion ?? "")) {
    throw new Error("RUNTIME_FLEET_CREDENTIAL_PROVISION_INVALID_KEY_VERSION");
  }
  const logical = {
    version: 1,
    kind: "RUNTIME_FLEET_CREDENTIAL_PROVISIONING",
    mode: "adopt-existing",
    keyVersion,
    active: false,
    activationAllowed: false,
    activationBlockReason: "FLEET_ACTIVATION_REQUIRES_SEPARATE_PER_CONNECTION_REVIEWED_GATE",
    remoteMutations: 0,
    connectionCount: connections.length,
    connections: [...connections]
      .sort((left, right) => left.connectionId.localeCompare(right.connectionId))
      .map((connection) => ({
        connectionId: connection.connectionId,
        runId: connection.runId,
        targetEvidence: connection.targetEvidence,
        exportManifestSha256: connection.adoption.exportManifestSha256,
        reconciliationManifestSha256: connection.adoption.reconciliationManifestSha256,
        reconciliationReportSha256: connection.adoption.reconciliationReportSha256,
        sourceDatasetSha256: connection.adoption.sourceDatasetSha256,
        targetDatasetSha256: connection.adoption.targetDatasetSha256,
        adoptionBindingSha256: connection.adoption.bindingSha256,
      })),
  };
  return {
    ...logical,
    logicalManifestSha256: sha256(canonicalJson(logical)),
  };
}

function validateExternalOutput(outputDir) {
  const target = resolve(outputDir);
  if (!isOutsideRepository(target)) {
    throw new Error("RUNTIME_FLEET_CREDENTIAL_PROVISION_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  if (existsSync(target)) {
    throw new Error("RUNTIME_FLEET_CREDENTIAL_PROVISION_OUTPUT_ALREADY_EXISTS");
  }
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const realParent = realpathSync(parent);
  if (!isOutsideRepository(realParent)) {
    throw new Error("RUNTIME_FLEET_CREDENTIAL_PROVISION_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  return { target, realParent };
}

export function fleetCredentialProvisioningPlan() {
  return {
    status: "RUNTIME_FLEET_CREDENTIAL_PROVISION_PLAN_ONLY",
    remoteMutations: 0,
    writesPlaintext: false,
    insertsActiveCredentials: false,
    activationAllowed: false,
    requiredEnvironment: [
      "RUNTIME_FLEET_CREDENTIAL_INPUT_JSON",
      "RUNTIME_FLEET_CREDENTIAL_OUTPUT_DIR",
      "RUNTIME_VAULT_KEY_VERSION",
      "RUNTIME_VAULT_MASTER_KEY",
    ],
    renderGate: "--render --input=/private/input.json --output=/private/new-directory",
  };
}

export function prepareFleetCredentialProvisioning({
  environment = process.env,
  inputPath,
  outputDir,
}) {
  const sourcePath = resolve(
    inputPath ?? required(environment, "RUNTIME_FLEET_CREDENTIAL_INPUT_JSON"),
  );
  const destination = outputDir ?? required(environment, "RUNTIME_FLEET_CREDENTIAL_OUTPUT_DIR");
  const keyVersion = required(environment, "RUNTIME_VAULT_KEY_VERSION");
  const masterKey = required(environment, "RUNTIME_VAULT_MASTER_KEY");
  if (!KEY_VERSION_PATTERN.test(keyVersion)) {
    throw new Error("RUNTIME_FLEET_CREDENTIAL_PROVISION_INVALID_KEY_VERSION");
  }

  const input = parsePrivateJson(sourcePath);
  const connections = validateFleetProvisioningInput(input);
  const logicalManifest = buildFleetLogicalManifest({ keyVersion, connections });
  const { target, realParent } = validateExternalOutput(destination);
  const staging = mkdtempSync(join(realParent, `.${basename(target)}.tmp-`));
  chmodSync(staging, 0o700);

  try {
    const artifacts = [];
    for (const connection of connections) {
      const connectionDirectory = join(staging, connection.connectionId);
      mkdirSync(connectionDirectory, { mode: 0o700 });
      chmodSync(connectionDirectory, 0o700);
      const output = join(connectionDirectory, "runtime-credentials.sql");
      const result = prepareCredentialProvisioning({
        mode: "adopt-existing",
        output,
        environment: {
          CANARY_CONNECTION_ID: connection.connectionId,
          CANARY_RUN_ID: connection.runId,
          RUNTIME_VAULT_KEY_VERSION: keyVersion,
          RUNTIME_VAULT_MASTER_KEY: masterKey,
          RUNTIME_AGORA_CREDENTIAL: connection.credentials.agora,
          RUNTIME_WINERIM_CREDENTIAL: connection.credentials.winerim,
          RUNTIME_ADOPT_EXPORT_MANIFEST: connection.adoptionEvidence.exportManifestPath,
          RUNTIME_ADOPT_EXPORT_MANIFEST_SHA256: connection.adoptionEvidence.exportManifestSha256,
          RUNTIME_ADOPT_TARGET_MANIFEST: connection.adoptionEvidence.targetManifestPath,
          RUNTIME_ADOPT_TARGET_MANIFEST_SHA256: connection.adoptionEvidence.targetManifestSha256,
          RUNTIME_ADOPT_RECONCILIATION_MANIFEST:
            connection.adoptionEvidence.reconciliationManifestPath,
          RUNTIME_ADOPT_RECONCILIATION_MANIFEST_SHA256:
            connection.adoptionEvidence.reconciliationManifestSha256,
        },
      });
      artifacts.push({
        connectionId: connection.connectionId,
        runId: connection.runId,
        output: result.output,
        manifestPath: result.manifestPath,
        sqlSha256: result.artifactSha256,
        manifestSha256: result.manifestSha256,
        active: false,
        activationAllowed: false,
      });
    }

    const manifestPath = join(staging, "fleet-credentials.logical-manifest.json");
    const manifestSource = `${JSON.stringify(logicalManifest, null, 2)}\n`;
    writeFileSync(manifestPath, manifestSource, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(manifestPath, 0o600);
    renameSync(staging, target);

    const relocatedArtifacts = artifacts.map((artifact) => ({
      ...artifact,
      output: join(target, artifact.connectionId, "runtime-credentials.sql"),
      manifestPath: join(target, artifact.connectionId, "runtime-credentials.sql.manifest.json"),
    }));
    return {
      status: "RUNTIME_FLEET_CREDENTIAL_PROVISION_ARTIFACTS_READY",
      remoteMutations: 0,
      active: false,
      activationAllowed: false,
      connectionCount: connections.length,
      outputDir: target,
      logicalManifestPath: join(target, "fleet-credentials.logical-manifest.json"),
      logicalManifestSha256: logicalManifest.logicalManifestSha256,
      artifacts: relocatedArtifacts,
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function argument(name) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function main() {
  if (!process.argv.includes("--render")) {
    process.stdout.write(`${JSON.stringify(fleetCredentialProvisioningPlan(), null, 2)}\n`);
    return;
  }
  const result = prepareFleetCredentialProvisioning({
    inputPath: argument("--input"),
    outputDir: argument("--output"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
