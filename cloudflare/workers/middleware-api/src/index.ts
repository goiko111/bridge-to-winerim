import {
  buildInitialOnboardingGates,
  isReadyForTechnicalReview,
  type CommercialOnboardingInput,
  type GateStatus,
  type OnboardingGate,
  validateCommercialOnboardingInput,
} from "../../../../src/lib/middlewareOnboarding";
import {
  buildOnboardingRequestPayload,
  canTransitionOnboardingRequestStatus,
  isOnboardingRequestStatus,
} from "../../../../src/lib/onboardingRequest";

export interface Env {
  ENVIRONMENT?: string;
  RELEASE?: string;
  ALLOWED_ORIGIN?: string;
  ALLOWED_ORIGINS?: string;
  ONBOARDING_REQUESTS_ENABLED?: string;
  ONBOARDING_REQUESTS_REQUIRE_ACCESS_EMAIL?: string;
  LOVABLE_CLOUD_REST_URL?: string;
  LOVABLE_CLOUD_SERVICE_KEY?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
}

const WINERIM_API_BASE_URL = "https://app.winerim.com/api/v2";
const REQUEST_TIMEOUT_MS = 8000;
const ONBOARDING_REQUEST_COLUMNS = [
  "id",
  "provider",
  "location_name",
  "pos_base_url",
  "status",
  "requested_by_email",
  "normalized_input",
  "test_gates",
  "test_summary",
  "ready_for_technical_review",
  "notes",
  "submitted_at",
  "tested_at",
  "reviewed_at",
  "converted_at",
  "created_at",
  "updated_at",
].join(",");
interface AccessJwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}
interface AccessJwtPayload {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iss?: string;
  sub?: string;
}
interface AccessCertsResponse {
  keys?: JsonWebKey[];
}

let accessCertsCache: { teamDomain: string; fetchedAt: number; keys: JsonWebKey[] } | undefined;

function allowedOrigins(env: Env): string[] {
  return String(env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsOrigin(request: Request, env: Env): string {
  const requestOrigin = request.headers.get("Origin");
  const allowed = allowedOrigins(env);
  if (!requestOrigin) return allowed[0] || "*";
  if (allowed.includes(requestOrigin) || allowed.includes("*")) return requestOrigin;
  return allowed[0] || "null";
}

function corsHeaders(request: Request, env: Env): HeadersInit {
  return {
    "Access-Control-Allow-Origin": corsOrigin(request, env),
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, CF-Access-Client-Id, CF-Access-Client-Secret, CF-Access-Jwt-Assertion",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(request: Request, body: unknown, env: Env, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      ...corsHeaders(request, env),
      "Content-Type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
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

function isEnabled(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function requestEmail(request: Request): string | undefined {
  return request.headers.get("CF-Access-Authenticated-User-Email")?.trim() || undefined;
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJwtPart<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as T;
}

function accessAudienceMatches(actual: string | string[] | undefined, expected: string): boolean {
  if (Array.isArray(actual)) return actual.includes(expected);
  return actual === expected;
}

async function fetchAccessKeys(env: Env): Promise<JsonWebKey[]> {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN?.replace(/\/+$/, "");
  if (!teamDomain) throw new Error("ACCESS_TEAM_DOMAIN_NOT_CONFIGURED");

  const now = Date.now();
  if (accessCertsCache && accessCertsCache.teamDomain === teamDomain && now - accessCertsCache.fetchedAt < 10 * 60 * 1000) {
    return accessCertsCache.keys;
  }

  const response = await fetchWithTimeout(`${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`ACCESS_CERTS_FAILED:${response.status}`);
  const body = await response.json() as AccessCertsResponse;
  const keys = Array.isArray(body.keys) ? body.keys : [];
  accessCertsCache = { teamDomain, fetchedAt: now, keys };
  return keys;
}

async function verifyAccessJwt(request: Request, env: Env): Promise<string | undefined> {
  const expectedAud = env.CF_ACCESS_AUD?.trim();
  if (!expectedAud) return requestEmail(request);

  const token = request.headers.get("CF-Access-Jwt-Assertion")?.trim();
  if (!token) return undefined;

  const parts = token.split(".");
  if (parts.length !== 3) return undefined;

  const header = decodeJwtPart<AccessJwtHeader>(parts[0]);
  const payload = decodeJwtPart<AccessJwtPayload>(parts[1]);
  if (header.alg !== "RS256" || !header.kid) return undefined;
  if (!accessAudienceMatches(payload.aud, expectedAud)) return undefined;
  if (typeof payload.exp === "number" && payload.exp <= Math.floor(Date.now() / 1000)) return undefined;

  const keys = await fetchAccessKeys(env);
  const jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) return undefined;

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = base64UrlToBytes(parts[2]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data);
  if (!valid) return undefined;

  return payload.email || requestEmail(request);
}

async function requireAccessEmail(request: Request, env: Env): Promise<string | Response> {
  const requireAccess = env.ONBOARDING_REQUESTS_REQUIRE_ACCESS_EMAIL !== "false";
  let email: string | undefined;
  try {
    email = await verifyAccessJwt(request, env);
  } catch {
    email = undefined;
  }

  if (requireAccess && !email) {
    return jsonResponse(request, { success: false, error: "ACCESS_IDENTITY_REQUIRED" }, env, { status: 401 });
  }
  return email || "local-dev@winerim.local";
}

function parseSubmittedGates(value: unknown): OnboardingGate[] {
  if (!Array.isArray(value)) return [];

  const allowedStatuses: GateStatus[] = ["pass", "warn", "fail", "blocked"];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const candidate = item as Record<string, unknown>;
      const status = String(candidate.status || "");
      if (!allowedStatuses.includes(status as GateStatus)) return null;
      return {
        id: String(candidate.id || "unknown").slice(0, 80),
        label: String(candidate.label || "Gate").slice(0, 120),
        status: status as GateStatus,
        detail: String(candidate.detail || "").slice(0, 500),
      };
    })
    .filter((item): item is OnboardingGate => Boolean(item));
}

function revoEndpoint(baseUrl: string, path: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  if (/\/v2$/i.test(cleanBase) && cleanPath.startsWith("/v2/")) {
    return `${cleanBase}${cleanPath.slice(3)}`;
  }
  return `${cleanBase}${cleanPath}`;
}

function storageHeaders(env: Env, extra: HeadersInit = {}): HeadersInit {
  const serviceKey = env.LOVABLE_CLOUD_SERVICE_KEY;
  if (!serviceKey) throw new Error("REQUEST_STORAGE_NOT_CONFIGURED");

  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    ...extra,
  };
}

function storageUrl(env: Env, pathAndQuery: string): string {
  const restUrl = env.LOVABLE_CLOUD_REST_URL?.replace(/\/+$/, "");
  if (!restUrl) throw new Error("REQUEST_STORAGE_NOT_CONFIGURED");
  const cleanPath = pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`;
  return `${restUrl}${cleanPath}`;
}

async function fetchStorage(env: Env, pathAndQuery: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithTimeout(storageUrl(env, pathAndQuery), {
    ...init,
    headers: storageHeaders(env, init.headers || {}),
  });
}

function storageDisabledResponse(request: Request, env: Env): Response | undefined {
  if (!isEnabled(env.ONBOARDING_REQUESTS_ENABLED)) {
    return jsonResponse(request, { success: false, error: "REQUEST_STORAGE_DISABLED" }, env, { status: 503 });
  }
  return undefined;
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
    return jsonResponse(request, { success: false, error: "INVALID_JSON" }, env, { status: 400 });
  }

  const validation = validateCommercialOnboardingInput(body as Partial<CommercialOnboardingInput>);
  if (!validation.valid) {
    return jsonResponse(request, {
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

  return jsonResponse(request, {
    success: true,
    environment: env.ENVIRONMENT || "local",
    normalized: {
      provider: input.provider,
      locationName: input.locationName,
      posBaseUrl: input.posBaseUrl,
      revoTenant: input.provider === "revo" ? input.revoTenant : undefined,
    },
    gates,
    readyForTechnicalReview: isReadyForTechnicalReview(gates),
  }, env);
}

async function insertOnboardingRequest(row: Record<string, unknown>, env: Env): Promise<{ id?: string }> {
  const response = await fetchStorage(env, "/onboarding_requests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });

  if (!response.ok) throw new Error(`REQUEST_STORAGE_FAILED:${response.status}`);

  const body = await response.json().catch(() => null);
  if (Array.isArray(body) && body[0] && typeof body[0].id === "string") return { id: body[0].id };
  return {};
}

async function fetchOnboardingRequest(id: string, env: Env): Promise<Record<string, unknown> | undefined> {
  const params = new URLSearchParams({
    id: `eq.${id}`,
    select: "id,status,notes",
    limit: "1",
  });
  const response = await fetchStorage(env, `/onboarding_requests?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`REQUEST_STORAGE_FAILED:${response.status}`);
  const items = await response.json().catch(() => []);
  return Array.isArray(items) ? items[0] : undefined;
}

async function handleOnboardingRequest(request: Request, env: Env): Promise<Response> {
  const disabled = storageDisabledResponse(request, env);
  if (disabled) return disabled;

  const accessResult = await requireAccessEmail(request, env);
  if (accessResult instanceof Response) return accessResult;
  const email = accessResult;

  let body: Record<string, unknown>;
  try {
    body = await parseJsonOnce(request);
  } catch {
    return jsonResponse(request, { success: false, error: "INVALID_JSON" }, env, { status: 400 });
  }

  const input = (body.input || body) as Partial<CommercialOnboardingInput>;
  const validation = validateCommercialOnboardingInput(input);
  if (!validation.valid) {
    return jsonResponse(request, {
      success: false,
      error: "VALIDATION_FAILED",
      errors: validation.errors,
      gates: buildInitialOnboardingGates(input),
    }, env, { status: 400 });
  }

  const submittedGates = parseSubmittedGates(body.gates);
  const gates = submittedGates.length > 0 ? submittedGates : buildInitialOnboardingGates(validation.normalized);
  const payload = buildOnboardingRequestPayload(validation.normalized, gates);
  const now = new Date().toISOString();
  const status = payload.testSummary.readyForTechnicalReview ? "READY_FOR_TECHNICAL_REVIEW" : "TESTED";

  const row = {
    provider: payload.provider,
    location_name: payload.locationName,
    pos_base_url: payload.posBaseUrl,
    status,
    source: "commercial_onboarding",
    requested_by_email: email,
    normalized_input: payload.normalizedInput,
    test_gates: payload.testGates,
    test_summary: payload.testSummary,
    secret_refs: {},
    ready_for_technical_review: payload.testSummary.readyForTechnicalReview,
    notes: typeof body.notes === "string" ? body.notes.slice(0, 1000) : null,
    submitted_at: now,
    tested_at: now,
  };

  try {
    const result = await insertOnboardingRequest(row, env);
    return jsonResponse(request, {
      success: true,
      id: result.id,
      status,
      readyForTechnicalReview: payload.testSummary.readyForTechnicalReview,
    }, env, { status: 201 });
  } catch (error) {
    const message = String(error);
    const code = message.includes("REQUEST_STORAGE_NOT_CONFIGURED")
      ? "REQUEST_STORAGE_NOT_CONFIGURED"
      : "REQUEST_STORAGE_FAILED";
    return jsonResponse(request, { success: false, error: code }, env, { status: 503 });
  }
}

async function handleListOnboardingRequests(request: Request, env: Env): Promise<Response> {
  const disabled = storageDisabledResponse(request, env);
  if (disabled) return disabled;

  const accessResult = await requireAccessEmail(request, env);
  if (accessResult instanceof Response) return accessResult;

  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || "50") || 50, 1), 100);
  const status = url.searchParams.get("status");
  const params = new URLSearchParams({
    select: ONBOARDING_REQUEST_COLUMNS,
    order: "created_at.desc",
    limit: String(limit),
  });
  if (status && isOnboardingRequestStatus(status)) params.set("status", `eq.${status}`);

  try {
    const response = await fetchStorage(env, `/onboarding_requests?${params.toString()}`, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return jsonResponse(request, { success: false, error: "REQUEST_STORAGE_FAILED" }, env, { status: 503 });
    }

    const items = await response.json().catch(() => []);
    return jsonResponse(request, { success: true, items: Array.isArray(items) ? items : [] }, env);
  } catch (error) {
    const message = String(error);
    const code = message.includes("REQUEST_STORAGE_NOT_CONFIGURED")
      ? "REQUEST_STORAGE_NOT_CONFIGURED"
      : "REQUEST_STORAGE_FAILED";
    return jsonResponse(request, { success: false, error: code }, env, { status: 503 });
  }
}

async function handleUpdateOnboardingRequest(request: Request, env: Env, id: string): Promise<Response> {
  const disabled = storageDisabledResponse(request, env);
  if (disabled) return disabled;

  const accessResult = await requireAccessEmail(request, env);
  if (accessResult instanceof Response) return accessResult;
  const email = accessResult;

  let body: Record<string, unknown>;
  try {
    body = await parseJsonOnce(request);
  } catch {
    return jsonResponse(request, { success: false, error: "INVALID_JSON" }, env, { status: 400 });
  }

  const status = String(body.status || "").trim();
  if (!isOnboardingRequestStatus(status)) {
    return jsonResponse(request, { success: false, error: "INVALID_STATUS" }, env, { status: 400 });
  }

  let current: Record<string, unknown> | undefined;
  try {
    current = await fetchOnboardingRequest(id, env);
  } catch (error) {
    const message = String(error);
    const code = message.includes("REQUEST_STORAGE_NOT_CONFIGURED")
      ? "REQUEST_STORAGE_NOT_CONFIGURED"
      : "REQUEST_STORAGE_FAILED";
    return jsonResponse(request, { success: false, error: code }, env, { status: 503 });
  }

  const currentStatus = String(current?.status || "");
  if (!current || !isOnboardingRequestStatus(currentStatus)) {
    return jsonResponse(request, { success: false, error: "REQUEST_NOT_FOUND" }, env, { status: 404 });
  }

  if (!canTransitionOnboardingRequestStatus(currentStatus, status)) {
    return jsonResponse(request, {
      success: false,
      error: "INVALID_STATUS_TRANSITION",
      from: currentStatus,
      to: status,
    }, env, { status: 409 });
  }

  const existingNotes = typeof current.notes === "string" ? current.notes.trim() : "";
  const note = typeof body.notes === "string" ? body.notes.trim().slice(0, 1000) : "";
  const patch: Record<string, unknown> = {
    status,
  };
  const now = new Date().toISOString();
  if (status === "TECHNICAL_REVIEW" || status === "APPROVED" || status === "REJECTED") patch.reviewed_at = now;
  if (status === "CONVERTED") patch.converted_at = now;
  if (note) {
    patch.notes = [
      existingNotes,
      `${note}\nActualizado por ${email} (${now})`,
    ].filter(Boolean).join("\n\n").slice(0, 1000);
  }

  try {
    const params = new URLSearchParams({
      id: `eq.${id}`,
      select: ONBOARDING_REQUEST_COLUMNS,
    });
    const response = await fetchStorage(env, `/onboarding_requests?${params.toString()}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(patch),
    });

    if (!response.ok) {
      return jsonResponse(request, { success: false, error: "REQUEST_STORAGE_FAILED" }, env, { status: 503 });
    }

    const items = await response.json().catch(() => []);
    return jsonResponse(request, { success: true, item: Array.isArray(items) ? items[0] : undefined }, env);
  } catch (error) {
    const message = String(error);
    const code = message.includes("REQUEST_STORAGE_NOT_CONFIGURED")
      ? "REQUEST_STORAGE_NOT_CONFIGURED"
      : "REQUEST_STORAGE_FAILED";
    return jsonResponse(request, { success: false, error: code }, env, { status: 503 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(request, {
        ok: true,
        service: "winerim-middleware-api",
        environment: env.ENVIRONMENT || "local",
        release: env.RELEASE || "dev",
      }, env);
    }

    if (request.method === "POST" && url.pathname === "/api/onboarding/test") {
      return handleOnboardingTest(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/onboarding/requests") {
      return handleOnboardingRequest(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/onboarding/requests") {
      return handleListOnboardingRequests(request, env);
    }

    const requestMatch = url.pathname.match(/^\/api\/onboarding\/requests\/([0-9a-f-]{8,})$/i);
    if (request.method === "PATCH" && requestMatch) {
      return handleUpdateOnboardingRequest(request, env, requestMatch[1]);
    }

    return jsonResponse(request, { success: false, error: "NOT_FOUND" }, env, { status: 404 });
  },
};
