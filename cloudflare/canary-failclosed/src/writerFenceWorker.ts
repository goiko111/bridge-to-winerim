import { Client } from "pg";

import {
  createHyperdrivePostgresAdapter,
  sql,
  type DatabaseAdapter,
  type DriverQueryConfig,
  type HyperdriveBinding,
  type PostgresClientFactory,
} from "../../workers/middleware-api/src/db";
import {
  SecretsStoreSecretLike,
  validateActiveWriterFenceGrant,
  WriterFenceCredentialAttestation,
  WriterFenceCredentialKind,
  WriterFenceActiveScopeEvidence,
  WriterFenceGrant,
  WriterFenceGrantV3,
  WriterFenceLease,
} from "./writerFence";

type DurableStorageLike = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  transaction<T>(callback: (transaction: DurableStorageLike) => Promise<T>): Promise<T>;
};

type DurableStateLike = { storage: DurableStorageLike };
type DurableStubLike = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
type DurableNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableStubLike;
};

type WriterFenceWorkerEnvironment = {
  CONNECTION_WRITER_FENCE: DurableNamespaceLike;
  WRITER_FENCE_GRANT?: SecretsStoreSecretLike;
  MIDDLEWARE_DB?: HyperdriveBinding;
};

type WriterFenceWorkerDependencies = {
  database?: (env: WriterFenceWorkerEnvironment) => DatabaseAdapter;
};

type AcquireRequest = {
  connectionId: string;
  runId: string;
  holderId: string;
  ttlSeconds: number;
  rawGrant?: string;
  credential?: WriterFenceCredentialAttestation;
  requestNonce?: string;
};

type StoredLease = WriterFenceLease & { acquiredAt: string };
type LeaseCredential = Readonly<{
  reference: string;
  version: string;
  binding: string;
  kind?: WriterFenceCredentialKind;
  attestationSha256?: string;
  bundleSha256?: string;
}>;

interface ActiveScopeRow extends Record<string, unknown> {
  connection_id: string;
  run_id: string;
  writer_fence_grant_sha256: string;
  credential_set_sha256: string | null;
}

const MAX_REQUEST_GRANT_BYTES = 64 * 1024;
const NONCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_NONCE_RETENTION_MS = 2 * 60 * 60 * 1_000;
const MAX_RETAINED_REQUEST_NONCES = 4_096;

type StoredRequestNonce = Readonly<{ nonce: string; observedAt: number }>;

const createPostgresClient: PostgresClientFactory = ({ connectionString, applicationName }) => {
  const client = new Client({ connectionString, application_name: applicationName });
  return {
    connect: async () => {
      await client.connect();
    },
    query: async <Row extends Record<string, unknown>>(query: string | DriverQueryConfig) => {
      const result = await client.query<Row>(query);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    end: () => client.end(),
  };
};

function defaultDatabase(env: WriterFenceWorkerEnvironment): DatabaseAdapter {
  if (!env.MIDDLEWARE_DB) throw new Error("WRITER_FENCE_ACTIVE_SCOPE_DATABASE_MISSING");
  return createHyperdrivePostgresAdapter(env.MIDDLEWARE_DB, {
    createClient: createPostgresClient,
    applicationName: "winerim-writer-fence",
  });
}

async function loadActiveScopeEvidence(
  database: DatabaseAdapter,
  connectionId: string,
  runId: string,
): Promise<WriterFenceActiveScopeEvidence | null> {
  const result = await database.query<ActiveScopeRow>(sql`
    SELECT
      scope.connection_id::text AS connection_id,
      scope.run_id,
      scope.writer_fence_grant_sha256,
      scope.credential_set_sha256
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = ${connectionId}::uuid
      AND scope.run_id = ${runId}
      AND scope.active = true
      AND scope.status = 'ACTIVE'
      AND scope.approved_at <= now()
      AND scope.expires_at > now()
      AND scope.writer_fence_grant_sha256 IS NOT NULL
    LIMIT 2
  `);
  if (result.rowCount !== 1 || result.rows.length !== 1) return null;
  const row = result.rows[0];
  return {
    connectionId: String(row.connection_id),
    runId: String(row.run_id),
    writerFenceGrantSha256: String(row.writer_fence_grant_sha256),
    ...(row.credential_set_sha256 === null
      ? {}
      : { credentialSetSha256: String(row.credential_set_sha256) }),
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function acquireLease(
  storage: DurableStorageLike,
  request: AcquireRequest,
  credential: LeaseCredential,
  grantExpiresAt: string,
): Promise<StoredLease | null> {
  return storage.transaction(async (transaction) => {
    const now = Date.now();
    const leaseKey = credential.kind ? `lease:${credential.kind}` : "lease";
    const tokenKey = credential.kind ? `lastFencingToken:${credential.kind}` : "lastFencingToken";
    if (credential.kind) {
      const requestNonce = request.requestNonce ?? "";
      if (!NONCE_PATTERN.test(requestNonce)) {
        throw new Error("WRITER_FENCE_REQUEST_NONCE_REJECTED");
      }
      const replayKey = `requestNonces:${credential.kind}`;
      const retained = (await transaction.get<StoredRequestNonce[]>(replayKey) ?? [])
        .filter((entry) => Number.isFinite(entry.observedAt) && entry.observedAt > now - REQUEST_NONCE_RETENTION_MS)
        .slice(-(MAX_RETAINED_REQUEST_NONCES - 1));
      if (retained.some((entry) => entry.nonce === requestNonce)) {
        throw new Error("WRITER_FENCE_REQUEST_REPLAY_REJECTED");
      }
      await transaction.put(replayKey, [...retained, { nonce: requestNonce, observedAt: now }]);
    }
    const current = await transaction.get<StoredLease>(leaseKey);
    if (current && Date.parse(current.expiresAt) > now) {
      const sameHolder = current.connectionId === request.connectionId
        && current.runId === request.runId
        && current.holderId === request.holderId;
      const sameCredential = current.credentialReference === credential.reference
        && current.credentialVersion === credential.version
        && current.credentialBinding === credential.binding
        && current.credentialKind === credential.kind
        && current.credentialAttestationSha256 === credential.attestationSha256
        && current.credentialBundleSha256 === credential.bundleSha256;
      if (!sameHolder || !sameCredential) return null;
    }
    const lastToken = await transaction.get<number>(tokenKey) ?? 0;
    const renewal = current
      && current.runId === request.runId
      && current.holderId === request.holderId
      && Date.parse(current.expiresAt) > now;
    const fencingToken = renewal ? current.fencingToken : lastToken + 1;
    const requestedExpiry = now + request.ttlSeconds * 1_000;
    const grantExpiry = Date.parse(grantExpiresAt);
    const effectiveExpiry = Math.min(requestedExpiry, grantExpiry);
    if (!Number.isFinite(effectiveExpiry) || effectiveExpiry <= now) return null;
    const lease: StoredLease = {
      connectionId: request.connectionId,
      runId: request.runId,
      holderId: request.holderId,
      credentialReference: credential.reference,
      credentialVersion: credential.version,
      credentialBinding: credential.binding,
      ...(credential.kind ? {
        credentialKind: credential.kind,
        credentialAttestationSha256: credential.attestationSha256,
        credentialBundleSha256: credential.bundleSha256,
        requestNonce: request.requestNonce,
      } : {}),
      fencingToken,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(effectiveExpiry).toISOString(),
    };
    await transaction.put(leaseKey, lease);
    await transaction.put(tokenKey, fencingToken);
    return lease;
  });
}

function legacyLeaseCredential(grant: Exclude<WriterFenceGrant, WriterFenceGrantV3>): LeaseCredential {
  return {
    reference: grant.exclusiveCredentialRef,
    version: grant.credentialVersion,
    binding: grant.credentialBinding,
  };
}

function fleetLeaseCredential(
  grant: WriterFenceGrantV3,
  request: AcquireRequest,
): LeaseCredential {
  const requested = request.credential;
  const kind = requested?.kind;
  if (!requested || (kind !== "agora" && kind !== "winerim")) {
    throw new Error("WRITER_FENCE_FLEET_CREDENTIAL_KIND_REQUIRED");
  }
  if (
    requested.connectionId !== request.connectionId
    || requested.runId !== request.runId
    || requested.provider !== "agora"
  ) {
    throw new Error("WRITER_FENCE_FLEET_CREDENTIAL_SCOPE_MISMATCH");
  }
  const allowed = grant.credentialBundle.credentials[kind];
  if (
    requested.reference !== allowed.reference
    || requested.version !== allowed.attestationSha256
    || allowed.version !== allowed.attestationSha256
  ) {
    throw new Error("WRITER_FENCE_FLEET_CREDENTIAL_ATTESTATION_MISMATCH");
  }
  return {
    reference: allowed.reference,
    version: allowed.version,
    binding: allowed.binding,
    kind,
    attestationSha256: allowed.attestationSha256,
    bundleSha256: grant.credentialBundle.bundleSha256,
  };
}

export class ConnectionWriterFence {
  constructor(
    private readonly state: DurableStateLike,
    private readonly env: WriterFenceWorkerEnvironment,
    private readonly dependencies: WriterFenceWorkerDependencies = {},
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/leases/acquire") {
      return json(404, { error: "not_found" });
    }
    let body: AcquireRequest;
    try {
      body = await request.json() as AcquireRequest;
    } catch {
      return json(400, { error: "invalid_json" });
    }
    if (!Number.isInteger(body.ttlSeconds) || body.ttlSeconds < 30 || body.ttlSeconds > 120) {
      return json(422, { error: "invalid_lease_ttl" });
    }
    try {
      const proof = request.headers.get("x-writer-fence-proof") ?? "";
      const rawGrant = body.rawGrant ?? await this.env.WRITER_FENCE_GRANT?.get();
      if (typeof rawGrant !== "string" || rawGrant.length === 0) {
        throw new Error("WRITER_FENCE_GRANT_BINDING_MISSING");
      }
      if (new TextEncoder().encode(rawGrant).byteLength > MAX_REQUEST_GRANT_BYTES) {
        throw new Error("WRITER_FENCE_GRANT_TOO_LARGE");
      }
      const database = (this.dependencies.database ?? defaultDatabase)(this.env);
      const evidence = await loadActiveScopeEvidence(database, body.connectionId, body.runId);
      if (!evidence) throw new Error("WRITER_FENCE_ACTIVE_SCOPE_NOT_FOUND");
      const grant = await validateActiveWriterFenceGrant({
        rawGrant,
        proof,
        evidence,
        connectionId: body.connectionId,
        runId: body.runId,
        holderId: body.holderId,
      });
      if (grant.version === 3 && body.rawGrant === undefined) {
        throw new Error("WRITER_FENCE_FLEET_PER_CONNECTION_GRANT_REQUIRED");
      }
      const credential = grant.version === 3
        ? fleetLeaseCredential(grant, body)
        : legacyLeaseCredential(grant);
      const lease = await acquireLease(
        this.state.storage,
        body,
        credential,
        grant.expiresAt,
      );
      if (!lease) return json(409, { error: "writer_lease_held_by_other_runtime" });
      return json(200, lease);
    } catch (error) {
      return json(403, { error: error instanceof Error ? error.message : "writer_fence_rejected" });
    }
  }
}

export default {
  async fetch(request: Request, env: WriterFenceWorkerEnvironment): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/leases/acquire") {
      return json(404, { error: "not_found" });
    }
    let body: Partial<AcquireRequest>;
    try {
      body = await request.clone().json() as Partial<AcquireRequest>;
    } catch {
      return json(400, { error: "invalid_json" });
    }
    if (typeof body.connectionId !== "string" || body.connectionId.length === 0) {
      return json(422, { error: "connection_id_required" });
    }
    const id = env.CONNECTION_WRITER_FENCE.idFromName(body.connectionId);
    return env.CONNECTION_WRITER_FENCE.get(id).fetch(request);
  },
};
