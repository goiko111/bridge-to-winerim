const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const MIN_LEASE_TTL_SECONDS = 30;
const MAX_LEASE_TTL_SECONDS = 120;
const LEASE_RESPONSE_CLOCK_SKEW_MS = 5_000;
const MUTATION_LEASE_MIN_REMAINING_MS = 15_000;

export type SecretsStoreSecretLike = {
  get(): Promise<string>;
};

export type WriterFenceServiceLike = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type WriterFenceClientEnvironment = {
  WRITER_FENCE?: WriterFenceServiceLike;
  CANARY_WRITER_FENCE_PROOF?: SecretsStoreSecretLike;
};

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

export type WriterFenceLease = {
  connectionId: string;
  runId: string;
  holderId: string;
  fencingToken: number;
  credentialReference: string;
  credentialVersion: string;
  credentialBinding: string;
  expiresAt: string;
};

export type WriterFenceCredentialAttestation = Readonly<{
  reference: string;
  version: string;
}>;

export type WriterFenceMutationAuthorization = Readonly<{
  connectionId: string;
  runId: string;
  holderId: string;
  fencingToken: number;
  credentialReference: string;
  credentialVersion: string;
  credentialBinding: string;
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
  const credentialBinding = await writerFenceCredentialBinding(input.credential);
  if (input.lease.credentialReference !== input.credential.reference) {
    throw new Error("WRITER_FENCE_CREDENTIAL_REFERENCE_DRIFT");
  }
  if (input.lease.credentialVersion !== input.credential.version) {
    throw new Error("WRITER_FENCE_CREDENTIAL_VERSION_DRIFT");
  }
  if (input.lease.credentialBinding !== credentialBinding) {
    throw new Error("WRITER_FENCE_CREDENTIAL_BINDING_DRIFT");
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
    authorizedAt: new Date(nowMs).toISOString(),
    expiresAt: input.lease.expiresAt,
  });
}

function timestamp(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

export function parseWriterFenceGrant(raw: string): WriterFenceGrantV1 {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error("WRITER_FENCE_GRANT_INVALID_JSON");
  }
  if (!candidate || typeof candidate !== "object") {
    throw new Error("WRITER_FENCE_GRANT_INVALID_OBJECT");
  }
  const grant = candidate as Partial<WriterFenceGrantV1>;
  if (grant.version !== 1) throw new Error("WRITER_FENCE_GRANT_VERSION_REJECTED");
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
  if (!String(grant.exclusiveCredentialRef ?? "").startsWith("runtime-vault://postgres/")) {
    throw new Error("WRITER_FENCE_GRANT_EXCLUSIVE_CREDENTIAL_REQUIRED");
  }
  if (!SHA256_PATTERN.test(String(grant.credentialVersion ?? ""))) {
    throw new Error("WRITER_FENCE_GRANT_CREDENTIAL_VERSION_REJECTED");
  }
  if (!SHA256_PATTERN.test(String(grant.credentialBinding ?? ""))) {
    throw new Error("WRITER_FENCE_GRANT_CREDENTIAL_BINDING_REJECTED");
  }
  if (!grant.legacyWriter || ![401, 403].includes(grant.legacyWriter.negativeProbeStatus ?? 0)) {
    throw new Error("WRITER_FENCE_GRANT_LEGACY_NEGATIVE_PROBE_REQUIRED");
  }
  if (!SHA256_PATTERN.test(String(grant.legacyWriter.evidenceSha256 ?? ""))) {
    throw new Error("WRITER_FENCE_GRANT_LEGACY_EVIDENCE_REJECTED");
  }
  timestamp(String(grant.legacyWriter.revokedAt ?? ""), "WRITER_FENCE_GRANT_REVOKED_AT_REJECTED");
  timestamp(String(grant.issuedAt ?? ""), "WRITER_FENCE_GRANT_ISSUED_AT_REJECTED");
  timestamp(String(grant.expiresAt ?? ""), "WRITER_FENCE_GRANT_EXPIRES_AT_REJECTED");
  return grant as WriterFenceGrantV1;
}

export async function validateWriterFenceGrant(input: {
  grant: WriterFenceGrantV1;
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
  if (await writerFenceCredentialBinding({
    reference: grant.exclusiveCredentialRef,
    version: grant.credentialVersion,
  }) !== grant.credentialBinding) {
    throw new Error("WRITER_FENCE_GRANT_CREDENTIAL_BINDING_MISMATCH");
  }

  const issuedAt = timestamp(grant.issuedAt, "WRITER_FENCE_GRANT_ISSUED_AT_REJECTED");
  const expiresAt = timestamp(grant.expiresAt, "WRITER_FENCE_GRANT_EXPIRES_AT_REJECTED");
  const revokedAt = timestamp(grant.legacyWriter.revokedAt, "WRITER_FENCE_GRANT_REVOKED_AT_REJECTED");
  if (issuedAt > nowMs + 30_000) throw new Error("WRITER_FENCE_GRANT_NOT_YET_VALID");
  if (expiresAt <= issuedAt) throw new Error("WRITER_FENCE_GRANT_WINDOW_INVALID");
  if (expiresAt <= nowMs) throw new Error("WRITER_FENCE_GRANT_EXPIRED");
  if (expiresAt - issuedAt > 2 * 60 * 60 * 1_000) throw new Error("WRITER_FENCE_GRANT_WINDOW_TOO_WIDE");
  if (revokedAt > issuedAt || revokedAt > nowMs) throw new Error("WRITER_FENCE_LEGACY_REVOKE_ORDER_INVALID");
}

export async function acquireExclusiveWriterFence(input: {
  env: WriterFenceClientEnvironment;
  connectionId: string;
  runId: string;
  holderId: string;
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
  if (await writerFenceCredentialBinding({
    reference: lease.credentialReference,
    version: lease.credentialVersion,
  }) !== lease.credentialBinding) {
    throw new Error("WRITER_FENCE_LEASE_CREDENTIAL_BINDING_MISMATCH");
  }
  return lease as WriterFenceLease;
}
