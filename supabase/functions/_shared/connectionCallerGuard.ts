// Control de llamante para funciones que usan service_role por connectionId.
// Deja pasar solo: (1) llamadas internas con la clave de servicio exacta
// (cron-dispatcher, winerim-proxy → agora-proxy, auto-invocaciones), o
// (2) un usuario con sesión que sea admin de plataforma o tenga acceso al
// restaurante (can_access_connection). Todo lo demás: 401/403, fail-closed.

export type CallerDecision =
  | { ok: true; kind: "internal" | "admin" | "tenant"; userId?: string }
  | { ok: false; status: 400 | 401 | 403 | 500; code: string };

export type CallerDeps = {
  serviceKey: string | undefined;
  getUserId: (jwt: string) => Promise<string | null>;
  isPlatformAdmin: (jwt: string) => Promise<boolean>;
  canAccessConnection: (jwt: string, connectionId: string) => Promise<boolean>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function decideCaller(authHeader: string | null, connectionId: unknown, deps: CallerDeps): Promise<CallerDecision> {
  if (typeof connectionId !== "string" || !UUID.test(connectionId)) return { ok: false, status: 400, code: "INVALID_CONNECTION_ID" };
  const m = /^Bearer\s+(.+)$/i.exec(authHeader ?? "");
  if (!m) return { ok: false, status: 401, code: "MISSING_AUTH" };
  const token = m[1].trim();
  if (deps.serviceKey && safeEqual(token, deps.serviceKey)) return { ok: true, kind: "internal" };
  try {
    const userId = await deps.getUserId(token);
    if (!userId) return { ok: false, status: 401, code: "INVALID_SESSION" };
    if (await deps.isPlatformAdmin(token)) return { ok: true, kind: "admin", userId };
    if (await deps.canAccessConnection(token, connectionId)) return { ok: true, kind: "tenant", userId };
    return { ok: false, status: 403, code: "CONNECTION_FORBIDDEN" };
  } catch {
    return { ok: false, status: 500, code: "ACCESS_CHECK_FAILED" };
  }
}

/** Adaptador Deno: usa el cliente de supabase-js con la sesión del llamante. */
// deno-lint-ignore no-explicit-any
export function supabaseCallerDeps(createClient: any, url: string, anonKey: string, serviceKey: string | undefined): CallerDeps {
  // deno-lint-ignore no-explicit-any
  const asUser = (jwt: string): any => createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false } });
  return {
    serviceKey,
    getUserId: async (jwt) => { const { data, error } = await asUser(jwt).auth.getUser(jwt); return error ? null : data?.user?.id ?? null; },
    isPlatformAdmin: async (jwt) => { const { data, error } = await asUser(jwt).rpc("is_platform_admin"); if (error) throw error; return data === true; },
    canAccessConnection: async (jwt, id) => { const { data, error } = await asUser(jwt).rpc("can_access_connection", { _connection_id: id }); if (error) throw error; return data === true; },
  };
}

export function callerDeniedResponse(d: Extract<CallerDecision, { ok: false }>, cors: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: d.code }), { status: d.status, headers: { ...cors, "Content-Type": "application/json" } });
}
