import type { WinerimMutationHttpRequest, WinerimStockReadback } from "../../handlers/stock";
import {
  HttpAdapterError,
  type WinerimMutationHttpTransport,
  type WinerimMutationTransportOptions,
} from "./contracts";
import { createSafeHttpClient } from "./safe-http";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const STOCK_PATH = /^\/api\/v2\/stock\/[1-9]\d*$/;
const STOCK_LIST_PATH = "/api/v2/stock";
const STOCK_READBACK_PAGE_LIMIT = 100;
const STOCK_READBACK_MAX_PAGES = 1_000;

export type WinerimStockReadbackErrorCode =
  | "WINERIM_STOCK_READBACK_INVALID_STOCK_ID"
  | "WINERIM_STOCK_READBACK_HTTP_ERROR"
  | "WINERIM_STOCK_READBACK_INVALID_RESPONSE"
  | "WINERIM_STOCK_READBACK_AMBIGUOUS"
  | "WINERIM_STOCK_READBACK_NOT_FOUND";

export class WinerimStockReadbackError extends Error {
  constructor(readonly code: WinerimStockReadbackErrorCode) {
    super(code);
    this.name = "WinerimStockReadbackError";
  }
}

type StockReadbackPage = Readonly<{
  page: number;
  limit: number;
  totalCount: number;
  totalPages: number;
  stocks: readonly WinerimStockReadback[];
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeInteger(value: unknown, minimum: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
    ? value
    : null;
}

function normalizeStockReadbackPage(body: unknown, requestedPage: number): StockReadbackPage {
  const payload = record(body);
  const pagination = record(payload?.pagination);
  const page = safeInteger(pagination?.page, 1);
  const limit = safeInteger(pagination?.limit, 1);
  const totalCount = safeInteger(pagination?.total_count, 0);
  const totalPages = safeInteger(pagination?.total_pages, 0);
  if (payload?.success !== true || !Array.isArray(payload.stocks) ||
      page !== requestedPage || limit === null || limit > STOCK_READBACK_PAGE_LIMIT ||
      totalCount === null || totalPages === null || totalPages > STOCK_READBACK_MAX_PAGES ||
      payload.stocks.length > limit || totalCount < payload.stocks.length) {
    throw new WinerimStockReadbackError("WINERIM_STOCK_READBACK_INVALID_RESPONSE");
  }

  const stocks = payload.stocks.map((value) => {
    const entry = record(value);
    const stockId = safeInteger(entry?.id, 1);
    const stock = safeInteger(entry?.stock, 0);
    if (stockId === null || stock === null) {
      throw new WinerimStockReadbackError("WINERIM_STOCK_READBACK_INVALID_RESPONSE");
    }
    return { stockId, stock };
  });

  return { page, limit, totalCount, totalPages, stocks };
}

function validMutationRequest(request: WinerimMutationHttpRequest): boolean {
  if (request.kind === "sales-import") {
    return request.method === "POST" && request.path === "/api/v2/sales/import";
  }
  return request.kind === "stock-put" && request.method === "PUT" && STOCK_PATH.test(request.path);
}

async function credentialHeader(options: WinerimMutationTransportOptions): Promise<Readonly<Record<string, string>>> {
  let value: string;
  try {
    value = String(await options.credential.read()).trim();
  } catch {
    throw new HttpAdapterError("HTTP_CREDENTIAL_UNAVAILABLE");
  }
  if (!value || /[\r\n]/.test(value)) throw new HttpAdapterError("HTTP_CREDENTIAL_UNAVAILABLE");
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "WINERIM-API-TOKEN": value,
  };
}

export function createWinerimMutationTransport(
  options: WinerimMutationTransportOptions,
): WinerimMutationHttpTransport {
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

  return {
    async send(request) {
      if (!validMutationRequest(request)) {
        throw new HttpAdapterError("WINERIM_INVALID_MUTATION_REQUEST");
      }
      const response = await http.request({
        operation: request.kind === "sales-import" ? "winerim.sales-import" : "winerim.stock-put",
        method: request.method,
        path: request.path,
        headers: await credentialHeader(options),
        body: request.body,
      });
      return { status: response.status, body: response.body };
    },

    async readStock(stockId) {
      if (!Number.isSafeInteger(stockId) || stockId <= 0) {
        throw new WinerimStockReadbackError("WINERIM_STOCK_READBACK_INVALID_STOCK_ID");
      }

      const matches: WinerimStockReadback[] = [];
      let expectedTotalPages: number | null = null;
      let expectedTotalCount: number | null = null;
      let expectedLimit: number | null = null;
      for (let page = 1; expectedTotalPages === null || page <= Math.max(1, expectedTotalPages); page++) {
        const response = await http.request({
          operation: "winerim.stock-readback",
          method: "GET",
          path: STOCK_LIST_PATH,
          query: { page: String(page), limit: String(STOCK_READBACK_PAGE_LIMIT) },
          headers: await credentialHeader(options),
        });
        if (!response.ok) {
          throw new WinerimStockReadbackError("WINERIM_STOCK_READBACK_HTTP_ERROR");
        }

        const normalized = normalizeStockReadbackPage(response.body, page);
        if (expectedTotalPages === null) {
          expectedTotalPages = normalized.totalPages;
          expectedTotalCount = normalized.totalCount;
          expectedLimit = normalized.limit;
        } else if (normalized.totalPages !== expectedTotalPages ||
                   normalized.totalCount !== expectedTotalCount ||
                   normalized.limit !== expectedLimit) {
          throw new WinerimStockReadbackError("WINERIM_STOCK_READBACK_INVALID_RESPONSE");
        }
        matches.push(...normalized.stocks.filter((entry) => entry.stockId === stockId));
      }

      if (matches.length > 1) {
        throw new WinerimStockReadbackError("WINERIM_STOCK_READBACK_AMBIGUOUS");
      }
      if (matches.length === 0) {
        throw new WinerimStockReadbackError("WINERIM_STOCK_READBACK_NOT_FOUND");
      }
      return matches[0];
    },

    sleep(milliseconds) {
      return options.sleep(milliseconds);
    },
  };
}
