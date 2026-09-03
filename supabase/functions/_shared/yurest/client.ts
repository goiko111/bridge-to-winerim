export interface YurestClientConfig {
  baseUrl?: string;
  email: string;
  password: string;
  providerToken: string;
  storeId: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface YurestListParams {
  page?: number;
  per_page?: number;
  [key: string]: string | number | boolean | undefined;
}

export interface YurestProductCostStore {
  store_id: number;
  store_name?: string | null;
  [key: string]: unknown;
}

export interface YurestProductCost {
  product_id: number;
  product_name: string;
  stores?: YurestProductCostStore[];
  [key: string]: unknown;
}

export interface YurestPage<T> {
  items: T[];
  pagination?: {
    page?: number;
    per_page?: number;
    total?: number;
    last_page?: number;
    next?: string | null;
  };
}

export class YurestHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint: string,
    public readonly responseMessage?: string,
  ) {
    super(message);
    this.name = "YurestHttpError";
  }
}

export function normalizeYurestBaseUrl(value = "https://cliente.yurest.com/ws"): string {
  const raw = value.trim().replace(/\/+$/, "");
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Yurest base URL must use HTTPS");
  return raw.endsWith("/ws") ? raw : `${raw}/ws`;
}

function buildQuery(params: YurestListParams = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parsePage<T>(value: unknown): YurestPage<T> {
  const root = asRecord(value);
  const data = asRecord(root.data);
  return {
    items: Array.isArray(data.items) ? data.items as T[] : [],
    pagination: asRecord(data.pagination) as YurestPage<T>["pagination"],
  };
}

export function createYurestClient(config: YurestClientConfig) {
  const baseUrl = normalizeYurestBaseUrl(config.baseUrl);
  const timeoutMs = config.timeoutMs ?? 20_000;
  const fetchImpl = config.fetchImpl ?? fetch;
  let accessToken: string | null = null;

  async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function parseResponse(response: Response, endpoint: string): Promise<unknown> {
    const text = await response.text();
    let parsed: unknown = null;
    if (text.trim()) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      const responseMessage = typeof parsed === "object" && parsed
        ? String((parsed as Record<string, unknown>).message ?? "")
        : "";
      throw new YurestHttpError(
        `Yurest request failed with HTTP ${response.status}`,
        response.status,
        endpoint,
        responseMessage || undefined,
      );
    }
    return parsed;
  }

  async function login(force = false): Promise<string> {
    if (accessToken && !force) return accessToken;
    const response = await fetchWithTimeout(`${baseUrl}/v2/auth/login`, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Provider-Token": config.providerToken,
      },
      body: JSON.stringify({ email: config.email, password: config.password }),
    });
    const parsed = asRecord(await parseResponse(response, "/v2/auth/login"));
    const data = asRecord(parsed.data);
    const token = typeof data.access_token === "string" ? data.access_token.trim() : "";
    if (!token) throw new Error("Yurest login returned no access token");
    accessToken = token;
    return token;
  }

  async function request(path: string, options: RequestInit = {}, retryAuth = true): Promise<unknown> {
    const token = await login();
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("X-Provider-Token", config.providerToken);
    const response = await fetchWithTimeout(`${baseUrl}${path}`, { ...options, headers });

    if (response.status === 401 && retryAuth) {
      await login(true);
      return request(path, options, false);
    }
    return parseResponse(response, path.split("?")[0]);
  }

  function scopedParams(params: YurestListParams = {}): YurestListParams {
    return { ...params, store_id: config.storeId };
  }

  function validateStore(value: unknown, endpoint: string): void {
    const root = asRecord(value);
    const data = asRecord(root.data);
    const store = asRecord(data.store);
    const storeId = Number(store.id ?? data.store_id);
    if (!Number.isFinite(storeId) || storeId !== config.storeId) {
      throw new YurestHttpError("Yurest resource is outside the configured store", 403, endpoint);
    }
  }

  async function listAllProductCostsForStore(maxPages = 50): Promise<{
    items: YurestProductCost[];
    scannedProducts: number;
    pagesScanned: number;
  }> {
    const items: YurestProductCost[] = [];
    let scannedProducts = 0;
    let pagesScanned = 0;

    for (let page = 1; page <= maxPages; page += 1) {
      const response = await request(`/v2/products/costs${buildQuery({ page, per_page: 200 })}`);
      const parsed = parsePage<YurestProductCost>(response);
      pagesScanned = page;
      scannedProducts += parsed.items.length;
      for (const product of parsed.items) {
        const stores = Array.isArray(product.stores)
          ? product.stores.filter((store) => Number(store.store_id) === config.storeId)
          : [];
        if (stores.length) items.push({ ...product, stores });
      }
      if (parsed.items.length < 200 || (parsed.pagination?.last_page && page >= parsed.pagination.last_page)) break;
    }

    return { items, scannedProducts, pagesScanned };
  }

  async function listStock(locationId: number, params: YurestListParams = {}) {
    const locations = parsePage<Record<string, unknown>>(
      await request(`/v2/stores/warehouse-locations${buildQuery(scopedParams({ per_page: 200 }))}`),
    );
    const belongsToStore = locations.items.some((location) =>
      Number(location.id) === locationId && Number(location.store_id) === config.storeId
    );
    if (!belongsToStore) {
      throw new YurestHttpError("Warehouse location is outside the configured store", 403, "/v2/stock");
    }
    return request(`/v2/stock${buildQuery({ ...params, location_id: locationId })}`);
  }

  async function getInventory(id: number) {
    const endpoint = `/v2/stores/warehouse-locations/inventories/${encodeURIComponent(String(id))}`;
    const response = await request(endpoint);
    validateStore(response, endpoint);
    return response;
  }

  return {
    login,
    listProducts: (params: YurestListParams = {}) => request(`/v2/products${buildQuery(params)}`),
    listAllProductCostsForStore,
    listWarehouseLocations: (params: YurestListParams = {}) =>
      request(`/v2/stores/warehouse-locations${buildQuery(scopedParams(params))}`),
    listStock,
    listStockMovements: (params: YurestListParams = {}) =>
      request(`/v2/stock/movements${buildQuery(scopedParams(params))}`),
    listInventories: (params: YurestListParams = {}) =>
      request(`/v2/stores/warehouse-locations/inventories${buildQuery(scopedParams(params))}`),
    getInventory,
    listProviders: (params: YurestListParams = {}) => request(`/v2/providers${buildQuery(params)}`),
    listProviderProducts: (params: YurestListParams = {}) =>
      request(`/v2/provider-products${buildQuery(params)}`),
  };
}
