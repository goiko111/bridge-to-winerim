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
  ExactSalesLineIdentity,
  PostgresSalesAdapter,
  PostgresSalesAdapterOptions,
  ProviderProductSalesClassification,
  SalesClaimReadback,
  SalesDocumentsReadback,
  SalesEventReadback,
  SalesLineReadback,
  SalesReadbackFilter,
} from "./types";
import {
  exactSalesMappingForLine,
  exactSalesMappingIndex,
} from "./identity";

type MappingRow = {
  mapping_id: unknown;
  provider_product_id: unknown;
  provider_product_name: unknown;
  winerim_wine_id: unknown;
  format_type: unknown;
  stock_id: unknown;
  stock_active: unknown;
};

type NativeMappingRow = MappingRow & {
  provider_sale_format_id: unknown;
  provider_sale_format_name: unknown;
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

function hasResidualClaimFailure(result: Record<string, unknown>): boolean {
  return text(result.lastError).trim().length > 0 || boolean(result.retryable);
}

function hasCertifiedCompletionEvidence(result: Record<string, unknown>): boolean {
  const completion = jsonRecord(result.completionEvidence);
  if (Object.keys(completion).length === 0) {
    // Preserve clean claims produced before the evidence contract rollout.
    return !hasResidualClaimFailure(result);
  }
  const winerim = jsonRecord(completion.winerim);
  return completion.contractVersion === 1
    && completion.sourceObserved === true
    && completion.sourcePersisted === true
    && winerim.contractVersion === 1
    && winerim.accepted === true
    && text(winerim.orderId).length > 0
    && text(winerim.reason).length > 0
    && !hasResidualClaimFailure(result);
}

function claimState(status: unknown, result: Record<string, unknown>): SalesClaimSnapshot["state"] {
  if (status === "SUCCESS") return hasCertifiedCompletionEvidence(result) ? "COMPLETE" : "QUARANTINED";
  if (status === "RUNNING") return "PENDING";
  if (status === "TERMINAL") return "QUARANTINED";
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

function nativeMappingFromRow(row: NativeMappingRow): ExactSalesMapping | null {
  const mapping = mappingFromRow(row);
  const saleFormatId = text(row.provider_sale_format_id);
  if (!mapping || !saleFormatId) return null;
  return {
    ...mapping,
    providerSaleFormatId: saleFormatId,
    providerSaleFormatName: text(row.provider_sale_format_name),
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
      stock_contract.stock_id,
      stock_contract.stock_active
    FROM public.product_mappings pm
    LEFT JOIN public.winerim_wines ww
      ON ww.connection_id = pm.connection_id
     AND ww.winerim_id = pm.winerim_wine_id
    JOIN LATERAL (
      SELECT
        min(contract_entry.stock_id) AS stock_id,
        bool_and(contract_entry.stock_active) AS stock_active,
        count(*) AS stock_count
      FROM (
        SELECT
          price_entry->'erpStock'->>'id' AS stock_id,
          (price_entry->'erpStock'->>'stockActive')::boolean AS stock_active
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(ww.raw_payload->'prices') = 'array'
            THEN ww.raw_payload->'prices'
            ELSE '[]'::jsonb
          END
        ) price_entry
        WHERE CASE
          WHEN lower(btrim(COALESCE(price_entry->>'variant', ''))) IN ('copa', 'glass', 'c') THEN 'GLASS'
          WHEN lower(btrim(COALESCE(price_entry->>'variant', ''))) IN ('magnum', 'mag', 'm') THEN 'MAGNUM'
          WHEN lower(btrim(COALESCE(price_entry->>'variant', ''))) IN ('botella', 'bottle', 'bot') THEN 'BOTTLE'
          ELSE ''
        END = CASE
          WHEN upper(pm.format_type) IN ('GLASS', 'COPA', 'C') THEN 'GLASS'
          WHEN upper(pm.format_type) IN ('MAGNUM', 'M') THEN 'MAGNUM'
          ELSE 'BOTTLE'
        END
          AND jsonb_typeof(price_entry->'erpStock') = 'object'
          AND COALESCE(price_entry->'erpStock'->>'id', '') <> ''
          AND jsonb_typeof(price_entry->'erpStock'->'stockActive') = 'boolean'
        UNION ALL
        SELECT
          stock_entry->>'id' AS stock_id,
          (stock_entry->>'stockActive')::boolean AS stock_active
        FROM jsonb_array_elements(
          CASE
            WHEN COALESCE(jsonb_typeof(ww.raw_payload->'prices'), 'null') <> 'array'
             AND jsonb_typeof(ww.raw_payload->'stocks') = 'array'
              THEN ww.raw_payload->'stocks'
            ELSE '[]'::jsonb
          END
        ) stock_entry
        WHERE stock_entry->>'id' = CASE
          WHEN upper(pm.format_type) IN ('GLASS', 'COPA', 'C') THEN ww.glass_stock_id::text
          WHEN upper(pm.format_type) IN ('MAGNUM', 'M') THEN ww.magnum_stock_id::text
          ELSE ww.bottle_stock_id::text
        END
          AND jsonb_typeof(stock_entry->'stockActive') = 'boolean'
        UNION ALL
        SELECT
          stock_policy_entry.value->>'stockId' AS stock_id,
          (stock_policy_entry.value->>'stockActive')::boolean AS stock_active
        FROM jsonb_each(
          CASE
            WHEN COALESCE(jsonb_typeof(ww.raw_payload->'prices'), 'null') <> 'array'
             AND COALESCE(jsonb_typeof(ww.raw_payload->'stocks'), 'null') <> 'array'
             AND jsonb_typeof(ww.raw_payload->'stock_policy') = 'object'
              THEN ww.raw_payload->'stock_policy'
            ELSE '{}'::jsonb
          END
        ) stock_policy_entry(key, value)
        WHERE CASE
          WHEN lower(btrim(stock_policy_entry.key)) IN ('copa', 'glass', 'c') THEN 'GLASS'
          WHEN lower(btrim(stock_policy_entry.key)) IN ('magnum', 'mag', 'm') THEN 'MAGNUM'
          WHEN lower(btrim(stock_policy_entry.key)) IN ('botella', 'bottle', 'bot') THEN 'BOTTLE'
          ELSE ''
        END = CASE
          WHEN upper(pm.format_type) IN ('GLASS', 'COPA', 'C') THEN 'GLASS'
          WHEN upper(pm.format_type) IN ('MAGNUM', 'M') THEN 'MAGNUM'
          ELSE 'BOTTLE'
        END
          AND jsonb_typeof(stock_policy_entry.value) = 'object'
          AND COALESCE(stock_policy_entry.value->>'stockId', '') <> ''
          AND jsonb_typeof(stock_policy_entry.value->'stockActive') = 'boolean'
      ) contract_entry
    ) stock_contract ON stock_contract.stock_count = 1
    WHERE pm.connection_id = ${connectionId}::uuid
      AND pm.provider_product_id = ANY(${ids}::text[])
      AND pm.status = 'CONFIRMED'
      AND pm.winerim_wine_id IS NOT NULL
      AND (
        (
          stock_contract.stock_active IS TRUE
          AND pm.match_method IN (
            'RESCUE_EXACT_ID_WINE_VARIANT',
            'WINERIM_OWNED_EXACT_VARIANT'
          )
        )
        OR (
          stock_contract.stock_active IS FALSE
          AND pm.match_method IN (
            'RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY',
            'WINERIM_OWNED_EXACT_VARIANT'
          )
        )
      )
    ORDER BY pm.provider_product_id ASC
  `);
  return result.rows.map(mappingFromRow).filter((row): row is ExactSalesMapping => !!row);
}

async function selectExactNativeMappings(
  database: DatabaseTransaction,
  connectionId: string,
  lines: ExactSalesLineIdentity[],
): Promise<ExactSalesMapping[]> {
  const pairs = new Set(lines.map((line) => {
    const productId = text(line.providerProductId).trim();
    const saleFormatId = text(line.saleFormatId).trim();
    return productId && saleFormatId && productId !== saleFormatId
      ? `${productId}\u001f${saleFormatId}`
      : "";
  }).filter(Boolean));
  if (pairs.size === 0) return [];
  const productIds = Array.from(new Set(Array.from(pairs).map((pair) => pair.split("\u001f")[0]))).sort();
  const saleFormatIds = Array.from(new Set(Array.from(pairs).map((pair) => pair.split("\u001f")[1]))).sort();
  const result = await database.query<NativeMappingRow>(sql`
    SELECT
      native.id AS mapping_id,
      native.provider_product_id,
      native.sale_format_id AS provider_sale_format_id,
      native.provider_product_name,
      native.provider_sale_format_name,
      native.winerim_wine_id,
      native.format_type,
      stock_contract.stock_id,
      stock_contract.stock_active
    FROM public.agora_sales_variant_mappings native
    LEFT JOIN public.winerim_wines wine
      ON wine.connection_id = native.connection_id
     AND wine.winerim_id = native.winerim_wine_id
    JOIN LATERAL (
      SELECT
        min(contract_entry.stock_id) AS stock_id,
        bool_and(contract_entry.stock_active) AS stock_active,
        count(*) AS stock_count
      FROM (
        SELECT
          price_entry->'erpStock'->>'id' AS stock_id,
          (price_entry->'erpStock'->>'stockActive')::boolean AS stock_active
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(wine.raw_payload->'prices') = 'array'
            THEN wine.raw_payload->'prices'
            ELSE '[]'::jsonb
          END
        ) price_entry
        WHERE CASE
          WHEN lower(btrim(COALESCE(price_entry->>'variant', ''))) IN ('copa', 'glass', 'c') THEN 'GLASS'
          WHEN lower(btrim(COALESCE(price_entry->>'variant', ''))) IN ('magnum', 'mag', 'm') THEN 'MAGNUM'
          WHEN lower(btrim(COALESCE(price_entry->>'variant', ''))) IN ('botella', 'bottle', 'bot') THEN 'BOTTLE'
          ELSE ''
        END = CASE
          WHEN upper(native.format_type) = 'GLASS' THEN 'GLASS'
          WHEN upper(native.format_type) = 'MAGNUM' THEN 'MAGNUM'
          ELSE 'BOTTLE'
        END
          AND jsonb_typeof(price_entry->'erpStock') = 'object'
          AND COALESCE(price_entry->'erpStock'->>'id', '') <> ''
          AND jsonb_typeof(price_entry->'erpStock'->'stockActive') = 'boolean'
        UNION ALL
        SELECT
          stock_entry->>'id' AS stock_id,
          (stock_entry->>'stockActive')::boolean AS stock_active
        FROM jsonb_array_elements(
          CASE
            WHEN COALESCE(jsonb_typeof(wine.raw_payload->'prices'), 'null') <> 'array'
             AND jsonb_typeof(wine.raw_payload->'stocks') = 'array'
              THEN wine.raw_payload->'stocks'
            ELSE '[]'::jsonb
          END
        ) stock_entry
        WHERE stock_entry->>'id' = CASE
          WHEN upper(native.format_type) = 'GLASS' THEN wine.glass_stock_id::text
          WHEN upper(native.format_type) = 'MAGNUM' THEN wine.magnum_stock_id::text
          ELSE wine.bottle_stock_id::text
        END
          AND jsonb_typeof(stock_entry->'stockActive') = 'boolean'
      ) contract_entry
    ) stock_contract ON stock_contract.stock_count = 1
    WHERE native.connection_id = ${connectionId}::uuid
      AND native.provider_product_id = ANY(${productIds}::text[])
      AND native.sale_format_id = ANY(${saleFormatIds}::text[])
      AND native.status = 'CONFIRMED'
      AND (
        (stock_contract.stock_active IS TRUE AND native.match_method = 'AGORA_NATIVE_EXACT_ID_WINE_VARIANT')
        OR (stock_contract.stock_active IS FALSE AND native.match_method = 'AGORA_NATIVE_EXACT_ID_WINE_VARIANT_SALES_ONLY')
      )
    ORDER BY native.provider_product_id, native.sale_format_id
  `);
  return result.rows
    .filter((row) => pairs.has(`${text(row.provider_product_id)}\u001f${text(row.provider_sale_format_id)}`))
    .map(nativeMappingFromRow)
    .filter((row): row is ExactSalesMapping => !!row);
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
    actionKind: intent.action.kind,
    ...(intent.action.kind === "SALES_IMPORT"
      ? {
        importLive: intent.action.live,
        stockDisposition: intent.action.stockDisposition,
      }
      : { stockDisposition: "APPLIED_EXACT_ONCE" }),
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
    state: claimState(row.status, result),
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
    state: claimState(row.status, result),
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

  const readExactMappingsForLines = async (lines: ExactSalesLineIdentity[]) => {
    const flatIds = lines.flatMap((line) => [
      text(line.providerProductId),
      text(line.saleFormatId),
    ]).filter(Boolean);
    const [flat, native] = await Promise.all([
      selectExactMappings(database, options.connectionId, flatIds),
      selectExactNativeMappings(database, options.connectionId, lines),
    ]);
    return [...native, ...flat];
  };

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
    const uniqueDocuments = Array.from(new Map(
      documents.map((document) => [document.documentId, document] as const),
    ).values());
    if (uniqueDocuments.length === 0) return;
    await database.transaction(async (transaction) => {
      const lines = uniqueDocuments.flatMap((document) => document.lines);
      const mappingRows = await Promise.all([
        selectExactMappings(
          transaction,
          options.connectionId,
          lines.flatMap((line) => [line.providerProductId, line.saleFormatId ?? ""]),
        ),
        selectExactNativeMappings(transaction, options.connectionId, lines),
      ]).then(([flat, native]) => [...native, ...flat]);
      const mappings = exactSalesMappingIndex(mappingRows);
      const documentRows = uniqueDocuments.map((document) => {
        const amount = totalAmount(document);
        return {
          providerDocumentId: document.documentId,
          businessDay: document.businessDay,
          documentType: document.kind === "OPEN_TICKET" ? "OpenTicket" : "BasicInvoice",
          totalAmount: amount,
          lineCount: document.lines.length,
          rawJson: document,
        };
      });
      const lineRows = uniqueDocuments.flatMap((document) => document.lines.map((line) => {
        const mapping = exactSalesMappingForLine(mappings, line, {
          requireNativePair: options.requireNativeSaleFormatIdentity,
        }) ?? undefined;
        const format = mapping?.variant ?? line.suggestedVariant ?? null;
        const isWineCandidate = !!mapping
          || line.classification === "WINE"
          || line.classification === "AMBIGUOUS"
          || (line.classification === undefined && !!line.suggestedVariant);
        return {
          providerDocumentId: document.documentId,
          providerProductId: line.providerProductId || null,
          productName: line.productName,
          format,
          familyName: line.familyName ?? null,
          quantity: line.quantity,
          unitPrice: line.unitPrice ?? 0,
          totalAmount: line.totalAmount ?? (line.unitPrice ?? 0) * line.quantity,
          isWineCandidate,
          winerimWineId: mapping?.winerimWineId ?? null,
          mapped: !!mapping,
          soldAt: line.soldAt ?? null,
          soldAtSource: line.soldAt ? "provider_line" : null,
        };
      }));

      await transaction.query(sql`
        WITH document_input AS MATERIALIZED (
          SELECT *
          FROM jsonb_to_recordset(${JSON.stringify(documentRows)}::jsonb) AS document(
            "providerDocumentId" text,
            "businessDay" date,
            "documentType" text,
            "totalAmount" numeric,
            "lineCount" integer,
            "rawJson" jsonb
          )
        ), upserted_events AS (
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
          )
          SELECT
            ${options.connectionId}::uuid,
            document."providerDocumentId",
            document."businessDay",
            document."documentType",
            document."totalAmount",
            0,
            document."totalAmount",
            document."lineCount",
            document."rawJson"
          FROM document_input document
          ON CONFLICT (connection_id, provider_doc_id) DO UPDATE SET
            business_day = EXCLUDED.business_day,
            doc_type = EXCLUDED.doc_type,
            total_amount = EXCLUDED.total_amount,
            total_tax = EXCLUDED.total_tax,
            total_net = EXCLUDED.total_net,
            line_count = EXCLUDED.line_count,
            raw_json = EXCLUDED.raw_json
          WHERE sales_events.business_day IS DISTINCT FROM EXCLUDED.business_day
             OR sales_events.doc_type IS DISTINCT FROM EXCLUDED.doc_type
             OR sales_events.total_amount IS DISTINCT FROM EXCLUDED.total_amount
             OR sales_events.total_tax IS DISTINCT FROM EXCLUDED.total_tax
             OR sales_events.total_net IS DISTINCT FROM EXCLUDED.total_net
             OR sales_events.line_count IS DISTINCT FROM EXCLUDED.line_count
             OR sales_events.raw_json IS DISTINCT FROM EXCLUDED.raw_json
          RETURNING id, provider_doc_id
        ), target_events AS MATERIALIZED (
          SELECT event.id, event.provider_doc_id
          FROM upserted_events event
          UNION ALL
          SELECT event.id, event.provider_doc_id
          FROM public.sales_events event
          JOIN document_input document
            ON document."providerDocumentId" = event.provider_doc_id
          WHERE event.connection_id = ${options.connectionId}::uuid
            AND NOT EXISTS (
              SELECT 1 FROM upserted_events changed
              WHERE changed.provider_doc_id = event.provider_doc_id
            )
        ), deleted_lines AS (
          DELETE FROM public.sales_line_items line
          USING target_events event
          WHERE line.sales_event_id = event.id
          RETURNING line.id
        ), line_input AS MATERIALIZED (
          SELECT *
          FROM jsonb_to_recordset(${JSON.stringify(lineRows)}::jsonb) AS line(
            "providerDocumentId" text,
            "providerProductId" text,
            "productName" text,
            format text,
            "familyName" text,
            quantity numeric,
            "unitPrice" numeric,
            "totalAmount" numeric,
            "isWineCandidate" boolean,
            "winerimWineId" text,
            mapped boolean,
            "soldAt" timestamp,
            "soldAtSource" text
          )
        )
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
        )
        SELECT
          event.id,
          ${options.connectionId}::uuid,
          line."providerProductId",
          line."productName",
          line.format,
          line."familyName",
          line.quantity,
          line."unitPrice",
          line."totalAmount",
          0,
          line."isWineCandidate",
          line."winerimWineId",
          line.mapped,
          line."soldAt",
          line."soldAtSource"
        FROM line_input line
        JOIN target_events event
          ON event.provider_doc_id = line."providerDocumentId"
        ORDER BY event.provider_doc_id, line."providerProductId", line."productName"
      `);
    }, { isolationLevel: "read-committed", readOnly: false });
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
      const certifiedSuccess = row.status === "SUCCESS" && hasCertifiedCompletionEvidence(currentMetadata);
      if (certifiedSuccess && appliedQuantity >= intent.desiredQuantity) {
        return { state: "DUPLICATE", appliedQuantity };
      }
      if (row.status === "TERMINAL") {
        return { state: "QUARANTINED", appliedQuantity, error: "SALES_CLAIM_TERMINAL_QUARANTINED" };
      }
      if (row.status === "SUCCESS" && !certifiedSuccess) {
        return { state: "QUARANTINED", appliedQuantity, error: "SALES_CLAIM_SUCCESS_WITHOUT_EVIDENCE_QUARANTINED" };
      }
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
        result = (COALESCE(result, '{}'::jsonb) - 'lastError' - 'retryable') || ${JSON.stringify({
          appliedQuantity: input.appliedQuantity,
          orderId: input.orderId,
          completionEvidence: input.evidence,
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
      const mappings = await readExactMappingsForLines([input.line]);
      return exactSalesMappingForLine(exactSalesMappingIndex(mappings), input.line, {
        requireNativePair: options.requireNativeSaleFormatIdentity,
      });
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
    readExactMappingsForLines,
    readProductClassifications,
    readDocuments,
    readClaims,
    planCursorAdvance,
  };
}
