// Read-only Winerim fleet client. GET only, allowlisted paths, restaurantId mandatory.
// The token is read from WINERIM_FLEET_READ_TOKEN and never logged, returned or stored.
const BASE = "https://app.winerim.com";
const ALLOWED = new Set(["/api/v2/restaurants", "/api/v2/sales/records", "/api/v2/stock/movements"]);

export class FleetReadError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function redact(s: string): string {
  return s.replace(/wfk_[A-Za-z0-9]+_[A-Za-z0-9]+/g, "wfk_[REDACTED]");
}

export function createFleetClient(token: string, fetchImpl: typeof fetch = fetch, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  if (!token || !token.startsWith("wfk_")) throw new FleetReadError(0, "WINERIM_FLEET_READ_TOKEN ausente o no es credencial de flota");
  let calls = 0;
  async function get(path: string, params: Record<string, string | number | undefined>) {
    if (!ALLOWED.has(path)) throw new FleetReadError(0, `Ruta no permitida: ${path}`);
    if (path !== "/api/v2/restaurants" && params.restaurantId == null) throw new FleetReadError(0, "restaurantId obligatorio");
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    for (let attempt = 0; attempt < 3; attempt++) {
      calls++;
      const r = await fetchImpl(`${BASE}${path}${q.toString() ? `?${q.toString()}` : ""}`, { method: "GET", headers: { "WINERIM-API-TOKEN": token, Accept: "application/json" } });
      if (r.status === 429) { await sleep(Math.min(120, Number(r.headers.get("Retry-After") || 30)) * 1000); continue; }
      if (r.status === 503) { await sleep(3000 * (attempt + 1)); continue; }
      if (!r.ok) throw new FleetReadError(r.status, redact(`HTTP ${r.status} ${path}: ${(await r.text()).slice(0, 200)}`));
      return await r.json();
    }
    throw new FleetReadError(429, `Sin respuesta tras reintentos: ${path}`);
  }
  return {
    get calls() { return calls; },
    restaurants: () => get("/api/v2/restaurants", {}),
    salesByDate: (restaurantId: number, from: string, to: string, page = 1, orderId?: string) =>
      get("/api/v2/sales/records", { restaurantId, from, to, page, orderId, limit: 100, status: "all" }),
    salesSync: (restaurantId: number, changedSince?: string, cursor?: string) =>
      get("/api/v2/sales/records", { restaurantId, changedSince: cursor ? undefined : changedSince, cursor, limit: 100 }),
    movements: (restaurantId: number, p: { afterId?: number; from?: string; to?: string; category?: string; priceId?: number; stockId?: number }) =>
      get("/api/v2/stock/movements", { restaurantId, ...p, limit: 100 }),
  };
}
export type FleetClient = ReturnType<typeof createFleetClient>;
