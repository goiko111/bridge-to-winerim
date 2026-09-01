import {
  AGORA_EXPORT_FILTERS,
  AGORA_MASTER_FILTERS,
  HttpAdapterError,
  type AgoraExportFilter,
  type AgoraMasterFilter,
  type AgoraReadOnlyClient,
  type AgoraReadOnlyClientOptions,
} from "./contracts";
import { createSafeHttpClient } from "./safe-http";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const EXPORT_FILTERS = new Set<string>(AGORA_EXPORT_FILTERS);
const MASTER_FILTERS = new Set<string>(AGORA_MASTER_FILTERS);

function validBusinessDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function assertExportFilter(filter: string): asserts filter is AgoraExportFilter {
  if (!EXPORT_FILTERS.has(filter)) throw new HttpAdapterError("AGORA_INVALID_EXPORT_FILTER");
}

function normalizedMasterFilters(filters: readonly AgoraMasterFilter[]): AgoraMasterFilter[] {
  const unique = [...new Set(filters.map(String))];
  if (unique.length === 0 || unique.some((filter) => !MASTER_FILTERS.has(filter))) {
    throw new HttpAdapterError("AGORA_INVALID_MASTER_FILTER");
  }
  return unique as AgoraMasterFilter[];
}

async function credentialHeader(options: AgoraReadOnlyClientOptions): Promise<Readonly<Record<string, string>>> {
  let value: string;
  try {
    value = String(await options.credential.read()).trim();
  } catch {
    throw new HttpAdapterError("HTTP_CREDENTIAL_UNAVAILABLE");
  }
  if (!value || /[\r\n]/.test(value)) throw new HttpAdapterError("HTTP_CREDENTIAL_UNAVAILABLE");
  return { Accept: "application/json, application/xml, text/xml", "Api-Token": value };
}

export function createAgoraReadOnlyClient(options: AgoraReadOnlyClientOptions): AgoraReadOnlyClient {
  const http = createSafeHttpClient({
    target: "agora",
    baseUrl: options.baseUrl,
    allowedHosts: options.allowedHosts,
    allowedProtocols: ["http:", "https:"],
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    request: options.request,
    timer: options.timer,
    logger: options.logger,
  });

  return {
    async preflight() {
      return http.request({
        operation: "agora.preflight",
        method: "GET",
        path: "/api/",
        headers: await credentialHeader(options),
      });
    },

    async exportInvoices(businessDay) {
      if (!validBusinessDay(businessDay)) throw new HttpAdapterError("AGORA_INVALID_BUSINESS_DAY");
      return http.request({
        operation: "agora.export.invoices",
        method: "GET",
        path: "/api/export/",
        query: { "business-day": businessDay, filter: "Invoices" },
        headers: await credentialHeader(options),
      });
    },

    async exportOpenTickets() {
      return http.request({
        operation: "agora.export.open-tickets",
        method: "GET",
        path: "/api/export/tickets/",
        headers: await credentialHeader(options),
      });
    },

    async exportCatalog(filter) {
      assertExportFilter(filter);
      if (filter === "Invoices") throw new HttpAdapterError("AGORA_INVALID_EXPORT_FILTER");
      return http.request({
        operation: "agora.export.catalog",
        method: "GET",
        path: "/api/export/",
        query: { filter },
        headers: await credentialHeader(options),
      });
    },

    async exportMaster(filters) {
      const normalized = normalizedMasterFilters(filters);
      return http.request({
        operation: "agora.export.master",
        method: "GET",
        path: "/api/export-master/",
        query: { filter: normalized.join(",") },
        headers: await credentialHeader(options),
      });
    },
  };
}
