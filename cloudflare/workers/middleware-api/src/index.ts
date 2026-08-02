import {
  buildInitialOnboardingGates,
  buildTechnicalReviewPacket,
  isReadyForTechnicalReview,
  sanitizeTechnicalReviewPacketPayload,
  validateOnboardingDestination,
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
import { Client } from "pg";
import {
  createHyperdrivePostgresAdapter,
  sql,
  type DatabaseAdapter,
  type DriverQueryConfig,
  type HyperdriveBinding,
  type PostgresClientFactory,
} from "./db";

export interface Env {
  ENVIRONMENT?: string;
  RELEASE?: string;
  ALLOWED_ORIGIN?: string;
  MIDDLEWARE_ADMIN_TOKEN?: string;
  POS_TEST_ALLOWED_HOSTS?: string;
  MIDDLEWARE_DB?: HyperdriveBinding;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  REQUIRE_ACCESS_JWT?: string;
}

const WINERIM_API_BASE_URL = "https://app.winerim.com/api/v2";
const REQUEST_TIMEOUT_MS = 8000;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_POS_RESPONSE_BYTES = 128 * 1024;

class PayloadTooLargeError extends Error {
  constructor() {
    super("PAYLOAD_TOO_LARGE");
    this.name = "PayloadTooLargeError";
  }
}

function corsHeaders(env: Env): HeadersInit {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Middleware-Token, CF-Access-Jwt-Assertion",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
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

interface AccessJwtHeader { alg?: string; kid?: string }
interface AccessJwtPayload { aud?: string | string[]; email?: string; exp?: number; nbf?: number; iss?: string }
interface AccessCertsResponse { keys?: JsonWebKey[] }
let accessCertsCache: { teamDomain: string; fetchedAt: number; keys: JsonWebKey[] } | undefined;

function accessJwtFromRequest(request: Request): string {
  const assertion = request.headers.get("CF-Access-Jwt-Assertion")?.trim();
  if (assertion) return assertion;
  const cookie = request.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === "CF_Authorization") return valueParts.join("=").trim();
  }
  return "";
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJwtPart<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as T;
}

function accessAudienceMatches(actual: string | string[] | undefined, expected: string): boolean {
  return Array.isArray(actual) ? actual.includes(expected) : actual === expected;
}

function normalizedAccessTeamDomain(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

async function fetchAccessKeys(teamDomain: string): Promise<JsonWebKey[]> {
  const now = Date.now();
  if (accessCertsCache && accessCertsCache.teamDomain === teamDomain && now - accessCertsCache.fetchedAt < 10 * 60 * 1000) {
    return accessCertsCache.keys;
  }
  const response = await fetchWithTimeout(`${teamDomain}/cdn-cgi/access/certs`, { redirect: "error" });
  if (!response.ok) throw new Error("ACCESS_CERTS_UNAVAILABLE");
  const body = await response.json() as AccessCertsResponse;
  const keys = Array.isArray(body.keys) ? body.keys : [];
  accessCertsCache = { teamDomain, fetchedAt: now, keys };
  return keys;
}

export async function verifyAccessJwt(request: Request, env: Env): Promise<{ valid: boolean; reason?: string }> {
  const expectedAudience = env.CF_ACCESS_AUD?.trim();
  const teamDomain = normalizedAccessTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  if (!expectedAudience || !teamDomain) return { valid: false, reason: "ACCESS_CONFIG_INVALID" };
  const token = accessJwtFromRequest(request);
  if (!token) return { valid: false, reason: "ACCESS_TOKEN_MISSING" };
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, reason: "ACCESS_TOKEN_MALFORMED" };

  try {
    const header = decodeJwtPart<AccessJwtHeader>(parts[0]);
    const payload = decodeJwtPart<AccessJwtPayload>(parts[1]);
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== "RS256" || !header.kid) return { valid: false, reason: "ACCESS_ALGORITHM_INVALID" };
    if (!accessAudienceMatches(payload.aud, expectedAudience)) return { valid: false, reason: "ACCESS_AUDIENCE_INVALID" };
    if (payload.iss !== teamDomain) return { valid: false, reason: "ACCESS_ISSUER_INVALID" };
    if (typeof payload.exp !== "number" || payload.exp <= now) return { valid: false, reason: "ACCESS_TOKEN_EXPIRED" };
    if (typeof payload.nbf === "number" && payload.nbf > now + 30) return { valid: false, reason: "ACCESS_TOKEN_NOT_ACTIVE" };

    const keys = await fetchAccessKeys(teamDomain);
    const jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA");
    if (!jwk) return { valid: false, reason: "ACCESS_KEY_NOT_FOUND" };
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    return valid ? { valid: true } : { valid: false, reason: "ACCESS_SIGNATURE_INVALID" };
  } catch {
    return { valid: false, reason: "ACCESS_VERIFICATION_FAILED" };
  }
}

async function requireAdminAccess(request: Request, env: Env): Promise<Response | null> {
  if (env.REQUIRE_ACCESS_JWT === "true") {
    if ((await verifyAccessJwt(request, env)).valid) return null;
    return jsonResponse({ success: false, error: "ACCESS_IDENTITY_REQUIRED" }, env, { status: 401 });
  }
  if (!env.MIDDLEWARE_ADMIN_TOKEN) {
    return jsonResponse({ success: false, error: "ADMIN_TOKEN_NOT_CONFIGURED" }, env, { status: 503 });
  }
  if (bearerToken(request) !== env.MIDDLEWARE_ADMIN_TOKEN) {
    return jsonResponse({ success: false, error: "UNAUTHORIZED" }, env, { status: 401 });
  }
  return null;
}

const createPostgresClient: PostgresClientFactory = ({ connectionString, applicationName }) => {
  const client = new Client({ connectionString, application_name: applicationName });
  return {
    connect: () => client.connect(),
    query: async <Row extends Record<string, unknown>>(query: string | DriverQueryConfig) => {
      const result = await client.query<Row>(query);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    end: () => client.end(),
  };
};

function database(env: Env): DatabaseAdapter {
  if (!env.MIDDLEWARE_DB) throw new Error("MIDDLEWARE_DB_NOT_CONFIGURED");
  return createHyperdrivePostgresAdapter(env.MIDDLEWARE_DB, { createClient: createPostgresClient });
}

async function parseJsonOnce(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new PayloadTooLargeError();
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new PayloadTooLargeError();
  }
  if (!text.trim()) return {};
  return JSON.parse(text);
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...init, redirect: "error", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseTextLimited(response: Response, maxBytes = MAX_POS_RESPONSE_BYTES): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new PayloadTooLargeError();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
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

    return gate(
      "winerim",
      "Winerim",
      res.status === 401 || res.status === 403 ? "fail" : "warn",
      `Winerim responde HTTP ${res.status}.`,
    );
  } catch (error) {
    return gate("winerim", "Winerim", "fail", "No se pudo conectar con Winerim.");
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
      const body = await readResponseTextLimited(res).catch(() => "");
      const hasXmlShape = body.includes("<") && /Family|Families|ArrayOf/i.test(body.slice(0, 4096));
      return gate(
        "pos",
        "Agora",
        hasXmlShape ? "pass" : "warn",
        hasXmlShape ? "Agora accesible y export-master responde." : "Agora responde, pero la respuesta no parece XML de master data.",
      );
    }

    return gate("pos", "Agora", "fail", `Agora responde HTTP ${res.status}.`);
  } catch (error) {
    return gate("pos", "Agora", "fail", "No se pudo alcanzar la URL de Agora.");
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

    return gate("pos", "REVO", res.status === 401 || res.status === 403 ? "fail" : "warn", `REVO responde HTTP ${res.status}.`);
  } catch (error) {
    return gate("pos", "REVO", "fail", "No se pudo alcanzar la URL de REVO.");
  }
}

async function handleOnboardingTest(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await parseJsonOnce(request);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return jsonResponse({ success: false, error: "PAYLOAD_TOO_LARGE" }, env, { status: 413 });
    }
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
  const allowedHosts = String(env.POS_TEST_ALLOWED_HOSTS || "").split(",");
  const destination = validateOnboardingDestination(input.posBaseUrl, allowedHosts);
  if (!destination.allowed) {
    return jsonResponse({ success: false, error: destination.reason || "POS_DESTINATION_NOT_ALLOWED" }, env, { status: 403 });
  }
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
  const unauthorized = await requireAdminAccess(request, env);
  if (unauthorized) return unauthorized;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(connectionId)) {
    return jsonResponse({ success: false, error: "INVALID_CONNECTION_ID" }, env, { status: 400 });
  }

  try {
    const result = await database(env).query(sql`
      SELECT id, connection_id, contact_type, display_name, email, phone,
             notify_on_health_failure, notify_on_stock_failure, notify_on_catalog_failure
      FROM connection_notification_contacts
      WHERE connection_id = ${connectionId} AND enabled = true
      ORDER BY contact_type ASC, display_name ASC
    `);
    return jsonResponse({ success: true, connectionId, contacts: result.rows }, env);
  } catch (error) {
    return jsonResponse({
      success: false,
      error: "DATABASE_CONTACTS_ERROR",
      detail: compactError(error instanceof Error ? error.message : error),
    }, env, { status: 503 });
  }
}

async function handleCreateOnboardingRequest(request: Request, env: Env): Promise<Response> {
  const unauthorized = await requireAdminAccess(request, env);
  if (unauthorized) return unauthorized;

  let body: Record<string, unknown>;
  try {
    body = await parseJsonOnce(request);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return jsonResponse({ success: false, error: "PAYLOAD_TOO_LARGE" }, env, { status: 413 });
    }
    return jsonResponse({ success: false, error: "INVALID_JSON" }, env, { status: 400 });
  }

  const sanitized = sanitizeTechnicalReviewPacketPayload(body);
  if (!sanitized.valid || !sanitized.reviewPacket) {
    return jsonResponse({ success: false, error: "INVALID_REVIEW_PACKET", errors: sanitized.errors }, env, { status: 400 });
  }

  const reviewPacket = sanitized.reviewPacket;

  try {
    const status = reviewPacket.readyForTechnicalReview ? "READY_FOR_TECHNICAL_REVIEW" : "DRAFT";
    const result = await database(env).query(sql`
      INSERT INTO integration_onboarding_requests (
        provider, location_name, pos_base_url, revo_tenant, status,
        ready_for_technical_review, gate_summary, review_packet
      ) VALUES (
        ${reviewPacket.provider}, ${reviewPacket.locationName}, ${reviewPacket.posBaseUrl},
        ${reviewPacket.provider === "revo" ? reviewPacket.revoTenant || null : null}, ${status},
        ${reviewPacket.readyForTechnicalReview}, ${reviewPacket.gateSummary}, ${reviewPacket}
      )
      RETURNING id, provider, location_name, status, ready_for_technical_review, created_at
    `);
    return jsonResponse({ success: true, request: result.rows[0] }, env, { status: 201 });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: "DATABASE_ONBOARDING_REQUEST_ERROR",
      detail: compactError(error instanceof Error ? error.message : error),
    }, env, { status: 503 });
  }
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
  verified_products: number;
  master_data: Record<string, unknown> | null;
  stock_error: string | null;
  outbound_error: string | null;
  mapped_sales_7d: number;
  sales_lines_7d: number;
  stock_success_7d: number;
  stock_failed_open: number;
  outbound_open: number;
  outbound_failed: number;
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
  const unauthorized = await requireAdminAccess(request, env);
  if (unauthorized) return unauthorized;
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600000).toISOString();
  try {
    const result = await database(env).query<AgoraConnectionRow>(sql`
      SELECT
        c.id, c.location_name, c.enabled, c.write_mode, c.last_sync_at,
        c.last_business_day_synced, c.catalog_sync_enabled,
        c.circuit_breaker_paused_until, c.circuit_breaker_reason, c.consecutive_failures,
        (SELECT count(*)::int FROM winerim_push_tracking t
          WHERE t.connection_id = c.id AND t.sync_status = 'VERIFIED') AS verified_products,
        (SELECT jsonb_build_object('families_json', m.families_json, 'products_summary_json', m.products_summary_json)
          FROM agora_master_data m WHERE m.connection_id = c.id
          ORDER BY m.fetched_at DESC NULLS LAST LIMIT 1) AS master_data,
        (SELECT concat(coalesce(s.product_name, 'Stock'), ': ', coalesce(s.error_message, ''))
          FROM stock_sync_log s WHERE s.connection_id = c.id AND s.status IN ('FAILED', 'BLOCKED')
          ORDER BY s.created_at DESC LIMIT 1) AS stock_error,
        (SELECT concat(coalesce(o.task_type, 'Outbound'), ': ', coalesce(o.last_error, o.blocked_reason, ''))
          FROM outbound_tasks o WHERE o.connection_id = c.id AND o.status IN ('FAILED', 'BLOCKED')
          ORDER BY o.created_at DESC LIMIT 1) AS outbound_error,
        (SELECT count(*)::int FROM sales_line_items l
          WHERE l.connection_id = c.id AND l.winerim_product_id IS NOT NULL AND l.created_at >= ${sevenDaysAgo}) AS mapped_sales_7d,
        (SELECT count(*)::int FROM sales_line_items l
          WHERE l.connection_id = c.id AND l.created_at >= ${sevenDaysAgo}) AS sales_lines_7d,
        (SELECT count(*)::int FROM stock_sync_log s
          WHERE s.connection_id = c.id AND s.status = 'SUCCESS' AND s.created_at >= ${sevenDaysAgo}) AS stock_success_7d,
        (SELECT count(*)::int FROM stock_sync_log s
          WHERE s.connection_id = c.id AND s.status IN ('FAILED', 'BLOCKED', 'PENDING')) AS stock_failed_open,
        (SELECT count(*)::int FROM outbound_tasks o
          WHERE o.connection_id = c.id AND o.status IN ('QUEUED', 'RUNNING')) AS outbound_open,
        (SELECT count(*)::int FROM outbound_tasks o
          WHERE o.connection_id = c.id AND o.status IN ('FAILED', 'BLOCKED')) AS outbound_failed
      FROM pos_connections c
      WHERE c.provider = 'agora'
      ORDER BY c.location_name ASC
    `);

    const rows = result.rows.map((connection) => ({
      connection: {
        id: connection.id,
        location_name: connection.location_name,
        enabled: connection.enabled,
        write_mode: connection.write_mode,
        last_sync_at: connection.last_sync_at,
        last_business_day_synced: connection.last_business_day_synced,
        catalog_sync_enabled: connection.catalog_sync_enabled,
        circuit_breaker_paused_until: connection.circuit_breaker_paused_until,
        circuit_breaker_reason: connection.circuit_breaker_reason,
        consecutive_failures: connection.consecutive_failures,
      },
      latestError: compactError(connection.stock_error || connection.outbound_error),
      metrics: {
        enabled: connection.enabled,
        writeMode: connection.write_mode,
        lastSyncAt: connection.last_sync_at,
        lastBusinessDaySynced: connection.last_business_day_synced,
        circuitBreakerPausedUntil: connection.circuit_breaker_paused_until,
        consecutiveFailures: connection.consecutive_failures || 0,
        verifiedProducts: connection.verified_products,
        legacyWineVisibleProducts: countLegacyWineVisibleProducts(connection.master_data),
        mappedSales7d: connection.mapped_sales_7d,
        salesLines7d: connection.sales_lines_7d,
        stockSuccess7d: connection.stock_success_7d,
        stockFailedOpen: connection.stock_failed_open,
        outboundOpen: connection.outbound_open,
        outboundFailed: connection.outbound_failed,
      },
    }));
    return jsonResponse({ success: true, rows }, env);
  } catch (error) {
    return jsonResponse({
      success: false,
      error: "DATABASE_AGORA_FLEET_ERROR",
      detail: compactError(error instanceof Error ? error.message : error),
    }, env, { status: 503 });
  }
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

    if (request.method === "GET" && url.pathname === "/ready") {
      const unauthorized = await requireAdminAccess(request, env);
      if (unauthorized) return unauthorized;
      try {
        const result = await database(env).query<{
          value: string;
          role_name: string;
          api_role_member: boolean;
          runtime_role_member: boolean;
          unsafe_role: boolean;
          can_read_connections: boolean;
          can_mutate_connections: boolean;
        }>(sql`
          SELECT
            value,
            current_user AS role_name,
            pg_has_role(current_user, 'middleware_api', 'member') AS api_role_member,
            pg_has_role(current_user, 'middleware_runtime', 'member') AS runtime_role_member,
            (
              SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication
              FROM pg_roles
              WHERE rolname = current_user
            ) AS unsafe_role,
            has_table_privilege(current_user, 'public.pos_connections', 'SELECT') AS can_read_connections,
            has_table_privilege(current_user, 'public.pos_connections', 'INSERT,UPDATE,DELETE') AS can_mutate_connections
          FROM public.infrastructure_metadata
          WHERE key = 'environment'
        `);
        const readiness = result.rows[0];
        const identity = readiness?.value;
        if (identity !== (env.ENVIRONMENT || "local")) {
          return jsonResponse({ ok: false, error: "DATABASE_IDENTITY_MISMATCH" }, env, { status: 503 });
        }
        if (!readiness.api_role_member
          || readiness.runtime_role_member
          || readiness.unsafe_role
          || !readiness.can_read_connections
          || readiness.can_mutate_connections) {
          return jsonResponse({ ok: false, error: "DATABASE_ROLE_MISMATCH" }, env, { status: 503 });
        }
        return jsonResponse({ ok: true, database: identity, role: readiness.role_name }, env);
      } catch {
        return jsonResponse({ ok: false, error: "DATABASE_NOT_READY" }, env, { status: 503 });
      }
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
      const unauthorized = await requireAdminAccess(request, env);
      if (unauthorized) return unauthorized;
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
