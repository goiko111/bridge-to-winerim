export interface HoldedClientConfig {
  baseUrl?: string;
  apiToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface HoldedListParams {
  cursor?: string;
  limit?: number;
  [key: string]: string | number | boolean | undefined;
}

export class HoldedHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = "HoldedHttpError";
  }
}

export function normalizeHoldedBaseUrl(value = "https://api.holded.com/api/v2"): string {
  const raw = value.trim().replace(/\/+$/, "");
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Holded base URL must use HTTPS");
  return raw;
}

function buildQuery(params: HoldedListParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

export function createHoldedClient(config: HoldedClientConfig) {
  const baseUrl = normalizeHoldedBaseUrl(config.baseUrl);
  const timeoutMs = config.timeoutMs ?? 20_000;
  const fetchImpl = config.fetchImpl ?? fetch;

  async function request(path: string, options: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${config.apiToken}`);

    try {
      const response = await fetchImpl(`${baseUrl}${path}`, { ...options, headers, signal: controller.signal });
      const text = await response.text();
      if (!response.ok) {
        throw new HoldedHttpError(`Holded request failed with HTTP ${response.status}`, response.status, path.split("?")[0]);
      }
      if (!text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    listProducts: (params: HoldedListParams = {}) => request(`/products${buildQuery(params)}`),
    listInvoices: (params: HoldedListParams = {}) => request(`/invoices${buildQuery(params)}`),
    listContacts: (params: HoldedListParams = {}) => request(`/contacts${buildQuery(params)}`),
    listWarehouses: (params: HoldedListParams = {}) => request(`/warehouses${buildQuery(params)}`),
  };
}
