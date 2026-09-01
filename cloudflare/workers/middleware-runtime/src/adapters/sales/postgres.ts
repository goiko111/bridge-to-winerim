import {
  sql,
  type DatabaseAdapter,
  type DatabaseTransaction,
} from "../../../../middleware-api/src/db";
import type { JsonValue } from "../../contracts";
import { canonicalJson, sha256Hex } from "../../idempotency";
import type {
  ProviderSalesDocument,
  SalesClaimReservation,
  SalesClaimSnapshot,
  SalesMutationIntent,
  SalesVariant,
} from "../../handlers/sales";
import type {
  CursorAdvancePlan,
  ExactSalesMapping,
  PostgresSalesAdapter,
  PostgresSalesAdapterOptions,
  ProviderProductSalesClassification,
  SalesClaimReadback,
  SalesDocumentsReadback,
  SalesEventReadback,
  SalesLineReadback,
  SalesReadbackFilter,
} from "./types";

type MappingRow = {
  mapping_id: unknown;
  provider_product_id: unknown;
  provider_product_name: unknown;
  winerim_wine_id: unknown;
  format_type: unknown;
  stock_id: unknown;
  stock_active: unknown;
};

type ProductClassificationRow = {
  provider_product_id: unknown;
  family: unknown;
  is_wine_candidate: unknown;
  classification_override: unknown;
  last_score: unknown;
  wine_score: unknown;
};

type ClaimRow = {
  idempotency_key: unknown;
  message_id: unknown;
  job: unknown;
  status: unknown;
  applied_quantity: unknown;
  lease_expires_at: unknown;
  lease_expired?: unknown;
  payload_sha256?: unknown;
  lease_token?: unknown;
  result: unknown;
  updated_at: unknown;
};

type EventRow = {
  id: unknown;
  connection_id: unknown;
  provider_doc_id: unknown;
  business_day: unknown;
  doc_type: unknown;
  line_count: unknown;
  total_amount: unknown;
  raw_json: unknown;
  created_at: unknown;
};

type LineRow = {
  id: unknown;
  sales_event_id: unknown;
  provider_product_id: unknown;
  name: unknown;
  format: unknown;
  quantity: unknown;
  unit_price: unknown;
  total_amount: unknown;
  mapped: unknown;
  winerim_product_id: unknown;
  provider_sold_at: unknown;
};

const CLAIM_JOB = "sales.claim";
const DEFAULT_CLAIM_LEASE_SECONDS = 120;

export class PostgresSalesAdapterInvariantError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PostgresSalesAdapterInvariantError";
  }
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function nullableText(value: unknown): string | null {
  const normalized = text(value);
  return normalized || null;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function boolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes"].includes(text(value).toLowerCase());
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function normalizeVariant(value: unknown): SalesVariant | null {
  const normalized = text(value).trim().toUpperCase();
  if (["BOTTLE", "BOTELLA", "BOT"].includes(normalized)) return "BOTTLE";
  if (["GLASS", "COPA", "C"].includes(normalized)) return "GLASS";
  if (["MAGNUM", "M"].includes(normalized)) return "MAGNUM";
  return null;
}

function claimState(status: unknown): SalesClaimSnapshot["state"] {
  if (status === "SUCCESS") return "COMPLETE";
  if (status === "RUNNING") return "PENDING";
  return "FAILED";
}

function mappingFromRow(row: MappingRow): ExactSalesMapping | null {
  const variant = normalizeVariant(row.format_type);
  const wineId = text(row.winerim_wine_id);
  if (!variant || !wineId) return null;
  return {
    mappingId: text(row.mapping_id),
    mappingStatus: "CONFIRMED",
    providerProductId: text(row.provider_product_id),
    providerProductName: text(row.provider_product_name),
    winerimWineId: wineId,
    variant,
    stockId: nullableText(row.stock_id) ?? undefined,
    stockActive: boolean(row.stock_active),
  };
}

function productClassificationFromRow(
  row: ProductClassificationRow,
): ProviderProductSalesClassification | null {
  const providerProductId = text(row.provider_product_id).trim();
  if (!providerProductId) return null;
  const override = text(row.classification_override).trim().toUpperCase();
  let classification: ProviderProductSalesClassification["classification"];
  if (override === "WINE") {
    classification = "WINE";
  } else if (override === "NOT_WINE") {
    classification = "NOT_WINE";
  } else if (override && override !== "AUTO") {
    classification = "AMBIGUOUS";
  } else if (row.is_wine_candidate === true) {
    classification = "WINE";
  } else if (row.is_wine_candidate === false) {
    classification = number(row.last_score ?? row.wine_score) > 0 ? "AMBIGUOUS" : "NOT_WINE";
  } else {
    classification = "AMBIGUOUS";
  }
  return {
    providerProductId,
    familyName: nullableText(row.family),
    classification,
  };
}

async function selectExactMappings(
  database: DatabaseTransaction,
  connectionId: string,
  providerProductIds: string[],
): Promise<ExactSalesMapping[]> {
  const ids = Array.from(new Set(providerProductIds.map(String).filter(Boolean))).sort();
  if (ids.length === 0) return [];
  const result = await database.query<MappingRow>(sql`
    SELECT
      pm.id AS mapping_id,
      pm.provider_product_id,
      pm.provider_product_name,
      pm.winerim_wine_id,
      pm.format_type,
      CASE
        WHEN upper(pm.format_type) IN ('GLASS', 'COPA', 'C') THEN ww.glass_stock_id
        WHEN upper(pm.format_type) IN ('MAGNUM', 'M') THEN ww.magnum_stock_id
        ELSE ww.bottle_stock_id
      END::text AS stock_id,
      stock_contract.stock_active
    FROM public.product_mappings pm
    LEFT JOIN public.winerim_wines ww
      ON ww.connection_id = pm.connection_id
     AND ww.winerim_id = pm.winerim_wine_id
    JOIN LATERAL (
      SELECT
        bool_and((stock_entry->>'stockActive')::boolean) AS stock_active,
        count(*) AS stock_count
        FROM jsonb_array_elements(COALESCE(ww.raw_payload->'stocks', '[]'::jsonb)) stock_entry
        WHERE stock_entry->>'id' = (
          CASE
            WHEN upper(pm.format_type) IN ('GLASS', 'COPA', 'C') THEN ww.glass_stock_id
            WHEN upper(pm.format_type) IN ('MAGNUM', 'M') THEN ww.magnum_stock_id
            ELSE ww.bottle_stock_id
          END
        )::text
          AND jsonb_typeof(stock_entry->'stockActive') = 'boolean'
    ) stock_contract ON stock_contract.stock_count = 1
    WHERE pm.connection_id = ${connectionId}::uuid
      AND pm.provider_product_id = ANY(${ids}::text[])
      AND pm.status = 'CONFIRMED'
      AND pm.winerim_wine_id IS NOT NULL
      AND (
        (stock_contract.stock_active IS TRUE AND pm.match_method = 'RESCUE_EXACT_ID_WINE_VARIANT')
        OR (stock_contract.stock_active IS FALSE AND pm.match_method = 'RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY')
      )
    ORDER BY pm.provider_product_id ASC
  `);
  return result.rows.map(mappingFromRow).filter((row): row is ExactSalesMapping => !!row);
}

function totalAmount(document: ProviderSalesDocument): number {
  return document.lines.reduce((sum, line) => {
    if (line.totalAmount !== undefined) return sum + line.totalAmount;
    return sum + (line.unitPrice ?? 0) * line.quantity;
  }, 0);
}

function claimMetadata(intent: SalesMutationIntent, appliedQuantity: number): Record<string, unknown> {
  return {
    appliedQuantity,
    orderId: intent.orderId,
    provider: intent.provider,
    businessDay: intent.businessDay,
    lifecycleId: intent.lifecycleId,
    winerimWineId: intent.winerimWineId,
    variant: intent.variant,
    sourceDocumentIds: intent.sourceDocumentIds,
    sourceLineIds: intent.sourceLineIds,
    sourceDocumentKind: intent.sourceDocumentKind,
  };
}

export async function buildSalesClaimPayloadHash(
  intent: SalesMutationIntent,
  appliedQuantityBefore = intent.observedAppliedQuantity,
): Promise<string> {
  const payload = JSON.parse(JSON.stringify({
    version: 1,
    claimKey: intent.claimKey,
    orderId: intent.orderId,
    connectionId: intent.connectionId,
    provider: intent.provider,
    businessDay: intent.businessDay,
    lifecycleId: intent.lifecycleId,
    winerimWineId: intent.winerimWineId,
    variant: intent.variant,
    desiredQuantity: intent.desiredQuantity,
    appliedQuantityBefore,
    action: intent.action,
  })) as JsonValue;
  return sha256Hex(canonicalJson(payload));
}

function claimSnapshot(row: ClaimRow): SalesClaimSnapshot {
  const result = jsonRecord(row.result);
  const variant = normalizeVariant(result.variant) ?? undefined;
  const sourceDocumentKind = result.sourceDocumentKind === "OPEN_TICKET"
    || result.sourceDocumentKind === "DEFINITIVE_INVOICE"
    ? result.sourceDocumentKind
    : undefined;
  return {
    claimKey: text(row.idempotency_key),
    state: claimState(row.status),
    appliedQuantity: number(row.applied_quantity ?? result.appliedQuantity),
    ...(text(result.lifecycleId) ? { lifecycleId: text(result.lifecycleId) } : {}),
    ...(text(result.winerimWineId) ? { winerimWineId: text(result.winerimWineId) } : {}),
    ...(variant ? { variant } : {}),
    ...(stringArray(result.sourceDocumentIds).length > 0
      ? { sourceDocumentIds: stringArray(result.sourceDocumentIds) }
      : {}),
    ...(stringArray(result.sourceLineIds).length > 0
      ? { sourceLineIds: stringArray(result.sourceLineIds) }
      : {}),
    ...(sourceDocumentKind ? { sourceDocumentKind } : {}),
  };
}

function assertScope(
  options: PostgresSalesAdapterOptions,
  input: { connectionId: string; provider?: string },
): void {
  if (input.connectionId !== options.connectionId) {
    throw new PostgresSalesAdapterInvariantError("SALES_ADAPTER_CONNECTION_SCOPE_MISMATCH");
  }
  if (input.provider !== undefined && input.provider !== options.provider) {
    throw new PostgresSalesAdapterInvariantError("SALES_ADAPTER_PROVIDER_SCOPE_MISMATCH");
  }
}

function leaseSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CLAIM_LEASE_SECONDS;
  if (!Number.isInteger(value) || value < 15 || value > 900) {
    throw new PostgresSalesAdapterInvariantError("SALES_ADAPTER_INVALID_CLAIM_LEASE");
  }
  return value;
}

function mapEvent(row: EventRow): SalesEventReadback {
  const raw = jsonRecord(row.raw_json);
  return {
    id: text(row.id),
    connectionId: text(row.connection_id),
    providerDocumentId: text(row.provider_doc_id),
    businessDay: text(row.business_day).slice(0, 10),
    documentType: text(row.doc_type),
    lineCount: number(row.line_count),
    totalAmount: number(row.total_amount),
    rawDocument: Object.keys(raw).length > 0 ? raw as ProviderSalesDocument : null,
    createdAt: text(row.created_at),
  };
}

function mapLine(row: LineRow): SalesLineReadback {
  return {
    id: text(row.id),
    salesEventId: text(row.sales_event_id),
    providerProductId: nullableText(row.provider_product_id),
    name: text(row.name),
    format: nullableText(row.format),
    quantity: number(row.quantity),
    unitPrice: number(row.unit_price),
    totalAmount: number(row.total_amount),
    mapped: boolean(row.mapped),
    winerimProductId: nullableText(row.winerim_product_id),
    providerSoldAt: nullableText(row.provider_sold_at),
  };
}

function mapClaim(row: ClaimRow): SalesClaimReadback {
  const result = jsonRecord(row.result);
  return {
    claimKey: text(row.idempotency_key),
    state: claimState(row.status),
    appliedQuantity: number(row.applied_quantity ?? result.appliedQuantity),
    orderId: text(row.message_id),
    job: text(row.job),
    leaseExpiresAt: nullableText(row.lease_expires_at),
    updatedAt: text(row.updated_at),
    result,
  };
}

export function createPostgresSalesAdapter(
  database: DatabaseAdapter,
  options: PostgresSalesAdapterOptions,
): PostgresSalesAdapter {
  const claimLeaseSeconds = leaseSeconds(options.claimLeaseSeconds);

  const readExactMappings = (providerProductIds: string[]) =>
    selectExactMappings(database, options.connectionId, providerProductIds);

  const readProductClassifications = async (
    providerProductIds: string[],
    familyNames: string[],
  ): Promise<ProviderProductSalesClassification[]> => {
    const ids = Array.from(new Set(providerProductIds.map(String).map((value) => value.trim()).filter(Boolean))).sort();
    const families = Array.from(new Set(
      familyNames.map(String).map((value) => value.trim().toLowerCase()).filter(Boolean),
    )).sort();
    if (ids.length === 0 && families.length === 0) return [];
    const result = await database.transaction(async (transaction) => transaction.query<ProductClassificationRow>(sql`
      SELECT
        provider_product_id,
        family,
        is_wine_candidate,
        classification_override,
        last_score,
        wine_score
      FROM public.provider_products
      WHERE connection_id = ${options.connectionId}::uuid
        AND (
          provider_product_id = ANY(${ids}::text[])
          OR lower(btrim(COALESCE(family, ''))) = ANY(${families}::text[])
        )
      ORDER BY provider_product_id ASC
    `), { isolationLevel: "repeatable-read", readOnly: true });
    return result.rows
      .map(productClassificationFromRow)
      .filter((row): row is ProviderProductSalesClassification => !!row);
  };

  const readClaims = async (claimKeys: string[] = []): Promise<SalesClaimReadback[]> => {
    const keys = Array.from(new Set(claimKeys.map(String).filter(Boolean))).sort();
    const result = await database.transaction(async (transaction) => transaction.query<ClaimRow>(sql`
      SELECT
        idempotency_key,
        message_id,
        job,
        status,
        COALESCE((result ->> 'appliedQuantity')::numeric, 0) AS applied_quantity,
        lease_expires_at,
        result,
        updated_at
      FROM public.runtime_idempotency
      WHERE connection_id = ${options.connectionId}::uuid
        AND job = ${CLAIM_JOB}
        AND (cardinality(${keys}::text[]) = 0 OR idempotency_key = ANY(${keys}::text[]))
      ORDER BY updated_at DESC
    `), { isolationLevel: "repeatable-read", readOnly: true });
    return result.rows.map(mapClaim);
  };

  const loadReconciliationClaims: NonNullable<PostgresSalesAdapter["loadReconciliationClaims"]> = async (input) => {
    const lifecycleIds = Array.from(new Set(input.lifecycleIds.map(String).filter(Boolean))).sort();
    const result = await database.transaction(async (transaction) => transaction.query<ClaimRow>(sql`
      SELECT
        ri.idempotency_key,
        ri.message_id,
        ri.job,
        ri.status,
        COALESCE((ri.result ->> 'appliedQuantity')::numeric, 0) AS applied_quantity,
        ri.lease_expires_at,
        ri.payload_sha256,
        ri.lease_token,
        ri.result,
        ri.updated_at
      FROM public.runtime_idempotency ri
      WHERE ri.connection_id = ${options.connectionId}::uuid
        AND ri.job = ${CLAIM_JOB}
        AND (
          ri.status = 'RUNNING'
          OR COALESCE((ri.result ->> 'appliedQuantity')::numeric, 0) > 0
        )
        AND (
          ri.result ->> 'lifecycleId' = ANY(${lifecycleIds}::text[])
          OR (
            ${input.includeMissingOpenTickets}
            AND (
              ri.result ->> 'sourceDocumentKind' = 'OPEN_TICKET'
              OR EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(
                  CASE
                    WHEN jsonb_typeof(ri.result -> 'sourceDocumentIds') = 'array'
                      THEN ri.result -> 'sourceDocumentIds'
                    ELSE '[]'::jsonb
                  END
                ) source(document_id)
                JOIN public.sales_events open_event
                  ON open_event.connection_id = ri.connection_id
                 AND open_event.provider_doc_id = source.document_id
                 AND open_event.doc_type = 'OpenTicket'
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.sales_events definitive_event
              WHERE definitive_event.connection_id = ri.connection_id
                AND definitive_event.doc_type = 'BasicInvoice'
                AND definitive_event.raw_json ->> 'lifecycleId' = ri.result ->> 'lifecycleId'
            )
          )
        )
      ORDER BY ri.updated_at DESC
    `), { isolationLevel: "repeatable-read", readOnly: true });
    return result.rows.map(claimSnapshot);
  };

  const persistDocuments = async (documents: ProviderSalesDocument[]): Promise<void> => {
    for (const document of documents) {
      assertScope(options, { connectionId: options.connectionId, provider: document.provider });
    }
    await database.transaction(async (transaction) => {
      const mappingRows = await selectExactMappings(
        transaction,
        options.connectionId,
        documents.flatMap((document) => document.lines.flatMap((line) => [
          line.providerProductId,
          line.saleFormatId ?? "",
        ])),
      );
      const mappings = new Map(mappingRows.map((mapping) => [mapping.providerProductId, mapping]));

      for (const document of documents) {
        const amount = totalAmount(document);
        const event = await transaction.query<{ id: unknown }>(sql`
          INSERT INTO public.sales_events (
            connection_id,
            provider_doc_id,
            business_day,
            doc_type,
            total_amount,
            total_tax,
            total_net,
            line_count,
            raw_json
          ) VALUES (
            ${options.connectionId}::uuid,
            ${document.documentId},
            ${document.businessDay}::date,
            ${document.kind === "OPEN_TICKET" ? "OpenTicket" : "BasicInvoice"},
            ${amount},
            ${0},
            ${amount},
            ${document.lines.length},
            ${JSON.stringify(document)}::jsonb
          )
          ON CONFLICT (connection_id, provider_doc_id) DO UPDATE SET
            business_day = EXCLUDED.business_day,
            doc_type = EXCLUDED.doc_type,
            total_amount = EXCLUDED.total_amount,
            total_tax = EXCLUDED.total_tax,
            total_net = EXCLUDED.total_net,
            line_count = EXCLUDED.line_count,
            raw_json = EXCLUDED.raw_json
          RETURNING id
        `);
        const eventId = text(event.rows[0]?.id);
        if (!eventId) throw new PostgresSalesAdapterInvariantError("SALES_EVENT_UPSERT_NO_ID");

        await transaction.query(sql`
          DELETE FROM public.sales_line_items
          WHERE sales_event_id = ${eventId}::uuid
        `);

        for (const line of document.lines) {
          const mapping = mappings.get(line.providerProductId)
            ?? (line.saleFormatId ? mappings.get(line.saleFormatId) : undefined);
          const format = mapping?.variant ?? line.suggestedVariant ?? null;
          const lineTotal = line.totalAmount ?? (line.unitPrice ?? 0) * line.quantity;
          const isWineCandidate = !!mapping
            || line.classification === "WINE"
            || line.classification === "AMBIGUOUS"
            || (line.classification === undefined && !!line.suggestedVariant);
          await transaction.query(sql`
            INSERT INTO public.sales_line_items (
              sales_event_id,
              connection_id,
              provider_product_id,
              name,
              format,
              family,
              quantity,
              unit_price,
              total_amount,
              vat_rate,
              is_wine_candidate,
              winerim_product_id,
              mapped,
              provider_sold_at,
              provider_sold_at_source
            ) VALUES (
              ${eventId}::uuid,
              ${options.connectionId}::uuid,
              ${line.providerProductId || null},
              ${line.productName},
              ${format},
              ${line.familyName ?? null},
              ${line.quantity},
              ${line.unitPrice ?? 0},
              ${lineTotal},
              ${0},
              ${isWineCandidate},
              ${mapping?.winerimWineId ?? null},
              ${!!mapping},
              ${line.soldAt ?? null}::timestamp,
              ${line.soldAt ? "provider_line" : null}
            )
          `);
        }
      }
    }, { isolationLevel: "serializable", readOnly: false });
  };

  const reserveClaim = async (intent: SalesMutationIntent): Promise<SalesClaimReservation> => {
    assertScope(options, intent);
    const initialPayloadSha256 = await buildSalesClaimPayloadHash(intent);
    const leaseToken = crypto.randomUUID();
    return database.transaction(async (transaction) => {
      const selectCurrent = () => transaction.query<ClaimRow>(sql`
        SELECT
          idempotency_key,
          message_id,
          job,
          status,
          COALESCE((result ->> 'appliedQuantity')::numeric, 0) AS applied_quantity,
          lease_expires_at,
          COALESCE(lease_expires_at <= now(), true) AS lease_expired,
          payload_sha256,
          lease_token,
          result,
          updated_at
        FROM public.runtime_idempotency
        WHERE connection_id = ${options.connectionId}::uuid
          AND job = ${CLAIM_JOB}
          AND (
            idempotency_key = ${intent.claimKey}
            OR (
              result ->> 'lifecycleId' = ${intent.lifecycleId}
              AND result ->> 'winerimWineId' = ${intent.winerimWineId}
              AND upper(result ->> 'variant') = ${intent.variant}
            )
          )
        ORDER BY (idempotency_key = ${intent.claimKey}) DESC, updated_at DESC
        LIMIT 2
        FOR UPDATE
      `);

      let current = await selectCurrent();
      if (current.rowCount > 1) {
        throw new PostgresSalesAdapterInvariantError("SALES_CLAIM_DUPLICATE_IDENTITY_RECONCILIATION_REQUIRED");
      }

      const initialResult = JSON.stringify(claimMetadata(intent, Math.max(0, intent.observedAppliedQuantity)));
      if (current.rowCount === 0) {
        const inserted = await transaction.query<ClaimRow>(sql`
          INSERT INTO public.runtime_idempotency (
            idempotency_key,
            message_id,
            connection_id,
            job,
            status,
            attempt,
            lease_expires_at,
            payload_sha256,
            lease_token,
            result
          ) VALUES (
            ${intent.claimKey},
            ${intent.orderId},
            ${options.connectionId}::uuid,
            ${CLAIM_JOB},
            'RUNNING',
            1,
            now() + (${claimLeaseSeconds} * interval '1 second'),
            ${initialPayloadSha256},
            ${leaseToken}::uuid,
            ${initialResult}::jsonb
          )
          ON CONFLICT DO NOTHING
          RETURNING
            idempotency_key,
            message_id,
            job,
            status,
            COALESCE((result ->> 'appliedQuantity')::numeric, 0) AS applied_quantity,
            lease_expires_at,
            false AS lease_expired,
            payload_sha256,
            lease_token,
            result,
            updated_at
        `);
        if (inserted.rowCount === 1) {
          return {
            state: "ACQUIRED",
            appliedQuantity: number(inserted.rows[0].applied_quantity),
            claimKey: text(inserted.rows[0].idempotency_key) || intent.claimKey,
            payloadSha256: initialPayloadSha256,
            leaseToken,
          };
        }
        current = await selectCurrent();
        if (current.rowCount > 1) {
          throw new PostgresSalesAdapterInvariantError("SALES_CLAIM_DUPLICATE_IDENTITY_RECONCILIATION_REQUIRED");
        }
      }

      const row = current.rows[0];
      if (!row) throw new PostgresSalesAdapterInvariantError("SALES_CLAIM_CONFLICT_NOT_FOUND");
      const currentMetadata = jsonRecord(row.result);
      if (
        text(currentMetadata.lifecycleId) !== intent.lifecycleId
        || text(currentMetadata.winerimWineId) !== intent.winerimWineId
        || normalizeVariant(currentMetadata.variant) !== intent.variant
      ) {
        throw new PostgresSalesAdapterInvariantError("SALES_CLAIM_IDENTITY_MISMATCH");
      }
      const appliedQuantity = number(row.applied_quantity);
      if (row.status === "SUCCESS" && appliedQuantity >= intent.desiredQuantity) {
        return { state: "DUPLICATE", appliedQuantity };
      }
      if (row.status === "TERMINAL") return { state: "BUSY", appliedQuantity };
      if (row.status === "RUNNING" && !boolean(row.lease_expired)) {
        return { state: "BUSY", appliedQuantity };
      }

      const payloadSha256 = await buildSalesClaimPayloadHash(intent, appliedQuantity);
      const metadata = JSON.stringify(claimMetadata(intent, appliedQuantity));
      const reacquired = await transaction.query<ClaimRow>(sql`
        UPDATE public.runtime_idempotency
        SET
          message_id = ${intent.orderId},
          status = 'RUNNING',
          attempt = attempt + 1,
          lease_expires_at = now() + (${claimLeaseSeconds} * interval '1 second'),
          payload_sha256 = ${payloadSha256},
          lease_token = ${leaseToken}::uuid,
          result = COALESCE(result, '{}'::jsonb) || ${metadata}::jsonb,
          updated_at = now()
        WHERE idempotency_key = ${text(row.idempotency_key)}
          AND connection_id = ${options.connectionId}::uuid
          AND job = ${CLAIM_JOB}
          AND (
            status IN ('SUCCESS', 'RETRY')
            OR (status = 'RUNNING' AND COALESCE(lease_expires_at <= now(), true))
          )
        RETURNING
          idempotency_key,
          message_id,
          job,
          status,
          COALESCE((result ->> 'appliedQuantity')::numeric, 0) AS applied_quantity,
          lease_expires_at,
          false AS lease_expired,
          payload_sha256,
          lease_token,
          result,
          updated_at
      `);
      if (reacquired.rowCount !== 1) {
        throw new PostgresSalesAdapterInvariantError("SALES_CLAIM_REACQUIRE_FAILED");
      }
      return {
        state: "ACQUIRED",
        appliedQuantity,
        claimKey: text(row.idempotency_key),
        payloadSha256,
        leaseToken,
      };
    }, { isolationLevel: "serializable", readOnly: false });
  };

  const completeClaim: PostgresSalesAdapter["completeClaim"] = async (input) => {
    const result = await database.query(sql`
      UPDATE public.runtime_idempotency
      SET
        status = 'SUCCESS',
        lease_expires_at = NULL,
        result = COALESCE(result, '{}'::jsonb) || ${JSON.stringify({
          appliedQuantity: input.appliedQuantity,
          orderId: input.orderId,
        })}::jsonb,
        updated_at = now()
      WHERE idempotency_key = ${input.claimKey}
        AND connection_id = ${options.connectionId}::uuid
        AND job = ${CLAIM_JOB}
        AND status = 'RUNNING'
        AND message_id = ${input.orderId}
        AND payload_sha256 = ${input.payloadSha256}
        AND lease_token = ${input.leaseToken}::uuid
      RETURNING idempotency_key
    `);
    if (result.rowCount !== 1) {
      throw new PostgresSalesAdapterInvariantError("SALES_CLAIM_COMPLETE_NOT_OWNED");
    }
  };

  const releaseClaim: PostgresSalesAdapter["releaseClaim"] = async (input) => {
    const result = await database.query(sql`
      UPDATE public.runtime_idempotency
      SET
        status = ${input.retryable ? "RETRY" : "TERMINAL"},
        lease_expires_at = NULL,
        result = COALESCE(result, '{}'::jsonb) || ${JSON.stringify({
          orderId: input.orderId,
          retryable: input.retryable,
          lastError: input.error,
        })}::jsonb,
        updated_at = now()
      WHERE idempotency_key = ${input.claimKey}
        AND connection_id = ${options.connectionId}::uuid
        AND job = ${CLAIM_JOB}
        AND status = 'RUNNING'
        AND message_id = ${input.orderId}
        AND payload_sha256 = ${input.payloadSha256}
        AND lease_token = ${input.leaseToken}::uuid
      RETURNING idempotency_key
    `);
    if (result.rowCount !== 1) {
      throw new PostgresSalesAdapterInvariantError("SALES_CLAIM_RELEASE_NOT_OWNED");
    }
  };

  const readDocuments = async (filter: SalesReadbackFilter = {}): Promise<SalesDocumentsReadback> => {
    const limit = Math.max(1, Math.min(500, Math.trunc(filter.limit ?? 100)));
    const providerDocumentIds = Array.from(new Set((filter.providerDocumentIds ?? []).map(String).filter(Boolean))).sort();
    return database.transaction(async (transaction) => {
      const events = await transaction.query<EventRow>(sql`
        SELECT
          id,
          connection_id,
          provider_doc_id,
          business_day,
          doc_type,
          line_count,
          total_amount,
          raw_json,
          created_at
        FROM public.sales_events
        WHERE connection_id = ${options.connectionId}::uuid
          AND (${filter.fromBusinessDay ?? null}::date IS NULL OR business_day >= ${filter.fromBusinessDay ?? null}::date)
          AND (${filter.toBusinessDay ?? null}::date IS NULL OR business_day <= ${filter.toBusinessDay ?? null}::date)
          AND (cardinality(${providerDocumentIds}::text[]) = 0 OR provider_doc_id = ANY(${providerDocumentIds}::text[]))
        ORDER BY business_day DESC, created_at DESC
        LIMIT ${limit}
      `);
      const eventIds = events.rows.map((row) => text(row.id)).filter(Boolean);
      if (eventIds.length === 0) return { events: [], lines: [] };
      const lines = await transaction.query<LineRow>(sql`
        SELECT
          id,
          sales_event_id,
          provider_product_id,
          name,
          format,
          quantity,
          unit_price,
          total_amount,
          mapped,
          winerim_product_id,
          provider_sold_at
        FROM public.sales_line_items
        WHERE connection_id = ${options.connectionId}::uuid
          AND sales_event_id = ANY(${eventIds}::uuid[])
        ORDER BY sales_event_id ASC, created_at ASC, id ASC
      `);
      return {
        events: events.rows.map(mapEvent),
        lines: lines.rows.map(mapLine),
      };
    }, { isolationLevel: "repeatable-read", readOnly: true });
  };

  const planCursorAdvance: PostgresSalesAdapter["planCursorAdvance"] = (input): CursorAdvancePlan => ({
    kind: "SALES_CURSOR_ADVANCE",
    executable: false,
    connectionId: options.connectionId,
    throughBusinessDay: input.throughBusinessDay,
    reason: input.reason,
    requiredReadbacks: input.requiredReadbacks ?? [
      "definitive invoice count reconciled",
      "sales line mappings reviewed",
      "claims contain no RUNNING or RETRY rows",
      "stock application verified by its separate adapter",
    ],
    statement: {
      text: "UPDATE public.pos_connections SET last_business_day_synced = GREATEST(last_business_day_synced, $2::date) WHERE id = $1::uuid RETURNING last_business_day_synced",
      values: [options.connectionId, input.throughBusinessDay],
    },
  });

  return {
    resolveLine: async (input) => {
      assertScope(options, input);
      const mappings = await readExactMappings([input.line.providerProductId]);
      return mappings[0] ?? null;
    },
    loadClaims: async (claimKeys) => (await readClaims(claimKeys)).map((claim) => ({
      claimKey: claim.claimKey,
      state: claim.state,
      appliedQuantity: claim.appliedQuantity,
      ...(text(claim.result.lifecycleId) ? { lifecycleId: text(claim.result.lifecycleId) } : {}),
      ...(text(claim.result.winerimWineId) ? { winerimWineId: text(claim.result.winerimWineId) } : {}),
      ...(normalizeVariant(claim.result.variant)
        ? { variant: normalizeVariant(claim.result.variant)! }
        : {}),
      ...(stringArray(claim.result.sourceDocumentIds).length > 0
        ? { sourceDocumentIds: stringArray(claim.result.sourceDocumentIds) }
        : {}),
      ...(stringArray(claim.result.sourceLineIds).length > 0
        ? { sourceLineIds: stringArray(claim.result.sourceLineIds) }
        : {}),
      ...(claim.result.sourceDocumentKind === "OPEN_TICKET"
        || claim.result.sourceDocumentKind === "DEFINITIVE_INVOICE"
        ? { sourceDocumentKind: claim.result.sourceDocumentKind }
        : {}),
    })),
    loadReconciliationClaims,
    persistDocuments,
    reserveClaim,
    completeClaim,
    releaseClaim,
    readExactMappings,
    readProductClassifications,
    readDocuments,
    readClaims,
    planCursorAdvance,
  };
}
