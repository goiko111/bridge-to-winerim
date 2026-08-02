import {
  buildInitialOnboardingGates,
  buildTechnicalReviewPacket,
  isReadyForTechnicalReview,
  sanitizeTechnicalReviewPacketPayload,
  type CommercialOnboardingInput,
  type GateStatus,
  type OnboardingGate,
  validateCommercialOnboardingInput,
} from "../../../../src/lib/middlewareOnboarding";
import {
  getGoLiveBlockingItems,
  getIntegrationChecklist,
  getRequiredItems,
  type ChecklistProvider,
} from "../../../../src/lib/integrationChecklist";

export interface Env {
  ENVIRONMENT?: string;
  RELEASE?: string;
  ALLOWED_ORIGIN?: string;
  LOVABLE_CLOUD_URL?: string;
  LOVABLE_SERVICE_ROLE_KEY?: string;
  MIDDLEWARE_ADMIN_TOKEN?: string;
}

const WINERIM_API_BASE_URL = "https://app.winerim.com/api/v2";
const REQUEST_TIMEOUT_MS = 8000;

function corsHeaders(env: Env): HeadersInit {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Middleware-Token",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(body: unknown, env: Env, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      ...corsHeaders(env),
      "Content-Type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
  });
}

function bearerToken(request: Request): string {
  const auth = request.headers.get("Authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return request.headers.get("X-Middleware-Token") || "";
}

function requireAdminAccess(request: Request, env: Env): Response | null {
  if (!env.MIDDLEWARE_ADMIN_TOKEN) {
    return jsonResponse({ success: false, error: "ADMIN_TOKEN_NOT_CONFIGURED" }, env, { status: 503 });
  }
  if (bearerToken(request) !== env.MIDDLEWARE_ADMIN_TOKEN) {
    return jsonResponse({ success: false, error: "UNAUTHORIZED" }, env, { status: 401 });
  }
  return null;
}

function lovableCloudRestBase(env: Env): string | null {
  const base = (env.LOVABLE_CLOUD_URL || "").replace(/\/+$/, "");
  return base ? `${base}/rest/v1` : null;
}

async function lovableCloudGet(env: Env, path: string): Promise<Response> {
  const restBase = lovableCloudRestBase(env);
  if (!restBase || !env.LOVABLE_SERVICE_ROLE_KEY) {
    return jsonResponse({ success: false, error: "LOVABLE_CLOUD_NOT_CONFIGURED" }, env, { status: 503 });
  }

  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return fetchWithTimeout(`${restBase}${cleanPath}`, {
    headers: {
      Accept: "application/json",
      apikey: env.LOVABLE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.LOVABLE_SERVICE_ROLE_KEY}`,
    },
  });
}

async function lovableCloudGetJson<T>(env: Env, path: string): Promise<{ data: T | null; error: Response | null }> {
  const res = await lovableCloudGet(env, path);
  if (!res.ok) return { data: null, error: res };
  return { data: await res.json() as T, error: null };
}

async function lovableCloudCount(env: Env, path: string): Promise<number> {
  const restBase = lovableCloudRestBase(env);
  if (!restBase || !env.LOVABLE_SERVICE_ROLE_KEY) return 0;

  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const res = await fetchWithTimeout(`${restBase}${cleanPath}`, {
    headers: {
      Accept: "application/json",
      Prefer: "count=exact",
      Range: "0-0",
      apikey: env.LOVABLE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.LOVABLE_SERVICE_ROLE_KEY}`,
    },
  });

  const contentRange = res.headers.get("content-range") || "";
  const count = Number(contentRange.split("/")[1] || 0);
  if (Number.isFinite(count)) return count;

  const body = await res.json().catch(() => []);
  return Array.isArray(body) ? body.length : 0;
}

async function lovableCloudPost(env: Env, path: string, body: unknown): Promise<Response> {
  const restBase = lovableCloudRestBase(env);
  if (!restBase || !env.LOVABLE_SERVICE_ROLE_KEY) {
    return jsonResponse({ success: false, error: "LOVABLE_CLOUD_NOT_CONFIGURED" }, env, { status: 503 });
  }

  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return fetchWithTimeout(`${restBase}${cleanPath}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Prefer: "return=representation",
      apikey: env.LOVABLE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.LOVABLE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

async function parseJsonOnce(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  return JSON.parse(text);
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function gate(id: string, label: string, status: GateStatus, detail: string, technicalDetail?: string): OnboardingGate {
  return { id, label, status, detail, technicalDetail };
}

function revoEndpoint(baseUrl: string, path: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  if (/\/v2$/i.test(cleanBase) && cleanPath.startsWith("/v2/")) {
    return `${cleanBase}${cleanPath.slice(3)}`;
  }
  return `${cleanBase}${cleanPath}`;
}

async function testWinerimToken(token: string): Promise<OnboardingGate> {
  try {
    const res = await fetchWithTimeout(`${WINERIM_API_BASE_URL}/wines?page=1&limit=1`, {
      headers: {
        Accept: "application/json",
        "WINERIM-API-TOKEN": token,
      },
    });

    if (res.ok) {
      return gate("winerim", "Winerim", "pass", "Token Winerim valido.");
    }

    const body = await res.text().catch(() => "");
    return gate(
      "winerim",
      "Winerim",
      res.status === 401 || res.status === 403 ? "fail" : "warn",
      `Winerim responde HTTP ${res.status}.`,
      body.slice(0, 500),
    );
  } catch (error) {
    return gate("winerim", "Winerim", "fail", "No se pudo conectar con Winerim.", String(error));
  }
}

async function testAgoraReachability(input: CommercialOnboardingInput): Promise<OnboardingGate> {
  try {
    const res = await fetchWithTimeout(`${input.posBaseUrl}/api/export-master/?filter=Families`, {
      headers: {
        Accept: "application/xml",
        "Api-Token": input.posApiToken,
      },
    });

    if (res.ok) {
      const body = await res.text().catch(() => "");
      const hasXmlShape = body.includes("<") && /Family|Families|ArrayOf/i.test(body);
      return gate(
        "pos",
        "Agora",
        hasXmlShape ? "pass" : "warn",
        hasXmlShape ? "Agora accesible y export-master responde." : "Agora responde, pero la respuesta no parece XML de master data.",
        body.slice(0, 500),
      );
    }

    const body = await res.text().catch(() => "");
    return gate("pos", "Agora", "fail", `Agora responde HTTP ${res.status}.`, body.slice(0, 500));
  } catch (error) {
    return gate("pos", "Agora", "fail", "No se pudo alcanzar la URL de Agora.", String(error));
  }
}

async function testRevoReachability(input: CommercialOnboardingInput): Promise<OnboardingGate> {
  try {
    const res = await fetchWithTimeout(revoEndpoint(input.posBaseUrl, "/v2/paymentMethods"), {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.posApiToken}`,
        tenant: input.revoTenant,
        "client-token": input.revoClientToken,
      },
    });

    if (res.ok) return gate("pos", "REVO", "pass", "REVO accesible con tenant, access token y client-token.");

    const body = await res.text().catch(() => "");
    return gate("pos", "REVO", res.status === 401 || res.status === 403 ? "fail" : "warn", `REVO responde HTTP ${res.status}.`, body.slice(0, 500));
  } catch (error) {
    return gate("pos", "REVO", "fail", "No se pudo alcanzar la URL de REVO.", String(error));
  }
}

async function handleOnboardingTest(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await parseJsonOnce(request);
  } catch {
    return jsonResponse({ success: false, error: "INVALID_JSON" }, env, { status: 400 });
  }

  const validation = validateCommercialOnboardingInput(body as Partial<CommercialOnboardingInput>);
  if (!validation.valid) {
    return jsonResponse({
      success: false,
      error: "VALIDATION_FAILED",
      errors: validation.errors,
      gates: buildInitialOnboardingGates(body as Partial<CommercialOnboardingInput>),
    }, env, { status: 400 });
  }

  const input = validation.normalized;
  const [winerimGate, posGate] = await Promise.all([
    testWinerimToken(input.winerimApiToken),
    input.provider === "revo" ? testRevoReachability(input) : testAgoraReachability(input),
  ]);

  const gates: OnboardingGate[] = [
    gate("input", "Datos basicos", "pass", "Campos minimos completos."),
    winerimGate,
    posGate,
    gate("write", "Escritura", "blocked", "Sin escritura automatica: requiere revision tecnica y dry-run antes de activar."),
  ];
  const checklist = getIntegrationChecklist(input.provider as ChecklistProvider);
  const reviewPacket = buildTechnicalReviewPacket(
    input,
    gates,
    getGoLiveBlockingItems(checklist).map((item) => item.id),
  );

  return jsonResponse({
    success: true,
    environment: env.ENVIRONMENT || "local",
    normalized: {
      provider: input.provider,
      locationName: input.locationName,
      posBaseUrl: input.posBaseUrl,
      revoTenant: input.provider === "revo" ? input.revoTenant : undefined,
    },
    gates,
    reviewPacket,
    readyForTechnicalReview: isReadyForTechnicalReview(gates),
  }, env);
}

async function handleNotificationContacts(request: Request, env: Env, connectionId: string): Promise<Response> {
  const unauthorized = requireAdminAccess(request, env);
  if (unauthorized) return unauthorized;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(connectionId)) {
    return jsonResponse({ success: false, error: "INVALID_CONNECTION_ID" }, env, { status: 400 });
  }

  const params = new URLSearchParams({
    connection_id: `eq.${connectionId}`,
    enabled: "eq.true",
    select: "id,connection_id,contact_type,display_name,email,phone,notify_on_health_failure,notify_on_stock_failure,notify_on_catalog_failure",
    order: "contact_type.asc,display_name.asc",
  });
  const res = await lovableCloudGet(env, `/connection_notification_contacts?${params.toString()}`);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return jsonResponse({
      success: false,
      error: "LOVABLE_CLOUD_CONTACTS_ERROR",
      status: res.status,
      detail: body.slice(0, 500),
    }, env, { status: res.status });
  }

  return jsonResponse({
    success: true,
    connectionId,
    contacts: await res.json(),
  }, env);
}

async function handleCreateOnboardingRequest(request: Request, env: Env): Promise<Response> {
  const unauthorized = requireAdminAccess(request, env);
  if (unauthorized) return unauthorized;

  let body: Record<string, unknown>;
  try {
    body = await parseJsonOnce(request);
  } catch {
    return jsonResponse({ success: false, error: "INVALID_JSON" }, env, { status: 400 });
  }

  const sanitized = sanitizeTechnicalReviewPacketPayload(body);
  if (!sanitized.valid || !sanitized.reviewPacket) {
    return jsonResponse({ success: false, error: "INVALID_REVIEW_PACKET", errors: sanitized.errors }, env, { status: 400 });
  }

  const reviewPacket = sanitized.reviewPacket;

  const insertBody = {
    provider: reviewPacket.provider,
    location_name: reviewPacket.locationName,
    pos_base_url: reviewPacket.posBaseUrl,
    revo_tenant: reviewPacket.provider === "revo" ? reviewPacket.revoTenant || null : null,
    status: reviewPacket.readyForTechnicalReview ? "READY_FOR_TECHNICAL_REVIEW" : "DRAFT",
    ready_for_technical_review: reviewPacket.readyForTechnicalReview,
    gate_summary: reviewPacket.gateSummary,
    review_packet: reviewPacket,
  };

  const res = await lovableCloudPost(env, "/integration_onboarding_requests", insertBody);
  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    return jsonResponse({
      success: false,
      error: "LOVABLE_CLOUD_ONBOARDING_REQUEST_ERROR",
      status: res.status,
      detail: errorBody.slice(0, 500),
    }, env, { status: res.status });
  }

  const created = await res.json();
  return jsonResponse({ success: true, request: Array.isArray(created) ? created[0] : created }, env, { status: 201 });
}

interface AgoraConnectionRow {
  id: string;
  location_name: string;
  enabled: boolean;
  write_mode: string | null;
  last_sync_at: string | null;
  last_business_day_synced: string | null;
  catalog_sync_enabled: boolean | null;
  circuit_breaker_paused_until: string | null;
  circuit_breaker_reason: string | null;
  consecutive_failures: number | null;
}

function apiQuery(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function compactError(value: unknown): string | null {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function asBool(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() === "true";
}

function looksLikeWine(value: string): boolean {
  return /\b(vino|vinos|tinto|tintos|blanco|blancos|rosado|rosados|copa|copas|magnum|espumoso|espumosos|champagne|cava|dulce|dulces|generoso|generosos|bodega|ribera|rioja)\b/i.test(value);
}

function countLegacyWineVisibleProducts(masterData: unknown): number {
  const row = (masterData || {}) as {
    families_json?: Array<Record<string, unknown>>;
    products_summary_json?: Array<Record<string, unknown>>;
  };
  const families = Array.isArray(row.families_json) ? row.families_json : [];
  const products = Array.isArray(row.products_summary_json) ? row.products_summary_json : [];
  const familyById = new Map(families.map((family) => [String(family.Id || ""), family]));

  return products.filter((product) => {
    const family = familyById.get(String(product.FamilyId || ""));
    const familyName = String(family?.Name || "");
    const productName = String(product.Name || "");
    const isWinerim = familyName.toUpperCase().includes("WINERIM") || productName.startsWith("B ") || productName.startsWith("C ") || productName.startsWith("M ");
    if (isWinerim) return false;
    if (!looksLikeWine(`${familyName} ${productName}`)) return false;

    const familyVisible = asBool(family?.ShowInPos, true) && !family?.DeletionDate;
    const productVisible = asBool(product.UseAsDirectSale, true) && asBool(product.SaleableAsMain, true) && !product.DeletionDate;
    return familyVisible && productVisible;
  }).length;
}

async function handleAgoraFleet(request: Request, env: Env): Promise<Response> {
  const unauthorized = requireAdminAccess(request, env);
  if (unauthorized) return unauthorized;

  const connectionQuery = apiQuery({
    provider: "eq.agora",
    select: "id,location_name,enabled,write_mode,last_sync_at,last_business_day_synced,catalog_sync_enabled,circuit_breaker_paused_until,circuit_breaker_reason,consecutive_failures",
    order: "location_name.asc",
  });
  const connectionsRes = await lovableCloudGetJson<AgoraConnectionRow[]>(env, `/pos_connections?${connectionQuery}`);

  if (connectionsRes.error) {
    const body = await connectionsRes.error.text().catch(() => "");
    return jsonResponse({
      success: false,
      error: "LOVABLE_CLOUD_AGORA_FLEET_ERROR",
      status: connectionsRes.error.status,
      detail: body.slice(0, 500),
    }, env, { status: connectionsRes.error.status });
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600000).toISOString();
  const rows = await Promise.all((connectionsRes.data || []).map(async (connection) => {
    const encodedConnectionId = encodeURIComponent(connection.id);
    const [
      verifiedProducts,
      masterData,
      latestStockError,
      latestOutboundError,
      mappedSales7d,
      salesLines7d,
      stockSuccess7d,
      stockFailedOpen,
      outboundOpen,
      outboundFailed,
    ] = await Promise.all([
      lovableCloudCount(env, `/winerim_push_tracking?connection_id=eq.${encodedConnectionId}&sync_status=eq.VERIFIED&select=id`),
      lovableCloudGetJson<Array<Record<string, unknown>>>(env, `/agora_master_data?connection_id=eq.${encodedConnectionId}&select=families_json,products_summary_json&limit=1`),
      lovableCloudGetJson<Array<Record<string, unknown>>>(env, `/stock_sync_log?connection_id=eq.${encodedConnectionId}&status=in.(FAILED,BLOCKED)&select=error_message,product_name,created_at&order=created_at.desc&limit=1`),
      lovableCloudGetJson<Array<Record<string, unknown>>>(env, `/outbound_tasks?connection_id=eq.${encodedConnectionId}&status=in.(FAILED,BLOCKED)&select=last_error,blocked_reason,task_type,created_at&order=created_at.desc&limit=1`),
      lovableCloudCount(env, `/sales_line_items?connection_id=eq.${encodedConnectionId}&winerim_product_id=not.is.null&created_at=gte.${encodeURIComponent(sevenDaysAgo)}&select=id`),
      lovableCloudCount(env, `/sales_line_items?connection_id=eq.${encodedConnectionId}&created_at=gte.${encodeURIComponent(sevenDaysAgo)}&select=id`),
      lovableCloudCount(env, `/stock_sync_log?connection_id=eq.${encodedConnectionId}&status=eq.SUCCESS&created_at=gte.${encodeURIComponent(sevenDaysAgo)}&select=id`),
      lovableCloudCount(env, `/stock_sync_log?connection_id=eq.${encodedConnectionId}&status=in.(FAILED,BLOCKED,PENDING)&select=id`),
      lovableCloudCount(env, `/outbound_tasks?connection_id=eq.${encodedConnectionId}&status=in.(QUEUED,RUNNING)&select=id`),
      lovableCloudCount(env, `/outbound_tasks?connection_id=eq.${encodedConnectionId}&status=in.(FAILED,BLOCKED)&select=id`),
    ]);

    const stockErrorRow = latestStockError.data?.[0];
    const outboundErrorRow = latestOutboundError.data?.[0];
    const stockError = stockErrorRow
      ? compactError(`${stockErrorRow.product_name || "Stock"}: ${stockErrorRow.error_message || ""}`)
      : null;
    const outboundError = outboundErrorRow
      ? compactError(`${outboundErrorRow.task_type || "Outbound"}: ${outboundErrorRow.last_error || outboundErrorRow.blocked_reason || ""}`)
      : null;

    return {
      connection,
      latestError: stockError || outboundError,
      metrics: {
        enabled: connection.enabled,
        writeMode: connection.write_mode,
        lastSyncAt: connection.last_sync_at,
        lastBusinessDaySynced: connection.last_business_day_synced,
        circuitBreakerPausedUntil: connection.circuit_breaker_paused_until,
        consecutiveFailures: connection.consecutive_failures || 0,
        verifiedProducts,
        legacyWineVisibleProducts: countLegacyWineVisibleProducts(masterData.data?.[0]),
        mappedSales7d,
        salesLines7d,
        stockSuccess7d,
        stockFailedOpen,
        outboundOpen,
        outboundFailed,
      },
    };
  }));

  return jsonResponse({ success: true, rows }, env);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "winerim-middleware-api",
        environment: env.ENVIRONMENT || "local",
        release: env.RELEASE || "dev",
      }, env);
    }

    if (request.method === "GET" && url.pathname === "/api/checklist") {
      const provider = (url.searchParams.get("provider") || "agora").toLowerCase() === "revo" ? "revo" : "agora";
      const checklist = getIntegrationChecklist(provider as ChecklistProvider);
      return jsonResponse({
        success: true,
        checklist,
        requiredCount: getRequiredItems(checklist).length,
        goLiveBlockingCount: getGoLiveBlockingItems(checklist).length,
      }, env);
    }

    if (request.method === "POST" && url.pathname === "/api/onboarding/test") {
      return handleOnboardingTest(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/onboarding/requests") {
      return handleCreateOnboardingRequest(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/agora/fleet") {
      return handleAgoraFleet(request, env);
    }

    const contactsMatch = url.pathname.match(/^\/api\/connections\/([^/]+)\/notification-contacts$/);
    if (request.method === "GET" && contactsMatch) {
      return handleNotificationContacts(request, env, contactsMatch[1]);
    }

    return jsonResponse({ success: false, error: "NOT_FOUND" }, env, { status: 404 });
  },
};
