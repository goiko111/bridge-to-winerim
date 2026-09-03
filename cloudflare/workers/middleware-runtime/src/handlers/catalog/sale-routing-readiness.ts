export type SaleRoutingFormat = "BOTTLE" | "GLASS";

export type SaleRoutingSaleCenter = Readonly<{
  id: string;
  name?: string | null;
  currentPriceListId?: string | null;
  priceListId?: string | null;
  deleted?: boolean;
}>;

export type SaleRoutingPriceList = Readonly<{
  id: string;
  name?: string | null;
  deleted?: boolean;
}>;

export type SaleRoutingPreparation = Readonly<{
  id: string;
  name?: string | null;
  deleted?: boolean;
}>;

export type SaleRoutingProductPrice = Readonly<{
  priceListId: string;
  mainPrice: number | null;
}>;

export type SaleRoutingProduct = Readonly<{
  productId: string;
  source: "WINERIM" | "LEGACY";
  format: string;
  active?: boolean;
  familyId?: string | null;
  saleableAsMain: boolean;
  useAsDirectSale: boolean;
  preparationTypeId?: string | null;
  preparationOrderId?: string | null;
  prices: readonly SaleRoutingProductPrice[];
}>;

export type SaleRoutingReadinessInput = Readonly<{
  connectionId: string;
  selectedSaleCenterIds: readonly string[];
  saleCenters: readonly SaleRoutingSaleCenter[];
  priceLists: readonly SaleRoutingPriceList[];
  preparationTypes: readonly SaleRoutingPreparation[];
  preparationOrders: readonly SaleRoutingPreparation[];
  products: readonly SaleRoutingProduct[];
}>;

export type SaleRoutingReadinessIssueCode =
  | "SALE_CENTER_SELECTION_EMPTY"
  | "SELECTED_SALE_CENTER_NOT_FOUND"
  | "SALE_CENTER_INACTIVE"
  | "SALE_CENTER_PRICE_LIST_MISSING"
  | "PRICE_LIST_NOT_FOUND"
  | "PRICE_LIST_INACTIVE"
  | "PRODUCT_FAMILY_MISSING"
  | "PRODUCT_NOT_SALEABLE"
  | "PRODUCT_DIRECT_SALE_ENABLED"
  | "PREPARATION_ROUTE_MISSING"
  | "PREPARATION_ROUTE_PARTIAL"
  | "PREPARATION_TYPE_NOT_FOUND"
  | "PREPARATION_ORDER_NOT_FOUND"
  | "PRODUCT_PRICE_MISSING"
  | "PRODUCT_PRICE_NONPOSITIVE";

export type SaleRoutingReadinessIssue = Readonly<{
  code: SaleRoutingReadinessIssueCode;
  saleCenterId?: string;
  priceListId?: string;
  productId?: string;
  format?: SaleRoutingFormat;
}>;

export type SaleRoutingReadinessCenter = Readonly<{
  saleCenterId: string;
  priceListId?: string;
  status: "READY" | "BLOCKED";
  expectedBottleProducts: number;
  expectedGlassProducts: number;
  readyBottleProducts: number;
  readyGlassProducts: number;
  issues: readonly SaleRoutingReadinessIssue[];
}>;

export type SaleRoutingReadinessReport = Readonly<{
  connectionId: string;
  status: "READY" | "BLOCKED";
  selectedSaleCenters: readonly SaleRoutingReadinessCenter[];
  summary: Readonly<{
    selectedSaleCenters: number;
    expectedBottleProducts: number;
    expectedGlassProducts: number;
    readyBottleProducts: number;
    readyGlassProducts: number;
    blockingIssues: number;
  }>;
  issues: readonly SaleRoutingReadinessIssue[];
}>;

const FORMATS = new Set<SaleRoutingFormat>(["BOTTLE", "GLASS"]);

function normalizedId(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function formatOf(product: SaleRoutingProduct): SaleRoutingFormat | null {
  const format = normalizedId(product.format).toUpperCase();
  return FORMATS.has(format as SaleRoutingFormat) ? format as SaleRoutingFormat : null;
}

function effectivePriceListId(saleCenter: SaleRoutingSaleCenter): string {
  return normalizedId(saleCenter.currentPriceListId) || normalizedId(saleCenter.priceListId);
}

function issue(
  code: SaleRoutingReadinessIssueCode,
  fields: Omit<SaleRoutingReadinessIssue, "code"> = {},
): SaleRoutingReadinessIssue {
  return { code, ...fields };
}

function productIssues(
  product: SaleRoutingProduct,
  format: SaleRoutingFormat,
  saleCenterId: string,
  priceListId: string,
  preparationTypeIds: ReadonlySet<string>,
  preparationOrderIds: ReadonlySet<string>,
): SaleRoutingReadinessIssue[] {
  const issues: SaleRoutingReadinessIssue[] = [];
  const fields = { saleCenterId, priceListId, productId: product.productId, format };
  if (!normalizedId(product.familyId)) issues.push(issue("PRODUCT_FAMILY_MISSING", fields));
  if (!product.saleableAsMain) issues.push(issue("PRODUCT_NOT_SALEABLE", fields));
  if (product.useAsDirectSale) issues.push(issue("PRODUCT_DIRECT_SALE_ENABLED", fields));

  const preparationTypeId = normalizedId(product.preparationTypeId);
  const preparationOrderId = normalizedId(product.preparationOrderId);
  if (!preparationTypeId && !preparationOrderId) {
    issues.push(issue("PREPARATION_ROUTE_MISSING", fields));
  } else if (!preparationTypeId || !preparationOrderId) {
    issues.push(issue("PREPARATION_ROUTE_PARTIAL", fields));
  } else {
    if (!preparationTypeIds.has(preparationTypeId)) {
      issues.push(issue("PREPARATION_TYPE_NOT_FOUND", fields));
    }
    if (!preparationOrderIds.has(preparationOrderId)) {
      issues.push(issue("PREPARATION_ORDER_NOT_FOUND", fields));
    }
  }

  const price = product.prices.find((item) => normalizedId(item.priceListId) === priceListId);
  if (!price) {
    issues.push(issue("PRODUCT_PRICE_MISSING", fields));
  } else if (!Number.isFinite(price.mainPrice) || Number(price.mainPrice) <= 0) {
    issues.push(issue("PRODUCT_PRICE_NONPOSITIVE", fields));
  }
  return issues;
}

export function auditSaleRoutingReadiness(
  input: SaleRoutingReadinessInput,
): SaleRoutingReadinessReport {
  const products = input.products
    .map((product) => ({ product, format: formatOf(product) }))
    .filter((item): item is { product: SaleRoutingProduct; format: SaleRoutingFormat } => (
      item.product.source === "WINERIM" && item.product.active !== false && item.format !== null
    ))
    .sort((left, right) => left.product.productId.localeCompare(right.product.productId));
  const saleCentersById = new Map(input.saleCenters.map((center) => [normalizedId(center.id), center]));
  const priceListsById = new Map(input.priceLists.map((priceList) => [normalizedId(priceList.id), priceList]));
  const preparationTypeIds = new Set(
    input.preparationTypes.filter((item) => !item.deleted).map((item) => normalizedId(item.id)),
  );
  const preparationOrderIds = new Set(
    input.preparationOrders.filter((item) => !item.deleted).map((item) => normalizedId(item.id)),
  );
  const issues: SaleRoutingReadinessIssue[] = [];
  const selectedIds = [...new Set(input.selectedSaleCenterIds.map(normalizedId).filter(Boolean))].sort();
  if (selectedIds.length === 0) issues.push(issue("SALE_CENTER_SELECTION_EMPTY"));

  const selectedSaleCenters = selectedIds.map((saleCenterId): SaleRoutingReadinessCenter => {
    const saleCenter = saleCentersById.get(saleCenterId);
    const centerIssues: SaleRoutingReadinessIssue[] = [];
    if (!saleCenter) {
      centerIssues.push(issue("SELECTED_SALE_CENTER_NOT_FOUND", { saleCenterId }));
    } else if (saleCenter.deleted) {
      centerIssues.push(issue("SALE_CENTER_INACTIVE", { saleCenterId }));
    }

    const priceListId = saleCenter ? effectivePriceListId(saleCenter) : "";
    if (saleCenter && !priceListId) {
      centerIssues.push(issue("SALE_CENTER_PRICE_LIST_MISSING", { saleCenterId }));
    }
    const priceList = priceListId ? priceListsById.get(priceListId) : undefined;
    if (priceListId && !priceList) {
      centerIssues.push(issue("PRICE_LIST_NOT_FOUND", { saleCenterId, priceListId }));
    } else if (priceList?.deleted) {
      centerIssues.push(issue("PRICE_LIST_INACTIVE", { saleCenterId, priceListId }));
    }

    let readyBottleProducts = 0;
    let readyGlassProducts = 0;
    if (saleCenter && priceList && !saleCenter.deleted && !priceList.deleted) {
      for (const { product, format } of products) {
        const productReadinessIssues = productIssues(
          product,
          format,
          saleCenterId,
          priceListId,
          preparationTypeIds,
          preparationOrderIds,
        );
        centerIssues.push(...productReadinessIssues);
        if (productReadinessIssues.length === 0) {
          if (format === "BOTTLE") readyBottleProducts += 1;
          else readyGlassProducts += 1;
        }
      }
    }
    issues.push(...centerIssues);
    return {
      saleCenterId,
      ...(priceListId ? { priceListId } : {}),
      status: centerIssues.length === 0 ? "READY" : "BLOCKED",
      expectedBottleProducts: products.filter((item) => item.format === "BOTTLE").length,
      expectedGlassProducts: products.filter((item) => item.format === "GLASS").length,
      readyBottleProducts,
      readyGlassProducts,
      issues: centerIssues,
    };
  });

  const expectedBottleProducts = products.filter((item) => item.format === "BOTTLE").length * selectedSaleCenters.length;
  const expectedGlassProducts = products.filter((item) => item.format === "GLASS").length * selectedSaleCenters.length;
  const readyBottleProducts = selectedSaleCenters.reduce((total, center) => total + center.readyBottleProducts, 0);
  const readyGlassProducts = selectedSaleCenters.reduce((total, center) => total + center.readyGlassProducts, 0);
  return {
    connectionId: input.connectionId,
    status: issues.length === 0 ? "READY" : "BLOCKED",
    selectedSaleCenters,
    summary: {
      selectedSaleCenters: selectedSaleCenters.length,
      expectedBottleProducts,
      expectedGlassProducts,
      readyBottleProducts,
      readyGlassProducts,
      blockingIssues: issues.length,
    },
    issues,
  };
}
