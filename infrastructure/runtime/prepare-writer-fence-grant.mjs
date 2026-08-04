import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const WRITER_FENCE_MODES = new Set(["legacy-writer-revoked", "bootstrap-no-legacy-writer"]);

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

function explicitZero(name) {
  const value = required(name);
  if (value !== "0") throw new Error(`WRITER_FENCE_GRANT_${name}_MUST_BE_ZERO`);
  return 0;
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
  const writerFenceMode = String(
    process.env.WRITER_FENCE_MODE ?? "legacy-writer-revoked",
  ).trim();
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
    const revokedAt = required("LEGACY_WRITER_REVOKED_AT");
    const negativeProbeStatus = Number(required("LEGACY_WRITER_NEGATIVE_PROBE_STATUS"));
    const evidenceSha256 = required("LEGACY_WRITER_EVIDENCE_SHA256");
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
    const job = required("CANARY_RUNTIME_JOB");
    const lane = required("CANARY_RUNTIME_LANE");
    const productId = required("CANARY_CATALOG_PRODUCT_ID");
    if (
      job !== "catalog.sync-master"
      || lane !== "catalog"
      || !/^\d+$/.test(productId)
      || exclusiveCredentialRef !== expectedCredentialRef
    ) {
      throw new Error("WRITER_FENCE_GRANT_BOOTSTRAP_CATALOG_AGORA_SCOPE_REQUIRED");
    }
    const verifiedAt = required("NO_LEGACY_WRITER_VERIFIED_AT");
    const evidenceSha256 = required("NO_LEGACY_WRITER_EVIDENCE_SHA256");
    const cloudflareEvidenceSha256 = required("NO_LEGACY_WRITER_CLOUDFLARE_EVIDENCE_SHA256");
    if (!SHA256_PATTERN.test(evidenceSha256) || !SHA256_PATTERN.test(cloudflareEvidenceSha256)) {
      throw new Error("WRITER_FENCE_GRANT_INVALID_BOOTSTRAP_EVIDENCE_SHA256");
    }
    const verifiedMs = timestamp(verifiedAt, "NO_LEGACY_WRITER_VERIFIED_AT");
    if (verifiedMs > issuedMs || issuedMs - verifiedMs > 15 * 60 * 1_000) {
      throw new Error("WRITER_FENCE_GRANT_BOOTSTRAP_EVIDENCE_MUST_BE_FRESH");
    }
    const absence = {
      activeConnectionCount: explicitZero("NO_LEGACY_WRITER_ACTIVE_CONNECTION_COUNT"),
      activeCredentialCount: explicitZero("NO_LEGACY_WRITER_ACTIVE_CREDENTIAL_COUNT"),
      activeScopeCount: explicitZero("NO_LEGACY_WRITER_ACTIVE_SCOPE_COUNT"),
      priorRunCount: explicitZero("NO_LEGACY_WRITER_PRIOR_RUN_COUNT"),
      activeProducerCount: explicitZero("NO_LEGACY_WRITER_ACTIVE_PRODUCER_COUNT"),
      activeConsumerCount: explicitZero("NO_LEGACY_WRITER_ACTIVE_CONSUMER_COUNT"),
    };
    grant = {
      version: 2,
      ...common,
      writerHistory: {
        mode: "bootstrap-no-legacy-writer",
        verifiedAt,
        evidenceSha256,
        cloudflareEvidenceSha256,
        absence,
      },
    };
  }
  const target = outputPath();
  const source = `${JSON.stringify(grant, null, 2)}\n`;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, source, { mode: 0o600 });
  chmodSync(target, 0o600);
  const grantSha256 = createHash("sha256").update(source).digest("hex");
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
