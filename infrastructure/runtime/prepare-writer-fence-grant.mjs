import { createHash, createHmac, createPublicKey, verify } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ADOPT_EXISTING_RUN_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/;
const ADOPT_EXISTING_KEY_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const ADOPT_EXISTING_SALES_MODE = "adopt-existing-sales-no-legacy-writer";
const ADOPT_EXISTING_FULL_LANES_MODE = "adopt-existing-full-lanes-no-legacy-writer";
const ADOPT_EXISTING_SALES_JOBS = ["sales.auto-sync", "sales.sync-intraday"];
const ADOPT_EXISTING_FULL_LANES_JOBS = [
  ...ADOPT_EXISTING_SALES_JOBS,
  "catalog.fetch-winerim",
  "catalog.sync-master",
  "outbound.process",
];
const WRITER_FENCE_MODES = new Set([
  "legacy-writer-revoked",
  "bootstrap-no-legacy-writer",
  ADOPT_EXISTING_SALES_MODE,
  ADOPT_EXISTING_FULL_LANES_MODE,
]);
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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredSha256(environment, name) {
  const value = requiredFrom(environment, name).toLowerCase();
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`WRITER_FENCE_GRANT_INVALID_${name}`);
  }
  return value;
}

function fleetCredentialReference(connectionId, kind) {
  return `runtime-vault://postgres/${connectionId}/agora/${kind}`;
}

function fleetCredentialBinding({ connectionId, runId, kind, version }) {
  return sha256([
    "winerim-writer-fence-fleet-credential",
    "1",
    connectionId,
    runId,
    "agora",
    kind,
    fleetCredentialReference(connectionId, kind),
    version,
  ].join("|"));
}

function prepareFleetCredentialBundle({ environment, connectionId, runId, holderId, proof, issuedAt, expiresAt }) {
  const keyVersion = requiredFrom(environment, "RUNTIME_VAULT_KEY_VERSION");
  if (!ADOPT_EXISTING_KEY_VERSION_PATTERN.test(keyVersion)) {
    throw new Error("WRITER_FENCE_GRANT_INVALID_KEY_VERSION");
  }
  const credentials = Object.fromEntries(["agora", "winerim"].map((kind) => {
    const version = requiredFrom(environment, `CANARY_${kind.toUpperCase()}_CREDENTIAL_VERSION`).toLowerCase();
    if (!SHA256_PATTERN.test(version)) {
      throw new Error(`WRITER_FENCE_GRANT_INVALID_${kind.toUpperCase()}_CREDENTIAL_VERSION`);
    }
    return [kind, {
      kind,
      reference: fleetCredentialReference(connectionId, kind),
      version,
      attestationSha256: version,
      binding: fleetCredentialBinding({ connectionId, runId, kind, version }),
    }];
  }));
  const generationSha256 = sha256([
    "winerim-runtime-credential-set",
    "1",
    connectionId,
    runId,
    keyVersion,
    credentials.agora.attestationSha256,
    credentials.winerim.attestationSha256,
  ].join("|"));
  const unsigned = { version: 1, keyVersion, generationSha256, credentials };
  const payload = [
    "winerim-writer-fence-credential-bundle",
    "1",
    connectionId,
    runId,
    holderId,
    issuedAt,
    expiresAt,
    keyVersion,
    generationSha256,
    credentials.agora.kind,
    credentials.agora.reference,
    credentials.agora.version,
    credentials.agora.attestationSha256,
    credentials.agora.binding,
    credentials.winerim.kind,
    credentials.winerim.reference,
    credentials.winerim.version,
    credentials.winerim.attestationSha256,
    credentials.winerim.binding,
  ].join("|");
  return {
    ...unsigned,
    bundleSha256: sha256(payload),
    signatureSha256: createHmac("sha256", proof).update(payload).digest("hex"),
  };
}

function bootstrapAbsence(environment) {
  const fields = {
    activeConnectionCount: "CANARY_BOOTSTRAP_ACTIVE_CONNECTION_COUNT",
    activeCredentialCount: "CANARY_BOOTSTRAP_ACTIVE_CREDENTIAL_COUNT",
    activeScopeCount: "CANARY_BOOTSTRAP_ACTIVE_SCOPE_COUNT",
    priorRunCount: "CANARY_BOOTSTRAP_PRIOR_RUN_COUNT",
    activeProducerCount: "CANARY_BOOTSTRAP_ACTIVE_PRODUCER_COUNT",
    activeConsumerCount: "CANARY_BOOTSTRAP_ACTIVE_CONSUMER_COUNT",
  };
  return Object.fromEntries(Object.entries(fields).map(([key, name]) => {
    if (requiredFrom(environment, name) !== "0") {
      throw new Error("WRITER_FENCE_GRANT_BOOTSTRAP_ABSENCE_REQUIRED");
    }
    return [key, 0];
  }));
}

function adoptExistingAbsence(environment) {
  const zeroFields = {
    activeConnectionCount: "CANARY_ADOPT_EXISTING_ACTIVE_CONNECTION_COUNT",
    activeCredentialCount: "CANARY_ADOPT_EXISTING_ACTIVE_CREDENTIAL_COUNT",
    activeScopeCount: "CANARY_ADOPT_EXISTING_ACTIVE_SCOPE_COUNT",
    activeProducerCount: "CANARY_ADOPT_EXISTING_ACTIVE_PRODUCER_COUNT",
    activeConsumerCount: "CANARY_ADOPT_EXISTING_ACTIVE_CONSUMER_COUNT",
  };
  const absence = Object.fromEntries(Object.entries(zeroFields).map(([key, name]) => {
    if (requiredFrom(environment, name) !== "0") {
      throw new Error("WRITER_FENCE_GRANT_ADOPT_EXISTING_ACTIVE_STATE_MUST_BE_ZERO");
    }
    return [key, 0];
  }));
  const priorRunValue = requiredFrom(environment, "CANARY_ADOPT_EXISTING_PRIOR_RUN_COUNT");
  if (!/^\d+$/.test(priorRunValue)) {
    throw new Error("WRITER_FENCE_GRANT_ADOPT_EXISTING_PRIOR_RUN_COUNT_INVALID");
  }
  const priorRunCount = Number(priorRunValue);
  if (!Number.isSafeInteger(priorRunCount)) {
    throw new Error("WRITER_FENCE_GRANT_ADOPT_EXISTING_PRIOR_RUN_COUNT_INVALID");
  }
  return { ...absence, priorRunCount };
}

function adoptExistingRuntimePolicy(environment, writerFenceMode) {
  const fullLanes = writerFenceMode === ADOPT_EXISTING_FULL_LANES_MODE;
  const expectedJobs = fullLanes
    ? ADOPT_EXISTING_FULL_LANES_JOBS
    : ADOPT_EXISTING_SALES_JOBS;
  let runtimeJobs;
  try {
    runtimeJobs = JSON.parse(requiredFrom(environment, "CANARY_RUNTIME_JOBS"));
  } catch {
    throw new Error("WRITER_FENCE_GRANT_ADOPT_EXISTING_RUNTIME_JOBS_INVALID");
  }
  if (
    !Array.isArray(runtimeJobs)
    || runtimeJobs.length !== expectedJobs.length
    || runtimeJobs.some((job, index) => job !== expectedJobs[index])
  ) {
    throw new Error(fullLanes
      ? "WRITER_FENCE_GRANT_ADOPT_EXISTING_FULL_LANES_JOBS_REQUIRED"
      : "WRITER_FENCE_GRANT_ADOPT_EXISTING_SALES_JOBS_REQUIRED");
  }
  const expectedLane = fullLanes ? "full-lanes" : "sales";
  if (requiredFrom(environment, "CANARY_RUNTIME_LANE") !== expectedLane) {
    throw new Error(fullLanes
      ? "WRITER_FENCE_GRANT_ADOPT_EXISTING_FULL_LANES_LANE_REQUIRED"
      : "WRITER_FENCE_GRANT_ADOPT_EXISTING_SALES_LANE_REQUIRED");
  }
  const expectedFeatures = {
    openTickets: false,
    catalog: fullLanes,
    stock: fullLanes,
    outbound: fullLanes,
    maintenance: false,
  };
  const featureBindings = {
    openTickets: "CANARY_RUNTIME_OPEN_TICKETS_ENABLED",
    catalog: "CANARY_RUNTIME_CATALOG_ENABLED",
    stock: "CANARY_RUNTIME_STOCK_ENABLED",
    outbound: "CANARY_RUNTIME_OUTBOUND_ENABLED",
    maintenance: "CANARY_RUNTIME_MAINTENANCE_ENABLED",
  };
  const features = Object.fromEntries(Object.entries(featureBindings).map(([key, name]) => {
    const expected = expectedFeatures[key];
    if (requiredFrom(environment, name) !== String(expected)) {
      throw new Error(fullLanes
        ? "WRITER_FENCE_GRANT_ADOPT_EXISTING_FULL_LANES_FEATURES_REQUIRED"
        : "WRITER_FENCE_GRANT_ADOPT_EXISTING_NON_SALES_FEATURE_MUST_BE_DISABLED");
    }
    return [key, expected];
  }));
  const providerConfig = fullLanes
    ? {
      runtime_fleet_profile: "full-lanes-v1",
      runtime_fleet_job_allowlist: [...ADOPT_EXISTING_FULL_LANES_JOBS],
      runtime_sales_job_allowlist: [...ADOPT_EXISTING_SALES_JOBS],
      intraday_sales_sync_enabled: true,
      open_tickets_sync_enabled: features.openTickets,
      open_tickets_stock_sync_enabled: features.openTickets,
      runtime_catalog_enabled: features.catalog,
      runtime_stock_enabled: features.stock,
      runtime_outbound_enabled: features.outbound,
      runtime_maintenance_enabled: features.maintenance,
    }
    : {
      runtime_sales_job_allowlist: [...ADOPT_EXISTING_SALES_JOBS],
      intraday_sales_sync_enabled: true,
      open_tickets_sync_enabled: features.openTickets,
      open_tickets_stock_sync_enabled: features.openTickets,
    };
  return {
    profile: fullLanes ? "full-lanes-v1" : "sales-only-v1",
    providerConfig,
    runtimePolicySha256: sha256(canonicalJson(providerConfig)),
  };
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
  requireActivationEnvelope = false,
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
  const signature = Buffer.from(envelope.signatureBase64, "base64");
  if (!verify(null, canonicalPayload, publicKey, signature)) {
    throw new Error("WRITER_FENCE_GRANT_EXTERNAL_EVIDENCE_SIGNATURE_INVALID");
  }
  if (requireActivationEnvelope && (
    sha256(Buffer.from(envelope.publicKeyPem ?? "")) !== publicKeySha256
    || !SHA256_PATTERN.test(envelope.hashes?.readbacksSourceSha256 ?? "")
    || envelope.hashes?.publicKeySha256 !== publicKeySha256
    || envelope.hashes?.payloadSha256 !== sha256(canonicalPayload)
    || envelope.hashes?.signatureSha256 !== sha256(signature)
  )) {
    throw new Error("WRITER_FENCE_GRANT_EXTERNAL_EVIDENCE_ACTIVATION_ENVELOPE_INVALID");
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
    ...(requireActivationEnvelope ? { removedFromLovable: true } : {}),
  };
}

export function readExternalBootstrapWriterFenceEvidence({
  environment,
  connectionId,
  referenceTime,
  requireActivationEnvelope = false,
}) {
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
    requireActivationEnvelope,
  });
}

function prepareAdoptExistingActivationScope({
  environment,
  connectionId,
  runId,
  holderId,
  proof,
  issuedAt,
  expiresAt,
  externalEvidence,
  runtimePolicy,
}) {
  const adoptionBindingSha256 = requiredSha256(
    environment,
    "CANARY_ADOPTION_BINDING_SHA256",
  );
  const deploymentManifestSha256 = requiredSha256(
    environment,
    "CANARY_DEPLOYMENT_MANIFEST_SHA256",
  );
  const finalTargetRawSha256 = requiredSha256(
    environment,
    "CANARY_FINAL_TARGET_RAW_SHA256",
  );
  const payload = [
    "winerim-writer-fence-adopt-existing-sales",
    "1",
    connectionId,
    runId,
    holderId,
    issuedAt,
    expiresAt,
    adoptionBindingSha256,
    deploymentManifestSha256,
    finalTargetRawSha256,
    externalEvidence.artifactSha256,
    externalEvidence.payloadSha256,
    runtimePolicy.runtimePolicySha256,
  ].join("|");
  return {
    version: 1,
    kind: "adopt-existing-sales",
    adoptionBindingSha256,
    deploymentManifestSha256,
    finalTargetRawSha256,
    externalEvidenceSha256: externalEvidence.artifactSha256,
    externalEvidencePayloadSha256: externalEvidence.payloadSha256,
    runtimePolicyProfile: runtimePolicy.profile,
    runtimeJobAllowlist: runtimePolicy.profile === "full-lanes-v1"
      ? [...ADOPT_EXISTING_FULL_LANES_JOBS]
      : [...ADOPT_EXISTING_SALES_JOBS],
    runtimePolicySha256: runtimePolicy.runtimePolicySha256,
    bindingSha256: sha256(payload),
    signatureSha256: createHmac("sha256", proof).update(payload).digest("hex"),
  };
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
  const writerFenceMode = String(
    environment.WRITER_FENCE_MODE ?? "legacy-writer-revoked",
  ).trim();
  const issuedAt = environment.CANARY_FENCE_ISSUED_AT ?? new Date().toISOString();
  const expiresAt = requiredFrom(environment, "CANARY_FENCE_EXPIRES_AT");

  if (!UUID_PATTERN.test(connectionId)) throw new Error("WRITER_FENCE_GRANT_INVALID_CONNECTION_ID");
  if (!IDENTIFIER_PATTERN.test(runId)) throw new Error("WRITER_FENCE_GRANT_INVALID_RUN_ID");
  if (!IDENTIFIER_PATTERN.test(holderId)) throw new Error("WRITER_FENCE_GRANT_INVALID_HOLDER_ID");
  if (proof.length < 32) throw new Error("WRITER_FENCE_GRANT_PROOF_TOO_SHORT");
  if (!WRITER_FENCE_MODES.has(writerFenceMode)) {
    throw new Error("WRITER_FENCE_GRANT_INVALID_MODE");
  }
  if (writerFenceMode === ADOPT_EXISTING_SALES_MODE && !ADOPT_EXISTING_RUN_PATTERN.test(runId)) {
    throw new Error("WRITER_FENCE_GRANT_ADOPT_EXISTING_INVALID_RUN_ID");
  }
  if (writerFenceMode === ADOPT_EXISTING_FULL_LANES_MODE && !ADOPT_EXISTING_RUN_PATTERN.test(runId)) {
    throw new Error("WRITER_FENCE_GRANT_ADOPT_EXISTING_INVALID_RUN_ID");
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
    issuedAt,
    expiresAt,
  };
  const fleetGrant = writerFenceMode === "bootstrap-no-legacy-writer"
    || writerFenceMode === ADOPT_EXISTING_SALES_MODE
    || writerFenceMode === ADOPT_EXISTING_FULL_LANES_MODE
    || String(environment.CANARY_WRITER_FENCE_GRANT_VERSION ?? "") === "3";
  let legacyCredential;
  if (!fleetGrant) {
    const exclusiveCredentialRef = requiredFrom(environment, "CANARY_EXCLUSIVE_CREDENTIAL_REF");
    const credentialVersion = requiredFrom(environment, "CANARY_EXCLUSIVE_CREDENTIAL_VERSION").toLowerCase();
    if (!exclusiveCredentialRef.startsWith("runtime-vault://postgres/")) {
      throw new Error("WRITER_FENCE_GRANT_EXCLUSIVE_CREDENTIAL_REF_REQUIRED");
    }
    if (!SHA256_PATTERN.test(credentialVersion)) {
      throw new Error("WRITER_FENCE_GRANT_INVALID_CREDENTIAL_VERSION");
    }
    legacyCredential = {
      exclusiveCredentialRef,
      credentialVersion,
      credentialBinding: sha256([
        "winerim-writer-fence-credential",
        "1",
        exclusiveCredentialRef,
        credentialVersion,
      ].join("|")),
    };
  }
  const credentialBundle = fleetGrant
    ? prepareFleetCredentialBundle({ environment, connectionId, runId, holderId, proof, issuedAt, expiresAt })
    : null;
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
      version: fleetGrant ? 3 : 1,
      ...common,
      ...(credentialBundle ? { credentialBundle } : legacyCredential),
      legacyWriter: { revokedAt, negativeProbeStatus, evidenceSha256 },
    };
  } else if (writerFenceMode === "bootstrap-no-legacy-writer") {
    const job = requiredFrom(environment, "CANARY_RUNTIME_JOB");
    const lane = requiredFrom(environment, "CANARY_RUNTIME_LANE");
    const productId = requiredFrom(environment, "CANARY_CATALOG_PRODUCT_ID");
    if (
      job !== "catalog.sync-master"
      || lane !== "catalog"
      || !/^\d+$/.test(productId)
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
      credentialBundle,
      writerHistory: {
        mode: "bootstrap-no-legacy-writer",
        verifiedAt: externalEvidence.observedAt,
        evidenceSha256: externalEvidence.artifactSha256,
        cloudflareEvidenceSha256: externalEvidence.payloadSha256,
        absence: bootstrapAbsence(environment),
        externalEvidence,
      },
    };
  } else {
    const externalEvidence = readExternalBootstrapWriterFenceEvidence({
      environment,
      connectionId,
      referenceTime: issuedAt,
      requireActivationEnvelope: true,
    });
    if (
      externalEvidence.fenceMode !== "lovable-disabled-no-agora-rotation"
      || externalEvidence.readbackObservedAt.length !== 2
    ) {
      throw new Error("WRITER_FENCE_GRANT_ADOPT_EXISTING_REQUIRES_NO_ROTATION_EVIDENCE");
    }
    adoptExistingAbsence(environment);
    if (!ADOPT_EXISTING_KEY_VERSION_PATTERN.test(credentialBundle.keyVersion)) {
      throw new Error("WRITER_FENCE_GRANT_ADOPT_EXISTING_INVALID_KEY_VERSION");
    }
    const internalEvidenceSha256 = requiredSha256(
      environment,
      "CANARY_WRITER_FENCE_EVIDENCE_SHA256",
    );
    const sourcePassSha256 = requiredSha256(
      environment,
      "CANARY_WRITER_FENCE_SOURCE_PASS_SHA256",
    );
    const internalVerifiedAt = new Date(timestamp(
      requiredFrom(environment, "CANARY_WRITER_FENCE_VERIFIED_AT"),
      "CANARY_WRITER_FENCE_VERIFIED_AT",
    )).toISOString();
    if (internalVerifiedAt !== externalEvidence.observedAt) {
      throw new Error("WRITER_FENCE_GRANT_ADOPT_EXISTING_EVIDENCE_TIME_MISMATCH");
    }
    const runtimePolicy = adoptExistingRuntimePolicy(environment, writerFenceMode);
    grant = {
      version: 3,
      grantType: "adopt-existing-sales",
      ...common,
      credentialBundle,
      writerHistory: {
        mode: "adopt-existing-sales",
        verifiedAt: internalVerifiedAt,
        evidenceSha256: internalEvidenceSha256,
        cloudflareEvidenceSha256: sourcePassSha256,
        externalEvidence,
      },
      activationScope: prepareAdoptExistingActivationScope({
        environment,
        connectionId,
        runId,
        holderId,
        proof,
        issuedAt,
        expiresAt,
        externalEvidence,
        runtimePolicy,
      }),
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
