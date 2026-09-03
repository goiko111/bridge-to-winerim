import type { PosOutboundTransport } from "../../middleware-runtime/src/adapters/outbound";
import type {
  HttpRequestPort,
  SecretTextPort,
} from "../../middleware-runtime/src/adapters/http";
import type {
  OutboundExecutionResult,
  OutboundTask,
} from "../../middleware-runtime/src/handlers/outbound";

type JsonRecord = Record<string, unknown>;

const IMPORT_PATH = "/api/import/";
const MASTER_PATH = "/api/export-master/?filter=Products";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const POST_IMPORT_READBACK_DELAYS_MS = Object.freeze([500, 1_500]);
const SUPPORTED_TASK_TYPES = new Set([
  "AGORA_XML_UPSERT_PRODUCT",
  "AGORA_MIGRATE_FAMILY",
  "AGORA_HIDE_PRODUCT",
]);
const PRODUCT_READBACK_ATTRIBUTES = Object.freeze([
  "Id",
  "BaseSaleFormatId",
  "Name",
  "ButtonText",
  "Color",
  "FamilyId",
  "VatId",
  "UseAsDirectSale",
  "SaleableAsMain",
]);
const BOOLEAN_READBACK_ATTRIBUTES = new Set(["UseAsDirectSale", "SaleableAsMain"]);
const PRICE_READBACK_ATTRIBUTES = Object.freeze([
  "MainPrice",
  "AddinPrice",
  "MenuItemPrice",
]);

export type AgoraOutboundTransportOptions = Readonly<{
  connectionId: string;
  baseUrl: string;
  allowedHosts: readonly string[];
  credential: SecretTextPort;
  request: HttpRequestPort;
  timeoutMs?: number;
  maxResponseBytes?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}>;

type XmlProduct = Readonly<{
  id: string;
  xml: string;
  canonical: string;
  attrs: Readonly<Record<string, string>>;
}>;

type XmlToken = Readonly<{
  kind: "open" | "self" | "close";
  name: string;
  raw: string;
  start: number;
  end: number;
  depth: number;
  parentStart: number | null;
}>;

type XmlElement = Readonly<{
  name: string;
  start: number;
  end: number;
  depth: number;
  parentStart: number | null;
  openingRaw: string;
}>;

type XmlStructure = Readonly<{
  root: XmlElement;
  tokens: readonly XmlToken[];
  elements: readonly XmlElement[];
}>;

type PreparedMutation = Readonly<{
  xml: string;
  expected: readonly XmlProduct[];
  baseline?: readonly XmlProduct[];
}>;

type ReadResult =
  | { ok: true; products: ReadonlyMap<string, XmlProduct> }
  | { ok: false; result: OutboundExecutionResult };

class TransportBlocked extends Error {
  constructor(readonly reason: string, readonly detail?: string) {
    super(reason);
    this.name = "TransportBlocked";
  }
}

class TransportHttpFailure extends Error {
  constructor(
    readonly status: number | undefined,
    readonly operation: "IMPORT" | "READBACK",
    readonly timeout = false,
    readonly route?: string,
    readonly bodySample?: string,
  ) {
    super(`AGORA_${operation}_${timeout ? "TIMEOUT" : status === undefined ? "NETWORK_ERROR" : `HTTP_${status}`}`);
    this.name = "TransportHttpFailure";
  }
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function normalizedHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function validatedBaseUrl(options: AgoraOutboundTransportOptions): URL {
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    throw new TransportBlocked("AGORA_BASE_URL_INVALID");
  }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || (base.pathname !== "/" && base.pathname !== "")) {
    throw new TransportBlocked("AGORA_BASE_URL_INVALID");
  }
  const allowed = new Set(options.allowedHosts.map(normalizedHost).filter(Boolean));
  if (allowed.size === 0 || !allowed.has(normalizedHost(base.host))) {
    throw new TransportBlocked("AGORA_HOST_NOT_ALLOWLISTED");
  }
  base.pathname = "/";
  return base;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < min || selected > max) {
    throw new TransportBlocked("AGORA_TRANSPORT_LIMIT_INVALID");
  }
  return selected;
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function parseAttributes(tag: string): Record<string, string> {
  const start = /^<[A-Za-z_][\w:.-]*\b/.exec(tag);
  if (!start) throw new TransportBlocked("AGORA_XML_TAG_INVALID");
  const attrs: Record<string, string> = {};
  const source = tag.slice(start[0].length, tag.endsWith("/>") ? -2 : -1).trim();
  let cursor = 0;
  const attribute = /([A-Za-z_][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/gy;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? "")) cursor++;
    if (cursor >= source.length) break;
    attribute.lastIndex = cursor;
    const match = attribute.exec(source);
    if (!match || match.index !== cursor) throw new TransportBlocked("AGORA_XML_ATTRIBUTE_INVALID");
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(attrs, key)) {
      throw new TransportBlocked("AGORA_XML_ATTRIBUTE_DUPLICATE", key);
    }
    attrs[key] = decodeXml(match[2].slice(1, -1));
    cursor = attribute.lastIndex;
  }
  return attrs;
}

function tagEnd(xml: string, start: number): number {
  let quote: "\"" | "'" | null = null;
  for (let index = start + 1; index < xml.length; index++) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return index + 1;
  }
  throw new TransportBlocked("AGORA_XML_TAG_INVALID");
}

function parseXmlStructure(xml: string): XmlStructure {
  if (!xml.trim() || /\0|<!/i.test(xml)) throw new TransportBlocked("AGORA_XML_INVALID");

  const tokens: XmlToken[] = [];
  const elements: XmlElement[] = [];
  const stack: Array<{
    name: string;
    start: number;
    depth: number;
    parentStart: number | null;
    openingRaw: string;
  }> = [];
  let root: XmlElement | null = null;
  let cursor = 0;
  let declarationSeen = false;

  while (cursor < xml.length) {
    const opening = xml.indexOf("<", cursor);
    if (opening < 0) {
      if (xml.slice(cursor).trim()) throw new TransportBlocked("AGORA_XML_TEXT_NOT_SUPPORTED");
      break;
    }
    if (xml.slice(cursor, opening).trim()) throw new TransportBlocked("AGORA_XML_TEXT_NOT_SUPPORTED");

    if (xml.startsWith("<?", opening)) {
      const end = xml.indexOf("?>", opening + 2);
      if (end < 0 || declarationSeen || tokens.length > 0 ||
          !/^<\?xml\s+[^?]*\?>$/i.test(xml.slice(opening, end + 2))) {
        throw new TransportBlocked("AGORA_XML_PROCESSING_INSTRUCTION_INVALID");
      }
      declarationSeen = true;
      cursor = end + 2;
      continue;
    }

    const end = tagEnd(xml, opening);
    const raw = xml.slice(opening, end);
    const close = /^<\/([A-Za-z_][\w:.-]*)\s*>$/.exec(raw);
    if (close) {
      const current = stack.pop();
      if (!current || current.name !== close[1]) throw new TransportBlocked("AGORA_XML_NESTING_INVALID");
      tokens.push({
        kind: "close",
        name: close[1],
        raw,
        start: opening,
        end,
        depth: current.depth,
        parentStart: current.parentStart,
      });
      const element: XmlElement = {
        name: current.name,
        start: current.start,
        end,
        depth: current.depth,
        parentStart: current.parentStart,
        openingRaw: current.openingRaw,
      };
      elements.push(element);
      if (current.depth === 0) {
        if (root) throw new TransportBlocked("AGORA_XML_ROOT_INVALID");
        root = element;
      }
      cursor = end;
      continue;
    }

    const open = /^<([A-Za-z_][\w:.-]*)\b[\s\S]*>$/.exec(raw);
    if (!open) throw new TransportBlocked("AGORA_XML_TAG_INVALID");
    parseAttributes(raw);
    const selfClosing = /\/\s*>$/.test(raw);
    const depth = stack.length;
    const parentStart = stack.at(-1)?.start ?? null;
    tokens.push({
      kind: selfClosing ? "self" : "open",
      name: open[1],
      raw,
      start: opening,
      end,
      depth,
      parentStart,
    });
    if (selfClosing) {
      const element: XmlElement = {
        name: open[1],
        start: opening,
        end,
        depth,
        parentStart,
        openingRaw: raw,
      };
      elements.push(element);
      if (depth === 0) {
        if (root) throw new TransportBlocked("AGORA_XML_ROOT_INVALID");
        root = element;
      }
    } else {
      stack.push({ name: open[1], start: opening, depth, parentStart, openingRaw: raw });
    }
    cursor = end;
  }

  if (stack.length > 0) throw new TransportBlocked("AGORA_XML_NESTING_INVALID");
  if (!root || elements.filter((element) => element.depth === 0).length !== 1) {
    throw new TransportBlocked("AGORA_XML_ROOT_INVALID");
  }
  return { root, tokens, elements };
}

function openingTag(xml: string): string {
  const structure = parseXmlStructure(xml.trim());
  if (structure.root.name !== "Product") throw new TransportBlocked("AGORA_PRODUCT_XML_INVALID");
  return structure.root.openingRaw;
}

function canonicalTag(tag: string): string {
  const close = /^<\/([A-Za-z_][\w:.-]*)\s*>$/.exec(tag);
  if (close) return `</${close[1]}>`;
  const open = /^<([A-Za-z_][\w:.-]*)\b/.exec(tag);
  if (!open) throw new TransportBlocked("AGORA_XML_TAG_INVALID");
  const attrs = parseAttributes(tag);
  const serialized = Object.keys(attrs).sort().map((key) => `${key}=${JSON.stringify(attrs[key])}`).join(";");
  return `<${open[1]}${serialized ? ` ${serialized}` : ""}${tag.endsWith("/>") ? "/" : ""}>`;
}

function canonicalElement(xml: string): string {
  const structure = parseXmlStructure(xml);
  if (structure.root.name !== "Product") throw new TransportBlocked("AGORA_PRODUCT_XML_INVALID");
  return structure.tokens.map((token) => canonicalTag(token.raw)).join("");
}

function parseSingleProduct(productXml: string): XmlProduct {
  const attrs = parseAttributes(openingTag(productXml));
  const id = String(attrs.Id ?? "").trim();
  if (!id || !/^\d+$/.test(id)) throw new TransportBlocked("AGORA_PRODUCT_ID_INVALID");
  return {
    id,
    xml: productXml.trim(),
    canonical: canonicalElement(productXml.trim()),
    attrs,
  };
}

const JSON_PRODUCT_ATTRIBUTES = Object.freeze([
  "Order", "Id", "BaseSaleFormatId", "Name", "ButtonText", "Color", "PLU", "FamilyId", "VatId",
  "UseAsDirectSale", "SaleableAsMain", "SaleableAsAddin", "IsSoldByWeight",
  "AskForPreparationNotes", "AskForAddins", "PrintWhenPriceIsZero",
  "PreparationTypeId", "PreparationOrderId", "CostPrice",
]);
const JSON_PRICE_ATTRIBUTES = Object.freeze([
  "PriceListId", "MainPrice", "AddinPrice", "MenuItemPrice",
]);
const JSON_COST_PRICE_ATTRIBUTES = Object.freeze(["WarehouseId", "CostPrice"]);
const MONEY_ATTRIBUTES = new Set(["MainPrice", "AddinPrice", "MenuItemPrice", "CostPrice"]);

function jsonAttributeValue(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TransportBlocked("AGORA_PRODUCT_JSON_INVALID");
    return MONEY_ATTRIBUTES.has(name) ? value.toFixed(2) : String(value);
  }
  if (typeof value === "string") return value;
  throw new TransportBlocked("AGORA_PRODUCT_JSON_INVALID");
}

function jsonAttributes(source: JsonRecord, names: readonly string[]): string {
  return names.flatMap((name) => {
    const value = jsonAttributeValue(name, source[name]);
    return value === undefined ? [] : [`${name}="${escapeXml(value)}"`];
  }).join(" ");
}

function jsonProductXml(value: unknown): string {
  const product = record(value);
  const attrs = jsonAttributes(product, JSON_PRODUCT_ATTRIBUTES);
  if (!attrs || !/^\d+$/.test(String(product.Id ?? ""))) {
    throw new TransportBlocked("AGORA_PRODUCT_JSON_INVALID");
  }
  const prices = Array.isArray(product.Prices)
    ? product.Prices.map((price) => `<Price ${jsonAttributes(record(price), JSON_PRICE_ATTRIBUTES)} />`).join("")
    : "";
  const costs = Array.isArray(product.CostPrices)
    ? product.CostPrices.map((cost) => `<CostPrice ${jsonAttributes(record(cost), JSON_COST_PRICE_ATTRIBUTES)} />`).join("")
    : "";
  return `<Product ${attrs}><Prices>${prices}</Prices><CostPrices>${costs}</CostPrices></Product>`;
}

function extractJsonProducts(payload: string): XmlProduct[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new TransportBlocked("AGORA_PRODUCT_JSON_INVALID");
  }
  const root = record(parsed);
  if (!Array.isArray(root.Products)) throw new TransportBlocked("AGORA_PRODUCTS_CONTAINER_INVALID");
  const seen = new Set<string>();
  return root.Products.map((value) => {
    const product = parseSingleProduct(jsonProductXml(value));
    if (seen.has(product.id)) throw new TransportBlocked("AGORA_PRODUCT_ID_DUPLICATE", product.id);
    seen.add(product.id);
    return product;
  });
}

function extractMasterProducts(payload: string): XmlProduct[] {
  const trimmed = payload.trim();
  return trimmed.startsWith("{")
    ? extractJsonProducts(trimmed)
    : extractProducts(trimmed, { allowEmpty: true });
}

function extractProducts(
  xml: string,
  options: Readonly<{
    allowEmpty?: boolean;
    expectedRoot?: string;
    onlyProductsRootChild?: boolean;
  }> = {},
): XmlProduct[] {
  const structure = parseXmlStructure(xml);
  if (options.expectedRoot && structure.root.name !== options.expectedRoot) {
    throw new TransportBlocked("AGORA_PRODUCT_XML_INVALID");
  }
  const containers = structure.elements.filter((element) => element.name === "Products");
  if (containers.length !== 1) throw new TransportBlocked("AGORA_PRODUCTS_CONTAINER_INVALID");
  const [container] = containers;
  if (container.depth !== 1 || container.parentStart !== structure.root.start) {
    throw new TransportBlocked("AGORA_PRODUCTS_CONTAINER_INVALID");
  }
  const directChildren = structure.elements
    .filter((element) => element.parentStart === container.start)
    .sort((left, right) => left.start - right.start);
  if (directChildren.some((element) => element.name !== "Product")) {
    throw new TransportBlocked("AGORA_PRODUCTS_CHILD_INVALID");
  }
  const allProducts = structure.elements.filter((element) => element.name === "Product");
  if (allProducts.some((element) => element.parentStart !== container.start)) {
    throw new TransportBlocked("AGORA_PRODUCT_OUTSIDE_CONTAINER");
  }
  if (options.onlyProductsRootChild) {
    const rootChildren = structure.elements.filter((element) => element.parentStart === structure.root.start);
    if (rootChildren.length !== 1 || rootChildren[0].start !== container.start) {
      throw new TransportBlocked("AGORA_UPSERT_IMPORT_XML_AMBIGUOUS");
    }
  }
  if (!options.allowEmpty && directChildren.length === 0) {
    throw new TransportBlocked("AGORA_PRODUCT_XML_INVALID");
  }
  const seen = new Set<string>();
  return directChildren.map((element) => {
    const productXml = xml.slice(element.start, element.end);
    const product = parseSingleProduct(productXml);
    if (seen.has(product.id)) throw new TransportBlocked("AGORA_PRODUCT_ID_DUPLICATE", product.id);
    seen.add(product.id);
    return product;
  });
}

function exactIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new TransportBlocked("AGORA_EXPECTED_PRODUCT_IDS_REQUIRED");
  const ids = value.map((entry) => String(entry ?? "").trim());
  if (ids.some((id) => !/^\d+$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new TransportBlocked("AGORA_EXPECTED_PRODUCT_IDS_INVALID");
  }
  return [...ids].sort((left, right) => Number(left) - Number(right));
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function importEnvelope(products: readonly XmlProduct[]): string {
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n  <Products>\n${products.map((product) => `    ${product.xml}`).join("\n")}\n  </Products>\n</Import>`;
}

function setProductAttribute(product: XmlProduct, name: string, value: string): XmlProduct {
  const escaped = escapeXml(value);
  const matcher = new RegExp(`\\b${name}\\s*=\\s*("[^"]*"|'[^']*')`, "i");
  let xml: string;
  if (matcher.test(openingTag(product.xml))) {
    xml = product.xml.replace(matcher, `${name}="${escaped}"`);
  } else {
    xml = product.xml.replace(/^<Product\b([^>]*?)(\/?>)/i, `<Product$1 ${name}="${escaped}"$2`);
  }
  const updated = parseSingleProduct(xml);
  if (updated.id !== product.id) throw new TransportBlocked("AGORA_PRODUCT_PATCH_INVALID");
  return updated;
}

function comparableBoolean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1"].includes(normalized)) return "true";
  if (["false", "0"].includes(normalized)) return "false";
  return normalized;
}

function comparableMoney(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(4) : value.trim();
}

function priceContracts(product: XmlProduct): ReadonlyMap<string, Readonly<Record<string, string>>> {
  const structure = parseXmlStructure(product.xml);
  const productRoot = structure.elements.find((element) => element.name === "Product");
  if (!productRoot) throw new TransportBlocked("AGORA_PRODUCT_PRICES_INVALID", product.id);
  const prices = structure.elements.filter((element) => (
    element.name === "Prices" && element.parentStart === productRoot.start
  ));
  if (prices.length !== 1) throw new TransportBlocked("AGORA_PRODUCT_PRICES_INVALID", product.id);
  const [container] = prices;
  const contracts = new Map<string, Readonly<Record<string, string>>>();
  for (const price of structure.elements.filter((element) => (
    element.name === "Price" && element.parentStart === container.start
  ))) {
    const attrs = parseAttributes(price.openingRaw);
    const priceListId = String(attrs.PriceListId ?? "").trim();
    if (!priceListId || contracts.has(priceListId)) {
      throw new TransportBlocked("AGORA_PRODUCT_PRICES_INVALID", product.id);
    }
    contracts.set(priceListId, attrs);
  }
  return contracts;
}

function productContractMismatch(expected: XmlProduct, observed: XmlProduct): string | null {
  for (const name of PRODUCT_READBACK_ATTRIBUTES) {
    if (name === "BaseSaleFormatId" && expected.attrs[name] === undefined) continue;
    const expectedValue = BOOLEAN_READBACK_ATTRIBUTES.has(name)
      ? comparableBoolean(expected.attrs[name])
      : expected.attrs[name];
    const observedValue = BOOLEAN_READBACK_ATTRIBUTES.has(name)
      ? comparableBoolean(observed.attrs[name])
      : observed.attrs[name];
    if (expectedValue !== observedValue) {
      return `attribute:${name}:expected=${expectedValue ?? "missing"}:observed=${observedValue ?? "missing"}`;
    }
  }

  const expectedPrices = priceContracts(expected);
  const observedPrices = priceContracts(observed);
  const expectedPriceListIds = [...expectedPrices.keys()].sort();
  const observedPriceListIds = [...observedPrices.keys()].sort();
  const missingPriceListIds = expectedPriceListIds.filter((priceListId) => !observedPrices.has(priceListId));
  if (missingPriceListIds.length > 0) {
    return `prices:missing=${missingPriceListIds.join(",")}:observed=${observedPriceListIds.join(",")}`;
  }
  for (const priceListId of expectedPriceListIds) {
    const expectedPrice = expectedPrices.get(priceListId)!;
    const observedPrice = observedPrices.get(priceListId)!;
    for (const name of PRICE_READBACK_ATTRIBUTES) {
      if (expectedPrice[name] === undefined) continue;
      const expectedValue = comparableMoney(expectedPrice[name]);
      const observedValue = comparableMoney(observedPrice[name]);
      if (expectedValue !== observedValue) {
        return `price:${priceListId}:${name}:expected=${expectedValue ?? "missing"}:observed=${observedValue ?? "missing"}`;
      }
    }
  }
  return null;
}

function productsMatch(expected: readonly XmlProduct[], actual: ReadonlyMap<string, XmlProduct>): boolean {
  return expected.every((product) => {
    const observed = actual.get(product.id);
    return observed ? productContractMismatch(product, observed) === null : false;
  });
}

function productMismatchDetail(
  expected: readonly XmlProduct[],
  actual: ReadonlyMap<string, XmlProduct>,
): string {
  for (const product of expected) {
    const observed = actual.get(product.id);
    if (!observed) return `${product.id}:missing`;
    const mismatch = productContractMismatch(product, observed);
    if (mismatch) return `${product.id}:${mismatch}`.slice(0, 500);
  }
  return expected.map((product) => product.id).join(",");
}

function preserveExistingOrder(
  prepared: PreparedMutation,
  master: ReadonlyMap<string, XmlProduct>,
): PreparedMutation {
  const expected = prepared.expected.map((product) => {
    const existingOrder = master.get(product.id)?.attrs.Order?.trim();
    return existingOrder && /^\d+$/.test(existingOrder)
      ? setProductAttribute(product, "Order", existingOrder)
      : product;
  });
  return { ...prepared, expected, xml: importEnvelope(expected) };
}

function blocked(reason: string, detail?: string): OutboundExecutionResult {
  return { kind: "blocked", reason, ...(detail ? { detail } : {}) };
}

function failure(error: TransportHttpFailure): OutboundExecutionResult {
  return {
    kind: "failure",
    failure: {
      ...(error.status === undefined ? {} : { httpStatus: error.status }),
      message: error.message,
      diagnostic: {
        operation: `agora.${error.operation.toLowerCase()}`,
        ...(error.route ? { route: error.route } : {}),
        ...(error.status === undefined ? {} : { httpStatus: error.status }),
        errorCode: error.message,
        ...(error.bodySample ? { bodySample: error.bodySample } : {}),
      },
    },
  };
}

function validateTask(
  task: OutboundTask,
  context: Readonly<{ idempotencyKey: string; attempt: number; maxAttempts: number }>,
  connectionId: string,
): JsonRecord {
  if (!SUPPORTED_TASK_TYPES.has(task.taskType)) throw new TransportBlocked("AGORA_OUTBOUND_TASK_UNSUPPORTED");
  if (!task.id.trim() || task.connectionId !== connectionId || task.provider.trim().toLowerCase() !== "agora") {
    throw new TransportBlocked("AGORA_OUTBOUND_TASK_IDENTITY_INVALID");
  }
  const expectedKey = task.idempotencyKey?.trim() || `outbound-task:${task.id}`;
  if (context.idempotencyKey !== expectedKey || context.attempt !== task.attempts ||
      context.maxAttempts !== task.maxAttempts) {
    throw new TransportBlocked("AGORA_OUTBOUND_EXECUTION_CONTEXT_INVALID");
  }
  return record(task.payload);
}

function prepareUpsert(payload: JsonRecord): PreparedMutation {
  const xml = typeof payload._import_xml === "string" ? payload._import_xml.trim() : "";
  if (!xml) throw new TransportBlocked("AGORA_UPSERT_IMPORT_XML_REQUIRED");
  if (new TextEncoder().encode(xml).byteLength > MAX_IMPORT_BYTES) {
    throw new TransportBlocked("AGORA_UPSERT_IMPORT_XML_TOO_LARGE");
  }
  const expected = extractProducts(xml, {
    expectedRoot: "Import",
    onlyProductsRootChild: true,
  });
  if (expected.length !== 1) throw new TransportBlocked("AGORA_MULTI_PRODUCT_MUTATION_REJECTED");
  const payloadIds = exactIds(payload._expected_product_ids);
  const xmlIds = expected.map((product) => product.id).sort((left, right) => Number(left) - Number(right));
  if (!sameIds(payloadIds, xmlIds)) throw new TransportBlocked("AGORA_UPSERT_PRODUCT_IDS_MISMATCH");
  return { xml, expected };
}

function requiredId(value: unknown, reason: string): string {
  const id = String(value ?? "").trim();
  if (!/^\d+$/.test(id)) throw new TransportBlocked(reason);
  return id;
}

function findAllProducts(master: ReadonlyMap<string, XmlProduct>, ids: readonly string[]): XmlProduct[] {
  const products = ids.map((id) => master.get(id)).filter((product): product is XmlProduct => !!product);
  if (products.length !== ids.length) {
    const missing = ids.filter((id) => !master.has(id));
    throw new TransportBlocked("AGORA_MASTER_PRODUCT_MISSING", missing.join(","));
  }
  return products;
}

function prepareFromMaster(task: OutboundTask, payload: JsonRecord, master: ReadonlyMap<string, XmlProduct>): PreparedMutation {
  if (task.taskType === "AGORA_MIGRATE_FAMILY") {
    const productId = requiredId(payload.productId ?? task.externalId, "AGORA_MIGRATE_PRODUCT_ID_REQUIRED");
    const targetFamilyId = requiredId(payload.targetFamilyId, "AGORA_MIGRATE_FAMILY_ID_REQUIRED");
    const [current] = findAllProducts(master, [productId]);
    const expected = [setProductAttribute(current, "FamilyId", targetFamilyId)];
    return { xml: importEnvelope(expected), expected, baseline: [current] };
  }

  if (task.taskType === "AGORA_HIDE_PRODUCT") {
    const ids = exactIds(payload._product_ids);
    if (ids.length !== 1) throw new TransportBlocked("AGORA_MULTI_PRODUCT_MUTATION_REJECTED");
    const expected = findAllProducts(master, ids).map((product) =>
      setProductAttribute(setProductAttribute(product, "UseAsDirectSale", "false"), "SaleableAsMain", "false")
    );
    return { xml: importEnvelope(expected), expected, baseline: findAllProducts(master, ids) };
  }

  throw new TransportBlocked("AGORA_OUTBOUND_PREPARATION_INVALID");
}

async function apiToken(credential: SecretTextPort): Promise<string> {
  let token: string;
  try {
    token = String(await credential.read()).trim();
  } catch {
    throw new TransportBlocked("AGORA_CREDENTIAL_UNAVAILABLE");
  }
  if (!token || /[\r\n]/.test(token)) throw new TransportBlocked("AGORA_CREDENTIAL_UNAVAILABLE");
  return token;
}

async function responseText(response: Response, maximum: number, timeoutMs: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximum) {
    await response.body?.cancel().catch(() => undefined);
    throw new TransportBlocked("AGORA_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async (): Promise<string> => {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        received += result.value.byteLength;
        if (received > maximum) {
          await reader.cancel().catch(() => undefined);
          throw new TransportBlocked("AGORA_RESPONSE_TOO_LARGE");
        }
        chunks.push(decoder.decode(result.value, { stream: true }));
      }
      chunks.push(decoder.decode());
      return chunks.join("");
    };
    return await Promise.race([
      read(),
      new Promise<string>((_, reject) => {
        handle = setTimeout(() => {
          reject(new TransportHttpFailure(408, "READBACK", true));
          void reader.cancel().catch(() => undefined);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof TransportHttpFailure) throw error;
    if (error instanceof TransportBlocked) throw error;
    throw new TransportBlocked("AGORA_RESPONSE_UNREADABLE");
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

async function requestWithTimeout(
  request: HttpRequestPort,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  operation: "IMPORT" | "READBACK",
): Promise<Response> {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request.request(url.toString(), { ...init, redirect: "manual", signal: controller.signal });
  } catch {
    throw new TransportHttpFailure(
      controller.signal.aborted ? 408 : undefined,
      operation,
      controller.signal.aborted,
      `${init.method ?? "GET"} ${url.pathname}${url.search}`,
    );
  } finally {
    clearTimeout(handle);
  }
}

async function failureBodySample(response: Response, timeoutMs: number): Promise<string | undefined> {
  try {
    const text = await responseText(response, 4096, timeoutMs);
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized ? normalized.slice(0, 256) : undefined;
  } catch {
    return undefined;
  }
}

async function readMaster(input: Readonly<{
  base: URL;
  token: string;
  request: HttpRequestPort;
  timeoutMs: number;
  maxResponseBytes: number;
}>): Promise<ReadResult> {
  try {
    const response = await requestWithTimeout(
      input.request,
      new URL(MASTER_PATH, input.base),
      { method: "GET", headers: { Accept: "application/xml, text/xml", "Api-Token": input.token } },
      input.timeoutMs,
      "READBACK",
    );
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, result: blocked("AGORA_READBACK_REDIRECT_BLOCKED") };
    }
    if (!response.ok) {
      return {
        ok: false,
        result: failure(new TransportHttpFailure(
          response.status,
          "READBACK",
          false,
          `GET ${MASTER_PATH}`,
          await failureBodySample(response, input.timeoutMs),
        )),
      };
    }
    const body = await responseText(response, input.maxResponseBytes, input.timeoutMs);
    const products = extractMasterProducts(body);
    return { ok: true, products: new Map(products.map((product) => [product.id, product])) };
  } catch (error) {
    if (error instanceof TransportHttpFailure) return { ok: false, result: failure(error) };
    if (error instanceof TransportBlocked) return { ok: false, result: blocked(error.reason, error.detail) };
    return { ok: false, result: blocked("AGORA_READBACK_INVALID") };
  }
}

async function postImport(input: Readonly<{
  base: URL;
  token: string;
  xml: string;
  request: HttpRequestPort;
  timeoutMs: number;
}>): Promise<OutboundExecutionResult | null> {
  try {
    const response = await requestWithTimeout(
      input.request,
      new URL(IMPORT_PATH, input.base),
      {
        method: "POST",
        headers: {
          Accept: "application/xml, text/xml",
          "Content-Type": "application/xml; charset=utf-8",
          "Api-Token": input.token,
        },
        body: input.xml,
      },
      input.timeoutMs,
      "IMPORT",
    );
    if (response.status >= 300 && response.status < 400) return blocked("AGORA_IMPORT_REDIRECT_BLOCKED");
    return response.ok ? null : failure(new TransportHttpFailure(
      response.status,
      "IMPORT",
      false,
      `POST ${IMPORT_PATH}`,
      await failureBodySample(response, input.timeoutMs),
    ));
  } catch (error) {
    if (error instanceof TransportHttpFailure) return failure(error);
    return blocked("AGORA_IMPORT_UNAVAILABLE");
  }
}

function superseded(task: OutboundTask, ids: readonly string[]): OutboundExecutionResult {
  return {
    kind: "superseded",
    evidence: {
      verified: true,
      taskId: task.id,
      connectionId: task.connectionId,
      observedAt: new Date().toISOString(),
      source: "provider_readback",
      detail: `agora-products-already-match:${ids.join(",")}`,
    },
  };
}

export function createAgoraOutboundTransport(options: AgoraOutboundTransportOptions): PosOutboundTransport {
  let base: URL;
  let timeoutMs: number;
  let maxResponseBytes: number;
  try {
    if (!options.connectionId.trim()) throw new TransportBlocked("AGORA_CONNECTION_ID_INVALID");
    base = validatedBaseUrl(options);
    timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 60_000);
    maxResponseBytes = boundedInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1, 32 * 1024 * 1024);
  } catch (error) {
    const result = error instanceof TransportBlocked
      ? blocked(error.reason, error.detail)
      : blocked("AGORA_TRANSPORT_CONFIGURATION_INVALID");
    return Object.freeze({ execute: async () => result });
  }

  return Object.freeze({
    async execute({ task, context }): Promise<OutboundExecutionResult> {
      try {
        const payload = validateTask(task, context, options.connectionId);

        let prepared: PreparedMutation;
        if (task.taskType === "AGORA_XML_UPSERT_PRODUCT") {
          prepared = prepareUpsert(payload);
        }

        const token = await apiToken(options.credential);
        const reader = { base, token, request: options.request, timeoutMs, maxResponseBytes };
        if (task.taskType !== "AGORA_XML_UPSERT_PRODUCT") {
          const before = await readMaster(reader);
          if (!before.ok) return before.result;
          prepared = prepareFromMaster(task, payload, before.products);
        }

        const expectedIds = prepared.expected.map((product) => product.id);
        const before = await readMaster(reader);
        if (!before.ok) return before.result;
        if (task.taskType === "AGORA_XML_UPSERT_PRODUCT") {
          prepared = preserveExistingOrder(prepared, before.products);
        }
        if (productsMatch(prepared.expected, before.products)) return superseded(task, expectedIds);
        if (prepared.baseline && !productsMatch(prepared.baseline, before.products)) {
          return blocked("AGORA_PRECONDITION_DRIFT", expectedIds.join(","));
        }

        const importFailure = await postImport({ ...reader, xml: prepared.xml });
        if (importFailure) return importFailure;

        let lastProducts = before.products;
        for (let attempt = 0; attempt <= POST_IMPORT_READBACK_DELAYS_MS.length; attempt += 1) {
          if (attempt > 0) {
            await (options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(
              POST_IMPORT_READBACK_DELAYS_MS[attempt - 1],
            );
          }
          const after = await readMaster(reader);
          if (!after.ok) return after.result;
          lastProducts = after.products;
          if (productsMatch(prepared.expected, after.products)) {
            return {
              kind: "success",
              ...(expectedIds.length === 1 ? { externalId: expectedIds[0] } : {}),
              detail: `agora-import-readback-verified:${expectedIds.join(",")}`,
            };
          }
        }
        return blocked("AGORA_READBACK_MISMATCH", productMismatchDetail(prepared.expected, lastProducts));
      } catch (error) {
        if (error instanceof TransportBlocked) return blocked(error.reason, error.detail);
        if (error instanceof TransportHttpFailure) return failure(error);
        return blocked("AGORA_OUTBOUND_TRANSPORT_INVALID");
      }
    },
  });
}
