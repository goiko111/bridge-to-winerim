export const CERTIFICATION_STATES = [
  "ONLINE_OK",
  "OFFLINE_EXPECTED",
  "CATCHUP_PENDING",
  "DEGRADED",
  "P0",
] as const;

export type IntegrationCertificationState = typeof CERTIFICATION_STATES[number];
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type ServiceWindow = Readonly<{
  start: string;
  end: string;
}>;

export type MonitoringPolicy = Readonly<{
  timezone: string;
  weeklySchedule: Partial<Record<Weekday, readonly ServiceWindow[]>> | null;
  offlineGraceMinutes: number;
  p0AfterMinutes: number;
  healthyCyclesRequired: number;
  maxCycleAgeMinutes: number;
}>;

export type RuntimeJobEvidence = Readonly<{
  job: string;
  outcome: string;
  observedAt: string;
  errorClass?: string | null;
}>;

export type IntegrationEvidence = Readonly<{
  observedAt: string;
  enabled: boolean;
  catalogSyncEnabled: boolean;
  activeScopeCount: number;
  activeCredentialCount: number;
  breakerPausedUntil?: string | null;
  latestJobs: readonly RuntimeJobEvidence[];
  recentConnectivityFailures: number;
  expectedCatalogProducts: number;
  confirmedCatalogProducts: number;
  missingCatalogProducts: number;
  priceDivergences: number;
  masterFetchedAt?: string | null;
  recentSalesEvents: number;
  recentWineLines: number;
  recentUnmappedWineLines: number;
  recentStockFailures: number;
  duplicateStockApplications: number;
  stockCoverageSince?: string | null;
  stockRequiredClaims: number;
  stockCertifiedClaims: number;
  salesOnlyClaims: number;
  missingStockCertifications: number;
  unknownStockPolicyClaims: number;
  stockShortfallClaims: number;
  liveQueueTasks: number;
  failedQueueTasksRecent: number;
  cursorLagDays?: number | null;
  previousState?: IntegrationCertificationState | null;
  previousHealthyCycleStreak?: number;
}>;

export type CertificationChecklist = Readonly<{
  writerOk: boolean;
  connectivityOk: boolean;
  catalogOk: boolean;
  salesOk: boolean;
  stockOk: boolean;
  queueOk: boolean;
  cursorOk: boolean;
}>;

export type CertificationResult = Readonly<{
  state: IntegrationCertificationState;
  serviceWindowState: "ACTIVE" | "INACTIVE" | "UNCONFIGURED";
  healthyCycleStreak: number;
  checklist: CertificationChecklist;
  reasons: readonly string[];
}>;

const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const REQUIRED_JOBS = Object.freeze([
  "catalog.fetch-winerim",
  "catalog.sync-master",
  "sales.auto-sync",
] as const);

export const DEFAULT_MONITORING_POLICY: MonitoringPolicy = Object.freeze({
  timezone: "Europe/Madrid",
  weeklySchedule: null,
  offlineGraceMinutes: 30,
  p0AfterMinutes: 20,
  healthyCyclesRequired: 2,
  maxCycleAgeMinutes: 12,
});

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function validTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function parseMonitoringPolicy(value: unknown): MonitoringPolicy {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawSchedule = input.weeklySchedule;
  let weeklySchedule: Partial<Record<Weekday, readonly ServiceWindow[]>> | null = null;
  if (rawSchedule && typeof rawSchedule === "object" && !Array.isArray(rawSchedule)) {
    const parsed: Partial<Record<Weekday, readonly ServiceWindow[]>> = {};
    for (const weekday of WEEKDAYS) {
      const windows = (rawSchedule as Record<string, unknown>)[weekday];
      if (!Array.isArray(windows)) continue;
      parsed[weekday] = Object.freeze(windows.flatMap((window) => {
        if (!window || typeof window !== "object" || Array.isArray(window)) return [];
        const candidate = window as Record<string, unknown>;
        return validTime(candidate.start) && validTime(candidate.end)
          ? [Object.freeze({ start: candidate.start, end: candidate.end })]
          : [];
      }));
    }
    weeklySchedule = Object.freeze(parsed);
  }

  return Object.freeze({
    timezone: validTimezone(input.timezone) ? input.timezone : DEFAULT_MONITORING_POLICY.timezone,
    weeklySchedule,
    offlineGraceMinutes: boundedInteger(input.offlineGraceMinutes, 30, 0, 180),
    p0AfterMinutes: boundedInteger(input.p0AfterMinutes, 20, 10, 240),
    healthyCyclesRequired: boundedInteger(input.healthyCyclesRequired, 2, 2, 6),
    maxCycleAgeMinutes: boundedInteger(input.maxCycleAgeMinutes, 12, 5, 30),
  });
}

function localClock(now: Date, timezone: string): { weekday: Weekday; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = value("weekday").slice(0, 3).toLowerCase() as Weekday;
  const hour = Number(value("hour"));
  const minute = Number(value("minute"));
  return {
    weekday: WEEKDAYS.includes(weekday) ? weekday : "mon",
    minutes: hour * 60 + minute,
  };
}

function timeMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function previousWeekday(weekday: Weekday): Weekday {
  const index = WEEKDAYS.indexOf(weekday);
  return WEEKDAYS[(index + WEEKDAYS.length - 1) % WEEKDAYS.length];
}

export function serviceWindowState(
  observedAt: string,
  policy: MonitoringPolicy,
): CertificationResult["serviceWindowState"] {
  if (policy.weeklySchedule === null) return "UNCONFIGURED";
  const now = new Date(observedAt);
  if (!Number.isFinite(now.getTime())) return "ACTIVE";
  const clock = localClock(now, policy.timezone);
  const today = policy.weeklySchedule[clock.weekday] ?? [];
  const previous = policy.weeklySchedule[previousWeekday(clock.weekday)] ?? [];

  const activeToday = today.some((window) => {
    const start = timeMinutes(window.start);
    const end = timeMinutes(window.end);
    if (start === end) return true;
    if (end > start) return clock.minutes >= start && clock.minutes < end + policy.offlineGraceMinutes;
    return clock.minutes >= start;
  });
  const activeFromPreviousDay = previous.some((window) => {
    const start = timeMinutes(window.start);
    const end = timeMinutes(window.end);
    return end <= start && start !== end && clock.minutes < end + policy.offlineGraceMinutes;
  });
  return activeToday || activeFromPreviousDay ? "ACTIVE" : "INACTIVE";
}

function ageMinutes(observedAt: string, timestamp: string | null | undefined): number {
  const observed = Date.parse(observedAt);
  const value = Date.parse(timestamp ?? "");
  if (!Number.isFinite(observed) || !Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (observed - value) / 60_000);
}

function successfulJob(job: RuntimeJobEvidence | undefined, evidence: IntegrationEvidence, maximumAge: number): boolean {
  return !!job
    && ["SUCCESS", "DUPLICATE"].includes(job.outcome)
    && ageMinutes(evidence.observedAt, job.observedAt) <= maximumAge;
}

function uniqueReasons(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

export function certifyIntegration(
  evidence: IntegrationEvidence,
  policy: MonitoringPolicy = DEFAULT_MONITORING_POLICY,
): CertificationResult {
  const latest = new Map(evidence.latestJobs.map((job) => [job.job, job]));
  const writerOk = evidence.enabled
    && evidence.activeScopeCount === 1
    && evidence.activeCredentialCount === 2;
  const breakerActive = !!evidence.breakerPausedUntil
    && Date.parse(evidence.breakerPausedUntil) > Date.parse(evidence.observedAt);
  const jobsOk = REQUIRED_JOBS.every((job) => successfulJob(latest.get(job), evidence, policy.maxCycleAgeMinutes));
  const connectivityOk = !breakerActive && jobsOk;
  const catalogCycleFresh = successfulJob(
    latest.get("catalog.sync-master"),
    evidence,
    policy.maxCycleAgeMinutes,
  );
  const masterFresh = evidence.expectedCatalogProducts === 0
    || catalogCycleFresh
    || ageMinutes(evidence.observedAt, evidence.masterFetchedAt) <= policy.maxCycleAgeMinutes;
  const catalogOk = evidence.catalogSyncEnabled
    && masterFresh
    && evidence.missingCatalogProducts === 0
    && evidence.priceDivergences === 0
    && evidence.confirmedCatalogProducts >= evidence.expectedCatalogProducts;
  const salesOk = evidence.recentUnmappedWineLines === 0;
  const stockOk = evidence.recentStockFailures === 0
    && evidence.duplicateStockApplications === 0
    && evidence.missingStockCertifications === 0
    && evidence.unknownStockPolicyClaims === 0
    && evidence.stockShortfallClaims === 0
    && evidence.stockCertifiedClaims >= evidence.stockRequiredClaims;
  const queueOk = evidence.liveQueueTasks === 0 && evidence.failedQueueTasksRecent === 0;
  const cursorOk = evidence.cursorLagDays === null
    || evidence.cursorLagDays === undefined
    || evidence.cursorLagDays <= 1;
  const checklist = Object.freeze({
    writerOk,
    connectivityOk,
    catalogOk,
    salesOk,
    stockOk,
    queueOk,
    cursorOk,
  });
  const windowState = serviceWindowState(evidence.observedAt, policy);
  const reasons: string[] = [];
  if (!writerOk) reasons.push("WRITER_SCOPE_OR_CREDENTIALS_INVALID");
  if (breakerActive) reasons.push("BREAKER_ACTIVE");
  if (!jobsOk) reasons.push("RUNTIME_CYCLE_NOT_HEALTHY");
  if (!catalogOk) {
    if (!evidence.catalogSyncEnabled) reasons.push("CATALOG_SYNC_DISABLED");
    if (!masterFresh) reasons.push("AGORA_MASTER_STALE");
    if (evidence.missingCatalogProducts > 0) reasons.push("CATALOG_PRODUCTS_MISSING");
    if (evidence.priceDivergences > 0) reasons.push("CATALOG_PRICE_DIVERGENCE");
  }
  if (!salesOk) reasons.push("UNMAPPED_WINE_SALES");
  if (evidence.recentStockFailures > 0) reasons.push("STOCK_APPLICATION_FAILED");
  if (evidence.duplicateStockApplications > 0) reasons.push("STOCK_DOUBLE_APPLICATION_RISK");
  if (evidence.missingStockCertifications > 0) reasons.push("STOCK_APPLICATION_MISSING");
  if (evidence.unknownStockPolicyClaims > 0) reasons.push("STOCK_POLICY_UNKNOWN");
  if (evidence.stockShortfallClaims > 0) reasons.push("STOCK_SHORTFALL_OBSERVED");
  if (!queueOk) reasons.push("LIVE_QUEUE_DEBT");
  if (!cursorOk) reasons.push("SALES_CURSOR_LAG");

  const dataCritical = !writerOk
    || !stockOk
    || evidence.recentUnmappedWineLines > 0
    || (evidence.cursorLagDays ?? 0) > 2;
  const pendingWhileOffline = evidence.missingCatalogProducts > 0
    || evidence.priceDivergences > 0
    || evidence.liveQueueTasks > 0
    || evidence.failedQueueTasksRecent > 0;
  if (!connectivityOk && windowState === "INACTIVE" && !dataCritical) {
    if (pendingWhileOffline) {
      return Object.freeze({
        state: "CATCHUP_PENDING",
        serviceWindowState: windowState,
        healthyCycleStreak: 0,
        checklist,
        reasons: uniqueReasons([
          ...reasons,
          "OUTSIDE_CONFIGURED_SERVICE_HOURS",
          "PENDING_CHANGES_DURING_OFFLINE",
        ]),
      });
    }
    return Object.freeze({
      state: "OFFLINE_EXPECTED",
      serviceWindowState: windowState,
      healthyCycleStreak: 0,
      checklist,
      reasons: uniqueReasons([...reasons, "OUTSIDE_CONFIGURED_SERVICE_HOURS"]),
    });
  }

  if (dataCritical) {
    return Object.freeze({
      state: "P0",
      serviceWindowState: windowState,
      healthyCycleStreak: 0,
      checklist,
      reasons: uniqueReasons(reasons),
    });
  }

  if (!connectivityOk) {
    const state: IntegrationCertificationState = evidence.recentConnectivityFailures >= Math.ceil(policy.p0AfterMinutes / 5)
      ? "P0"
      : "DEGRADED";
    return Object.freeze({
      state,
      serviceWindowState: windowState,
      healthyCycleStreak: 0,
      checklist,
      reasons: uniqueReasons(reasons),
    });
  }

  const cycleHealthy = Object.values(checklist).every(Boolean);
  if (!cycleHealthy) {
    return Object.freeze({
      state: "DEGRADED",
      serviceWindowState: windowState,
      healthyCycleStreak: 0,
      checklist,
      reasons: uniqueReasons(reasons),
    });
  }

  const previousStreak = Math.max(0, evidence.previousHealthyCycleStreak ?? 0);
  const healthyCycleStreak = Math.min(policy.healthyCyclesRequired, previousStreak + 1);
  return Object.freeze({
    state: healthyCycleStreak >= policy.healthyCyclesRequired ? "ONLINE_OK" : "CATCHUP_PENDING",
    serviceWindowState: windowState,
    healthyCycleStreak,
    checklist,
    reasons: healthyCycleStreak >= policy.healthyCyclesRequired
      ? Object.freeze([])
      : Object.freeze(["AWAITING_SECOND_HEALTHY_CYCLE"]),
  });
}
