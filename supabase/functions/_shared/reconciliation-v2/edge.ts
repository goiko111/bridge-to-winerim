import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export function serverClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function requestClient(authorization: string): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function requirePlatformAdmin(request: Request): Promise<{ userId: string; db: SupabaseClient }> {
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) throw Object.assign(new Error("Falta autenticación"), { status: 401 });
  const authClient = requestClient(authorization);
  const { data, error } = await authClient.auth.getUser();
  if (error || !data.user) throw Object.assign(new Error("Sesión inválida"), { status: 401 });
  const { data: isAdmin, error: roleError } = await authClient.rpc("is_platform_admin");
  if (roleError) throw Object.assign(new Error("No se pudo validar el rol"), { status: 500 });
  if (isAdmin !== true) throw Object.assign(new Error("Solo administradores de plataforma"), { status: 403 });
  return { userId: data.user.id, db: serverClient() };
}

export const SCHEDULER_KEY_HEADER = "x-reconciliation-scheduler-key";

/**
 * Platform admin JWT, or the rotating scheduler service identity. The scheduler key is
 * never stored in plaintext here: only its SHA-256 lives in a service-role-only table.
 * Callers MUST apply assertSchedulerRequest() when `scheduler` is true.
 */
export async function requireAdminOrScheduler(request: Request): Promise<{ userId: string | null; db: SupabaseClient; scheduler: boolean }> {
  const key = request.headers.get(SCHEDULER_KEY_HEADER);
  if (key == null) return { ...(await requirePlatformAdmin(request)), scheduler: false };
  if (key.length < 32 || key.length > 256) throw Object.assign(new Error("Identidad de servicio inválida"), { status: 401, code: "SCHEDULER_IDENTITY_INVALID" });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  const hash = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  const db = serverClient();
  const { data, error } = await db.from("reconciliation_v2_scheduler_identities").select("id").eq("key_sha256", hash).is("revoked_at", null).maybeSingle();
  if (error) throw Object.assign(new Error("No se pudo validar la identidad de servicio"), { status: 500, code: "SCHEDULER_IDENTITY_CHECK_FAILED" });
  if (!data) throw Object.assign(new Error("Identidad de servicio inválida o revocada"), { status: 401, code: "SCHEDULER_IDENTITY_INVALID" });
  return { userId: null, db, scheduler: true };
}

export async function requireAuthenticated(request: Request): Promise<{ userId: string; db: SupabaseClient }> {
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) throw Object.assign(new Error("Falta autenticación"), { status: 401 });
  const db = requestClient(authorization);
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) throw Object.assign(new Error("Sesión inválida"), { status: 401 });
  return { userId: data.user.id, db };
}

function allowedOrigins(): Set<string> {
  return new Set((Deno.env.get("EDGE_ALLOWED_ORIGINS") ?? "").split(",").map((origin) => origin.trim()).filter(Boolean));
}

export function corsFor(request: Request): HeadersInit {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = allowedOrigins();
  return origin && allowed.has(origin) ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    Vary: "Origin",
  } : {};
}

export function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsFor(request) } });
}

export function preflight(request: Request): Response | null {
  if (request.method !== "OPTIONS") return null;
  const headers = corsFor(request);
  return Object.keys(headers).length ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 });
}

export async function parseJson<T>(request: Request): Promise<T> {
  if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json") throw Object.assign(new Error("Content-Type debe ser application/json"), { status: 415 });
  return await request.json() as T;
}


export function assertPost(request: Request): void {
  if (request.method !== "POST") throw Object.assign(new Error("Método no permitido"), { status: 405 });
}

export function asDryRun(value: unknown): boolean {
  return value === undefined ? true : value === true;
}

export function safeError(request: Request, error: unknown): Response {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 500;
  const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "UNEXPECTED_ERROR";
  const message = error instanceof Error ? error.message : "Error inesperado";
  return json(request, { ok: false, code, message }, Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500);
}
