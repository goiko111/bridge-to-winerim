export interface TspoonlabClientConfig {
  baseUrl: string;
  username: string;
  password: string;
  orderCenterId?: string;
  recipeCenterId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface TspoonlabListParams {
  start?: number;
  rows?: number;
  filter?: string;
}

export class TspoonlabHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = "TspoonlabHttpError";
  }
}

export function normalizeTspoonlabBaseUrl(value: string): string {
  const raw = value.trim().replace(/\/+$/, "");
  if (!raw) return "https://app.tspoonlab.com/recipes/api";
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error("tSpoonLab base URL must use HTTPS");
  }
  return raw.endsWith("/recipes/api") ? raw : `${raw}/recipes/api`;
}

export function parseTspoonlabLoginToken(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("tSpoonLab login returned an empty token");

  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
    if (parsed && typeof parsed === "object") {
      for (const key of ["rememberme", "token", "value"]) {
        const candidate = (parsed as Record<string, unknown>)[key];
        if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
      }
    }
  } catch {
    // The documented login response is a plain token.
  }

  return value.replace(/^rememberme\s*:\s*/i, "").trim();
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

export function createTspoonlabClient(config: TspoonlabClientConfig) {
  const baseUrl = normalizeTspoonlabBaseUrl(config.baseUrl);
  const timeoutMs = config.timeoutMs ?? 20_000;
  const fetchImpl = config.fetchImpl ?? fetch;
  let rememberme: string | null = null;

  async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function login(): Promise<string> {
    if (rememberme) return rememberme;
    const body = new URLSearchParams({ username: config.username, password: config.password });
    const response = await fetchWithTimeout(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new TspoonlabHttpError(`tSpoonLab login failed with HTTP ${response.status}`, response.status, "/login");
    }
    rememberme = parseTspoonlabLoginToken(text);
    return rememberme;
  }

  async function request(path: string, options: RequestInit = {}, requireContext = true): Promise<unknown> {
    const token = await login();
    if (requireContext && !config.orderCenterId) {
      throw new Error("tSpoonLab order_center_id is required for this action");
    }

    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    headers.set("rememberme", token);
    if (config.orderCenterId) headers.set("order", config.orderCenterId);
    if (config.recipeCenterId) headers.set("recipe", config.recipeCenterId);

    const response = await fetchWithTimeout(`${baseUrl}${path}`, { ...options, headers });
    const text = await response.text();
    if (!response.ok) {
      throw new TspoonlabHttpError(
        `tSpoonLab request failed with HTTP ${response.status}`,
        response.status,
        path.split("?")[0],
      );
    }
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  function listPath(resource: string, params: TspoonlabListParams & Record<string, unknown> = {}) {
    return `${resource}${buildQuery({
      start: params.start ?? 0,
      rows: params.rows ?? 100,
      filter: typeof params.filter === "string" ? params.filter : undefined,
      withTypes: typeof params.withTypes === "boolean" ? params.withTypes : undefined,
      withDetail: typeof params.withDetail === "boolean" ? params.withDetail : undefined,
      hidden: typeof params.hidden === "boolean" ? params.hidden : undefined,
    })}`;
  }

  return {
    login,
    listOrderCenters: () => request("/orderCenters", {}, false),
    listMenus: (params: TspoonlabListParams & Record<string, unknown> = {}) => request(listPath("/listMenusPagedEx", params)),
    getMenu: (id: string) => request(`/menu/ext/${encodeURIComponent(id)}`),
    listRecipes: (params: TspoonlabListParams & Record<string, unknown> = {}) =>
      request(listPath("/listRecipesPaged", params)),
    getRecipe: (id: string) => request(`/recipe/${encodeURIComponent(id)}`),
    listDishes: (params: TspoonlabListParams & Record<string, unknown> = {}) =>
      request(listPath("/listDishesPaged", params)),
    getDish: (id: string) => request(`/dish/${encodeURIComponent(id)}`),
    listPendingSalesDeliveries: (startDate: string, endDate: string, includeInternal = true) =>
      request(`/integration/sales/deliveries/pending${buildQuery({ startDate, endDate, includeInternal })}`),
    listSalesDeliveries: (startDate: string, endDate: string, includeInternal = true) =>
      request(`/integration/sales/deliveries/all${buildQuery({ startDate, endDate, includeInternal })}`),
  };
}
