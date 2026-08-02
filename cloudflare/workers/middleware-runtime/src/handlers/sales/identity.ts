import { canonicalJson, sha256Hex } from "../../idempotency";
import type { SalesVariant } from "./types";

function slug(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 20) || "provider";
}

export async function buildSalesClaimKey(input: {
  connectionId: string;
  provider: string;
  businessDay: string;
  lifecycleId: string;
  winerimWineId: string;
  variant: SalesVariant;
}): Promise<string> {
  const digest = await sha256Hex(canonicalJson({
    version: 1,
    connectionId: input.connectionId,
    provider: input.provider,
    businessDay: input.businessDay,
    lifecycleId: input.lifecycleId,
    winerimWineId: input.winerimWineId,
    variant: input.variant,
  }));
  return `sales-claim:v1:${digest}`;
}

export async function buildSalesOrderId(input: {
  provider: string;
  claimKey: string;
  businessDay: string;
  variant: SalesVariant;
  desiredQuantity: number;
}): Promise<string> {
  const digest = await sha256Hex(canonicalJson({
    version: 1,
    claimKey: input.claimKey,
    desiredQuantity: input.desiredQuantity,
  }));
  const variant = input.variant === "BOTTLE" ? "b" : input.variant === "GLASS" ? "g" : "m";
  return `mw:v1:${slug(input.provider)}:${input.businessDay}:${digest.slice(0, 24)}:${variant}:t${input.desiredQuantity}`;
}

export async function buildSalesMutationIdempotencyKey(input: {
  orderId: string;
  action: "SALES_IMPORT" | "STOCK_APPLY";
}): Promise<string> {
  const digest = await sha256Hex(canonicalJson({
    version: 1,
    orderId: input.orderId,
    action: input.action,
  }));
  return `sales-mutation:v1:${digest}`;
}
