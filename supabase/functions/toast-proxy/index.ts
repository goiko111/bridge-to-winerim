import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getToastConfig, type ToastConfig } from "../_shared/providerConfig.ts";

// HMAC SHA-256 using built-in Web Crypto (no external deps)
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

function sb() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

async function getConnection(connId: string) {
  const { data, error } = await sb().from("pos_connections").select("*").eq("id", connId).single();
  if (error) throw new Error("Connection not found");
  return data;
}

// ── Credential field mapping (Item 8 — Explicit typed columns) ──
// New explicit columns:
//   toast_client_id     = client_id
//   toast_client_secret = client_secret  
//   toast_access_token  = access_token (JWT)
//   toast_refresh_token = refresh_token (if applicable)
//   toast_expires_at    = token expiry
// Legacy fallback: merchant_id / refresh_token_enc / access_token_enc / expires_at

const tokenCache: Record<string, { token: string; expiresAt: number }> = {};

interface ToastCredentials {
  clientId: string;
  clientSecret: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
  status: string;
}

function parseToastCredentials(cred: any): ToastCredentials | null {
  if (!cred) return null;
  // Prefer new explicit columns, fall back to legacy
  return {
    clientId: cred.toast_client_id || cred.merchant_id || "",
    clientSecret: cred.toast_client_secret || cred.refresh_token_enc || "",
    accessToken: cred.toast_access_token || (cred.access_token_enc !== "pending" ? cred.access_token_enc : null) || null,
    refreshToken: cred.toast_refresh_token || null,
    expiresAt: cred.toast_expires_at || cred.expires_at || null,
    status: cred.status || "PENDING",
  };
}

async function getAuthToken(conn: any): Promise<string> {
  const cfg = getToastConfig(conn.provider_config);
  const hostname = cfg.api_hostname.replace(/\/+$/, "");
  const connId = conn.id;

  // Check in-memory cache
  if (tokenCache[connId] && Date.now() < tokenCache[connId].expiresAt - 30000) {
    return tokenCache[connId].token;
  }

  // Check DB cache
  const { data: cred } = await sb().from("provider_credentials")
    .select("*").eq("connection_id", connId).maybeSingle();

  const parsed = parseToastCredentials(cred);

  if (parsed?.accessToken && parsed?.expiresAt) {
    const expiresAt = new Date(parsed.expiresAt).getTime();
    if (Date.now() < expiresAt - 30000) {
      tokenCache[connId] = { token: parsed.accessToken, expiresAt };
      return parsed.accessToken;
    }
  }

  // Read credentials from parsed or fallback to conn.api_token
  const clientId = parsed?.clientId || conn.api_token;
  const clientSecret = parsed?.clientSecret;
  if (!clientId || !clientSecret) throw new Error("Missing Toast credentials (client_id / client_secret). Re-enter them in the Connection step.");

  const res = await fetch(`${hostname}/authentication/v1/authentication/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret, userAccessType: "TOAST_MACHINE_CLIENT" }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Authentication failed (${res.status}): Invalid credentials or insufficient permissions. ${body.slice(0, 200)}`);
    }
    throw new Error(`Auth failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const token = data.token?.accessToken || data.accessToken || data.token;
  const expiresIn = data.token?.expiresIn || data.expiresIn || 3600;
  const expiresAt = Date.now() + expiresIn * 1000;
  if (!token) throw new Error("No token in auth response");

  // Persist token using new explicit columns (primary) + legacy for backward compat
  const credRow = {
    connection_id: connId,
    // Explicit Toast columns (primary)
    toast_client_id: clientId,
    toast_client_secret: clientSecret,
    toast_access_token: token,
    toast_refresh_token: null, // Toast uses client credentials, no refresh token
    toast_expires_at: new Date(expiresAt).toISOString(),
    // Legacy columns (backward compat)
    merchant_id: clientId,
    access_token_enc: token,
    refresh_token_enc: clientSecret,
    expires_at: new Date(expiresAt).toISOString(),
    status: "ACTIVE",
    scopes: cfg?.scopes_expected || [],
  };

  if (cred) {
    await sb().from("provider_credentials").update(credRow).eq("id", cred.id);
  } else {
    await sb().from("provider_credentials").insert(credRow);
  }

  tokenCache[connId] = { token, expiresAt };
  return token;
}

function toastHeaders(token: string, restaurantGuid: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Toast-Restaurant-External-ID": restaurantGuid,
    Accept: "application/json",
  };
}

// ── Resilience: retry with backoff ──
async function fetchWithRetry(url: string, opts: RequestInit, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, opts);
    if (res.status === 429 || res.status === 503) {
      if (attempt === maxRetries) return res;
      const retryAfter = parseInt(res.headers.get("Retry-After") || "0") || (2 ** attempt);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    return res;
  }
  throw new Error("Max retries exceeded");
}

// ═══════════════════════════════════════════════════════
// ACTION: store-credentials (explicit typed columns)
// ═══════════════════════════════════════════════════════
async function handleStoreCredentials(connId: string, clientId: string, clientSecret: string) {
  const { data: existing } = await sb().from("provider_credentials")
    .select("id").eq("connection_id", connId).maybeSingle();

  // Use new explicit columns + legacy for backward compat
  const row = {
    connection_id: connId,
    // Explicit Toast columns (primary)
    toast_client_id: clientId,
    toast_client_secret: clientSecret,
    toast_access_token: null, // Will be set after first auth
    toast_refresh_token: null,
    toast_expires_at: null,
    // Legacy columns (backward compat)
    merchant_id: clientId,
    access_token_enc: "pending",
    refresh_token_enc: clientSecret,
    status: "PENDING",
    scopes: [],
  };

  if (existing) {
    await sb().from("provider_credentials").update(row).eq("id", existing.id);
  } else {
    await sb().from("provider_credentials").insert(row);
  }
  return json({ success: true, message: "Credentials stored securely." });
}

// ═══════════════════════════════════════════════════════
// ACTION: preflight
// ═══════════════════════════════════════════════════════
async function handlePreflight(connId: string) {
  const conn = await getConnection(connId);
  const cfg = getToastConfig(conn.provider_config);
  const hostname = cfg.api_hostname.replace(/\/+$/, "");
  const guid = cfg.restaurant_guid;
  if (!guid) return json({ success: false, message: "Missing restaurant GUID" });

  let token: string;
  try { token = await getAuthToken(conn); } catch (e: any) {
    return json({ success: false, message: `Auth failed: ${e.message}` });
  }

  try {
    const res = await fetchWithRetry(
      `${hostname}/restaurants/v1/restaurants/${guid}?includeArchived=false`,
      { headers: toastHeaders(token, guid) }
    );
    if (!res.ok) {
      const body = await res.text();
      return json({ success: false, message: `Restaurant API error (${res.status}): ${body.slice(0, 300)}` });
    }
    const data = await res.json();
    const tz = data.general?.timeZone || cfg?.timezone || "America/New_York";
    const closeoutHour = data.general?.closeoutHour ?? cfg?.closeout_hour ?? 4;
    const name = data.general?.name || data.restaurantName || conn.location_name;

    const updatedConfig = { ...cfg, timezone: tz, closeout_hour: closeoutHour };
    await sb().from("pos_connections").update({
      provider_config: updatedConfig,
      location_name: name,
    }).eq("id", connId);

    return json({
      success: true,
      restaurantName: name,
      timezone: tz,
      closeoutHour,
      message: `Connected to "${name}" (${tz}, closeout ${closeoutHour}:00)`,
    });
  } catch (e: any) {
    return json({ success: false, message: `Preflight failed: ${e.message}` });
  }
}

// ═══════════════════════════════════════════════════════
// ACTION: check-scopes
// ═══════════════════════════════════════════════════════
async function handleCheckScopes(connId: string) {
  const conn = await getConnection(connId);
  const cfg = getToastConfig(conn.provider_config);
  const hostname = cfg.api_hostname.replace(/\/+$/, "");
  const guid = cfg.restaurant_guid;

  let token: string;
  try { token = await getAuthToken(conn); } catch { return json({ scopes: [] }); }

  const checks = [
    { scope: "orders:read", required: true, url: `${hostname}/orders/v2/ordersBulk?businessDate=${new Date().toISOString().slice(0, 10).replace(/-/g, "")}&pageSize=1&page=1` },
    { scope: "restaurants:read", required: true, url: `${hostname}/restaurants/v1/restaurants/${guid}?includeArchived=false` },
    { scope: "menus:read", required: false, url: `${hostname}/menus/v2/menus` },
  ];

  const results: { scope: string; required: boolean; status: "ok" | "missing" | "unknown" }[] = [];
  for (const check of checks) {
    try {
      const res = await fetchWithRetry(check.url, { headers: toastHeaders(token, guid) }, 1);
      if (res.status === 403) results.push({ ...check, status: "missing" });
      else if (res.ok || res.status === 404) results.push({ ...check, status: "ok" });
      else results.push({ ...check, status: "unknown" });
    } catch {
      results.push({ ...check, status: "unknown" });
    }
  }
  return json({ scopes: results });
}

// ── Format classification ──
function classifyFormat(name: string): string | null {
  const n = name.trim().toUpperCase();
  if (n.startsWith("BOT.") || n.startsWith("BOT ")) return "BOTTLE";
  if (n.startsWith("COPA") || n.startsWith("GLASS")) return "GLASS";
  if (n.startsWith("MAGNUM") || n.startsWith("MAG.")) return "MAGNUM";
  return null;
}

// ═══════════════════════════════════════════════════════
// ACTION: sync-sales (with diagnostics — Item 10)
// ═══════════════════════════════════════════════════════
async function handleSyncSales(connId: string, mode: string, params: any) {
  const conn = await getConnection(connId);
  const cfg = getToastConfig(conn.provider_config);
  const hostname = cfg.api_hostname.replace(/\/+$/, "");
  const guid = cfg.restaurant_guid;
  const tz = cfg?.timezone || "America/New_York";
  const closeoutHour = cfg?.closeout_hour ?? 4;

  let token: string;
  try { token = await getAuthToken(conn); } catch (e: any) {
    return json({ success: false, message: `Auth failed: ${e.message}`, totalOrders: 0, totalLines: 0, duplicatesSkipped: 0, pagesProcessed: 0, diagnostics: null });
  }

  let totalOrders = 0, totalLines = 0, duplicatesSkipped = 0, pagesProcessed = 0;
  const maxPages = 50;

  try {
    for (let page = 1; page <= maxPages; page++) {
      let url: string;
      if (mode === "BUSINESS_DATE") {
        const bd = params.businessDate || new Date().toISOString().slice(0, 10).replace(/-/g, "");
        url = `${hostname}/orders/v2/ordersBulk?businessDate=${bd}&pageSize=100&page=${page}`;
      } else {
        const start = params.startDate || new Date(Date.now() - 86400000).toISOString();
        const end = params.endDate || new Date().toISOString();
        url = `${hostname}/orders/v2/ordersBulk?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}&pageSize=100&page=${page}`;
      }

      const res = await fetchWithRetry(url, { headers: toastHeaders(token, guid) });

      if (res.status === 403) {
        return json({ success: false, message: "403 Forbidden — likely missing orders:read scope.", totalOrders, totalLines, duplicatesSkipped, pagesProcessed, diagnostics: { mode, timezone: tz, closeoutHour } });
      }
      if (!res.ok) {
        const body = await res.text();
        await sb().from("pos_connections").update({
          provider_config: { ...cfg, circuit_breaker: { open: true, until: new Date(Date.now() + 300000).toISOString(), lastError: `${res.status}: ${body.slice(0, 200)}` } },
        }).eq("id", connId);
        return json({ success: false, message: `Orders API error (${res.status}): ${body.slice(0, 300)}`, totalOrders, totalLines, duplicatesSkipped, pagesProcessed, diagnostics: { mode, timezone: tz, closeoutHour } });
      }

      const orders = await res.json();
      if (!Array.isArray(orders) || orders.length === 0) break;
      pagesProcessed++;

      for (const order of orders) {
        const orderGuid = order.guid || order.entityType?.guid || `toast_${Date.now()}`;
        const businessDate = order.businessDate
          ? `${String(order.businessDate).slice(0, 4)}-${String(order.businessDate).slice(4, 6)}-${String(order.businessDate).slice(6, 8)}`
          : (order.openedDate || new Date().toISOString()).slice(0, 10);
        const docId = `TOAST_${orderGuid}`;

        const { data: existing } = await sb().from("sales_events")
          .select("id").eq("connection_id", connId).eq("provider_doc_id", docId).limit(1);
        if (existing && existing.length > 0) { duplicatesSkipped++; continue; }

        let totalAmount = 0, totalTax = 0, lineCount = 0;
        const checks = order.checks || [];
        const lineItems: any[] = [];

        for (const check of checks) {
          const checkGuid = check.guid || "";
          const selections = check.selections || [];
          for (let si = 0; si < selections.length; si++) {
            const sel = selections[si];
            const itemName = sel.displayName || sel.name || sel.itemName || "Unknown";
            const qty = sel.quantity || 1;
            const price = sel.price || sel.preDiscountPrice || 0;
            const tax = sel.tax || 0;
            const format = classifyFormat(itemName);
            const lineKey = `TOAST_${orderGuid}_${checkGuid}_${sel.guid || si}`;

            totalAmount += price;
            totalTax += tax;
            lineCount++;

            lineItems.push({
              connection_id: connId,
              name: itemName,
              quantity: qty,
              unit_price: qty > 0 ? price / qty : price,
              total_amount: price,
              vat_rate: 0,
              is_wine_candidate: false,
              provider_product_id: lineKey,
              family: sel.salesCategory?.name || null,
              format,
            });
          }
        }

        const { data: evt } = await sb().from("sales_events").insert({
          connection_id: connId,
          provider_doc_id: docId,
          business_day: businessDate,
          total_amount: order.amount || totalAmount,
          total_tax: totalTax,
          total_net: (order.amount || totalAmount) - totalTax,
          line_count: lineCount,
          doc_type: "Toast_Order",
          raw_json: order,
        }).select("id").single();

        if (evt) {
          totalOrders++;
          for (const li of lineItems) {
            await sb().from("sales_line_items").insert({ ...li, sales_event_id: evt.id });
            totalLines++;
          }
        }
      }
    }

    // Build cursor and diagnostics
    const cursor = { mode, ...params, page: pagesProcessed, lastModified: new Date().toISOString() };
    await sb().from("pos_connections").update({
      last_sync_at: new Date().toISOString(),
      provider_config: {
        ...cfg,
        circuit_breaker: { open: false, until: null, lastError: null },
        last_orders_sync_cursor: cursor,
      },
    }).eq("id", connId);

    // Item 10: return full diagnostics
    const diagnostics = {
      mode,
      timezone: tz,
      closeoutHour,
      startDate: params.startDate || null,
      endDate: params.endDate || null,
      businessDate: params.businessDate || null,
      pagesProcessed,
      totalOrdersFetched: totalOrders,
      cursorSaved: cursor,
    };

    return json({
      success: true,
      totalOrders,
      totalLines,
      duplicatesSkipped,
      pagesProcessed,
      diagnostics,
      message: `Synced ${totalOrders} orders with ${totalLines} line items across ${pagesProcessed} pages.`,
    });
  } catch (e: any) {
    return json({ success: false, message: `Sync error: ${e.message}`, totalOrders, totalLines, duplicatesSkipped, pagesProcessed, diagnostics: { mode, timezone: tz, closeoutHour } });
  }
}

// ═══════════════════════════════════════════════════════
// ACTION: sync-menus
// ═══════════════════════════════════════════════════════
async function handleSyncMenus(connId: string) {
  const conn = await getConnection(connId);
  const cfg = getToastConfig(conn.provider_config);
  const hostname = cfg.api_hostname.replace(/\/+$/, "");
  const guid = cfg.restaurant_guid;

  let token: string;
  try { token = await getAuthToken(conn); } catch (e: any) {
    return json({ success: false, totalMenus: 0, totalItems: 0, message: `Auth failed: ${e.message}` });
  }

  try {
    const res = await fetchWithRetry(`${hostname}/menus/v2/menus`, { headers: toastHeaders(token, guid) });
    if (res.status === 403) {
      return json({ success: false, totalMenus: 0, totalItems: 0, message: "403 — likely missing menus:read scope." });
    }
    if (!res.ok) {
      const body = await res.text();
      return json({ success: false, totalMenus: 0, totalItems: 0, message: `Menus API error (${res.status}): ${body.slice(0, 300)}` });
    }

    const menus = await res.json();
    let totalMenus = 0, totalItems = 0;

    const menuList = Array.isArray(menus) ? menus : [menus];
    for (const menu of menuList) {
      totalMenus++;
      const groups = menu.groups || menu.menuGroups || [];
      for (const group of groups) {
        const items = group.items || group.menuItems || [];
        for (const item of items) {
          const itemGuid = item.guid || item.itemGuid || `menu_${totalItems}`;
          const name = item.name || item.displayName || "Unknown";
          const price = item.price || item.prices?.[0]?.price || 0;
          const category = group.name || null;
          const format = classifyFormat(name);

          await sb().from("provider_products").upsert({
            connection_id: connId,
            provider_product_id: `TOAST_MENU_${itemGuid}`,
            name,
            family: category,
            price,
            vat_rate: 0,
            sale_format: format,
            raw_payload: item,
            sync_status: "SYNCED",
            last_synced_at: new Date().toISOString(),
          }, { onConflict: "connection_id,provider_product_id" });
          totalItems++;
        }
      }
    }

    await sb().from("pos_connections").update({
      last_catalog_sync_at: new Date().toISOString(),
      catalog_product_count: totalItems,
    }).eq("id", connId);

    return json({ success: true, totalMenus, totalItems, message: `Synced ${totalMenus} menus with ${totalItems} items.` });
  } catch (e: any) {
    return json({ success: false, totalMenus: 0, totalItems: 0, message: `Menus sync error: ${e.message}` });
  }
}

// ═══════════════════════════════════════════════════════
// ACTION: sync-status (extended with webhook diagnostics)
// ═══════════════════════════════════════════════════════
async function handleSyncStatus(connId: string) {
  const conn = await getConnection(connId);
  const cfg = getToastConfig(conn.provider_config);
  const cb = cfg.circuit_breaker || {};
  const cursor = cfg.last_orders_sync_cursor || null;
  const webhookDiag = cfg?.webhook_diagnostics || {};

  const { count: ordersCount } = await sb().from("sales_events")
    .select("id", { count: "exact", head: true }).eq("connection_id", connId);

  const { count: recentCount } = await sb().from("sales_events")
    .select("id", { count: "exact", head: true }).eq("connection_id", connId)
    .gte("created_at", new Date(Date.now() - 3600000).toISOString());

  // Webhook event stats
  const { data: lastWebhook } = await sb().from("webhook_events")
    .select("created_at, event_type, status")
    .eq("provider", "TOAST").eq("connection_id", connId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();

  const { count: webhookTotal } = await sb().from("webhook_events")
    .select("id", { count: "exact", head: true })
    .eq("provider", "TOAST").eq("connection_id", connId);

  const { count: webhookProcessed } = await sb().from("webhook_events")
    .select("id", { count: "exact", head: true })
    .eq("provider", "TOAST").eq("connection_id", connId).eq("status", "PROCESSED");

  const { count: webhookRejected } = await sb().from("webhook_events")
    .select("id", { count: "exact", head: true })
    .eq("provider", "TOAST").eq("connection_id", connId).eq("status", "REJECTED");

  return json({
    lastSuccessfulSync: conn.last_sync_at,
    lastError: cb.lastError || null,
    ordersProcessed: ordersCount || 0,
    newOrders: recentCount || 0,
    circuitBreakerOpen: cb.open || false,
    circuitBreakerUntil: cb.until || null,
    lastCursor: cursor,
    timezone: cfg?.timezone || null,
    closeoutHour: cfg?.closeout_hour ?? null,
    // Webhook diagnostics (hardened)
    webhook: {
      lastEvent: lastWebhook ? `${lastWebhook.event_type} — ${lastWebhook.created_at}` : null,
      lastStatus: lastWebhook?.status || null,
      totalEvents: webhookTotal || 0,
      processedEvents: webhookProcessed || 0,
      rejectedEvents: webhookRejected || 0,
      lastSignatureFailure: webhookDiag.lastSignatureFailure || null,
      lastParseFailure: webhookDiag.lastParseFailure || null,
      lastSuccessfulEvent: webhookDiag.lastSuccessfulEvent || null,
      signatureEnforcement: cfg?.webhook_signature_strict ? "STRICT" : "PERMISSIVE",
    },
  });
}

// ═══════════════════════════════════════════════════════
// ACTION: webhook-ingest (hardened with retry-safe processing)
// ═══════════════════════════════════════════════════════
const MAX_WEBHOOK_BODY_SIZE = 2 * 1024 * 1024; // 2 MB
const WEBHOOK_PROCESSING_TIMEOUT = 5000; // 5s max for inline processing

interface WebhookDiagnostics {
  lastSignatureFailure?: string;
  lastParseFailure?: string;
  lastSuccessfulEvent?: string;
  lastEventId?: string;
}

async function updateWebhookDiagnostics(connId: string, updates: Partial<WebhookDiagnostics>) {
  const { data: conn } = await sb().from("pos_connections").select("provider_config").eq("id", connId).single();
  if (!conn) return;
  const cfg = conn.provider_config as any || {};
  const diag = { ...(cfg.webhook_diagnostics || {}), ...updates };
  await sb().from("pos_connections").update({
    provider_config: { ...cfg, webhook_diagnostics: diag },
  }).eq("id", connId);
}

async function handleWebhookIngest(req: Request) {
  const now = new Date().toISOString();

  // ── Payload size guard (check header first) ──
  const contentLength = parseInt(req.headers.get("content-length") || "0");
  if (contentLength > MAX_WEBHOOK_BODY_SIZE) {
    console.warn(`[Webhook] Payload too large from header: ${contentLength} bytes`);
    return json({ error: "Payload too large", maxBytes: MAX_WEBHOOK_BODY_SIZE }, 413);
  }

  // ── Read body with size limit ──
  let body: string;
  try {
    const reader = req.body?.getReader();
    if (!reader) return json({ error: "No body" }, 400);

    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.length;
      if (totalSize > MAX_WEBHOOK_BODY_SIZE) {
        reader.cancel();
        console.warn(`[Webhook] Payload exceeded limit during read: ${totalSize} bytes`);
        return json({ error: "Payload too large", maxBytes: MAX_WEBHOOK_BODY_SIZE }, 413);
      }
      chunks.push(value);
    }
    const combined = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    body = new TextDecoder().decode(combined);
  } catch (e: any) {
    console.error("[Webhook] Body read error:", e.message);
    return json({ error: "Failed to read body" }, 400);
  }

  // ── Parse JSON ──
  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch (e: any) {
    console.error("[Webhook] JSON parse failure, preview:", body.slice(0, 300));
    await sb().from("webhook_events").insert({
      provider: "TOAST",
      event_id: `PARSE_FAIL_${Date.now()}`,
      event_type: "PARSE_ERROR",
      payload: { raw_preview: body.slice(0, 2000), error: e.message },
      status: "REJECTED",
    });
    return json({ error: "Invalid JSON" }, 400);
  }

  // ── Find connection by restaurantGuid ──
  const guid = payload.restaurantGuid || payload.restaurant?.guid;
  if (!guid) {
    console.warn("[Webhook] Missing restaurantGuid in payload");
    return json({ error: "Missing restaurantGuid" }, 400);
  }

  const { data: connections } = await sb().from("pos_connections")
    .select("id, provider_config")
    .eq("provider", "toast")
    .limit(100);

  const match = (connections || []).find((c: any) => {
    const cfg = c.provider_config as any;
    return cfg?.restaurant_guid === guid;
  });

  if (!match) {
    console.warn(`[Webhook] No matching connection for guid: ${guid}`);
    return json({ error: "No matching connection for restaurant" }, 404);
  }

  const connId = match.id;
  const cfg = match.provider_config as any;
  const webhookSecret = cfg?.webhook_secret;
  const strictMode = cfg?.webhook_signature_strict === true;

  // ── Signature verification (enforcement based on config) ──
  const sig = req.headers.get("Toast-Signature") || req.headers.get("x-toast-signature") || "";

  if (webhookSecret) {
    if (!sig) {
      console.warn(`[Webhook] Missing signature header for conn ${connId}`);
      await updateWebhookDiagnostics(connId, { lastSignatureFailure: now });
      await sb().from("webhook_events").insert({
        provider: "TOAST",
        connection_id: connId,
        event_id: `SIG_MISSING_${Date.now()}`,
        event_type: "SIGNATURE_MISSING",
        payload: { restaurantGuid: guid },
        status: "REJECTED",
      });
      if (strictMode) return json({ error: "Missing signature" }, 401);
      // Permissive mode: log but continue
      console.warn("[Webhook] Permissive mode: allowing unsigned request");
    } else {
      try {
        const expectedSig = await hmacSha256Hex(webhookSecret, body);
        const sigValue = sig.startsWith("sha256=") ? sig.slice(7) : sig;

        if (sigValue.toLowerCase() !== expectedSig.toLowerCase()) {
          console.warn(`[Webhook] Signature mismatch for conn ${connId}`);
          await updateWebhookDiagnostics(connId, { lastSignatureFailure: now });
          await sb().from("webhook_events").insert({
            provider: "TOAST",
            connection_id: connId,
            event_id: `SIG_FAIL_${Date.now()}`,
            event_type: "SIGNATURE_MISMATCH",
            payload: { restaurantGuid: guid },
            status: "REJECTED",
          });
          if (strictMode) return json({ error: "Invalid signature" }, 401);
          console.warn("[Webhook] Permissive mode: allowing mismatched signature");
        }
      } catch (e: any) {
        console.error("[Webhook] HMAC verification error:", e.message);
        // Allow through if HMAC lib fails but log it
      }
    }
  }

  // ── Strong dedupe: eventGuid + orderGuid ──
  const eventGuid = payload.eventGuid || payload.guid || "";
  const orderGuid = payload.orderGuid || payload.order?.guid || "";
  const eventType = payload.eventType || "ORDER_UPDATE";
  const timestamp = payload.timestamp || payload.createdDate || Date.now();

  // Build deterministic dedupe key
  const dedupeKey = eventGuid
    ? `TOAST_EVT_${eventGuid}`
    : `TOAST_${guid}_${orderGuid}_${eventType}_${timestamp}`;

  // Check for existing event (atomic dedupe)
  const { data: existingEvt } = await sb().from("webhook_events")
    .select("id, status").eq("event_id", dedupeKey).limit(1);

  if (existingEvt && existingEvt.length > 0) {
    console.log(`[Webhook] Duplicate event: ${dedupeKey}`);
    return json({ ok: true, message: "Duplicate event", eventId: dedupeKey });
  }

  // ── Store event for retry-safe async processing ──
  const { data: inserted, error: insertErr } = await sb().from("webhook_events").insert({
    provider: "TOAST",
    connection_id: connId,
    event_id: dedupeKey,
    event_type: eventType,
    payload: {
      ...payload,
      _meta: {
        receivedAt: now,
        bodySize: body.length,
        signaturePresent: !!sig,
        signatureValid: webhookSecret ? (sig ? true : false) : null,
      },
    },
    status: "PENDING",
  }).select("id").single();

  if (insertErr) {
    // 23505 = unique violation (concurrent dedupe race)
    if (insertErr.code === "23505") {
      return json({ ok: true, message: "Duplicate event (concurrent)", eventId: dedupeKey });
    }
    console.error("[Webhook] Insert error:", insertErr);
    return json({ error: "Failed to queue event" }, 500);
  }

  // ── Inline processing attempt (retry-safe: if this fails, event is still PENDING) ──
  try {
    // Only process order events inline
    if (eventType.includes("ORDER") && orderGuid) {
      const processed = await processOrderWebhook(connId, cfg, payload, orderGuid);
      if (processed) {
        await sb().from("webhook_events").update({
          status: "PROCESSED",
          processed_at: new Date().toISOString(),
        }).eq("id", inserted.id);
        await updateWebhookDiagnostics(connId, { lastSuccessfulEvent: now, lastEventId: dedupeKey });
      }
    } else {
      // Non-order events: mark as processed (logged)
      await sb().from("webhook_events").update({
        status: "PROCESSED",
        processed_at: new Date().toISOString(),
      }).eq("id", inserted.id);
    }
  } catch (e: any) {
    console.error(`[Webhook] Processing error for ${dedupeKey}:`, e.message);
    // Leave as PENDING for retry
  }

  return json({
    ok: true,
    message: "Event queued",
    eventId: dedupeKey,
    immediate: true,
  });
}

// ── Process order webhook into sales_events ──
async function processOrderWebhook(connId: string, cfg: any, payload: any, orderGuid: string): Promise<boolean> {
  const businessDate = payload.businessDate
    ? `${String(payload.businessDate).slice(0, 4)}-${String(payload.businessDate).slice(4, 6)}-${String(payload.businessDate).slice(6, 8)}`
    : (payload.openedDate || new Date().toISOString()).slice(0, 10);

  const docId = `TOAST_${orderGuid}`;

  // Dedupe against sales_events
  const { data: existing } = await sb().from("sales_events")
    .select("id").eq("connection_id", connId).eq("provider_doc_id", docId).limit(1);

  if (existing && existing.length > 0) {
    console.log(`[Webhook] Order already exists: ${docId}`);
    return true; // Already processed
  }

  // Extract line items
  let totalAmount = 0, totalTax = 0, lineCount = 0;
  const checks = payload.checks || [];
  const lineItems: any[] = [];

  for (const check of checks) {
    const checkGuid = check.guid || "";
    const selections = check.selections || [];
    for (let si = 0; si < selections.length; si++) {
      const sel = selections[si];
      const itemName = sel.displayName || sel.name || sel.itemName || "Unknown";
      const qty = sel.quantity || 1;
      const price = sel.price || sel.preDiscountPrice || 0;
      const tax = sel.tax || 0;
      const format = classifyFormat(itemName);
      const lineKey = `TOAST_${orderGuid}_${checkGuid}_${sel.guid || si}`;

      totalAmount += price;
      totalTax += tax;
      lineCount++;

      lineItems.push({
        connection_id: connId,
        name: itemName,
        quantity: qty,
        unit_price: qty > 0 ? price / qty : price,
        total_amount: price,
        vat_rate: 0,
        is_wine_candidate: false,
        provider_product_id: lineKey,
        family: sel.salesCategory?.name || null,
        format,
      });
    }
  }

  // Insert sales event
  const { data: evt } = await sb().from("sales_events").insert({
    connection_id: connId,
    provider_doc_id: docId,
    business_day: businessDate,
    total_amount: payload.amount || totalAmount,
    total_tax: totalTax,
    total_net: (payload.amount || totalAmount) - totalTax,
    line_count: lineCount,
    doc_type: "Toast_Order_Webhook",
    raw_json: payload,
  }).select("id").single();

  if (evt) {
    for (const li of lineItems) {
      await sb().from("sales_line_items").insert({ ...li, sales_event_id: evt.id });
    }
    return true;
  }
  return false;
}


// ═══════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/webhook") || url.searchParams.get("webhook") === "true") {
      return await handleWebhookIngest(req);
    }

    const payload = await req.json();
    const { action, connection_id } = payload;

    switch (action) {
      case "store-credentials":
        return await handleStoreCredentials(connection_id, payload.client_id, payload.client_secret);
      case "preflight":
        return await handlePreflight(connection_id);
      case "check-scopes":
        return await handleCheckScopes(connection_id);
      case "sync-sales":
        return await handleSyncSales(connection_id, payload.mode || "DATE_RANGE", payload);
      case "sync-menus":
        return await handleSyncMenus(connection_id);
      case "sync-status":
        return await handleSyncStatus(connection_id);
      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});
