import {
  sql,
  type DatabaseAdapter,
  type DatabaseTransaction,
} from "../../../../middleware-api/src/db";
import type {
  CatalogApplyPortResult,
  CatalogExistingFamily,
  CatalogExistingProduct,
  CatalogFamilyRef,
  CatalogFamilyRoutingInput,
  CatalogFormat,
  CatalogHandlerPorts,
  CatalogLabelPolicy,
  CatalogPlan,
  CatalogPlanningContext,
  CatalogProductIdPolicy,
  CatalogProductOperation,
  CatalogRequest,
  CatalogWineInput,
} from "../../handlers/catalog";
import type {
  PostgresCatalogAdapter,
  PostgresCatalogAdapterOptions,
} from "./types";

type ConnectionRow = Record<string, unknown> & {
  id: unknown;
  provider: unknown;
  provider_config: unknown;
  default_family_id: unknown;
  updated_at: unknown;
  last_catalog_sync_at: unknown;
};

type MasterRow = Record<string, unknown> & {
  families_json: unknown;
  products_summary_json: unknown;
  fetched_at: unknown;
  updated_at: unknown;
};

type WineRow = Record<string, unknown> & {
  winerim_id: unknown;
  name: unknown;
  vintage: unknown;
  wine_type: unknown;
  price: unknown;
  bottle_sale_price: unknown;
  bottle_purchase_price: unknown;
  glass_sale_price: unknown;
  glass_cost_price: unknown;
  magnum_sale_price: unknown;
  magnum_purchase_price: unknown;
  serve_by_glass: unknown;
  is_active: unknown;
  raw_payload: unknown;
  updated_at: unknown;
};

type MappingRow = Record<string, unknown> & {
  provider_product_id: unknown;
  provider_product_name: unknown;
  winerim_wine_id: unknown;
  winerim_wine_name: unknown;
  format_type: unknown;
  agora_product_id: unknown;
  status: unknown;
  match_method: unknown;
  updated_at: unknown;
};

type ProviderProductRow = Record<string, unknown> & {
  provider_product_id: unknown;
  name: unknown;
  family: unknown;
  price: unknown;
  sale_format: unknown;
  winerim_wine_id: unknown;
  sync_status: unknown;
  raw_payload: unknown;
  updated_at: unknown;
};

type TrackingRow = Record<string, unknown> & {
  winerim_wine_id: unknown;
  format: unknown;
  agora_product_id: unknown;
  agora_family_id: unknown;
  sync_status: unknown;
  source: unknown;
  updated_at: unknown;
};

type ClaimRow = Record<string, unknown> & {
  idempotency_key: unknown;
  job: unknown;
  status: unknown;
  result: unknown;
};

const CATALOG_PLAN_JOB = "catalog.plan.db";
const EXPLICIT_MAPPING_STATUSES = new Set(["CONFIRMED", "PENDING"]);
const REMOTE_TRACKING_STATUSES = new Set(["PUSHED", "VERIFIED"]);
const REJECTED_MAPPING_STATUSES = new Set(["IGNORED", "REJECTED"]);
const WINE_TYPE_ALIASES: Record<string, string> = {
  red: "tinto",
  white: "blanco",
  rose: "rosado",
  sparkling: "espumoso",
  cava: "espumoso",
  champagne: "espumoso",
  sweet: "dulce",
  dessert: "dulce",
  postre: "dulce",
  generoso: "fortificado",
  fortified: "fortificado",
};

export class PostgresCatalogAdapterInvariantError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PostgresCatalogAdapterInvariantError";
  }
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function nullableText(value: unknown): string | null {
  return text(value) || null;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function boolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  const normalized = text(value).toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return fallback;
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function records(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
      : [];
  } catch {
    return [];
  }
}

function field(row: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null) return row[name];
  }
  return undefined;
}

function normalizedKey(value: unknown): string {
  return text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeFormat(value: unknown): CatalogFormat | null {
  const normalized = text(value).toUpperCase();
  if (["BOTTLE", "BOTELLA", "BOT", "B"].includes(normalized)) return "BOTTLE";
  if (["GLASS", "COPA", "C"].includes(normalized)) return "GLASS";
  if (["MAGNUM", "MAG", "M"].includes(normalized)) return "MAGNUM";
  return null;
}

function normalizeWineType(value: unknown): string {
  const normalized = normalizedKey(value);
  return WINE_TYPE_ALIASES[normalized] || normalized;
}

function familyFromRecord(row: Record<string, unknown>): CatalogExistingFamily | null {
  const id = text(field(row, "Id", "id", "FamilyId", "familyId"));
  const name = text(field(row, "Name", "name", "FamilyName", "familyName"));
  return id && name ? { id, name } : null;
}

function productFromRecord(row: Record<string, unknown>): CatalogExistingProduct | null {
  const productId = text(field(row, "Id", "id", "ProductId", "productId", "provider_product_id"));
  const name = text(field(row, "Name", "name", "ProductName", "productName"));
  if (!productId || !name) return null;
  const buttonText = nullableText(field(row, "ButtonText", "buttonText"));
  const familyId = nullableText(field(row, "FamilyId", "familyId", "family_id"));
  const rawSalePrice = field(row, "SalePrice", "salePrice", "Price", "price");
  const rawCostPrice = field(row, "CostPrice", "costPrice", "PurchasePrice", "purchasePrice");
  const rawUseAsDirectSale = field(row, "UseAsDirectSale", "useAsDirectSale");
  const rawSaleableAsMain = field(row, "SaleableAsMain", "saleableAsMain");
  return {
    productId,
    name,
    buttonText,
    familyId,
    ...(rawSalePrice === undefined ? {} : { salePrice: number(rawSalePrice) }),
    ...(rawCostPrice === undefined ? {} : { costPrice: number(rawCostPrice) }),
    ...(rawUseAsDirectSale === undefined ? {} : { useAsDirectSale: boolean(rawUseAsDirectSale) }),
    ...(rawSaleableAsMain === undefined ? {} : { saleableAsMain: boolean(rawSaleableAsMain) }),
  };
}

function mappingProductId(row: MappingRow): string {
  return text(row.agora_product_id || row.provider_product_id);
}

function mappingKey(winerimId: unknown, format: unknown): string | null {
  const id = text(winerimId);
  const normalizedFormat = normalizeFormat(format);
  return id && normalizedFormat ? `${id}:${normalizedFormat}` : null;
}

function explicitProductIds(
  mappings: readonly MappingRow[],
  tracking: readonly TrackingRow[],
): Readonly<Record<string, string>> {
  const explicit: Record<string, string> = {};
  const rejected = new Set(
    mappings
      .filter((row) => text(row.status).toUpperCase() === "REJECTED")
      .map((row) => mappingKey(row.winerim_wine_id, row.format_type))
      .filter((key): key is string => !!key),
  );

  for (const row of mappings) {
    const key = mappingKey(row.winerim_wine_id, row.format_type);
    const productId = mappingProductId(row);
    if (!key || !/^\d+$/.test(productId) || !EXPLICIT_MAPPING_STATUSES.has(text(row.status).toUpperCase())) continue;
    explicit[key] = productId;
  }
  for (const row of tracking) {
    const key = mappingKey(row.winerim_wine_id, row.format);
    const productId = text(row.agora_product_id);
    if (!key || rejected.has(key) || explicit[key] || !/^\d+$/.test(productId)) continue;
    explicit[key] = productId;
  }
  return explicit;
}

function wineFromRow(row: WineRow, explicitIds: Readonly<Record<string, string>>): CatalogWineInput | null {
  const winerimId = text(row.winerim_id);
  const name = text(row.name);
  if (!winerimId || !name) return null;
  const raw = record(row.raw_payload);
  const bottleSalePrice = number(row.bottle_sale_price || row.price || field(raw, "bottle_sale_price", "bottlePrice"));
  const glassSalePrice = number(row.glass_sale_price || field(raw, "glass_sale_price", "glassPrice"));
  const magnumSalePrice = number(row.magnum_sale_price || field(raw, "magnum_sale_price", "magnumPrice"));
  const variants: CatalogWineInput["variants"][number][] = [];
  if (bottleSalePrice > 0) variants.push({
    format: "BOTTLE",
    salePrice: bottleSalePrice,
    costPrice: number(row.bottle_purchase_price || field(raw, "bottle_purchase_price", "purchasePrice")),
    explicitProductId: explicitIds[`${winerimId}:BOTTLE`],
  });
  if (glassSalePrice > 0 || boolean(row.serve_by_glass)) variants.push({
    format: "GLASS",
    salePrice: glassSalePrice,
    costPrice: number(row.glass_cost_price || field(raw, "glass_cost_price", "glassCost")),
    enabled: glassSalePrice > 0,
    explicitProductId: explicitIds[`${winerimId}:GLASS`],
  });
  if (magnumSalePrice > 0) variants.push({
    format: "MAGNUM",
    salePrice: magnumSalePrice,
    costPrice: number(row.magnum_purchase_price || field(raw, "magnum_purchase_price", "magnumCost")),
    explicitProductId: explicitIds[`${winerimId}:MAGNUM`],
  });
  for (const format of ["BOTTLE", "GLASS", "MAGNUM"] as const) {
    const explicitProductId = explicitIds[`${winerimId}:${format}`];
    if (!explicitProductId || variants.some((variant) => variant.format === format)) continue;
    variants.push({
      format,
      salePrice: 0,
      costPrice: 0,
      enabled: false,
      explicitProductId,
    });
  }
  return {
    winerimId,
    name,
    vintage: nullableText(row.vintage || field(raw, "vintage", "year")),
    wineType: normalizeWineType(row.wine_type || field(raw, "wine_type", "type")),
    active: boolean(row.is_active, true),
    variants,
  };
}

function mergeExistingProducts(
  master: readonly Record<string, unknown>[],
  providerProducts: readonly ProviderProductRow[],
  mappings: readonly MappingRow[],
  tracking: readonly TrackingRow[],
): CatalogExistingProduct[] {
  const products = new Map<string, CatalogExistingProduct>();

  const merge = (product: CatalogExistingProduct | null, authoritative = false): void => {
    if (!product) return;
    const current = products.get(product.productId);
    if (!current || authoritative) {
      products.set(product.productId, { ...current, ...product });
      return;
    }
    products.set(product.productId, {
      ...product,
      ...current,
      buttonText: current.buttonText ?? product.buttonText,
      familyId: current.familyId ?? product.familyId,
      salePrice: current.salePrice ?? product.salePrice,
      costPrice: current.costPrice ?? product.costPrice,
    });
  };

  for (const row of providerProducts) {
    const raw = record(row.raw_payload);
    merge(productFromRecord({
      ...raw,
      provider_product_id: row.provider_product_id,
      name: row.name,
      family_id: field(raw, "FamilyId", "familyId"),
      price: row.price,
    }));
  }
  for (const row of mappings) {
    if (text(row.status).toUpperCase() !== "CONFIRMED") continue;
    merge(productFromRecord({
      provider_product_id: mappingProductId(row),
      name: row.provider_product_name,
    }));
  }
  for (const row of tracking) {
    if (!REMOTE_TRACKING_STATUSES.has(text(row.sync_status).toUpperCase())) continue;
    const productId = text(row.agora_product_id);
    if (!productId || products.has(productId)) continue;
    merge(productFromRecord({
      provider_product_id: productId,
      name: `${normalizeFormat(row.format) || "BOTTLE"} ${text(row.winerim_wine_id)}`,
      family_id: row.agora_family_id,
    }));
  }
  for (const row of master) merge(productFromRecord(row), true);

  return [...products.values()].sort((left, right) => left.productId.localeCompare(right.productId, "en", { numeric: true }));
}

function familyRef(value: unknown, familiesById: ReadonlyMap<string, CatalogExistingFamily>): CatalogFamilyRef | null {
  if (typeof value === "string" || typeof value === "number") {
    return familiesById.get(text(value)) || null;
  }
  const parsed = familyFromRecord(record(value));
  return parsed ? familiesById.get(parsed.id) || parsed : null;
}

function configuredFamilyRouting(
  config: Record<string, unknown>,
  families: readonly CatalogExistingFamily[],
): CatalogFamilyRoutingInput {
  const raw = record(config.catalog_family_routing || config.agora_catalog_family_routing);
  const familiesById = new Map(families.map((family) => [family.id, family]));
  const byFormat: Partial<Record<CatalogFormat, CatalogFamilyRef>> = {};
  const byWineType: Record<string, CatalogFamilyRef> = {};
  const byFormatAndWineType: Record<string, CatalogFamilyRef> = {};

  for (const [key, value] of Object.entries(record(raw.byFormat || raw.by_format))) {
    const format = normalizeFormat(key);
    const ref = familyRef(value, familiesById);
    if (format && ref) byFormat[format] = ref;
  }
  for (const [key, value] of Object.entries(record(raw.byWineType || raw.by_wine_type))) {
    const ref = familyRef(value, familiesById);
    if (ref) byWineType[normalizeWineType(key)] = ref;
  }
  for (const [key, value] of Object.entries(record(raw.byFormatAndWineType || raw.by_format_and_wine_type))) {
    const [rawFormat, rawWineType] = key.split(":");
    const format = normalizeFormat(rawFormat);
    const ref = familyRef(value, familiesById);
    if (format && rawWineType && ref) byFormatAndWineType[`${format.toLowerCase()}:${normalizeWineType(rawWineType)}`] = ref;
  }

  return {
    ...(Object.keys(byFormatAndWineType).length > 0 ? { byFormatAndWineType } : {}),
    ...(Object.keys(byFormat).length > 0 ? { byFormat } : {}),
    ...(Object.keys(byWineType).length > 0 ? { byWineType } : {}),
    defaultFamily: familyRef(raw.defaultFamily || raw.default_family, familiesById),
  };
}

function inferredFamilyRouting(
  families: readonly CatalogExistingFamily[],
  defaultFamilyId: unknown,
): CatalogFamilyRoutingInput {
  const byFormat: Partial<Record<CatalogFormat, CatalogFamilyRef>> = {};
  const byWineType: Record<string, CatalogFamilyRef> = {};
  const find = (predicate: (key: string) => boolean): CatalogFamilyRef | undefined => {
    const family = families.find((candidate) => predicate(normalizedKey(candidate.name)));
    return family ? { id: family.id, name: family.name } : undefined;
  };
  const glass = find((key) => key.includes("copa") && key.includes("winerim"));
  const magnum = find((key) => key.includes("magnum") && key.includes("winerim"));
  if (glass) byFormat.GLASS = glass;
  if (magnum) byFormat.MAGNUM = magnum;

  const names: Record<string, readonly string[]> = {
    tinto: ["tinto"],
    blanco: ["blanco"],
    rosado: ["rosado"],
    espumoso: ["espumoso", "cava", "champagne"],
    fortificado: ["fortificado", "generoso", "jerez"],
    dulce: ["dulce", "postre"],
  };
  for (const [wineType, needles] of Object.entries(names)) {
    const match = find((key) => key.includes("winerim") && needles.some((needle) => key.includes(needle)));
    if (match) byWineType[wineType] = match;
  }

  const defaultFamily = families.find((family) => family.id === text(defaultFamilyId)) || null;
  return {
    ...(Object.keys(byFormat).length > 0 ? { byFormat } : {}),
    ...(Object.keys(byWineType).length > 0 ? { byWineType } : {}),
    defaultFamily,
  };
}

function mergeFamilyRouting(
  inferred: CatalogFamilyRoutingInput,
  configured: CatalogFamilyRoutingInput,
  override?: CatalogFamilyRoutingInput,
): CatalogFamilyRoutingInput {
  return {
    byFormatAndWineType: {
      ...(inferred.byFormatAndWineType || {}),
      ...(configured.byFormatAndWineType || {}),
      ...(override?.byFormatAndWineType || {}),
    },
    byFormat: {
      ...(inferred.byFormat || {}),
      ...(configured.byFormat || {}),
      ...(override?.byFormat || {}),
    },
    byWineType: {
      ...(inferred.byWineType || {}),
      ...(configured.byWineType || {}),
      ...(override?.byWineType || {}),
    },
    defaultFamily: override?.defaultFamily ?? configured.defaultFamily ?? inferred.defaultFamily ?? null,
  };
}

function labelPolicy(config: Record<string, unknown>, override?: CatalogLabelPolicy): CatalogLabelPolicy {
  const naming = record(config.agora_product_naming);
  const rawIds = config.agora_vintage_disambiguation_product_ids || naming.vintage_disambiguation_product_ids;
  const ids = Array.isArray(rawIds) ? rawIds.map(text).filter(Boolean) : [];
  const overrides = record(config.agora_product_name_overrides);
  const names: Record<string, string> = {};
  for (const [productId, value] of Object.entries(overrides)) {
    if (/^\d+$/.test(productId) && text(value)) names[productId] = text(value);
  }
  return {
    buttonTextMaxLength: 20,
    preferVintageForDuplicateNames: naming.prefer_vintage_for_duplicate_names !== false,
    ...(ids.length > 0 ? { vintageDisambiguationProductIds: ids } : {}),
    ...(Object.keys(names).length > 0 ? { nameOverridesByProductId: names } : {}),
    ...override,
  };
}

function sourceRevision(
  connection: ConnectionRow,
  master: MasterRow,
  wines: readonly WineRow[],
  mappings: readonly MappingRow[],
  providerProducts: readonly ProviderProductRow[],
  tracking: readonly TrackingRow[],
): string {
  const latest = (rows: readonly Record<string, unknown>[]): string => rows.map((row) => text(row.updated_at)).sort().at(-1) || "none";
  return [
    "catalog-db:v1",
    text(connection.updated_at) || "none",
    text(master.updated_at || master.fetched_at) || "none",
    `${wines.length}@${latest(wines)}`,
    `${mappings.length}@${latest(mappings)}`,
    `${providerProducts.length}@${latest(providerProducts)}`,
    `${tracking.length}@${latest(tracking)}`,
  ].join(":");
}

async function loadPlanningContext(
  database: DatabaseAdapter,
  request: CatalogRequest,
  options: PostgresCatalogAdapterOptions,
): ReturnType<CatalogHandlerPorts["loadPlanningContext"]> {
  try {
    return await database.transaction(async (transaction) => {
    const connectionResult = await transaction.query<ConnectionRow>(sql`
      SELECT
        id,
        provider,
        provider_config,
        default_family_id,
        updated_at,
        last_catalog_sync_at
      FROM public.pos_connections
      WHERE id = ${request.connectionId}::uuid
      LIMIT 1
    `);
    const connection = connectionResult.rows[0];
    if (!connection) return { ok: false, code: "CONTEXT_NOT_FOUND" };

    const masterResult = await transaction.query<MasterRow>(sql`
      SELECT families_json, products_summary_json, fetched_at, updated_at
      FROM public.agora_master_data
      WHERE connection_id = ${request.connectionId}::uuid
      LIMIT 1
    `);
    const master = masterResult.rows[0];
    if (!master) return { ok: false, code: "CONTEXT_INVALID" };
    const familyRows = records(master.families_json);
    const productRows = records(master.products_summary_json);
    const families = familyRows.map(familyFromRecord).filter((item): item is CatalogExistingFamily => !!item);
    if (families.length === 0) return { ok: false, code: "CONTEXT_INVALID" };

    const selectedWineIds = request.wineSelection.kind === "ids" ? [...request.wineSelection.ids] : [];
    const wineResult = await transaction.query<WineRow>(sql`
      SELECT
        winerim_id,
        name,
        vintage,
        wine_type,
        price,
        bottle_sale_price,
        bottle_purchase_price,
        glass_sale_price,
        glass_cost_price,
        magnum_sale_price,
        magnum_purchase_price,
        serve_by_glass,
        is_active,
        raw_payload,
        updated_at
      FROM public.winerim_wines
      WHERE connection_id = ${request.connectionId}::uuid
        AND (cardinality(${selectedWineIds}::text[]) = 0 OR winerim_id = ANY(${selectedWineIds}::text[]))
      ORDER BY winerim_id ASC
    `);
    const mappingResult = await transaction.query<MappingRow>(sql`
      SELECT
        provider_product_id,
        provider_product_name,
        winerim_wine_id,
        winerim_wine_name,
        format_type,
        agora_product_id,
        status,
        match_method,
        updated_at
      FROM public.product_mappings
      WHERE connection_id = ${request.connectionId}::uuid
      ORDER BY provider_product_id ASC
    `);
    const providerProductResult = await transaction.query<ProviderProductRow>(sql`
      SELECT
        provider_product_id,
        name,
        family,
        price,
        sale_format,
        winerim_wine_id,
        sync_status,
        raw_payload,
        updated_at
      FROM public.provider_products
      WHERE connection_id = ${request.connectionId}::uuid
      ORDER BY provider_product_id ASC
    `);
    const trackingResult = await transaction.query<TrackingRow>(sql`
      SELECT
        winerim_wine_id,
        format,
        agora_product_id,
        agora_family_id,
        sync_status,
        source,
        updated_at
      FROM public.winerim_push_tracking
      WHERE connection_id = ${request.connectionId}::uuid
      ORDER BY winerim_wine_id ASC, format ASC
    `);

    const config = record(connection.provider_config);
    const ids = explicitProductIds(mappingResult.rows, trackingResult.rows);
    const wines = wineResult.rows.map((row) => wineFromRow(row, ids)).filter((item): item is CatalogWineInput => !!item);
    const configuredRouting = configuredFamilyRouting(config, families);
    const productIdPolicy: CatalogProductIdPolicy = {
      ...options.productIdPolicy,
      explicitIds: {
        ...ids,
        ...(options.productIdPolicy?.explicitIds || {}),
      },
    };
    const context: CatalogPlanningContext = {
      provider: text(connection.provider) || "unknown",
      sourceRevision: sourceRevision(
        connection,
        master,
        wineResult.rows,
        mappingResult.rows,
        providerProductResult.rows,
        trackingResult.rows,
      ),
      wines,
      existingFamilies: families,
      existingProducts: mergeExistingProducts(
        productRows,
        providerProductResult.rows,
        mappingResult.rows,
        trackingResult.rows,
      ),
      familyRouting: mergeFamilyRouting(
        inferredFamilyRouting(families, connection.default_family_id),
        configuredRouting,
        options.familyRouting,
      ),
      productIdPolicy,
      labelPolicy: labelPolicy(config, options.labelPolicy),
    };
    return { ok: true, context };
    }, { isolationLevel: "repeatable-read", readOnly: true });
  } catch {
    return { ok: false, code: "CONTEXT_UNAVAILABLE" };
  }
}

function assertApplyInput(input: Parameters<NonNullable<CatalogHandlerPorts["applyPlan"]>>[0]): void {
  const { request, plan, idempotency } = input;
  if (request.dryRun || request.canonicalAction !== "apply" || plan.dryRun || plan.action !== "apply") {
    throw new PostgresCatalogAdapterInvariantError("CATALOG_DB_DRY_RUN_WRITE_REJECTED");
  }
  if (!plan.readyToApply || plan.operations.length === 0 || plan.issues.some((issue) => issue.severity === "error")) {
    throw new PostgresCatalogAdapterInvariantError("CATALOG_DB_PLAN_NOT_APPLICABLE");
  }
  if (
    request.connectionId !== plan.connectionId
    || plan.connectionId !== idempotency.connectionId
    || plan.provider !== idempotency.provider
    || plan.sourceRevision !== idempotency.sourceRevision
    || plan.idempotency.key !== idempotency.key
    || plan.idempotency.fingerprint !== idempotency.fingerprint
    || idempotency.scope !== "catalog-plan"
  ) {
    throw new PostgresCatalogAdapterInvariantError("CATALOG_DB_PLAN_SCOPE_MISMATCH");
  }
  const productIds = plan.operations.map((operation) => operation.desired.productId);
  if (new Set(productIds).size !== productIds.length || productIds.some((id) => !/^\d+$/.test(id))) {
    throw new PostgresCatalogAdapterInvariantError("CATALOG_DB_INVALID_PRODUCT_SET");
  }
}

function planResult(plan: CatalogPlan): Record<string, unknown> {
  return {
    version: plan.version,
    fingerprint: plan.idempotency.fingerprint,
    sourceRevision: plan.sourceRevision,
    provider: plan.provider,
    productIds: plan.operations.map((operation) => operation.desired.productId).sort((left, right) => Number(left) - Number(right)),
    state: "DB_PLAN_PREPARED",
  };
}

async function lockMappings(
  transaction: DatabaseTransaction,
  connectionId: string,
  operations: readonly CatalogProductOperation[],
): Promise<Map<string, MappingRow>> {
  const productIds = operations.map((operation) => operation.desired.productId);
  const result = await transaction.query<MappingRow>(sql`
    SELECT
      provider_product_id,
      provider_product_name,
      winerim_wine_id,
      winerim_wine_name,
      format_type,
      agora_product_id,
      status,
      match_method,
      updated_at
    FROM public.product_mappings
    WHERE connection_id = ${connectionId}::uuid
      AND provider_product_id = ANY(${productIds}::text[])
    FOR UPDATE
  `);
  return new Map(result.rows.map((row) => [text(row.provider_product_id), row]));
}

async function lockTracking(
  transaction: DatabaseTransaction,
  connectionId: string,
  operations: readonly CatalogProductOperation[],
): Promise<Map<string, TrackingRow>> {
  const wineIds = [...new Set(operations.map((operation) => operation.desired.winerimId))];
  const result = await transaction.query<TrackingRow>(sql`
    SELECT
      winerim_wine_id,
      format,
      agora_product_id,
      agora_family_id,
      sync_status,
      source,
      updated_at
    FROM public.winerim_push_tracking
    WHERE connection_id = ${connectionId}::uuid
      AND winerim_wine_id = ANY(${wineIds}::text[])
    FOR UPDATE
  `);
  return new Map(result.rows.map((row) => [mappingKey(row.winerim_wine_id, row.format) || "", row]));
}

function assertNoIdentityConflicts(
  operations: readonly CatalogProductOperation[],
  mappings: ReadonlyMap<string, MappingRow>,
  tracking: ReadonlyMap<string, TrackingRow>,
): void {
  for (const operation of operations) {
    const desired = operation.desired;
    const mapping = mappings.get(desired.productId);
    if (mapping) {
      const status = text(mapping.status).toUpperCase();
      const mappedWineId = text(mapping.winerim_wine_id);
      const mappedFormat = normalizeFormat(mapping.format_type);
      if (
        ["IGNORED", "REJECTED"].includes(status)
        || (mappedWineId && mappedWineId !== desired.winerimId)
        || (mappedFormat && mappedFormat !== desired.format)
      ) {
        throw new PostgresCatalogAdapterInvariantError("CATALOG_DB_MAPPING_CONFLICT");
      }
    }
    const tracked = tracking.get(`${desired.winerimId}:${desired.format}`);
    const trackedProductId = text(tracked?.agora_product_id);
    if (trackedProductId && trackedProductId !== desired.productId) {
      throw new PostgresCatalogAdapterInvariantError("CATALOG_DB_TRACKING_CONFLICT");
    }
  }
}

async function claimPlan(
  transaction: DatabaseTransaction,
  plan: CatalogPlan,
): Promise<"ACQUIRED" | "DUPLICATE"> {
  const metadata = JSON.stringify(planResult(plan));
  const inserted = await transaction.query<ClaimRow>(sql`
    INSERT INTO public.runtime_idempotency (
      idempotency_key,
      message_id,
      connection_id,
      job,
      status,
      attempt,
      lease_expires_at,
      result
    ) VALUES (
      ${plan.idempotency.key},
      ${plan.idempotency.fingerprint},
      ${plan.connectionId}::uuid,
      ${CATALOG_PLAN_JOB},
      'RUNNING',
      1,
      NULL,
      ${metadata}::jsonb
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING idempotency_key, job, status, result
  `);
  if (inserted.rowCount === 1) return "ACQUIRED";

  const current = await transaction.query<ClaimRow>(sql`
    SELECT idempotency_key, job, status, result
    FROM public.runtime_idempotency
    WHERE idempotency_key = ${plan.idempotency.key}
    FOR UPDATE
  `);
  const row = current.rows[0];
  const result = record(row?.result);
  if (
    row
    && text(row.job) === CATALOG_PLAN_JOB
    && text(row.status) === "SUCCESS"
    && text(result.fingerprint) === plan.idempotency.fingerprint
    && text(result.state) === "DB_PLAN_PREPARED"
  ) return "DUPLICATE";
  throw new PostgresCatalogAdapterInvariantError("CATALOG_DB_IDEMPOTENCY_CONFLICT");
}

async function persistMappingPlan(
  transaction: DatabaseTransaction,
  connectionId: string,
  operation: CatalogProductOperation,
  existing: MappingRow | undefined,
  planKey: string,
): Promise<void> {
  if (existing && REJECTED_MAPPING_STATUSES.has(text(existing.status).toUpperCase())) return;
  const desired = operation.desired;
  const reasons = ["EXACT_PROVIDER_READBACK", `plan:${planKey}`];
  const result = await transaction.query<Record<string, unknown>>(sql`
    INSERT INTO public.product_mappings (
      connection_id,
      provider_product_id,
      provider_product_name,
      winerim_wine_id,
      winerim_wine_name,
      match_method,
      match_score,
      match_reasons,
      status,
      format_type,
      agora_product_id,
      last_synced_at,
      last_sync_error
    )
    SELECT
      ${connectionId}::uuid,
      ${desired.productId},
      ${desired.label.name},
      ww.winerim_id,
      ww.name,
      CASE
        WHEN stock_contract.stock_active IS TRUE THEN 'RESCUE_EXACT_ID_WINE_VARIANT'
        ELSE 'RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY'
      END,
      1,
      ${reasons}::text[],
      'CONFIRMED',
      ${desired.format},
      ${desired.productId},
      now(),
      NULL
    FROM public.winerim_wines ww
    JOIN LATERAL (
      SELECT
        bool_and((stock_entry->>'stockActive')::boolean) AS stock_active,
        count(*) AS stock_count
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(ww.raw_payload->'stocks') = 'array' THEN ww.raw_payload->'stocks'
          ELSE '[]'::jsonb
        END
      ) stock_entry
      WHERE stock_entry->>'id' = (
        CASE
          WHEN ${desired.format} = 'GLASS' THEN ww.glass_stock_id
          WHEN ${desired.format} = 'MAGNUM' THEN ww.magnum_stock_id
          ELSE ww.bottle_stock_id
        END
      )::text
        AND jsonb_typeof(stock_entry->'stockActive') = 'boolean'
    ) stock_contract ON stock_contract.stock_count = 1
    WHERE ww.connection_id = ${connectionId}::uuid
      AND ww.winerim_id = ${desired.winerimId}
    ON CONFLICT (connection_id, provider_product_id) DO UPDATE SET
      provider_product_name = EXCLUDED.provider_product_name,
      winerim_wine_id = EXCLUDED.winerim_wine_id,
      winerim_wine_name = EXCLUDED.winerim_wine_name,
      match_method = EXCLUDED.match_method,
      match_score = EXCLUDED.match_score,
      match_reasons = EXCLUDED.match_reasons,
      status = 'CONFIRMED',
      format_type = EXCLUDED.format_type,
      agora_product_id = EXCLUDED.agora_product_id,
      last_synced_at = now(),
      last_sync_error = NULL,
      updated_at = now()
    WHERE product_mappings.status IN ('PENDING', 'CONFIRMED')
    RETURNING provider_product_id
  `);
  if (result.rowCount !== 1) {
    throw new PostgresCatalogAdapterInvariantError("CATALOG_DB_MAPPING_PLAN_NOT_PERSISTED");
  }
}

async function persistTrackingPlan(
  transaction: DatabaseTransaction,
  connectionId: string,
  operation: CatalogProductOperation,
): Promise<void> {
  const desired = operation.desired;
  const certifiedStatus = desired.saleableAsMain === false ? "HIDDEN" : "VERIFIED";
  await transaction.query(sql`
    INSERT INTO public.winerim_push_tracking (
      connection_id,
      winerim_wine_id,
      format,
      agora_product_id,
      agora_family_id,
      source,
      sync_status,
      last_error,
      pushed_at,
      verified_at
    ) VALUES (
      ${connectionId}::uuid,
      ${desired.winerimId},
      ${desired.format},
      ${desired.productId},
      ${desired.family.id},
      'WINERIM',
      ${certifiedStatus},
      NULL,
      now(),
      now()
    )
    ON CONFLICT (connection_id, winerim_wine_id, format) DO UPDATE SET
      agora_product_id = EXCLUDED.agora_product_id,
      agora_family_id = EXCLUDED.agora_family_id,
      source = 'WINERIM',
      sync_status = EXCLUDED.sync_status,
      last_error = NULL,
      pushed_at = EXCLUDED.pushed_at,
      verified_at = EXCLUDED.verified_at,
      updated_at = now()
  `);
}

type CatalogApplyInput = Parameters<NonNullable<CatalogHandlerPorts["applyPlan"]>>[0];
type CatalogApplySuccess = Extract<CatalogApplyPortResult, { ok: true }>;

class PostgresCatalogPreflightRollback extends Error {
  constructor(readonly result: CatalogApplySuccess) {
    super("CATALOG_DB_PREFLIGHT_ROLLBACK");
    this.name = "PostgresCatalogPreflightRollback";
  }
}

function applyFailure(error: unknown): Extract<CatalogApplyPortResult, { ok: false }> {
  if (error instanceof PostgresCatalogAdapterInvariantError) {
    const conflict = error.code.includes("CONFLICT") || error.code.includes("SCOPE_MISMATCH");
    return { ok: false, code: conflict ? "APPLY_CONFLICT" : "APPLY_REJECTED" };
  }
  return { ok: false, code: "APPLY_UNAVAILABLE" };
}

async function persistPlan(
  transaction: DatabaseTransaction,
  input: CatalogApplyInput,
): Promise<CatalogApplySuccess> {
  const connection = await transaction.query<ConnectionRow>(sql`
    SELECT id, provider, provider_config, default_family_id, updated_at, last_catalog_sync_at
    FROM public.pos_connections
    WHERE id = ${input.plan.connectionId}::uuid
    FOR SHARE
  `);
  if (!connection.rows[0] || text(connection.rows[0].provider) !== input.plan.provider) {
    throw new PostgresCatalogAdapterInvariantError("CATALOG_DB_CONNECTION_SCOPE_MISMATCH");
  }

  const mappings = await lockMappings(transaction, input.plan.connectionId, input.plan.operations);
  const tracking = await lockTracking(transaction, input.plan.connectionId, input.plan.operations);
  assertNoIdentityConflicts(input.plan.operations, mappings, tracking);
  const claim = await claimPlan(transaction, input.plan);
  const productIds = input.plan.operations.map((operation) => operation.desired.productId)
    .sort((left, right) => Number(left) - Number(right));
  if (claim === "DUPLICATE") {
    return { ok: true, receipt: { status: "duplicate", appliedProductIds: productIds } };
  }

  for (const operation of input.plan.operations) {
    await persistMappingPlan(
      transaction,
      input.plan.connectionId,
      operation,
      mappings.get(operation.desired.productId),
      input.plan.idempotency.key,
    );
    await persistTrackingPlan(transaction, input.plan.connectionId, operation);
  }

  const completed = await transaction.query<ClaimRow>(sql`
    UPDATE public.runtime_idempotency
    SET
      status = 'SUCCESS',
      lease_expires_at = NULL,
      result = ${JSON.stringify(planResult(input.plan))}::jsonb,
      updated_at = now()
    WHERE idempotency_key = ${input.plan.idempotency.key}
      AND connection_id = ${input.plan.connectionId}::uuid
      AND job = ${CATALOG_PLAN_JOB}
      AND status = 'RUNNING'
    RETURNING idempotency_key, job, status, result
  `);
  if (completed.rowCount !== 1) {
    throw new PostgresCatalogAdapterInvariantError("CATALOG_DB_PLAN_COMPLETE_NOT_OWNED");
  }
  return { ok: true, receipt: { status: "applied", appliedProductIds: productIds } };
}

async function preflightApplyPlan(
  database: DatabaseAdapter,
  input: CatalogApplyInput,
): Promise<CatalogApplyPortResult> {
  try {
    assertApplyInput(input);
  } catch (error) {
    return applyFailure(error);
  }

  try {
    await database.transaction(async (transaction) => {
      const result = await persistPlan(transaction, input);
      throw new PostgresCatalogPreflightRollback(result);
    }, { isolationLevel: "serializable", readOnly: false });
    return { ok: false, code: "APPLY_UNAVAILABLE" };
  } catch (error) {
    if (error instanceof PostgresCatalogPreflightRollback) return error.result;
    return applyFailure(error);
  }
}

async function applyPlan(
  database: DatabaseAdapter,
  input: Parameters<NonNullable<CatalogHandlerPorts["applyPlan"]>>[0],
): Promise<CatalogApplyPortResult> {
  try {
    assertApplyInput(input);
  } catch (error) {
    if (error instanceof PostgresCatalogAdapterInvariantError) return { ok: false, code: "APPLY_REJECTED" };
    return { ok: false, code: "APPLY_UNAVAILABLE" };
  }

  try {
    return await database.transaction(
      (transaction) => persistPlan(transaction, input),
      { isolationLevel: "serializable", readOnly: false },
    );
  } catch (error) {
    return applyFailure(error);
  }
}

export function createPostgresCatalogAdapter(
  database: DatabaseAdapter,
  options: PostgresCatalogAdapterOptions = {},
): PostgresCatalogAdapter {
  return {
    loadPlanningContext: (request) => loadPlanningContext(database, request, options),
    preflightApplyPlan: (input) => preflightApplyPlan(database, input),
    applyPlan: (input) => applyPlan(database, input),
  };
}
