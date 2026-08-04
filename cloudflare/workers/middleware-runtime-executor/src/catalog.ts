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
import { createAgoraOutboundTransport } from "./agoraOutboundTransport";
import type { CatalogChangeQueuePort } from "./catalogChanges";

type BooleanSwitch = boolean | string | null | undefined;
type JsonRecord = Record<string, unknown>;

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
  | Extract<CatalogApplyPortResult, { ok: false }>;

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
  colorByFormat: Readonly<Record<AgoraCatalogRenderableProductState["format"], string>>;
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
  agoraApply?: AgoraCatalogApplyAndReadbackPort;
  changes?: CatalogChangeQueuePort;
  maxChangesPerRun?: number;
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
): RuntimeExecutionResult {
  return {
    ok: false,
    failure: {
      httpStatus,
      message,
      ...(retryableLine ? { retryableLine: true } : {}),
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

export async function catalogProductCanonicalFingerprint(
  product: AgoraCatalogRenderableProductState,
): Promise<string> {
  return sha256Hex(canonicalJson({
    version: 1,
    productId: product.productId,
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
  exactAgoraId(product.winerimId, "AGORA_CATALOG_WINERIM_ID_INVALID");
  const familyId = exactAgoraId(product.family.id, "AGORA_CATALOG_FAMILY_ID_INVALID");
  const vatId = exactAgoraId(profile.vatId, "AGORA_CATALOG_VAT_ID_INVALID");
  const priceListIds = exactAgoraIds(profile.priceListIds, "AGORA_CATALOG_PRICE_LIST_IDS_INVALID");
  const warehouseIds = exactAgoraIds(profile.warehouseIds, "AGORA_CATALOG_WAREHOUSE_IDS_INVALID");
  const order = exactAgoraId(profile.orderByProductId[productId], "AGORA_CATALOG_ORDER_INVALID");
  const name = exactText(product.label.name, "AGORA_CATALOG_NAME_INVALID");
  const buttonText = exactText(product.label.buttonText, "AGORA_CATALOG_BUTTON_TEXT_INVALID");
  if (buttonText.length > 20) throw new Error("AGORA_CATALOG_BUTTON_TEXT_INVALID");
  exactText(product.family.name, "AGORA_CATALOG_FAMILY_NAME_INVALID");
  const color = exactText(profile.colorByFormat[product.format], "AGORA_CATALOG_COLOR_INVALID");
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

  return `    <Product Order="${order}" Id="${productId}" Name="${escapeXmlAttribute(name)}" ButtonText="${escapeXmlAttribute(buttonText)}" Color="${escapeXmlAttribute(color)}" PLU="" FamilyId="${familyId}" VatId="${vatId}" UseAsDirectSale="${product.useAsDirectSale}" SaleableAsMain="${product.saleableAsMain}" SaleableAsAddin="false" IsSoldByWeight="false" AskForPreparationNotes="false" AskForAddins="false" PrintWhenPriceIsZero="false" PreparationTypeId="${escapeXmlAttribute(preparationTypeId)}" PreparationOrderId="${escapeXmlAttribute(preparationOrderId)}" CostPrice="${costPrice}">
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
): Extract<CatalogApplyPortResult, { ok: false }> {
  if (result.kind === "failure") {
    const status = result.failure.httpStatus;
    if (status === 409) return { ok: false, code: "APPLY_CONFLICT" };
    return status !== undefined && [400, 401, 403, 404, 422].includes(status)
      ? { ok: false, code: "APPLY_REJECTED" }
      : { ok: false, code: "APPLY_UNAVAILABLE" };
  }
  return result.kind === "blocked" && [
    "AGORA_READBACK_MISMATCH",
    "AGORA_PRECONDITION_DRIFT",
  ].includes(result.reason)
    ? { ok: false, code: "APPLY_CONFLICT" }
    : { ok: false, code: "APPLY_REJECTED" };
}

export function createAgoraCatalogPlanApplyAndReadbackPort(
  options: AgoraCatalogPlanTransportOptions,
): AgoraCatalogApplyAndReadbackPort {
  return Object.freeze({
    async applyAndReadback(input): Promise<AgoraCatalogApplyAndReadbackResult> {
      if (!enabled(options.enabled)) return { ok: false, code: "APPLY_REJECTED" };
      if (!input.connectionId.trim() || input.connectionId !== options.connectionId.trim() ||
          input.plan.connectionId !== input.connectionId || input.plan.provider.trim().toLowerCase() !== "agora" ||
          input.plan.dryRun || !input.plan.readyToApply || input.plan.issues.some((issue) => issue.severity === "error") ||
          input.plan.operations.length !== 1 || !input.messageId.trim() || !input.envelopeIdempotencyKey.trim()) {
        return { ok: false, code: "APPLY_REJECTED" };
      }

      const [operation] = input.plan.operations;
      let productXml: string;
      let fingerprint: string;
      try {
        productXml = renderAgoraCatalogProductXml(operation.desired, options.profile);
        fingerprint = await catalogProductCanonicalFingerprint(operation.desired);
      } catch {
        return { ok: false, code: "APPLY_REJECTED" };
      }

      let idempotencyKey: string;
      try {
        idempotencyKey = exactText(
          operation.idempotency.key,
          "AGORA_CATALOG_IDEMPOTENCY_KEY_INVALID",
        );
      } catch {
        return { ok: false, code: "APPLY_REJECTED" };
      }
      const transport = createAgoraOutboundTransport({
        connectionId: options.connectionId,
        baseUrl: options.baseUrl,
        allowedHosts: options.allowedHosts,
        credential: input.credential,
        request: options.request,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
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

  let agora: SecretTextPort | null = null;
  if (!dryRun) {
    agora = await credential(envelope, connection, options, "agora");
    if (!agora) return failure(503, "CATALOG_AGORA_CREDENTIAL_UNAVAILABLE");
  }

  const adapterFactory = options.adapterFactory ?? createPostgresCatalogAdapter;
  const adapter = adapterFactory(options.database, options.adapterOptions);
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
          if (!remoteApply || !agora) return { ok: false, code: "APPLY_UNAVAILABLE" };
          if (input.plan.operations.length !== 1) return { ok: false, code: "APPLY_REJECTED" };
          let remote: AgoraCatalogApplyAndReadbackResult;
          try {
            remote = await remoteApply.applyAndReadback({
              connectionId: envelope.connectionId,
              messageId: envelope.messageId,
              envelopeIdempotencyKey: envelope.idempotencyKey,
              plan: input.plan,
              credential: agora,
            });
          } catch {
            return { ok: false, code: "APPLY_UNAVAILABLE" };
          }
          if (!remote.ok || !await exactProductReadback(remote.receipt, input.plan)) {
            return remote.ok
              ? { ok: false, code: "APPLY_CONFLICT" }
              : remote;
          }

          let persisted: CatalogApplyPortResult;
          try {
            persisted = await adapter.applyPlan(input);
          } catch {
            return { ok: false, code: "APPLY_UNAVAILABLE" };
          }
          if (!persisted.ok || !exactProductIds(persisted.receipt, input.plan)) {
            return persisted.ok
              ? { ok: false, code: "APPLY_CONFLICT" }
              : persisted;
          }
          return remote;
        },
      }
      : {}),
  });

  if (!result.ok) return failure(result.status, `CATALOG_${result.error.code}`);
  return {
    ok: true,
    detail: `catalog:${result.mode}:${result.plan.operations.length}:${result.plan.idempotency.key}`,
  };
}

function explicitSelection(payload: JsonRecord): boolean {
  return payload.winerimWineIds !== undefined
    || payload.wineIds !== undefined
    || payload.formatTypes !== undefined
    || payload.formats !== undefined;
}

function changeLimit(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(10, parsed)) : 5;
}

async function executePendingChanges(
  envelope: RuntimeEnvelopeV1,
  connection: RuntimeConnectionConfiguration,
  options: PrivateCatalogCompositionOptions,
): Promise<RuntimeExecutionResult> {
  if (!options.changes) return failure(503, "CATALOG_CHANGE_QUEUE_NOT_CONFIGURED");
  const dryRun = dryRunRequested(envelope);
  const input = {
    connectionId: envelope.connectionId,
    limit: changeLimit(options.maxChangesPerRun),
  };
  let claimed;
  try {
    claimed = dryRun
      ? await options.changes.peek(input)
      : await options.changes.claim(input);
  } catch {
    return failure(503, "CATALOG_CHANGE_QUEUE_UNAVAILABLE");
  }
  if (claimed.length === 0) return { ok: true, detail: "catalog:queue:idle:0" };

  let completed = 0;
  let blocked = 0;
  let retry = 0;
  for (const change of claimed) {
    const selectedEnvelope: RuntimeEnvelopeV1 = {
      ...envelope,
      payload: {
        dryRun,
        winerimWineIds: [change.winerimWineId],
        formatTypes: [change.format],
      },
    };
    const result = await executePlan(selectedEnvelope, connection, options);
    if (dryRun) {
      if (result.ok) completed++;
      else blocked++;
      continue;
    }
    const decision = result.ok
      ? { status: "SUCCESS" as const }
      : [400, 401, 403, 404, 422].includes(result.failure.httpStatus)
        ? { status: "BLOCKED" as const, error: result.failure.message }
        : { status: "PENDING" as const, retryAfterSeconds: 300, error: result.failure.message };
    let settled: boolean;
    try {
      settled = await options.changes.settle(change, decision);
    } catch {
      return failure(503, "CATALOG_CHANGE_SETTLEMENT_UNAVAILABLE", true);
    }
    if (!settled) return failure(409, "CATALOG_CHANGE_SUPERSEDED", true);
    if (decision.status === "SUCCESS") completed++;
    else if (decision.status === "BLOCKED") blocked++;
    else retry++;
  }
  if (retry > 0) return failure(503, "CATALOG_CHANGE_RETRY_PENDING", true);
  return {
    ok: true,
    detail: `catalog:queue:${dryRun ? "preview" : "complete"}:${completed}:blocked=${blocked}`,
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
        : explicitSelection(record(envelope.payload))
          ? executePlan(envelope, connection, options)
          : executePendingChanges(envelope, connection, options);
    },
  });
}
