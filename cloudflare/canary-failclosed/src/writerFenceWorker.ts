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
  WriterFenceActiveScopeEvidence,
  WriterFenceGrant,
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
  WRITER_FENCE_GRANT: SecretsStoreSecretLike;
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
};

type StoredLease = WriterFenceLease & { acquiredAt: string };
type LeaseCredential = Pick<
  WriterFenceGrant,
  "exclusiveCredentialRef" | "credentialVersion" | "credentialBinding"
>;

interface ActiveScopeRow extends Record<string, unknown> {
  connection_id: string;
  run_id: string;
  writer_fence_grant_sha256: string;
}

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
      scope.writer_fence_grant_sha256
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = ${connectionId}::uuid
      AND scope.run_id = ${runId}
      AND scope.active = true
      AND scope.status = 'ACTIVE'
      AND scope.writer_fence_grant_sha256 IS NOT NULL
    LIMIT 2
  `);
  if (result.rowCount !== 1 || result.rows.length !== 1) return null;
  const row = result.rows[0];
  return {
    connectionId: String(row.connection_id),
    runId: String(row.run_id),
    writerFenceGrantSha256: String(row.writer_fence_grant_sha256),
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
    const current = await transaction.get<StoredLease>("lease");
    if (current && Date.parse(current.expiresAt) > now) {
      const sameHolder = current.connectionId === request.connectionId
        && current.runId === request.runId
        && current.holderId === request.holderId;
      const sameCredential = current.credentialReference === credential.exclusiveCredentialRef
        && current.credentialVersion === credential.credentialVersion
        && current.credentialBinding === credential.credentialBinding;
      if (!sameHolder || !sameCredential) return null;
    }
    const lastToken = await transaction.get<number>("lastFencingToken") ?? 0;
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
      credentialReference: credential.exclusiveCredentialRef,
      credentialVersion: credential.credentialVersion,
      credentialBinding: credential.credentialBinding,
      fencingToken,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(effectiveExpiry).toISOString(),
    };
    await transaction.put("lease", lease);
    await transaction.put("lastFencingToken", fencingToken);
    return lease;
  });
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
      const rawGrant = await this.env.WRITER_FENCE_GRANT.get();
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
      const lease = await acquireLease(
        this.state.storage,
        body,
        grant,
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
