export const CATALOG_PLAN_VERSION = 1 as const;

export type CatalogFormat = "BOTTLE" | "GLASS" | "MAGNUM";
export type CatalogAction = "preview" | "apply";
export type CatalogRequestAction =
  | "catalog.preview"
  | "catalog.apply"
  | "preview-xml"
  | "xml-import";

export type CatalogRequest = {
  action: CatalogRequestAction;
  canonicalAction: CatalogAction;
  connectionId: string;
  dryRun: boolean;
  formats: readonly CatalogFormat[];
  wineSelection: { kind: "all" } | { kind: "ids"; ids: readonly string[] };
};

export type CatalogFamilyRef = {
  id: string;
  name: string;
};

export type CatalogFamilyRoutingInput = {
  byFormatAndWineType?: Readonly<Record<string, CatalogFamilyRef>>;
  byFormat?: Partial<Readonly<Record<CatalogFormat, CatalogFamilyRef>>>;
  byWineType?: Readonly<Record<string, CatalogFamilyRef>>;
  defaultFamily?: CatalogFamilyRef | null;
};

export type CatalogProductIdPolicy = {
  offsets?: Partial<Readonly<Record<CatalogFormat, number>>>;
  explicitIds?: Readonly<Record<string, string>>;
};

export type CatalogLabelPolicy = {
  prefixes?: Partial<Readonly<Record<CatalogFormat, string>>>;
  buttonTextMaxLength?: number;
  preferVintageForDuplicateNames?: boolean;
  vintageDisambiguationProductIds?: readonly string[];
  nameOverridesByProductId?: Readonly<Record<string, string>>;
};

export type CatalogWineVariantInput = {
  format: CatalogFormat;
  salePrice: number;
  costPrice?: number | null;
  enabled?: boolean;
  explicitProductId?: string;
};

export type CatalogWineInput = {
  winerimId: string;
  name: string;
  vintage?: string | number | null;
  wineType?: string | null;
  active?: boolean;
  variants: readonly CatalogWineVariantInput[];
};

export type CatalogExistingFamily = {
  id: string;
  name: string;
};

export type CatalogExistingProduct = {
  productId: string;
  name: string;
  buttonText?: string | null;
  familyId?: string | null;
  salePrice?: number | null;
  costPrice?: number | null;
  useAsDirectSale?: boolean | null;
  saleableAsMain?: boolean | null;
};

export type CatalogPlanningContext = {
  provider: string;
  sourceRevision: string;
  wines: readonly CatalogWineInput[];
  existingFamilies: readonly CatalogExistingFamily[];
  existingProducts: readonly CatalogExistingProduct[];
  familyRouting: CatalogFamilyRoutingInput;
  productIdPolicy?: CatalogProductIdPolicy;
  labelPolicy?: CatalogLabelPolicy;
};

export type CatalogPlanIssueCode =
  | "DUPLICATE_WINE_INPUT"
  | "DUPLICATE_VARIANT_INPUT"
  | "REQUESTED_WINE_NOT_FOUND"
  | "INVALID_WINERIM_ID"
  | "INVALID_WINE_NAME"
  | "WINE_INACTIVE"
  | "FORMAT_NOT_REQUESTED"
  | "VARIANT_DISABLED"
  | "INVALID_SALE_PRICE"
  | "HIDE_BASELINE_INCOMPLETE"
  | "INVALID_PRODUCT_ID"
  | "PRODUCT_ID_COLLISION"
  | "FAMILY_NOT_RESOLVED"
  | "FAMILY_NOT_IN_MASTER";

export type CatalogPlanIssue = {
  severity: "error" | "warning";
  code: CatalogPlanIssueCode;
  winerimId?: string;
  format?: CatalogFormat;
  productId?: string;
};

export type CatalogProductLabel = {
  name: string;
  buttonText: string;
};

export type CatalogProductDesiredState = {
  productId: string;
  winerimId: string;
  format: CatalogFormat;
  label: CatalogProductLabel;
  family: CatalogFamilyRef;
  salePrice: number;
  costPrice: number;
  useAsDirectSale: boolean;
  saleableAsMain: boolean;
};

export type CatalogChangedField =
  | "name"
  | "buttonText"
  | "familyId"
  | "salePrice"
  | "costPrice"
  | "useAsDirectSale"
  | "saleableAsMain";

export type CatalogIdempotencyDescriptor = {
  version: typeof CATALOG_PLAN_VERSION;
  scope: "catalog-plan" | "catalog-product-upsert";
  key: string;
  fingerprint: string;
  connectionId: string;
  provider: string;
  sourceRevision: string;
  productId?: string;
};

export type CatalogProductOperation = {
  kind: "create" | "update" | "unchanged";
  desired: CatalogProductDesiredState;
  changedFields: readonly CatalogChangedField[];
  idempotency: CatalogIdempotencyDescriptor;
};

export type CatalogPlan = {
  version: typeof CATALOG_PLAN_VERSION;
  connectionId: string;
  provider: string;
  sourceRevision: string;
  action: CatalogAction;
  dryRun: boolean;
  readyToApply: boolean;
  formats: readonly CatalogFormat[];
  operations: readonly CatalogProductOperation[];
  productLabelsById: Readonly<Record<string, CatalogProductLabel>>;
  issues: readonly CatalogPlanIssue[];
  summary: {
    requestedWines: number;
    consideredVariants: number;
    create: number;
    update: number;
    unchanged: number;
    blocked: number;
  };
  idempotency: CatalogIdempotencyDescriptor;
};

export type CatalogApplyReceipt = {
  status: "applied" | "duplicate";
  appliedProductIds: readonly string[];
  providerRequestId?: string;
};

export type CatalogApplyPortResult =
  | { ok: true; receipt: CatalogApplyReceipt }
  | { ok: false; code: "APPLY_REJECTED" | "APPLY_UNAVAILABLE" | "APPLY_CONFLICT" };

export type CatalogContextPortResult =
  | { ok: true; context: CatalogPlanningContext }
  | { ok: false; code: "CONTEXT_NOT_FOUND" | "CONTEXT_UNAVAILABLE" | "CONTEXT_INVALID" };

export type CatalogHandlerPorts = {
  loadPlanningContext(request: CatalogRequest): Promise<CatalogContextPortResult>;
  applyPlan?: (input: {
    request: CatalogRequest;
    plan: CatalogPlan;
    idempotency: CatalogIdempotencyDescriptor;
  }) => Promise<CatalogApplyPortResult>;
};

export type CatalogHandlerErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED_ACTION"
  | "INVALID_CONNECTION_ID"
  | "INVALID_FORMAT"
  | "INVALID_WINE_SELECTION"
  | "CONTEXT_NOT_FOUND"
  | "CONTEXT_UNAVAILABLE"
  | "CONTEXT_INVALID"
  | "CATALOG_PLAN_BLOCKED"
  | "APPLY_PORT_NOT_CONFIGURED"
  | "APPLY_REJECTED"
  | "APPLY_UNAVAILABLE"
  | "APPLY_CONFLICT";

export type CatalogHandlerResult =
  | {
    ok: true;
    status: 200;
    mode: "preview" | "applied" | "duplicate";
    plan: CatalogPlan;
    receipt?: CatalogApplyReceipt;
  }
  | {
    ok: false;
    status: 400 | 404 | 409 | 422 | 503;
    error: {
      code: CatalogHandlerErrorCode;
      message: string;
    };
  };
