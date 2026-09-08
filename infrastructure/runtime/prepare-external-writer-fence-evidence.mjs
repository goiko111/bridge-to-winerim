import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateExternalBootstrapWriterFenceEvidence } from "./prepare-writer-fence-grant.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SECRET_KEY_PATTERN = /(?:^|_)(?:api_?token|winerim_?(?:api_?)?token|access_?token|refresh_?token|authorization|bearer|password|secret|private_?key|credential_(?:value|token|secret))(?:$|_)/i;
const MAX_INPUT_BYTES = 1024 * 1024;
const MIN_DRAIN_MS = 130 * 1_000;
const MIN_READBACK_SEPARATION_MS = 5 * 1_000;
const MAX_EVIDENCE_AGE_MS = 15 * 60 * 1_000;
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function plainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizedKey(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
}

function assertNoSecretMaterial(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (
      SECRET_KEY_PATTERN.test(normalizedKey(key))
      && nested !== null
      && nested !== false
      && nested !== ""
    ) {
      throw new Error("EXTERNAL_WRITER_FENCE_SECRET_OR_TOKEN_PRESENT");
    }
    assertNoSecretMaterial(nested);
  }
}

function assertExactKeys(value, expected, label) {
  if (!plainObject(value)) {
    throw new Error(`EXTERNAL_WRITER_FENCE_INVALID_${label}`);
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`EXTERNAL_WRITER_FENCE_INVALID_${label}_FIELDS`);
  }
}

function timestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`EXTERNAL_WRITER_FENCE_INVALID_${label}`);
  }
  return parsed;
}

function safeReadRegularFile(path, label, { privateMode = false } = {}) {
  if (!path || !isAbsolute(path)) {
    throw new Error(`EXTERNAL_WRITER_FENCE_${label}_PATH_MUST_BE_ABSOLUTE`);
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`EXTERNAL_WRITER_FENCE_${label}_MUST_BE_REGULAR_FILE`);
  }
  if (privateMode && !new Set([0o400, 0o600]).has(metadata.mode & 0o777)) {
    throw new Error("EXTERNAL_WRITER_FENCE_PRIVATE_KEY_MUST_BE_0400_OR_0600");
  }
  if (metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) {
    throw new Error(`EXTERNAL_WRITER_FENCE_${label}_INVALID_SIZE`);
  }

  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error(`EXTERNAL_WRITER_FENCE_${label}_CHANGED_DURING_READ`);
    }
    if (privateMode && !new Set([0o400, 0o600]).has(opened.mode & 0o777)) {
      throw new Error("EXTERNAL_WRITER_FENCE_PRIVATE_KEY_MUST_BE_0400_OR_0600");
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function parsePayload(source) {
  let document;
  try {
    document = JSON.parse(source.toString("utf8"));
  } catch {
    throw new Error("EXTERNAL_WRITER_FENCE_READBACKS_INVALID_JSON");
  }
  assertNoSecretMaterial(document);
  return document;
}

function validateReadback(readback, fenceAppliedMs, index) {
  assertExactKeys(readback, [
    "observedAt",
    "status",
    "writerDisabled",
    "cronDisabled",
    "edgeMutationDisabled",
    "agoraCredentialUnavailableToLovable",
  ], `READBACK_${index + 1}`);
  const observedMs = timestamp(readback.observedAt, `READBACK_${index + 1}_OBSERVED_AT`);
  if (
    readback.status !== "FENCED_HEALTHY"
    || readback.writerDisabled !== true
    || readback.cronDisabled !== true
    || readback.edgeMutationDisabled !== true
    || readback.agoraCredentialUnavailableToLovable !== true
    || observedMs < fenceAppliedMs + MIN_DRAIN_MS
  ) {
    throw new Error("EXTERNAL_WRITER_FENCE_READBACK_NOT_HEALTHY_AFTER_DRAIN");
  }
  return observedMs;
}

export function validateExternalWriterFencePayload(payload, { referenceTime = new Date().toISOString() } = {}) {
  assertNoSecretMaterial(payload);
  assertExactKeys(payload, [
    "evidenceType",
    "connectionId",
    "source",
    "fenceMode",
    "fenceAppliedAt",
    "observedAt",
    "lovable",
    "agoraCredential",
    "readbacks",
  ], "PAYLOAD");
  assertExactKeys(payload.source, ["provider", "projectId", "collectorRunId"], "SOURCE");
  assertExactKeys(payload.lovable, [
    "writerDisabled",
    "cronDisabled",
    "edgeMutationDisabled",
  ], "LOVABLE_STATE");
  assertExactKeys(payload.agoraCredential, ["rotated", "removedFromLovable"], "AGORA_CREDENTIAL");

  if (
    payload.evidenceType !== "lovable-writer-fence"
    || !UUID_PATTERN.test(payload.connectionId ?? "")
    || payload.source.provider !== "lovable-cloud"
    || !UUID_PATTERN.test(payload.source.projectId ?? "")
    || !IDENTIFIER_PATTERN.test(payload.source.collectorRunId ?? "")
    || payload.fenceMode !== "lovable-disabled-no-agora-rotation"
  ) {
    throw new Error("EXTERNAL_WRITER_FENCE_SCOPE_MISMATCH");
  }
  if (
    payload.lovable.writerDisabled !== true
    || payload.lovable.cronDisabled !== true
    || payload.lovable.edgeMutationDisabled !== true
    || payload.agoraCredential.rotated !== false
    || payload.agoraCredential.removedFromLovable !== true
  ) {
    throw new Error("EXTERNAL_WRITER_FENCE_WRITER_NOT_EXCLUSIVELY_DISABLED");
  }
  if (!Array.isArray(payload.readbacks) || payload.readbacks.length !== 2) {
    throw new Error("EXTERNAL_WRITER_FENCE_EXACTLY_TWO_READBACKS_REQUIRED");
  }

  const referenceMs = timestamp(referenceTime, "REFERENCE_TIME");
  const fenceAppliedMs = timestamp(payload.fenceAppliedAt, "FENCE_APPLIED_AT");
  const observedMs = timestamp(payload.observedAt, "OBSERVED_AT");
  const readbackTimes = payload.readbacks.map((readback, index) => (
    validateReadback(readback, fenceAppliedMs, index)
  ));
  if (
    readbackTimes[1] - readbackTimes[0] < MIN_READBACK_SEPARATION_MS
    || readbackTimes[1] !== observedMs
  ) {
    throw new Error("EXTERNAL_WRITER_FENCE_READBACK_ORDER_OR_SEPARATION_INVALID");
  }
  if (
    fenceAppliedMs > observedMs
    || observedMs > referenceMs
    || referenceMs - observedMs > MAX_EVIDENCE_AGE_MS
  ) {
    throw new Error("EXTERNAL_WRITER_FENCE_EVIDENCE_NOT_FRESH");
  }

  return {
    evidenceType: "lovable-writer-fence",
    connectionId: payload.connectionId,
    source: {
      provider: "lovable-cloud",
      projectId: payload.source.projectId,
      collectorRunId: payload.source.collectorRunId,
    },
    fenceMode: "lovable-disabled-no-agora-rotation",
    fenceAppliedAt: payload.fenceAppliedAt,
    observedAt: payload.observedAt,
    lovable: {
      writerDisabled: true,
      cronDisabled: true,
      edgeMutationDisabled: true,
    },
    agoraCredential: {
      rotated: false,
      removedFromLovable: true,
    },
    readbacks: payload.readbacks.map((readback) => ({
      observedAt: readback.observedAt,
      status: "FENCED_HEALTHY",
      writerDisabled: true,
      cronDisabled: true,
      edgeMutationDisabled: true,
      agoraCredentialUnavailableToLovable: true,
    })),
  };
}

function privateEd25519Key(source) {
  let privateKey;
  try {
    privateKey = createPrivateKey(source);
  } catch {
    throw new Error("EXTERNAL_WRITER_FENCE_PRIVATE_KEY_INVALID");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("EXTERNAL_WRITER_FENCE_PRIVATE_KEY_MUST_BE_ED25519");
  }
  return privateKey;
}

export function buildExternalWriterFenceEvidence({
  payload,
  privateKeySource,
  keyId,
  readbacksSourceSha256,
  referenceTime = new Date().toISOString(),
}) {
  if (!IDENTIFIER_PATTERN.test(keyId ?? "")) {
    throw new Error("EXTERNAL_WRITER_FENCE_INVALID_KEY_ID");
  }
  if (!SHA256_PATTERN.test(readbacksSourceSha256 ?? "")) {
    throw new Error("EXTERNAL_WRITER_FENCE_INVALID_READBACKS_SHA256");
  }
  const canonicalPayload = validateExternalWriterFencePayload(payload, { referenceTime });
  const privateKey = privateEd25519Key(privateKeySource);
  const publicKeySource = Buffer.from(createPublicKey(privateKey).export({
    type: "spki",
    format: "pem",
  }));
  const payloadSource = Buffer.from(JSON.stringify(canonicalPayload));
  const signature = sign(null, payloadSource, privateKey);
  const hashes = {
    readbacksSourceSha256,
    publicKeySha256: sha256(publicKeySource),
    payloadSha256: sha256(payloadSource),
    signatureSha256: sha256(signature),
  };
  const envelope = {
    version: 1,
    algorithm: "Ed25519",
    keyId,
    publicKeyPem: publicKeySource.toString("utf8"),
    payload: canonicalPayload,
    signatureBase64: signature.toString("base64"),
    hashes,
  };
  const artifactSource = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`);
  const artifactSha256 = sha256(artifactSource);

  validateExternalBootstrapWriterFenceEvidence({
    artifactSource,
    artifactSha256,
    publicKeySource,
    publicKeySha256: hashes.publicKeySha256,
    connectionId: canonicalPayload.connectionId,
    referenceTime,
  });

  return {
    artifactSource,
    publicKeySource,
    artifactSha256,
    hashes,
    payload: canonicalPayload,
  };
}

function outsideRepository(path) {
  const candidate = relative(repoRoot, path);
  return candidate === ".." || candidate.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    || isAbsolute(candidate);
}

function outputTarget(outputDir) {
  if (!outputDir || !isAbsolute(outputDir) || !outsideRepository(resolve(outputDir))) {
    throw new Error("EXTERNAL_WRITER_FENCE_OUTPUT_MUST_BE_ABSOLUTE_OUTSIDE_REPOSITORY");
  }
  const target = resolve(outputDir);
  if (existsSync(target)) {
    throw new Error("EXTERNAL_WRITER_FENCE_OUTPUT_ALREADY_EXISTS");
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  chmodSync(dirname(target), 0o700);
  const realParent = realpathSync(dirname(target));
  if (!outsideRepository(realParent)) {
    throw new Error("EXTERNAL_WRITER_FENCE_OUTPUT_REALPATH_MUST_BE_OUTSIDE_REPOSITORY");
  }
  return { target, realParent };
}

export function prepareExternalWriterFenceEvidence({
  readbacksPath,
  expectedReadbacksSha256,
  privateKeyPath,
  keyId,
  outputDir,
  referenceTime = new Date().toISOString(),
}) {
  if (!SHA256_PATTERN.test(expectedReadbacksSha256 ?? "")) {
    throw new Error("EXTERNAL_WRITER_FENCE_INVALID_EXPECTED_READBACKS_SHA256");
  }
  const readbacksSource = safeReadRegularFile(readbacksPath, "READBACKS");
  const readbacksSourceSha256 = sha256(readbacksSource);
  if (readbacksSourceSha256 !== expectedReadbacksSha256) {
    throw new Error("EXTERNAL_WRITER_FENCE_READBACKS_SHA256_MISMATCH");
  }
  const privateKeySource = safeReadRegularFile(privateKeyPath, "PRIVATE_KEY", { privateMode: true });
  const prepared = buildExternalWriterFenceEvidence({
    payload: parsePayload(readbacksSource),
    privateKeySource,
    keyId,
    readbacksSourceSha256,
    referenceTime,
  });
  const { target, realParent } = outputTarget(outputDir);
  const staging = mkdtempSync(join(realParent, `.${basename(target)}.tmp-`));
  chmodSync(staging, 0o700);
  try {
    const evidenceName = "lovable-writer-fence.evidence.json";
    const publicKeyName = "lovable-writer-fence.public.pem";
    const evidencePath = join(staging, evidenceName);
    const publicKeyPath = join(staging, publicKeyName);
    writeFileSync(evidencePath, prepared.artifactSource, { mode: 0o600, flag: "wx" });
    writeFileSync(publicKeyPath, prepared.publicKeySource, { mode: 0o600, flag: "wx" });
    chmodSync(evidencePath, 0o600);
    chmodSync(publicKeyPath, 0o600);
    renameSync(staging, target);
    return {
      status: "EXTERNAL_WRITER_FENCE_EVIDENCE_READY",
      remoteMutations: 0,
      productionWrites: 0,
      connectionId: prepared.payload.connectionId,
      projectId: prepared.payload.source.projectId,
      collectorRunId: prepared.payload.source.collectorRunId,
      fenceMode: prepared.payload.fenceMode,
      fenceAppliedAt: prepared.payload.fenceAppliedAt,
      observedAt: prepared.payload.observedAt,
      readbackObservedAt: prepared.payload.readbacks.map((readback) => readback.observedAt),
      evidencePath: join(target, evidenceName),
      publicKeyPath: join(target, publicKeyName),
      artifactSha256: prepared.artifactSha256,
      ...prepared.hashes,
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
  if (!process.argv.includes("--collect")) {
    process.stdout.write(`${JSON.stringify({
      status: "EXTERNAL_WRITER_FENCE_LOCAL_COLLECTOR_READY",
      remoteMutations: 0,
      productionWrites: 0,
      minimumDrainMs: MIN_DRAIN_MS,
      minimumReadbackSeparationMs: MIN_READBACK_SEPARATION_MS,
      maximumEvidenceAgeMs: MAX_EVIDENCE_AGE_MS,
      requiredArguments: [
        "--readbacks=/absolute/path/readbacks.json",
        "--readbacks-sha256=<SHA256>",
        "--private-key=/absolute/path/ed25519-private.pem",
        "--key-id=<PINNED_KEY_ID>",
        "--output=/absolute/path/outside/repository",
      ],
    }, null, 2)}\n`);
    return;
  }
  const result = prepareExternalWriterFenceEvidence({
    readbacksPath: argument("--readbacks"),
    expectedReadbacksSha256: argument("--readbacks-sha256")?.toLowerCase(),
    privateKeyPath: argument("--private-key"),
    keyId: argument("--key-id"),
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
