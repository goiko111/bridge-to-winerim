// Clinic-only AUDIT_ONLY daily scheduler logic. Pure and dependency-injected so it is testable.
import { addBusinessDays, bindingCutoffHour, bindingTimezone, businessWindow, type BindingMetadata } from "./time.ts";

export const PIPELINE_VERSION = "clinic-audit-v1";
export const SCHEDULER_LOCK_STREAM = "scheduler:daily";
export const SCHEDULER_LOCK_TTL_SECONDS = 900;
export const CLINIC_CONNECTION_ID = "1c5177f1-9459-4ee9-8b6e-4780f8b6b96b";
/** Only connections allowed to run under the scheduler identity. Ocean Club and the rest of the fleet stay out. */
export const SCHEDULER_CONNECTIONS: ReadonlySet<string> = new Set([CLINIC_CONNECTION_ID]);

const fail = (message: string, status: number, code: string) => Object.assign(new Error(message), { status, code });

export function assertSchedulerRequest(input: { connectionId: unknown; dryRun: unknown; historical: boolean; businessDay: unknown }): void {
  if (typeof input.connectionId !== "string" || !SCHEDULER_CONNECTIONS.has(input.connectionId)) throw fail("Conexión fuera del alcance del scheduler", 403, "SCHEDULER_SCOPE_DENIED");
  if (input.historical) throw fail("El scheduler no puede usar el modo histórico", 403, "SCHEDULER_HISTORICAL_FORBIDDEN");
  if (input.dryRun !== false) throw fail("El scheduler exige dryRun:false explícito", 400, "SCHEDULER_REQUIRES_EXPLICIT_DRYRUN_FALSE");
  if (typeof input.businessDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.businessDay)) throw fail("El scheduler exige un día de negocio explícito", 400, "SCHEDULER_EXPLICIT_DAY_REQUIRED");
}

/** Latest business day whose window [cutoff, next cutoff) is fully closed at `now` in the binding timezone. */
export function closedBusinessDay(binding: BindingMetadata, now: Date): string {
  const timeZone = bindingTimezone(binding); const cutoff = bindingCutoffHour(binding);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
  const localDay = `${parts.year}-${parts.month}-${parts.day}`;
  const day = addBusinessDays(localDay, Number(parts.hour) >= cutoff ? -1 : -2);
  if (Date.parse(businessWindow(binding, day).to) > now.getTime()) throw fail("El día calculado aún no está cerrado", 500, "BUSINESS_DAY_NOT_CLOSED");
  return day;
}

export type StepResult = { status: number; body: Record<string, unknown> };
export type StateRow = { business_day: string; status: string; error_code: string | null; attempts: number };
export type StatePatch = { status: string; error_code?: string | null; attempts?: number; run_id?: string | null; evidence?: Record<string, unknown>; finished_at?: string | null };
export type SchedulerDeps = {
  now(): Date;
  claim(): Promise<boolean>;
  release(): Promise<void>;
  getState(day: string): Promise<StateRow | null>;
  lastOtherState(day: string): Promise<StateRow | null>;
  putState(day: string, patch: StatePatch): Promise<void>;
  sales(day: string): Promise<StepResult>;
  movements(day: string): Promise<StepResult>;
  reconcile(day: string): Promise<StepResult>;
};
export type SchedulerOutcome = { outcome: "LOCK_BUSY" | "ALREADY_DONE" | "BLOCKED" | "SUCCEEDED" | "SOURCE_INCOMPLETE" | "FAILED"; businessDay: string; errorCode?: string | null; evidence?: Record<string, unknown> };

const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Ingestion is fresh only if it persisted (dryRun:false), completed, and covered exactly the target day. */
export function ingestFresh(step: StepResult, day: string): { fresh: boolean; code: string | null } {
  const b = step.body; const overlap = obj(b.overlap);
  if (step.status !== 200) return { fresh: false, code: typeof b.code === "string" ? b.code : `HTTP_${step.status}` };
  if (b.dryRun !== false || b.state !== "COMPLETE" || overlap.businessDay !== day || overlap.complete !== true) return { fresh: false, code: "INGEST_NOT_FRESH" };
  return { fresh: true, code: null };
}

function summarize(step: StepResult): Record<string, unknown> {
  const b = step.body; const metrics = obj(b.metrics);
  return { http: step.status, state: b.state ?? null, code: b.code ?? null, dryRun: b.dryRun ?? null, pagesRead: b.pagesRead ?? null, records: b.records ?? null, deletions: b.deletions ?? null, movements: b.movements ?? null, overlap: b.overlap ?? null, calls: b.calls ?? null, runId: b.runId ?? null, completeness: b.completeness ?? null, states: metrics.states ?? null };
}

export async function runScheduledPipeline(binding: BindingMetadata, deps: SchedulerDeps): Promise<SchedulerOutcome> {
  const day = closedBusinessDay(binding, deps.now());
  if (!(await deps.claim())) return { outcome: "LOCK_BUSY", businessDay: day };
  try {
    const existing = await deps.getState(day);
    if (existing?.status === "SUCCEEDED" || existing?.status === "SOURCE_INCOMPLETE") return { outcome: "ALREADY_DONE", businessDay: day };
    if (existing?.status === "BLOCKED") return { outcome: "BLOCKED", businessDay: day, errorCode: existing.error_code };
    const previous = await deps.lastOtherState(day);
    if (previous?.status === "BLOCKED") return { outcome: "BLOCKED", businessDay: day, errorCode: previous.error_code };
    const attempts = (existing?.attempts ?? 0) + 1;
    await deps.putState(day, { status: "RUNNING", attempts, error_code: null, finished_at: null });
    const evidence: Record<string, unknown> = {};
    const failWith = async (code: string): Promise<SchedulerOutcome> => {
      const prior = existing?.status === "FAILED" ? existing : previous?.status === "FAILED" ? previous : null;
      const status = prior?.error_code === code ? "BLOCKED" : "FAILED";
      await deps.putState(day, { status, error_code: code, attempts, evidence, finished_at: deps.now().toISOString() });
      return { outcome: status as "BLOCKED" | "FAILED", businessDay: day, errorCode: code, evidence };
    };
    try {
      const sales = await deps.sales(day); evidence.sales = summarize(sales);
      const s = ingestFresh(sales, day); if (!s.fresh) return await failWith(`SALES_${s.code}`);
      const movements = await deps.movements(day); evidence.movements = summarize(movements);
      const m = ingestFresh(movements, day); if (!m.fresh) return await failWith(`MOVEMENTS_${m.code}`);
      const rec = await deps.reconcile(day); evidence.reconcile = summarize(rec);
      if ((rec.status !== 200 && rec.status !== 206) || rec.body.dryRun !== false || typeof rec.body.runId !== "string") return await failWith(`RECONCILE_${typeof rec.body.code === "string" ? rec.body.code : `HTTP_${rec.status}`}`);
      const status = rec.status === 200 ? "SUCCEEDED" : "SOURCE_INCOMPLETE";
      await deps.putState(day, { status, error_code: status === "SUCCEEDED" ? null : "RECONCILE_SOURCE_INCOMPLETE", attempts, run_id: rec.body.runId, evidence, finished_at: deps.now().toISOString() });
      return { outcome: status, businessDay: day, evidence };
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "PIPELINE_EXCEPTION";
      return await failWith(code);
    }
  } finally { await deps.release(); }
}
