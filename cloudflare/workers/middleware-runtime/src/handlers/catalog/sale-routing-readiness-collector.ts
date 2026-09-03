import type { AgoraMasterFilter, AgoraReadOnlyClient, HttpAdapterResponse } from "../../adapters/http/contracts";
import {
  auditSaleRoutingReadiness,
  type SaleRoutingFormat,
  type SaleRoutingPreparation,
  type SaleRoutingPriceList,
  type SaleRoutingProduct,
  type SaleRoutingProductPrice,
  type SaleRoutingReadinessInput,
  type SaleRoutingReadinessReport,
  type SaleRoutingSaleCenter,
} from "./sale-routing-readiness";

type UnknownRecord = Record<string, unknown>;

const MASTER_FILTERS = [
  "SaleCenters",
  "PriceLists",
  "PreparationTypes",
  "PreparationOrders",
  "Products",
] as const satisfies readonly AgoraMasterFilter[];

const XML_TAGS: Record<AgoraMasterFilter, readonly string[]> = {
  SaleCenters: ["SaleCenter", "SaleCenterModel"],
  PriceLists: ["PriceList", "PriceListModel"],
  PreparationTypes: ["PreparationType", "PreparationTypeModel"],
  PreparationOrders: ["PreparationOrder", "PreparationOrderModel"],
  Products: ["Product", "ProductModel", "Article"],
  Families: ["Family", "FamilyModel"],
  Vats: ["Vat", "VatModel"],
  Warehouses: ["Warehouse", "WarehouseModel"],
  SalePoints: ["SalePoint", "SalePointModel"],
};

export type SaleRoutingExpectedProduct = Readonly<{
  productId: string;
  format: SaleRoutingFormat;
}>;

export type SaleRoutingReadinessCollectorInput = Readonly<{
  connectionId: string;
  selectedSaleCenterIds: readonly string[];
  expectedProducts: readonly SaleRoutingExpectedProduct[];
  agora: Pick<AgoraReadOnlyClient, "exportMaster">;
}>;

export type SaleRoutingReadinessMasterReceipt = Readonly<{
  filter: typeof MASTER_FILTERS[number];
  status: number;
  contentType: string;
  records: number;
}>;

export type SaleRoutingReadinessCollectionIssue = Readonly<{
  code: "AGORA_MASTER_HTTP_ERROR" | "AGORA_MASTER_PAYLOAD_INVALID" | "WINERIM_PRODUCT_MISSING_FROM_MASTER";
  filter?: typeof MASTER_FILTERS[number];
  productId?: string;
  status?: number;
}>;

export type SaleRoutingReadinessCollectionReport = Readonly<{
  status: "READY" | "BLOCKED";
  readiness: SaleRoutingReadinessReport;
  receipts: readonly SaleRoutingReadinessMasterReceipt[];
  collectionIssues: readonly SaleRoutingReadinessCollectionIssue[];
}>;

export class SaleRoutingReadinessCollectionError extends Error {
  constructor(
    readonly code: "AGORA_MASTER_HTTP_ERROR" | "AGORA_MASTER_PAYLOAD_INVALID",
    readonly filter: typeof MASTER_FILTERS[number],
    readonly status?: number,
  ) {
    super(code);
    this.name = "SaleRoutingReadinessCollectionError";
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function field(record: UnknownRecord, ...names: string[]): unknown {
  for (const name of names) {
    if (name in record) return record[name];
    const matchingKey = Object.keys(record).find((key) => key.toLowerCase() === name.toLowerCase());
    if (matchingKey) return record[matchingKey];
  }
  return undefined;
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function boolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const normalized = text(value).toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return undefined;
}

function number(value: unknown): number | null {
  const normalized = text(value).replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function xmlAttributes(value: string): UnknownRecord {
  const attributes: UnknownRecord = {};
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    attributes[match[1]] = (match[2] ?? match[3] ?? "")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }
  return attributes;
}

function xmlRecords(payload: string, filter: AgoraMasterFilter): UnknownRecord[] {
  const tags = XML_TAGS[filter];
  const result: UnknownRecord[] = [];
  for (const tag of tags) {
    const pattern = new RegExp(`<${tag}\\b([^>]*)\\/?>(?:[\\s\\S]*?<\\/${tag}>)?`, "gi");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(payload))) result.push(xmlAttributes(match[1]));
  }
  return result;
}

function recordsFrom(value: unknown, filter: AgoraMasterFilter): UnknownRecord[] {
  if (typeof value === "string") return xmlRecords(value, filter);
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];

  const singular = filter.replace(/s$/, "");
  const candidates = [field(value, filter, singular), field(value, "Data", "Items", "Results")];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
    if (isRecord(candidate)) {
      const nested = field(candidate, filter, singular, "Items", "Results");
      if (Array.isArray(nested)) return nested.filter(isRecord);
      if (isRecord(nested)) return [nested];
      return [candidate];
    }
  }
  return [value];
}

function recordId(record: UnknownRecord): string {
  return text(field(record, "Id", "ProductId", "SaleCenterId", "PriceListId", "PreparationTypeId", "PreparationOrderId"));
}

function deleted(record: UnknownRecord): boolean {
  return boolean(field(record, "Deleted", "IsDeleted", "Inactive", "IsInactive")) === true;
}

function productPrices(record: UnknownRecord): SaleRoutingProductPrice[] {
  const raw = field(record, "Prices", "ProductPrices", "PriceListPrices");
  const priceRows = Array.isArray(raw) ? raw.filter(isRecord) : isRecord(raw) ? [raw] : [];
  const prices = priceRows.map((item) => ({
    priceListId: text(field(item, "PriceListId", "ListId", "TariffId")),
    mainPrice: number(field(item, "MainPrice", "Price", "PriceWithTaxes")),
  })).filter((item) => item.priceListId);
  const flatPriceListId = text(field(record, "CurrentPriceListId", "PriceListId", "ListId"));
  const flatMainPrice = number(field(record, "MainPrice", "Price", "PriceWithTaxes"));
  if (flatPriceListId && flatMainPrice !== null && !prices.some((item) => item.priceListId === flatPriceListId)) {
    prices.push({ priceListId: flatPriceListId, mainPrice: flatMainPrice });
  }
  return prices;
}

function saleCenters(records: readonly UnknownRecord[]): SaleRoutingSaleCenter[] {
  return records.map((record) => ({
    id: recordId(record),
    name: text(field(record, "Name", "Description")) || undefined,
    currentPriceListId: text(field(record, "CurrentPriceListId")) || undefined,
    priceListId: text(field(record, "PriceListId", "ListId")) || undefined,
    deleted: deleted(record),
  })).filter((item) => item.id);
}

function preparations(records: readonly UnknownRecord[]): SaleRoutingPreparation[] {
  return records.map((record) => ({
    id: recordId(record),
    name: text(field(record, "Name", "Description")) || undefined,
    deleted: deleted(record),
  })).filter((item) => item.id);
}

function priceLists(records: readonly UnknownRecord[]): SaleRoutingPriceList[] {
  return preparations(records);
}

function product(record: UnknownRecord, expected: SaleRoutingExpectedProduct): SaleRoutingProduct {
  const active = boolean(field(record, "Active", "IsActive", "Enabled", "IsEnabled"));
  return {
    productId: expected.productId,
    source: "WINERIM",
    format: expected.format,
    active: active === undefined ? !deleted(record) : active && !deleted(record),
    familyId: text(field(record, "FamilyId", "Family", "FamilyCode")) || undefined,
    saleableAsMain: boolean(field(record, "SaleableAsMain", "IsSaleableAsMain")) === true,
    useAsDirectSale: boolean(field(record, "UseAsDirectSale", "IsDirectSale")) === true,
    preparationTypeId: text(field(record, "PreparationTypeId")) || undefined,
    preparationOrderId: text(field(record, "PreparationOrderId")) || undefined,
    prices: productPrices(record),
  };
}

async function readMaster(
  agora: Pick<AgoraReadOnlyClient, "exportMaster">,
  filter: typeof MASTER_FILTERS[number],
): Promise<Readonly<{ records: readonly UnknownRecord[]; receipt: SaleRoutingReadinessMasterReceipt }>> {
  let response: HttpAdapterResponse;
  try {
    response = await agora.exportMaster([filter]);
  } catch {
    throw new SaleRoutingReadinessCollectionError("AGORA_MASTER_HTTP_ERROR", filter);
  }
  if (!response.ok) throw new SaleRoutingReadinessCollectionError("AGORA_MASTER_HTTP_ERROR", filter, response.status);
  const records = recordsFrom(response.body, filter);
  if (records.length === 0) throw new SaleRoutingReadinessCollectionError("AGORA_MASTER_PAYLOAD_INVALID", filter, response.status);
  return {
    records,
    receipt: { filter, status: response.status, contentType: response.contentType, records: records.length },
  };
}

export async function collectSaleRoutingReadiness(
  input: SaleRoutingReadinessCollectorInput,
): Promise<SaleRoutingReadinessCollectionReport> {
  const reads = await Promise.all(MASTER_FILTERS.map((filter) => readMaster(input.agora, filter)));
  const masters = Object.fromEntries(MASTER_FILTERS.map((filter, index) => [filter, reads[index].records])) as Record<
    typeof MASTER_FILTERS[number],
    readonly UnknownRecord[]
  >;
  const productById = new Map(masters.Products.map((record) => [recordId(record), record]));
  const collectionIssues: SaleRoutingReadinessCollectionIssue[] = [];
  const products = input.expectedProducts.map((expected) => {
    const providerProduct = productById.get(expected.productId);
    if (!providerProduct) {
      collectionIssues.push({ code: "WINERIM_PRODUCT_MISSING_FROM_MASTER", productId: expected.productId });
      return {
        productId: expected.productId,
        source: "WINERIM" as const,
        format: expected.format,
        active: true,
        familyId: "",
        saleableAsMain: false,
        useAsDirectSale: false,
        prices: [],
      };
    }
    return product(providerProduct, expected);
  });
  const readinessInput: SaleRoutingReadinessInput = {
    connectionId: input.connectionId,
    selectedSaleCenterIds: input.selectedSaleCenterIds,
    saleCenters: saleCenters(masters.SaleCenters),
    priceLists: priceLists(masters.PriceLists),
    preparationTypes: preparations(masters.PreparationTypes),
    preparationOrders: preparations(masters.PreparationOrders),
    products,
  };
  const readiness = auditSaleRoutingReadiness(readinessInput);
  return {
    status: readiness.status === "READY" && collectionIssues.length === 0 ? "READY" : "BLOCKED",
    readiness,
    receipts: reads.map((read) => read.receipt),
    collectionIssues,
  };
}
