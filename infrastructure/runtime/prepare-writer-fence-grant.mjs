import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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

function outputPath() {
  const argument = process.argv.find((value) => value.startsWith("--output="));
  if (!argument) throw new Error("USAGE: prepare-writer-fence-grant.mjs --output=/secure/path/grant.json");
  return resolve(argument.slice("--output=".length));
}

function main() {
  const connectionId = required("CANARY_CONNECTION_ID");
  const runId = required("CANARY_RUN_ID");
  const holderId = required("CANARY_HOLDER_ID");
  const proof = required("CANARY_WRITER_FENCE_PROOF");
  const exclusiveCredentialRef = required("CANARY_EXCLUSIVE_CREDENTIAL_REF");
  const credentialVersion = required("CANARY_EXCLUSIVE_CREDENTIAL_VERSION");
  const revokedAt = required("LEGACY_WRITER_REVOKED_AT");
  const negativeProbeStatus = Number(required("LEGACY_WRITER_NEGATIVE_PROBE_STATUS"));
  const evidenceSha256 = required("LEGACY_WRITER_EVIDENCE_SHA256");
  const issuedAt = process.env.CANARY_FENCE_ISSUED_AT ?? new Date().toISOString();
  const expiresAt = required("CANARY_FENCE_EXPIRES_AT");

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
  if (![401, 403].includes(negativeProbeStatus)) {
    throw new Error("WRITER_FENCE_GRANT_LEGACY_WRITER_MUST_RETURN_401_OR_403");
  }
  if (!SHA256_PATTERN.test(evidenceSha256)) {
    throw new Error("WRITER_FENCE_GRANT_INVALID_LEGACY_EVIDENCE_SHA256");
  }

  const revokedMs = timestamp(revokedAt, "LEGACY_WRITER_REVOKED_AT");
  const issuedMs = timestamp(issuedAt, "CANARY_FENCE_ISSUED_AT");
  const expiresMs = timestamp(expiresAt, "CANARY_FENCE_EXPIRES_AT");
  if (revokedMs > issuedMs) throw new Error("WRITER_FENCE_GRANT_REVOKE_AFTER_ISSUE");
  if (expiresMs <= issuedMs || expiresMs - issuedMs > 2 * 60 * 60 * 1_000) {
    throw new Error("WRITER_FENCE_GRANT_EXPIRY_MUST_BE_WITHIN_TWO_HOURS");
  }

  const grant = {
    version: 1,
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
    legacyWriter: { revokedAt, negativeProbeStatus, evidenceSha256 },
    issuedAt,
    expiresAt,
  };
  const target = outputPath();
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, `${JSON.stringify(grant, null, 2)}\n`, { mode: 0o600 });
  chmodSync(target, 0o600);
  const grantSha256 = createHash("sha256").update(JSON.stringify(grant)).digest("hex");
  process.stdout.write(
    `WRITER_FENCE_GRANT_READY path=${target} connection=${connectionId} run=${runId} sha256=${grantSha256}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
