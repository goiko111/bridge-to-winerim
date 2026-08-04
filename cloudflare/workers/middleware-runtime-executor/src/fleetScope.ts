import { sql, type DatabaseAdapter } from "../../middleware-api/src/db";
import {
  isDeployableRuntimeCanaryConnectionId,
  type RuntimeEnvelopeV1,
} from "../../middleware-runtime/src/contracts";
import {
  parseWriterFenceGrant,
  sha256Hex,
  type SecretsStoreSecretLike,
} from "../../../canary-failclosed/src/writerFence";

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const GENERATION_MODE_PATTERN = /^[a-z][a-z0-9-]{2,31}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_FLEET_FENCE_BUNDLE_BYTES = 512 * 1024;

export const FLEET_EXECUTOR_MODE = "fleet-executor" as const;

export type ActiveFleetScope = Readonly<{
  connectionId: string;
  runId: string;
  generationMode: string;
  credentialSetSha256: string;
  writerFenceGrantSha256: string;
}>;

export type FleetWriterFenceMaterial = Readonly<{
  rawGrant: string;
  proof: string;
  holderId: string;
}>;

type ActiveFleetScopeRow = Record<string, unknown> & {
  connection_id: unknown;
  run_id: unknown;
  generation_mode: unknown;
  credential_set_sha256: unknown;
  writer_fence_grant_sha256: unknown;
};

type FleetCredentialGenerationRow = Record<string, unknown> & {
  credential_kind: unknown;
  key_version: unknown;
  attestation_sha256: unknown;
};

type FleetWriterFenceBundleEntry = Readonly<{
  connectionId: string;
  runId: string;
  generationSha256: string;
  rawGrant: string;
  proof: string;
}>;

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function validActiveFleetScope(row: ActiveFleetScopeRow): ActiveFleetScope | null {
  const connectionId = text(row.connection_id);
  const runId = text(row.run_id);
  const generationMode = text(row.generation_mode).toLowerCase();
  const credentialSetSha256 = text(row.credential_set_sha256).toLowerCase();
  const writerFenceGrantSha256 = text(row.writer_fence_grant_sha256).toLowerCase();
  if (
    !isDeployableRuntimeCanaryConnectionId(connectionId)
    || !RUN_ID_PATTERN.test(runId)
    || !GENERATION_MODE_PATTERN.test(generationMode)
    || !SHA256_PATTERN.test(credentialSetSha256)
    || !SHA256_PATTERN.test(writerFenceGrantSha256)
  ) return null;
  return Object.freeze({
    connectionId,
    runId,
    generationMode,
    credentialSetSha256,
    writerFenceGrantSha256,
  });
}

export async function loadActiveFleetScope(
  database: DatabaseAdapter,
  connectionId: string,
): Promise<ActiveFleetScope | null> {
  if (!isDeployableRuntimeCanaryConnectionId(connectionId)) return null;
  const result = await database.query<ActiveFleetScopeRow>(sql`
    SELECT
      scope.connection_id::text AS connection_id,
      scope.run_id,
      scope.generation_mode,
      scope.credential_set_sha256,
      scope.writer_fence_grant_sha256
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = ${connectionId}::uuid
      AND scope.active = true
      AND scope.status = 'ACTIVE'
      AND scope.approved_at <= now()
      AND scope.expires_at > now()
      AND scope.credential_set_sha256 IS NOT NULL
      AND scope.writer_fence_grant_sha256 IS NOT NULL
    LIMIT 2
  `);
  if (result.rowCount !== 1 || result.rows.length !== 1) return null;
  const scope = validActiveFleetScope(result.rows[0]);
  if (!scope || scope.connectionId !== connectionId) return null;
  const credentials = await database.query<FleetCredentialGenerationRow>(sql`
    SELECT
      credentials.credential_kind,
      credentials.key_version,
      credentials.attestation_sha256
    FROM public.runtime_connection_credentials credentials
    WHERE credentials.connection_id = ${scope.connectionId}::uuid
      AND credentials.run_id = ${scope.runId}
      AND credentials.provider = 'agora'
      AND credentials.active = true
      AND credentials.retired_at IS NULL
    ORDER BY credentials.credential_kind
  `);
  if (credentials.rowCount !== 2 || credentials.rows.length !== 2) return null;
  const byKind = Object.fromEntries(credentials.rows.map((row) => [text(row.credential_kind), row]));
  const agora = byKind.agora;
  const winerim = byKind.winerim;
  const keyVersion = text(agora?.key_version);
  const agoraAttestation = text(agora?.attestation_sha256).toLowerCase();
  const winerimAttestation = text(winerim?.attestation_sha256).toLowerCase();
  if (
    !agora
    || !winerim
    || !KEY_VERSION_PATTERN.test(keyVersion)
    || text(winerim.key_version) !== keyVersion
    || !SHA256_PATTERN.test(agoraAttestation)
    || !SHA256_PATTERN.test(winerimAttestation)
  ) return null;
  const recomputedGeneration = await sha256Hex([
    "winerim-runtime-credential-set",
    "1",
    scope.connectionId,
    scope.runId,
    keyVersion,
    agoraAttestation,
    winerimAttestation,
  ].join("|"));
  return recomputedGeneration === scope.credentialSetSha256 ? scope : null;
}

export function fleetEnvelopeEventId(
  scope: Pick<ActiveFleetScope, "runId" | "credentialSetSha256">,
  messageId: string,
): string {
  return `fleet:${scope.runId}:${scope.credentialSetSha256}:${messageId}`;
}

export function isEnvelopeInsideActiveFleetScope(
  envelope: RuntimeEnvelopeV1,
  scope: ActiveFleetScope,
): boolean {
  return envelope.connectionId === scope.connectionId
    && envelope.source.kind === "queue"
    && envelope.source.eventId === fleetEnvelopeEventId(scope, envelope.messageId);
}

function parseBundleEntry(value: unknown): FleetWriterFenceBundleEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const entry = {
    connectionId: text(candidate.connectionId),
    runId: text(candidate.runId),
    generationSha256: text(candidate.generationSha256).toLowerCase(),
    rawGrant: String(candidate.rawGrant ?? ""),
    proof: String(candidate.proof ?? ""),
  };
  if (
    !isDeployableRuntimeCanaryConnectionId(entry.connectionId)
    || !RUN_ID_PATTERN.test(entry.runId)
    || !SHA256_PATTERN.test(entry.generationSha256)
    || entry.rawGrant.length === 0
    || entry.proof.length < 32
  ) return null;
  return Object.freeze(entry);
}

async function readFleetFenceEntries(
  binding: SecretsStoreSecretLike,
): Promise<readonly FleetWriterFenceBundleEntry[]> {
  const raw = await binding.get();
  if (new TextEncoder().encode(raw).byteLength > MAX_FLEET_FENCE_BUNDLE_BYTES) {
    throw new Error("RUNTIME_FLEET_FENCE_BUNDLE_TOO_LARGE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("RUNTIME_FLEET_FENCE_BUNDLE_INVALID_JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("RUNTIME_FLEET_FENCE_BUNDLE_INVALID");
  }
  const candidate = parsed as { version?: unknown; entries?: unknown };
  if (candidate.version !== 1 || !Array.isArray(candidate.entries)) {
    throw new Error("RUNTIME_FLEET_FENCE_BUNDLE_INVALID");
  }
  const entries = candidate.entries.map(parseBundleEntry);
  if (entries.some((entry) => entry === null)) {
    throw new Error("RUNTIME_FLEET_FENCE_BUNDLE_ENTRY_INVALID");
  }
  const resolved = entries as FleetWriterFenceBundleEntry[];
  const identities = new Set<string>();
  for (const entry of resolved) {
    const identity = `${entry.connectionId}:${entry.runId}:${entry.generationSha256}`;
    if (identities.has(identity)) throw new Error("RUNTIME_FLEET_FENCE_BUNDLE_DUPLICATE");
    identities.add(identity);
  }
  return Object.freeze(resolved);
}

export async function resolveFleetWriterFenceMaterial(
  binding: SecretsStoreSecretLike,
  scope: ActiveFleetScope,
): Promise<FleetWriterFenceMaterial> {
  const entries = await readFleetFenceEntries(binding);
  const matching = entries.filter((entry) => (
    entry.connectionId === scope.connectionId
    && entry.runId === scope.runId
    && entry.generationSha256 === scope.credentialSetSha256
  ));
  if (matching.length !== 1) throw new Error("RUNTIME_FLEET_FENCE_SCOPE_NOT_FOUND");
  const entry = matching[0];
  if (await sha256Hex(entry.rawGrant) !== scope.writerFenceGrantSha256) {
    throw new Error("RUNTIME_FLEET_FENCE_GRANT_HASH_MISMATCH");
  }
  const grant = parseWriterFenceGrant(entry.rawGrant);
  if (grant.connectionId !== scope.connectionId || grant.runId !== scope.runId) {
    throw new Error("RUNTIME_FLEET_FENCE_GRANT_SCOPE_MISMATCH");
  }
  return Object.freeze({
    rawGrant: entry.rawGrant,
    proof: entry.proof,
    holderId: grant.holderId,
  });
}
