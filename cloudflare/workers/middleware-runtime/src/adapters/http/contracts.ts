import type { WinerimMutationTransport } from "../../handlers/stock";

export type HttpRequestPort = Readonly<{
  request(url: string, init: RequestInit): Promise<Response>;
}>;

export type HttpTimerPort = Readonly<{
  now(): number;
  schedule(callback: () => void, milliseconds: number): unknown;
  cancel(handle: unknown): void;
}>;

export type SecretTextPort = Readonly<{
  read(): string | Promise<string>;
}>;

export type HttpAdapterLogEvent = Readonly<{
  event: "http.adapter.request";
  target: "agora" | "winerim";
  operation: string;
  method: "GET" | "POST" | "PUT";
  host: string;
  path: string;
  outcome: "success" | "http_error" | "blocked" | "timeout" | "network_error";
  durationMs: number;
  status?: number;
  errorCode?: HttpAdapterErrorCode;
}>;

export type HttpLoggerPort = Readonly<{
  write(event: HttpAdapterLogEvent): void | Promise<void>;
}>;

export type HttpAdapterErrorCode =
  | "HTTP_INVALID_BASE_URL"
  | "HTTP_BASE_URL_NOT_ALLOWLISTED"
  | "HTTP_INVALID_TIMEOUT"
  | "HTTP_INVALID_RESPONSE_LIMIT"
  | "HTTP_INVALID_REQUEST_PATH"
  | "HTTP_REDIRECT_BLOCKED"
  | "HTTP_TIMEOUT"
  | "HTTP_NETWORK_ERROR"
  | "HTTP_RESPONSE_TOO_LARGE"
  | "HTTP_RESPONSE_READ_FAILED"
  | "HTTP_CREDENTIAL_UNAVAILABLE"
  | "AGORA_INVALID_BUSINESS_DAY"
  | "AGORA_INVALID_EXPORT_FILTER"
  | "AGORA_INVALID_MASTER_FILTER"
  | "WINERIM_INVALID_MUTATION_REQUEST";

export type HttpAdapterErrorDiagnostic = Readonly<{
  target?: "agora" | "winerim";
  operation?: string;
  method?: "GET" | "POST" | "PUT";
  protocol?: string;
  host?: string;
  path?: string;
  url?: string;
  durationMs?: number;
  status?: number;
  bodySample?: string;
}>;

export class HttpAdapterError extends Error {
  constructor(
    readonly code: HttpAdapterErrorCode,
    readonly diagnostic: HttpAdapterErrorDiagnostic = {},
  ) {
    super(code);
    this.name = "HttpAdapterError";
  }
}

export type HttpAdapterResponse = Readonly<{
  ok: boolean;
  status: number;
  contentType: string;
  body: unknown;
}>;

export type SafeHttpClientOptions = Readonly<{
  target: "agora" | "winerim";
  baseUrl: string;
  allowedHosts: readonly string[];
  allowedProtocols: readonly ("http:" | "https:")[];
  timeoutMs: number;
  maxResponseBytes: number;
  request: HttpRequestPort;
  timer: HttpTimerPort;
  logger?: HttpLoggerPort;
}>;

export type SafeHttpRequest = Readonly<{
  operation: string;
  method: "GET" | "POST" | "PUT";
  path: string;
  query?: Readonly<Record<string, string>>;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
}>;

export type SafeHttpClient = Readonly<{
  request(input: SafeHttpRequest): Promise<HttpAdapterResponse>;
}>;

export const AGORA_EXPORT_FILTERS = ["Invoices", "Articles", "Products", "Catalog"] as const;
export type AgoraExportFilter = typeof AGORA_EXPORT_FILTERS[number];

export const AGORA_MASTER_FILTERS = [
  "Products",
  "Families",
  "Vats",
  "PriceLists",
  "PreparationTypes",
  "PreparationOrders",
  "Warehouses",
  "SalePoints",
  "SaleCenters",
] as const;
export type AgoraMasterFilter = typeof AGORA_MASTER_FILTERS[number];

export type AgoraReadOnlyClient = Readonly<{
  preflight(): Promise<HttpAdapterResponse>;
  exportInvoices(businessDay: string): Promise<HttpAdapterResponse>;
  exportOpenTickets(): Promise<HttpAdapterResponse>;
  exportCatalog(filter: Exclude<AgoraExportFilter, "Invoices">): Promise<HttpAdapterResponse>;
  exportMaster(filters: readonly AgoraMasterFilter[]): Promise<HttpAdapterResponse>;
}>;

export type AgoraReadOnlyClientOptions = Readonly<{
  baseUrl: string;
  allowedHosts: readonly string[];
  credential: SecretTextPort;
  request: HttpRequestPort;
  timer: HttpTimerPort;
  logger?: HttpLoggerPort;
  timeoutMs?: number;
  maxResponseBytes?: number;
}>;

export type WinerimMutationHttpTransport = WinerimMutationTransport;

export type WinerimMutationTransportOptions = Readonly<{
  baseUrl: string;
  allowedHosts: readonly string[];
  credential: SecretTextPort;
  request: HttpRequestPort;
  timer: HttpTimerPort;
  sleep(milliseconds: number): Promise<void>;
  logger?: HttpLoggerPort;
  timeoutMs?: number;
  maxResponseBytes?: number;
}>;
