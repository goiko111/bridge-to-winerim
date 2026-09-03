import type { DatabaseAdapter } from "../../middleware-api/src/db";
import {
  createPostgresCatalogAdapter,
  type PostgresCatalogAdapterFactory,
  type PostgresCatalogAdapterOptions,
} from "../../middleware-runtime/src/adapters/catalog";
import type {
  HttpRequestPort,
  SecretTextPort,
} from "../../middleware-runtime/src/adapters/http";
import {
  isRuntimeEnvelope,
  type RuntimeEnvelopeV1,
  type RuntimeJob,
} from "../../middleware-runtime/src/contracts";
import { canonicalJson, sha256Hex } from "../../middleware-runtime/src/idempotency";
import type {
  RuntimeConnectionConfiguration,
  RuntimeConnectionConfigurationPort,
  RuntimeCredentialAccessPort,
} from "../../middleware-runtime/src/executor";
import {
  handleCatalogRequest,
  type CatalogApplyPortResult,
  type CatalogApplyReceipt,
  type CatalogPlan,
  type CatalogProductDesiredState,
} from "../../middleware-runtime/src/handlers/catalog";
import type { RuntimeExecutionResult } from "../../middleware-runtime/src/queue";
import type { RuntimeFailureDiagnosticInput } from "../../middleware-runtime/src/retry";
import { createAgoraOutboundTransport } from "./agoraOutboundTransport";
import type { AgoraMasterRefreshPort } from "./agoraMasterRefresh";

type BooleanSwitch = boolean | string | null | undefined;
type JsonRecord = Record<string, unknown>;
type CatalogApplyFailure = Extract<CatalogApplyPortResult, { ok: false }> & Readonly<{
  diagnostic?: RuntimeFailureDiagnosticInput;
}>;

const CATALOG_JOBS = Object.freeze([
  "catalog.fetch-winerim",
  "catalog.sync-master",
] as const satisfies readonly RuntimeJob[]);
const CATALOG_JOB_SET = new Set<RuntimeJob>(CATALOG_JOBS);

export const PRIVATE_CATALOG_SAFETY_CONTRACT = Object.freeze({
  enabledByDefault: false,
  queueClaim: "runtime_idempotency",
  planClaim: "runtime_idempotency/catalog.plan.db",
  deadLetter: "cloudflare-queue/max-attempts",
  applyIsSeparateGate: true,
  freshAgoraMasterBeforePlan: true,
  remoteReadbackBeforePersistence: true,
});

export type PrivateCatalogSwitches = Readonly<{
  executionEnabled?: BooleanSwitch;
  fetchEnabled?: BooleanSwitch;
  applyEnabled?: BooleanSwitch;
}>;

export type CatalogRefreshResult =
  | Readonly<{ ok: true; outcome: "complete" | "duplicate"; changed: number }>
  | Readonly<{
      ok: false;
      httpStatus: number;
      message: string;
      retryableLine?: boolean;
      diagnostic?: RuntimeFailureDiagnosticInput;
    }>;

/**
 * The current shared catalog adapter owns planning and atomic DB claims, but it
 * intentionally does not own the Winerim HTTP list/detail refresh. Keeping the
 * refresh behind this explicit port prevents a future worker integration from
 * silently treating a DB-only plan as a successful remote catalog fetch.
 */
export type WinerimCatalogRefreshPort = Readonly<{
  refresh(input: Readonly<{
    connectionId: string;
    messageId: string;
    idempotencyKey: string;
    dryRun: boolean;
    credential: SecretTextPort;
  }>): Promise<CatalogRefreshResult>;
}>;

/**
 * Concrete Agora transports must not return an `ok` receipt until they have
 * completed the remote mutation and read every planned product back with the
 * exact desired Name, ButtonText, FamilyId, prices and saleability flags. The
 * executor independently checks that the receipt covers exactly the planned
 * Product.Id set before allowing any DB persistence.
 */
export type AgoraCatalogReadbackReceipt = CatalogApplyReceipt & Readonly<{
  canonicalProductFingerprints: Readonly<Record<string, string>>;
}>;

export type AgoraCatalogApplyAndReadbackResult =
  | Readonly<{ ok: true; receipt: AgoraCatalogReadbackReceipt }>
  | CatalogApplyFailure;

export type AgoraCatalogApplyAndReadbackPort = Readonly<{
  applyAndReadback(input: Readonly<{
    connectionId: string;
    messageId: string;
    envelopeIdempotencyKey: string;
    plan: CatalogPlan;
    credential: SecretTextPort;
  }>): Promise<AgoraCatalogApplyAndReadbackResult>;
}>;

export type AgoraCatalogRenderableProductState = Omit<
  CatalogProductDesiredState,
  "useAsDirectSale" | "saleableAsMain"
> & Readonly<{
  useAsDirectSale: boolean;
  saleableAsMain: boolean;
}>;

export type AgoraCatalogXmlProfile = Readonly<{
  vatId: string;
  priceListIds: readonly string[];
  warehouseIds: readonly string[];
  alwaysIncludeVintage?: boolean;
  colorByFormat: Readonly<Record<AgoraCatalogRenderableProductState["format"], string>>;
  colorByProductId?: Readonly<Record<string, string>>;
  preparationTypeId: string;
  preparationOrderId: string;
  orderByProductId: Readonly<Record<string, string | number>>;
}>;

export type AgoraCatalogPlanTransportOptions = Readonly<{
  enabled?: BooleanSwitch;
  connectionId: string;
  baseUrl: string;
  allowedHosts: readonly string[];
  request: HttpRequestPort;
  profile: AgoraCatalogXmlProfile;
  timeoutMs?: number;
  maxResponseBytes?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}>;

export const AGORA_CATALOG_PLAN_TRANSPORT_SAFETY_CONTRACT = Object.freeze({
  enabledByDefault: false,
  oneProductPerMutation: true,
  exactXmlReadbackRequired: true,
  workerWiring: false,
});

export type PrivateCatalogCompositionOptions = Readonly<{
  allowedConnectionId: string;
  switches?: PrivateCatalogSwitches;
  database: DatabaseAdapter;
  connections: RuntimeConnectionConfigurationPort;
  credentials: RuntimeCredentialAccessPort;
  adapterOptions?: PostgresCatalogAdapterOptions;
  adapterFactory?: PostgresCatalogAdapterFactory;
  refresh?: WinerimCatalogRefreshPort;
  agoraMasterRefresh?: AgoraMasterRefreshPort;
  agoraApply?: AgoraCatalogApplyAndReadbackPort;
}>;

export type PrivateCatalogLaneExecutor = Readonly<{
  execute(envelope: RuntimeEnvelopeV1): Promise<RuntimeExecutionResult>;
}>;

function enabled(value: BooleanSwitch): boolean {
  return value === true || String(value ?? "").trim().toLowerCase() === "true";
}

function failure(
  httpStatus: number,
  message: string,
  retryableLine = false,
  diagnostic?: RuntimeFailureDiagnosticInput,
): RuntimeExecutionResult {
  return {
    ok: false,
    failure: {
      httpStatus,
      message,
      ...(retryableLine ? { retryableLine: true } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    },
  };
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function dryRunRequested(envelope: RuntimeEnvelopeV1): boolean {
  return record(envelope.payload).dryRun === true;
}

function validConnection(
  envelope: RuntimeEnvelopeV1,
  connection: RuntimeConnectionConfiguration | null,
): connection is RuntimeConnectionConfiguration {
  return !!connection
    && connection.connectionId === envelope.connectionId
    && connection.provider.trim().toLowerCase() === "agora"
    && connection.enabled === true;
}

async function scopedConnection(
  envelope: RuntimeEnvelopeV1,
  options: PrivateCatalogCompositionOptions,
): Promise<RuntimeConnectionConfiguration | RuntimeExecutionResult> {
  if (envelope.connectionId !== options.allowedConnectionId.trim()) {
    return failure(422, "CATALOG_CONNECTION_REJECTED");
  }
  let connection: RuntimeConnectionConfiguration | null;
  try {
    connection = await options.connections.load(envelope.connectionId);
  } catch {
    return failure(503, "CATALOG_CONNECTION_UNAVAILABLE");
  }
  return validConnection(envelope, connection)
    ? connection
    : failure(422, "CATALOG_CONNECTION_SCOPE_REJECTED");
}

function isFailure(value: RuntimeConnectionConfiguration | RuntimeExecutionResult): value is RuntimeExecutionResult {
  return "ok" in value;
}

async function credential(
  envelope: RuntimeEnvelopeV1,
  connection: RuntimeConnectionConfiguration,
  options: PrivateCatalogCompositionOptions,
  kind: "agora" | "winerim",
): Promise<SecretTextPort | null> {
  try {
    const opened = await options.credentials.open({
      connectionId: envelope.connectionId,
      provider: connection.provider,
      kind,
    });
    return opened && typeof opened.read === "function" ? opened : null;
  } catch {
    return null;
  }
}

function selectionPayload(payload: JsonRecord): Record<string, unknown> {
  const formatTypes = payload.formatTypes ?? payload.formats;
  const winerimWineIds = payload.winerimWineIds ?? payload.wineIds;
  return {
    ...(formatTypes === undefined ? {} : { formatTypes }),
    ...(winerimWineIds === undefined ? {} : { winerimWineIds }),
  };
}

function catalogDiagnostic(
  stage: string,
  errorCode: string,
  detail?: string,
  httpStatus?: number,
): RuntimeFailureDiagnosticInput {
  return {
    operation: "catalog.apply",
    route: `catalog.${stage}`,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    errorCode,
    ...(detail ? { bodySample: detail } : {}),
  };
}

const MAX_CATALOG_OPERATIONS_PER_JOB = 3;

async function boundedOperationPlans(
  plan: CatalogPlan,
): Promise<readonly CatalogPlan[]> {
  const operations = plan.operations
    .filter((candidate) => candidate.kind !== "unchanged")
    .slice(0, MAX_CATALOG_OPERATIONS_PER_JOB);
  return Promise.all(operations.map(async (operation) => {
    const state = {
      parentPlan: plan.idempotency.fingerprint,
      operation: operation.idempotency.fingerprint,
      productId: operation.desired.productId,
    };
    const fingerprint = await sha256Hex(canonicalJson({
      version: 1,
      scope: "catalog-plan-single",
      connectionId: plan.connectionId,
      provider: plan.provider,
      sourceRevision: plan.sourceRevision,
      state,
    }));
    return {
      ...plan,
      operations: [operation],
      formats: [operation.desired.format],
      productLabelsById: {
        [operation.desired.productId]: operation.desired.label,
      },
      summary: {
        requestedWines: 1,
        consideredVariants: 1,
        create: operation.kind === "create" ? 1 : 0,
        update: operation.kind === "update" ? 1 : 0,
        unchanged: 0,
        blocked: 0,
      },
      idempotency: {
        version: plan.idempotency.version,
        scope: "catalog-plan" as const,
        key: `catalog-plan-single:${operation.idempotency.key}`,
        fingerprint,
        connectionId: plan.connectionId,
        provider: plan.provider,
        sourceRevision: plan.sourceRevision,
      },
    };
  }));
}

export async function catalogProductCanonicalFingerprint(
  product: AgoraCatalogRenderableProductState,
): Promise<string> {
  return sha256Hex(canonicalJson({
    version: 1,
    productId: product.productId,
    ...(product.baseSaleFormatId ? { baseSaleFormatId: product.baseSaleFormatId } : {}),
    name: product.label.name,
    buttonText: product.label.buttonText,
    familyId: product.family.id,
    salePrice: product.salePrice,
    costPrice: product.costPrice,
    useAsDirectSale: product.useAsDirectSale,
    saleableAsMain: product.saleableAsMain,
  }));
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function exactAgoraId(value: unknown, code: string): string {
  const id = String(value ?? "").trim();
  if (!/^\d+$/.test(id)) throw new Error(code);
  return id;
}

function exactAgoraIds(values: readonly string[], code: string): string[] {
  const ids = values.map((value) => exactAgoraId(value, code));
  if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error(code);
  return ids;
}

function exactText(value: unknown, code: string, allowEmpty = false): string {
  const text = String(value ?? "").trim();
  if ((!allowEmpty && !text) || /[\0\r\n]/.test(text)) throw new Error(code);
  return text;
}

function exactMoney(value: number, code: string, allowZero: boolean): string {
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) throw new Error(code);
  return value.toFixed(2);
}

/**
 * Render only the product shape represented by the catalog plan. Agora fields
 * that cannot be inferred safely (VAT, price lists, warehouses, preparation,
 * colour and order) are mandatory profile inputs rather than guessed defaults.
 */
export function renderAgoraCatalogProductXml(
  product: AgoraCatalogRenderableProductState,
  profile: AgoraCatalogXmlProfile,
): string {
  const productId = exactAgoraId(product.productId, "AGORA_CATALOG_PRODUCT_ID_INVALID");
  const baseSaleFormat = product.baseSaleFormatId
    ? ` BaseSaleFormatId="${exactAgoraId(product.baseSaleFormatId, "AGORA_CATALOG_BASE_SALE_FORMAT_ID_INVALID")}"`
    : "";
  exactAgoraId(product.winerimId, "AGORA_CATALOG_WINERIM_ID_INVALID");
  const familyId = exactAgoraId(product.family.id, "AGORA_CATALOG_FAMILY_ID_INVALID");
  const vatId = exactAgoraId(profile.vatId, "AGORA_CATALOG_VAT_ID_INVALID");
  const priceListIds = exactAgoraIds(profile.priceListIds, "AGORA_CATALOG_PRICE_LIST_IDS_INVALID");
  const warehouseIds = exactAgoraIds(profile.warehouseIds, "AGORA_CATALOG_WAREHOUSE_IDS_INVALID");
  const configuredOrder = profile.orderByProductId[productId];
  const order = configuredOrder === undefined || String(configuredOrder).trim() === ""
    ? productId
    : exactAgoraId(configuredOrder, "AGORA_CATALOG_ORDER_INVALID");
  const name = exactText(product.label.name, "AGORA_CATALOG_NAME_INVALID");
  const buttonText = exactText(product.label.buttonText, "AGORA_CATALOG_BUTTON_TEXT_INVALID");
  if (buttonText.length > 20) throw new Error("AGORA_CATALOG_BUTTON_TEXT_INVALID");
  exactText(product.family.name, "AGORA_CATALOG_FAMILY_NAME_INVALID");
  const color = exactText(
    profile.colorByProductId?.[productId] ?? profile.colorByFormat[product.format],
    "AGORA_CATALOG_COLOR_INVALID",
  );
  const preparationTypeId = exactText(
    profile.preparationTypeId,
    "AGORA_CATALOG_PREPARATION_TYPE_INVALID",
    true,
  );
  const preparationOrderId = exactText(
    profile.preparationOrderId,
    "AGORA_CATALOG_PREPARATION_ORDER_INVALID",
    true,
  );
  const salePrice = exactMoney(product.salePrice, "AGORA_CATALOG_SALE_PRICE_INVALID", false);
  const costPrice = exactMoney(product.costPrice, "AGORA_CATALOG_COST_PRICE_INVALID", true);
  if (typeof product.useAsDirectSale !== "boolean" || typeof product.saleableAsMain !== "boolean") {
    throw new Error("AGORA_CATALOG_SALEABILITY_INVALID");
  }

  const prices = priceListIds.map((priceListId) =>
    `        <Price PriceListId="${priceListId}" MainPrice="${salePrice}" AddinPrice="0.00" MenuItemPrice="0.00" />`
  ).join("\n");
  const costs = warehouseIds.map((warehouseId) =>
    `        <CostPrice WarehouseId="${warehouseId}" CostPrice="${costPrice}" />`
  ).join("\n");

  return `    <Product Order="${order}" Id="${productId}"${baseSaleFormat} Name="${escapeXmlAttribute(name)}" ButtonText="${escapeXmlAttribute(buttonText)}" Color="${escapeXmlAttribute(color)}" PLU="" FamilyId="${familyId}" VatId="${vatId}" UseAsDirectSale="${product.useAsDirectSale}" SaleableAsMain="${product.saleableAsMain}" SaleableAsAddin="false" IsSoldByWeight="false" AskForPreparationNotes="false" AskForAddins="false" PrintWhenPriceIsZero="false" PreparationTypeId="${escapeXmlAttribute(preparationTypeId)}" PreparationOrderId="${escapeXmlAttribute(preparationOrderId)}" CostPrice="${costPrice}">
      <Prices>
${prices}
      </Prices>
      <CostPrices>
${costs}
      </CostPrices>
    </Product>`;
}

function catalogTransportFailure(
  result: Awaited<ReturnType<ReturnType<typeof createAgoraOutboundTransport>["execute"]>>,
): CatalogApplyFailure {
  if (result.kind === "failure") {
    const status = result.failure.httpStatus;
    const diagnostic = result.failure.diagnostic ?? catalogDiagnostic(
      "remote-transport",
      result.failure.message,
      undefined,
      status,
    );
    if (status === 409) return { ok: false, code: "APPLY_CONFLICT", diagnostic };
    return status !== undefined && [400, 401, 403, 404, 422].includes(status)
      ? { ok: false, code: "APPLY_REJECTED", diagnostic }
      : { ok: false, code: "APPLY_UNAVAILABLE", diagnostic };
  }
  const diagnostic = catalogDiagnostic(
    result.kind === "blocked" ? "remote-readback" : "remote-transport",
    result.kind === "blocked" ? result.reason : "AGORA_CATALOG_APPLY_NOT_SUCCESS",
    result.kind === "blocked" ? result.detail : undefined,
  );
  return result.kind === "blocked" && [
    "AGORA_READBACK_MISMATCH",
    "AGORA_PRECONDITION_DRIFT",
  ].includes(result.reason)
    ? { ok: false, code: "APPLY_CONFLICT", diagnostic }
    : { ok: false, code: "APPLY_REJECTED", diagnostic };
}

export function createAgoraCatalogPlanApplyAndReadbackPort(
  options: AgoraCatalogPlanTransportOptions,
): AgoraCatalogApplyAndReadbackPort {
  return Object.freeze({
    async applyAndReadback(input): Promise<AgoraCatalogApplyAndReadbackResult> {
      if (!enabled(options.enabled)) {
        return { ok: false, code: "APPLY_REJECTED", diagnostic: catalogDiagnostic("precondition", "AGORA_CATALOG_APPLY_DISABLED") };
      }
      if (!input.connectionId.trim() || input.connectionId !== options.connectionId.trim() ||
          input.plan.connectionId !== input.connectionId || input.plan.provider.trim().toLowerCase() !== "agora" ||
          input.plan.dryRun || !input.plan.readyToApply || input.plan.issues.some((issue) => issue.severity === "error") ||
          input.plan.operations.length !== 1 || !input.messageId.trim() || !input.envelopeIdempotencyKey.trim()) {
        return { ok: false, code: "APPLY_REJECTED", diagnostic: catalogDiagnostic("precondition", "AGORA_CATALOG_APPLY_PRECONDITION_REJECTED") };
      }

      const [operation] = input.plan.operations;
      let productXml: string;
      let fingerprint: string;
      try {
        productXml = renderAgoraCatalogProductXml(operation.desired, options.profile);
        fingerprint = await catalogProductCanonicalFingerprint(operation.desired);
      } catch (error) {
        return {
          ok: false,
          code: "APPLY_REJECTED",
          diagnostic: catalogDiagnostic("render", error instanceof Error ? error.message : "AGORA_CATALOG_RENDER_REJECTED"),
        };
      }

      let idempotencyKey: string;
      try {
        idempotencyKey = exactText(
          operation.idempotency.key,
          "AGORA_CATALOG_IDEMPOTENCY_KEY_INVALID",
        );
      } catch (error) {
        return {
          ok: false,
          code: "APPLY_REJECTED",
          diagnostic: catalogDiagnostic("idempotency", error instanceof Error ? error.message : "AGORA_CATALOG_IDEMPOTENCY_REJECTED"),
        };
      }
      const transport = createAgoraOutboundTransport({
        connectionId: options.connectionId,
        baseUrl: options.baseUrl,
        allowedHosts: options.allowedHosts,
        credential: input.credential,
        request: options.request,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      });
      const result = await transport.execute({
        task: {
          id: input.messageId,
          connectionId: input.connectionId,
          provider: "agora",
          taskType: "AGORA_XML_UPSERT_PRODUCT",
          payload: {
            _import_xml: `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n  <Products>\n${productXml}\n  </Products>\n</Import>`,
            _expected_product_ids: [operation.desired.productId],
            _catalog_plan_key: input.plan.idempotency.key,
            _catalog_product_fingerprint: fingerprint,
            _envelope_idempotency_key: input.envelopeIdempotencyKey,
          },
          status: "RUNNING",
          attempts: 1,
          maxAttempts: 1,
          createdAt: new Date().toISOString(),
          idempotencyKey,
          externalId: operation.desired.productId,
        },
        context: { idempotencyKey, attempt: 1, maxAttempts: 1 },
      });

      if (result.kind !== "success" && result.kind !== "superseded") {
        return catalogTransportFailure(result);
      }
      return {
        ok: true,
        receipt: {
          status: result.kind === "success" ? "applied" : "duplicate",
          appliedProductIds: [operation.desired.productId],
          canonicalProductFingerprints: { [operation.desired.productId]: fingerprint },
        },
      };
    },
  });
}

function exactProductIds(
  receipt: CatalogApplyReceipt,
  plan: CatalogPlan,
): boolean {
  const expected = plan.operations
    .map((operation) => operation.desired.productId)
    .sort((left, right) => Number(left) - Number(right));
  const observed = [...new Set(receipt.appliedProductIds.map((productId) => String(productId).trim()))]
    .filter(Boolean)
    .sort((left, right) => Number(left) - Number(right));
  return observed.length === expected.length
    && observed.every((productId, index) => productId === expected[index]);
}

async function exactProductReadback(
  receipt: AgoraCatalogReadbackReceipt,
  plan: CatalogPlan,
): Promise<boolean> {
  if (!exactProductIds(receipt, plan)) return false;
  const observedEntries = Object.entries(receipt.canonicalProductFingerprints)
    .map(([productId, fingerprint]) => [String(productId).trim(), String(fingerprint).trim()] as const)
    .filter(([productId, fingerprint]) => productId && fingerprint)
    .sort(([left], [right]) => Number(left) - Number(right));
  if (observedEntries.length !== plan.operations.length ||
      new Set(observedEntries.map(([productId]) => productId)).size !== observedEntries.length) {
    return false;
  }
  const expectedEntries = await Promise.all(plan.operations.map(async (operation) => [
    operation.desired.productId,
    await catalogProductCanonicalFingerprint(operation.desired),
  ] as const));
  expectedEntries.sort(([left], [right]) => Number(left) - Number(right));
  return observedEntries.every(([productId, fingerprint], index) =>
    productId === expectedEntries[index]?.[0] && fingerprint === expectedEntries[index]?.[1]
  );
}

async function executeRefresh(
  envelope: RuntimeEnvelopeV1,
  connection: RuntimeConnectionConfiguration,
  options: PrivateCatalogCompositionOptions,
): Promise<RuntimeExecutionResult> {
  if (!enabled(options.switches?.fetchEnabled)) return failure(503, "CATALOG_FETCH_DISABLED");
  if (!options.refresh) return failure(503, "CATALOG_FETCH_PORT_NOT_CONFIGURED");
  const winerim = await credential(envelope, connection, options, "winerim");
  if (!winerim) return failure(503, "CATALOG_WINERIM_CREDENTIAL_UNAVAILABLE");

  let result: CatalogRefreshResult;
  try {
    result = await options.refresh.refresh({
      connectionId: envelope.connectionId,
      messageId: envelope.messageId,
      idempotencyKey: envelope.idempotencyKey,
      dryRun: dryRunRequested(envelope),
      credential: winerim,
    });
  } catch {
    return failure(503, "CATALOG_FETCH_UNAVAILABLE");
  }
  const changed = result.ok && Number.isFinite(result.changed)
    ? Math.max(0, Math.floor(result.changed))
    : 0;
  return result.ok
    ? { ok: true, detail: `catalog:fetch:${result.outcome}:${changed}` }
    : failure(
      result.httpStatus,
      [400, 401, 403, 404, 409, 422].includes(result.httpStatus)
        ? "CATALOG_FETCH_REJECTED"
        : "CATALOG_FETCH_UNAVAILABLE",
      result.retryableLine === true,
      result.diagnostic,
    );
}

async function executePlan(
  envelope: RuntimeEnvelopeV1,
  connection: RuntimeConnectionConfiguration,
  options: PrivateCatalogCompositionOptions,
): Promise<RuntimeExecutionResult> {
  const payload = record(envelope.payload);
  const dryRun = dryRunRequested(envelope);
  const remoteApply = options.agoraApply;
  if (!dryRun && !enabled(options.switches?.applyEnabled)) {
    return failure(503, "CATALOG_APPLY_DISABLED");
  }
  if (!dryRun && !remoteApply) {
    return failure(503, "CATALOG_AGORA_APPLY_PORT_NOT_CONFIGURED");
  }
  if (!dryRun && !options.agoraMasterRefresh) {
    return failure(503, "CATALOG_AGORA_MASTER_REFRESH_PORT_NOT_CONFIGURED");
  }

  let agora: SecretTextPort | null = null;
  if (!dryRun) {
    agora = await credential(envelope, connection, options, "agora");
    if (!agora) return failure(503, "CATALOG_AGORA_CREDENTIAL_UNAVAILABLE");
    const refreshed = await options.agoraMasterRefresh!.refresh({
      connectionId: envelope.connectionId,
      credential: agora,
    });
    if (!refreshed.ok) {
      return failure(
        refreshed.httpStatus,
        "CATALOG_AGORA_MASTER_REFRESH_FAILED",
        refreshed.retryableLine === true,
        refreshed.diagnostic,
      );
    }
  }

  const adapterFactory = options.adapterFactory ?? createPostgresCatalogAdapter;
  const adapter = adapterFactory(options.database, options.adapterOptions);
  let applyDiagnostic: RuntimeFailureDiagnosticInput | undefined;
  const result = await handleCatalogRequest({
    action: dryRun ? "catalog.preview" : "catalog.apply",
    connectionId: envelope.connectionId,
    dryRun,
    ...selectionPayload(payload),
  }, {
    loadPlanningContext: adapter.loadPlanningContext,
    ...(!dryRun && enabled(options.switches?.applyEnabled)
      ? {
        applyPlan: async (input): Promise<CatalogApplyPortResult> => {
          if (!remoteApply || !agora) {
            applyDiagnostic = catalogDiagnostic("precondition", "CATALOG_APPLY_PORT_UNAVAILABLE");
            return { ok: false, code: "APPLY_UNAVAILABLE" };
          }
          const boundedPlans = await boundedOperationPlans(input.plan);
          if (boundedPlans.length === 0) {
            return {
              ok: true,
              receipt: {
                status: "duplicate",
                appliedProductIds: [],
              },
            };
          }
          const appliedProductIds: string[] = [];
          let applied = false;
          for (const boundedPlan of boundedPlans) {
            let remote: AgoraCatalogApplyAndReadbackResult;
            try {
              remote = await remoteApply.applyAndReadback({
                connectionId: envelope.connectionId,
                messageId: envelope.messageId,
                envelopeIdempotencyKey: envelope.idempotencyKey,
                plan: boundedPlan,
                credential: agora,
              });
            } catch (error) {
              applyDiagnostic = catalogDiagnostic(
                "remote-apply",
                error instanceof Error ? error.name : "CATALOG_REMOTE_APPLY_THROWN",
              );
              return { ok: false, code: "APPLY_UNAVAILABLE" };
            }
            if (!remote.ok || !await exactProductReadback(remote.receipt, boundedPlan)) {
              applyDiagnostic = remote.ok
                ? catalogDiagnostic("remote-readback", "CATALOG_REMOTE_READBACK_FINGERPRINT_MISMATCH")
                : remote.diagnostic;
              return remote.ok
                ? { ok: false, code: "APPLY_CONFLICT" }
                : remote;
            }

            let persisted: CatalogApplyPortResult;
            try {
              persisted = await adapter.applyPlan({
                ...input,
                plan: boundedPlan,
                idempotency: boundedPlan.idempotency,
              });
            } catch (error) {
              applyDiagnostic = catalogDiagnostic(
                "persist",
                error instanceof Error ? error.name : "CATALOG_PERSIST_THROWN",
              );
              return { ok: false, code: "APPLY_UNAVAILABLE" };
            }
            if (!persisted.ok || !exactProductIds(persisted.receipt, boundedPlan)) {
              applyDiagnostic = persisted.ok
                ? catalogDiagnostic("persist-readback", "CATALOG_PERSIST_RECEIPT_MISMATCH")
                : catalogDiagnostic(
                  "persist",
                  persisted.diagnosticCode || `CATALOG_${persisted.code}`,
                );
              return persisted.ok
                ? { ok: false, code: "APPLY_CONFLICT" }
                : persisted;
            }
            appliedProductIds.push(...remote.receipt.appliedProductIds);
            applied ||= remote.receipt.status === "applied";
          }
          return {
            ok: true,
            receipt: {
              status: applied ? "applied" : "duplicate",
              appliedProductIds,
            },
          };
        },
      }
      : {}),
  });

  if (!result.ok) return failure(result.status, `CATALOG_${result.error.code}`, false, applyDiagnostic);
  return {
    ok: true,
    detail: `catalog:${result.mode}:${result.plan.operations.length}:${result.plan.idempotency.key}`,
  };
}

export function privateCatalogEnabledJobs(
  switches: PrivateCatalogSwitches | undefined,
): readonly RuntimeJob[] {
  if (!enabled(switches?.executionEnabled)) return [];
  return CATALOG_JOBS.filter((job) =>
    job === "catalog.fetch-winerim" ? enabled(switches?.fetchEnabled) : true
  );
}

export function createPrivateCatalogLaneExecutor(
  options: PrivateCatalogCompositionOptions,
): PrivateCatalogLaneExecutor {
  return Object.freeze({
    async execute(envelope): Promise<RuntimeExecutionResult> {
      if (!isRuntimeEnvelope(envelope) || !CATALOG_JOB_SET.has(envelope.job)) {
        return failure(422, "CATALOG_ENVELOPE_REJECTED");
      }
      if (!enabled(options.switches?.executionEnabled)) return failure(503, "CATALOG_EXECUTION_DISABLED");

      const connection = await scopedConnection(envelope, options);
      if (isFailure(connection)) return connection;
      return envelope.job === "catalog.fetch-winerim"
        ? executeRefresh(envelope, connection, options)
        : executePlan(envelope, connection, options);
    },
  });
}
