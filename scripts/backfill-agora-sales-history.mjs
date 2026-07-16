#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import process from "node:process";

const REQUEST_GAP_MS = 520;
const MAX_RANGE_DAYS = 120;
const WINERIM_API_BASE = "https://app.winerim.com/api/v2";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index++;
    }
  }
  return args;
}

function required(args, key) {
  const value = String(args[key] || "").trim();
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function isDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function addDays(day, amount) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function dayRange(fromDay, toDay) {
  if (!isDay(fromDay) || !isDay(toDay) || fromDay > toDay) {
    throw new Error("--from and --to must be a valid ascending YYYY-MM-DD range");
  }
  const days = [];
  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) {
    days.push(day);
    if (days.length > MAX_RANGE_DAYS) {
      throw new Error(`Date range exceeds ${MAX_RANGE_DAYS} days`);
    }
  }
  return days;
}

function decodeAgoraText(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#0*39;/g, "'")
    .replace(/&nbsp;/gi, " ");
}

export function normalizeHistoricalWineName(value) {
  return decodeAgoraText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^\s*(botella|bot\.?|bottle|copa|glass|magnum|mag\.?|[bcm]\.?)\s+/, "")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b(botella|bot\.?|bottle|copa|glass|magnum|75\s*cl|150\s*cl|37[,.]5\s*cl)\b/g, " ")
    .replace(/&/g, " y ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeHistoricalAliasLabel(value) {
  return decodeAgoraText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^\s*([bcm])\.?\s+/, "$1 ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/&/g, " y ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function inferHistoricalVariant(productName, saleFormatName) {
  const format = decodeAgoraText(saleFormatName)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const name = decodeAgoraText(productName)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  if (/\b(copa|glass|by the glass)\b/.test(format)) return "GLASS";
  if (/\b(magnum|mag)\b/.test(format)) return "MAGNUM";
  if (/\b(botella|bottle|bot\.)\b/.test(format)) return "BOTTLE";
  if (/^(c\.?|copa)\s+/.test(name)) return "GLASS";
  if (/^(m\.?|magnum|mag\.?)\s+/.test(name)) return "MAGNUM";
  return "BOTTLE";
}

export function normalizeHistoricalAliasDefinitions(definitions) {
  if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) {
    return [];
  }

  const aliases = [];
  for (const [legacyName, rawTarget] of Object.entries(definitions)) {
    const target = rawTarget && typeof rawTarget === "object" && !Array.isArray(rawTarget)
      ? rawTarget
      : { winerimId: rawTarget };
    const winerimId = String(target.winerimId ?? target.winerim_id ?? "").trim();
    if (!winerimId) continue;

    const explicitVariant = String(target.variant || "").trim().toUpperCase();
    const variant = explicitVariant || inferHistoricalVariant(legacyName, legacyName);
    if (!["BOTTLE", "GLASS", "MAGNUM"].includes(variant)) {
      throw new Error(`Invalid historical alias variant for "${legacyName}": ${variant}`);
    }

    aliases.push({
      legacyName,
      normalizedLabel: normalizeHistoricalAliasLabel(legacyName),
      winerimId,
      variant,
    });
  }
  return aliases;
}

export function resolveHistoricalAlias(aliasMap, productName, inferredVariant) {
  const aliases = aliasMap.get(normalizeHistoricalAliasLabel(productName)) || [];
  const matchingVariant = aliases.filter((alias) => alias.variant === inferredVariant);
  const candidates = matchingVariant.length > 0 ? matchingVariant : aliases;
  const unique = new Map(
    candidates.map((alias) => [`${alias.wine.winerim_id}|${alias.variant}`, alias]),
  );
  return unique.size === 1 ? Array.from(unique.values())[0] : null;
}

export function netHistoricalCandidates(rawCandidates) {
  const grouped = new Map();
  for (const sale of rawCandidates) {
    if (!grouped.has(sale.lifecycleKey)) {
      grouped.set(sale.lifecycleKey, {
        rows: [],
        quantity: 0,
        providerTotalAmount: 0,
        positiveQuantity: 0,
        negativeQuantity: 0,
      });
    }
    const group = grouped.get(sale.lifecycleKey);
    group.rows.push(sale);
    group.quantity += Number(sale.qty || 0);
    group.providerTotalAmount += Number(sale.audit?.providerTotalAmount || 0);
    if (sale.qty > 0) group.positiveQuantity += sale.qty;
    if (sale.qty < 0) group.negativeQuantity += Math.abs(sale.qty);
  }

  const candidates = [];
  const netted = [];
  const negative = [];
  for (const [lifecycleKey, group] of grouped) {
    const positiveRows = group.rows.filter((sale) => sale.qty > 0);
    const base = positiveRows[0] || group.rows[0];
    const audit = {
      ...base.audit,
      providerTotalAmount: group.providerTotalAmount,
      sourceDocumentIds: Array.from(new Set(
        group.rows.map((sale) => sale.audit?.documentId).filter(Boolean),
      )),
      grossPositiveQty: group.positiveQuantity,
      grossNegativeQty: group.negativeQuantity,
    };
    if (group.negativeQuantity > 0 || positiveRows.length > 1) {
      netted.push({
        lifecycleKey,
        quantity: group.quantity,
        positiveQuantity: group.positiveQuantity,
        negativeQuantity: group.negativeQuantity,
        audit,
      });
    }
    if (group.quantity > 0) {
      candidates.push({
        ...base,
        qty: group.quantity,
        audit,
      });
    } else if (group.quantity < 0) {
      negative.push({
        lifecycleKey,
        quantity: group.quantity,
        audit,
      });
    }
  }
  return { candidates, netted, negative };
}

function stableHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizedExternalId(value, fallback) {
  const normalized = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return normalized || fallback;
}

function buildHistoricalOrderId({
  connectionId,
  businessDay,
  documentId,
  lineKey,
  wineId,
  variant,
}) {
  const scope = [
    connectionId,
    businessDay,
    documentId,
    lineKey,
    wineId,
    variant,
  ].join("|");
  return [
    "agora-history",
    normalizedExternalId(connectionId, "connection").slice(0, 8),
    businessDay,
    normalizedExternalId(documentId, "document"),
    normalizedExternalId(lineKey, "line"),
    stableHash(scope),
  ].join(":");
}

function parseInvoices(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.Invoices)) return payload.Invoices;
  if (Array.isArray(payload.Data?.Invoices)) return payload.Data.Invoices;
  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function invoiceDocumentId(invoice, day, index) {
  const globalId = String(invoice.GlobalId || invoice.InvoiceGlobalId || "").trim();
  if (globalId) return globalId;
  const serie = String(invoice.Serie || invoice.Series || "").trim();
  const number = String(invoice.Number || invoice.InvoiceNumber || invoice.Id || "").trim();
  if (number) return `${serie || "invoice"}-${number}`;
  return `${day}-${index}`;
}

function providerSoldAt(line, item, invoice, day) {
  const candidates = [
    line?.CreationDate,
    line?.Date,
    item?.CreationDate,
    item?.Date,
    invoice?.CreationDate,
    invoice?.Date,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value && Number.isFinite(Date.parse(value))) return value;
  }
  return `${day}T12:00:00`;
}

function stockIdForVariant(wine, variant) {
  const value = variant === "GLASS"
    ? wine.glass_stock_id
    : variant === "MAGNUM"
      ? wine.magnum_stock_id
      : wine.bottle_stock_id;
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, init = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`${response.status}: ${text.slice(0, 250)}`);
      }
      return text.trim() ? JSON.parse(text) : null;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(750 * attempt);
    }
  }
  throw lastError;
}

async function fetchAllRows(restBase, headers, table, select, connectionId) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const query = new URLSearchParams({
      select,
      connection_id: `eq.${connectionId}`,
      limit: "1000",
      offset: String(offset),
    });
    const page = await fetchJson(`${restBase}/${table}?${query}`, { headers });
    rows.push(...(page || []));
    if (!page || page.length < 1000) break;
  }
  return rows;
}

function buildResolutionMap(wines, trackingRows, mappingRows) {
  const wineById = new Map(wines.map((wine) => [String(wine.winerim_id), wine]));
  const resolutionMap = new Map();
  for (const row of trackingRows) {
    if (!row.agora_product_id || !row.winerim_wine_id) continue;
    if (!["VERIFIED", "PUSHED"].includes(String(row.sync_status || ""))) continue;
    const wine = wineById.get(String(row.winerim_wine_id));
    if (!wine) continue;
    resolutionMap.set(String(row.agora_product_id), {
      wine,
      variant: String(row.format || "BOTTLE").toUpperCase(),
      method: "TRACKING",
    });
  }
  for (const row of mappingRows) {
    const productId = String(row.provider_product_id || "");
    if (!productId || resolutionMap.has(productId)) continue;
    if (row.status !== "CONFIRMED" || !row.winerim_wine_id) continue;
    const wine = wineById.get(String(row.winerim_wine_id));
    if (!wine) continue;
    resolutionMap.set(productId, {
      wine,
      variant: String(row.format_type || "BOTTLE").toUpperCase(),
      method: "MAPPING",
    });
  }
  return resolutionMap;
}

function buildExactNameMap(wines) {
  const names = new Map();
  for (const wine of wines) {
    const normalized = normalizeHistoricalWineName(wine.name);
    if (!normalized) continue;
    if (!names.has(normalized)) names.set(normalized, []);
    names.get(normalized).push(wine);
  }
  return names;
}

function levenshtein(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = new Array(right.length + 1);
    current[0] = row;
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function similarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const characterScore = 1 - (levenshtein(left, right) / Math.max(left.length, right.length));
  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection++;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size || 1;
  return (characterScore * 0.65) + ((intersection / union) * 0.35);
}

function bestReviewCandidate(wines, name) {
  const normalized = normalizeHistoricalWineName(name);
  let best = null;
  let second = null;
  for (const wine of wines) {
    const score = similarity(normalized, normalizeHistoricalWineName(wine.name));
    const candidate = { winerimId: String(wine.winerim_id), name: wine.name, score };
    if (!best || score > best.score) {
      second = best;
      best = candidate;
    } else if (!second || score > second.score) {
      second = candidate;
    }
  }
  if (!best || best.score < 0.6) return null;
  return {
    ...best,
    secondScore: second?.score || 0,
    margin: best.score - (second?.score || 0),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connectionId = required(args, "connection-id");
  const fromDay = required(args, "from");
  const toDay = required(args, "to");
  const skipFrom = args["skip-from"] ? String(args["skip-from"]) : null;
  const requestedOrderIds = new Set(
    String(args["only-order-ids"] || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const apply = args.apply === true;
  const reportPath = args.report ? String(args.report) : null;
  const aliasesFile = args["aliases-file"] ? String(args["aliases-file"]) : null;
  const days = dayRange(fromDay, toDay);

  if (skipFrom && !isDay(skipFrom)) throw new Error("--skip-from must use YYYY-MM-DD");
  if (apply && args["confirm-no-stock"] !== true) {
    throw new Error("--apply requires --confirm-no-stock");
  }

  const cloudUrl = String(process.env.VITE_SUPABASE_URL || process.env.LOVABLE_CLOUD_URL || "").trim();
  const serviceRoleKey = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.LOVABLE_CLOUD_SERVICE_ROLE_KEY ||
    "",
  ).trim();
  const cloudKey = String(
    serviceRoleKey ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    "",
  ).trim();
  if (!cloudUrl || !cloudKey) throw new Error("Missing Lovable Cloud URL/key in environment");
  if (apply && !serviceRoleKey) {
    throw new Error("Historical apply requires an explicit Lovable Cloud service-role key");
  }

  const restBase = `${cloudUrl.replace(/\/$/, "")}/rest/v1`;
  const cloudHeaders = {
    apikey: cloudKey,
    Authorization: `Bearer ${cloudKey}`,
  };
  const connectionQuery = new URLSearchParams({
    select: "id,location_name,base_url,api_token,winerim_api_token,provider_config",
    id: `eq.${connectionId}`,
  });
  const [connection] = await fetchJson(`${restBase}/pos_connections?${connectionQuery}`, {
    headers: cloudHeaders,
  });
  if (!connection) throw new Error(`Connection ${connectionId} not found`);
  if (!connection.api_token || !connection.winerim_api_token) {
    throw new Error("Connection is missing Agora or Winerim credentials");
  }

  const [wines, trackingRows, mappingRows] = await Promise.all([
    fetchAllRows(
      restBase,
      cloudHeaders,
      "winerim_wines",
      "winerim_id,name,is_active,bottle_stock_id,glass_stock_id,magnum_stock_id",
      connectionId,
    ),
    fetchAllRows(
      restBase,
      cloudHeaders,
      "winerim_push_tracking",
      "winerim_wine_id,format,agora_product_id,sync_status",
      connectionId,
    ),
    fetchAllRows(
      restBase,
      cloudHeaders,
      "product_mappings",
      "provider_product_id,winerim_wine_id,status,format_type",
      connectionId,
    ),
  ]);

  const resolutionMap = buildResolutionMap(wines, trackingRows, mappingRows);
  const exactNameMap = buildExactNameMap(wines);
  const wineById = new Map(wines.map((wine) => [String(wine.winerim_id), wine]));
  const configuredAliases = (
    connection.provider_config?.historical_sales_name_aliases &&
    typeof connection.provider_config.historical_sales_name_aliases === "object"
  )
    ? connection.provider_config.historical_sales_name_aliases
    : {};
  let fileAliases = {};
  if (aliasesFile) {
    const parsed = JSON.parse(await readFile(aliasesFile, "utf8"));
    fileAliases = parsed?.aliases && typeof parsed.aliases === "object"
      ? parsed.aliases
      : parsed;
  }
  const aliasDefinitions = normalizeHistoricalAliasDefinitions({
    ...configuredAliases,
    ...fileAliases,
  });
  const aliasMap = new Map();
  const rejectedAliases = [];
  for (const alias of aliasDefinitions) {
    const wine = wineById.get(alias.winerimId);
    if (!wine) {
      rejectedAliases.push({ ...alias, reason: "WINERIM_WINE_NOT_FOUND" });
      continue;
    }
    if (!alias.normalizedLabel) {
      rejectedAliases.push({ ...alias, reason: "EMPTY_NORMALIZED_NAME" });
      continue;
    }
    if (!aliasMap.has(alias.normalizedLabel)) aliasMap.set(alias.normalizedLabel, []);
    aliasMap.get(alias.normalizedLabel).push({ ...alias, wine });
  }
  const rawCandidates = [];
  const review = new Map();
  const unresolved = new Map();
  const skippedExisting = new Map();
  const fractional = [];
  const errors = [];
  let invoices = 0;
  let scannedLines = 0;
  let skippedExistingWindow = 0;

  for (const day of days) {
    const url = `${String(connection.base_url).replace(/\/$/, "")}/api/export/?business-day=${day}&filter=Invoices`;
    let dayInvoices;
    try {
      dayInvoices = parseInvoices(await fetchJson(url, {
        headers: {
          "Api-Token": connection.api_token,
          Accept: "application/json",
        },
      }));
    } catch (error) {
      errors.push(`${day}: ${String(error)}`);
      await sleep(REQUEST_GAP_MS);
      continue;
    }
    invoices += dayInvoices.length;

    for (let invoiceIndex = 0; invoiceIndex < dayInvoices.length; invoiceIndex++) {
      const invoice = dayInvoices[invoiceIndex];
      const documentId = invoiceDocumentId(invoice, day, invoiceIndex);
      const items = Array.isArray(invoice.InvoiceItems) ? invoice.InvoiceItems : [];
      for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
        const item = items[itemIndex];
        const lines = Array.isArray(item.Lines) ? item.Lines : [];
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
          const line = lines[lineIndex];
          const quantity = Number(line.Quantity || 0);
          if (!Number.isFinite(quantity) || quantity === 0) continue;
          scannedLines++;

          const productId = String(line.ProductId || line.SaleFormatId || "");
          const productName = decodeAgoraText(line.ProductName || line.SaleFormatName || "");
          const saleFormatName = decodeAgoraText(line.SaleFormatName || "");
          const inferredVariant = inferHistoricalVariant(productName, saleFormatName);
          let resolution = resolutionMap.get(productId) || null;

          const alias = resolveHistoricalAlias(aliasMap, productName, inferredVariant);
          if (alias) {
            resolution = {
              wine: alias.wine,
              variant: alias.variant,
              method: "MANUAL_ALIAS",
            };
          }
          if (!resolution) {
            const exactMatches = exactNameMap.get(normalizeHistoricalWineName(productName)) || [];
            if (exactMatches.length === 1) {
              resolution = {
                wine: exactMatches[0],
                variant: inferredVariant,
                method: "EXACT_NAME",
              };
            }
          }

          if (!resolution?.wine) {
            const candidate = bestReviewCandidate(wines, productName);
            const key = `${productId}|${productName}|${saleFormatName}`;
            const target = candidate ? review : unresolved;
            if (!target.has(key)) {
              target.set(key, {
                productId,
                productName,
                saleFormatName,
                family: decodeAgoraText(line.FamilyName || ""),
                lines: 0,
                quantity: 0,
                totalAmount: 0,
                candidate,
                days: new Set(),
              });
            }
            const row = target.get(key);
            row.lines++;
            row.quantity += quantity;
            row.totalAmount += Number(line.TotalAmount || 0);
            row.days.add(day);
            continue;
          }
          if (resolution.wine.is_active === false) {
            const key = `${productId}|${productName}|inactive-winerim-wine`;
            if (!unresolved.has(key)) {
              unresolved.set(key, {
                productId,
                productName,
                saleFormatName,
                family: decodeAgoraText(line.FamilyName || ""),
                lines: 0,
                quantity: 0,
                totalAmount: 0,
                reason: `Winerim wine ${resolution.wine.winerim_id} is inactive; sales/import cannot access its stockId`,
                days: new Set(),
              });
            }
            const row = unresolved.get(key);
            row.lines++;
            row.quantity += quantity;
            row.totalAmount += Number(line.TotalAmount || 0);
            row.days.add(day);
            continue;
          }

          const variant = resolution.method === "EXACT_NAME"
            ? inferredVariant
            : String(resolution.variant || inferredVariant).toUpperCase();
          const stockId = stockIdForVariant(resolution.wine, variant);
          if (!stockId) {
            const key = `${productId}|${productName}|${variant}|missing-stock`;
            if (!unresolved.has(key)) {
              unresolved.set(key, {
                productId,
                productName,
                saleFormatName,
                family: decodeAgoraText(line.FamilyName || ""),
                lines: 0,
                quantity: 0,
                totalAmount: 0,
                reason: `Winerim ${variant} stockId not found`,
                days: new Set(),
              });
            }
            const row = unresolved.get(key);
            row.lines++;
            row.quantity += quantity;
            row.totalAmount += Number(line.TotalAmount || 0);
            row.days.add(day);
            continue;
          }

          if (!Number.isInteger(quantity)) {
            fractional.push({
              day,
              documentId,
              productId,
              productName,
              saleFormatName,
              quantity,
              winerimId: String(resolution.wine.winerim_id),
              winerimName: resolution.wine.name,
              variant,
            });
            continue;
          }

          if (skipFrom && day >= skipFrom) {
            skippedExistingWindow += quantity;
            const key = [
              day,
              resolution.wine.winerim_id,
              variant,
              productName,
            ].join("|");
            if (!skippedExisting.has(key)) {
              skippedExisting.set(key, {
                businessDay: day,
                providerProductName: productName,
                winerimId: String(resolution.wine.winerim_id),
                winerimName: resolution.wine.name,
                variant,
                quantity: 0,
                totalAmount: 0,
              });
            }
            const skipped = skippedExisting.get(key);
            skipped.quantity += quantity;
            skipped.totalAmount += Number(line.TotalAmount || 0);
            continue;
          }

          const lineKey = `${itemIndex}-${line.Index ?? lineIndex}`;
          const soldAt = providerSoldAt(line, item, invoice, day);
          const lifecycleKey = [
            day,
            soldAt,
            line.Index ?? lineIndex,
            productId || normalizeHistoricalWineName(productName),
            resolution.wine.winerim_id,
            variant,
            Number(line.UnitPrice ?? line.ProductPrice ?? 0).toFixed(4),
          ].join("|");
          rawCandidates.push({
            stockId,
            qty: quantity,
            soldAt,
            orderId: buildHistoricalOrderId({
              connectionId,
              businessDay: day,
              documentId,
              lineKey,
              wineId: String(resolution.wine.winerim_id),
              variant,
            }),
            audit: {
              businessDay: day,
              documentId,
              lineKey,
              providerProductId: productId,
              providerProductName: productName,
              saleFormatName,
              winerimId: String(resolution.wine.winerim_id),
              winerimName: resolution.wine.name,
              variant,
              matchMethod: resolution.method,
              providerTotalAmount: Number(line.TotalAmount || 0),
            },
            lifecycleKey,
          });
        }
      }
    }
    await sleep(REQUEST_GAP_MS);
  }

  const {
    candidates,
    netted: nettedLifecycleRows,
    negative: negativeNetRows,
  } = netHistoricalCandidates(rawCandidates);
  const duplicateOrderIds = candidates.length - new Set(candidates.map((sale) => sale.orderId)).size;
  if (duplicateOrderIds > 0) {
    throw new Error(`Generated ${duplicateOrderIds} duplicate historical orderIds`);
  }
  const selectedCandidates = requestedOrderIds.size > 0
    ? candidates.filter((sale) => requestedOrderIds.has(sale.orderId))
    : candidates;
  if (requestedOrderIds.size > 0) {
    const selectedOrderIds = new Set(selectedCandidates.map((sale) => sale.orderId));
    const missingOrderIds = Array.from(requestedOrderIds).filter(
      (orderId) => !selectedOrderIds.has(orderId),
    );
    if (missingOrderIds.length > 0) {
      throw new Error(`Requested historical orderIds not found: ${missingOrderIds.join(", ")}`);
    }
  }

  const importSummary = {
    attempted: false,
    batches: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };
  if (apply && selectedCandidates.length > 0) {
    importSummary.attempted = true;
    for (let offset = 0; offset < selectedCandidates.length; offset += 100) {
      const batch = selectedCandidates.slice(offset, offset + 100);
      const response = await fetchJson(`${WINERIM_API_BASE}/sales/import`, {
        method: "POST",
        headers: {
          "WINERIM-API-TOKEN": connection.winerim_api_token,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          sales: batch.map(({ stockId, qty, soldAt, orderId }) => ({
            stockId,
            qty,
            soldAt,
            orderId,
          })),
        }),
      });
      importSummary.batches++;
      importSummary.imported += Number(response?.imported || 0);
      importSummary.skipped += Number(response?.skipped || 0);
      importSummary.failed += Number(response?.failed || 0);
      if (Array.isArray(response?.errors)) {
        for (const error of response.errors) {
          const localIndex = Number(error?.index);
          const sale = Number.isInteger(localIndex) ? batch[localIndex] : null;
          importSummary.errors.push({
            ...error,
            globalIndex: Number.isInteger(localIndex) ? offset + localIndex : null,
            qty: sale?.qty ?? null,
            orderId: sale?.orderId ?? null,
            audit: sale?.audit ?? null,
          });
        }
      }
      await sleep(250);
    }
  }

  const serializeGrouped = (values) => Array.from(values.values())
    .map((row) => ({ ...row, days: Array.from(row.days).sort() }))
    .sort((left, right) => right.totalAmount - left.totalAmount);

  const byMatchMethod = {};
  const byVariant = {};
  for (const sale of selectedCandidates) {
    byMatchMethod[sale.audit.matchMethod] = (byMatchMethod[sale.audit.matchMethod] || 0) + sale.qty;
    byVariant[sale.audit.variant] = (byVariant[sale.audit.variant] || 0) + sale.qty;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    connectionId,
    locationName: connection.location_name,
    range: { from: fromDay, to: toDay, skipFrom },
    mode: apply ? "APPLY_SALES_ONLY" : "DRY_RUN",
    guarantees: {
      stockMutation: false,
      endpoint: "/api/v2/sales/import",
      idempotentOrderIds: true,
    },
    aliases: {
      file: aliasesFile,
      configured: aliasDefinitions.length,
      resolved: Array.from(aliasMap.values()).reduce((total, aliases) => total + aliases.length, 0),
      rejected: rejectedAliases,
    },
    scan: {
      days: days.length,
      invoices,
      lines: scannedLines,
      errors,
    },
    netting: {
      rawRows: rawCandidates.length,
      canonicalRows: candidates.length,
      lifecycleGroupsAdjusted: nettedLifecycleRows,
      negativeNetRows,
    },
    importable: {
      rows: selectedCandidates.length,
      quantity: selectedCandidates.reduce((total, sale) => total + sale.qty, 0),
      providerTotalAmount: selectedCandidates.reduce(
        (total, sale) => total + sale.audit.providerTotalAmount,
        0,
      ),
      selection: {
        requestedOrderIds: requestedOrderIds.size,
        excludedByOrderIdFilter: candidates.length - selectedCandidates.length,
      },
      skippedExistingWindow,
      skippedExisting: Array.from(skippedExisting.values()).sort(
        (left, right) => left.businessDay.localeCompare(right.businessDay) ||
          left.winerimName.localeCompare(right.winerimName, "es"),
      ),
      byMatchMethod,
      byVariant,
      ...(args["include-candidates"] === true ? { candidates: selectedCandidates } : {}),
    },
    review: serializeGrouped(review),
    unresolved: serializeGrouped(unresolved),
    fractional,
    importResult: importSummary,
    sample: selectedCandidates.slice(0, 25),
  };

  if (reportPath) {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
