const BASE_URL = "https://app.winerim.com/api/v2";
const ROUTES = {
  restaurants: "/restaurants",
  sales: "/sales/records",
  movements: "/stock/movements",
  stock: "/stock",
} as const;

export class FleetContractError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 500) {
    super(message);
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type FetchLike = typeof fetch;

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const asInt = (value: unknown, label: string) => {
  if (!Number.isInteger(value)) throw new FleetContractError("INVALID_RESPONSE", `${label} debe ser entero`, 502);
  return Number(value);
};
const asBool = (value: unknown, label: string) => {
  if (typeof value !== "boolean") throw new FleetContractError("INVALID_RESPONSE", `${label} debe ser booleano`, 502);
  return value;
};
const asArray = (value: unknown, label: string) => {
  if (!Array.isArray(value)) throw new FleetContractError("INVALID_RESPONSE", `${label} debe ser array`, 502);
  return value;
};

function validateRestaurantId(payload: Record<string, unknown>, expected: number): void {
  if (asInt(payload.restaurantId, "restaurantId") !== expected) throw new FleetContractError("RESTAURANT_MISMATCH", "restaurantId no coincide con la consulta", 502);
}

export type RestaurantPage = {
  data: Array<{ restaurantId: number; erpId?: number | string; name?: string; timezone?: string; currency?: string; active?: boolean }>;
  pagination?: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean };
  nextCursor?: string | null;
  hasMore: boolean;
};

export type SalesPage = {
  restaurantId: number;
  data: unknown[];
  deletions: unknown[];
  pagination?: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean };
  sync?: { nextCursor: string; hasMore: boolean };
};

export type MovementPage = { restaurantId: number; data: unknown[]; nextAfterId: number | null; hasMore: boolean };

export type StockPage = {
  success: true;
  pagination: { page: number; limit: number; total_count: number; total_pages: number };
  stocks: Array<{
    id: number;
    stock: number | null;
    stockActive: boolean;
    treshold: number | null;
    tresholdActive: boolean;
    maxQty: number | null;
    winePrice: {
      price: string | null;
      variant: string | null;
      wine: { id: number; name: string | null; vintage: string | null; slugname: string | null };
    };
  }>;
};

function validateStockPage(value: unknown): StockPage {
  if (!isObject(value) || value.success !== true || !isObject(value.pagination)) throw new FleetContractError("INVALID_STOCK_RESPONSE", "Respuesta /stock inválida", 502);
  const rows = asArray(value.stocks, "stocks");
  const page = asInt(value.pagination.page, "pagination.page");
  const limit = asInt(value.pagination.limit, "pagination.limit");
  const total_count = asInt(value.pagination.total_count, "pagination.total_count");
  const total_pages = asInt(value.pagination.total_pages, "pagination.total_pages");
  const stocks = rows.map((row, index) => {
    if (!isObject(row) || !isObject(row.winePrice) || !isObject(row.winePrice.wine)) throw new FleetContractError("INVALID_STOCK_RESPONSE", `stocks[${index}] inválido`, 502);
    return {
      id: asInt(row.id, `stocks[${index}].id`),
      stock: row.stock == null ? null : Number(row.stock),
      stockActive: asBool(row.stockActive, `stocks[${index}].stockActive`),
      treshold: row.treshold == null ? null : Number(row.treshold),
      tresholdActive: asBool(row.tresholdActive, `stocks[${index}].tresholdActive`),
      maxQty: row.maxQty == null ? null : Number(row.maxQty),
      winePrice: {
        price: row.winePrice.price == null ? null : String(row.winePrice.price),
        variant: row.winePrice.variant == null ? null : String(row.winePrice.variant),
        wine: {
          id: asInt(row.winePrice.wine.id, `stocks[${index}].winePrice.wine.id`),
          name: row.winePrice.wine.name == null ? null : String(row.winePrice.wine.name),
          vintage: row.winePrice.wine.vintage == null ? null : String(row.winePrice.wine.vintage),
          slugname: row.winePrice.wine.slugname == null ? null : String(row.winePrice.wine.slugname),
        },
      },
    };
  });
  return { success: true, pagination: { page, limit, total_count, total_pages }, stocks };
}

function validateOffsetInstant(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new FleetContractError("INVALID_CHANGED_SINCE", "changedSince debe ser ISO-8601 con offset", 400);
  }
  const age = Date.now() - Date.parse(value);
  if (age < 0 || age > 370 * 86_400_000) throw new FleetContractError("INVALID_CHANGED_SINCE", "changedSince fuera del rango permitido", 400);
}

function retryDelay(response: Response, attempt: number): number | null {
  if (response.status === 429) {
    const seconds = Number(response.headers.get("Retry-After") || 1);
    return Math.min(Math.max(seconds, 1), 30) * 1000;
  }
  if (response.status >= 500 && response.status <= 504) return Math.min(1000 * (2 ** attempt), 8000);
  return null;
}

export function createWinerimFleetClient(options: { token: string; fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void>; baseUrl?: string }) {
  if (!options.token.startsWith("wfk_")) throw new FleetContractError("INVALID_FLEET_TOKEN", "WINERIM_FLEET_READ_TOKEN debe ser una credencial de flota", 500);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const baseUrl = options.baseUrl ?? BASE_URL;
  let callCount = 0;

  async function fixedGet(path: (typeof ROUTES)[keyof typeof ROUTES], params: Record<string, string | number | undefined>): Promise<unknown> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") query.set(key, String(value));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      callCount += 1;
      const response = await fetchImpl(`${baseUrl}${path}?${query}`, { method: "GET", headers: { Accept: "application/json", "WINERIM-API-TOKEN": options.token } });
      if ([400, 401, 403, 404].includes(response.status)) throw new FleetContractError(`HTTP_${response.status}`, `Winerim rechazó ${path}`, response.status);
      if (!response.ok) {
        const delay = retryDelay(response, attempt);
        if (delay != null && attempt < 2) { await sleep(delay); continue; }
        throw new FleetContractError(`HTTP_${response.status}`, `Error Winerim en ${path}`, response.status);
      }
      return await response.json() as Json;
    }
    throw new FleetContractError("RETRIES_EXHAUSTED", `Reintentos agotados en ${path}`, 503);
  }

  return {
    get callCount() { return callCount; },
    async restaurants(page = 1, cursor?: string): Promise<RestaurantPage> {
      const raw = await fixedGet(ROUTES.restaurants, { page, cursor, limit: 100 });
      if (!isObject(raw)) throw new FleetContractError("INVALID_RESPONSE", "Respuesta /restaurants inválida", 502);
      const data = asArray(raw.data, "restaurants.data").map((row, index) => {
        if (!isObject(row)) throw new FleetContractError("INVALID_RESPONSE", `restaurants.data[${index}] inválido`, 502);
        return { ...row, restaurantId: asInt(row.restaurantId, `restaurants.data[${index}].restaurantId`) };
      });
      const pagination = isObject(raw.pagination) ? {
        page: asInt(raw.pagination.page, "pagination.page"), limit: asInt(raw.pagination.limit, "pagination.limit"),
        total: asInt(raw.pagination.total, "pagination.total"), totalPages: asInt(raw.pagination.totalPages, "pagination.totalPages"),
        hasMore: asBool(raw.pagination.hasMore, "pagination.hasMore"),
      } : undefined;
      return { data, pagination, nextCursor: raw.nextCursor == null ? null : String(raw.nextCursor), hasMore: pagination?.hasMore ?? Boolean(raw.hasMore) };
    },
    async salesSync(restaurantId: number, input: { changedSince?: string; cursor?: string; limit?: number }): Promise<SalesPage> {
      if (Boolean(input.changedSince) === Boolean(input.cursor)) throw new FleetContractError("INVALID_SYNC_CURSOR", "Indica changedSince o cursor, no ambos", 400);
      if (input.changedSince) validateOffsetInstant(input.changedSince);
      const raw = await fixedGet(ROUTES.sales, { restaurantId, changedSince: input.changedSince, cursor: input.cursor, limit: Math.min(input.limit ?? 100, 100) });
      if (!isObject(raw)) throw new FleetContractError("INVALID_RESPONSE", "Respuesta /sales/records inválida", 502);
      validateRestaurantId(raw, restaurantId);
      if (!isObject(raw.sync) || typeof raw.sync.nextCursor !== "string") throw new FleetContractError("INVALID_RESPONSE", "sync.nextCursor ausente", 502);
      return { restaurantId, data: asArray(raw.data, "data"), deletions: asArray(raw.deletions, "deletions"), sync: { nextCursor: raw.sync.nextCursor, hasMore: asBool(raw.sync.hasMore, "sync.hasMore") } };
    },
    async salesByDate(restaurantId: number, input: { from: string; to: string; page: number; status?: string }): Promise<SalesPage> {
      const raw = await fixedGet(ROUTES.sales, { restaurantId, from: input.from, to: input.to, page: input.page, limit: 100, status: input.status ?? "all" });
      if (!isObject(raw) || !isObject(raw.pagination)) throw new FleetContractError("INVALID_RESPONSE", "Respuesta paginada /sales/records inválida", 502);
      validateRestaurantId(raw, restaurantId);
      return { restaurantId, data: asArray(raw.data, "data"), deletions: [], pagination: {
        page: asInt(raw.pagination.page, "pagination.page"), limit: asInt(raw.pagination.limit, "pagination.limit"),
        total: asInt(raw.pagination.total, "pagination.total"), totalPages: asInt(raw.pagination.totalPages, "pagination.totalPages"),
        hasMore: asBool(raw.pagination.hasMore, "pagination.hasMore"),
      } };
    },
    async movements(restaurantId: number, input: { afterId?: number; from?: string; to?: string; category?: string }): Promise<MovementPage> {
      const raw = await fixedGet(ROUTES.movements, { restaurantId, ...input, limit: 100 });
      if (!isObject(raw)) throw new FleetContractError("INVALID_RESPONSE", "Respuesta /stock/movements inválida", 502);
      validateRestaurantId(raw, restaurantId);
      return { restaurantId, data: asArray(raw.data, "data"), nextAfterId: raw.nextAfterId == null ? null : asInt(raw.nextAfterId, "nextAfterId"), hasMore: asBool(raw.hasMore, "hasMore") };
    },
    async stock(restaurantId: number, page = 1): Promise<StockPage> {
      // Contract source: API_TOKEN_V2_DOCUMENTATION.html. The canonical OpenAPI
      // currently omits this route, so deployment remains gated on contract parity.
      return validateStockPage(await fixedGet(ROUTES.stock, { restaurantId, page, limit: 100 }));
    },
  };
}

export type WinerimFleetClient = ReturnType<typeof createWinerimFleetClient>;
