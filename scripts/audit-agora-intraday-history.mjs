#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const LOVABLE_ENV_FILE = process.env.LOVABLE_ENV_FILE || ".env";
const ADMIN_EMAIL = process.env.WINERIM_ADMIN_EMAIL || "";
const ADMIN_PASSWORD = process.env.WINERIM_ADMIN_PASSWORD || "";
const DAYS = Math.max(1, Number(process.env.AUDIT_DAYS || 7));
const CUTOFF_DAY_OVERRIDE = String(process.env.AUDIT_CUTOFF_DAY || "").trim();
const CONNECTION_IDS = new Set(
  String(process.env.AUDIT_CONNECTION_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const INCLUDE_DETAILS = process.env.AUDIT_INCLUDE_DETAILS === "true";
const OUTPUT_FILE = process.env.AUDIT_OUTPUT || "";
const WINERIM_BASE = "https://app.winerim.com";

const SEARCH_ALIASES = new Map([
  ["Restaurante Cienvinos Ecija", ["Cienvinos Ecija", "Cienvinos"]],
  ["Restaurante Jardi", ["restauranteljardi", "Jardi", "El Jardi"]],
  ["Restaurante Qtomas", ["Qtomas", "Q Tomas"]],
  ["Restaurante Triana", ["Restaurante Triana", "Triana"]],
  ["PurOsushi", ["Puro Sushi", "PurOsushi"]],
  ["El Higuerón", ["El Higuerón", "El Higueron", "Higuerón"]],
  ["De la O", ["DeLaO", "De la O"]],
]);

function parseDotEnv(text) {
  const result = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function chunks(values, size) {
  const result = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    const values = groups.get(key) || [];
    values.push(row);
    groups.set(key, values);
  }
  return groups;
}

function sumBy(rows, keyFn, valueFn) {
  const sums = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    sums.set(key, Number(sums.get(key) || 0) + Number(valueFn(row) || 0));
  }
  return sums;
}

async function lovableClient() {
  const fileEnv = parseDotEnv(await readFile(LOVABLE_ENV_FILE, "utf8"));
  const env = { ...fileEnv, ...process.env };
  const baseUrl = String(env.VITE_SUPABASE_URL || env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "";
  if (!baseUrl || !key) throw new Error("Lovable Cloud URL/key not found.");
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  async function all(table, select, params = {}) {
    const result = [];
    for (let offset = 0; ; offset += 1000) {
      const url = new URL(`${baseUrl}/rest/v1/${table}`);
      url.searchParams.set("select", select);
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
      if (!params.order) url.searchParams.set("order", "id.asc");
      const response = await fetch(url, {
        headers: { ...headers, Range: `${offset}-${offset + 999}` },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`${table}: HTTP ${response.status} ${await response.text()}`);
      const rows = await response.json();
      result.push(...rows);
      if (rows.length < 1000) break;
    }
    return result;
  }

  return { all };
}

function runWinerimScraper(activeConnections, cutoffDay) {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    return {
      ok: false,
      error: "WINERIM_ADMIN_EMAIL and WINERIM_ADMIN_PASSWORD are required for ERP comparison.",
      restaurants: [],
    };
  }

  const payload = JSON.stringify({
    baseUrl: WINERIM_BASE,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    cutoffDay,
    connections: activeConnections.map((connection) => ({
      id: connection.id,
      name: connection.location_name,
      aliases: SEARCH_ALIASES.get(connection.location_name) || [connection.location_name],
    })),
  });

  const python = String.raw`
import json, re, sys, html as html_lib
from datetime import datetime
from urllib.parse import urljoin
import requests
from lxml import html

payload = json.loads(sys.stdin.read())
base = payload["baseUrl"].rstrip("/")
cutoff = payload["cutoffDay"]

def clean(value):
    return " ".join(str(value or "").split())

def norm(value):
    import unicodedata
    text = unicodedata.normalize("NFD", str(value or ""))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()

def admin_session():
    session = requests.Session()
    login = session.get(base + "/admin/login", timeout=30)
    token = re.search(r'name="_csrf_token" value="([^"]+)"', login.text)
    if not token:
        raise RuntimeError("Winerim admin CSRF token not found")
    response = session.post(
        base + "/admin/login",
        data={
            "_csrf_token": token.group(1),
            "_target_path": "/",
            "_username": payload["email"],
            "_password": payload["password"],
        },
        timeout=30,
        allow_redirects=True,
    )
    if "/admin" not in response.url:
        raise RuntimeError("Winerim admin login failed")
    return session

def candidates_for(session, query):
    response = session.get(
        base + "/admin",
        params={
            "crudAction": "index",
            "crudControllerFqcn": r"App\Controller\Admin\Content\UserCrudController",
            "query": query,
        },
        timeout=30,
    )
    tree = html.fromstring(response.text)
    values = []
    for row in tree.xpath('//tbody/tr'):
        names = row.xpath('.//td[@data-column="name"]//text()')
        links = row.xpath('.//a[@data-action-name="impersonate"]/@href')
        if not names or not links:
            continue
        match = re.search(r'entityId=(\d+)', html_lib.unescape(links[0]))
        if match:
            values.append({"entityId": match.group(1), "name": clean(" ".join(names))})
    return values

def choose_candidate(session, connection):
    all_candidates = []
    for alias in connection["aliases"]:
        all_candidates.extend(candidates_for(session, alias))
        if all_candidates:
            break
    unique = {row["entityId"]: row for row in all_candidates}
    values = list(unique.values())
    targets = {norm(connection["name"])}
    targets.update(norm(alias) for alias in connection["aliases"])
    exact = [row for row in values if norm(row["name"]) in targets]
    if len(exact) == 1:
        return exact[0], values
    non_clone = [row for row in values if "clone" not in norm(row["name"])]
    if len(non_clone) == 1:
        return non_clone[0], values
    contained = [
        row for row in values
        if any(target in norm(row["name"]) or norm(row["name"]) in target for target in targets)
    ]
    if len(contained) == 1:
        return contained[0], values
    if len(values) == 1:
        return values[0], values
    return None, values

def parse_sales_page(text):
    tree = html.fromstring(text)
    rows = []
    current_day = None
    nodes = tree.xpath(
        '//div[contains(concat(" ", normalize-space(@class), " "), " sales-date-header ")]'
        ' | //div[contains(concat(" ", normalize-space(@class), " "), " erp-card ")]'
    )
    for node in nodes:
        classes = " " + clean(node.get("class")) + " "
        if " sales-date-header " in classes:
            title = clean(" ".join(node.xpath('.//*[contains(@class,"sales-date-title")]//text()')))
            current_day = title
            continue
        button = node.xpath('.//button[contains(@class,"cancel-sale-trigger")]')
        if not button:
            continue
        button = button[0]
        date = button.get("data-date")
        spans = node.xpath('.//*[contains(@class,"erp-meta-item")]')
        time = None
        source = None
        for span in spans:
            text_value = clean(" ".join(span.itertext()))
            if "schedule" in text_value:
                time = clean(text_value.replace("schedule", "", 1))
            if "sell" in text_value:
                source = clean(text_value.replace("sell", "", 1))
        rows.append({
            "date": date,
            "dateLabel": current_day,
            "time": time,
            "source": source,
            "saleId": button.get("data-sale-id"),
            "stockId": re.sub(r'^variant-', '', node.get("id") or ""),
            "variantPriceId": button.get("data-variant-id"),
            "wine": button.get("data-wine-name") or node.get("data-wine"),
            "variant": button.get("data-variant-label") or node.get("data-variant"),
            "qty": float(button.get("data-qty") or 0),
            "price": float(button.get("data-price") or 0),
        })
    pages = []
    for href in tree.xpath('//a[contains(@href,"/sales?p=")]/@href'):
        match = re.search(r'[?&]p=(\d+)', href)
        if match:
            pages.append(int(match.group(1)))
    return rows, max(pages or [1])

results = []
for connection in payload["connections"]:
    try:
        session = admin_session()
        selected, candidates = choose_candidate(session, connection)
        if not selected:
            results.append({
                "connectionId": connection["id"],
                "name": connection["name"],
                "ok": False,
                "error": "ADMIN_MATCH_AMBIGUOUS_OR_MISSING",
                "candidates": candidates,
            })
            continue
        response = session.get(
            base + "/admin",
            params={
                "crudAction": "impersonate",
                "crudControllerFqcn": r"App\Controller\Admin\Content\UserCrudController",
                "entityId": selected["entityId"],
            },
            timeout=30,
            allow_redirects=True,
        )
        menu_match = re.search(r'/profile/menu/(\d+)/edit', response.url)
        if not menu_match:
            raise RuntimeError("Menu id not found after impersonation")
        menu_id = menu_match.group(1)
        sales = []
        page = 1
        max_page = 1
        while page <= max_page and page <= 60:
            page_response = session.get(f"{base}/erp/{menu_id}/sales", params={"p": page}, timeout=30)
            page_rows, discovered_max = parse_sales_page(page_response.text)
            max_page = max(max_page, discovered_max)
            sales.extend(row for row in page_rows if row["date"] and row["date"] >= cutoff)
            dated_rows = [row for row in page_rows if row["date"]]
            if dated_rows and max(row["date"] for row in dated_rows) < cutoff:
                break
            page += 1
        results.append({
            "connectionId": connection["id"],
            "name": connection["name"],
            "ok": True,
            "adminEntityId": selected["entityId"],
            "adminName": selected["name"],
            "menuId": menu_id,
            "sales": sales,
        })
    except Exception as exc:
        results.append({
            "connectionId": connection["id"],
            "name": connection["name"],
            "ok": False,
            "error": str(exc),
        })

print(json.dumps({"ok": True, "restaurants": results}, ensure_ascii=False))
`;

  const result = spawnSync("python3", ["-c", python], {
    input: payload,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, PYTHONWARNINGS: "ignore" },
  });
  if (result.status !== 0) {
    return { ok: false, error: result.stderr.trim() || `Python exited ${result.status}`, restaurants: [] };
  }
  return JSON.parse(result.stdout);
}

async function main() {
  const client = await lovableClient();
  const cutoffDay = CUTOFF_DAY_OVERRIDE || (() => {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - DAYS);
    return isoDay(cutoff);
  })();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffDay)) {
    throw new Error("AUDIT_CUTOFF_DAY must use YYYY-MM-DD.");
  }
  const auditSpanDays = Math.max(
    1,
    Math.floor((Date.now() - Date.parse(`${cutoffDay}T00:00:00.000Z`)) / 86_400_000),
  );

  const allConnections = await client.all(
    "pos_connections",
    "id,location_name,provider,enabled,sync_mode,sync_frequency_minutes,last_sync_at,last_business_day_synced,provider_config",
    { provider: "eq.agora", order: "location_name.asc" },
  );
  const connections = CONNECTION_IDS.size === 0
    ? allConnections
    : allConnections.filter((connection) => CONNECTION_IDS.has(connection.id));
  if (connections.length === 0) {
    throw new Error("No Agora connections matched AUDIT_CONNECTION_IDS.");
  }
  const activeConnections = connections.filter((connection) => connection.enabled === true);
  const activeIds = new Set(activeConnections.map((connection) => connection.id));
  const connectionFilter = `in.(${connections.map((connection) => connection.id).join(",")})`;
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayDay = isoDay(yesterday);

  const [logs, events, wines] = await Promise.all([
    client.all(
      "stock_sync_log",
      "id,connection_id,sales_event_id,sales_line_item_id,idempotency_key,stock_id,winerim_product_id,variant,quantity,status,created_at,synced_at,error_message",
      { connection_id: connectionFilter, order: "id.asc" },
    ),
    client.all(
      "sales_events",
      "id,connection_id,provider_doc_id,doc_type,business_day,created_at",
      { connection_id: connectionFilter, business_day: `gte.${cutoffDay}`, order: "id.asc" },
    ),
    client.all(
      "winerim_wines",
      "connection_id,winerim_id,bottle_stock_id,glass_stock_id,magnum_stock_id",
      { connection_id: connectionFilter, order: "id.asc" },
    ),
  ]);
  const eventById = new Map(events.map((event) => [event.id, event]));
  const closedEvents = events.filter((event) =>
    activeIds.has(event.connection_id) &&
    event.business_day >= cutoffDay &&
    event.business_day <= yesterdayDay &&
    normalize(event.doc_type) !== "openticket"
  );
  const closedEventById = new Map(closedEvents.map((event) => [event.id, event]));
  const closedLines = [];
  for (const eventBatch of chunks(closedEvents.map((event) => event.id), 100)) {
    closedLines.push(...await client.all(
      "sales_line_items",
      "id,connection_id,sales_event_id,provider_product_id,quantity,winerim_product_id,format,mapped,is_wine_candidate",
      { sales_event_id: `in.(${eventBatch.join(",")})`, order: "id.asc" },
    ));
  }
  const wineByConnectionAndId = new Map(
    wines.map((wine) => [`${wine.connection_id}|${wine.winerim_id}`, wine]),
  );
  const canonicalClosedRows = [];
  const canonicalMissingStockIds = [];
  for (const line of closedLines) {
    if (!line.mapped || !line.winerim_product_id) continue;
    const event = closedEventById.get(line.sales_event_id);
    if (!event) continue;
    const wine = wineByConnectionAndId.get(`${line.connection_id}|${line.winerim_product_id}`);
    const format = normalize(line.format);
    const stockId = format === "copa" || format === "glass"
      ? wine?.glass_stock_id
      : format === "magnum"
      ? wine?.magnum_stock_id
      : wine?.bottle_stock_id;
    const row = {
      connectionId: line.connection_id,
      businessDay: event.business_day,
      providerDocId: event.provider_doc_id,
      providerProductId: String(line.provider_product_id || ""),
      name: line.name,
      stockId: stockId ? String(stockId) : null,
      wineId: String(line.winerim_product_id),
      format,
      quantity: Number(line.quantity || 0),
      unitPrice: Number(line.unit_price || 0),
      providerSoldAt: line.provider_sold_at || null,
      salesEventId: line.sales_event_id,
      lineId: line.id,
    };
    if (row.stockId) canonicalClosedRows.push(row);
    else canonicalMissingStockIds.push(row);
  }
  const activeLogs = logs.filter((row) => activeIds.has(row.connection_id));
  const successLogs = activeLogs.filter((row) => row.status === "SUCCESS");

  const duplicateIdempotency = Array.from(groupBy(successLogs, (row) => row.idempotency_key).entries())
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => ({
      key,
      connectionId: rows[0].connection_id,
      count: rows.length,
      logIds: rows.map((row) => row.id),
    }));

  const erp = runWinerimScraper(activeConnections, cutoffDay);
  const erpByConnection = new Map((erp.restaurants || []).map((row) => [row.connectionId, row]));

  const restaurantResults = connections.map((connection) => {
    const config = connection.provider_config || {};
    const connectionLogs = successLogs.filter((row) => row.connection_id === connection.id);
    const recentLogs = connectionLogs
      .map((row) => ({ ...row, businessDay: eventById.get(row.sales_event_id)?.business_day || null }))
      .filter((row) => row.businessDay && row.businessDay >= cutoffDay);
    const erpResult = erpByConnection.get(connection.id) || null;
    const erpSales = (erpResult?.sales || []).filter((sale) => normalize(sale.source) === "tpv");
    const closedErpSales = erpSales.filter(
      (sale) => sale.date >= cutoffDay && sale.date <= yesterdayDay,
    );
    const connectionCanonicalRows = canonicalClosedRows.filter(
      (row) => row.connectionId === connection.id,
    );
    const connectionClosedCandidateLines = closedLines
      .filter((line) => line.connection_id === connection.id && (line.mapped || line.is_wine_candidate))
      .map((line) => {
        const event = closedEventById.get(line.sales_event_id);
        return {
          businessDay: event?.business_day || null,
          providerDocId: event?.provider_doc_id || null,
          providerProductId: String(line.provider_product_id || ""),
          name: line.name,
          format: line.format,
          quantity: Number(line.quantity || 0),
          unitPrice: Number(line.unit_price || 0),
          mapped: line.mapped === true,
          isWineCandidate: line.is_wine_candidate === true,
          winerimProductId: line.winerim_product_id ? String(line.winerim_product_id) : null,
          providerSoldAt: line.provider_sold_at || null,
          lineId: line.id,
          salesEventId: line.sales_event_id,
        };
      });

    const logSums = sumBy(
      recentLogs,
      (row) => row.stock_id && row.businessDay ? `${row.businessDay}|${row.stock_id}` : null,
      (row) => row.quantity,
    );
    const erpLogSums = sumBy(
      erpSales,
      (row) => row.stockId && row.date ? `${row.date}|${row.stockId}` : null,
      (row) => row.qty,
    );
    const logComparisonKeys = new Set([...logSums.keys(), ...erpLogSums.keys()]);
    const logMismatches = Array.from(logComparisonKeys)
      .map((key) => ({
        key,
        middlewareQty: Number(logSums.get(key) || 0),
        erpQty: Number(erpLogSums.get(key) || 0),
      }))
      .filter((row) => Math.abs(row.middlewareQty - row.erpQty) > 0.0001);

    const canonicalSums = sumBy(
      connectionCanonicalRows,
      (row) => row.stockId && row.businessDay ? `${row.businessDay}|${row.stockId}` : null,
      (row) => row.quantity,
    );
    const closedErpSums = sumBy(
      closedErpSales,
      (row) => row.stockId && row.date ? `${row.date}|${row.stockId}` : null,
      (row) => row.qty,
    );
    const canonicalComparisonKeys = new Set([...canonicalSums.keys(), ...closedErpSums.keys()]);
    const canonicalMismatches = Array.from(canonicalComparisonKeys)
      .map((key) => ({
        key,
        agoraInvoiceQty: Number(canonicalSums.get(key) || 0),
        erpQty: Number(closedErpSums.get(key) || 0),
      }))
      .filter((row) => Math.abs(row.agoraInvoiceQty - row.erpQty) > 0.0001);

    const canonicalWindowSums = sumBy(
      connectionCanonicalRows,
      (row) => row.stockId || null,
      (row) => row.quantity,
    );
    const closedErpWindowSums = sumBy(
      closedErpSales,
      (row) => row.stockId || null,
      (row) => row.qty,
    );
    const canonicalWindowKeys = new Set([...canonicalWindowSums.keys(), ...closedErpWindowSums.keys()]);
    const canonicalWindowMismatches = Array.from(canonicalWindowKeys)
      .map((stockId) => ({
        stockId,
        agoraInvoiceQty: Number(canonicalWindowSums.get(stockId) || 0),
        erpQty: Number(closedErpWindowSums.get(stockId) || 0),
      }))
      .filter((row) => Math.abs(row.agoraInvoiceQty - row.erpQty) > 0.0001);

    const duplicateFingerprints = Array.from(groupBy(
      erpSales,
      (sale) => [
        sale.date,
        sale.time,
        sale.stockId,
        sale.qty,
        sale.price,
        normalize(sale.source),
      ].join("|"),
    ).entries())
      .filter(([, rows]) => rows.length > 1)
      .map(([fingerprint, rows]) => ({
        fingerprint,
        count: rows.length,
        saleIds: rows.map((row) => row.saleId),
        wine: rows[0].wine,
        variant: rows[0].variant,
      }));

    const connectionDuplicateKeys = duplicateIdempotency.filter(
      (row) => row.connectionId === connection.id,
    );
    const flags = {
      openTickets: config.open_tickets_sync_enabled === true,
      openTicketsStock: config.open_tickets_stock_sync_enabled === true,
      intraday: config.intraday_sales_sync_enabled === true,
      currentDayOnly: config.open_tickets_stock_current_day_only !== false,
      restoreStalePreviousDays: config.open_tickets_restore_stale_previous_days_enabled !== false,
      minLineAgeMinutes: config.open_tickets_min_line_age_minutes ?? null,
    };
    const flagsComplete = !connection.enabled || (
      flags.openTickets &&
      flags.intraday &&
      typeof flags.openTicketsStock === "boolean"
    );

    let status = connection.enabled ? "PASS" : "NOT_ACTIVE";
    if (connection.enabled) {
      if (!flagsComplete || connectionDuplicateKeys.length > 0) status = "FAIL";
      else if (
        !erpResult?.ok ||
        canonicalWindowMismatches.length > 0 ||
        canonicalMismatches.length > 0 ||
        duplicateFingerprints.length > 0 ||
        canonicalMissingStockIds.some((row) => row.connectionId === connection.id)
      ) {
        status = "WARN";
      }
    }

    return {
      connectionId: connection.id,
      name: connection.location_name,
      enabled: connection.enabled,
      status,
      syncFrequencyMinutes: connection.sync_frequency_minutes,
      lastSyncAt: connection.last_sync_at,
      lastBusinessDaySynced: connection.last_business_day_synced,
      flags,
      flagsComplete,
      idempotencyStatus: !connection.enabled
        ? "NOT_ACTIVE"
        : connectionDuplicateKeys.length === 0
        ? "PASS"
        : "FAIL",
      historyReconciliationStatus: !connection.enabled
        ? "NOT_ACTIVE"
        : !erpResult?.ok
        ? "NOT_AUDITED"
        : canonicalWindowMismatches.length === 0 && canonicalMismatches.length === 0
        ? "PASS"
        : "REVIEW",
      middlewareSuccessfulRows: recentLogs.length,
      canonicalClosedInvoiceLines: connectionCanonicalRows.length,
      erpTpvCards: erpSales.length,
      erpClosedTpvCards: closedErpSales.length,
      exactDuplicateIdempotencyKeys: connectionDuplicateKeys,
      erpExactFingerprintSuspects: duplicateFingerprints,
      logAggregateMismatches: logMismatches,
      canonicalClosedDayMismatches: canonicalMismatches,
      canonicalClosedWindowMismatches: canonicalWindowMismatches,
      canonicalMissingStockIds: canonicalMissingStockIds.filter(
        (row) => row.connectionId === connection.id,
      ),
      erp: erpResult ? {
        ok: erpResult.ok,
        menuId: erpResult.menuId || null,
        adminName: erpResult.adminName || null,
        error: erpResult.error || null,
        candidates: erpResult.candidates || undefined,
      } : { ok: false, error: "NOT_AUDITED" },
      ...(INCLUDE_DETAILS ? {
        details: {
          canonicalClosedRows: connectionCanonicalRows,
          closedCandidateLines: connectionClosedCandidateLines,
          successfulLogs: recentLogs.map((row) => ({
            id: row.id,
            businessDay: row.businessDay,
            salesEventId: row.sales_event_id,
            salesLineItemId: row.sales_line_item_id,
            idempotencyKey: row.idempotency_key,
            stockId: row.stock_id ? String(row.stock_id) : null,
            wineId: row.winerim_product_id ? String(row.winerim_product_id) : null,
            variant: row.variant,
            quantity: Number(row.quantity || 0),
            createdAt: row.created_at,
            syncedAt: row.synced_at,
          })),
          erpTpvSales: erpSales,
          erpAllSales: erpResult?.sales || [],
        },
      } : {}),
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    cutoffDay,
    days: auditSpanDays,
    summary: {
      totalAgoraConnections: connections.length,
      activeConnections: activeConnections.length,
      activeWithOpenTickets: activeConnections.filter(
        (connection) => connection.provider_config?.open_tickets_sync_enabled === true,
      ).length,
      activeWithIntraday: activeConnections.filter(
        (connection) => connection.provider_config?.intraday_sales_sync_enabled === true,
      ).length,
      activeWithOpenTicketStock: activeConnections.filter(
        (connection) => connection.provider_config?.open_tickets_stock_sync_enabled === true,
      ).length,
      exactDuplicateIdempotencyKeys: duplicateIdempotency.length,
      erpAudited: restaurantResults.filter((row) => row.enabled && row.erp.ok).length,
      pass: restaurantResults.filter((row) => row.enabled && row.status === "PASS").length,
      warn: restaurantResults.filter((row) => row.enabled && row.status === "WARN").length,
      fail: restaurantResults.filter((row) => row.enabled && row.status === "FAIL").length,
    },
    restaurants: restaurantResults,
  };

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (OUTPUT_FILE) {
    await writeFile(path.resolve(OUTPUT_FILE), serialized);
  } else {
    process.stdout.write(serialized);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
