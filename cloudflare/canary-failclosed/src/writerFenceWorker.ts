import {
  parseWriterFenceGrant,
  SecretsStoreSecretLike,
  validateWriterFenceGrant,
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
};

type AcquireRequest = {
  connectionId: string;
  runId: string;
  holderId: string;
  ttlSeconds: number;
};

type StoredLease = WriterFenceLease & { acquiredAt: string };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function acquireLease(
  storage: DurableStorageLike,
  request: AcquireRequest,
  credentialVersion: string,
): Promise<StoredLease | null> {
  return storage.transaction(async (transaction) => {
    const now = Date.now();
    const current = await transaction.get<StoredLease>("lease");
    if (
      current
      && Date.parse(current.expiresAt) > now
      && (current.runId !== request.runId || current.holderId !== request.holderId)
    ) {
      return null;
    }
    const lastToken = await transaction.get<number>("lastFencingToken") ?? 0;
    const renewal = current
      && current.runId === request.runId
      && current.holderId === request.holderId
      && Date.parse(current.expiresAt) > now;
    const fencingToken = renewal ? current.fencingToken : lastToken + 1;
    const lease: StoredLease = {
      connectionId: request.connectionId,
      runId: request.runId,
      holderId: request.holderId,
      credentialVersion,
      fencingToken,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + request.ttlSeconds * 1_000).toISOString(),
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
      const grant = parseWriterFenceGrant(await this.env.WRITER_FENCE_GRANT.get());
      await validateWriterFenceGrant({
        grant,
        proof,
        connectionId: body.connectionId,
        runId: body.runId,
        holderId: body.holderId,
      });
      const lease = await acquireLease(this.state.storage, body, grant.credentialVersion);
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
