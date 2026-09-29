import { describe, expect, it } from "vitest";
import { assertSchedulerRequest, CLINIC_CONNECTION_ID, summarizeFleet, closedBusinessDay, runScheduledPipeline, type SchedulerDeps, type StateRow, type StepResult } from "../../supabase/functions/_shared/reconciliation-v2/scheduler";

const binding = { metadata: { timezone: "Europe/Madrid", businessDayCutoffHour: 6 } };
const ok = (day: string, extra: Record<string, unknown> = {}): StepResult => ({ status: 200, body: { dryRun: false, state: "COMPLETE", overlap: { businessDay: day, complete: true }, ...extra } });

function harness(now: string, overrides: Partial<SchedulerDeps> = {}, initial: Record<string, StateRow & { updated?: number }> = {}) {
  const states = new Map(Object.entries(initial)); const calls: string[] = []; let tick = 0;
  let lock: { owner: string; expires: number } | null = null; const clock = { t: Date.parse(now) };
  const deps: SchedulerDeps = {
    now: () => new Date(clock.t),
    claim: async () => { if (lock && lock.expires > clock.t && lock.owner !== "me") return false; lock = { owner: "me", expires: clock.t + 900_000 }; return true; },
    release: async () => { if (lock?.owner === "me") lock = null; },
    getState: async (d) => states.get(d) ?? null,
    lastOtherState: async (d) => [...states.values()].filter((r) => r.business_day !== d).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0] ?? null,
    putState: async (d, p) => { states.set(d, { ...(states.get(d) ?? { business_day: d, attempts: 0, error_code: null }), ...p, business_day: d, updated: ++tick } as StateRow & { updated: number }); },
    sales: async (d) => { calls.push("sales"); return ok(d, { records: 3 }); },
    movements: async (d) => { calls.push("movements"); return ok(d, { movements: 2 }); },
    reconcile: async () => { calls.push("reconcile"); return { status: 200, body: { dryRun: false, runId: "r1", metrics: { states: { MATCHED: 1 } } } }; },
    ...overrides,
  };
  return { deps, states, calls, setLock: (l: typeof lock) => { lock = l; }, clock };
}

describe("closedBusinessDay (Europe/Madrid, corte 06:00)", () => {
  it("antes de las 06:00 locales el día anterior sigue abierto", () => {
    expect(closedBusinessDay(binding, new Date("2026-09-29T03:59:00Z"))).toBe("2026-09-27"); // 05:59 CEST
  });
  it("desde las 06:00 locales el día anterior queda cerrado", () => {
    expect(closedBusinessDay(binding, new Date("2026-09-29T04:00:00Z"))).toBe("2026-09-28"); // 06:00 CEST
    expect(closedBusinessDay(binding, new Date("2026-09-29T05:15:00Z"))).toBe("2026-09-28");
  });
  it("horario de invierno (UTC+1): 05:15Z son 06:15 locales", () => {
    expect(closedBusinessDay(binding, new Date("2026-12-15T05:15:00Z"))).toBe("2026-12-14");
    expect(closedBusinessDay(binding, new Date("2026-12-15T04:59:00Z"))).toBe("2026-12-13");
  });
  it("días de cambio de hora DST", () => {
    expect(closedBusinessDay(binding, new Date("2026-03-30T05:15:00Z"))).toBe("2026-03-29"); // día de 23h
    expect(closedBusinessDay(binding, new Date("2026-10-26T05:15:00Z"))).toBe("2026-10-25"); // día de 25h
    expect(closedBusinessDay(binding, new Date("2026-10-25T04:30:00Z"))).toBe("2026-10-23"); // 05:30 CET tras el cambio
  });
});

describe("assertSchedulerRequest", () => {
  const base = { connectionId: CLINIC_CONNECTION_ID, dryRun: false, historical: false, businessDay: "2026-09-28" };
  it("Ocean Club excluido y connectionId inválido rechazado", () => {
    expect(() => assertSchedulerRequest({ ...base, connectionId: "706b952e-767d-41af-9cba-8e225b16a877" })).toThrow(/alcance/);
    expect(() => assertSchedulerRequest({ ...base, connectionId: "no-uuid" })).toThrow(/alcance/);
    expect(() => assertSchedulerRequest({ ...base, connectionId: "21ee3345-1090-4e83-94f2-43126d6e7695" })).not.toThrow();
  });
  it("flota no conciliada con conexiones sin binding o incompletas", () => {
    const ok = { connectionId: CLINIC_CONNECTION_ID, outcome: "SUCCEEDED" as const, businessDay: "2026-09-28" };
    expect(summarizeFleet([ok], 0).fleetReconciled).toBe(true);
    expect(summarizeFleet([ok], 24).reasons).toContain("BLOQUEADO_SIN_BINDING:24");
    expect(summarizeFleet([ok, { ...ok, outcome: "SOURCE_INCOMPLETE" }], 0).fleetReconciled).toBe(false);
    expect(summarizeFleet([], 0).fleetReconciled).toBe(false);
  });
  it("rechaza modo histórico, dryRun implícito y día ausente", () => {
    expect(() => assertSchedulerRequest({ ...base, historical: true })).toThrow(/histórico/);
    expect(() => assertSchedulerRequest({ ...base, dryRun: undefined })).toThrow(/dryRun/);
    expect(() => assertSchedulerRequest({ ...base, businessDay: undefined })).toThrow(/explícito/);
    expect(() => assertSchedulerRequest(base)).not.toThrow();
  });
});

describe("runScheduledPipeline", () => {
  const now = "2026-09-29T05:15:00Z";
  it("orden ventas -> movimientos -> conciliación y SUCCEEDED", async () => {
    const h = harness(now); const out = await runScheduledPipeline(binding, h.deps);
    expect(out.outcome).toBe("SUCCEEDED"); expect(out.businessDay).toBe("2026-09-28"); expect(h.calls).toEqual(["sales", "movements", "reconcile"]);
    expect(h.states.get("2026-09-28")?.status).toBe("SUCCEEDED");
  });
  it("idempotente: segunda ejecución del mismo día no vuelve a llamar", async () => {
    const h = harness(now); await runScheduledPipeline(binding, h.deps); h.calls.length = 0;
    expect((await runScheduledPipeline(binding, h.deps)).outcome).toBe("ALREADY_DONE"); expect(h.calls).toEqual([]);
  });
  it("lock activo de otro dueño: no solapa", async () => {
    const h = harness(now); h.setLock({ owner: "other", expires: Date.parse(now) + 60_000 });
    expect((await runScheduledPipeline(binding, h.deps)).outcome).toBe("LOCK_BUSY"); expect(h.calls).toEqual([]);
  });
  it("lock caducado: se recupera", async () => {
    const h = harness(now); h.setLock({ owner: "other", expires: Date.parse(now) - 1 });
    expect((await runScheduledPipeline(binding, h.deps)).outcome).toBe("SUCCEEDED");
  });
  it("ventas no frescas: no concilia (sin falsos HISTORY_MISSING)", async () => {
    const h = harness(now, { sales: async (d) => ({ status: 206, body: { dryRun: false, state: "SOURCE_INCOMPLETE", overlap: { businessDay: d, complete: false } } }) });
    const out = await runScheduledPipeline(binding, h.deps); expect(out.outcome).toBe("FAILED"); expect(h.calls).not.toContain("reconcile");
  });
  it("solape de otro día no cuenta como fresco", async () => {
    const h = harness(now, { movements: async () => ok("2026-09-27") });
    expect((await runScheduledPipeline(binding, h.deps)).errorCode).toBe("MOVEMENTS_INGEST_NOT_FRESH"); expect(h.calls).not.toContain("reconcile");
  });
  it("mismo error dos veces seguidas -> BLOCKED y deja de reintentar", async () => {
    const bad = { sales: async () => ({ status: 502, body: { code: "HTTP_502" } }) };
    const h = harness(now, bad);
    expect((await runScheduledPipeline(binding, h.deps)).outcome).toBe("FAILED");
    expect((await runScheduledPipeline(binding, h.deps)).outcome).toBe("BLOCKED");
    h.clock.t += 86_400_000; h.calls.length = 0;
    expect((await runScheduledPipeline(binding, h.deps)).outcome).toBe("BLOCKED"); expect(h.calls).toEqual([]);
  });
  it("errores distintos no bloquean", async () => {
    let n = 0; const h = harness(now, { sales: async () => ({ status: 502, body: { code: n++ ? "B" : "A" } }) });
    await runScheduledPipeline(binding, h.deps); expect((await runScheduledPipeline(binding, h.deps)).outcome).toBe("FAILED");
  });
  it("conciliación 206 persiste como SOURCE_INCOMPLETE", async () => {
    const h = harness(now, { reconcile: async () => ({ status: 206, body: { dryRun: false, runId: "r2" } }) });
    expect((await runScheduledPipeline(binding, h.deps)).outcome).toBe("SOURCE_INCOMPLETE");
  });
  it("siempre libera el lock", async () => {
    const h = harness(now, { sales: async () => { throw Object.assign(new Error("x"), { code: "BOOM" }); } });
    await runScheduledPipeline(binding, h.deps); h.setLock(null);
    expect(await h.deps.claim()).toBe(true);
  });
});
