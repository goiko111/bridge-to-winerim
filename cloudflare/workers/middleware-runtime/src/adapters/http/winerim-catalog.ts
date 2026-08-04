import { canonicalJson, sha256Hex } from "../../idempotency";
import type { JsonValue } from "../../contracts";
import {
  HttpAdapterError,
  type HttpLoggerPort,
  type HttpRequestPort,
  type HttpTimerPort,
  type SecretTextPort,
} from "./contracts";
import { createSafeHttpClient, redactSensitiveText } from "./safe-http";

const BULK_WINES_PATH = "/api/v2/wines/bulk";
const WINES_PATH = "/api/v2/wines";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_WINE_ID_DIGITS = 15;
const MAX_PRODUCT_PRICE = 1_000_000;
const MAX_PRICES = 24;
const INVENTORY_PAGE_SIZE = 100;
const MAX_INVENTORY_PAGES = 100;
const INVENTORY_BULK_SIZE = 50;

export const WINERIM_CATALOG_REFRESH_VERSION = 1 as const;
export const WINERIM_CATALOG_BULK_ENDPOINT = BULK_WINES_PATH;
export const WINERIM_CATALOG_FORMATS = ["BOTTLE", "GLASS", "MAGNUM"] as const;

export type WinerimCatalogFormat = typeof WINERIM_CATALOG_FORMATS[number];

export type WinerimCatalogVariantSnapshot = Readonly<{
  format: WinerimCatalogFormat;
  salePrice: number;
  costPrice: number;
  enabled: true;
}>;

export type WinerimCatalogWineSnapshot = Readonly<{
  winerimId: string;
  name: string;
  vintage: string | null;
  wineType: string | null;
  active: boolean;
  variant: WinerimCatalogVariantSnapshot;
}>;

export type WinerimCatalogRead = Readonly<{
  fingerprint: string;
  wine: WinerimCatalogWineSnapshot;
}>;

export type WinerimCatalogClient = Readonly<{
  fetchOne(input: Readonly<{
    winerimWineId: string;
    format: WinerimCatalogFormat;
  }>): Promise<WinerimCatalogRead>;
}>;

export type WinerimCatalogInventoryWine = Readonly<{
  winerimId: string;
  name: string;
  vintage: string | null;
  wineType: string | null;
  active: boolean;
  variants: readonly WinerimCatalogVariantSnapshot[];
  raw: Readonly<Record<string, unknown>>;
}>;

export type WinerimCatalogInventory = Readonly<{
  wines: readonly WinerimCatalogInventoryWine[];
  fingerprint: string;
}>;

export type WinerimCatalogInventoryClient = Readonly<{
  fetchInventory(): Promise<WinerimCatalogInventory>;
}>;

export type WinerimCatalogClientOptions = Readonly<{
  baseUrl: string;
  allowedHosts: readonly string[];
  credential: SecretTextPort;
  request: HttpRequestPort;
  timer: HttpTimerPort;
  logger?: HttpLoggerPort;
  timeoutMs?: number;
  maxResponseBytes?: number;
}>;

export type WinerimCatalogErrorCode =
  | "WINERIM_CATALOG_INVALID_TARGET"
  | "WINERIM_CATALOG_HTTP_ERROR"
  | "WINERIM_CATALOG_INVALID_RESPONSE"
  | "WINERIM_CATALOG_WINE_NOT_FOUND"
  | "WINERIM_CATALOG_AMBIGUOUS_RESPONSE"
  | "WINERIM_CATALOG_VARIANT_NOT_FOUND";

export class WinerimCatalogError extends Error {
  constructor(readonly code: WinerimCatalogErrorCode) {
    super(code);
    this.name = "WinerimCatalogError";
  }
}

type PriceEntry = Readonly<{
  variant: string;
  price: number | null;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validWineId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  if (!new RegExp(`^[1-9]\\d{0,${MAX_WINE_ID_DIGITS - 1}}$`).test(normalized)) return null;
  const numeric = Number(normalized);
  return Number.isSafeInteger(numeric) && numeric > 0 ? normalized : null;
}

function boundedText(value: unknown, maximum: number, required = false): string | null {
  if (value === null || value === undefined || value === "") {
    if (required) throw new WinerimCatalogError("WINERIM_CATALOG_INVALID_RESPONSE");
    return null;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new WinerimCatalogError("WINERIM_CATALOG_INVALID_RESPONSE");
  }
  const normalized = redactSensitiveText(String(value)).replace(/\s+/g, " ").trim();
  if ((!normalized && required) || normalized.length > maximum) {
    throw new WinerimCatalogError("WINERIM_CATALOG_INVALID_RESPONSE");
  }
  return normalized || null;
}

function decimal(value: unknown, positive: boolean): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") {
    throw new WinerimCatalogError("WINERIM_CATALOG_INVALID_RESPONSE");
  }
  const raw = String(value).trim();
  if (!/^\d{1,9}(?:\.\d{1,4})?$/.test(raw)) {
    throw new WinerimCatalogError("WINERIM_CATALOG_INVALID_RESPONSE");
  }
  const normalized = Number(raw);
  if (!Number.isFinite(normalized) || normalized > MAX_PRODUCT_PRICE || (positive ? normalized <= 0 : normalized < 0)) {
    throw new WinerimCatalogError("WINERIM_CATALOG_INVALID_RESPONSE");
  }
  return normalized;
}

function firstDefined(source: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    if (source[name] !== undefined && source[name] !== null) return source[name];
  }
  return null;
}

function normalizedVariant(value: string): WinerimCatalogFormat | null {
  const variant = value.trim().toLowerCase();
  if (["bottle", "botella", "botella-pequena", "media-botella"].includes(variant)) return "BOTTLE";
  if (["glass", "copa"].includes(variant)) return "GLASS";
  if (variant === "magnum") return "MAGNUM";
  return null;
}

function priceEntries(wine: Record<string, unknown>): PriceEntry[] {
  if (wine.prices === undefined || wine.prices === null) return [];
  if (!Array.isArray(wine.prices) || wine.prices.length > MAX_PRICES) {
    throw new WinerimCatalogError("WINERIM_CATALOG_INVALID_RESPONSE");
  }
  return wine.prices.map((value) => {
    const entry = record(value);
    if (!entry) throw new WinerimCatalogError("WINERIM_CATALOG_INVALID_RESPONSE");
    const variant = boundedText(entry.variant, 32, true);
    return {
      variant: variant as string,
      price: decimal(entry.price, true),
    };
  });
}

function salePriceFields(format: WinerimCatalogFormat): readonly string[] {
  if (format === "BOTTLE") return ["bottle_sale_price", "sale_price", "pvp", "price"];
  if (format === "GLASS") return ["glass_sale_price", "glass_price"];
  return ["magnum_sale_price"];
}

function costPriceFields(format: WinerimCatalogFormat): readonly string[] {
  if (format === "BOTTLE") return ["bottle_purchase_price", "purchase_price", "cost_price", "cost"];
  if (format === "GLASS") return ["glass_cost_price", "glass_cost"];
  return ["magnum_purchase_price", "magnum_cost"];
}

function normalizeWine(
  value: unknown,
  expectedWineId: string,
  format: WinerimCatalogFormat,
): WinerimCatalogWineSnapshot {
  const wine = record(value);
  if (!wine || validWineId(wine.id) !== expectedWineId) {
    throw new WinerimCatalogError("WINERIM_CATALOG_INVALID_RESPONSE");
  }
  const entries = priceEntries(wine);
  const matching = entries.filter((entry) => normalizedVariant(entry.variant) === format);
  if (matching.length > 1) {
    throw new WinerimCatalogError("WINERIM_CATALOG_AMBIGUOUS_RESPONSE");
  }
  const salePrice = matching[0]?.price ?? decimal(firstDefined(wine, salePriceFields(format)), true);
  if (salePrice === null) {
    throw new WinerimCatalogError("WINERIM_CATALOG_VARIANT_NOT_FOUND");
  }
  const costPrice = decimal(firstDefined(wine, costPriceFields(format)), false) ?? 0;
  const rawType = firstDefined(wine, ["type", "wine_type", "category", "style", "color", "colour"]);
  const status = boundedText(wine.status, 32)?.toLowerCase();
  if (wine.active !== undefined && typeof wine.active !== "boolean") {
    throw new WinerimCatalogError("WINERIM_CATALOG_INVALID_RESPONSE");
  }
  if (wine.is_active !== undefined && typeof wine.is_active !== "boolean") {
    throw new WinerimCatalogError("WINERIM_CATALOG_INVALID_RESPONSE");
  }
  return Object.freeze({
    winerimId: expectedWineId,
    name: boundedText(wine.name, 200, true) as string,
    vintage: boundedText(wine.vintage ?? wine.year, 16),
    wineType: boundedText(rawType, 80)?.toLowerCase() ?? null,
    active: wine.active !== false && wine.is_active !== false && status !== "inactive",
    variant: Object.freeze({ format, salePrice, costPrice, enabled: true as const }),
  });
}

function inventoryWine(value: unknown, expectedWineId: string): WinerimCatalogInventoryWine {
  const raw = record(value);
  if (!raw || validWineId(raw.id) !== expectedWineId) {
    throw new WinerimCatalogError("WINERIM_CATALOG_INVALID_RESPONSE");
  }
  const variants: WinerimCatalogVariantSnapshot[] = [];
  let common: WinerimCatalogWineSnapshot | null = null;
  for (const format of WINERIM_CATALOG_FORMATS) {
    try {
      const normalized = normalizeWine(raw, expectedWineId, format);
      common ??= normalized;
      variants.push(normalized.variant);
    } catch (error) {
      if (!(error instanceof WinerimCatalogError) || error.code !== "WINERIM_CATALOG_VARIANT_NOT_FOUND") {
        throw error;
      }
    }
  }
  if (!common) {
    const name = boundedText(raw.name, 200, true) as string;
    const status = boundedText(raw.status, 32)?.toLowerCase();
    common = {
      winerimId: expectedWineId,
      name,
      vintage: boundedText(raw.vintage ?? raw.year, 16),
      wineType: boundedText(firstDefined(raw, ["type", "wine_type", "category", "style", "color", "colour"]), 80)?.toLowerCase() ?? null,
      active: raw.active !== false && raw.is_active !== false && status !== "inactive",
      variant: { format: "BOTTLE", salePrice: 0, costPrice: 0, enabled: true },
    };
  }
  return Object.freeze({
    winerimId: common.winerimId,
    name: common.name,
    vintage: common.vintage,
    wineType: common.wineType,
    active: common.active,
    variants: Object.freeze(variants.sort((left, right) => left.format.localeCompare(right.format))),
    raw: Object.freeze({ ...raw }),
  });
}

async function credentialHeaders(credential: SecretTextPort): Promise<Readonly<Record<string, string>>> {
  let token: string;
  try {
    token = String(await credential.read()).trim();
  } catch {
    throw new HttpAdapterError("HTTP_CREDENTIAL_UNAVAILABLE");
  }
  if (!token || /[\r\n]/.test(token)) throw new HttpAdapterError("HTTP_CREDENTIAL_UNAVAILABLE");
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "WINERIM-API-TOKEN": token,
  };
}

export function createWinerimCatalogClient(options: WinerimCatalogClientOptions): WinerimCatalogClient {
  const http = createSafeHttpClient({
    target: "winerim",
    baseUrl: options.baseUrl,
    allowedHosts: options.allowedHosts,
    allowedProtocols: ["https:"],
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    request: options.request,
    timer: options.timer,
    logger: options.logger,
  });

  return Object.freeze({
    async fetchOne(input): Promise<WinerimCatalogRead> {
      const winerimWineId = validWineId(input.winerimWineId);
      if (!winerimWineId || !WINERIM_CATALOG_FORMATS.includes(input.format)) {
        throw new WinerimCatalogError("WINERIM_CATALOG_INVALID_TARGET");
      }
      const response = await http.request({
        operation: "winerim.catalog-bulk-one",
        method: "POST",
        path: BULK_WINES_PATH,
        headers: await credentialHeaders(options.credential),
        body: { ids: [Number(winerimWineId)] },
      });
      if (!response.ok) throw new WinerimCatalogError("WINERIM_CATALOG_HTTP_ERROR");
      const payload = record(response.body);
      if (!payload || payload.success !== true || !Array.isArray(payload.wines)) {
        throw new WinerimCatalogError("WINERIM_CATALOG_INVALID_RESPONSE");
      }
      if (payload.wines.length === 0) {
        throw new WinerimCatalogError("WINERIM_CATALOG_WINE_NOT_FOUND");
      }
      if (payload.wines.length !== 1) {
        throw new WinerimCatalogError("WINERIM_CATALOG_AMBIGUOUS_RESPONSE");
      }
      const wine = normalizeWine(payload.wines[0], winerimWineId, input.format);
      const fingerprint = await sha256Hex(canonicalJson(wine as unknown as JsonValue));
      return Object.freeze({ fingerprint, wine });
    },
  });
}

export function createWinerimCatalogInventoryClient(
  options: WinerimCatalogClientOptions,
): WinerimCatalogInventoryClient {
  const http = createSafeHttpClient({
    target: "winerim",
    baseUrl: options.baseUrl,
    allowedHosts: options.allowedHosts,
    allowedProtocols: ["https:"],
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResponseBytes: Math.max(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 4 * 1024 * 1024),
    request: options.request,
    timer: options.timer,
    logger: options.logger,
  });

  return Object.freeze({
    async fetchInventory(): Promise<WinerimCatalogInventory> {
      const headers = await credentialHeaders(options.credential);
      const listed = new Map<string, Record<string, unknown>>();
      for (let page = 1; page <= MAX_INVENTORY_PAGES; page++) {
        const response = await http.request({
          operation: "winerim.catalog-list",
          method: "GET",
          path: WINES_PATH,
          query: { page: String(page), limit: String(INVENTORY_PAGE_SIZE) },
          headers,
        });
        if (!response.ok) throw new WinerimCatalogError("WINERIM_CATALOG_HTTP_ERROR");
        const payload = record(response.body);
        if (!payload || payload.success !== true || !Array.isArray(payload.wines)) {
          throw new WinerimCatalogError("WINERIM_CATALOG_INVALID_RESPONSE");
        }
        for (const value of payload.wines) {
          const wine = record(value);
          const id = validWineId(wine?.id);
          if (!wine || !id || listed.has(id)) {
            throw new WinerimCatalogError("WINERIM_CATALOG_INVALID_RESPONSE");
          }
          listed.set(id, wine);
        }
        const pagination = record(payload.pagination);
        const totalPages = Number(pagination?.total_pages ?? 1);
        if (!Number.isInteger(totalPages) || totalPages < 1 || totalPages > MAX_INVENTORY_PAGES) {
          throw new WinerimCatalogError("WINERIM_CATALOG_INVALID_RESPONSE");
        }
        if (page >= totalPages) break;
      }

      const ids = [...listed.keys()].sort((left, right) => Number(left) - Number(right));
      const detailed = new Map<string, Record<string, unknown>>();
      for (let offset = 0; offset < ids.length; offset += INVENTORY_BULK_SIZE) {
        const batch = ids.slice(offset, offset + INVENTORY_BULK_SIZE);
        const response = await http.request({
          operation: "winerim.catalog-bulk-inventory",
          method: "POST",
          path: BULK_WINES_PATH,
          headers,
          body: { ids: batch.map(Number) },
        });
        if (!response.ok) throw new WinerimCatalogError("WINERIM_CATALOG_HTTP_ERROR");
        const payload = record(response.body);
        if (!payload || payload.success !== true || !Array.isArray(payload.wines)) {
          throw new WinerimCatalogError("WINERIM_CATALOG_INVALID_RESPONSE");
        }
        for (const value of payload.wines) {
          const wine = record(value);
          const id = validWineId(wine?.id);
          if (!wine || !id || !listed.has(id) || detailed.has(id)) {
            throw new WinerimCatalogError("WINERIM_CATALOG_INVALID_RESPONSE");
          }
          detailed.set(id, { ...listed.get(id), ...wine });
        }
      }
      if (detailed.size !== ids.length) {
        throw new WinerimCatalogError("WINERIM_CATALOG_INVALID_RESPONSE");
      }
      const wines = ids.map((id) => inventoryWine(detailed.get(id), id));
      const fingerprint = await sha256Hex(canonicalJson(wines.map((wine) => ({
        winerimId: wine.winerimId,
        name: wine.name,
        vintage: wine.vintage,
        wineType: wine.wineType,
        active: wine.active,
        variants: wine.variants,
      })) as unknown as JsonValue));
      return Object.freeze({ wines: Object.freeze(wines), fingerprint });
    },
  });
}
