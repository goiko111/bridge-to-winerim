import { FleetContractError } from "./winerimFleetClient.ts";

type ObjectLike = Record<string, unknown>;

const object = (value: unknown, label: string): ObjectLike => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FleetContractError("INVALID_PROBE_RESPONSE", `${label} debe ser objeto`, 502);
  }
  return value as ObjectLike;
};

const integer = (value: unknown, label: string): number => {
  if (!Number.isInteger(value)) throw new FleetContractError("INVALID_PROBE_RESPONSE", `${label} debe ser entero`, 502);
  return Number(value);
};

const finite = (value: unknown, label: string): number | null => {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new FleetContractError("INVALID_PROBE_RESPONSE", `${label} debe ser numérico`, 502);
  return parsed;
};

const text = (value: unknown, max = 256): string | null => value == null ? null : String(value).slice(0, max);
const bool = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;

export const CANDIDATE_PROBE_ACTION = "VERIFY_CANDIDATE_SALES" as const;

export type CandidateProbeRequest = {
  action: typeof CANDIDATE_PROBE_ACTION;
  connectionId: string;
  restaurantId: number;
  businessDay: string;
};

export function parseCandidateProbeRequest(value: unknown): CandidateProbeRequest {
  const row = object(value, "body");
  const allowed = new Set(["action", "connectionId", "restaurantId", "businessDay"]);
  const extra = Object.keys(row).filter((key) => !allowed.has(key));
  if (extra.length) throw Object.assign(new Error(`Campos no permitidos: ${extra.join(", ")}`), { status: 400, code: "INVALID_PROBE_BODY" });
  if (row.action !== CANDIDATE_PROBE_ACTION) throw Object.assign(new Error("Acción de lectura no permitida"), { status: 400, code: "INVALID_PROBE_ACTION" });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(row.connectionId ?? ""))) {
    throw Object.assign(new Error("connectionId inválido"), { status: 400, code: "INVALID_CONNECTION_ID" });
  }
  if (!Number.isInteger(row.restaurantId) || Number(row.restaurantId) <= 0) {
    throw Object.assign(new Error("restaurantId inválido"), { status: 400, code: "INVALID_RESTAURANT_ID" });
  }
  const businessDay = String(row.businessDay ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDay) || new Date(`${businessDay}T00:00:00Z`).toISOString().slice(0, 10) !== businessDay) {
    throw Object.assign(new Error("businessDay inválido"), { status: 400, code: "INVALID_BUSINESS_DAY" });
  }
  return { action: CANDIDATE_PROBE_ACTION, connectionId: String(row.connectionId), restaurantId: Number(row.restaurantId), businessDay };
}

export function nextBusinessDay(day: string): string {
  const value = new Date(`${day}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

export function assertClosedBusinessDay(day: string, timeZone: string, now = new Date()): void {
  let today: string;
  try {
    today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    throw Object.assign(new Error("La zona horaria del restaurante no es válida"), { status: 409, code: "RESTAURANT_TIMEZONE_INVALID" });
  }
  if (day >= today) throw Object.assign(new Error("La comprobación exige un día local ya cerrado"), { status: 409, code: "BUSINESS_DAY_NOT_CLOSED" });
}

function normalizeStockEffect(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as ObjectLike;
  const movements = Array.isArray(row.movements) ? row.movements.map((item, index) => {
    const movement = object(item, `stockEffect.movements[${index}]`);
    return {
      stockMovementId: movement.stockMovementId == null ? null : integer(movement.stockMovementId, "stockMovementId"),
      difference: finite(movement.difference, "difference"),
      unitsBefore: finite(movement.unitsBefore, "unitsBefore"),
      unitsAfter: finite(movement.unitsAfter, "unitsAfter"),
      exists: bool(movement.exists),
    };
  }) : null;
  return { known: bool(row.known), status: text(row.status, 64), stockApplied: bool(row.stockApplied), receiptId: text(row.receiptId, 160), movements };
}

export type SanitizedCandidateSale = ReturnType<typeof normalizeCandidateSale>;

export function normalizeCandidateSale(value: unknown) {
  const sale = object(value, "sale");
  const wine = object(sale.wine, "sale.wine");
  const variant = object(sale.variant, "sale.variant");
  const amounts = object(sale.amounts, "sale.amounts");
  const source = object(sale.source, "sale.source");
  if (!Array.isArray(sale.lines)) throw new FleetContractError("INVALID_PROBE_RESPONSE", "sale.lines debe ser array", 502);
  const lines = sale.lines.map((value, index) => {
    const line = object(value, `sale.lines[${index}]`);
    const lineSource = object(line.source, `sale.lines[${index}].source`);
    return {
      lineId: text(line.lineId, 160), saleDetailId: line.saleDetailId == null ? null : integer(line.saleDetailId, "saleDetailId"),
      lineType: text(line.lineType, 32), format: text(line.format, 64), qty: finite(line.qty, "line.qty"),
      unitAmount: finite(line.unitAmount, "line.unitAmount"), totalAmount: finite(line.totalAmount, "line.totalAmount"),
      taxIncluded: bool(line.taxIncluded), effectiveAt: text(line.effectiveAt, 48), timeReliable: bool(line.timeReliable), recordedAt: text(line.recordedAt, 48),
      source: {
        origin: text(lineSource.origin, 64), channel: text(lineSource.channel, 64), contract: text(lineSource.contract, 64),
        externalOrderId: text(lineSource.externalOrderId, 160), sourceSystem: text(lineSource.sourceSystem, 64), sourceLineId: text(lineSource.sourceLineId, 160),
        invoiceId: text(lineSource.invoiceId, 160), receiptId: text(lineSource.receiptId, 160), mode: text(lineSource.mode, 64),
      },
      stockEffect: normalizeStockEffect(line.stockEffect),
    };
  });
  return {
    saleId: integer(sale.saleId, "sale.saleId"), status: text(sale.status, 32), effectiveAt: text(sale.effectiveAt, 48),
    timeReliable: bool(sale.timeReliable), recordedAt: text(sale.recordedAt, 48), updatedAt: text(sale.updatedAt, 48),
    wine: { wineId: integer(wine.wineId, "wine.wineId"), name: text(wine.name, 240) },
    variant: { priceId: integer(variant.priceId, "variant.priceId"), stockId: variant.stockId == null ? null : integer(variant.stockId, "variant.stockId"), format: text(variant.format, 64), name: text(variant.name, 160) },
    qty: finite(sale.qty, "sale.qty"), servedQty: finite(sale.servedQty, "sale.servedQty"), bottleOpen: bool(sale.bottleOpen), unbackedQty: finite(sale.unbackedQty, "sale.unbackedQty"),
    amounts: { total: finite(amounts.total, "amounts.total"), basis: text(amounts.basis, 64), currency: text(amounts.currency, 8) },
    source: { origin: text(source.origin, 64), channel: text(source.channel, 64), contract: text(source.contract, 64), integrationId: text(source.integrationId, 160), recordType: text(source.recordType, 64), externalOrderId: text(source.externalOrderId, 160), serviceChannel: text(source.serviceChannel, 64) },
    lines,
  };
}

export function normalizeCandidateSales(values: unknown[]): SanitizedCandidateSale[] {
  return values.map(normalizeCandidateSale).sort((a, b) => a.saleId - b.saleId);
}
