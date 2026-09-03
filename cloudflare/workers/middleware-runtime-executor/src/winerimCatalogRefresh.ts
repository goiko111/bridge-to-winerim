import {
  sql,
  type DatabaseAdapter,
} from "../../middleware-api/src/db";
import {
  createSafeHttpClient,
  HttpAdapterError,
  type HttpRequestPort,
  type HttpTimerPort,
} from "../../middleware-runtime/src/adapters/http";
import type {
  CatalogRefreshResult,
  WinerimCatalogRefreshPort,
} from "./catalog";
import type { RuntimeFailureDiagnosticInput } from "../../middleware-runtime/src/retry";

const LIST_PATH = "/api/v2/wines";
const BULK_PATH = "/api/v2/wines/bulk";
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_WINES = 5_000;
export const WINERIM_CATALOG_REFRESH_TIMEOUT_MS = 30_000;
export const WINERIM_CATALOG_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export type WinerimCatalogRefreshOptions = Readonly<{
  database: DatabaseAdapter;
  baseUrl: string;
  allowedHosts: readonly string[];
  request: HttpRequestPort;
  timer: HttpTimerPort;
  timeoutMs?: number;
}>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function wineId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9]\d{0,17}$/.test(normalized) ? normalized : null;
}

function text(value: unknown, maximum: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).replace(/\s+/g, " ").trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function decimal(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0 && normalized <= 1_000_000
    ? normalized
    : null;
}

function normalizedVariant(value: unknown): "BOTTLE" | "GLASS" | "MAGNUM" | null {
  const variant = String(value ?? "").trim().toLowerCase();
  if (["bottle", "botella", "botella-pequena"].includes(variant)) return "BOTTLE";
  if (["glass", "copa"].includes(variant)) return "GLASS";
  if (variant === "magnum") return "MAGNUM";
  return null;
}

export function normalizedWine(detail: JsonRecord, fallback: JsonRecord): JsonRecord {
  const id = wineId(detail.id ?? fallback.id);
  const name = text(detail.name ?? fallback.name, 200);
  if (!id || !name) throw new Error("WINERIM_CATALOG_INVALID_WINE");

  const prices = Array.isArray(detail.prices) ? detail.prices : [];
  if (prices.length > 32) throw new Error("WINERIM_CATALOG_INVALID_PRICES");
  const priceByFormat = new Map<string, number>();
  const stockIdByFormat = new Map<string, string>();
  for (const rawPrice of prices) {
    const entry = record(rawPrice);
    const format = normalizedVariant(entry?.variant);
    const price = decimal(entry?.price);
    if (!entry || !format || price === null || priceByFormat.has(format)) continue;
    priceByFormat.set(format, price);
    const erpStock = record(entry.erpStock);
    const stockId = wineId(erpStock?.id);
    if (stockId) stockIdByFormat.set(format, stockId);
  }

  const bottleSalePrice = priceByFormat.get("BOTTLE")
    ?? decimal(detail.bottle_sale_price ?? detail.sale_price ?? detail.pvp ?? detail.price);
  const glassSalePrice = priceByFormat.get("GLASS")
    ?? decimal(detail.glass_sale_price ?? detail.glass_price);
  const magnumSalePrice = priceByFormat.get("MAGNUM")
    ?? decimal(detail.magnum_sale_price);
  const ready = [bottleSalePrice, glassSalePrice, magnumSalePrice]
    .some((value) => value !== null && value > 0);
  const status = text(detail.status, 32)?.toLowerCase();

  return {
    winerim_id: id,
    name,
    vintage: text(detail.vintage ?? detail.year ?? fallback.vintage, 32),
    wine_type: text(
      detail.type ?? detail.wine_type ?? detail.category ?? detail.style ?? detail.color ?? fallback.type,
      80,
    )?.toLowerCase() ?? null,
    is_active: detail.active !== false && detail.is_active !== false && status !== "inactive",
    price: bottleSalePrice,
    bottle_sale_price: bottleSalePrice,
    bottle_purchase_price: decimal(
      detail.bottle_purchase_price ?? detail.purchase_price ?? detail.cost_price ?? detail.cost,
    ),
    glass_sale_price: glassSalePrice,
    glass_cost_price: decimal(detail.glass_cost_price ?? detail.glass_cost),
    magnum_sale_price: magnumSalePrice,
    magnum_purchase_price: decimal(detail.magnum_purchase_price ?? detail.magnum_cost),
    serve_by_glass: priceByFormat.has("GLASS") || detail.serve_by_glass === true || detail.by_glass === true,
    bottle_stock_id: stockIdByFormat.get("BOTTLE") ?? null,
    glass_stock_id: stockIdByFormat.get("GLASS") ?? null,
    magnum_stock_id: stockIdByFormat.get("MAGNUM") ?? null,
    pricing_status: ready ? "READY" : "MISSING",
    pricing_missing_reason: ready ? null : prices.length === 0 ? "prices_array_empty" : "sale_price_missing",
    raw_payload: detail,
  };
}

async function headers(credential: Parameters<WinerimCatalogRefreshPort["refresh"]>[0]["credential"]): Promise<Record<string, string>> {
  const token = String(await credential.read()).trim();
  if (!token || /[\r\n]/.test(token)) throw new Error("WINERIM_CATALOG_CREDENTIAL_INVALID");
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "WINERIM-API-TOKEN": token,
  };
}

function httpDiagnostic(error: HttpAdapterError): RuntimeFailureDiagnosticInput {
  return {
    operation: error.diagnostic?.operation ?? "winerim.catalog-refresh",
    route: error.diagnostic?.path,
    httpStatus: error.diagnostic?.status,
    elapsedMs: error.diagnostic?.durationMs,
    errorCode: error.code,
  };
}

function logRefreshFailure(diagnostic: RuntimeFailureDiagnosticInput): void {
  console.warn(JSON.stringify({
    event: "winerim.catalog-refresh.failure",
    operation: diagnostic.operation,
    route: diagnostic.route ?? null,
    httpStatus: diagnostic.httpStatus ?? null,
    elapsedMs: diagnostic.elapsedMs ?? null,
    errorCode: diagnostic.errorCode ?? "WINERIM_CATALOG_REFRESH_FAILED",
  }));
}

function safeRefreshErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^WINERIM_CATALOG_[A-Z0-9_]+$/.test(message)
    ? message
    : "WINERIM_CATALOG_REFRESH_FAILED";
}

function safeDatabaseErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as Readonly<{ code?: unknown; driverCode?: unknown }>;
  const values = [candidate.code, candidate.driverCode]
    .map((value) => String(value ?? "").trim())
    .filter((value) => /^[A-Z0-9_]{2,64}$/.test(value));
  return values.length > 0 ? values.join(":") : null;
}

async function persist(
  database: DatabaseAdapter,
  connectionId: string,
  wines: readonly JsonRecord[],
): Promise<number> {
  const payload = JSON.stringify(wines);
  const result = await database.transaction(async (transaction) => transaction.query<{
    changed: unknown;
    retired: unknown;
  }>(sql`
    WITH source AS MATERIALIZED (
      SELECT value AS wine
      FROM jsonb_array_elements(${payload}::jsonb) value
    ),
    upserted AS (
      INSERT INTO public.winerim_wines (
        connection_id, winerim_id, name, vintage, wine_type, is_active,
        price, bottle_sale_price, bottle_purchase_price,
        glass_sale_price, glass_cost_price,
        magnum_sale_price, magnum_purchase_price,
        bottle_stock_id, glass_stock_id, magnum_stock_id,
        serve_by_glass, pricing_status, pricing_missing_reason, raw_payload
      )
      SELECT
        ${connectionId}::uuid,
        wine->>'winerim_id',
        wine->>'name',
        nullif(wine->>'vintage', ''),
        nullif(wine->>'wine_type', ''),
        (wine->>'is_active')::boolean,
        nullif(wine->>'price', '')::numeric,
        nullif(wine->>'bottle_sale_price', '')::numeric,
        nullif(wine->>'bottle_purchase_price', '')::numeric,
        nullif(wine->>'glass_sale_price', '')::numeric,
        nullif(wine->>'glass_cost_price', '')::numeric,
        nullif(wine->>'magnum_sale_price', '')::numeric,
        nullif(wine->>'magnum_purchase_price', '')::numeric,
        nullif(wine->>'bottle_stock_id', '')::bigint,
        nullif(wine->>'glass_stock_id', '')::bigint,
        nullif(wine->>'magnum_stock_id', '')::bigint,
        (wine->>'serve_by_glass')::boolean,
        wine->>'pricing_status',
        nullif(wine->>'pricing_missing_reason', ''),
        wine->'raw_payload'
      FROM source
      ON CONFLICT (connection_id, winerim_id) DO UPDATE SET
        name = excluded.name,
        vintage = excluded.vintage,
        wine_type = excluded.wine_type,
        is_active = excluded.is_active,
        price = excluded.price,
        bottle_sale_price = excluded.bottle_sale_price,
        bottle_purchase_price = excluded.bottle_purchase_price,
        glass_sale_price = excluded.glass_sale_price,
        glass_cost_price = excluded.glass_cost_price,
        magnum_sale_price = excluded.magnum_sale_price,
        magnum_purchase_price = excluded.magnum_purchase_price,
        bottle_stock_id = excluded.bottle_stock_id,
        glass_stock_id = excluded.glass_stock_id,
        magnum_stock_id = excluded.magnum_stock_id,
        serve_by_glass = excluded.serve_by_glass,
        pricing_status = excluded.pricing_status,
        pricing_missing_reason = excluded.pricing_missing_reason,
        raw_payload = excluded.raw_payload,
        updated_at = now()
      WHERE (
        winerim_wines.name, winerim_wines.vintage, winerim_wines.wine_type,
        winerim_wines.is_active, winerim_wines.price,
        winerim_wines.bottle_sale_price, winerim_wines.bottle_purchase_price,
        winerim_wines.glass_sale_price, winerim_wines.glass_cost_price,
        winerim_wines.magnum_sale_price, winerim_wines.magnum_purchase_price,
        winerim_wines.bottle_stock_id, winerim_wines.glass_stock_id,
        winerim_wines.magnum_stock_id,
        winerim_wines.serve_by_glass, winerim_wines.pricing_status,
        winerim_wines.pricing_missing_reason, winerim_wines.raw_payload
      ) IS DISTINCT FROM (
        excluded.name, excluded.vintage, excluded.wine_type,
        excluded.is_active, excluded.price,
        excluded.bottle_sale_price, excluded.bottle_purchase_price,
        excluded.glass_sale_price, excluded.glass_cost_price,
        excluded.magnum_sale_price, excluded.magnum_purchase_price,
        excluded.bottle_stock_id, excluded.glass_stock_id,
        excluded.magnum_stock_id,
        excluded.serve_by_glass, excluded.pricing_status,
        excluded.pricing_missing_reason, excluded.raw_payload
      )
      RETURNING 1
    ),
    retired AS (
      UPDATE public.winerim_wines target
      SET is_active = false,
          pricing_status = 'MISSING',
          pricing_missing_reason = 'deleted_in_winerim',
          updated_at = now()
      WHERE target.connection_id = ${connectionId}::uuid
        AND target.is_active = true
        AND NOT EXISTS (
          SELECT 1 FROM source
          WHERE source.wine->>'winerim_id' = target.winerim_id
        )
      RETURNING 1
    )
    SELECT
      (SELECT count(*) FROM upserted)::int AS changed,
      (SELECT count(*) FROM retired)::int AS retired
  `), { isolationLevel: "serializable" });
  const row = result.rows[0];
  return Math.max(0, Number(row?.changed ?? 0)) + Math.max(0, Number(row?.retired ?? 0));
}

export function createWinerimCatalogRefreshPort(
  options: WinerimCatalogRefreshOptions,
): WinerimCatalogRefreshPort {
  const http = createSafeHttpClient({
    target: "winerim",
    baseUrl: options.baseUrl,
    allowedHosts: options.allowedHosts,
    allowedProtocols: ["https:"],
    timeoutMs: options.timeoutMs ?? WINERIM_CATALOG_REFRESH_TIMEOUT_MS,
    maxResponseBytes: WINERIM_CATALOG_MAX_RESPONSE_BYTES,
    request: options.request,
    timer: options.timer,
  });

  return Object.freeze({
    async refresh(input): Promise<CatalogRefreshResult> {
      void input.messageId;
      void input.idempotencyKey;
      let stage = "credential";
      try {
        const requestHeaders = await headers(input.credential);
        const listed: JsonRecord[] = [];
        let totalPages = 1;
        stage = "list";
        for (let page = 1; page <= totalPages; page++) {
          if (page > MAX_PAGES) throw new Error("WINERIM_CATALOG_PAGE_LIMIT");
          const response = await http.request({
            operation: "winerim.catalog-list",
            method: "GET",
            path: LIST_PATH,
            query: { page: String(page), limit: String(PAGE_SIZE) },
            headers: requestHeaders,
          });
          const payload = record(response.body);
          if (!response.ok || !payload || payload.success !== true || !Array.isArray(payload.wines)) {
            logRefreshFailure({
              operation: "winerim.catalog-list",
              route: `${LIST_PATH}?page=${page}&limit=${PAGE_SIZE}`,
              httpStatus: response.status || 502,
              errorCode: "WINERIM_CATALOG_LIST_FAILED",
            });
            return {
              ok: false,
              httpStatus: response.status || 502,
              message: "WINERIM_CATALOG_LIST_FAILED",
              diagnostic: {
                operation: "winerim.catalog-list",
                route: `${LIST_PATH}?page=${page}&limit=${PAGE_SIZE}`,
                httpStatus: response.status || 502,
                errorCode: "WINERIM_CATALOG_LIST_FAILED",
              },
            };
          }
          for (const value of payload.wines) {
            const wine = record(value);
            if (!wine || !wineId(wine.id)) throw new Error("WINERIM_CATALOG_INVALID_LIST");
            listed.push(wine);
          }
          if (listed.length > MAX_WINES) throw new Error("WINERIM_CATALOG_WINE_LIMIT");
          const pagination = record(payload.pagination);
          const observedPages = Number(pagination?.total_pages ?? 1);
          if (!Number.isSafeInteger(observedPages) || observedPages < page || observedPages > MAX_PAGES) {
            throw new Error("WINERIM_CATALOG_INVALID_PAGINATION");
          }
          totalPages = observedPages;
        }
        if (listed.length === 0) throw new Error("WINERIM_CATALOG_EMPTY");

        const listedById = new Map(listed.map((wine) => [wineId(wine.id) as string, wine]));
        const details: JsonRecord[] = [];
        const ids = [...listedById.keys()];
        stage = "bulk";
        for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
          const batch = ids.slice(offset, offset + PAGE_SIZE);
          const response = await http.request({
            operation: "winerim.catalog-bulk",
            method: "POST",
            path: BULK_PATH,
            headers: requestHeaders,
            body: { ids: batch.map(Number) },
          });
          const payload = record(response.body);
          if (!response.ok || !payload || payload.success !== true || !Array.isArray(payload.wines)) {
            logRefreshFailure({
              operation: "winerim.catalog-bulk",
              route: BULK_PATH,
              httpStatus: response.status || 502,
              errorCode: `WINERIM_CATALOG_BULK_FAILED_OFFSET_${offset}`,
            });
            return {
              ok: false,
              httpStatus: response.status || 502,
              message: "WINERIM_CATALOG_BULK_FAILED",
              diagnostic: {
                operation: "winerim.catalog-bulk",
                route: BULK_PATH,
                httpStatus: response.status || 502,
                errorCode: `WINERIM_CATALOG_BULK_FAILED_OFFSET_${offset}`,
              },
            };
          }
          const returned = new Set<string>();
          stage = "normalize";
          for (const value of payload.wines) {
            const detail = record(value);
            const id = wineId(detail?.id);
            if (!detail || !id || !batch.includes(id) || returned.has(id)) {
              throw new Error("WINERIM_CATALOG_INVALID_BULK");
            }
            returned.add(id);
            details.push(normalizedWine(detail, listedById.get(id) as JsonRecord));
          }
          if (returned.size !== batch.length) throw new Error("WINERIM_CATALOG_INCOMPLETE_BULK");
          stage = "bulk";
        }

        if (input.dryRun) return { ok: true, outcome: "complete", changed: 0 };
        stage = "persist";
        const changed = await persist(options.database, input.connectionId, details);
        return { ok: true, outcome: changed === 0 ? "duplicate" : "complete", changed };
      } catch (error) {
        if (error instanceof HttpAdapterError) {
          const diagnostic = httpDiagnostic(error);
          logRefreshFailure(diagnostic);
          return {
            ok: false,
            httpStatus: error.diagnostic?.status ?? 503,
            message: error.code,
            diagnostic,
          };
        }
        const errorCode = safeRefreshErrorCode(error);
        logRefreshFailure({
          operation: `winerim.catalog-refresh.${stage}`,
          errorCode: safeDatabaseErrorCode(error) ?? errorCode,
        });
        return { ok: false, httpStatus: 503, message: errorCode };
      }
    },
  });
}
