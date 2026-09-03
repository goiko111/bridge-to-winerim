import {
  sql,
  type DatabaseAdapter,
  type DatabaseTransaction,
} from "../../middleware-api/src/db";
import {
  createAgoraReadOnlyClient,
  HttpAdapterError,
  type AgoraMasterFilter,
  type HttpRequestPort,
  type HttpTimerPort,
  type SecretTextPort,
} from "../../middleware-runtime/src/adapters/http";
import type { RuntimeFailureDiagnosticInput } from "../../middleware-runtime/src/retry";

type JsonRecord = Record<string, unknown>;

type XmlNode = Readonly<{
  name: string;
  attributes: Readonly<JsonRecord>;
  children: readonly XmlNode[];
}>;

type MutableXmlNode = {
  name: string;
  attributes: JsonRecord;
  children: MutableXmlNode[];
};

type MasterDataset = Readonly<{
  filter: AgoraMasterFilter;
  container: string;
  item: string;
  column:
    | "families"
    | "products"
    | "vats"
    | "priceLists"
    | "preparationTypes"
    | "preparationOrders"
    | "warehouses"
    | "salePoints"
    | "saleCenters";
}>;

export type AgoraMasterSnapshot = Readonly<{
  families: readonly JsonRecord[];
  products: readonly JsonRecord[];
  vats: readonly JsonRecord[];
  priceLists: readonly JsonRecord[];
  preparationTypes: readonly JsonRecord[];
  preparationOrders: readonly JsonRecord[];
  warehouses: readonly JsonRecord[];
  salePoints: readonly JsonRecord[];
  saleCenters: readonly JsonRecord[];
  observedAt: string;
}>;

export type AgoraMasterRefreshResult =
  | Readonly<{ ok: true; outcome: "complete"; changed: number; observedAt: string }>
  | Readonly<{
      ok: false;
      httpStatus: number;
      message: string;
      retryableLine?: boolean;
      diagnostic?: RuntimeFailureDiagnosticInput;
    }>;

export type AgoraMasterRefreshPort = Readonly<{
  refresh(input: Readonly<{
    connectionId: string;
    credential: SecretTextPort;
  }>): Promise<AgoraMasterRefreshResult>;
}>;

export type AgoraMasterRefreshOptions = Readonly<{
  database: DatabaseAdapter;
  connectionId: string;
  baseUrl: string;
  allowedHosts: readonly string[];
  request: HttpRequestPort;
  timer: HttpTimerPort;
  profile: AgoraMasterOperationalProfile;
  timeoutMs?: number;
}>;

export type AgoraMasterOperationalProfile = Readonly<{
  vatId: string;
  priceListIds: readonly string[];
  warehouseIds: readonly string[];
  preparationTypeId: string;
  preparationOrderId: string;
}>;

const MASTER_DATASETS: readonly MasterDataset[] = Object.freeze([
  { filter: "Families", container: "Families", item: "Family", column: "families" },
  { filter: "Products", container: "Products", item: "Product", column: "products" },
  { filter: "Vats", container: "Vats", item: "Vat", column: "vats" },
  { filter: "PriceLists", container: "PriceLists", item: "PriceList", column: "priceLists" },
  { filter: "PreparationTypes", container: "PreparationTypes", item: "PreparationType", column: "preparationTypes" },
  { filter: "PreparationOrders", container: "PreparationOrders", item: "PreparationOrder", column: "preparationOrders" },
  { filter: "Warehouses", container: "Warehouses", item: "Warehouse", column: "warehouses" },
  { filter: "SalePoints", container: "SalePoints", item: "SalePoint", column: "salePoints" },
  { filter: "SaleCenters", container: "SaleCenters", item: "SaleCenter", column: "saleCenters" },
]);

const MAX_XML_NODES = 100_000;
const MAX_XML_DEPTH = 32;
const MAX_ATTRIBUTES_PER_NODE = 128;
const DEFAULT_TIMEOUT_MS = 10_000;

function decodeEntity(entity: string): string {
  if (entity === "quot") return "\"";
  if (entity === "apos") return "'";
  if (entity === "lt") return "<";
  if (entity === "gt") return ">";
  if (entity === "amp") return "&";
  const decimal = /^#([0-9]{1,7})$/.exec(entity);
  const hexadecimal = /^#x([0-9a-f]{1,6})$/i.exec(entity);
  const codePoint = decimal
    ? Number.parseInt(decimal[1], 10)
    : hexadecimal
      ? Number.parseInt(hexadecimal[1], 16)
      : Number.NaN;
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    throw new Error("AGORA_MASTER_XML_ENTITY_INVALID");
  }
  return String.fromCodePoint(codePoint);
}

function decodeXml(value: string): string {
  return value.replace(/&([^;\s]{1,16});/g, (_match, entity: string) => decodeEntity(entity));
}

function parseAttributes(source: string): JsonRecord {
  const attributes: JsonRecord = {};
  let cursor = 0;
  const attribute = /([A-Za-z_][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/gy;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (cursor >= source.length) break;
    attribute.lastIndex = cursor;
    const match = attribute.exec(source);
    if (!match || match.index !== cursor) throw new Error("AGORA_MASTER_XML_ATTRIBUTE_INVALID");
    if (Object.prototype.hasOwnProperty.call(attributes, match[1])) {
      throw new Error("AGORA_MASTER_XML_ATTRIBUTE_DUPLICATE");
    }
    attributes[match[1]] = decodeXml(match[2].slice(1, -1));
    if (Object.keys(attributes).length > MAX_ATTRIBUTES_PER_NODE) {
      throw new Error("AGORA_MASTER_XML_ATTRIBUTE_LIMIT");
    }
    cursor = attribute.lastIndex;
  }
  return attributes;
}

function tagEnd(xml: string, start: number): number {
  let quote: "\"" | "'" | null = null;
  for (let index = start + 1; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index + 1;
    }
  }
  throw new Error("AGORA_MASTER_XML_TAG_INVALID");
}

function parseXml(xmlInput: string): XmlNode {
  const xml = xmlInput.replace(/^\uFEFF/, "");
  if (!xml.trim() || /\0|<!/i.test(xml)) throw new Error("AGORA_MASTER_XML_INVALID");
  const roots: MutableXmlNode[] = [];
  const stack: MutableXmlNode[] = [];
  let cursor = 0;
  let declarationSeen = false;
  let nodes = 0;

  while (cursor < xml.length) {
    const opening = xml.indexOf("<", cursor);
    if (opening < 0) {
      if (xml.slice(cursor).trim()) throw new Error("AGORA_MASTER_XML_TEXT_INVALID");
      break;
    }
    if (xml.slice(cursor, opening).trim()) throw new Error("AGORA_MASTER_XML_TEXT_INVALID");

    if (xml.startsWith("<?", opening)) {
      const end = xml.indexOf("?>", opening + 2);
      const raw = end < 0 ? "" : xml.slice(opening, end + 2);
      if (end < 0 || declarationSeen || roots.length > 0 || !/^<\?xml\s+[^?]*\?>$/i.test(raw)) {
        throw new Error("AGORA_MASTER_XML_DECLARATION_INVALID");
      }
      declarationSeen = true;
      cursor = end + 2;
      continue;
    }

    const end = tagEnd(xml, opening);
    const raw = xml.slice(opening, end);
    if (raw.startsWith("</")) {
      const match = /^<\/([A-Za-z_][\w:.-]*)\s*>$/.exec(raw);
      const current = stack.pop();
      if (!match || !current || current.name !== match[1]) {
        throw new Error("AGORA_MASTER_XML_NESTING_INVALID");
      }
      cursor = end;
      continue;
    }

    const selfClosing = /\/\s*>$/.test(raw);
    const match = /^<([A-Za-z_][\w:.-]*)([\s\S]*?)(?:\/\s*>|>)$/.exec(raw);
    if (!match) throw new Error("AGORA_MASTER_XML_TAG_INVALID");
    const node: MutableXmlNode = {
      name: match[1],
      attributes: parseAttributes(match[2]),
      children: [],
    };
    nodes += 1;
    if (nodes > MAX_XML_NODES) throw new Error("AGORA_MASTER_XML_NODE_LIMIT");
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else roots.push(node);
    if (!selfClosing) {
      stack.push(node);
      if (stack.length > MAX_XML_DEPTH) throw new Error("AGORA_MASTER_XML_DEPTH_LIMIT");
    }
    cursor = end;
  }

  if (stack.length > 0 || roots.length !== 1 || roots[0].name !== "Export") {
    throw new Error("AGORA_MASTER_XML_ROOT_INVALID");
  }
  return roots[0];
}

function nodeRecord(node: XmlNode): JsonRecord {
  const output: JsonRecord = { ...node.attributes };
  const childrenByName = new Map<string, XmlNode[]>();
  for (const child of node.children) {
    const children = childrenByName.get(child.name) ?? [];
    children.push(child);
    childrenByName.set(child.name, children);
  }
  for (const [name, children] of childrenByName) {
    output[name] = children.length === 1
      ? nodeRecord(children[0])
      : children.map(nodeRecord);
  }
  return output;
}

export function parseAgoraMasterRows(
  xml: string,
  containerName: string,
  itemName: string,
): readonly JsonRecord[] {
  const root = parseXml(xml);
  const containers = root.children.filter((child) => child.name === containerName);
  if (containers.length !== 1) throw new Error("AGORA_MASTER_CONTAINER_INVALID");
  const unexpected = containers[0].children.filter((child) => child.name !== itemName);
  if (unexpected.length > 0) throw new Error("AGORA_MASTER_ITEM_INVALID");
  return containers[0].children.map(nodeRecord);
}

function exactId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^\d{1,18}$/.test(normalized) ? normalized : null;
}

function idSet(rows: readonly JsonRecord[], dataset: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    const id = exactId(row.Id ?? row.id);
    if (!id || ids.has(id)) throw new Error(`AGORA_MASTER_${dataset}_IDENTITY_INVALID`);
    ids.add(id);
  }
  if (ids.size === 0) throw new Error(`AGORA_MASTER_${dataset}_EMPTY`);
  return ids;
}

function configuredIds(values: readonly string[], errorCode: string): readonly string[] {
  const ids = values.map(exactId);
  if (ids.some((id) => id === null) || new Set(ids).size !== ids.length) throw new Error(errorCode);
  return ids as readonly string[];
}

function requireIds(
  configured: readonly string[],
  available: ReadonlySet<string>,
  errorCode: string,
): void {
  if (configured.length === 0 || configured.some((id) => !available.has(id))) throw new Error(errorCode);
}

function validateOperationalProfileShape(profile: AgoraMasterOperationalProfile): void {
  if (
    configuredIds(profile.priceListIds, "AGORA_MASTER_PROFILE_PRICE_LIST_INVALID").length === 0
    || configuredIds(profile.warehouseIds, "AGORA_MASTER_PROFILE_WAREHOUSE_INVALID").length === 0
    || !exactId(profile.vatId)
    || !exactId(profile.preparationTypeId)
    || !exactId(profile.preparationOrderId)
  ) {
    throw new Error("AGORA_MASTER_PROFILE_OPERATIONAL_ROUTING_INVALID");
  }
}

export function validateAgoraMasterSnapshot(
  snapshot: AgoraMasterSnapshot,
  profile: AgoraMasterOperationalProfile,
): void {
  validateOperationalProfileShape(profile);
  idSet(snapshot.families, "FAMILIES");
  idSet(snapshot.products, "PRODUCTS");
  const vatIds = idSet(snapshot.vats, "VATS");
  const priceListIds = idSet(snapshot.priceLists, "PRICE_LISTS");
  const preparationTypeIds = idSet(snapshot.preparationTypes, "PREPARATION_TYPES");
  const preparationOrderIds = idSet(snapshot.preparationOrders, "PREPARATION_ORDERS");
  const warehouseIds = idSet(snapshot.warehouses, "WAREHOUSES");
  idSet(snapshot.salePoints, "SALE_POINTS");
  const saleCenterIds = idSet(snapshot.saleCenters, "SALE_CENTERS");

  const configuredPriceLists = configuredIds(profile.priceListIds, "AGORA_MASTER_PROFILE_PRICE_LIST_INVALID");
  const configuredWarehouses = configuredIds(profile.warehouseIds, "AGORA_MASTER_PROFILE_WAREHOUSE_INVALID");
  const configuredVat = exactId(profile.vatId);
  const configuredPreparationType = exactId(profile.preparationTypeId);
  const configuredPreparationOrder = exactId(profile.preparationOrderId);
  if (!configuredVat || !configuredPreparationType || !configuredPreparationOrder) {
    throw new Error("AGORA_MASTER_PROFILE_OPERATIONAL_ROUTING_INVALID");
  }
  requireIds(configuredPriceLists, priceListIds, "AGORA_MASTER_PROFILE_PRICE_LIST_MISSING");
  requireIds(configuredWarehouses, warehouseIds, "AGORA_MASTER_PROFILE_WAREHOUSE_MISSING");
  requireIds([configuredVat], vatIds, "AGORA_MASTER_PROFILE_VAT_MISSING");
  requireIds([configuredPreparationType], preparationTypeIds, "AGORA_MASTER_PROFILE_PREPARATION_TYPE_MISSING");
  requireIds([configuredPreparationOrder], preparationOrderIds, "AGORA_MASTER_PROFILE_PREPARATION_ORDER_MISSING");

  const activePriceLists = new Set<string>();
  for (const center of snapshot.saleCenters) {
    const centerId = exactId(center.Id ?? center.id);
    if (!centerId || !saleCenterIds.has(centerId)) throw new Error("AGORA_MASTER_SALE_CENTER_INVALID");
    const candidates = [
      center.CurrentPriceListId,
      center.PriceListId,
      center.DefaultPriceListId,
    ].map(exactId).filter((id): id is string => id !== null);
    if (candidates.length === 0 || candidates.some((id) => !priceListIds.has(id))) {
      throw new Error("AGORA_MASTER_SALE_CENTER_PRICE_LIST_INVALID");
    }
    candidates.forEach((id) => activePriceLists.add(id));
  }
  if (!configuredPriceLists.some((id) => activePriceLists.has(id))) {
    throw new Error("AGORA_MASTER_PROFILE_PRICE_LIST_NOT_ACTIVE");
  }

  for (const point of snapshot.salePoints) {
    const centerId = exactId(point.SaleCenterId ?? point.CenterId ?? point.saleCenterId);
    if (!centerId || !saleCenterIds.has(centerId)) {
      throw new Error("AGORA_MASTER_SALE_POINT_CENTER_INVALID");
    }
  }
}

function safeFailureCode(error: unknown): string {
  if (error instanceof HttpAdapterError) return error.code;
  const message = error instanceof Error ? error.message : "";
  return /^AGORA_MASTER_[A-Z0-9_]+$/.test(message)
    ? message
    : "AGORA_MASTER_REFRESH_FAILED";
}

function failureDiagnostic(error: unknown, stage: string): RuntimeFailureDiagnosticInput {
  if (error instanceof HttpAdapterError) {
    return {
      operation: error.diagnostic.operation ?? "agora.master-refresh",
      route: error.diagnostic.path,
      httpStatus: error.diagnostic.status,
      elapsedMs: error.diagnostic.durationMs,
      errorCode: error.code,
    };
  }
  return {
    operation: "agora.master-refresh",
    route: `agora.master.${stage}`,
    errorCode: safeFailureCode(error),
  };
}

async function persistSnapshot(
  transaction: DatabaseTransaction,
  connectionId: string,
  snapshot: AgoraMasterSnapshot,
): Promise<void> {
  const lock = await transaction.query<{ locked: boolean }>(sql`
    SELECT pg_try_advisory_xact_lock(
      hashtextextended('agora-master-refresh:' || ${connectionId}, 0)
    ) AS locked
  `);
  if (lock.rowCount !== 1 || lock.rows[0]?.locked !== true) {
    throw new Error("AGORA_MASTER_REFRESH_BUSY");
  }
  const updated = await transaction.query<{ connection_id: string }>(sql`
    UPDATE public.agora_master_data
    SET
      families_json = ${JSON.stringify(snapshot.families)}::jsonb,
      products_summary_json = ${JSON.stringify(snapshot.products)}::jsonb,
      vats_json = ${JSON.stringify(snapshot.vats)}::jsonb,
      price_lists_json = ${JSON.stringify(snapshot.priceLists)}::jsonb,
      preparation_types_json = ${JSON.stringify(snapshot.preparationTypes)}::jsonb,
      preparation_orders_json = ${JSON.stringify(snapshot.preparationOrders)}::jsonb,
      warehouses_json = ${JSON.stringify(snapshot.warehouses)}::jsonb,
      sale_points_json = ${JSON.stringify(snapshot.salePoints)}::jsonb,
      sale_centers_json = ${JSON.stringify(snapshot.saleCenters)}::jsonb,
      fetched_at = ${snapshot.observedAt}::timestamptz,
      updated_at = now()
    WHERE connection_id = ${connectionId}::uuid
    RETURNING connection_id::text AS connection_id
  `);
  if (updated.rowCount !== 1 || updated.rows[0]?.connection_id !== connectionId) {
    throw new Error("AGORA_MASTER_REFRESH_NOT_PERSISTED");
  }
}

export function createAgoraMasterRefreshPort(
  options: AgoraMasterRefreshOptions,
): AgoraMasterRefreshPort {
  return Object.freeze({
    async refresh(input): Promise<AgoraMasterRefreshResult> {
      if (input.connectionId !== options.connectionId) {
        return {
          ok: false,
          httpStatus: 422,
          message: "AGORA_MASTER_CONNECTION_REJECTED",
          diagnostic: {
            operation: "agora.master-refresh",
            route: "agora.master.precondition",
            errorCode: "AGORA_MASTER_CONNECTION_REJECTED",
          },
        };
      }

      let stage = "profile";
      try {
        validateOperationalProfileShape(options.profile);
        stage = "credential";
        const credential = String(await input.credential.read()).trim();
        if (!credential || /[\r\n]/.test(credential)) throw new Error("AGORA_MASTER_CREDENTIAL_INVALID");
        const client = createAgoraReadOnlyClient({
          baseUrl: options.baseUrl,
          allowedHosts: options.allowedHosts,
          request: options.request,
          timer: options.timer,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          credential: { read: () => credential },
        });

        const values: Partial<Record<MasterDataset["column"], readonly JsonRecord[]>> = {};
        for (const dataset of MASTER_DATASETS) {
          stage = dataset.filter;
          const response = await client.exportMaster([dataset.filter]);
          if (!response.ok || response.status !== 200 || typeof response.body !== "string") {
            return {
              ok: false,
              httpStatus: response.status || 502,
              message: "AGORA_MASTER_HTTP_REJECTED",
              diagnostic: {
                operation: "agora.export.master",
                route: `/api/export-master/?filter=${dataset.filter}`,
                httpStatus: response.status || 502,
                errorCode: "AGORA_MASTER_HTTP_REJECTED",
              },
            };
          }
          values[dataset.column] = parseAgoraMasterRows(
            response.body,
            dataset.container,
            dataset.item,
          );
        }

        const observedAt = new Date(options.timer.now()).toISOString();
        const snapshot: AgoraMasterSnapshot = {
          families: values.families ?? [],
          products: values.products ?? [],
          vats: values.vats ?? [],
          priceLists: values.priceLists ?? [],
          preparationTypes: values.preparationTypes ?? [],
          preparationOrders: values.preparationOrders ?? [],
          warehouses: values.warehouses ?? [],
          salePoints: values.salePoints ?? [],
          saleCenters: values.saleCenters ?? [],
          observedAt,
        };
        stage = "validate";
        validateAgoraMasterSnapshot(snapshot, options.profile);
        stage = "persist";
        await options.database.transaction(
          (transaction) => persistSnapshot(transaction, input.connectionId, snapshot),
          { isolationLevel: "serializable" },
        );
        return { ok: true, outcome: "complete", changed: 1, observedAt };
      } catch (error) {
        const diagnostic = failureDiagnostic(error, stage);
        return {
          ok: false,
          httpStatus: diagnostic.httpStatus ?? 503,
          message: diagnostic.errorCode ?? "AGORA_MASTER_REFRESH_FAILED",
          retryableLine: diagnostic.errorCode === "AGORA_MASTER_REFRESH_BUSY",
          diagnostic,
        };
      }
    },
  });
}
