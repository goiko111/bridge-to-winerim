import { canonicalJson, sha256Hex } from "../../idempotency";
import { JsonValue } from "../../contracts";
import {
  CATALOG_PLAN_VERSION,
  CatalogChangedField,
  CatalogExistingFamily,
  CatalogExistingProduct,
  CatalogFamilyRef,
  CatalogFormat,
  CatalogIdempotencyDescriptor,
  CatalogLabelPolicy,
  CatalogPlan,
  CatalogPlanIssue,
  CatalogPlanningContext,
  CatalogProductIdPolicy,
  CatalogProductLabel,
  CatalogProductOperation,
  CatalogRequest,
  CatalogWineInput,
  CatalogWineVariantInput,
} from "./contracts";

const DEFAULT_OFFSETS: Record<CatalogFormat, number> = {
  BOTTLE: 500000,
  GLASS: 700000,
  MAGNUM: 900000,
};
const DEFAULT_PREFIXES: Record<CatalogFormat, string> = {
  BOTTLE: "B",
  GLASS: "C",
  MAGNUM: "M",
};
const WINE_TYPE_ALIASES: Record<string, string> = { postre: "dulce" };
const WINE_TYPE_FAMILY_NAMES: Record<string, readonly string[]> = {
  tinto: ["VINOS TINTOS", "Tintos", "Tinto"],
  blanco: ["VINOS BLANCOS", "Blancos", "Blanco"],
  rosado: ["VINOS ROSADOS", "Rosados", "Rosado"],
  espumoso: ["ESPUMOSOS", "Espumosos", "Cava", "Champagne"],
  cava: ["ESPUMOSOS", "Cava", "Espumosos"],
  champagne: ["ESPUMOSOS", "Champagne", "Espumosos"],
  generoso: ["GENEROSOS", "Generosos", "Jerez"],
  fortificado: ["GENEROSOS", "Generosos"],
  dulce: ["DULCE", "Dulce", "Postre", "Dessert"],
  postre: ["DULCE", "Dulce", "Postre", "Dessert"],
};

type ProductCandidate = {
  wine: CatalogWineInput;
  variant: CatalogWineVariantInput;
  productId: string;
  baseName: string;
  family: CatalogFamilyRef;
};

function normalizedText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizedNameKey(value: unknown): string {
  return normalizedText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function canonicalWineType(value: unknown): string {
  const normalized = normalizedNameKey(value);
  return WINE_TYPE_ALIASES[normalized] || normalized;
}

function formatRoutingKey(format: CatalogFormat, wineType: string): string {
  return `${format.toLowerCase()}:${wineType}`;
}

function productIdFor(
  wine: CatalogWineInput,
  variant: CatalogWineVariantInput,
  policy: CatalogProductIdPolicy = {},
): string | null {
  const explicitKey = `${wine.winerimId}:${variant.format}`;
  const explicitId = normalizedText(
    variant.explicitProductId || policy.explicitIds?.[explicitKey],
  );
  if (explicitId) return /^\d+$/.test(explicitId) ? explicitId : null;

  const winerimId = Number(wine.winerimId);
  const offset = Number(policy.offsets?.[variant.format] ?? DEFAULT_OFFSETS[variant.format]);
  const productId = winerimId + offset;
  return Number.isSafeInteger(winerimId) && winerimId > 0
    && Number.isSafeInteger(offset) && offset >= 0
    && Number.isSafeInteger(productId)
    ? String(productId)
    : null;
}

function resolveConfiguredFamily(
  ref: CatalogFamilyRef | null | undefined,
  familiesById: ReadonlyMap<string, CatalogExistingFamily>,
): CatalogFamilyRef | null {
  if (!ref) return null;
  const existing = familiesById.get(normalizedText(ref.id));
  if (!existing) return { id: normalizedText(ref.id), name: normalizedText(ref.name) };
  return { id: existing.id, name: existing.name };
}

function resolveFamily(
  context: CatalogPlanningContext,
  wine: CatalogWineInput,
  format: CatalogFormat,
): { family: CatalogFamilyRef | null; configured: boolean } {
  const families = [...context.existingFamilies]
    .filter((family) => normalizedText(family.id) && normalizedText(family.name))
    .map((family) => ({ id: normalizedText(family.id), name: normalizedText(family.name) }));
  const familiesById = new Map(families.map((family) => [family.id, family]));
  const wineType = canonicalWineType(wine.wineType);
  const routing = context.familyRouting || {};
  const configured = [
    wineType ? routing.byFormatAndWineType?.[formatRoutingKey(format, wineType)] : null,
    routing.byFormat?.[format],
    wineType ? routing.byWineType?.[wineType] : null,
    routing.defaultFamily,
  ].find(Boolean) as CatalogFamilyRef | undefined;
  if (configured) return { family: resolveConfiguredFamily(configured, familiesById), configured: true };

  const expectedNames = WINE_TYPE_FAMILY_NAMES[wineType] || [];
  for (const expectedName of expectedNames) {
    const exact = families.find((family) => normalizedNameKey(family.name) === normalizedNameKey(expectedName));
    if (exact) return { family: exact, configured: false };
  }

  const generic = families.find((family) => ["vinos", "vino", "wine", "wines"].includes(normalizedNameKey(family.name)));
  return { family: generic || families[0] || null, configured: false };
}

function normalizeVintage(value: unknown): string {
  return normalizedText(value).match(/\b(18|19|20)\d{2}\b/)?.[0] || "";
}

function suffixCandidates(value: unknown): string[] {
  const raw = normalizedText(value);
  const digits = raw.replace(/\D/g, "");
  const source = digits || raw;
  return [...new Set([
    source.length > 3 ? source.slice(-3) : source,
    source.length > 6 ? source.slice(-6) : source,
    source,
  ].filter(Boolean))];
}

function buttonText(baseName: string, finalName: string, suffix: string, maxLength: number): string {
  if (!suffix) return finalName.slice(0, maxLength);
  const suffixText = ` ${suffix}`;
  if (suffixText.length >= maxLength) return suffix.slice(0, maxLength);
  const head = baseName.slice(0, maxLength - suffixText.length).trimEnd();
  return `${head || baseName.charAt(0)}${suffixText}`.slice(0, maxLength);
}

function labelsFor(
  candidates: readonly ProductCandidate[],
  existingProducts: readonly CatalogExistingProduct[],
  policy: CatalogLabelPolicy = {},
): Record<string, CatalogProductLabel> {
  const maxLength = Math.max(1, Math.min(100, Math.floor(policy.buttonTextMaxLength ?? 20)));
  const existingOwners = new Map<string, Set<string>>();
  for (const product of existingProducts) {
    const key = normalizedNameKey(product.name);
    if (!key || !product.productId) continue;
    const owners = existingOwners.get(key) || new Set<string>();
    owners.add(String(product.productId));
    existingOwners.set(key, owners);
  }

  const groups = new Map<string, ProductCandidate[]>();
  for (const candidate of candidates) {
    const key = normalizedNameKey(candidate.baseName);
    const group = groups.get(key) || [];
    group.push(candidate);
    groups.set(key, group);
  }

  const assigned = new Set<string>();
  const labels: Record<string, CatalogProductLabel> = {};
  const vintageAllowlist = new Set(policy.vintageDisambiguationProductIds || []);
  const preferVintage = policy.preferVintageForDuplicateNames !== false;

  const hasExternalOwner = (name: string, productId: string): boolean =>
    [...(existingOwners.get(normalizedNameKey(name)) || [])].some((owner) => owner !== productId);
  const available = (name: string, productId: string): boolean =>
    !assigned.has(normalizedNameKey(name)) && !hasExternalOwner(name, productId);

  for (const group of groups.values()) {
    const sorted = [...group].sort((left, right) => Number(left.productId) - Number(right.productId));
    const generatedIds = new Set(sorted.map((entry) => entry.productId));
    const baseName = sorted[0].baseName;
    const externalCollision = [...(existingOwners.get(normalizedNameKey(baseName)) || [])]
      .some((owner) => !generatedIds.has(owner));

    sorted.forEach((entry, index) => {
      const override = normalizedText(policy.nameOverridesByProductId?.[entry.productId]);
      if (override) {
        labels[entry.productId] = { name: override, buttonText: override.slice(0, maxLength) };
        assigned.add(normalizedNameKey(override));
        return;
      }

      const vintage = normalizeVintage(entry.wine.vintage);
      const preferVintageHere = Boolean(
        vintage
        && (sorted.length > 1 || externalCollision)
        && (preferVintage || vintageAllowlist.has(entry.productId)),
      );
      const mustDisambiguate = index > 0 || externalCollision || !available(entry.baseName, entry.productId);
      let finalName = entry.baseName;
      let suffix = "";
      let vintageSuffix = false;

      if (preferVintageHere || mustDisambiguate) {
        const suffixes = [
          ...(preferVintageHere ? [{ value: vintage, vintage: true }] : []),
          ...suffixCandidates(entry.wine.winerimId).map((value) => ({ value, vintage: false })),
        ];
        finalName = "";
        for (const candidate of suffixes) {
          const name = `${entry.baseName} ${candidate.value}`.trim();
          if (!available(name, entry.productId)) continue;
          finalName = name;
          suffix = candidate.value;
          vintageSuffix = candidate.vintage;
          break;
        }
        if (!finalName) {
          finalName = `${entry.baseName} ${entry.productId}`;
          suffix = entry.productId;
        }
      }

      labels[entry.productId] = {
        name: finalName,
        buttonText: vintageSuffix
          ? buttonText(entry.baseName, finalName, suffix, maxLength)
          : finalName.slice(0, maxLength),
      };
      assigned.add(normalizedNameKey(finalName));
    });
  }
  return labels;
}

function numberEqual(left: number | null | undefined, right: number): boolean {
  return left !== null && left !== undefined && Number(left).toFixed(2) === Number(right).toFixed(2);
}

function changedFields(
  existing: CatalogExistingProduct | undefined,
  desired: CatalogProductOperation["desired"],
): CatalogChangedField[] {
  if (!existing) return ["name", "buttonText", "familyId", "salePrice", "costPrice"];
  const changed: CatalogChangedField[] = [];
  if (normalizedText(existing.name) !== desired.label.name) changed.push("name");
  if (existing.buttonText !== undefined && existing.buttonText !== null
      && normalizedText(existing.buttonText) !== desired.label.buttonText) changed.push("buttonText");
  if (existing.familyId !== undefined && existing.familyId !== null
      && normalizedText(existing.familyId) !== desired.family.id) changed.push("familyId");
  if (existing.salePrice !== undefined && existing.salePrice !== null
      && !numberEqual(existing.salePrice, desired.salePrice)) changed.push("salePrice");
  if (existing.costPrice !== undefined && existing.costPrice !== null
      && !numberEqual(existing.costPrice, desired.costPrice)) changed.push("costPrice");
  return changed;
}

async function idempotencyDescriptor(input: {
  scope: CatalogIdempotencyDescriptor["scope"];
  connectionId: string;
  provider: string;
  sourceRevision: string;
  productId?: string;
  state: JsonValue;
}): Promise<CatalogIdempotencyDescriptor> {
  const fingerprint = await sha256Hex(canonicalJson(input.state));
  const material: JsonValue = {
    version: CATALOG_PLAN_VERSION,
    scope: input.scope,
    connectionId: input.connectionId,
    provider: input.provider,
    sourceRevision: input.sourceRevision,
    productId: input.productId || null,
    fingerprint,
  };
  return {
    version: CATALOG_PLAN_VERSION,
    scope: input.scope,
    key: `catalog:v1:${await sha256Hex(canonicalJson(material))}`,
    fingerprint,
    connectionId: input.connectionId,
    provider: input.provider,
    sourceRevision: input.sourceRevision,
    ...(input.productId ? { productId: input.productId } : {}),
  };
}

function issue(
  issues: CatalogPlanIssue[],
  code: CatalogPlanIssue["code"],
  input: Partial<Pick<CatalogPlanIssue, "winerimId" | "format" | "productId">> = {},
  severity: CatalogPlanIssue["severity"] = "error",
): void {
  issues.push({ severity, code, ...input });
}

export async function buildCatalogPlan(
  request: CatalogRequest,
  context: CatalogPlanningContext,
): Promise<CatalogPlan> {
  const provider = normalizedText(context.provider) || "unknown";
  const sourceRevision = normalizedText(context.sourceRevision);
  const issues: CatalogPlanIssue[] = [];
  const selectedIds = request.wineSelection.kind === "ids" ? new Set(request.wineSelection.ids) : null;
  if (selectedIds) {
    const availableIds = new Set(context.wines.map((wine) => normalizedText(wine.winerimId)));
    for (const winerimId of selectedIds) {
      if (!availableIds.has(winerimId)) issue(issues, "REQUESTED_WINE_NOT_FOUND", { winerimId });
    }
  }
  const wines = [...context.wines]
    .filter((wine) => !selectedIds || selectedIds.has(String(wine.winerimId)))
    .sort((left, right) => Number(left.winerimId) - Number(right.winerimId));
  const seenWineIds = new Set<string>();
  const productOwners = new Map<string, string>();
  const candidates: ProductCandidate[] = [];
  let consideredVariants = 0;

  for (const wine of wines) {
    const winerimId = normalizedText(wine.winerimId);
    if (seenWineIds.has(winerimId)) {
      issue(issues, "DUPLICATE_WINE_INPUT", { winerimId });
      continue;
    }
    seenWineIds.add(winerimId);
    if (!/^\d+$/.test(winerimId) || Number(winerimId) <= 0) {
      issue(issues, "INVALID_WINERIM_ID", { winerimId });
      continue;
    }
    if (normalizedText(wine.name).length < 2) {
      issue(issues, "INVALID_WINE_NAME", { winerimId });
      continue;
    }
    if (wine.active === false) {
      issue(issues, "WINE_INACTIVE", { winerimId }, "warning");
      continue;
    }

    const seenFormats = new Set<CatalogFormat>();
    const variants = [...wine.variants].sort((left, right) => request.formats.indexOf(left.format) - request.formats.indexOf(right.format));
    for (const variant of variants) {
      consideredVariants++;
      if (seenFormats.has(variant.format)) {
        issue(issues, "DUPLICATE_VARIANT_INPUT", { winerimId, format: variant.format });
        continue;
      }
      seenFormats.add(variant.format);
      if (!request.formats.includes(variant.format)) {
        issue(issues, "FORMAT_NOT_REQUESTED", { winerimId, format: variant.format }, "warning");
        continue;
      }
      if (variant.enabled === false) {
        issue(issues, "VARIANT_DISABLED", { winerimId, format: variant.format }, "warning");
        continue;
      }
      if (!Number.isFinite(variant.salePrice) || variant.salePrice <= 0) {
        issue(issues, "INVALID_SALE_PRICE", { winerimId, format: variant.format });
        continue;
      }

      const productId = productIdFor(wine, variant, context.productIdPolicy);
      if (!productId) {
        issue(issues, "INVALID_PRODUCT_ID", { winerimId, format: variant.format });
        continue;
      }
      const owner = productOwners.get(productId);
      if (owner && owner !== `${winerimId}:${variant.format}`) {
        issue(issues, "PRODUCT_ID_COLLISION", { winerimId, format: variant.format, productId });
        continue;
      }
      productOwners.set(productId, `${winerimId}:${variant.format}`);

      const resolved = resolveFamily(context, wine, variant.format);
      if (!resolved.family) {
        issue(issues, "FAMILY_NOT_RESOLVED", { winerimId, format: variant.format, productId });
        continue;
      }
      if (resolved.configured && !context.existingFamilies.some((family) => normalizedText(family.id) === resolved.family?.id)) {
        issue(issues, "FAMILY_NOT_IN_MASTER", { winerimId, format: variant.format, productId });
        continue;
      }

      const prefix = normalizedText(context.labelPolicy?.prefixes?.[variant.format] || DEFAULT_PREFIXES[variant.format]);
      candidates.push({
        wine,
        variant,
        productId,
        baseName: `${prefix} ${normalizedText(wine.name)}`.trim(),
        family: resolved.family,
      });
    }
  }

  candidates.sort((left, right) => Number(left.productId) - Number(right.productId));
  const productLabelsById = labelsFor(candidates, context.existingProducts, context.labelPolicy);
  const existingById = new Map(context.existingProducts.map((product) => [String(product.productId), product]));
  const operations: CatalogProductOperation[] = [];

  for (const candidate of candidates) {
    const desired: CatalogProductOperation["desired"] = {
      productId: candidate.productId,
      winerimId: candidate.wine.winerimId,
      format: candidate.variant.format,
      label: productLabelsById[candidate.productId],
      family: candidate.family,
      salePrice: Number(candidate.variant.salePrice.toFixed(2)),
      costPrice: Number(Math.max(0, candidate.variant.costPrice || 0).toFixed(2)),
      useAsDirectSale: false,
      saleableAsMain: true,
    };
    const existing = existingById.get(candidate.productId);
    const fields = changedFields(existing, desired);
    const operationState = desired as unknown as JsonValue;
    operations.push({
      kind: !existing ? "create" : fields.length > 0 ? "update" : "unchanged",
      desired,
      changedFields: fields,
      idempotency: await idempotencyDescriptor({
        scope: "catalog-product-upsert",
        connectionId: request.connectionId,
        provider,
        sourceRevision,
        productId: candidate.productId,
        state: operationState,
      }),
    });
  }

  const planState: JsonValue = operations.map((operation) => ({
    kind: operation.kind,
    desired: operation.desired as unknown as JsonValue,
    changedFields: [...operation.changedFields],
    operationKey: operation.idempotency.key,
  }));
  const idempotency = await idempotencyDescriptor({
    scope: "catalog-plan",
    connectionId: request.connectionId,
    provider,
    sourceRevision,
    state: planState,
  });
  const blockingIssues = issues.filter((entry) => entry.severity === "error").length;

  return {
    version: CATALOG_PLAN_VERSION,
    connectionId: request.connectionId,
    provider,
    sourceRevision,
    action: request.canonicalAction,
    dryRun: request.dryRun,
    readyToApply: blockingIssues === 0,
    formats: request.formats,
    operations,
    productLabelsById,
    issues,
    summary: {
      requestedWines: wines.length,
      consideredVariants,
      create: operations.filter((operation) => operation.kind === "create").length,
      update: operations.filter((operation) => operation.kind === "update").length,
      unchanged: operations.filter((operation) => operation.kind === "unchanged").length,
      blocked: blockingIssues,
    },
    idempotency,
  };
}
