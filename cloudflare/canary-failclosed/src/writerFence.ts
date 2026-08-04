const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const MIN_LEASE_TTL_SECONDS = 30;
const MAX_LEASE_TTL_SECONDS = 120;
const LEASE_RESPONSE_CLOCK_SKEW_MS = 5_000;
const MUTATION_LEASE_MIN_REMAINING_MS = 15_000;
const MAX_BOOTSTRAP_EVIDENCE_AGE_MS = 15 * 60 * 1_000;

export type SecretsStoreSecretLike = {
  get(): Promise<string>;
};

export type WriterFenceServiceLike = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type WriterFenceClientEnvironment = {
  WRITER_FENCE?: WriterFenceServiceLike;
  CANARY_WRITER_FENCE_PROOF?: SecretsStoreSecretLike;
  CANARY_WRITER_FENCE_GRANT?: SecretsStoreSecretLike;
};

export type WriterFenceCredentialKind = "agora" | "winerim";

export type WriterFenceFleetCredential = Readonly<{
  kind: WriterFenceCredentialKind;
  reference: string;
  version: string;
  attestationSha256: string;
  binding: string;
}>;

export type WriterFenceCredentialBundleV1 = Readonly<{
  version: 1;
  keyVersion: string;
  generationSha256: string;
  bundleSha256: string;
  signatureSha256: string;
  credentials: Readonly<{
    agora: WriterFenceFleetCredential;
    winerim: WriterFenceFleetCredential;
  }>;
}>;

export type WriterFenceGrantV1 = {
  version: 1;
  connectionId: string;
  runId: string;
  holderId: string;
  proofSha256: string;
  exclusiveCredentialRef: string;
  credentialVersion: string;
  credentialBinding: string;
  legacyWriter: {
    revokedAt: string;
    negativeProbeStatus: 401 | 403;
    evidenceSha256: string;
  };
  issuedAt: string;
  expiresAt: string;
};

export type WriterFenceGrantV2 = {
  version: 2;
  connectionId: string;
  runId: string;
  holderId: string;
  proofSha256: string;
  exclusiveCredentialRef: string;
  credentialVersion: string;
  credentialBinding: string;
  writerHistory: {
    mode: "bootstrap-no-legacy-writer";
    verifiedAt: string;
    evidenceSha256: string;
    cloudflareEvidenceSha256: string;
    absence: {
      activeConnectionCount: 0;
      activeCredentialCount: 0;
      activeScopeCount: 0;
      priorRunCount: 0;
      activeProducerCount: 0;
      activeConsumerCount: 0;
    };
  };
  issuedAt: string;
  expiresAt: string;
};

export type WriterFenceGrantV3 = {
  version: 3;
  connectionId: string;
  runId: string;
  holderId: string;
  proofSha256: string;
  exclusiveCredentialRef?: never;
  credentialVersion?: never;
  credentialBinding?: never;
  credentialBundle: WriterFenceCredentialBundleV1;
  legacyWriter?: WriterFenceGrantV1["legacyWriter"];
  writerHistory?: WriterFenceGrantV2["writerHistory"];
  issuedAt: string;
  expiresAt: string;
};

export type WriterFenceGrant = WriterFenceGrantV1 | WriterFenceGrantV2 | WriterFenceGrantV3;

type WriterFenceGrantCandidate = Partial<Omit<WriterFenceGrantV1, "version" | "legacyWriter">> & {
  version?: unknown;
  legacyWriter?: WriterFenceGrantV1["legacyWriter"];
  writerHistory?: WriterFenceGrantV2["writerHistory"];
  credentialBundle?: WriterFenceCredentialBundleV1;
};

export type WriterFenceLease = {
  connectionId: string;
  runId: string;
  holderId: string;
  fencingToken: number;
  credentialReference: string;
  credentialVersion: string;
  credentialBinding: string;
  credentialKind?: WriterFenceCredentialKind;
  credentialAttestationSha256?: string;
  credentialBundleSha256?: string;
  requestNonce?: string;
  expiresAt: string;
};

export type WriterFenceCredentialAttestation = Readonly<{
  reference: string;
  version: string;
  connectionId?: string;
  runId?: string;
  provider?: string;
  kind?: WriterFenceCredentialKind;
}>;

export type WriterFenceActiveScopeEvidence = Readonly<{
  connectionId: string;
  runId: string;
  writerFenceGrantSha256: string;
  credentialSetSha256?: string;
}>;

export type WriterFenceMutationAuthorization = Readonly<{
  connectionId: string;
  runId: string;
  holderId: string;
  fencingToken: number;
  credentialReference: string;
  credentialVersion: string;
  credentialBinding: string;
  credentialKind?: WriterFenceCredentialKind;
  credentialAttestationSha256?: string;
  credentialBundleSha256?: string;
  authorizedAt: string;
  expiresAt: string;
}>;

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function writerFenceCredentialBinding(
  credential: WriterFenceCredentialAttestation,
): Promise<string> {
  if (!credential.reference.startsWith("runtime-vault://postgres/")) {
    throw new Error("WRITER_FENCE_CREDENTIAL_REFERENCE_REJECTED");
  }
  if (!SHA256_PATTERN.test(credential.version)) {
    throw new Error("WRITER_FENCE_CREDENTIAL_VERSION_REJECTED");
  }
  return sha256Hex([
    "winerim-writer-fence-credential",
    "1",
    credential.reference,
    credential.version,
  ].join("|"));
}

function fleetCredentialReference(connectionId: string, kind: WriterFenceCredentialKind): string {
  return `runtime-vault://postgres/${connectionId}/agora/${kind}`;
}

function fleetCredentialCandidate(
  credential: WriterFenceCredentialAttestation,
  connectionId: string,
  runId: string,
): Required<Pick<WriterFenceCredentialAttestation, "reference" | "version" | "connectionId" | "runId" | "provider" | "kind">> {
  const kind = credential.kind;
  if (kind !== "agora" && kind !== "winerim") {
    throw new Error("WRITER_FENCE_CREDENTIAL_KIND_REJECTED");
  }
  if (credential.connectionId !== connectionId || credential.runId !== runId) {
    throw new Error("WRITER_FENCE_CREDENTIAL_SCOPE_REJECTED");
  }
  if (credential.provider !== "agora") {
    throw new Error("WRITER_FENCE_CREDENTIAL_PROVIDER_REJECTED");
  }
  if (credential.reference !== fleetCredentialReference(connectionId, kind)) {
    throw new Error("WRITER_FENCE_CREDENTIAL_REFERENCE_REJECTED");
  }
  if (!SHA256_PATTERN.test(credential.version)) {
    throw new Error("WRITER_FENCE_CREDENTIAL_VERSION_REJECTED");
  }
  return {
    reference: credential.reference,
    version: credential.version,
    connectionId,
    runId,
    provider: "agora",
    kind,
  };
}

export async function writerFenceFleetCredentialBinding(input: {
  credential: WriterFenceCredentialAttestation;
  connectionId: string;
  runId: string;
}): Promise<string> {
  const credential = fleetCredentialCandidate(input.credential, input.connectionId, input.runId);
  return sha256Hex([
    "winerim-writer-fence-fleet-credential",
    "1",
    credential.connectionId,
    credential.runId,
    credential.provider,
    credential.kind,
    credential.reference,
    credential.version,
  ].join("|"));
}

function credentialBundlePayload(input: {
  connectionId: string;
  runId: string;
  holderId: string;
  issuedAt: string;
  expiresAt: string;
  bundle: Pick<WriterFenceCredentialBundleV1, "version" | "keyVersion" | "generationSha256" | "credentials">;
}): string {
  const { agora, winerim } = input.bundle.credentials;
  return [
    "winerim-writer-fence-credential-bundle",
    String(input.bundle.version),
    input.connectionId,
    input.runId,
    input.holderId,
    input.issuedAt,
    input.expiresAt,
    input.bundle.keyVersion,
    input.bundle.generationSha256,
    agora.kind,
    agora.reference,
    agora.version,
    agora.attestationSha256,
    agora.binding,
    winerim.kind,
    winerim.reference,
    winerim.version,
    winerim.attestationSha256,
    winerim.binding,
  ].join("|");
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function writerFenceCredentialBundleDigests(input: {
  proof: string;
  connectionId: string;
  runId: string;
  holderId: string;
  issuedAt: string;
  expiresAt: string;
  bundle: Pick<WriterFenceCredentialBundleV1, "version" | "keyVersion" | "generationSha256" | "credentials">;
}): Promise<Readonly<{ bundleSha256: string; signatureSha256: string }>> {
  if (input.proof.length < 32) throw new Error("WRITER_FENCE_EXCLUSIVE_PROOF_TOO_SHORT");
  const payload = credentialBundlePayload(input);
  return Object.freeze({
    bundleSha256: await sha256Hex(payload),
    signatureSha256: await hmacSha256Hex(input.proof, payload),
  });
}

export async function authorizeWriterFenceMutation(input: {
  lease: WriterFenceLease;
  credential: WriterFenceCredentialAttestation;
  nowMs?: number;
  minimumRemainingMs?: number;
}): Promise<WriterFenceMutationAuthorization> {
  const nowMs = input.nowMs ?? Date.now();
  const minimumRemainingMs = input.minimumRemainingMs ?? MUTATION_LEASE_MIN_REMAINING_MS;
  if (!Number.isFinite(minimumRemainingMs) || minimumRemainingMs < 0) {
    throw new Error("WRITER_FENCE_MINIMUM_REMAINING_INVALID");
  }
  const fleetLease = input.lease.credentialKind !== undefined;
  const credentialBinding = fleetLease
    ? await writerFenceFleetCredentialBinding({
      credential: input.credential,
      connectionId: input.lease.connectionId,
      runId: input.lease.runId,
    })
    : await writerFenceCredentialBinding(input.credential);
  if (fleetLease && input.lease.credentialKind !== input.credential.kind) {
    throw new Error("WRITER_FENCE_CREDENTIAL_KIND_DRIFT");
  }
  if (input.lease.credentialReference !== input.credential.reference) {
    throw new Error("WRITER_FENCE_CREDENTIAL_REFERENCE_DRIFT");
  }
  if (input.lease.credentialVersion !== input.credential.version) {
    throw new Error("WRITER_FENCE_CREDENTIAL_VERSION_DRIFT");
  }
  if (input.lease.credentialBinding !== credentialBinding) {
    throw new Error("WRITER_FENCE_CREDENTIAL_BINDING_DRIFT");
  }
  if (fleetLease) {
    if (
      input.lease.credentialAttestationSha256 !== input.credential.version
      || !SHA256_PATTERN.test(String(input.lease.credentialBundleSha256 ?? ""))
    ) {
      throw new Error("WRITER_FENCE_CREDENTIAL_ATTESTATION_DRIFT");
    }
  }
  const expiresAtMs = timestamp(input.lease.expiresAt, "WRITER_FENCE_LEASE_EXPIRES_AT_REJECTED");
  if (expiresAtMs - nowMs < minimumRemainingMs) {
    throw new Error("WRITER_FENCE_LEASE_TOO_CLOSE_TO_EXPIRY");
  }
  if (!Number.isInteger(input.lease.fencingToken) || input.lease.fencingToken <= 0) {
    throw new Error("WRITER_FENCE_TOKEN_REJECTED");
  }
  return Object.freeze({
    connectionId: input.lease.connectionId,
    runId: input.lease.runId,
    holderId: input.lease.holderId,
    fencingToken: input.lease.fencingToken,
    credentialReference: input.credential.reference,
    credentialVersion: input.credential.version,
    credentialBinding,
    ...(fleetLease ? {
      credentialKind: input.lease.credentialKind,
      credentialAttestationSha256: input.lease.credentialAttestationSha256,
      credentialBundleSha256: input.lease.credentialBundleSha256,
    } : {}),
    authorizedAt: new Date(nowMs).toISOString(),
    expiresAt: input.lease.expiresAt,
  });
}

function timestamp(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

function validateCommonGrantFields(grant: WriterFenceGrantCandidate): void {
  if (!UUID_PATTERN.test(String(grant.connectionId ?? ""))) {
    throw new Error("WRITER_FENCE_GRANT_CONNECTION_REJECTED");
  }
  if (!IDENTIFIER_PATTERN.test(String(grant.runId ?? ""))) {
    throw new Error("WRITER_FENCE_GRANT_RUN_REJECTED");
  }
  if (!IDENTIFIER_PATTERN.test(String(grant.holderId ?? ""))) {
    throw new Error("WRITER_FENCE_GRANT_HOLDER_REJECTED");
  }
  if (!SHA256_PATTERN.test(String(grant.proofSha256 ?? ""))) {
    throw new Error("WRITER_FENCE_GRANT_PROOF_REJECTED");
  }
  timestamp(String(grant.issuedAt ?? ""), "WRITER_FENCE_GRANT_ISSUED_AT_REJECTED");
  timestamp(String(grant.expiresAt ?? ""), "WRITER_FENCE_GRANT_EXPIRES_AT_REJECTED");
}

function validateLegacyGrantCredentialFields(grant: WriterFenceGrantCandidate): void {
  if (!String(grant.exclusiveCredentialRef ?? "").startsWith("runtime-vault://postgres/")) {
    throw new Error("WRITER_FENCE_GRANT_EXCLUSIVE_CREDENTIAL_REQUIRED");
  }
  if (!SHA256_PATTERN.test(String(grant.credentialVersion ?? ""))) {
    throw new Error("WRITER_FENCE_GRANT_CREDENTIAL_VERSION_REJECTED");
  }
  if (!SHA256_PATTERN.test(String(grant.credentialBinding ?? ""))) {
    throw new Error("WRITER_FENCE_GRANT_CREDENTIAL_BINDING_REJECTED");
  }
}

function validateLegacyWriterEvidence(legacyWriter: WriterFenceGrantV1["legacyWriter"] | undefined): void {
  if (!legacyWriter || ![401, 403].includes(legacyWriter.negativeProbeStatus ?? 0)) {
    throw new Error("WRITER_FENCE_GRANT_LEGACY_NEGATIVE_PROBE_REQUIRED");
  }
  if (!SHA256_PATTERN.test(String(legacyWriter.evidenceSha256 ?? ""))) {
    throw new Error("WRITER_FENCE_GRANT_LEGACY_EVIDENCE_REJECTED");
  }
  timestamp(String(legacyWriter.revokedAt ?? ""), "WRITER_FENCE_GRANT_REVOKED_AT_REJECTED");
}

function validateBootstrapHistory(history: WriterFenceGrantV2["writerHistory"] | undefined): void {
  if (history?.mode !== "bootstrap-no-legacy-writer") {
    throw new Error("WRITER_FENCE_GRANT_BOOTSTRAP_MODE_REQUIRED");
  }
  if (
    !SHA256_PATTERN.test(String(history.evidenceSha256 ?? ""))
    || !SHA256_PATTERN.test(String(history.cloudflareEvidenceSha256 ?? ""))
  ) {
    throw new Error("WRITER_FENCE_GRANT_BOOTSTRAP_EVIDENCE_REJECTED");
  }
  timestamp(String(history.verifiedAt ?? ""), "WRITER_FENCE_GRANT_BOOTSTRAP_VERIFIED_AT_REJECTED");
  const absence = history.absence;
  if (
    !absence
    || absence.activeConnectionCount !== 0
    || absence.activeCredentialCount !== 0
    || absence.activeScopeCount !== 0
    || absence.priorRunCount !== 0
    || absence.activeProducerCount !== 0
    || absence.activeConsumerCount !== 0
  ) {
    throw new Error("WRITER_FENCE_GRANT_BOOTSTRAP_ABSENCE_REQUIRED");
  }
}

function validateFleetCredential(
  credential: WriterFenceFleetCredential | undefined,
  connectionId: string,
  runId: string,
  kind: WriterFenceCredentialKind,
): void {
  if (!credential || credential.kind !== kind) {
    throw new Error("WRITER_FENCE_GRANT_FLEET_CREDENTIAL_KIND_REJECTED");
  }
  if (credential.reference !== fleetCredentialReference(connectionId, kind)) {
    throw new Error("WRITER_FENCE_GRANT_FLEET_CREDENTIAL_REFERENCE_REJECTED");
  }
  if (
    !SHA256_PATTERN.test(credential.version)
    || credential.attestationSha256 !== credential.version
    || !SHA256_PATTERN.test(credential.binding)
  ) {
    throw new Error("WRITER_FENCE_GRANT_FLEET_CREDENTIAL_ATTESTATION_REJECTED");
  }
  void runId;
}

export function parseWriterFenceGrant(raw: string): WriterFenceGrant {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error("WRITER_FENCE_GRANT_INVALID_JSON");
  }
  if (!candidate || typeof candidate !== "object") {
    throw new Error("WRITER_FENCE_GRANT_INVALID_OBJECT");
  }
  const grant = candidate as WriterFenceGrantCandidate;
  if (grant.version !== 1 && grant.version !== 2 && grant.version !== 3) {
    throw new Error("WRITER_FENCE_GRANT_VERSION_REJECTED");
  }
  validateCommonGrantFields(grant);
  if (grant.version === 1) {
    validateLegacyGrantCredentialFields(grant);
    validateLegacyWriterEvidence(grant.legacyWriter);
    return grant as WriterFenceGrantV1;
  }
  if (grant.version === 3) {
    if (
      Object.prototype.hasOwnProperty.call(grant, "exclusiveCredentialRef")
      || Object.prototype.hasOwnProperty.call(grant, "credentialVersion")
      || Object.prototype.hasOwnProperty.call(grant, "credentialBinding")
    ) {
      throw new Error("WRITER_FENCE_GRANT_FLEET_SINGLE_CREDENTIAL_FORBIDDEN");
    }
    if (!grant.credentialBundle || grant.credentialBundle.version !== 1) {
      throw new Error("WRITER_FENCE_GRANT_FLEET_BUNDLE_REQUIRED");
    }
    const bundle = grant.credentialBundle;
    if (
      !IDENTIFIER_PATTERN.test(String(bundle.keyVersion ?? ""))
      || !SHA256_PATTERN.test(String(bundle.generationSha256 ?? ""))
      || !SHA256_PATTERN.test(String(bundle.bundleSha256 ?? ""))
      || !SHA256_PATTERN.test(String(bundle.signatureSha256 ?? ""))
    ) {
      throw new Error("WRITER_FENCE_GRANT_FLEET_BUNDLE_REJECTED");
    }
    validateFleetCredential(bundle.credentials?.agora, String(grant.connectionId), String(grant.runId), "agora");
    validateFleetCredential(bundle.credentials?.winerim, String(grant.connectionId), String(grant.runId), "winerim");
    const hasLegacy = Object.prototype.hasOwnProperty.call(grant, "legacyWriter");
    const hasBootstrap = Object.prototype.hasOwnProperty.call(grant, "writerHistory");
    if (hasLegacy === hasBootstrap) {
      throw new Error("WRITER_FENCE_GRANT_FLEET_WRITER_HISTORY_AMBIGUOUS");
    }
    if (hasLegacy) validateLegacyWriterEvidence(grant.legacyWriter);
    else validateBootstrapHistory(grant.writerHistory);
    return grant as WriterFenceGrantV3;
  }
  validateLegacyGrantCredentialFields(grant);
  if (Object.prototype.hasOwnProperty.call(grant, "legacyWriter")) {
    throw new Error("WRITER_FENCE_GRANT_BOOTSTRAP_LEGACY_EVIDENCE_FORBIDDEN");
  }
  const history = grant.writerHistory;
  validateBootstrapHistory(history);
  const expectedCredentialRef = `runtime-vault://postgres/${grant.connectionId}/agora/agora`;
  if (grant.exclusiveCredentialRef !== expectedCredentialRef) {
    throw new Error("WRITER_FENCE_GRANT_BOOTSTRAP_AGORA_CREDENTIAL_REQUIRED");
  }
  return grant as WriterFenceGrantV2;
}

export async function validateWriterFenceGrant(input: {
  grant: WriterFenceGrant;
  proof: string;
  connectionId: string;
  runId: string;
  holderId: string;
  nowMs?: number;
}): Promise<void> {
  const { grant } = input;
  const nowMs = input.nowMs ?? Date.now();
  if (grant.connectionId !== input.connectionId) throw new Error("WRITER_FENCE_CONNECTION_MISMATCH");
  if (grant.runId !== input.runId) throw new Error("WRITER_FENCE_RUN_MISMATCH");
  if (grant.holderId !== input.holderId) throw new Error("WRITER_FENCE_HOLDER_MISMATCH");
  if (input.proof.length < 32) throw new Error("WRITER_FENCE_EXCLUSIVE_PROOF_TOO_SHORT");
  if (await sha256Hex(input.proof) !== grant.proofSha256) {
    throw new Error("WRITER_FENCE_EXCLUSIVE_PROOF_MISMATCH");
  }
  if (grant.version === 3) {
    for (const kind of ["agora", "winerim"] as const) {
      const credential = grant.credentialBundle.credentials[kind];
      if (await writerFenceFleetCredentialBinding({
        credential: {
          reference: credential.reference,
          version: credential.version,
          connectionId: grant.connectionId,
          runId: grant.runId,
          provider: "agora",
          kind,
        },
        connectionId: grant.connectionId,
        runId: grant.runId,
      }) !== credential.binding) {
        throw new Error("WRITER_FENCE_GRANT_CREDENTIAL_BINDING_MISMATCH");
      }
    }
    const expectedGeneration = await sha256Hex([
      "winerim-runtime-credential-set",
      "1",
      grant.connectionId,
      grant.runId,
      grant.credentialBundle.keyVersion,
      grant.credentialBundle.credentials.agora.attestationSha256,
      grant.credentialBundle.credentials.winerim.attestationSha256,
    ].join("|"));
    if (expectedGeneration !== grant.credentialBundle.generationSha256) {
      throw new Error("WRITER_FENCE_GRANT_FLEET_GENERATION_MISMATCH");
    }
    const expectedDigests = await writerFenceCredentialBundleDigests({
      proof: input.proof,
      connectionId: grant.connectionId,
      runId: grant.runId,
      holderId: grant.holderId,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      bundle: grant.credentialBundle,
    });
    if (
      expectedDigests.bundleSha256 !== grant.credentialBundle.bundleSha256
      || expectedDigests.signatureSha256 !== grant.credentialBundle.signatureSha256
    ) {
      throw new Error("WRITER_FENCE_GRANT_FLEET_SIGNATURE_MISMATCH");
    }
  } else if (await writerFenceCredentialBinding({
    reference: grant.exclusiveCredentialRef,
    version: grant.credentialVersion,
  }) !== grant.credentialBinding) {
    throw new Error("WRITER_FENCE_GRANT_CREDENTIAL_BINDING_MISMATCH");
  }

  const issuedAt = timestamp(grant.issuedAt, "WRITER_FENCE_GRANT_ISSUED_AT_REJECTED");
  const expiresAt = timestamp(grant.expiresAt, "WRITER_FENCE_GRANT_EXPIRES_AT_REJECTED");
  if (issuedAt > nowMs + 30_000) throw new Error("WRITER_FENCE_GRANT_NOT_YET_VALID");
  if (expiresAt <= issuedAt) throw new Error("WRITER_FENCE_GRANT_WINDOW_INVALID");
  if (expiresAt <= nowMs) throw new Error("WRITER_FENCE_GRANT_EXPIRED");
  if (expiresAt - issuedAt > 2 * 60 * 60 * 1_000) throw new Error("WRITER_FENCE_GRANT_WINDOW_TOO_WIDE");
  if (grant.version === 1 || (grant.version === 3 && grant.legacyWriter)) {
    const revokedAt = timestamp(grant.legacyWriter!.revokedAt, "WRITER_FENCE_GRANT_REVOKED_AT_REJECTED");
    if (revokedAt > issuedAt || revokedAt > nowMs) {
      throw new Error("WRITER_FENCE_LEGACY_REVOKE_ORDER_INVALID");
    }
    return;
  }
  const writerHistory = grant.writerHistory!;
  const verifiedAt = timestamp(
    writerHistory.verifiedAt,
    "WRITER_FENCE_GRANT_BOOTSTRAP_VERIFIED_AT_REJECTED",
  );
  if (verifiedAt > issuedAt || verifiedAt > nowMs) {
    throw new Error("WRITER_FENCE_BOOTSTRAP_EVIDENCE_ORDER_INVALID");
  }
  if (issuedAt - verifiedAt > MAX_BOOTSTRAP_EVIDENCE_AGE_MS) {
    throw new Error("WRITER_FENCE_BOOTSTRAP_EVIDENCE_STALE");
  }
}

export async function validateActiveWriterFenceGrant(input: {
  rawGrant: string;
  proof: string;
  evidence: WriterFenceActiveScopeEvidence;
  connectionId: string;
  runId: string;
  holderId: string;
  nowMs?: number;
}): Promise<WriterFenceGrant> {
  if (
    input.evidence.connectionId !== input.connectionId
    || input.evidence.runId !== input.runId
  ) {
    throw new Error("WRITER_FENCE_ACTIVE_SCOPE_MISMATCH");
  }
  if (!SHA256_PATTERN.test(input.evidence.writerFenceGrantSha256)) {
    throw new Error("WRITER_FENCE_ACTIVE_GRANT_EVIDENCE_REJECTED");
  }
  if (await sha256Hex(input.rawGrant) !== input.evidence.writerFenceGrantSha256) {
    throw new Error("WRITER_FENCE_ACTIVE_GRANT_MISMATCH");
  }

  const grant = parseWriterFenceGrant(input.rawGrant);
  await validateWriterFenceGrant({
    grant,
    proof: input.proof,
    connectionId: input.connectionId,
    runId: input.runId,
    holderId: input.holderId,
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
  });
  if (grant.version === 3) {
    if (
      !SHA256_PATTERN.test(String(input.evidence.credentialSetSha256 ?? ""))
      || input.evidence.credentialSetSha256 !== grant.credentialBundle.generationSha256
    ) {
      throw new Error("WRITER_FENCE_ACTIVE_CREDENTIAL_SET_MISMATCH");
    }
  }
  return grant;
}

export async function acquireExclusiveWriterFence(input: {
  env: WriterFenceClientEnvironment;
  connectionId: string;
  runId: string;
  holderId: string;
  credential?: WriterFenceCredentialAttestation;
  ttlSeconds?: number;
}): Promise<WriterFenceLease> {
  if (!input.env.WRITER_FENCE || typeof input.env.WRITER_FENCE.fetch !== "function") {
    throw new Error("WRITER_FENCE_SERVICE_BINDING_MISSING");
  }
  if (!input.env.CANARY_WRITER_FENCE_PROOF || typeof input.env.CANARY_WRITER_FENCE_PROOF.get !== "function") {
    throw new Error("WRITER_FENCE_EXCLUSIVE_CREDENTIAL_BINDING_MISSING");
  }
  const proof = await input.env.CANARY_WRITER_FENCE_PROOF.get();
  if (proof.length < 32) throw new Error("WRITER_FENCE_EXCLUSIVE_PROOF_TOO_SHORT");
  const ttlSeconds = input.ttlSeconds ?? 90;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < MIN_LEASE_TTL_SECONDS || ttlSeconds > MAX_LEASE_TTL_SECONDS) {
    throw new Error("WRITER_FENCE_LEASE_TTL_REJECTED");
  }
  const requestedAt = Date.now();
  const rawGrant = typeof input.env.CANARY_WRITER_FENCE_GRANT?.get === "function"
    ? await input.env.CANARY_WRITER_FENCE_GRANT.get()
    : undefined;
  const parsedGrant = rawGrant === undefined ? undefined : parseWriterFenceGrant(rawGrant);
  if (parsedGrant?.version === 3 && !input.credential) {
    throw new Error("WRITER_FENCE_FLEET_CREDENTIAL_REQUIRED");
  }
  const requestNonce = parsedGrant?.version === 3 ? crypto.randomUUID() : undefined;

  const response = await input.env.WRITER_FENCE.fetch(
    "https://writer-fence.internal/v1/leases/acquire",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-writer-fence-proof": proof,
      },
      body: JSON.stringify({
        connectionId: input.connectionId,
        runId: input.runId,
        holderId: input.holderId,
        ttlSeconds,
        ...(rawGrant === undefined ? {} : { rawGrant }),
        ...(input.credential === undefined ? {} : { credential: input.credential }),
        ...(requestNonce === undefined ? {} : { requestNonce }),
      }),
    },
  );
  if (!response.ok) throw new Error(`WRITER_FENCE_LEASE_DENIED_${response.status}`);
  const lease = await response.json() as Partial<WriterFenceLease>;
  if (
    lease.connectionId !== input.connectionId
    || lease.runId !== input.runId
    || lease.holderId !== input.holderId
    || !Number.isInteger(lease.fencingToken)
    || Number(lease.fencingToken) <= 0
    || Date.parse(String(lease.expiresAt ?? "")) <= Date.now()
    || Date.parse(String(lease.expiresAt ?? "")) > requestedAt + ttlSeconds * 1_000 + LEASE_RESPONSE_CLOCK_SKEW_MS
    || typeof lease.credentialReference !== "string"
    || !lease.credentialReference.startsWith("runtime-vault://postgres/")
    || typeof lease.credentialVersion !== "string"
    || lease.credentialVersion.length === 0
    || typeof lease.credentialBinding !== "string"
    || !SHA256_PATTERN.test(lease.credentialBinding)
  ) {
    throw new Error("WRITER_FENCE_LEASE_RESPONSE_INVALID");
  }
  if (parsedGrant?.version === 3) {
    if (
      lease.credentialKind !== input.credential?.kind
      || lease.credentialAttestationSha256 !== input.credential?.version
      || lease.credentialBundleSha256 !== parsedGrant.credentialBundle.bundleSha256
      || lease.requestNonce !== requestNonce
      || await writerFenceFleetCredentialBinding({
        credential: input.credential!,
        connectionId: input.connectionId,
        runId: input.runId,
      }) !== lease.credentialBinding
    ) {
      throw new Error("WRITER_FENCE_LEASE_FLEET_BINDING_MISMATCH");
    }
  } else if (await writerFenceCredentialBinding({
    reference: lease.credentialReference,
    version: lease.credentialVersion,
  }) !== lease.credentialBinding) {
    throw new Error("WRITER_FENCE_LEASE_CREDENTIAL_BINDING_MISMATCH");
  }
  return lease as WriterFenceLease;
}
