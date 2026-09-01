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

const JOB_BASE_DELAY_SECONDS: Record<ScheduledRuntimeJob, number> = {
  "outbound.process": 0,
  "sales.auto-sync": 20,
  "sales.sync-intraday": 25,
  "sales.sync-open-tickets": 30,
  "catalog.fetch-winerim": 45,
  "catalog.sync-master": 60,
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

export function scheduledDelaySeconds(connectionId: string, job: ScheduledRuntimeJob): number {
  const jitter = stableNumber(`${connectionId}:${job}`) % 10;
  return JOB_BASE_DELAY_SECONDS[job] + jitter;
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
      const payload: JsonValue = { scheduled: true };
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
