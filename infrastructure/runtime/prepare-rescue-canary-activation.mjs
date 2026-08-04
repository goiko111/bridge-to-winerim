import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readExternalBootstrapWriterFenceEvidence } from "./prepare-writer-fence-grant.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RESOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const MAX_WINDOW_MS = 2 * 60 * 60 * 1_000;
const MIN_LEGACY_WRITER_DRAIN_MS = 130 * 1_000;
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");
const DEPLOYMENT_CONFIG_KEYS = Object.freeze(["consumer", "executor", "fence", "observer"]);
const WRITER_FENCE_MODES = new Set(["legacy-writer-revoked", "bootstrap-no-legacy-writer"]);
const DEPLOYMENT_POLICIES = Object.freeze({
  "winerim.sales-import-live": Object.freeze({
    lane: "sales-import",
    exclusiveWriterCredentialKind: "winerim",
    agoraCredentialMode: "shared-read-only",
    agoraCatalogApply: false,
    winerimMutation: true,
  }),
  "catalog.sync-master": Object.freeze({
    lane: "catalog",
    exclusiveWriterCredentialKind: "agora",
    agoraCredentialMode: "exclusive-writer",
    agoraCatalogApply: true,
    winerimMutation: false,
  }),
});

function required(environment, name) {
  const value = String(environment[name] ?? "").trim();
  if (!value) throw new Error(`RESCUE_CANARY_ACTIVATION_MISSING_${name}`);
  return value;
}

function parseTimestamp(value, name) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`RESCUE_CANARY_ACTIVATION_INVALID_${name}`);
  return { milliseconds: parsed, iso: new Date(parsed).toISOString() };
}

function readBoundJson({ path, expectedSha256, label }) {
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new Error(`RESCUE_CANARY_ACTIVATION_INVALID_${label}_SHA256`);
  }
  const source = readFileSync(resolve(path), "utf8");
  const actualSha256 = createHash("sha256").update(source).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`RESCUE_CANARY_ACTIVATION_${label}_SHA256_MISMATCH`);
  }
  try {
    return { value: JSON.parse(source), sha256: actualSha256 };
  } catch {
    throw new Error(`RESCUE_CANARY_ACTIVATION_${label}_INVALID_JSON`);
  }
}

function deploymentPolicy(manifest) {
  if (manifest?.version === 3) {
    return {
      job: "winerim.sales-import-live",
      ...DEPLOYMENT_POLICIES["winerim.sales-import-live"],
      productId: null,
      writerFenceMode: "legacy-writer-revoked",
    };
  }
  if (manifest?.version !== 4) return null;
  const job = String(manifest.scopePolicy?.job ?? "");
  const policy = DEPLOYMENT_POLICIES[job];
  if (!policy) return null;
  const productId = manifest.scopePolicy?.productId;
  const writerFenceMode = String(manifest.writerFence?.mode ?? "legacy-writer-revoked");
  if (
    manifest.scopePolicy?.lane !== policy.lane
    || manifest.scopePolicy?.maxOperations !== 1
    || (job === "catalog.sync-master" && !/^\d+$/.test(String(productId ?? "")))
    || (job !== "catalog.sync-master" && productId !== null)
    || !WRITER_FENCE_MODES.has(writerFenceMode)
    || (writerFenceMode === "bootstrap-no-legacy-writer" && job !== "catalog.sync-master")
  ) return null;
  return { job, ...policy, productId, writerFenceMode };
}

function validateDeploymentManifest({
  manifest,
  connectionId,
  runId,
  keyVersion,
  credentialSetSha256,
  deploymentConfigSha256,
  deploymentBundleSha256,
}) {
  const policy = deploymentPolicy(manifest);
  const exclusiveCredentialRef = policy
    ? `runtime-vault://postgres/${connectionId}/agora/${policy.exclusiveWriterCredentialKind}`
    : "";
  if (
    !policy
    || manifest.connectionId !== connectionId
    || manifest.runId !== runId
    || manifest.scopeNote !== `rescue-canary-run:${runId}`
    || manifest.credentialBinding?.keyVersion !== keyVersion
    || manifest.credentialBinding?.credentialSetSha256 !== credentialSetSha256
    || !SHA256_PATTERN.test(manifest.credentialBinding?.exclusiveAttestationSha256 ?? "")
    || !RESOURCE_PATTERN.test(manifest.writerFence?.holderId ?? "")
    || !SHA256_PATTERN.test(manifest.writerFence?.proofSha256 ?? "")
    || manifest.writerFence?.exclusiveCredentialRef !== exclusiveCredentialRef
    || !SHA256_PATTERN.test(manifest.writerFence?.credentialBinding ?? "")
    || manifest.credentialPolicy?.exclusiveWriterCredentialKind !== policy.exclusiveWriterCredentialKind
    || manifest.credentialPolicy?.agoraCredentialMode !== policy.agoraCredentialMode
    || manifest.mutationPolicy?.agoraCatalogApply !== policy.agoraCatalogApply
    || manifest.mutationPolicy?.agoraOutboundMutation !== false
    || manifest.mutationPolicy?.winerimMutation !== policy.winerimMutation
  ) {
    throw new Error("RESCUE_CANARY_ACTIVATION_DEPLOYMENT_MANIFEST_SCOPE_MISMATCH");
  }
  if (DEPLOYMENT_CONFIG_KEYS.some((key) => (
    !SHA256_PATTERN.test(manifest.configSha256?.[key] ?? "")
    || manifest.configSha256[key] !== deploymentConfigSha256?.[key]
  ))) {
    throw new Error("RESCUE_CANARY_ACTIVATION_DEPLOYMENT_CONFIG_SHA256_MISMATCH");
  }
  if (DEPLOYMENT_CONFIG_KEYS.some((key) => (
    !SHA256_PATTERN.test(manifest.bundleSha256?.[key] ?? "")
    || manifest.bundleSha256[key] !== deploymentBundleSha256?.[key]
  ))) {
    throw new Error("RESCUE_CANARY_ACTIVATION_DEPLOYMENT_BUNDLE_SHA256_MISMATCH");
  }
  const queueName = `winerim-rescue-prod-canary-${runId}`;
  const expected = {
    queues: {
      input: queueName,
      dlq: `${queueName}-dlq`,
      alarms: `${queueName}-alarms`,
      observerFailures: `${queueName}-observer-failures`,
    },
    workers: {
      consumer: queueName,
      observer: `winerim-rescue-prod-canary-dlq-observer-${runId}`,
    },
  };
  const resources = manifest.resources;
  if (
    !resources
    || Object.entries(expected.queues).some(([key, value]) => resources.queues?.[key] !== value)
    || Object.entries(expected.workers).some(([key, value]) => resources.workers?.[key] !== value)
  ) {
    throw new Error("RESCUE_CANARY_ACTIVATION_DEPLOYMENT_MANIFEST_RESOURCE_MISMATCH");
  }
  const namedResources = [
    resources.workers.executor,
    resources.workers.fence,
    resources.secrets?.vault,
    resources.secrets?.proof,
    resources.secrets?.grant,
    resources.archiveBucket,
  ];
  if (namedResources.some((value) => !RESOURCE_PATTERN.test(value))) {
    throw new Error("RESCUE_CANARY_ACTIVATION_INVALID_RESOURCE_NAME");
  }
  return {
    exclusiveAttestationSha256: manifest.credentialBinding.exclusiveAttestationSha256,
    writerFence: manifest.writerFence,
    policy,
  };
}

function validateProvisioningManifest({ manifest, connectionId, runId, keyVersion }) {
  if (
    manifest?.version !== 1
    || manifest.connectionId !== connectionId
    || manifest.runId !== runId
    || manifest.keyVersion !== keyVersion
    || manifest.active !== false
    || !new Set(["bootstrap", "rotate"]).has(manifest.mode)
    || !SHA256_PATTERN.test(manifest.sqlSha256 ?? "")
    || !SHA256_PATTERN.test(manifest.credentialSetSha256 ?? "")
    || !SHA256_PATTERN.test(manifest.credentialAttestations?.agora ?? "")
    || !SHA256_PATTERN.test(manifest.credentialAttestations?.winerim ?? "")
  ) {
    throw new Error("RESCUE_CANARY_ACTIVATION_CREDENTIAL_PROVISIONING_MANIFEST_MISMATCH");
  }
  const recomputed = createHash("sha256").update([
    "winerim-runtime-credential-set",
    "1",
    connectionId,
    runId,
    keyVersion,
    manifest.credentialAttestations.agora,
    manifest.credentialAttestations.winerim,
  ].join("|")).digest("hex");
  if (recomputed !== manifest.credentialSetSha256) {
    throw new Error("RESCUE_CANARY_ACTIVATION_CREDENTIAL_SET_SHA256_MISMATCH");
  }
  return {
    attestations: manifest.credentialAttestations,
    credentialSetSha256: manifest.credentialSetSha256,
    mode: manifest.mode,
  };
}

function validateWriterFenceGrant({
  grant,
  connectionId,
  runId,
  expectedAttestation,
  expectedHolderId,
  expectedProofSha256,
  expectedCredentialRef,
  expectedCredentialBinding,
  expectedMode,
  expectedExternalEvidence,
  approvedAt,
  expiresAt,
}) {
  const recomputedCredentialBinding = createHash("sha256").update([
    "winerim-writer-fence-credential",
    "1",
    expectedCredentialRef,
    expectedAttestation,
  ].join("|")).digest("hex");
  const commonMismatch = (
    !grant
    || grant.connectionId !== connectionId
    || grant.runId !== runId
    || grant.holderId !== expectedHolderId
    || grant.proofSha256 !== expectedProofSha256
    || grant.exclusiveCredentialRef !== expectedCredentialRef
    || grant.credentialVersion !== expectedAttestation
    || grant.credentialBinding !== recomputedCredentialBinding
    || expectedCredentialBinding !== recomputedCredentialBinding
  );
  if (commonMismatch) {
    throw new Error("RESCUE_CANARY_ACTIVATION_WRITER_FENCE_GRANT_MISMATCH");
  }
  const issued = parseTimestamp(grant.issuedAt, "WRITER_FENCE_ISSUED_AT");
  const fenceExpiry = parseTimestamp(grant.expiresAt, "WRITER_FENCE_EXPIRES_AT");
  if (approvedAt.milliseconds < issued.milliseconds || expiresAt.milliseconds > fenceExpiry.milliseconds) {
    throw new Error("RESCUE_CANARY_ACTIVATION_WRITER_FENCE_WINDOW_MISMATCH");
  }
  if (expectedMode === "legacy-writer-revoked") {
    if (
      grant.version !== 1
      || ![401, 403].includes(grant.legacyWriter?.negativeProbeStatus)
      || !SHA256_PATTERN.test(grant.legacyWriter?.evidenceSha256 ?? "")
    ) {
      throw new Error("RESCUE_CANARY_ACTIVATION_WRITER_FENCE_GRANT_MISMATCH");
    }
    const revoked = parseTimestamp(grant.legacyWriter.revokedAt, "LEGACY_WRITER_REVOKED_AT");
    if (
      revoked.milliseconds > issued.milliseconds
      || issued.milliseconds < revoked.milliseconds + MIN_LEGACY_WRITER_DRAIN_MS
      || approvedAt.milliseconds < revoked.milliseconds + MIN_LEGACY_WRITER_DRAIN_MS
    ) {
      throw new Error("RESCUE_CANARY_ACTIVATION_WRITER_FENCE_WINDOW_MISMATCH");
    }
    return { mode: expectedMode, evidenceAt: revoked.iso };
  }
  const history = grant.writerHistory;
  if (
    expectedMode !== "bootstrap-no-legacy-writer"
    || grant.version !== 3
    || Object.prototype.hasOwnProperty.call(grant, "legacyWriter")
    || history?.mode !== expectedMode
    || !expectedExternalEvidence
    || JSON.stringify(history.externalEvidence) !== JSON.stringify(expectedExternalEvidence)
    || grant.exclusiveCredentialRef !== `runtime-vault://postgres/${connectionId}/agora/agora`
  ) {
    throw new Error("RESCUE_CANARY_ACTIVATION_WRITER_FENCE_GRANT_MISMATCH");
  }
  const verified = parseTimestamp(history.verifiedAt, "NO_LEGACY_WRITER_VERIFIED_AT");
  if (
    verified.milliseconds > issued.milliseconds
    || issued.milliseconds - verified.milliseconds > 15 * 60 * 1_000
  ) {
    throw new Error("RESCUE_CANARY_ACTIVATION_WRITER_FENCE_WINDOW_MISMATCH");
  }
  return { mode: expectedMode, evidenceAt: verified.iso };
}

export function renderRescueCanaryActivationSql({
  connectionId,
  runId,
  approvedAt,
  expiresAt,
  keyVersion,
  mode = "bootstrap",
  writerFenceMode = "legacy-writer-revoked",
  legacyWriterRevokedAt,
  writerFenceEvidenceAt = legacyWriterRevokedAt,
  credentialAttestations,
  credentialSetSha256,
  deploymentManifestSha256,
  writerFenceGrantSha256,
}) {
  if (!UUID_PATTERN.test(connectionId)) throw new Error("RESCUE_CANARY_ACTIVATION_INVALID_CONNECTION_ID");
  if (!RUN_PATTERN.test(runId)) throw new Error("RESCUE_CANARY_ACTIVATION_INVALID_RUN_ID");
  if (!KEY_VERSION_PATTERN.test(keyVersion)) throw new Error("RESCUE_CANARY_ACTIVATION_INVALID_KEY_VERSION");
  if (!new Set(["bootstrap", "rotate"]).has(mode)) {
    throw new Error("RESCUE_CANARY_ACTIVATION_INVALID_MODE");
  }
  if (!WRITER_FENCE_MODES.has(writerFenceMode)) {
    throw new Error("RESCUE_CANARY_ACTIVATION_INVALID_WRITER_FENCE_MODE");
  }
  const writerEvidence = parseTimestamp(writerFenceEvidenceAt, "WRITER_FENCE_EVIDENCE_AT");
  if (
    !SHA256_PATTERN.test(credentialAttestations?.agora ?? "")
    || !SHA256_PATTERN.test(credentialAttestations?.winerim ?? "")
    || !SHA256_PATTERN.test(credentialSetSha256 ?? "")
    || !SHA256_PATTERN.test(deploymentManifestSha256 ?? "")
    || !SHA256_PATTERN.test(writerFenceGrantSha256 ?? "")
  ) {
    throw new Error("RESCUE_CANARY_ACTIVATION_INVALID_EVIDENCE_SHA256");
  }
  const approved = parseTimestamp(approvedAt, "APPROVED_AT");
  const expires = parseTimestamp(expiresAt, "EXPIRES_AT");
  if (
    expires.milliseconds <= approved.milliseconds
    || expires.milliseconds - approved.milliseconds > MAX_WINDOW_MS
  ) {
    throw new Error("RESCUE_CANARY_ACTIVATION_WINDOW_MUST_BE_WITHIN_TWO_HOURS");
  }
  const scopeNote = `rescue-canary-run:${runId}`;
  return `BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20s';
SELECT pg_advisory_xact_lock(hashtextextended('runtime-canary-control-plane', 0));

LOCK TABLE public.pos_connections,
  public.runtime_canary_connections,
  public.runtime_connection_credentials
  IN SHARE ROW EXCLUSIVE MODE;

DO $verify_rescue_canary_activation$
BEGIN
  IF '${writerFenceMode}' = 'legacy-writer-revoked'
    AND statement_timestamp() < '${writerEvidence.iso}'::timestamptz + interval '130 seconds' THEN
    RAISE EXCEPTION 'legacy writer lease and network drain has not elapsed';
  END IF;
  IF '${approved.iso}'::timestamptz > statement_timestamp()
    OR '${expires.iso}'::timestamptz <= statement_timestamp()
    OR '${expires.iso}'::timestamptz > '${approved.iso}'::timestamptz + interval '2 hours' THEN
    RAISE EXCEPTION 'canary approval window is not currently valid';
  END IF;
  IF (
    SELECT count(*)
    FROM public.pos_connections
    WHERE id = '${connectionId}'::uuid
      AND provider = 'agora'
      AND enabled = false
      AND catalog_sync_enabled = false
      AND sync_mode = 'PULL_ONLY'
      AND write_mode = 'NONE'
      AND backfill_days = 0
  ) <> 1 THEN
    RAISE EXCEPTION 'activation candidate is missing or not inert';
  END IF;
  IF EXISTS (SELECT 1 FROM public.runtime_canary_connections WHERE active = true)
    OR EXISTS (SELECT 1 FROM public.runtime_connection_credentials WHERE active = true) THEN
    RAISE EXCEPTION 'another canary scope or credential is active';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.runtime_canary_connections
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND generation_mode = '${mode}'
      AND status = 'PREPARED'
      AND active = false
      AND approved_at IS NULL
      AND expires_at IS NULL
      AND deployment_manifest_sha256 IS NULL
      AND writer_fence_grant_sha256 IS NULL
      AND credential_set_sha256 IS NULL
      AND activated_at IS NULL
      AND retired_at IS NULL
  ) THEN
    RAISE EXCEPTION 'exact prepared canary run is missing or already consumed';
  END IF;
  IF '${writerFenceMode}' = 'bootstrap-no-legacy-writer' AND (
    EXISTS (
      SELECT 1 FROM public.runtime_canary_connections
      WHERE connection_id = '${connectionId}'::uuid
        AND run_id <> '${runId}'
    )
    OR EXISTS (
      SELECT 1 FROM public.runtime_connection_credentials
      WHERE connection_id = '${connectionId}'::uuid
        AND run_id <> '${runId}'
    )
  ) THEN
    RAISE EXCEPTION 'bootstrap-no-legacy-writer requires zero prior scopes, runs, or credentials';
  END IF;
  IF (
    SELECT count(*)
    FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid
      AND key_version = '${keyVersion}'
      AND run_id = '${runId}'
      AND provider = 'agora'
      AND credential_kind IN ('agora', 'winerim')
      AND active = false
      AND activated_at IS NULL
      AND retired_at IS NULL
  ) <> 2 OR (
    SELECT count(DISTINCT credential_kind)
    FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid
      AND key_version = '${keyVersion}'
      AND run_id = '${runId}'
      AND provider = 'agora'
      AND active = false
  ) <> 2 THEN
    RAISE EXCEPTION 'exact inactive credential generation is incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND credential_kind = 'agora'
      AND attestation_sha256 = '${credentialAttestations.agora}'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND credential_kind = 'winerim'
      AND attestation_sha256 = '${credentialAttestations.winerim}'
  ) THEN
    RAISE EXCEPTION 'credential attestations do not match reviewed provisioning manifest';
  END IF;
  IF '${mode}' = 'bootstrap' AND (
      (SELECT count(*) FROM public.sales_events WHERE connection_id = '${connectionId}'::uuid)
      + (SELECT count(*) FROM public.sales_line_items WHERE connection_id = '${connectionId}'::uuid)
      + (SELECT count(*) FROM public.stock_sync_log WHERE connection_id = '${connectionId}'::uuid)
      + (SELECT count(*) FROM public.outbound_tasks WHERE connection_id = '${connectionId}'::uuid)
      + (SELECT count(*) FROM public.runtime_execution_log WHERE connection_id = '${connectionId}'::uuid)
      + (SELECT count(*) FROM public.runtime_idempotency WHERE connection_id = '${connectionId}'::uuid)
    ) <> 0 THEN
    RAISE EXCEPTION 'bootstrap canary activation requires zero operational rows';
  END IF;
  IF '${mode}' = 'rotate' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.runtime_canary_connections
      WHERE connection_id = '${connectionId}'::uuid
        AND run_id <> '${runId}'
        AND status IN ('RETIRED', 'ABORTED')
        AND active = false
        AND retired_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'rotated canary activation requires prior terminal scope';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.runtime_connection_credentials credentials
      JOIN public.runtime_canary_connections scope
        ON scope.connection_id = credentials.connection_id
       AND scope.run_id = credentials.run_id
      WHERE credentials.connection_id = '${connectionId}'::uuid
        AND credentials.run_id <> '${runId}'
        AND (
          credentials.active
          OR credentials.activated_at IS NULL
          OR credentials.retired_at IS NULL
          OR scope.status NOT IN ('RETIRED', 'ABORTED')
          OR scope.active
          OR scope.retired_at IS NULL
        )
    ) THEN
      RAISE EXCEPTION 'rotated canary activation requires complete terminal history';
    END IF;
  END IF;
END;
$verify_rescue_canary_activation$;

UPDATE public.runtime_connection_credentials
SET active = true,
    activated_at = transaction_timestamp()
WHERE connection_id = '${connectionId}'::uuid
  AND run_id = '${runId}'
  AND key_version = '${keyVersion}'
  AND credential_kind IN ('agora', 'winerim')
  AND active = false;

UPDATE public.runtime_canary_connections
SET active = true,
    status = 'ACTIVE',
    approved_at = '${approved.iso}'::timestamptz,
    expires_at = '${expires.iso}'::timestamptz,
    deployment_manifest_sha256 = '${deploymentManifestSha256}',
    writer_fence_grant_sha256 = '${writerFenceGrantSha256}',
    credential_set_sha256 = '${credentialSetSha256}',
    activated_at = transaction_timestamp()
WHERE connection_id = '${connectionId}'::uuid
  AND run_id = '${runId}'
  AND status = 'PREPARED'
  AND active = false;

UPDATE public.pos_connections
SET enabled = true,
    catalog_sync_enabled = false,
    sync_mode = 'PULL_ONLY',
    write_mode = 'NONE',
    backfill_days = 0
WHERE id = '${connectionId}'::uuid
  AND enabled = false;

DO $readback_rescue_canary_activation$
BEGIN
  IF (
    SELECT count(*) FROM public.runtime_canary_connections
    WHERE active = true
      AND connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND approved_at = '${approved.iso}'::timestamptz
      AND expires_at = '${expires.iso}'::timestamptz
      AND note = '${scopeNote}'
      AND deployment_manifest_sha256 = '${deploymentManifestSha256}'
      AND writer_fence_grant_sha256 = '${writerFenceGrantSha256}'
      AND credential_set_sha256 = '${credentialSetSha256}'
  ) <> 1 OR (
    SELECT count(*) FROM public.runtime_connection_credentials
    WHERE active = true
      AND connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND key_version = '${keyVersion}'
      AND credential_kind IN ('agora', 'winerim')
  ) <> 2 OR (
    SELECT count(*) FROM public.pos_connections
    WHERE enabled = true
      AND id = '${connectionId}'::uuid
      AND catalog_sync_enabled = false
      AND sync_mode = 'PULL_ONLY'
      AND write_mode = 'NONE'
      AND backfill_days = 0
  ) <> 1 OR EXISTS (
    SELECT 1 FROM public.pos_connections
    WHERE id <> '${connectionId}'::uuid AND enabled = true
  ) THEN
    RAISE EXCEPTION 'rescue canary activation readback failed';
  END IF;
END;
$readback_rescue_canary_activation$;

COMMIT;
`;
}

export function rescueCanaryActivationPlan({
  connectionId,
  runId,
  approvedAt,
  expiresAt,
  keyVersion,
  deploymentManifest,
  deploymentManifestSha256,
  writerFenceGrant,
  writerFenceGrantSha256,
  credentialProvisioningManifest,
  credentialProvisioningManifestSha256,
  deploymentConfigSha256,
  deploymentBundleSha256,
  externalWriterFenceEvidence = null,
}) {
  if (!UUID_PATTERN.test(connectionId)) throw new Error("RESCUE_CANARY_ACTIVATION_INVALID_CONNECTION_ID");
  if (!RUN_PATTERN.test(runId)) throw new Error("RESCUE_CANARY_ACTIVATION_INVALID_RUN_ID");
  if (!KEY_VERSION_PATTERN.test(keyVersion)) throw new Error("RESCUE_CANARY_ACTIVATION_INVALID_KEY_VERSION");
  if (
    !SHA256_PATTERN.test(deploymentManifestSha256)
    || !SHA256_PATTERN.test(writerFenceGrantSha256)
    || !SHA256_PATTERN.test(credentialProvisioningManifestSha256)
  ) {
    throw new Error("RESCUE_CANARY_ACTIVATION_INVALID_BOUND_ARTIFACT_SHA256");
  }
  const approved = parseTimestamp(approvedAt, "APPROVED_AT");
  const expires = parseTimestamp(expiresAt, "EXPIRES_AT");
  if (
    expires.milliseconds <= approved.milliseconds
    || expires.milliseconds - approved.milliseconds > MAX_WINDOW_MS
  ) {
    throw new Error("RESCUE_CANARY_ACTIVATION_WINDOW_MUST_BE_WITHIN_TWO_HOURS");
  }
  const provisioning = validateProvisioningManifest({
    manifest: credentialProvisioningManifest,
    connectionId,
    runId,
    keyVersion,
  });
  const deployment = validateDeploymentManifest({
    manifest: deploymentManifest,
    connectionId,
    runId,
    keyVersion,
    credentialSetSha256: provisioning.credentialSetSha256,
    deploymentConfigSha256,
    deploymentBundleSha256,
  });
  if (
    deployment.policy.writerFenceMode === "bootstrap-no-legacy-writer"
    && provisioning.mode !== "bootstrap"
  ) {
    throw new Error("RESCUE_CANARY_ACTIVATION_BOOTSTRAP_WRITER_REQUIRES_BOOTSTRAP_GENERATION");
  }
  const exclusiveAttestation = provisioning.attestations[
    deployment.policy.exclusiveWriterCredentialKind
  ];
  if (deployment.exclusiveAttestationSha256 !== exclusiveAttestation) {
    throw new Error("RESCUE_CANARY_ACTIVATION_EXCLUSIVE_CREDENTIAL_ATTESTATION_MISMATCH");
  }
  const writerFence = validateWriterFenceGrant({
    grant: writerFenceGrant,
    connectionId,
    runId,
    expectedAttestation: deployment.exclusiveAttestationSha256,
    expectedHolderId: deployment.writerFence.holderId,
    expectedProofSha256: deployment.writerFence.proofSha256,
    expectedCredentialRef: deployment.writerFence.exclusiveCredentialRef,
    expectedCredentialBinding: deployment.writerFence.credentialBinding,
    expectedMode: deployment.policy.writerFenceMode,
    expectedExternalEvidence: externalWriterFenceEvidence,
    approvedAt: approved,
    expiresAt: expires,
  });
  return {
    status: "RESCUE_CANARY_ACTIVATION_PLAN_READY",
    remoteMutations: 0,
    connectionId,
    runId,
    approvedAt: approved.iso,
    expiresAt: expires.iso,
    keyVersion,
    mode: provisioning.mode,
    writerFenceMode: writerFence.mode,
    writerFenceEvidenceAt: writerFence.evidenceAt,
    scopeNote: `rescue-canary-run:${runId}`,
    deploymentManifestSha256,
    writerFenceGrantSha256,
    credentialProvisioningManifestSha256,
    deploymentConfigSha256,
    deploymentBundleSha256,
    credentialSetSha256: provisioning.credentialSetSha256,
    credentialAttestations: provisioning.attestations,
    activation: {
      oneConnection: true,
      job: deployment.policy.job,
      lane: deployment.policy.lane,
      maxOperations: 1,
      productId: deployment.policy.productId,
      catalogDisabled: !deployment.policy.agoraCatalogApply,
      syncMode: "PULL_ONLY",
      writeMode: "NONE",
      exclusiveWriterCredentialKind: deployment.policy.exclusiveWriterCredentialKind,
      agoraCredentialMode: deployment.policy.agoraCredentialMode,
      winerimMutation: deployment.policy.winerimMutation,
      credentialKinds: ["agora", "winerim"],
      firstCanaryRequiresZeroOperationalRows: true,
      preservesPriorOperationalRowsOnRotation: provisioning.mode === "rotate",
    },
    forbidden: [
      ...(!deployment.policy.agoraCatalogApply ? ["agora-catalog-write"] : []),
      "agora-outbound-write",
      ...(deployment.policy.agoraCatalogApply ? [] : ["catalog-enable"]),
      "backfill",
      "cursor-write",
      ...(!deployment.policy.winerimMutation ? ["winerim-mutation"] : []),
      "shared-queue",
    ],
  };
}

export function prepareRescueCanaryActivation({ environment = process.env, output }) {
  const connectionId = required(environment, "CANARY_CONNECTION_ID");
  const runId = required(environment, "CANARY_RUN_ID");
  const approvedAt = required(environment, "CANARY_SCOPE_APPROVED_AT");
  const expiresAt = required(environment, "CANARY_SCOPE_EXPIRES_AT");
  const keyVersion = required(environment, "RUNTIME_VAULT_KEY_VERSION");
  const deploymentManifestPath = required(environment, "CANARY_DEPLOYMENT_MANIFEST");
  const deploymentManifestSha256 = required(environment, "CANARY_DEPLOYMENT_MANIFEST_SHA256").toLowerCase();
  const writerFenceGrantPath = required(environment, "CANARY_WRITER_FENCE_GRANT");
  const writerFenceGrantSha256 = required(environment, "CANARY_WRITER_FENCE_GRANT_SHA256").toLowerCase();
  const credentialProvisioningManifestPath = required(environment, "RUNTIME_CREDENTIAL_PROVISIONING_MANIFEST");
  const credentialProvisioningManifestSha256 = required(
    environment,
    "RUNTIME_CREDENTIAL_PROVISIONING_MANIFEST_SHA256",
  ).toLowerCase();
  const deployment = readBoundJson({
    path: deploymentManifestPath,
    expectedSha256: deploymentManifestSha256,
    label: "DEPLOYMENT_MANIFEST",
  });
  const fence = readBoundJson({
    path: writerFenceGrantPath,
    expectedSha256: writerFenceGrantSha256,
    label: "WRITER_FENCE_GRANT",
  });
  const provisioning = readBoundJson({
    path: credentialProvisioningManifestPath,
    expectedSha256: credentialProvisioningManifestSha256,
    label: "CREDENTIAL_PROVISIONING_MANIFEST",
  });
  const externalWriterFenceEvidence = fence.value?.writerHistory?.mode === "bootstrap-no-legacy-writer"
    ? readExternalBootstrapWriterFenceEvidence({
      environment,
      connectionId,
      referenceTime: approvedAt,
    })
    : null;
  const deploymentConfigSha256 = {};
  const deploymentBundleSha256 = {};
  for (const key of DEPLOYMENT_CONFIG_KEYS) {
    const configPath = resolve(required(environment, `CANARY_DEPLOYMENT_CONFIG_${key.toUpperCase()}`));
    const bundlePath = resolve(required(environment, `CANARY_DEPLOYMENT_BUNDLE_${key.toUpperCase()}`));
    const config = readFileSync(configPath, "utf8");
    const configuredMain = config.match(/^main\s*=\s*"([^"]+)"/m)?.[1];
    if (configuredMain !== bundlePath || !/^no_bundle\s*=\s*true$/m.test(config)) {
      throw new Error("RESCUE_CANARY_ACTIVATION_DEPLOYMENT_BUNDLE_BINDING_MISMATCH");
    }
    deploymentConfigSha256[key] = createHash("sha256").update(config).digest("hex");
    deploymentBundleSha256[key] = createHash("sha256").update(readFileSync(bundlePath)).digest("hex");
  }
  const plan = rescueCanaryActivationPlan({
    connectionId,
    runId,
    approvedAt,
    expiresAt,
    keyVersion,
    deploymentManifest: deployment.value,
    deploymentManifestSha256: deployment.sha256,
    writerFenceGrant: fence.value,
    writerFenceGrantSha256: fence.sha256,
    credentialProvisioningManifest: provisioning.value,
    credentialProvisioningManifestSha256: provisioning.sha256,
    deploymentConfigSha256,
    deploymentBundleSha256,
    externalWriterFenceEvidence,
  });
  const target = resolve(output);
  const relativeTarget = relative(repoRoot, target);
  if (relativeTarget === "" || (!relativeTarget.startsWith("..") && !relativeTarget.startsWith("/"))) {
    throw new Error("RESCUE_CANARY_ACTIVATION_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const realParent = realpathSync(dirname(target));
  const realRelativeParent = relative(repoRoot, realParent);
  if (realRelativeParent === "" || (!realRelativeParent.startsWith("..") && !realRelativeParent.startsWith("/"))) {
    throw new Error("RESCUE_CANARY_ACTIVATION_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  const sql = renderRescueCanaryActivationSql({
    connectionId,
    runId,
    approvedAt,
    expiresAt,
    keyVersion,
    mode: plan.mode,
    writerFenceMode: plan.writerFenceMode,
    writerFenceEvidenceAt: plan.writerFenceEvidenceAt,
    credentialAttestations: plan.credentialAttestations,
    credentialSetSha256: plan.credentialSetSha256,
    deploymentManifestSha256: plan.deploymentManifestSha256,
    writerFenceGrantSha256: plan.writerFenceGrantSha256,
  });
  writeFileSync(target, sql, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(target, 0o600);
  return {
    ...plan,
    sqlPath: target,
    sqlSha256: createHash("sha256").update(sql).digest("hex"),
  };
}

function argument(name) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function main() {
  if (!process.argv.includes("--render")) {
    process.stdout.write(`${JSON.stringify({
      status: "RESCUE_CANARY_ACTIVATION_PLAN_ONLY",
      remoteMutations: 0,
      requiredEnvironment: [
        "CANARY_CONNECTION_ID",
        "CANARY_RUN_ID",
        "CANARY_SCOPE_APPROVED_AT",
        "CANARY_SCOPE_EXPIRES_AT",
        "RUNTIME_VAULT_KEY_VERSION",
        "CANARY_DEPLOYMENT_MANIFEST",
        "CANARY_DEPLOYMENT_MANIFEST_SHA256",
        "CANARY_WRITER_FENCE_GRANT",
        "CANARY_WRITER_FENCE_GRANT_SHA256",
        "RUNTIME_CREDENTIAL_PROVISIONING_MANIFEST",
        "RUNTIME_CREDENTIAL_PROVISIONING_MANIFEST_SHA256",
      ],
      renderGate: "--render --confirm-connection=<UUID> --output=/secure/path/activate.sql",
    }, null, 2)}\n`);
    return;
  }
  const connectionId = required(process.env, "CANARY_CONNECTION_ID");
  if (argument("--confirm-connection") !== connectionId) {
    throw new Error("RESCUE_CANARY_ACTIVATION_CONNECTION_CONFIRMATION_REQUIRED");
  }
  const output = argument("--output");
  if (!output) throw new Error("RESCUE_CANARY_ACTIVATION_OUTPUT_REQUIRED");
  process.stdout.write(`${JSON.stringify(prepareRescueCanaryActivation({ output }), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
