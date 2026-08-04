import { validateCredentialScope } from "./crypto";

type DurableStorageLike = {
  deleteAll(): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(timestamp: number | Date): Promise<void>;
  transaction<T>(callback: (transaction: Pick<DurableStorageLike, "get" | "put">) => Promise<T>): Promise<T>;
};

type DurableStateLike = Readonly<{ storage: DurableStorageLike }>;

export type ChallengeBinding = Readonly<{
  version: 1;
  challengeId: string;
  challengeNonce: string;
  connectionId: string;
  runId: string;
  keyVersion: string;
  operatorKeyId: string;
  principalSha256: string;
  expiresAt: string;
}>;

type StoredChallenge = ChallengeBinding & Readonly<{ consumedAt: string | null }>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function validateBinding(binding: ChallengeBinding): void {
  validateCredentialScope(binding);
  if (binding.version !== 1) throw new Error("CHALLENGE_INVALID");
  if (!/^[0-9a-f-]{36}$/i.test(binding.challengeId)) throw new Error("CHALLENGE_INVALID");
  if (!/^[A-Za-z0-9_-]{43}$/.test(binding.challengeNonce)) throw new Error("CHALLENGE_INVALID");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(binding.operatorKeyId)) throw new Error("CHALLENGE_INVALID");
  if (!/^[a-f0-9]{64}$/.test(binding.principalSha256)) throw new Error("CHALLENGE_INVALID");
  const expiresAt = Date.parse(binding.expiresAt);
  if (!Number.isFinite(expiresAt)) throw new Error("CHALLENGE_INVALID");
}

function bindingsMatch(left: ChallengeBinding, right: ChallengeBinding): boolean {
  return left.version === right.version
    && left.challengeId === right.challengeId
    && left.challengeNonce === right.challengeNonce
    && left.connectionId === right.connectionId
    && left.runId === right.runId
    && left.keyVersion === right.keyVersion
    && left.operatorKeyId === right.operatorKeyId
    && left.principalSha256 === right.principalSha256
    && left.expiresAt === right.expiresAt;
}

export class RuntimeCredentialChallenge {
  constructor(private readonly state: DurableStateLike) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return json(404, { error: "not_found" });
    const pathname = new URL(request.url).pathname;
    let binding: ChallengeBinding;
    try {
      binding = await request.json() as ChallengeBinding;
      validateBinding(binding);
    } catch {
      return json(422, { error: "challenge_rejected" });
    }
    if (pathname === "/internal/issue") {
      const issued = await this.state.storage.transaction(async (storage) => {
        if (await storage.get<StoredChallenge>("challenge")) return false;
        if (Date.parse(binding.expiresAt) <= Date.now()) return false;
        await storage.put("challenge", { ...binding, consumedAt: null });
        return true;
      });
      if (issued) {
        try {
          await this.state.storage.setAlarm(Date.parse(binding.expiresAt) + 60_000);
        } catch {
          await this.state.storage.deleteAll();
          return json(503, { error: "challenge_rejected" });
        }
      }
      return issued ? json(201, { issued: true }) : json(409, { error: "challenge_rejected" });
    }
    if (pathname === "/internal/consume") {
      const consumed = await this.state.storage.transaction(async (storage) => {
        const stored = await storage.get<StoredChallenge>("challenge");
        if (
          !stored
          || stored.consumedAt !== null
          || Date.parse(stored.expiresAt) <= Date.now()
          || !bindingsMatch(stored, binding)
        ) return false;
        await storage.put("challenge", { ...stored, consumedAt: new Date().toISOString() });
        return true;
      });
      return consumed ? json(200, { consumed: true }) : json(409, { error: "challenge_rejected" });
    }
    return json(404, { error: "not_found" });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}
