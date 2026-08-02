import type { WinerimMutationHttpRequest } from "../../handlers/stock";
import {
  HttpAdapterError,
  type WinerimMutationHttpTransport,
  type WinerimMutationTransportOptions,
} from "./contracts";
import { createSafeHttpClient } from "./safe-http";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const STOCK_PATH = /^\/api\/v2\/stock\/[1-9]\d*$/;

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

    sleep(milliseconds) {
      return options.sleep(milliseconds);
    },
  };
}
