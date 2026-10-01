import { describe, expect, it } from "vitest";
import { decideCaller, type CallerDeps } from "../../supabase/functions/_shared/connectionCallerGuard";

const CONN = "57e8acbe-5b5f-433c-a0c6-e760c211acd3";
const deps = (o: Partial<CallerDeps> = {}): CallerDeps => ({
  serviceKey: "svc-key",
  getUserId: async (t) => (t === "user-jwt" || t === "admin-jwt" ? "u1" : null),
  isPlatformAdmin: async (t) => t === "admin-jwt",
  canAccessConnection: async (t, id) => t === "user-jwt" && id === CONN,
  ...o,
});

describe("control de llamante agora-proxy / winerim-proxy", () => {
  it("sin cabecera → 401", async () => expect(await decideCaller(null, CONN, deps())).toMatchObject({ ok: false, status: 401 }));
  it("clave anon / token inválido → 401", async () => expect(await decideCaller("Bearer anon", CONN, deps())).toMatchObject({ ok: false, status: 401 }));
  it("clave de servicio exacta → interno", async () => expect(await decideCaller("Bearer svc-key", CONN, deps())).toMatchObject({ ok: true, kind: "internal" }));
  it("clave de servicio parecida no vale", async () => expect(await decideCaller("Bearer svc-kez", CONN, deps())).toMatchObject({ ok: false }));
  it("admin de plataforma → pasa", async () => expect(await decideCaller("Bearer admin-jwt", CONN, deps())).toMatchObject({ ok: true, kind: "admin" }));
  it("usuario con acceso al restaurante → pasa", async () => expect(await decideCaller("Bearer user-jwt", CONN, deps())).toMatchObject({ ok: true, kind: "tenant" }));
  it("usuario sin acceso a otro restaurante → 403", async () =>
    expect(await decideCaller("Bearer user-jwt", "706b952e-767d-41af-9cba-8e225b16a877", deps())).toMatchObject({ ok: false, status: 403 }));
  it("connectionId no UUID → 400", async () => expect(await decideCaller("Bearer svc-key", "x", deps())).toMatchObject({ ok: false, status: 400 }));
  it("fallo al comprobar → 500, nunca pasa", async () =>
    expect(await decideCaller("Bearer user-jwt", CONN, deps({ isPlatformAdmin: async () => { throw new Error("rpc"); } }))).toMatchObject({ ok: false, status: 500 }));
});

describe("llamada interna solo con cabecera apikey (supabase-js con clave sb_secret)", () => {
  it("apikey = clave de servicio sin Authorization → interno", async () =>
    expect(await decideCaller(null, CONN, deps(), "svc-key")).toMatchObject({ ok: true, kind: "internal" }));
  it("apikey distinta sin Authorization → 401", async () =>
    expect(await decideCaller(null, CONN, deps(), "anon")).toMatchObject({ ok: false, status: 401 }));
});
