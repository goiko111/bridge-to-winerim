import {
  sql,
  type DatabaseAdapter,
  type DatabaseTransaction,
} from "../../middleware-api/src/db";
import { canonicalJson, sha256Hex } from "../../middleware-runtime/src/idempotency";

const CATALOG_REMOTE_INTENT_JOB = "catalog.remote.apply.intent";
const DEFAULT_LEASE_SECONDS = 120;

export type CatalogRemoteIntentState =
  | "PREPARED"
  | "REMOTE_OUTCOME_UNKNOWN"
  | "REMOTE_CONFIRMED";

export type CatalogRemoteIntentIdentity = Readonly<{
  connectionId: string;
  messageId: string;
  planKey: string;
  planFingerprint: string;
  productFingerprints: Readonly<Record<string, string>>;
}>;

export type CatalogRemoteIntentLease = Readonly<{
  key: string;
  token: string;
  state: CatalogRemoteIntentState;
}>;

export type CatalogRemoteIntentPrepareResult =
  | Readonly<{ ok: true; outcome: "acquired"; lease: CatalogRemoteIntentLease }>
  | Readonly<{ ok: true; outcome: "completed" }>
  | Readonly<{ ok: false; code: "BUSY" | "CONFLICT" | "UNAVAILABLE" }>;

type IntentRow = Record<string, unknown> & Readonly<{
  idempotency_key: unknown;
  connection_id: unknown;
  job: unknown;
  status: unknown;
  result: unknown;
  lease_active: unknown;
}>;

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function boolean(value: unknown): boolean {
  return value === true || text(value).toLowerCase() === "true";
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function sortedFingerprints(value: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value)
      .map(([productId, fingerprint]) => [text(productId), text(fingerprint)] as const)
      .filter(([productId, fingerprint]) => /^\d+$/.test(productId) && /^[a-f0-9]{64}$/.test(fingerprint))
      .sort(([left], [right]) => Number(left) - Number(right)),
  );
}

function preparedResult(identity: CatalogRemoteIntentIdentity): Record<string, unknown> {
  return {
    version: 1,
    state: "PREPARED",
    planKey: identity.planKey,
    planFingerprint: identity.planFingerprint,
    productFingerprints: sortedFingerprints(identity.productFingerprints),
  };
}

function validIdentity(identity: CatalogRemoteIntentIdentity): boolean {
  const fingerprints = sortedFingerprints(identity.productFingerprints);
  return /^[0-9a-f-]{36}$/.test(identity.connectionId)
    && !!text(identity.messageId)
    && !!text(identity.planKey)
    && !!text(identity.planFingerprint)
    && Object.keys(fingerprints).length === Object.keys(identity.productFingerprints).length
    && Object.keys(fingerprints).length > 0;
}

async function intentKey(identity: CatalogRemoteIntentIdentity): Promise<string> {
  const digest = await sha256Hex(canonicalJson({
    version: 1,
    connectionId: identity.connectionId,
    planKey: identity.planKey,
    planFingerprint: identity.planFingerprint,
    productFingerprints: sortedFingerprints(identity.productFingerprints),
  }));
  return `catalog-remote-intent:v1:${digest}`;
}

function exactIntentRow(
  row: IntentRow | undefined,
  identity: CatalogRemoteIntentIdentity,
  key: string,
): row is IntentRow {
  if (!row) return false;
  const result = record(row.result);
  return text(row.idempotency_key) === key
    && text(row.connection_id) === identity.connectionId
    && text(row.job) === CATALOG_REMOTE_INTENT_JOB
    && Number(result.version) === 1
    && text(result.planKey) === identity.planKey
    && text(result.planFingerprint) === identity.planFingerprint
    && canonicalJson(record(result.productFingerprints)) === canonicalJson(sortedFingerprints(identity.productFingerprints));
}

function resumableState(value: unknown): CatalogRemoteIntentState | null {
  const state = text(value);
  return state === "PREPARED" || state === "REMOTE_OUTCOME_UNKNOWN" || state === "REMOTE_CONFIRMED"
    ? state
    : null;
}

async function prepareInTransaction(
  transaction: DatabaseTransaction,
  identity: CatalogRemoteIntentIdentity,
  key: string,
  token: string,
  leaseSeconds: number,
): Promise<CatalogRemoteIntentPrepareResult> {
  const metadata = JSON.stringify(preparedResult(identity));
  const inserted = await transaction.query<IntentRow>(sql`
    INSERT INTO public.runtime_idempotency (
      idempotency_key,
      message_id,
      connection_id,
      job,
      status,
      attempt,
      lease_expires_at,
      lease_token,
      result
    ) VALUES (
      ${key},
      ${identity.messageId},
      ${identity.connectionId}::uuid,
      ${CATALOG_REMOTE_INTENT_JOB},
      'RUNNING',
      1,
      now() + (${leaseSeconds} * interval '1 second'),
      ${token}::uuid,
      ${metadata}::jsonb
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING idempotency_key, connection_id, job, status, result, false AS lease_active
  `);
  if (inserted.rowCount === 1) {
    return { ok: true, outcome: "acquired", lease: { key, token, state: "PREPARED" } };
  }

  const current = await transaction.query<IntentRow>(sql`
    SELECT
      idempotency_key,
      connection_id,
      job,
      status,
      result,
      (lease_expires_at IS NOT NULL AND lease_expires_at > now()) AS lease_active
    FROM public.runtime_idempotency
    WHERE idempotency_key = ${key}
    FOR UPDATE
  `);
  const row = current.rows[0];
  if (!exactIntentRow(row, identity, key)) return { ok: false, code: "CONFLICT" };
  const result = record(row.result);
  if (text(row.status) === "SUCCESS" && text(result.state) === "COMPLETED") {
    return { ok: true, outcome: "completed" };
  }
  const state = resumableState(result.state);
  if (text(row.status) !== "RUNNING" || !state) return { ok: false, code: "CONFLICT" };
  if (boolean(row.lease_active)) return { ok: false, code: "BUSY" };

  const reacquired = await transaction.query<IntentRow>(sql`
    UPDATE public.runtime_idempotency
    SET
      message_id = ${identity.messageId},
      attempt = attempt + 1,
      lease_expires_at = now() + (${leaseSeconds} * interval '1 second'),
      lease_token = ${token}::uuid,
      updated_at = now()
    WHERE idempotency_key = ${key}
      AND connection_id = ${identity.connectionId}::uuid
      AND job = ${CATALOG_REMOTE_INTENT_JOB}
      AND status = 'RUNNING'
      AND (lease_expires_at IS NULL OR lease_expires_at <= now())
    RETURNING idempotency_key, connection_id, job, status, result, false AS lease_active
  `);
  return reacquired.rowCount === 1
    ? { ok: true, outcome: "acquired", lease: { key, token, state } }
    : { ok: false, code: "BUSY" };
}

export async function prepareCatalogRemoteIntent(
  database: DatabaseAdapter,
  identity: CatalogRemoteIntentIdentity,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<CatalogRemoteIntentPrepareResult> {
  if (!validIdentity(identity)) return { ok: false, code: "CONFLICT" };
  const boundedLeaseSeconds = Math.max(30, Math.min(300, Math.floor(leaseSeconds)));
  try {
    const key = await intentKey(identity);
    const token = crypto.randomUUID();
    return await database.transaction(
      (transaction) => prepareInTransaction(transaction, identity, key, token, boundedLeaseSeconds),
      { isolationLevel: "serializable", readOnly: false },
    );
  } catch {
    return { ok: false, code: "UNAVAILABLE" };
  }
}

async function updateOwnedIntent(
  database: DatabaseAdapter,
  identity: CatalogRemoteIntentIdentity,
  lease: CatalogRemoteIntentLease,
  patch: Readonly<Record<string, unknown>>,
  complete: boolean,
): Promise<boolean> {
  try {
    const result = complete
      ? await database.query<IntentRow>(sql`
        UPDATE public.runtime_idempotency
        SET
          status = 'SUCCESS',
          result = result || ${JSON.stringify(patch)}::jsonb,
          lease_expires_at = NULL,
          lease_token = NULL,
          updated_at = now()
        WHERE idempotency_key = ${lease.key}
          AND connection_id = ${identity.connectionId}::uuid
          AND job = ${CATALOG_REMOTE_INTENT_JOB}
          AND status = 'RUNNING'
          AND lease_token = ${lease.token}::uuid
        RETURNING idempotency_key, connection_id, job, status, result, false AS lease_active
      `)
      : await database.query<IntentRow>(sql`
        UPDATE public.runtime_idempotency
        SET
          result = result || ${JSON.stringify(patch)}::jsonb,
          updated_at = now()
        WHERE idempotency_key = ${lease.key}
          AND connection_id = ${identity.connectionId}::uuid
          AND job = ${CATALOG_REMOTE_INTENT_JOB}
          AND status = 'RUNNING'
          AND lease_token = ${lease.token}::uuid
        RETURNING idempotency_key, connection_id, job, status, result, false AS lease_active
      `);
    return result.rowCount === 1 && exactIntentRow(result.rows[0], identity, lease.key);
  } catch {
    return false;
  }
}

export function markCatalogRemoteIntentUnknown(
  database: DatabaseAdapter,
  identity: CatalogRemoteIntentIdentity,
  lease: CatalogRemoteIntentLease,
): Promise<boolean> {
  return updateOwnedIntent(database, identity, lease, {
    state: "REMOTE_OUTCOME_UNKNOWN",
    remoteOutcome: "UNKNOWN",
  }, false);
}

export function confirmCatalogRemoteIntentReadback(
  database: DatabaseAdapter,
  identity: CatalogRemoteIntentIdentity,
  lease: CatalogRemoteIntentLease,
  remoteStatus: "applied" | "duplicate",
): Promise<boolean> {
  return updateOwnedIntent(database, identity, lease, {
    state: "REMOTE_CONFIRMED",
    remoteOutcome: remoteStatus.toUpperCase(),
    observedProductFingerprints: sortedFingerprints(identity.productFingerprints),
  }, false);
}

export function completeCatalogRemoteIntent(
  database: DatabaseAdapter,
  identity: CatalogRemoteIntentIdentity,
  lease: CatalogRemoteIntentLease,
): Promise<boolean> {
  return updateOwnedIntent(database, identity, lease, {
    state: "COMPLETED",
  }, true);
}
