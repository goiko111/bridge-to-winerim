import { JsonValue, RuntimeEnvelopeV1 } from "./contracts";
import { createRuntimeEnvelope } from "./idempotency";

export const FIVE_MINUTE_CRON = "*/5 * * * *";
export const SCHEDULE_SLOT_MS = 5 * 60 * 1000;

export type ScheduledRuntimeJob =
  | "catalog.fetch-winerim"
  | "catalog.sync-master"
  | "sales.auto-sync"
  | "sales.sync-intraday"
  | "sales.sync-open-tickets"
  | "outbound.process";

export const SCHEDULED_CATALOG_FORMATS = Object.freeze([
  "BOTTLE",
  "GLASS",
  "MAGNUM",
] as const);

export type RuntimeScheduledConnection = {
  connectionId: string;
  enabled: boolean;
  breakerPausedUntil?: string | null;
  intradaySalesSyncEnabled?: boolean;
  openTicketsSyncEnabled?: boolean;
};

export type RuntimeScheduledMessage = {
  envelope: RuntimeEnvelopeV1;
  delaySeconds: number;
};

export type RuntimeSchedulerPlan = {
  cron: typeof FIVE_MINUTE_CRON;
  timeZone: "UTC";
  queueBindings: Record<
    "catalog" | "salesStock" | "salesImport" | "stockSync" | "outbound" | "maintenance",
    string
  >;
  batchSize: 10;
  batchTimeoutSeconds: 5;
  perConnectionRequestsPerSecond: 2;
  requiresPersistentIdempotency: true;
  requiresDeadLetterQueue: true;
};

export const DEFAULT_RUNTIME_SCHEDULER_PLAN: RuntimeSchedulerPlan = {
  cron: FIVE_MINUTE_CRON,
  timeZone: "UTC",
  queueBindings: {
    catalog: "MIDDLEWARE_CATALOG_QUEUE",
    salesStock: "MIDDLEWARE_SALES_STOCK_QUEUE",
    salesImport: "MIDDLEWARE_SALES_IMPORT_QUEUE",
    stockSync: "MIDDLEWARE_STOCK_SYNC_QUEUE",
    outbound: "MIDDLEWARE_OUTBOUND_QUEUE",
    maintenance: "MIDDLEWARE_MAINTENANCE_QUEUE",
  },
  batchSize: 10,
  batchTimeoutSeconds: 5,
  perConnectionRequestsPerSecond: 2,
  requiresPersistentIdempotency: true,
  requiresDeadLetterQueue: true,
};

const FIVE_MINUTE_JOB_OFFSET_SECONDS: Record<ScheduledRuntimeJob, number> = {
  "outbound.process": 0,
  "sales.auto-sync": 10,
  "sales.sync-intraday": 20,
  "sales.sync-open-tickets": 30,
  "catalog.fetch-winerim": 40,
  "catalog.sync-master": 65,
};

const FIVE_MINUTE_CONNECTION_SPREAD_SECONDS = 180;
const ONE_MINUTE_CONNECTION_SPREAD_SECONDS = 15;
const ONE_MINUTE_CATALOG_OFFSET_SECONDS: Partial<Record<ScheduledRuntimeJob, number>> = {
  "catalog.fetch-winerim": 0,
  "catalog.sync-master": 20,
};

function stableNumber(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function scheduledSlotIso(scheduledTimeMs: number): string {
  return new Date(Math.floor(scheduledTimeMs / SCHEDULE_SLOT_MS) * SCHEDULE_SLOT_MS).toISOString();
}

export function runtimeJobsForConnection(connection: RuntimeScheduledConnection): ScheduledRuntimeJob[] {
  const jobs: ScheduledRuntimeJob[] = [
    "outbound.process",
    "sales.auto-sync",
    "catalog.fetch-winerim",
    "catalog.sync-master",
  ];
  if (connection.intradaySalesSyncEnabled) jobs.push("sales.sync-intraday");
  if (connection.openTicketsSyncEnabled) jobs.push("sales.sync-open-tickets");
  return jobs;
}

export function isScheduledConnectionEligible(
  connection: RuntimeScheduledConnection,
  scheduledTimeMs: number,
): boolean {
  if (!connection.enabled) return false;
  if (!connection.breakerPausedUntil) return true;
  const pausedUntil = Date.parse(connection.breakerPausedUntil);
  return Number.isFinite(pausedUntil) && pausedUntil <= scheduledTimeMs;
}

export function scheduledDelaySeconds(
  connectionId: string,
  job: ScheduledRuntimeJob,
  scheduleWindowSeconds = SCHEDULE_SLOT_MS / 1000,
): number {
  if (scheduleWindowSeconds <= 60 && job in ONE_MINUTE_CATALOG_OFFSET_SECONDS) {
    const connectionSpread = stableNumber(connectionId) % ONE_MINUTE_CONNECTION_SPREAD_SECONDS;
    return connectionSpread + (ONE_MINUTE_CATALOG_OFFSET_SECONDS[job] ?? 0);
  }

  const connectionSpread = stableNumber(connectionId) % FIVE_MINUTE_CONNECTION_SPREAD_SECONDS;
  return connectionSpread + FIVE_MINUTE_JOB_OFFSET_SECONDS[job];
}

function catalogPayload(): JsonValue {
  // The catalog planner filters inactive or price-less variants. Scheduling all
  // supported formats prevents a valid glass or magnum from being skipped.
  return { scheduled: true, formatTypes: [...SCHEDULED_CATALOG_FORMATS] };
}

export async function buildScheduledRuntimeMessages(input: {
  cron: string;
  scheduledTimeMs: number;
  connections: RuntimeScheduledConnection[];
}): Promise<RuntimeScheduledMessage[]> {
  if (input.cron !== FIVE_MINUTE_CRON) return [];

  const slot = scheduledSlotIso(input.scheduledTimeMs);
  const eligible = input.connections
    .filter((connection) => isScheduledConnectionEligible(connection, input.scheduledTimeMs))
    .sort((left, right) => left.connectionId.localeCompare(right.connectionId));

  const messages: RuntimeScheduledMessage[] = [];
  for (const connection of eligible) {
    for (const job of runtimeJobsForConnection(connection)) {
      const delaySeconds = scheduledDelaySeconds(connection.connectionId, job);
      const availableAt = new Date(input.scheduledTimeMs + delaySeconds * 1000).toISOString();
      const payload: JsonValue = job === "catalog.sync-master"
        ? catalogPayload()
        : { scheduled: true };
      const envelope = await createRuntimeEnvelope({
        connectionId: connection.connectionId,
        job,
        dedupeScope: `cron:${slot}`,
        payload,
        createdAt: new Date(input.scheduledTimeMs).toISOString(),
        availableAt,
        source: {
          kind: "cron",
          eventId: `${input.cron}:${slot}`,
          scheduledSlot: slot,
          trigger: input.cron,
        },
      });
      messages.push({ envelope, delaySeconds });
    }
  }
  return messages;
}
