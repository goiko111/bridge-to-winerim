import {
  buildInitialOnboardingGates,
  isReadyForTechnicalReview,
  type CommercialOnboardingInput,
  type GateStatus,
  type OnboardingGate,
  validateCommercialOnboardingInput,
} from "../../../../src/lib/middlewareOnboarding";

export interface Env {
  ENVIRONMENT?: string;
  RELEASE?: string;
  ALLOWED_ORIGIN?: string;
  ALLOWED_ORIGINS?: string;
}

const WINERIM_API_BASE_URL = "https://app.winerim.com/api/v2";
const REQUEST_TIMEOUT_MS = 8000;

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
  return allowed[0] || requestOrigin;
}

function corsHeaders(request: Request, env: Env): HeadersInit {
  return {
    "Access-Control-Allow-Origin": corsOrigin(request, env),
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, CF-Access-Client-Id, CF-Access-Client-Secret",
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

    return jsonResponse(request, { success: false, error: "NOT_FOUND" }, env, { status: 404 });
  },
};
