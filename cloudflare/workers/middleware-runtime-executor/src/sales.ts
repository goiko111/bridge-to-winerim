import {
  sql,
  type DatabaseAdapter,
  type DatabaseTransaction,
} from "../../middleware-api/src/db";
import {
  createAgoraReadOnlyClient,
  createSafeHttpClient,
  createWinerimMutationTransport,
  type SecretTextPort,
} from "../../middleware-runtime/src/adapters/http";
import { createPostgresSalesAdapter } from "../../middleware-runtime/src/adapters/sales";
import type { ProviderProductSalesClassification } from "../../middleware-runtime/src/adapters/sales";
import { createPostgresStockAdapter } from "../../middleware-runtime/src/adapters/stock";
import type { RuntimeEnvelopeV1 } from "../../middleware-runtime/src/contracts";
import {
  executeSalesPlan,
  parseOpenTicketPayload,
  planSalesRun,
  type ProviderSalesDocument,
  type ProviderSalesLine,
  type SalesExecutionPorts,
  type SalesImportCommand,
  type SalesImportResult,
  type SalesLineClassification,
  type SalesLineResolution,
  type SalesPlan,
  type SalesRunKind,
  type SalesVariant,
  type StockApplyCommand,
  type StockApplyResult,
} from "../../middleware-runtime/src/handlers/sales";
import type {
  WinerimMutationExecutionResult,
  WinerimMutationTransport,
  WinerimStockIdentity,
} from "../../middleware-runtime/src/handlers/stock";
import { executeWinerimMutationPlan } from "../../middleware-runtime/src/handlers/stock";
import type { RuntimeExecutionResult } from "../../middleware-runtime/src/queue";
import {
  buildAgoraInvoiceDocId,
  isAgoraDocumentWithinBusinessDay,
  isAgoraRefundDocument,
  normalizeAgoraLineFormat,
} from "../../../../supabase/functions/_shared/agoraSales";
import {
  findStockForVariant,
  parseWinerimStockRows,
  type WinerimVariant,
} from "../../../../supabase/functions/_shared/stockSyncUtils";

type JsonRecord = Record<string, unknown>;

const SALES_JOBS = new Set<RuntimeEnvelopeV1["job"]>([
  "sales.auto-sync",
  "sales.sync-intraday",
  "sales.sync-open-tickets",
]);
const DEFAULT_TIME_ZONE = "Europe/Madrid";
const DEFAULT_MAX_CLOSED_DAYS_PER_RUN = 2;
const MAX_CLOSED_DAYS_PER_RUN = 7;
const WINERIM_STOCK_READ_TIMEOUT_MS = 10_000;
const WINERIM_STOCK_READ_MAX_BYTES = 2 * 1024 * 1024;

export type SalesLaneFlags = Readonly<{
  executionEnabled: boolean;
  cursorEnabled: boolean;
  dlqReady: boolean;
}>;

export type SalesLaneConnection = Readonly<{
  connectionId: string;
  provider: string;
  baseUrl: string;
  enabled: boolean;
  lastBusinessDaySynced: string | null;
  providerConfig: JsonRecord;
}>;

export type SalesLaneDependencies = Readonly<{
  database: DatabaseAdapter;
  agoraCredential: SecretTextPort;
  winerimCredential: SecretTextPort;
  winerimBaseUrl: string;
  winerimAllowedHosts: readonly string[];
  request: typeof fetch;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  maxClosedDaysPerRun?: number;
  beforeMutation?: () => Promise<void>;
}>;

type ParsedInvoices = Readonly<{
  recognized: boolean;
  invoices: JsonRecord[];
}>;

type SalesDayResult = Readonly<{
  businessDay: string;
  documentCount: number;
  candidateLineCount: number;
  executionCount: number;
  dryRun: boolean;
  cursorAdvanced: boolean;
}>;

type OpenTicketResult = Readonly<{
  businessDay: string;
  documentCount: number;
  candidateLineCount: number;
  blockedLineCount: number;
  executionCount: number;
  dryRun: boolean;
  mode: "shadow" | "provisional-stock";
}>;

type WinerimStockEntry = Readonly<{
  identity: WinerimStockIdentity;
  stock: number;
  active: boolean;
}>;

export class SalesLaneError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus = 503,
    readonly retryable = true,
  ) {
    super(code);
    this.name = "SalesLaneError";
  }
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function boolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes"].includes(text(value).toLowerCase());
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const normalized = text(value).replace(",", ".");
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validBusinessDay(value: unknown): value is string {
  const day = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

function addUtcDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function todayInTimeZone(now: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(now));
    const byType = new Map(parts.map((part) => [part.type, part.value]));
    const day = `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
    return validBusinessDay(day) ? day : new Date(now).toISOString().slice(0, 10);
  } catch {
    throw new SalesLaneError("SALES_INVALID_TIME_ZONE", 422, false);
  }
}

function providerTimeZone(connection: SalesLaneConnection): string {
  return text(
    connection.providerConfig.time_zone
      ?? connection.providerConfig.timezone
      ?? connection.providerConfig.timeZone,
  ) || DEFAULT_TIME_ZONE;
}

function salesCutoverBusinessDay(connection: SalesLaneConnection): string | null {
  const value = text(connection.providerConfig.runtime_sales_cutover_business_day);
  return validBusinessDay(value) ? value : null;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const valueRecord = value as JsonRecord;
  return `{${Object.keys(valueRecord).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(valueRecord[key])}`).join(",")}}`;
}

function shortHash(value: unknown): string {
  const serialized = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function field(value: JsonRecord, ...names: string[]): unknown {
  const keys = Object.keys(value);
  for (const name of names) {
    if (name in value) return value[name];
    const key = keys.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (key) return value[key];
  }
  return undefined;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((item): item is JsonRecord => !!record(item)) : [];
}

export function parseAgoraInvoicesPayload(payload: unknown): ParsedInvoices {
  if (Array.isArray(payload)) return { recognized: true, invoices: records(payload) };
  const root = record(payload);
  if (!root) return { recognized: false, invoices: [] };
  if (Array.isArray(root.Invoices)) return { recognized: true, invoices: records(root.Invoices) };
  const data = record(root.Data);
  if (data && Array.isArray(data.Invoices)) {
    return { recognized: true, invoices: records(data.Invoices) };
  }
  const arrays = Object.values(root).filter(Array.isArray);
  if (arrays.length === 1) return { recognized: true, invoices: records(arrays[0]) };
  return { recognized: false, invoices: [] };
}

function invoiceLines(invoice: JsonRecord): Array<{ line: JsonRecord; itemIndex: number; lineIndex: number }> {
  const direct = records(field(invoice, "Lines"));
  if (direct.length > 0) return direct.map((line, lineIndex) => ({ line, itemIndex: 0, lineIndex }));
  const flattened: Array<{ line: JsonRecord; itemIndex: number; lineIndex: number }> = [];
  records(field(invoice, "InvoiceItems", "Items")).forEach((item, itemIndex) => {
    records(field(item, "Lines", "Items")).forEach((line, lineIndex) => {
      flattened.push({ line, itemIndex, lineIndex });
    });
  });
  return flattened;
}

function nativeProductId(line: JsonRecord): string {
  const productId = text(field(line, "ProductId", "ProviderProductId", "ItemId", "ArticleId"));
  if (productId && productId !== "0") return productId;
  const saleFormatId = text(field(line, "SaleFormatId", "FormatId", "PriceId"));
  return saleFormatId && saleFormatId !== "0" ? saleFormatId : productId || "0";
}

function providerLine(
  documentId: string,
  raw: JsonRecord,
  itemIndex: number,
  lineIndex: number,
): ProviderSalesLine {
  const productName = text(field(raw, "ProductName", "Name", "Description", "ItemName"));
  const saleFormatName = text(field(raw, "SaleFormatName", "FormatName", "Format"));
  const familyName = text(field(raw, "FamilyName", "Family", "CategoryName"));
  const providerLineId = text(field(raw, "LineId", "Id", "Index", "Position"));
  const lineId = providerLineId
    ? `${documentId}:${itemIndex}:${providerLineId}`
    : `${documentId}:${itemIndex}:${lineIndex}:${shortHash({
      productId: nativeProductId(raw),
      productName,
      quantity: field(raw, "Quantity", "Qty", "Units"),
      unitPrice: field(raw, "UnitPrice", "Price", "ProductPrice"),
    })}`;
  const quantity = finiteNumber(field(raw, "Quantity", "Qty", "Units", "Amount")) ?? 0;
  const unitPrice = finiteNumber(field(raw, "UnitPrice", "Price", "ProductPrice", "PriceWithTaxes"));
  const totalAmount = finiteNumber(field(raw, "TotalAmount", "Total", "AmountWithTaxes"));
  const normalized = normalizeAgoraLineFormat(productName, saleFormatName);
  const suggestedVariant: SalesVariant | undefined = normalized === "COPA"
    ? "GLASS"
    : normalized === "MAGNUM"
    ? "MAGNUM"
    : normalized === "BOT"
    ? "BOTTLE"
    : undefined;
  return {
    lineId,
    providerProductId: nativeProductId(raw),
    saleFormatId: text(field(raw, "SaleFormatId", "FormatId", "PriceId")) || undefined,
    productName,
    familyName: familyName || undefined,
    quantity,
    unitPrice,
    totalAmount,
    soldAt: text(field(raw, "CreationDate", "SoldAt", "CreatedAt", "Date")) || undefined,
    suggestedVariant,
  };
}

function lifecycleIdentity(invoice: JsonRecord, documentId: string): { id: string; source: "PROVIDER" | "FALLBACK" } {
  const id = [
    invoice.GlobalId,
    invoice.TicketGlobalId,
    invoice.TicketId,
    invoice.OrderId,
    invoice.InvoiceId,
    invoice.DocumentId,
    invoice.Id,
  ].map(text).find(Boolean);
  return id ? { id, source: "PROVIDER" } : { id: documentId, source: "FALLBACK" };
}

export function normalizeAgoraDefinitiveInvoices(
  payload: unknown,
  businessDay: string,
): ProviderSalesDocument[] {
  if (!validBusinessDay(businessDay)) throw new SalesLaneError("SALES_INVALID_BUSINESS_DAY", 422, false);
  const parsed = parseAgoraInvoicesPayload(payload);
  if (!parsed.recognized) throw new SalesLaneError("AGORA_INVOICES_PAYLOAD_UNRECOGNIZED");
  return parsed.invoices.flatMap((invoice, invoiceIndex) => {
    if (!isAgoraDocumentWithinBusinessDay(invoice, businessDay) && !isAgoraRefundDocument(invoice)) {
      return [];
    }
    const documentId = buildAgoraInvoiceDocId(invoice, businessDay, invoiceIndex);
    const lifecycle = lifecycleIdentity(invoice, documentId);
    const invoiceDay = validBusinessDay(invoice.BusinessDay) ? String(invoice.BusinessDay) : businessDay;
    return [{
      provider: "agora",
      documentId,
      lifecycleId: lifecycle.id,
      identitySource: lifecycle.source,
      businessDay: invoiceDay,
      kind: "DEFINITIVE_INVOICE" as const,
      isRefund: isAgoraRefundDocument(invoice),
      observedAt: text(invoice.UpdatedAt ?? invoice.CreationDate) || undefined,
      lines: invoiceLines(invoice).map(({ line, itemIndex, lineIndex }) => (
        providerLine(documentId, line, itemIndex, lineIndex)
      )),
    }];
  });
}

function baseUrl(value: string): { value: string; allowedHost: string } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SalesLaneError("AGORA_BASE_URL_INVALID", 422, false);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new SalesLaneError("AGORA_BASE_URL_INVALID", 422, false);
  }
  parsed.pathname = "/";
  return { value: parsed.toString(), allowedHost: parsed.host.toLowerCase() };
}

async function loadConnection(database: DatabaseAdapter, connectionId: string): Promise<SalesLaneConnection> {
  const result = await database.query<{
    connection_id: unknown;
    provider: unknown;
    base_url: unknown;
    enabled: unknown;
    last_business_day_synced: unknown;
    provider_config: unknown;
  }>(sql`
    SELECT
      id::text AS connection_id,
      provider,
      base_url,
      enabled,
      last_business_day_synced,
      COALESCE(provider_config, '{}'::jsonb) AS provider_config
    FROM public.pos_connections
    WHERE id = ${connectionId}::uuid
    LIMIT 2
  `);
  if (result.rowCount !== 1) throw new SalesLaneError("SALES_CONNECTION_NOT_FOUND", 422, false);
  const row = result.rows[0];
  const providerConfig = record(row.provider_config) ?? {};
  return {
    connectionId: text(row.connection_id),
    provider: text(row.provider).toLowerCase(),
    baseUrl: text(row.base_url),
    enabled: row.enabled === true,
    lastBusinessDaySynced: validBusinessDay(row.last_business_day_synced)
      ? text(row.last_business_day_synced).slice(0, 10)
      : null,
    providerConfig,
  };
}

export function salesLaneFlags(value: {
  RUNTIME_SALES_EXECUTION_ENABLED?: string;
  RUNTIME_SALES_CURSOR_ENABLED?: string;
  RUNTIME_SALES_DLQ_READY?: string;
}): SalesLaneFlags {
  return {
    executionEnabled: boolean(value.RUNTIME_SALES_EXECUTION_ENABLED),
    cursorEnabled: boolean(value.RUNTIME_SALES_CURSOR_ENABLED),
    dlqReady: boolean(value.RUNTIME_SALES_DLQ_READY),
  };
}

export function salesLaneGateFailure(
  flags: SalesLaneFlags,
  dryRun: boolean,
  job?: RuntimeEnvelopeV1["job"],
): string | null {
  if (dryRun) return null;
  if (!flags.executionEnabled) return "RUNTIME_SALES_EXECUTION_DISABLED";
  if (job !== "sales.sync-open-tickets" && !flags.cursorEnabled) {
    return "RUNTIME_SALES_CURSOR_DISABLED";
  }
  if (!flags.dlqReady) return "RUNTIME_SALES_DLQ_NOT_READY";
  return null;
}

export function salesConnectionGateFailure(
  connection: SalesLaneConnection,
  job: RuntimeEnvelopeV1["job"],
  dryRun: boolean,
): string | null {
  if (dryRun) return null;
  if (job === "sales.sync-intraday" && !boolean(connection.providerConfig.intraday_sales_sync_enabled)) {
    return "SALES_INTRADAY_SYNC_DISABLED";
  }
  if (job === "sales.sync-open-tickets") {
    return boolean(connection.providerConfig.open_tickets_sync_enabled)
      ? null
      : "SALES_OPEN_TICKETS_SYNC_DISABLED";
  }
  if (!salesCutoverBusinessDay(connection)) return "SALES_CUTOVER_DAY_REQUIRED";
  return null;
}

function envelopePayload(envelope: RuntimeEnvelopeV1): JsonRecord {
  return record(envelope.payload) ?? {};
}

function runKindForJob(job: RuntimeEnvelopeV1["job"]): SalesRunKind {
  if (job === "sales.auto-sync") return "CLOSED_DAY";
  if (job === "sales.sync-intraday") return "INTRADAY";
  if (job === "sales.sync-open-tickets") return "OPEN_TICKET";
  throw new SalesLaneError("SALES_JOB_UNSUPPORTED", 422, false);
}

function boundedClosedDays(value: number | undefined): number {
  const candidate = Math.trunc(value ?? DEFAULT_MAX_CLOSED_DAYS_PER_RUN);
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > MAX_CLOSED_DAYS_PER_RUN) {
    throw new SalesLaneError("SALES_MAX_DAYS_INVALID", 422, false);
  }
  return candidate;
}

export function salesBusinessDays(
  envelope: RuntimeEnvelopeV1,
  connection: SalesLaneConnection,
  now: number,
  maxClosedDays = DEFAULT_MAX_CLOSED_DAYS_PER_RUN,
): string[] {
  const payload = envelopePayload(envelope);
  const cutoverDay = salesCutoverBusinessDay(connection);
  const explicitDay = text(payload.businessDay);
  if (explicitDay) {
    if (!validBusinessDay(explicitDay)) throw new SalesLaneError("SALES_INVALID_BUSINESS_DAY", 422, false);
    if (cutoverDay && explicitDay < cutoverDay) {
      throw new SalesLaneError("SALES_BEFORE_CUTOVER_REJECTED", 422, false);
    }
    return [explicitDay];
  }
  const today = todayInTimeZone(now, providerTimeZone(connection));
  if (envelope.job === "sales.sync-open-tickets") return [today];
  if (envelope.job === "sales.sync-intraday") {
    return cutoverDay && today < cutoverDay ? [] : [today];
  }
  if (envelope.job !== "sales.auto-sync") throw new SalesLaneError("SALES_JOB_UNSUPPORTED", 422, false);
  const through = addUtcDays(today, -1);
  const cursorStart = connection.lastBusinessDaySynced
    ? addUtcDays(connection.lastBusinessDaySynced, 1)
    : through;
  const start = cutoverDay && cutoverDay > cursorStart ? cutoverDay : cursorStart;
  if (start > through) return [];
  const days: string[] = [];
  for (let day = start; day <= through && days.length < boundedClosedDays(maxClosedDays); day = addUtcDays(day, 1)) {
    days.push(day);
  }
  return days;
}

function timer(dependencies: Pick<SalesLaneDependencies, "now">) {
  return {
    now: dependencies.now,
    schedule: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds),
    cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

async function loadDefinitiveDocuments(
  connection: SalesLaneConnection,
  businessDay: string,
  dependencies: SalesLaneDependencies,
): Promise<ProviderSalesDocument[]> {
  const target = baseUrl(connection.baseUrl);
  const client = createAgoraReadOnlyClient({
    baseUrl: target.value,
    allowedHosts: [target.allowedHost],
    credential: dependencies.agoraCredential,
    request: { request: (url, init) => dependencies.request(url, init) },
    timer: timer(dependencies),
  });
  const response = await client.exportInvoices(businessDay);
  if (!response.ok) {
    throw new SalesLaneError(`AGORA_INVOICES_HTTP_${response.status}`);
  }
  return normalizeAgoraDefinitiveInvoices(response.body, businessDay);
}

function recordField(value: JsonRecord, ...names: string[]): unknown {
  const keys = Object.keys(value);
  for (const name of names) {
    const key = keys.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (key) return value[key];
  }
  return undefined;
}

function recognizedOpenTicketPayload(payload: unknown): boolean {
  if (Array.isArray(payload)) return true;
  if (typeof payload === "string") {
    const value = payload.trim();
    if (!value) return false;
    if (value.startsWith("<")) {
      return /<(?:Tickets|TicketModel|Ticket)(?:\s|\/?>)/i.test(value);
    }
    try {
      return recognizedOpenTicketPayload(JSON.parse(value));
    } catch {
      return false;
    }
  }
  const root = record(payload);
  if (!root) return false;
  const direct = recordField(root, "Tickets", "TicketModels", "TicketModel", "Ticket");
  if (direct !== undefined) return true;
  const data = recordField(root, "Data");
  if (data !== undefined) return recognizedOpenTicketPayload(data);
  const identity = recordField(
    root,
    "GlobalId",
    "TicketGlobalId",
    "TicketId",
    "DocumentId",
    "DocId",
    "Id",
  );
  return text(identity).length > 0 && recordField(root, "Lines", "TicketLines", "Items", "Products") !== undefined;
}

export function normalizeAgoraOpenTickets(
  payload: unknown,
  businessDay: string,
  observedAt?: string,
): ProviderSalesDocument[] {
  if (!validBusinessDay(businessDay)) {
    throw new SalesLaneError("SALES_INVALID_BUSINESS_DAY", 422, false);
  }
  if (!recognizedOpenTicketPayload(payload)) {
    throw new SalesLaneError("AGORA_OPEN_TICKETS_PAYLOAD_UNRECOGNIZED");
  }
  let documents: ProviderSalesDocument[];
  try {
    documents = parseOpenTicketPayload(payload, {
      provider: "agora",
      businessDay,
      observedAt,
    });
  } catch {
    throw new SalesLaneError("AGORA_OPEN_TICKETS_PAYLOAD_UNRECOGNIZED");
  }
  if (documents.some((document) => (
    document.provider !== "agora"
    || document.kind !== "OPEN_TICKET"
    || !validBusinessDay(document.businessDay)
  ))) {
    throw new SalesLaneError("AGORA_OPEN_TICKETS_PAYLOAD_INVALID");
  }
  return documents;
}

async function loadOpenTicketDocuments(
  connection: SalesLaneConnection,
  businessDay: string,
  dependencies: SalesLaneDependencies,
): Promise<ProviderSalesDocument[]> {
  const target = baseUrl(connection.baseUrl);
  const client = createAgoraReadOnlyClient({
    baseUrl: target.value,
    allowedHosts: [target.allowedHost],
    credential: dependencies.agoraCredential,
    request: { request: (url, init) => dependencies.request(url, init) },
    timer: timer(dependencies),
  });
  const response = await client.exportOpenTickets();
  if (!response.ok) {
    throw new SalesLaneError(`AGORA_OPEN_TICKETS_HTTP_${response.status}`);
  }
  return normalizeAgoraOpenTickets(
    response.body,
    businessDay,
    new Date(dependencies.now()).toISOString(),
  );
}

function normalizeMappedLine(
  line: ProviderSalesLine,
  exactMappings: Map<string, SalesLineResolution>,
): ProviderSalesLine {
  if (exactMappings.has(line.providerProductId)) return line;
  if (line.saleFormatId && exactMappings.has(line.saleFormatId)) {
    return { ...line, providerProductId: line.saleFormatId };
  }
  return line;
}

type ClassifiedPlanningDocuments = Readonly<{
  observations: ProviderSalesDocument[];
  planning: ProviderSalesDocument[];
}>;

function familyKey(value: string | undefined | null): string {
  return text(value).toLowerCase();
}

function familyClassifications(
  classifications: ProviderProductSalesClassification[],
): Map<string, SalesLineClassification> {
  const grouped = new Map<string, SalesLineClassification[]>();
  for (const item of classifications) {
    const key = familyKey(item.familyName);
    if (!key) continue;
    const values = grouped.get(key) ?? [];
    values.push(item.classification);
    grouped.set(key, values);
  }
  return new Map(Array.from(grouped.entries()).map(([key, values]) => {
    if (values.includes("WINE")) return [key, "WINE"] as const;
    if (values.includes("AMBIGUOUS")) return [key, "AMBIGUOUS"] as const;
    return [key, "NOT_WINE"] as const;
  }));
}

function classifyLine(
  line: ProviderSalesLine,
  exactMappings: Map<string, SalesLineResolution>,
  classificationsById: Map<string, SalesLineClassification>,
  classificationsByFamily: Map<string, SalesLineClassification>,
): SalesLineClassification {
  if (
    exactMappings.has(line.providerProductId)
    || (line.saleFormatId && exactMappings.has(line.saleFormatId))
  ) return "WINE";
  const productClassification = classificationsById.get(line.providerProductId)
    ?? (line.saleFormatId ? classificationsById.get(line.saleFormatId) : undefined);
  if (productClassification) return productClassification;
  return classificationsByFamily.get(familyKey(line.familyName)) ?? "AMBIGUOUS";
}

function planningDocuments(
  documents: ProviderSalesDocument[],
  exactMappings: Map<string, SalesLineResolution>,
  classifications: ProviderProductSalesClassification[],
): ClassifiedPlanningDocuments {
  const classificationsById = new Map(
    classifications.map((item) => [item.providerProductId, item.classification]),
  );
  const classificationsByFamily = familyClassifications(classifications);
  const observations = documents.map((document) => ({
    ...document,
    lines: document.lines.map((line) => ({
      ...line,
      classification: classifyLine(
        line,
        exactMappings,
        classificationsById,
        classificationsByFamily,
      ),
    })),
  }));
  return {
    observations,
    planning: observations.map((document) => ({
      ...document,
      lines: document.lines
        .filter((line) => line.classification !== "NOT_WINE")
        .map((line) => normalizeMappedLine(line, exactMappings)),
    })),
  };
}

function stockVariant(variant: SalesVariant): WinerimVariant {
  if (variant === "GLASS") return "copa";
  if (variant === "MAGNUM") return "magnum";
  return "botella";
}

function runtimeStockVariant(variant: WinerimVariant): WinerimStockIdentity["variant"] {
  if (variant === "copa") return "glass";
  if (variant === "magnum") return "magnum";
  return "bottle";
}

function readStockActive(stock: JsonRecord): boolean {
  const value = stock.stockActive ?? stock.stock_active ?? stock.active;
  return value === undefined || value === null || value === "" ? true : boolean(value);
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function winerimCredentialHeader(credential: SecretTextPort): Promise<Record<string, string>> {
  return Promise.resolve(credential.read()).then((raw) => {
    const value = text(raw);
    if (!value || /[\r\n]/.test(value)) throw new SalesLaneError("RUNTIME_CREDENTIAL_UNAVAILABLE");
    return { Accept: "application/json", "WINERIM-API-TOKEN": value };
  });
}

function createWinerimStockReader(dependencies: SalesLaneDependencies) {
  const http = createSafeHttpClient({
    target: "winerim",
    baseUrl: dependencies.winerimBaseUrl,
    allowedHosts: dependencies.winerimAllowedHosts,
    allowedProtocols: ["https:"],
    timeoutMs: WINERIM_STOCK_READ_TIMEOUT_MS,
    maxResponseBytes: WINERIM_STOCK_READ_MAX_BYTES,
    request: { request: (url, init) => dependencies.request(url, init) },
    timer: timer(dependencies),
  });
  return async (wineId: string): Promise<WinerimStockEntry[]> => {
    if (!/^\d+$/.test(wineId)) throw new SalesLaneError("WINERIM_WINE_ID_INVALID", 422, false);
    const response = await http.request({
      operation: "winerim.stock-wine-read",
      method: "GET",
      path: `/api/v2/stock/wine/${wineId}`,
      headers: await winerimCredentialHeader(dependencies.winerimCredential),
    });
    if (!response.ok) throw new SalesLaneError(`WINERIM_STOCK_READ_HTTP_${response.status}`);
    return parseWinerimStockRows(response.body).flatMap((stock) => {
      const id = positiveInteger(stock.id ?? stock.stockId);
      const quantity = positiveInteger(stock.stock);
      const variant = (["copa", "botella", "magnum"] as const)
        .find((candidate) => findStockForVariant([stock], candidate));
      if (!id || quantity === null || !variant) return [];
      return [{
        identity: { wineId, stockId: id, variant: runtimeStockVariant(variant) },
        stock: quantity,
        active: readStockActive(stock),
      }];
    });
  };
}

function mutationTransport(dependencies: SalesLaneDependencies): WinerimMutationTransport {
  const transport = createWinerimMutationTransport({
    baseUrl: dependencies.winerimBaseUrl,
    allowedHosts: dependencies.winerimAllowedHosts,
    credential: dependencies.winerimCredential,
    request: { request: (url, init) => dependencies.request(url, init) },
    timer: timer(dependencies),
    sleep: dependencies.sleep,
  });
  if (!dependencies.beforeMutation) return transport;
  return {
    async send(request) {
      await dependencies.beforeMutation!();
      return transport.send(request);
    },
    ...(transport.readStock
      ? { readStock: (stockId: number) => transport.readStock!(stockId) }
      : {}),
    sleep: transport.sleep,
  };
}

function fallbackSoldAtForBusinessDay(businessDay: string): string {
  // Deterministic midday UTC avoids inventing a midnight timestamp near a date boundary.
  return `${businessDay}T12:00:00.000Z`;
}

function validProviderSoldAt(value: unknown): string | null {
  const candidate = text(value);
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : null;
}

function soldAtByOrderId(plan: SalesPlan): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const intent of plan.intents) {
    const documentIds = new Set(intent.sourceDocumentIds);
    const lineIds = new Set(intent.sourceLineIds);
    const documents = plan.documents.filter((document) => documentIds.has(document.documentId));
    const lineTimestamps = documents.flatMap((document) => document.lines
      .filter((line) => lineIds.has(line.lineId))
      .map((line) => validProviderSoldAt(line.soldAt))
      .filter((soldAt): soldAt is string => soldAt !== null));
    const documentTimestamps = documents
      .map((document) => validProviderSoldAt(document.observedAt))
      .filter((soldAt): soldAt is string => soldAt !== null);
    const candidates = lineTimestamps.length > 0 ? lineTimestamps : documentTimestamps;
    const earliest = candidates
      .map((soldAt) => ({ soldAt, epoch: Date.parse(soldAt) }))
      .sort((left, right) => left.epoch - right.epoch || left.soldAt.localeCompare(right.soldAt))[0];
    if (earliest) result.set(intent.orderId, earliest.soldAt);
  }
  return result;
}

function mutationSoldAt(
  orderId: string,
  businessDay: string,
  providerSoldAtByOrderId: ReadonlyMap<string, string>,
): string {
  const primaryOrderId = orderId.endsWith(":sales-only")
    ? orderId.slice(0, -":sales-only".length)
    : orderId;
  return providerSoldAtByOrderId.get(orderId)
    ?? providerSoldAtByOrderId.get(primaryOrderId)
    ?? fallbackSoldAtForBusinessDay(businessDay);
}

function mapStockRun(
  state: string,
  execution: WinerimMutationExecutionResult | null,
  kind: "stock" | "import",
): StockApplyResult | SalesImportResult {
  if (state === "DUPLICATE") {
    return kind === "stock"
      ? { ok: true, duplicate: true, stockMoved: true }
      : { ok: true, duplicate: true, lines: [{ duplicate: true }] };
  }
  if (state === "APPLIED" && execution?.ok) {
    return kind === "stock"
      ? { ok: true, stockMoved: true }
      : { ok: true, lines: [{ stockApplied: true }] };
  }
  const retryable = state === "BUSY" || state === "RETRY" || execution?.retryable === true;
  return {
    ok: false,
    status: retryable ? 409 : 422,
    retryable,
    error: retryable ? "WINERIM_MUTATION_RETRYABLE" : "WINERIM_MUTATION_TERMINAL",
  };
}

function createSalesMutations(
  dependencies: SalesLaneDependencies,
  providerSoldAtByOrderId: ReadonlyMap<string, string>,
): Pick<SalesExecutionPorts, "applyStock" | "importSales"> {
  const readStocks = createWinerimStockReader(dependencies);
  const transport = mutationTransport(dependencies);

  const applyStock = async (command: StockApplyCommand): Promise<StockApplyResult> => {
    const desiredVariant = stockVariant(command.variant);
    const stocks = await readStocks(command.winerimWineId);
    const source = stocks.find((entry) => (
      entry.active && entry.identity.variant === runtimeStockVariant(desiredVariant)
    ));
    if (!source) return { ok: false, status: 422, error: "WINERIM_STOCK_VARIANT_NOT_FOUND" };
    const adapter = createPostgresStockAdapter(dependencies.database, {
      connectionId: command.connectionId,
      transport,
      now: dependencies.now,
    });
    const result = await adapter.execute({
      idempotencyKey: command.idempotencyKey,
      mutation: {
        mode: "operational",
        orderId: command.orderId,
        soldAt: mutationSoldAt(command.orderId, command.businessDay, providerSoldAtByOrderId),
        quantity: command.decrementQuantity,
        soldStock: source.identity,
        stockSource: source.identity,
        currentSourceStock: source.stock,
      },
      productName: `Winerim ${command.winerimWineId} ${command.variant}`,
    });
    return mapStockRun(result.state, result.execution, "stock") as StockApplyResult;
  };

  const importSales = async (command: SalesImportCommand): Promise<SalesImportResult> => {
    if (command.lines.length !== 1) {
      return { ok: false, status: 422, error: "SALES_IMPORT_SINGLE_LINE_REQUIRED" };
    }
    const line = command.lines[0];
    const stocks = await readStocks(line.winerimWineId);
    const sold = stocks.find((entry) => (
      entry.active && entry.identity.variant === runtimeStockVariant(stockVariant(line.variant))
    ));
    if (!sold) return { ok: false, status: 422, error: "WINERIM_STOCK_VARIANT_NOT_FOUND" };

    if (!command.live) {
      const plan = {
        mode: "historical" as const,
        soldStock: sold.identity,
        stockSource: sold.identity,
        mutatesStock: false,
        requiresLiveStockCertification: false,
        request: {
          kind: "sales-import" as const,
          method: "POST" as const,
          path: "/api/v2/sales/import" as const,
          body: {
            sales: [{
              stockId: sold.identity.stockId,
              qty: line.quantity,
              soldAt: mutationSoldAt(command.orderId, command.businessDay, providerSoldAtByOrderId),
              orderId: command.orderId,
            }],
          },
        },
      };
      const execution = await executeWinerimMutationPlan(plan, transport);
      return execution.ok
        ? { ok: true, lines: [{ duplicate: execution.certifiedOrderIds.length === 0 }] }
        : {
          ok: false,
          status: execution.retryable ? 409 : 422,
          retryable: execution.retryable,
          error: execution.reason,
        };
    }

    if (sold.identity.variant !== "glass") {
      return { ok: false, status: 422, error: "LIVE_IMPORT_REQUIRES_GLASS" };
    }
    const bottle = stocks.find((entry) => entry.active && entry.identity.variant === "bottle");
    if (!bottle) return { ok: false, status: 422, error: "WINERIM_BOTTLE_SOURCE_NOT_FOUND" };
    const adapter = createPostgresStockAdapter(dependencies.database, {
      connectionId: command.connectionId,
      transport,
      now: dependencies.now,
    });
    const result = await adapter.execute({
      idempotencyKey: command.idempotencyKey,
      mutation: {
        mode: "operational",
        orderId: command.orderId,
        soldAt: mutationSoldAt(command.orderId, command.businessDay, providerSoldAtByOrderId),
        quantity: line.quantity,
        soldStock: sold.identity,
        stockSource: bottle.identity,
      },
      productName: `Winerim ${line.winerimWineId} GLASS`,
    });
    return mapStockRun(result.state, result.execution, "import") as SalesImportResult;
  };

  return { applyStock, importSales };
}

async function legacyReceiptConflict(
  database: DatabaseAdapter,
  connectionId: string,
  providerDocumentIds: string[],
  mutationKeys: string[],
  orderIds: string[],
  legacyOrderPrefixes: string[],
): Promise<boolean> {
  if (providerDocumentIds.length === 0) return false;
  const result = await database.query<{ conflict_count: unknown }>(sql`
    WITH receipts AS (
      SELECT
        ssl.*,
        se.provider_doc_id,
        COALESCE(
          ssl.winerim_response #>> '{salesImport,orderId}',
          ssl.winerim_response #>> '{salesImportBackfill,orderId}',
          ssl.winerim_response #>> '{request,body,sales,0,orderId}',
          ssl.winerim_response ->> 'orderId'
        ) AS receipt_order_id
      FROM public.stock_sync_log ssl
      LEFT JOIN public.sales_line_items sli ON sli.id = ssl.sales_line_item_id
      LEFT JOIN public.sales_events se ON se.id = COALESCE(ssl.sales_event_id, sli.sales_event_id)
    )
    SELECT count(*)::int AS conflict_count
    FROM receipts
    WHERE connection_id = ${connectionId}::uuid
      AND (
        provider_doc_id = ANY(${providerDocumentIds}::text[])
        OR (
          sales_event_id IS NULL
          AND (
            receipt_order_id = ANY(${orderIds}::text[])
            OR EXISTS (
              SELECT 1
              FROM unnest(${legacyOrderPrefixes}::text[]) AS legacy(prefix)
              WHERE receipt_order_id LIKE legacy.prefix || '%'
            )
          )
        )
      )
      AND status = 'SUCCESS'
      AND (
        idempotency_key IS NULL
        OR NOT (idempotency_key = ANY(${mutationKeys}::text[]))
      )
  `);
  return Number(result.rows[0]?.conflict_count ?? 0) > 0;
}

export async function advanceSalesCursorFailClosed(input: {
  database: DatabaseAdapter;
  connectionId: string;
  throughBusinessDay: string;
  providerDocumentIds: string[];
  claimKeys: string[];
  mutationKeys: string[];
  now: number;
}): Promise<boolean> {
  if (!validBusinessDay(input.throughBusinessDay)) {
    throw new SalesLaneError("SALES_CURSOR_DAY_INVALID", 422, false);
  }
  return input.database.transaction(async (transaction: DatabaseTransaction) => {
    const connection = await transaction.query<{
      enabled: unknown;
      provider: unknown;
      last_business_day_synced: unknown;
    }>(sql`
      SELECT enabled, provider, last_business_day_synced
      FROM public.pos_connections
      WHERE id = ${input.connectionId}::uuid
      FOR UPDATE
    `);
    const row = connection.rows[0];
    if (!row || row.enabled !== true || text(row.provider).toLowerCase() !== "agora") {
      throw new SalesLaneError("SALES_CURSOR_CONNECTION_SCOPE_REJECTED", 422, false);
    }

    const events = await transaction.query<{ event_count: unknown }>(sql`
      SELECT count(*)::int AS event_count
      FROM public.sales_events
      WHERE connection_id = ${input.connectionId}::uuid
        AND provider_doc_id = ANY(${input.providerDocumentIds}::text[])
    `);
    if (Number(events.rows[0]?.event_count ?? 0) !== input.providerDocumentIds.length) {
      throw new SalesLaneError("SALES_CURSOR_DOCUMENT_READBACK_FAILED");
    }

    if (input.claimKeys.length > 0) {
      const claims = await transaction.query<{ successful: unknown }>(sql`
        SELECT count(*)::int AS successful
        FROM public.runtime_idempotency
        WHERE connection_id = ${input.connectionId}::uuid
          AND job = 'sales.claim'
          AND idempotency_key = ANY(${input.claimKeys}::text[])
          AND status = 'SUCCESS'
      `);
      if (Number(claims.rows[0]?.successful ?? 0) !== input.claimKeys.length) {
        throw new SalesLaneError("SALES_CURSOR_CLAIM_READBACK_FAILED");
      }
    }

    if (input.mutationKeys.length > 0) {
      const mutations = await transaction.query<{ successful: unknown }>(sql`
        SELECT count(*)::int AS successful
        FROM public.runtime_idempotency
        WHERE connection_id = ${input.connectionId}::uuid
          AND job = 'stock.mutation'
          AND idempotency_key = ANY(${input.mutationKeys}::text[])
          AND status = 'SUCCESS'
      `);
      if (Number(mutations.rows[0]?.successful ?? 0) !== input.mutationKeys.length) {
        throw new SalesLaneError("SALES_CURSOR_MUTATION_READBACK_FAILED");
      }
    }

    const updated = await transaction.query<{ last_business_day_synced: unknown }>(sql`
      UPDATE public.pos_connections
      SET
        last_business_day_synced = GREATEST(last_business_day_synced, ${input.throughBusinessDay}::date),
        last_sync_at = ${new Date(input.now).toISOString()}::timestamptz
      WHERE id = ${input.connectionId}::uuid
      RETURNING last_business_day_synced
    `);
    if (updated.rowCount !== 1) throw new SalesLaneError("SALES_CURSOR_UPDATE_FAILED");
    return text(updated.rows[0].last_business_day_synced).slice(0, 10) >= input.throughBusinessDay;
  }, { isolationLevel: "serializable", readOnly: false });
}

async function touchSalesSync(
  database: DatabaseAdapter,
  connectionId: string,
  now: number,
): Promise<void> {
  const result = await database.query(sql`
    UPDATE public.pos_connections
    SET last_sync_at = ${new Date(now).toISOString()}::timestamptz
    WHERE id = ${connectionId}::uuid AND enabled = true AND provider = 'agora'
  `);
  if (result.rowCount !== 1) throw new SalesLaneError("SALES_SYNC_TIMESTAMP_UPDATE_FAILED");
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function legacyOrderPrefix(
  connectionId: string,
  businessDay: string,
  winerimWineId: string,
  variant: SalesVariant,
): string {
  const connectionShort = connectionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "x";
  const variantShort = variant === "BOTTLE" ? "bot" : variant === "GLASS" ? "cop" : "mag";
  return `agora:${connectionShort}:${businessDay}:${winerimWineId}:${variantShort}:`;
}

async function executeOpenTickets(
  connection: SalesLaneConnection,
  businessDay: string,
  dependencies: SalesLaneDependencies,
  dryRun: boolean,
): Promise<OpenTicketResult> {
  const documents = await loadOpenTicketDocuments(connection, businessDay, dependencies);
  const salesAdapter = createPostgresSalesAdapter(dependencies.database, {
    connectionId: connection.connectionId,
    provider: connection.provider,
  });
  const allIds = unique(documents.flatMap((document) => document.lines.flatMap((line) => [
    line.providerProductId,
    line.saleFormatId ?? "",
  ])));
  const mappings = await salesAdapter.readExactMappings(allIds);
  const mappingById = new Map<string, SalesLineResolution>(
    mappings.map((mapping) => [mapping.providerProductId, mapping]),
  );
  const classifications = await salesAdapter.readProductClassifications(
    allIds,
    unique(documents.flatMap((document) => document.lines.map((line) => line.familyName ?? ""))),
  );
  const classified = planningDocuments(documents, mappingById, classifications);
  const candidates = classified.planning;
  const stockEnabled = boolean(connection.providerConfig.open_tickets_stock_sync_enabled);
  const plan = await planSalesRun({
    connectionId: connection.connectionId,
    provider: connection.provider,
    runKind: "OPEN_TICKET",
    openTicketPolicy: stockEnabled ? "PROVISIONAL_STOCK" : "OBSERVE_ONLY",
    documents: candidates,
  }, {
    resolveLine: async ({ line }) => mappingById.get(line.providerProductId) ?? null,
    loadClaims: stockEnabled ? salesAdapter.loadClaims : undefined,
    loadReconciliationClaims: stockEnabled ? salesAdapter.loadReconciliationClaims : undefined,
  });

  if (dryRun) {
    const execution = await executeSalesPlan(plan, {
      reserveClaim: salesAdapter.reserveClaim,
      completeClaim: salesAdapter.completeClaim,
      releaseClaim: salesAdapter.releaseClaim,
      applyStock: async () => { throw new SalesLaneError("SALES_DRY_RUN_MUTATION_ATTEMPTED"); },
      importSales: async () => { throw new SalesLaneError("SALES_DRY_RUN_MUTATION_ATTEMPTED"); },
    }, { dryRun: true });
    return {
      businessDay,
      documentCount: documents.length,
      candidateLineCount: candidates.reduce((sum, document) => sum + document.lines.length, 0),
      blockedLineCount: plan.blocked.length,
      executionCount: execution.items.length,
      dryRun: true,
      mode: stockEnabled ? "provisional-stock" : "shadow",
    };
  }

  // Shadow is an idempotent database observation only. It intentionally does
  // not advance the definitive cursor or contact Winerim.
  await salesAdapter.persistDocuments(classified.observations);
  if (!stockEnabled) {
    return {
      businessDay,
      documentCount: documents.length,
      candidateLineCount: candidates.reduce((sum, document) => sum + document.lines.length, 0),
      blockedLineCount: plan.blocked.length,
      executionCount: 0,
      dryRun: false,
      mode: "shadow",
    };
  }

  if (plan.blocked.length > 0) {
    throw new SalesLaneError("SALES_OPEN_TICKET_PLAN_BLOCKED_FOR_DLQ");
  }
  if (plan.noops.some((noop) => noop.reason === "CLAIM_BUSY")) {
    throw new SalesLaneError("SALES_OPEN_TICKET_CLAIM_BUSY_FOR_DLQ");
  }
  const allMutationKeys = unique(plan.intents.map((intent) => intent.mutationIdempotencyKey));
  if (await legacyReceiptConflict(
    dependencies.database,
    connection.connectionId,
    unique(documents.map((document) => document.documentId)),
    allMutationKeys,
    unique(plan.intents.flatMap((intent) => [intent.orderId, `${intent.orderId}:sales-only`])),
    unique(plan.intents.map((intent) => legacyOrderPrefix(
      connection.connectionId,
      intent.businessDay,
      intent.winerimWineId,
      intent.variant,
    ))),
  )) {
    throw new SalesLaneError("SALES_LEGACY_IDEMPOTENCY_RECONCILIATION_REQUIRED");
  }

  const mutations = createSalesMutations(dependencies, soldAtByOrderId(plan));
  const execution = await executeSalesPlan(plan, {
    reserveClaim: salesAdapter.reserveClaim,
    completeClaim: salesAdapter.completeClaim,
    releaseClaim: salesAdapter.releaseClaim,
    ...mutations,
  });
  if (execution.items.some((item) => item.status === "FAILED" || item.status === "BUSY")) {
    throw new SalesLaneError("SALES_OPEN_TICKET_EXECUTION_FAILED_FOR_DLQ");
  }
  return {
    businessDay,
    documentCount: documents.length,
    candidateLineCount: candidates.reduce((sum, document) => sum + document.lines.length, 0),
    blockedLineCount: 0,
    executionCount: execution.items.length,
    dryRun: false,
    mode: "provisional-stock",
  };
}

async function executeDay(
  connection: SalesLaneConnection,
  businessDay: string,
  runKind: SalesRunKind,
  dependencies: SalesLaneDependencies,
  dryRun: boolean,
): Promise<SalesDayResult> {
  const documents = await loadDefinitiveDocuments(connection, businessDay, dependencies);
  const salesAdapter = createPostgresSalesAdapter(dependencies.database, {
    connectionId: connection.connectionId,
    provider: connection.provider,
  });
  const allIds = unique(documents.flatMap((document) => document.lines.flatMap((line) => [
    line.providerProductId,
    line.saleFormatId ?? "",
  ])));
  const mappings = await salesAdapter.readExactMappings(allIds);
  const mappingById = new Map<string, SalesLineResolution>(
    mappings.map((mapping) => [mapping.providerProductId, mapping]),
  );
  const classifications = await salesAdapter.readProductClassifications(
    allIds,
    unique(documents.flatMap((document) => document.lines.map((line) => line.familyName ?? ""))),
  );
  const classified = planningDocuments(documents, mappingById, classifications);
  const candidates = classified.planning;
  const plan = await planSalesRun({
    connectionId: connection.connectionId,
    provider: connection.provider,
    runKind,
    documents: candidates,
  }, {
    resolveLine: async ({ line }) => mappingById.get(line.providerProductId) ?? null,
    loadClaims: salesAdapter.loadClaims,
    loadReconciliationClaims: salesAdapter.loadReconciliationClaims,
  });

  if (dryRun) {
    const execution = await executeSalesPlan(plan, {
      reserveClaim: salesAdapter.reserveClaim,
      completeClaim: salesAdapter.completeClaim,
      releaseClaim: salesAdapter.releaseClaim,
      applyStock: async () => { throw new SalesLaneError("SALES_DRY_RUN_MUTATION_ATTEMPTED"); },
      importSales: async () => { throw new SalesLaneError("SALES_DRY_RUN_MUTATION_ATTEMPTED"); },
    }, { dryRun: true });
    return {
      businessDay,
      documentCount: documents.length,
      candidateLineCount: candidates.reduce((sum, document) => sum + document.lines.length, 0),
      executionCount: execution.items.length,
      dryRun: true,
      cursorAdvanced: false,
    };
  }

  if (plan.blocked.length > 0) {
    throw new SalesLaneError("SALES_PLAN_BLOCKED_FOR_DLQ");
  }
  if (plan.noops.some((noop) => noop.reason === "CLAIM_BUSY")) {
    throw new SalesLaneError("SALES_CLAIM_BUSY_FOR_DLQ");
  }
  const allMutationKeys = unique(plan.intents.map((intent) => intent.mutationIdempotencyKey));
  const stockMutationKeys = unique(plan.intents.flatMap((intent) => (
    intent.action.kind === "STOCK_APPLY" || intent.action.live
      ? [intent.mutationIdempotencyKey]
      : []
  )));
  if (await legacyReceiptConflict(
    dependencies.database,
    connection.connectionId,
    unique(documents.map((document) => document.documentId)),
    allMutationKeys,
    unique(plan.intents.flatMap((intent) => [intent.orderId, `${intent.orderId}:sales-only`])),
    unique(plan.intents.map((intent) => legacyOrderPrefix(
      connection.connectionId,
      intent.businessDay,
      intent.winerimWineId,
      intent.variant,
    ))),
  )) {
    throw new SalesLaneError("SALES_LEGACY_IDEMPOTENCY_RECONCILIATION_REQUIRED");
  }

  await salesAdapter.persistDocuments(classified.observations);

  const mutations = createSalesMutations(dependencies, soldAtByOrderId(plan));
  const execution = await executeSalesPlan(plan, {
    reserveClaim: salesAdapter.reserveClaim,
    completeClaim: salesAdapter.completeClaim,
    releaseClaim: salesAdapter.releaseClaim,
    ...mutations,
  });
  if (execution.items.some((item) => item.status === "FAILED" || item.status === "BUSY")) {
    throw new SalesLaneError("SALES_EXECUTION_FAILED_FOR_DLQ");
  }

  let cursorAdvanced = false;
  if (runKind === "CLOSED_DAY") {
    cursorAdvanced = await advanceSalesCursorFailClosed({
      database: dependencies.database,
      connectionId: connection.connectionId,
      throughBusinessDay: businessDay,
      providerDocumentIds: unique(documents.map((document) => document.documentId)),
      claimKeys: unique([
        ...plan.intents.map((intent) => intent.claimKey),
        ...plan.noops.map((noop) => noop.claimKey),
      ]),
      mutationKeys: stockMutationKeys,
      now: dependencies.now(),
    });
    if (!cursorAdvanced) throw new SalesLaneError("SALES_CURSOR_NOT_ADVANCED");
  } else {
    await touchSalesSync(dependencies.database, connection.connectionId, dependencies.now());
  }
  return {
    businessDay,
    documentCount: documents.length,
    candidateLineCount: candidates.reduce((sum, document) => sum + document.lines.length, 0),
    executionCount: execution.items.length,
    dryRun: false,
    cursorAdvanced,
  };
}

function failure(error: unknown): RuntimeExecutionResult {
  const laneError = error instanceof SalesLaneError
    ? error
    : new SalesLaneError("SALES_LANE_UNAVAILABLE");
  return {
    ok: false,
    failure: {
      httpStatus: laneError.httpStatus,
      message: laneError.code,
      ...(laneError.retryable ? { retryableLine: true } : {}),
    },
  };
}

export function isSalesLaneJob(job: RuntimeEnvelopeV1["job"]): boolean {
  return SALES_JOBS.has(job);
}

export async function executeAgoraSalesEnvelope(
  envelope: RuntimeEnvelopeV1,
  flags: SalesLaneFlags,
  dependencies: SalesLaneDependencies,
): Promise<RuntimeExecutionResult> {
  try {
    if (!isSalesLaneJob(envelope.job)) throw new SalesLaneError("SALES_JOB_UNSUPPORTED", 422, false);
    const dryRun = envelopePayload(envelope).dryRun === true;
    const gate = salesLaneGateFailure(flags, dryRun, envelope.job);
    if (gate) throw new SalesLaneError(gate);
    const connection = await loadConnection(dependencies.database, envelope.connectionId);
    if (
      connection.connectionId !== envelope.connectionId
      || connection.provider !== "agora"
      || connection.enabled !== true
    ) {
      throw new SalesLaneError("SALES_CONNECTION_SCOPE_REJECTED", 422, false);
    }
    const runKind = runKindForJob(envelope.job);
    const connectionGate = salesConnectionGateFailure(connection, envelope.job, dryRun);
    if (connectionGate) throw new SalesLaneError(connectionGate, 422, false);
    if (runKind === "OPEN_TICKET") {
      const businessDay = salesBusinessDays(
        envelope,
        connection,
        dependencies.now(),
        dependencies.maxClosedDaysPerRun,
      )[0];
      const result = await executeOpenTickets(connection, businessDay, dependencies, dryRun);
      return {
        ok: true,
        detail: [
          "sales",
          "open-tickets",
          result.dryRun ? "dry-run" : result.mode,
          result.documentCount,
          result.candidateLineCount,
          result.blockedLineCount,
          result.executionCount,
        ].join(":"),
      };
    }
    const days = salesBusinessDays(
      envelope,
      connection,
      dependencies.now(),
      dependencies.maxClosedDaysPerRun,
    );
    const results: SalesDayResult[] = [];
    for (const day of days) {
      results.push(await executeDay(connection, day, runKind, dependencies, dryRun));
    }
    const documents = results.reduce((sum, result) => sum + result.documentCount, 0);
    const items = results.reduce((sum, result) => sum + result.executionCount, 0);
    return {
      ok: true,
      detail: `sales:${dryRun ? "dry-run" : "complete"}:${days.length}:${documents}:${items}`,
    };
  } catch (error) {
    return failure(error);
  }
}
