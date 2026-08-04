import { sql, type DatabaseAdapter } from "../../middleware-api/src/db";
import type { WinerimCatalogFormat } from "../../middleware-runtime/src/adapters/http";

export type CatalogChange = Readonly<{
  connectionId: string;
  winerimWineId: string;
  format: WinerimCatalogFormat;
  sourceFingerprint: string;
  attempt: number;
}>;

export type CatalogChangeDecision =
  | Readonly<{ status: "SUCCESS" }>
  | Readonly<{ status: "PENDING"; retryAfterSeconds: number; error: string }>
  | Readonly<{ status: "BLOCKED"; error: string }>;

export type CatalogChangeQueuePort = Readonly<{
  claim(input: Readonly<{ connectionId: string; limit: number }>): Promise<readonly CatalogChange[]>;
  settle(change: CatalogChange, decision: CatalogChangeDecision): Promise<boolean>;
  peek(input: Readonly<{ connectionId: string; limit: number }>): Promise<readonly CatalogChange[]>;
}>;

type ChangeRow = Record<string, unknown> & {
  connection_id: unknown;
  winerim_wine_id: unknown;
  format: unknown;
  source_fingerprint: unknown;
  attempt: unknown;
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function format(value: unknown): WinerimCatalogFormat | null {
  const normalized = text(value).toUpperCase();
  return ["BOTTLE", "GLASS", "MAGNUM"].includes(normalized)
    ? normalized as WinerimCatalogFormat
    : null;
}

function change(row: ChangeRow): CatalogChange | null {
  const connectionId = text(row.connection_id);
  const winerimWineId = text(row.winerim_wine_id);
  const normalizedFormat = format(row.format);
  const sourceFingerprint = text(row.source_fingerprint).toLowerCase();
  const attempt = Number(row.attempt);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(connectionId)
    || !/^[1-9][0-9]{0,17}$/.test(winerimWineId)
    || !normalizedFormat
    || !/^[a-f0-9]{64}$/.test(sourceFingerprint)
    || !Number.isInteger(attempt)
    || attempt < 0
    || attempt > 20
  ) return null;
  return { connectionId, winerimWineId, format: normalizedFormat, sourceFingerprint, attempt };
}

function changes(rows: readonly ChangeRow[]): CatalogChange[] {
  const parsed = rows.map(change);
  if (parsed.some((item) => !item)) throw new Error("CATALOG_CHANGE_ROW_INVALID");
  return parsed as CatalogChange[];
}

function boundedLimit(value: number): number {
  return Number.isInteger(value) ? Math.max(1, Math.min(10, value)) : 1;
}

const CLAIM_LEASE_SECONDS = 120;

function safeError(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(normalized)
    ? normalized
    : "CATALOG_CHANGE_FAILED";
}

export function createPostgresCatalogChangeQueue(database: DatabaseAdapter): CatalogChangeQueuePort {
  return Object.freeze({
    async peek(input) {
      const result = await database.query<ChangeRow>(sql`
        SELECT connection_id, winerim_wine_id, format, source_fingerprint, attempt
        FROM public.runtime_catalog_changes
        WHERE connection_id = ${input.connectionId}::uuid
          AND status = 'PENDING'
          AND available_at <= now()
          AND attempt < 20
        ORDER BY available_at, updated_at, winerim_wine_id, format
        LIMIT ${boundedLimit(input.limit)}
      `);
      return changes(result.rows);
    },
    async claim(input) {
      return database.transaction(async (transaction) => {
        const result = await transaction.query<ChangeRow>(sql`
          WITH exhausted AS (
            UPDATE public.runtime_catalog_changes
            SET status = 'BLOCKED',
                claimed_at = COALESCE(claimed_at, now()),
                lease_expires_at = NULL,
                completed_at = now(),
                last_error = 'CATALOG_CHANGE_ATTEMPTS_EXHAUSTED',
                updated_at = now()
            WHERE connection_id = ${input.connectionId}::uuid
              AND attempt >= 20
              AND (
                (status = 'PENDING' AND available_at <= now())
                OR (status = 'RUNNING' AND lease_expires_at <= now())
              )
            RETURNING connection_id
          ), candidates AS (
            SELECT connection_id, winerim_wine_id, format
            FROM public.runtime_catalog_changes
            WHERE connection_id = ${input.connectionId}::uuid
              AND attempt < 20
              AND (
                (status = 'PENDING' AND available_at <= now())
                OR (status = 'RUNNING' AND lease_expires_at <= now())
              )
            ORDER BY available_at, updated_at, winerim_wine_id, format
            FOR UPDATE SKIP LOCKED
            LIMIT ${boundedLimit(input.limit)}
          )
          UPDATE public.runtime_catalog_changes change
          SET status = 'RUNNING',
              attempt = change.attempt + 1,
              claimed_at = now(),
              lease_expires_at = now() + (${CLAIM_LEASE_SECONDS} * interval '1 second'),
              completed_at = NULL,
              last_error = NULL,
              updated_at = now()
          FROM candidates
          WHERE change.connection_id = candidates.connection_id
            AND change.winerim_wine_id = candidates.winerim_wine_id
            AND change.format = candidates.format
          RETURNING change.connection_id, change.winerim_wine_id, change.format,
                    change.source_fingerprint, change.attempt
        `);
        return changes(result.rows);
      }, { isolationLevel: "read-committed" });
    },
    async settle(item, decision) {
      const pending = decision.status === "PENDING";
      const result = await database.query(sql`
        UPDATE public.runtime_catalog_changes
        SET status = ${decision.status},
            available_at = ${pending
              ? new Date(Date.now() + Math.max(1, Math.min(3600, decision.retryAfterSeconds)) * 1000).toISOString()
              : new Date().toISOString()}::timestamptz,
            claimed_at = CASE WHEN ${pending} THEN NULL ELSE claimed_at END,
            lease_expires_at = NULL,
            completed_at = CASE WHEN ${pending} THEN NULL ELSE now() END,
            last_error = ${decision.status === "SUCCESS" ? null : safeError(decision.error)},
            updated_at = now()
        WHERE connection_id = ${item.connectionId}::uuid
          AND winerim_wine_id = ${item.winerimWineId}
          AND format = ${item.format}
          AND source_fingerprint = ${item.sourceFingerprint}
          AND status = 'RUNNING'
          AND attempt = ${item.attempt}
        RETURNING connection_id
      `);
      return result.rowCount === 1;
    },
  });
}
