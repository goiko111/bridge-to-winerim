import { createHash, createPublicKey, verify } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const WRITER_FENCE_MODES = new Set(["legacy-writer-revoked", "bootstrap-no-legacy-writer"]);
const MIN_LEGACY_WRITER_DRAIN_MS = 130 * 1_000;
const MAX_BOOTSTRAP_EVIDENCE_AGE_MS = 15 * 60 * 1_000;
const scriptPath = fileURLToPath(import.meta.url);

function required(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`WRITER_FENCE_GRANT_MISSING_${name}`);
  return value;
}

function timestamp(value, name) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`WRITER_FENCE_GRANT_INVALID_${name}`);
  return parsed;
}

function requiredFrom(environment, name) {
  const value = String(environment[name] ?? "").trim();
  if (!value) throw new Error(`WRITER_FENCE_GRANT_MISSING_${name}`);
  return value;
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function readBoundFile(path, expectedSha256, label) {
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new Error(`WRITER_FENCE_GRANT_INVALID_${label}_SHA256`);
  }
  const source = readFileSync(resolve(path));
  if (sha256(source) !== expectedSha256) {
    throw new Error(`WRITER_FENCE_GRANT_${label}_SHA256_MISMATCH`);
  }
  return source;
}

function healthyFenceReadback(readback, fenceAppliedMs) {
  const observedMs = timestamp(readback?.observedAt, "EXTERNAL_READBACK_OBSERVED_AT");
  if (
    readback?.status !== "FENCED_HEALTHY"
    || readback?.writerDisabled !== true
    || readback?.cronDisabled !== true
    || readback?.edgeMutationDisabled !== true
    || readback?.agoraCredentialUnavailableToLovable !== true
    || observedMs < fenceAppliedMs + MIN_LEGACY_WRITER_DRAIN_MS
  ) {
    throw new Error("WRITER_FENCE_GRANT_EXTERNAL_READBACK_NOT_HEALTHY_AFTER_DRAIN");
  }
  return observedMs;
}

export function validateExternalBootstrapWriterFenceEvidence({
  artifactSource,
  artifactSha256,
  publicKeySource,
  publicKeySha256,
  connectionId,
  referenceTime,
}) {
  if (!SHA256_PATTERN.test(artifactSha256) || sha256(artifactSource) !== artifactSha256) {
    throw new Error("WRITER_FENCE_GRANT_EXTERNAL_EVIDENCE_SHA256_MISMATCH");
  }
  if (!SHA256_PATTERN.test(publicKeySha256) || sha256(publicKeySource) !== publicKeySha256) {
    throw new Error("WRITER_FENCE_GRANT_EXTERNAL_PUBLIC_KEY_SHA256_MISMATCH");
  }
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(artifactSource).toString("utf8"));
  } catch {
    throw new Error("WRITER_FENCE_GRANT_EXTERNAL_EVIDENCE_INVALID_JSON");
  }
  if (
    envelope?.version !== 1
    || envelope?.algorithm !== "Ed25519"
    || !IDENTIFIER_PATTERN.test(envelope?.keyId ?? "")
    || typeof envelope?.payload !== "object"
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope?.signatureBase64 ?? "")
  ) {
    throw new Error("WRITER_FENCE_GRANT_EXTERNAL_EVIDENCE_INVALID_ENVELOPE");
  }
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeySource);
  } catch {
    throw new Error("WRITER_FENCE_GRANT_EXTERNAL_PUBLIC_KEY_INVALID");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("WRITER_FENCE_GRANT_EXTERNAL_PUBLIC_KEY_MUST_BE_ED25519");
  }
  const canonicalPayload = Buffer.from(JSON.stringify(envelope.payload));
  if (!verify(null, canonicalPayload, publicKey, Buffer.from(envelope.signatureBase64, "base64"))) {
    throw new Error("WRITER_FENCE_GRANT_EXTERNAL_EVIDENCE_SIGNATURE_INVALID");
  }

  const payload = envelope.payload;
  if (
    payload?.evidenceType !== "lovable-writer-fence"
    || payload?.connectionId !== connectionId
    || payload?.source?.provider !== "lovable-cloud"
    || !UUID_PATTERN.test(payload?.source?.projectId ?? "")
    || !IDENTIFIER_PATTERN.test(payload?.source?.collectorRunId ?? "")
    || !new Set(["agora-credential-rotated", "lovable-disabled-no-agora-rotation"]).has(payload?.fenceMode)
    || payload?.lovable?.writerDisabled !== true
    || payload?.lovable?.cronDisabled !== true
    || payload?.lovable?.edgeMutationDisabled !== true
  ) {
    throw new Error("WRITER_FENCE_GRANT_EXTERNAL_EVIDENCE_SCOPE_MISMATCH");
  }

  const referenceMs = timestamp(referenceTime, "EXTERNAL_EVIDENCE_REFERENCE_TIME");
  const fenceAppliedMs = timestamp(payload.fenceAppliedAt, "EXTERNAL_FENCE_APPLIED_AT");
  const observedMs = timestamp(payload.observedAt, "EXTERNAL_EVIDENCE_OBSERVED_AT");
  if (
    fenceAppliedMs > observedMs
    || observedMs > referenceMs
    || referenceMs - observedMs > MAX_BOOTSTRAP_EVIDENCE_AGE_MS
  ) {
    throw new Error("WRITER_FENCE_GRANT_BOOTSTRAP_EVIDENCE_MUST_BE_FRESH");
  }
  if (!Array.isArray(payload.readbacks) || payload.readbacks.length < 1) {
    throw new Error("WRITER_FENCE_GRANT_EXTERNAL_READBACKS_REQUIRED");
  }
  const readbackTimes = payload.readbacks.map((readback) => healthyFenceReadback(
    readback,
    fenceAppliedMs,
  ));
  if (
    readbackTimes.some((value, index) => index > 0 && value <= readbackTimes[index - 1])
    || readbackTimes.at(-1) !== observedMs
  ) {
    throw new Error("WRITER_FENCE_GRANT_EXTERNAL_READBACK_ORDER_INVALID");
  }

  if (payload.fenceMode === "agora-credential-rotated") {
    if (
      payload?.agoraCredential?.rotated !== true
      || ![401, 403].includes(payload?.agoraCredential?.oldCredentialProbeStatus)
      || timestamp(payload?.agoraCredential?.rotatedAt, "EXTERNAL_AGORA_ROTATED_AT") > observedMs
    ) {
      throw new Error("WRITER_FENCE_GRANT_EXTERNAL_AGORA_ROTATION_NOT_VERIFIED");
    }
  } else if (
    payload?.agoraCredential?.rotated !== false
    || payload?.agoraCredential?.removedFromLovable !== true
    || payload.readbacks.length !== 2
  ) {
    throw new Error("WRITER_FENCE_GRANT_EXTERNAL_NO_ROTATION_REQUIRES_TWO_READBACKS");
  }

  return {
    artifactSha256,
    publicKeySha256,
    payloadSha256: sha256(canonicalPayload),
    signatureSha256: sha256(Buffer.from(envelope.signatureBase64, "base64")),
    keyId: envelope.keyId,
    projectId: payload.source.projectId,
    collectorRunId: payload.source.collectorRunId,
    fenceMode: payload.fenceMode,
    fenceAppliedAt: new Date(fenceAppliedMs).toISOString(),
    observedAt: new Date(observedMs).toISOString(),
    readbackObservedAt: readbackTimes.map((value) => new Date(value).toISOString()),
  };
}

export function readExternalBootstrapWriterFenceEvidence({ environment, connectionId, referenceTime }) {
  const artifactSha256 = requiredFrom(environment, "NO_LEGACY_WRITER_EXTERNAL_EVIDENCE_SHA256").toLowerCase();
  const publicKeySha256 = requiredFrom(environment, "NO_LEGACY_WRITER_EXTERNAL_PUBLIC_KEY_SHA256").toLowerCase();
  const artifactSource = readBoundFile(
    requiredFrom(environment, "NO_LEGACY_WRITER_EXTERNAL_EVIDENCE"),
    artifactSha256,
    "EXTERNAL_EVIDENCE",
  );
  const publicKeySource = readBoundFile(
    requiredFrom(environment, "NO_LEGACY_WRITER_EXTERNAL_PUBLIC_KEY"),
    publicKeySha256,
    "EXTERNAL_PUBLIC_KEY",
  );
  return validateExternalBootstrapWriterFenceEvidence({
    artifactSource,
    artifactSha256,
    publicKeySource,
    publicKeySha256,
    connectionId,
    referenceTime,
  });
}

function outputPath() {
  const argument = process.argv.find((value) => value.startsWith("--output="));
  if (!argument) throw new Error("USAGE: prepare-writer-fence-grant.mjs --output=/secure/path/grant.json");
  return resolve(argument.slice("--output=".length));
}

export function prepareWriterFenceGrant({ environment = process.env, output } = {}) {
  const connectionId = requiredFrom(environment, "CANARY_CONNECTION_ID");
  const runId = requiredFrom(environment, "CANARY_RUN_ID");
  const holderId = requiredFrom(environment, "CANARY_HOLDER_ID");
  const proof = requiredFrom(environment, "CANARY_WRITER_FENCE_PROOF");
  const exclusiveCredentialRef = requiredFrom(environment, "CANARY_EXCLUSIVE_CREDENTIAL_REF");
  const credentialVersion = requiredFrom(environment, "CANARY_EXCLUSIVE_CREDENTIAL_VERSION");
  const writerFenceMode = String(
    environment.WRITER_FENCE_MODE ?? "legacy-writer-revoked",
  ).trim();
  const issuedAt = environment.CANARY_FENCE_ISSUED_AT ?? new Date().toISOString();
  const expiresAt = requiredFrom(environment, "CANARY_FENCE_EXPIRES_AT");

  if (!UUID_PATTERN.test(connectionId)) throw new Error("WRITER_FENCE_GRANT_INVALID_CONNECTION_ID");
  if (!IDENTIFIER_PATTERN.test(runId)) throw new Error("WRITER_FENCE_GRANT_INVALID_RUN_ID");
  if (!IDENTIFIER_PATTERN.test(holderId)) throw new Error("WRITER_FENCE_GRANT_INVALID_HOLDER_ID");
  if (proof.length < 32) throw new Error("WRITER_FENCE_GRANT_PROOF_TOO_SHORT");
  if (!exclusiveCredentialRef.startsWith("runtime-vault://postgres/")) {
    throw new Error("WRITER_FENCE_GRANT_EXCLUSIVE_CREDENTIAL_REF_REQUIRED");
  }
  if (!SHA256_PATTERN.test(credentialVersion)) {
    throw new Error("WRITER_FENCE_GRANT_INVALID_CREDENTIAL_VERSION");
  }
  if (!WRITER_FENCE_MODES.has(writerFenceMode)) {
    throw new Error("WRITER_FENCE_GRANT_INVALID_MODE");
  }

  const issuedMs = timestamp(issuedAt, "CANARY_FENCE_ISSUED_AT");
  const expiresMs = timestamp(expiresAt, "CANARY_FENCE_EXPIRES_AT");
  if (expiresMs <= issuedMs || expiresMs - issuedMs > 2 * 60 * 60 * 1_000) {
    throw new Error("WRITER_FENCE_GRANT_EXPIRY_MUST_BE_WITHIN_TWO_HOURS");
  }

  const common = {
    connectionId,
    runId,
    holderId,
    proofSha256: createHash("sha256").update(proof).digest("hex"),
    exclusiveCredentialRef,
    credentialVersion,
    credentialBinding: createHash("sha256").update([
      "winerim-writer-fence-credential",
      "1",
      exclusiveCredentialRef,
      credentialVersion,
    ].join("|")).digest("hex"),
    issuedAt,
    expiresAt,
  };
  let grant;
  if (writerFenceMode === "legacy-writer-revoked") {
    const revokedAt = requiredFrom(environment, "LEGACY_WRITER_REVOKED_AT");
    const negativeProbeStatus = Number(requiredFrom(environment, "LEGACY_WRITER_NEGATIVE_PROBE_STATUS"));
    const evidenceSha256 = requiredFrom(environment, "LEGACY_WRITER_EVIDENCE_SHA256");
    if (![401, 403].includes(negativeProbeStatus)) {
      throw new Error("WRITER_FENCE_GRANT_LEGACY_WRITER_MUST_RETURN_401_OR_403");
    }
    if (!SHA256_PATTERN.test(evidenceSha256)) {
      throw new Error("WRITER_FENCE_GRANT_INVALID_LEGACY_EVIDENCE_SHA256");
    }
    const revokedMs = timestamp(revokedAt, "LEGACY_WRITER_REVOKED_AT");
    if (revokedMs > issuedMs) throw new Error("WRITER_FENCE_GRANT_REVOKE_AFTER_ISSUE");
    grant = {
      version: 1,
      ...common,
      legacyWriter: { revokedAt, negativeProbeStatus, evidenceSha256 },
    };
  } else {
    const expectedCredentialRef = `runtime-vault://postgres/${connectionId}/agora/agora`;
    const job = requiredFrom(environment, "CANARY_RUNTIME_JOB");
    const lane = requiredFrom(environment, "CANARY_RUNTIME_LANE");
    const productId = requiredFrom(environment, "CANARY_CATALOG_PRODUCT_ID");
    if (
      job !== "catalog.sync-master"
      || lane !== "catalog"
      || !/^\d+$/.test(productId)
      || exclusiveCredentialRef !== expectedCredentialRef
    ) {
      throw new Error("WRITER_FENCE_GRANT_BOOTSTRAP_CATALOG_AGORA_SCOPE_REQUIRED");
    }
    const externalEvidence = readExternalBootstrapWriterFenceEvidence({
      environment,
      connectionId,
      referenceTime: issuedAt,
    });
    grant = {
      version: 3,
      ...common,
      writerHistory: {
        mode: "bootstrap-no-legacy-writer",
        verifiedAt: externalEvidence.observedAt,
        externalEvidence,
      },
    };
  }
  const target = resolve(output ?? outputPath());
  const source = `${JSON.stringify(grant, null, 2)}\n`;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, source, { mode: 0o600 });
  chmodSync(target, 0o600);
  const grantSha256 = createHash("sha256").update(source).digest("hex");
  process.stdout.write(
    `WRITER_FENCE_GRANT_READY path=${target} connection=${connectionId} run=${runId} sha256=${grantSha256}\n`,
  );
  return { grant, grantSha256, path: target };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    prepareWriterFenceGrant();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
