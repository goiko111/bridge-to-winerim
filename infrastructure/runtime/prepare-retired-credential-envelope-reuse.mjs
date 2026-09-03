import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runtimeCredentialAad,
  runtimeCredentialSetSha256,
  validateAdoptExistingEvidence,
} from "./prepare-runtime-credential-provisioning.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ALGORITHM = "AES-256-GCM";
const AAD_VERSION = 1;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_AGE_MS = 15 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5_000;
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`RUNTIME_RETIRED_ENVELOPE_REUSE_INVALID_${label}`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`RUNTIME_RETIRED_ENVELOPE_REUSE_INVALID_${label}_KEYS`);
  }
}

function parseJson(source, label) {
  try {
    return JSON.parse(source.toString("utf8"));
  } catch {
    throw new Error(`RUNTIME_RETIRED_ENVELOPE_REUSE_INVALID_${label}_JSON`);
  }
}

function isOutsideRepository(path) {
  const candidate = relative(repoRoot, path);
  return candidate !== "" && (candidate.startsWith("..") || candidate.startsWith("/"));
}

function readPrivateFile(path, label) {
  if (!isAbsolute(path)) {
    throw new Error(`RUNTIME_RETIRED_ENVELOPE_REUSE_${label}_PATH_MUST_BE_ABSOLUTE`);
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`RUNTIME_RETIRED_ENVELOPE_REUSE_${label}_MUST_BE_REGULAR_FILE`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`RUNTIME_RETIRED_ENVELOPE_REUSE_${label}_MUST_BE_PRIVATE_0600`);
  }
  if (metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) {
    throw new Error(`RUNTIME_RETIRED_ENVELOPE_REUSE_${label}_INVALID_SIZE`);
  }
  return readFileSync(path);
}

function exactFileSha256(source, expected, label) {
  if (!SHA256_PATTERN.test(expected ?? "")) {
    throw new Error(`RUNTIME_RETIRED_ENVELOPE_REUSE_INVALID_${label}_SHA256`);
  }
  const actual = sha256(source);
  if (actual !== expected) {
    throw new Error(`RUNTIME_RETIRED_ENVELOPE_REUSE_${label}_SHA256_MISMATCH`);
  }
  return actual;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    throw new Error(`RUNTIME_RETIRED_ENVELOPE_REUSE_INVALID_${label}`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`RUNTIME_RETIRED_ENVELOPE_REUSE_INVALID_${label}`);
  }
  return parsed;
}

function validateFreshCapture(source, label, now, { requireAuthoritative }) {
  const artifact = parseJson(source, label);
  if (artifact?.schemaVersion !== "agora-shadow-v2") {
    throw new Error(`RUNTIME_RETIRED_ENVELOPE_REUSE_${label}_SCHEMA_MISMATCH`);
  }
  const capture = artifact.capture;
  if (
    !capture
    || capture.sourceMarkerStable !== true
    || (requireAuthoritative && (
      capture.authoritative !== true
      || capture.consistencyBlocker !== null
    ))
  ) {
    throw new Error(`RUNTIME_RETIRED_ENVELOPE_REUSE_${label}_CAPTURE_NOT_STABLE`);
  }
  const startedAt = timestamp(capture.captureStartedAt, `${label}_CAPTURE_STARTED_AT`);
  const endedAt = timestamp(capture.captureEndedAt, `${label}_CAPTURE_ENDED_AT`);
  const nowMs = now.getTime();
  if (
    startedAt.getTime() > endedAt.getTime()
    || endedAt.getTime() > nowMs + MAX_CLOCK_SKEW_MS
    || nowMs - endedAt.getTime() > MAX_EVIDENCE_AGE_MS
  ) {
    throw new Error(`RUNTIME_RETIRED_ENVELOPE_REUSE_${label}_CAPTURE_STALE`);
  }
  return {
    captureStartedAt: startedAt.toISOString(),
    captureEndedAt: endedAt.toISOString(),
    mode: String(capture.mode ?? ""),
    authoritative: capture.authoritative === true,
    consistencyBlocker: capture.consistencyBlocker ?? null,
  };
}

function artifactReference(reference, label) {
  exactKeys(reference, ["path", "sha256"], label);
  const path = String(reference.path ?? "").trim();
  const source = readPrivateFile(path, label);
  const artifactSha256 = exactFileSha256(source, reference.sha256, label);
  return { path, source, sha256: artifactSha256 };
}

function validateSourceCredentialManifest(manifest, input) {
  exactKeys(manifest, [
    "version",
    "connectionId",
    "runId",
    "keyVersion",
    "mode",
    "active",
    "sqlSha256",
    "credentialAttestations",
    "credentialSetSha256",
    "adoption",
    "adoptionCursorPolicy",
    "scopeGenerationMode",
    "activationAllowed",
    "activationBlockReason",
  ], "SOURCE_CREDENTIAL_MANIFEST");
  exactKeys(manifest.credentialAttestations, ["agora", "winerim"], "SOURCE_ATTESTATIONS");
  const attestations = manifest.credentialAttestations;
  if (
    manifest.version !== 3
    || manifest.connectionId !== input.connectionId
    || manifest.runId !== input.sourceRunId
    || manifest.keyVersion !== input.expectedKeyVersion
    || manifest.mode !== "adopt-existing"
    || manifest.active !== false
    || manifest.scopeGenerationMode !== "bootstrap"
    || manifest.activationAllowed !== false
    || manifest.activationBlockReason !== "ADOPT_EXISTING_ACTIVATION_REQUIRES_SEPARATE_REVIEWED_GATE"
    || !SHA256_PATTERN.test(manifest.sqlSha256 ?? "")
    || !SHA256_PATTERN.test(attestations.agora ?? "")
    || !SHA256_PATTERN.test(attestations.winerim ?? "")
    || !SHA256_PATTERN.test(manifest.credentialSetSha256 ?? "")
  ) {
    throw new Error("RUNTIME_RETIRED_ENVELOPE_REUSE_SOURCE_MANIFEST_SCOPE_MISMATCH");
  }
  const sourceCredentialSetSha256 = runtimeCredentialSetSha256({
    connectionId: input.connectionId,
    runId: input.sourceRunId,
    keyVersion: input.expectedKeyVersion,
    credentials: [
      { kind: "agora", attestationSha256: attestations.agora },
      { kind: "winerim", attestationSha256: attestations.winerim },
    ],
  });
  if (manifest.credentialSetSha256 !== sourceCredentialSetSha256) {
    throw new Error("RUNTIME_RETIRED_ENVELOPE_REUSE_SOURCE_CREDENTIAL_SET_MISMATCH");
  }
  return {
    attestations: { agora: attestations.agora, winerim: attestations.winerim },
    sourceCredentialSetSha256,
  };
}

function validateInput(input, now) {
  exactKeys(input, [
    "version",
    "kind",
    "connectionId",
    "sourceRunId",
    "targetRunId",
    "expectedKeyVersion",
    "sourceCredentialManifest",
    "adoptionEvidence",
  ], "INPUT");
  exactKeys(input.adoptionEvidence, [
    "exportManifestPath",
    "exportManifestSha256",
    "targetManifestPath",
    "targetManifestSha256",
    "reconciliationManifestPath",
    "reconciliationManifestSha256",
  ], "ADOPTION_EVIDENCE");
  const connectionId = String(input.connectionId ?? "").trim().toLowerCase();
  const sourceRunId = String(input.sourceRunId ?? "").trim();
  const targetRunId = String(input.targetRunId ?? "").trim();
  const expectedKeyVersion = String(input.expectedKeyVersion ?? "").trim();
  if (
    input.version !== 1
    || input.kind !== "RUNTIME_RETIRED_CREDENTIAL_ENVELOPE_REUSE"
    || !UUID_PATTERN.test(connectionId)
    || !RUN_PATTERN.test(sourceRunId)
    || !RUN_PATTERN.test(targetRunId)
    || sourceRunId === targetRunId
    || !KEY_VERSION_PATTERN.test(expectedKeyVersion)
  ) {
    throw new Error("RUNTIME_RETIRED_ENVELOPE_REUSE_INVALID_INPUT_CONTRACT");
  }

  const sourceCredentialReference = artifactReference(
    input.sourceCredentialManifest,
    "SOURCE_CREDENTIAL_MANIFEST",
  );
  const sourceCredentialManifest = parseJson(
    sourceCredentialReference.source,
    "SOURCE_CREDENTIAL_MANIFEST",
  );
  const sourceCredential = validateSourceCredentialManifest(sourceCredentialManifest, {
    connectionId,
    sourceRunId,
    expectedKeyVersion,
  });

  const exportManifestPath = String(input.adoptionEvidence.exportManifestPath ?? "").trim();
  const targetManifestPath = String(input.adoptionEvidence.targetManifestPath ?? "").trim();
  const reconciliationManifestPath = String(
    input.adoptionEvidence.reconciliationManifestPath ?? "",
  ).trim();
  const exportManifestSource = readPrivateFile(exportManifestPath, "EXPORT_MANIFEST");
  const targetManifestSource = readPrivateFile(targetManifestPath, "TARGET_MANIFEST");
  const reconciliationManifestSource = readPrivateFile(
    reconciliationManifestPath,
    "RECONCILIATION_MANIFEST",
  );
  const sourceCapture = validateFreshCapture(exportManifestSource, "EXPORT_MANIFEST", now, {
    requireAuthoritative: false,
  });
  const targetCapture = validateFreshCapture(targetManifestSource, "TARGET_MANIFEST", now, {
    requireAuthoritative: true,
  });
  const adoption = validateAdoptExistingEvidence({
    connectionId,
    exportManifestSource,
    exportManifestSha256: input.adoptionEvidence.exportManifestSha256,
    targetManifestSource,
    targetManifestSha256: input.adoptionEvidence.targetManifestSha256,
    reconciliationManifestSource,
    reconciliationManifestSha256: input.adoptionEvidence.reconciliationManifestSha256,
  });
  const credentials = [
    { kind: "agora", attestationSha256: sourceCredential.attestations.agora },
    { kind: "winerim", attestationSha256: sourceCredential.attestations.winerim },
  ];
  return {
    connectionId,
    sourceRunId,
    targetRunId,
    keyVersion: expectedKeyVersion,
    credentials,
    credentialAttestations: sourceCredential.attestations,
    sourceCredentialSetSha256: sourceCredential.sourceCredentialSetSha256,
    targetCredentialSetSha256: runtimeCredentialSetSha256({
      connectionId,
      runId: targetRunId,
      keyVersion: expectedKeyVersion,
      credentials,
    }),
    sourceCredentialManifestSha256: sourceCredentialReference.sha256,
    sourceCredentialManifestSqlSha256: sourceCredentialManifest.sqlSha256,
    adoption,
    evidence: {
      exportManifestSha256: input.adoptionEvidence.exportManifestSha256,
      targetManifestSha256: input.adoptionEvidence.targetManifestSha256,
      reconciliationManifestSha256: input.adoptionEvidence.reconciliationManifestSha256,
      sourceCapture,
      targetCapture,
    },
    generatedAt: now.toISOString(),
  };
}

export function renderRetiredCredentialEnvelopeReuseSql(validated) {
  const {
    connectionId,
    sourceRunId,
    targetRunId,
    keyVersion,
    credentialAttestations,
    adoption,
  } = validated;
  return `BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20s';
SELECT pg_advisory_xact_lock(hashtextextended('runtime-canary-control-plane', 0));

LOCK TABLE public.pos_connections,
  public.runtime_canary_connections,
  public.runtime_connection_credentials
  IN SHARE ROW EXCLUSIVE MODE;

DO $validate_retired_envelope_reuse$
DECLARE
  incomplete_versions integer;
BEGIN
  IF (
    SELECT count(*) FROM public.pos_connections
    WHERE id = '${connectionId}'::uuid
      AND provider = 'agora'
      AND enabled = false
      AND catalog_sync_enabled = false
      AND sync_mode = 'PULL_ONLY'
      AND write_mode = 'NONE'
      AND backfill_days = 0
  ) <> 1 THEN
    RAISE EXCEPTION 'retired envelope target connection is missing or not inert';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.runtime_canary_connections WHERE run_id = '${targetRunId}'
  ) OR EXISTS (
    SELECT 1 FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid AND run_id = '${targetRunId}'
  ) THEN
    RAISE EXCEPTION 'retired envelope target run already exists';
  END IF;

  SELECT count(*) INTO incomplete_versions
  FROM (
    SELECT credentials.run_id
    FROM public.runtime_connection_credentials credentials
    LEFT JOIN public.runtime_canary_connections scope
      ON scope.connection_id = credentials.connection_id
     AND scope.run_id = credentials.run_id
    WHERE credentials.connection_id = '${connectionId}'::uuid
    GROUP BY credentials.run_id, scope.status, scope.active, scope.retired_at
    HAVING count(*) <> 2
      OR count(*) FILTER (
        WHERE credentials.provider = 'agora'
          AND credentials.credential_kind IN ('agora', 'winerim')
      ) <> 2
      OR count(DISTINCT credentials.credential_kind) <> 2
      OR bool_or(credentials.active)
      OR scope.status IS NULL
      OR scope.status NOT IN ('RETIRED', 'ABORTED')
      OR scope.active IS DISTINCT FROM false
      OR scope.retired_at IS NULL
      OR bool_or(credentials.retired_at IS NULL)
      OR bool_or(
        scope.status = 'RETIRED'
        AND (
          credentials.activated_at IS NULL
          OR credentials.retired_at < credentials.activated_at
        )
      )
      OR bool_or(
        scope.status = 'ABORTED'
        AND credentials.activated_at IS NOT NULL
      )
  ) invalid_generation;
  IF incomplete_versions <> 0 THEN
    RAISE EXCEPTION 'retired envelope credential history is incomplete or still active';
  END IF;

  IF (
    SELECT count(*) FROM public.runtime_canary_connections
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${sourceRunId}'
      AND status = 'RETIRED'
      AND active = false
      AND activated_at IS NOT NULL
      AND retired_at IS NOT NULL
      AND retired_at >= activated_at
  ) <> 1 THEN
    RAISE EXCEPTION 'source credential scope is not an activated retired generation';
  END IF;

  IF (
    SELECT count(*) FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${sourceRunId}'
      AND provider = 'agora'
      AND credential_kind IN ('agora', 'winerim')
      AND algorithm = '${ALGORITHM}'
      AND key_version = '${keyVersion}'
      AND aad_version = ${AAD_VERSION}
      AND active = false
      AND activated_at IS NOT NULL
      AND retired_at IS NOT NULL
      AND retired_at >= activated_at
  ) <> 2 OR (
    SELECT count(DISTINCT credential_kind)
    FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${sourceRunId}'
      AND credential_kind IN ('agora', 'winerim')
  ) <> 2 OR NOT EXISTS (
    SELECT 1 FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${sourceRunId}'
      AND credential_kind = 'agora'
      AND attestation_sha256 = '${credentialAttestations.agora}'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${sourceRunId}'
      AND credential_kind = 'winerim'
      AND attestation_sha256 = '${credentialAttestations.winerim}'
  ) THEN
    RAISE EXCEPTION 'source generation does not contain exactly two compatible retired envelopes';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.runtime_canary_connections
    WHERE connection_id = '${connectionId}'::uuid AND active = true
  ) OR EXISTS (
    SELECT 1 FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid AND active = true
  ) THEN
    RAISE EXCEPTION 'runtime generation or credential is already active for connection';
  END IF;

  IF (
    SELECT count(*) FROM public.sales_events
    WHERE connection_id = '${connectionId}'::uuid
  ) <> ${adoption.watermarks.salesEvents} THEN
    RAISE EXCEPTION 'adopt-existing sales event watermark mismatch';
  END IF;
  IF (
    SELECT count(*) FROM public.sales_line_items
    WHERE connection_id = '${connectionId}'::uuid
  ) <> ${adoption.watermarks.salesLineItems} THEN
    RAISE EXCEPTION 'adopt-existing sales line watermark mismatch';
  END IF;
  IF COALESCE((
    SELECT max(business_day)::text FROM public.sales_events
    WHERE connection_id = '${connectionId}'::uuid
  ), '') <> '${adoption.watermarks.maxBusinessDay}' THEN
    RAISE EXCEPTION 'adopt-existing sales day watermark mismatch';
  END IF;
  IF COALESCE((
    SELECT last_business_day_synced::text FROM public.pos_connections
    WHERE id = '${connectionId}'::uuid
  ), '') <> '${adoption.watermarks.lastBusinessDaySynced}' THEN
    RAISE EXCEPTION 'adopt-existing cursor day watermark mismatch';
  END IF;
  IF COALESCE((
    SELECT to_char(last_sync_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    FROM public.pos_connections WHERE id = '${connectionId}'::uuid
  ), '') <> '${adoption.watermarks.lastSyncAt}' THEN
    RAISE EXCEPTION 'adopt-existing sync timestamp watermark mismatch';
  END IF;
END;
$validate_retired_envelope_reuse$;

INSERT INTO public.runtime_canary_connections (
  connection_id, run_id, generation_mode, active, note, status
) VALUES (
  '${connectionId}'::uuid,
  '${targetRunId}',
  'bootstrap',
  false,
  'adopt-existing:v3:${adoption.bindingSha256}',
  'PREPARED'
);

INSERT INTO public.runtime_connection_credentials (
  connection_id,
  provider,
  credential_kind,
  run_id,
  algorithm,
  key_version,
  aad_version,
  ciphertext,
  nonce,
  attestation_sha256,
  active
)
SELECT
  connection_id,
  provider,
  credential_kind,
  '${targetRunId}',
  algorithm,
  key_version,
  aad_version,
  ciphertext,
  nonce,
  attestation_sha256,
  false
FROM public.runtime_connection_credentials
WHERE connection_id = '${connectionId}'::uuid
  AND run_id = '${sourceRunId}'
  AND provider = 'agora'
  AND credential_kind IN ('agora', 'winerim')
  AND algorithm = '${ALGORITHM}'
  AND key_version = '${keyVersion}'
  AND aad_version = ${AAD_VERSION}
  AND active = false
  AND activated_at IS NOT NULL
  AND retired_at IS NOT NULL
  AND retired_at >= activated_at
ORDER BY credential_kind;

DO $verify_retired_envelope_reuse$
BEGIN
  IF (
    SELECT count(*) FROM public.runtime_canary_connections
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${targetRunId}'
      AND generation_mode = 'bootstrap'
      AND status = 'PREPARED'
      AND active = false
      AND activated_at IS NULL
      AND retired_at IS NULL
      AND note = 'adopt-existing:v3:${adoption.bindingSha256}'
  ) <> 1 OR (
    SELECT count(*) FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${targetRunId}'
      AND active = false
      AND activated_at IS NULL
      AND retired_at IS NULL
      AND key_version = '${keyVersion}'
      AND aad_version = ${AAD_VERSION}
      AND algorithm = '${ALGORITHM}'
  ) <> 2 THEN
    RAISE EXCEPTION 'retired envelope PREPARED generation readback failed';
  END IF;

  IF EXISTS (
    (
      SELECT provider, credential_kind, algorithm, key_version, aad_version,
        ciphertext, nonce, attestation_sha256
      FROM public.runtime_connection_credentials
      WHERE connection_id = '${connectionId}'::uuid AND run_id = '${sourceRunId}'
      EXCEPT
      SELECT provider, credential_kind, algorithm, key_version, aad_version,
        ciphertext, nonce, attestation_sha256
      FROM public.runtime_connection_credentials
      WHERE connection_id = '${connectionId}'::uuid AND run_id = '${targetRunId}'
    ) UNION ALL (
      SELECT provider, credential_kind, algorithm, key_version, aad_version,
        ciphertext, nonce, attestation_sha256
      FROM public.runtime_connection_credentials
      WHERE connection_id = '${connectionId}'::uuid AND run_id = '${targetRunId}'
      EXCEPT
      SELECT provider, credential_kind, algorithm, key_version, aad_version,
        ciphertext, nonce, attestation_sha256
      FROM public.runtime_connection_credentials
      WHERE connection_id = '${connectionId}'::uuid AND run_id = '${sourceRunId}'
    )
  ) THEN
    RAISE EXCEPTION 'retired envelope byte-for-byte readback mismatch';
  END IF;
END;
$verify_retired_envelope_reuse$;

COMMIT;
`;
}

export function buildRetiredCredentialEnvelopeReuseManifest(validated, sqlSha256) {
  const aad = Object.fromEntries(validated.credentials.map(({ kind }) => {
    const value = runtimeCredentialAad({
      connectionId: validated.connectionId,
      kind,
      keyVersion: validated.keyVersion,
    });
    return [kind, { value, sha256: sha256(value) }];
  }));
  return {
    version: 3,
    connectionId: validated.connectionId,
    runId: validated.targetRunId,
    keyVersion: validated.keyVersion,
    mode: "adopt-existing",
    active: false,
    sqlSha256,
    credentialAttestations: validated.credentialAttestations,
    credentialSetSha256: validated.targetCredentialSetSha256,
    adoption: validated.adoption,
    adoptionCursorPolicy: {
      semantics: "lastBusinessDaySynced certifies closed business days; maxBusinessDay may include the current intraday service day",
      acceptedLagDays: [0, 1],
    },
    scopeGenerationMode: "bootstrap",
    activationAllowed: false,
    activationBlockReason: "ADOPT_EXISTING_ACTIVATION_REQUIRES_SEPARATE_REVIEWED_GATE",
    envelopeReuse: {
      version: 1,
      kind: "RETIRED_CREDENTIAL_ENVELOPE_REUSE",
      method: "POSTGRES_INSERT_SELECT_NO_PLAINTEXT",
      sourceRunId: validated.sourceRunId,
      sourceCredentialManifestSha256: validated.sourceCredentialManifestSha256,
      sourceCredentialManifestSqlSha256: validated.sourceCredentialManifestSqlSha256,
      sourceCredentialSetSha256: validated.sourceCredentialSetSha256,
      targetCredentialSetSha256: validated.targetCredentialSetSha256,
      algorithm: ALGORITHM,
      aadVersion: AAD_VERSION,
      aadRunIndependent: true,
      aad,
      evidenceMaxAgeSeconds: MAX_EVIDENCE_AGE_MS / 1_000,
      sourceCapture: validated.evidence.sourceCapture,
      targetCapture: validated.evidence.targetCapture,
      generatedAt: validated.generatedAt,
      plaintextRead: false,
      remoteMutations: 0,
    },
  };
}

function validateOutput(output) {
  const target = resolve(output);
  if (!isOutsideRepository(target)) {
    throw new Error("RUNTIME_RETIRED_ENVELOPE_REUSE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  if (existsSync(target) || existsSync(`${target}.manifest.json`)) {
    throw new Error("RUNTIME_RETIRED_ENVELOPE_REUSE_OUTPUT_ALREADY_EXISTS");
  }
  const parent = dirname(target);
  if (existsSync(parent)) {
    const metadata = lstatSync(parent);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("RUNTIME_RETIRED_ENVELOPE_REUSE_OUTPUT_PARENT_MUST_BE_DIRECTORY");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error("RUNTIME_RETIRED_ENVELOPE_REUSE_OUTPUT_PARENT_MUST_BE_PRIVATE_0700");
    }
  } else {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
  }
  const realParent = realpathSync(parent);
  if (!isOutsideRepository(realParent)) {
    throw new Error("RUNTIME_RETIRED_ENVELOPE_REUSE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  return target;
}

export function prepareRetiredCredentialEnvelopeReuse({ inputPath, output, now = new Date() }) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("RUNTIME_RETIRED_ENVELOPE_REUSE_INVALID_NOW");
  }
  const inputSource = readPrivateFile(inputPath, "INPUT");
  const input = parseJson(inputSource, "INPUT");
  const validated = validateInput(input, now);
  const target = validateOutput(output);
  const manifestPath = `${target}.manifest.json`;
  try {
    const sql = renderRetiredCredentialEnvelopeReuseSql(validated);
    const sqlSha256 = sha256(sql);
    const manifest = buildRetiredCredentialEnvelopeReuseManifest(validated, sqlSha256);
    const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(target, sql, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(target, 0o600);
    writeFileSync(manifestPath, manifestSource, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(manifestPath, 0o600);
    return {
      status: "RUNTIME_RETIRED_ENVELOPE_REUSE_PREPARED",
      remoteMutations: 0,
      plaintextRead: false,
      connectionId: validated.connectionId,
      sourceRunId: validated.sourceRunId,
      runId: validated.targetRunId,
      keyVersion: validated.keyVersion,
      output: target,
      sqlSha256,
      manifestPath,
      manifestSha256: sha256(manifestSource),
      credentialAttestations: validated.credentialAttestations,
      credentialSetSha256: validated.targetCredentialSetSha256,
      activationAllowed: false,
    };
  } catch (error) {
    rmSync(target, { force: true });
    rmSync(manifestPath, { force: true });
    throw error;
  }
}

export function retiredCredentialEnvelopeReusePlan() {
  return {
    status: "RUNTIME_RETIRED_ENVELOPE_REUSE_PLAN_ONLY",
    remoteMutations: 0,
    plaintextRead: false,
    outputMode: "private-0600",
    sqlMethod: "INSERT_SELECT_FROM_EXACT_RETIRED_GENERATION",
    evidenceMaxAgeSeconds: MAX_EVIDENCE_AGE_MS / 1_000,
    requiredLifecycle: {
      sourceScope: "RETIRED_AFTER_ACTIVATION",
      sourceCredentials: "EXACTLY_TWO_INACTIVE_ACTIVATED_AND_RETIRED",
      targetScope: "ABSENT_THEN_PREPARED_INACTIVE",
    },
    renderGate: "--render --input=/private/input.json --output=/private/runtime-credentials.sql --confirm-connection=<UUID> --confirm-source-run=<RUN> --confirm-target-run=<RUN>",
  };
}

function argument(name) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function main() {
  if (!process.argv.includes("--render")) {
    process.stdout.write(`${JSON.stringify(retiredCredentialEnvelopeReusePlan(), null, 2)}\n`);
    return;
  }
  const inputPath = argument("--input");
  const output = argument("--output");
  if (!inputPath || !output) {
    throw new Error("RUNTIME_RETIRED_ENVELOPE_REUSE_INPUT_AND_OUTPUT_REQUIRED");
  }
  const input = parseJson(readPrivateFile(inputPath, "INPUT"), "INPUT");
  if (
    argument("--confirm-connection") !== input.connectionId
    || argument("--confirm-source-run") !== input.sourceRunId
    || argument("--confirm-target-run") !== input.targetRunId
  ) {
    throw new Error("RUNTIME_RETIRED_ENVELOPE_REUSE_EXPLICIT_CONFIRMATION_REQUIRED");
  }
  const result = prepareRetiredCredentialEnvelopeReuse({ inputPath, output });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) main();
