import { describe, expect, it } from "vitest";
import {
  buildScheduledRuntimeMessages,
  DEFAULT_RUNTIME_SCHEDULER_PLAN,
  FIVE_MINUTE_CRON,
  scheduledSlotIso,
} from "../../cloudflare/workers/middleware-runtime/src";

describe("Cloudflare runtime scheduler plan", () => {
  const scheduledTimeMs = Date.parse("2026-08-02T10:02:31.000Z");

  it("uses a deterministic five-minute UTC slot", () => {
    expect(scheduledSlotIso(scheduledTimeMs)).toBe("2026-08-02T10:00:00.000Z");
    expect(DEFAULT_RUNTIME_SCHEDULER_PLAN).toMatchObject({
      cron: "*/5 * * * *",
      timeZone: "UTC",
      batchSize: 10,
      perConnectionRequestsPerSecond: 2,
      requiresPersistentIdempotency: true,
      requiresDeadLetterQueue: true,
    });
    expect(DEFAULT_RUNTIME_SCHEDULER_PLAN.queueBindings).toMatchObject({
      catalog: "MIDDLEWARE_CATALOG_QUEUE",
      salesImport: "MIDDLEWARE_SALES_IMPORT_QUEUE",
      stockSync: "MIDDLEWARE_STOCK_SYNC_QUEUE",
      maintenance: "MIDDLEWARE_MAINTENANCE_QUEUE",
    });
  });

  it("fans out only eligible connections and includes configured optional jobs", async () => {
    const messages = await buildScheduledRuntimeMessages({
      cron: FIVE_MINUTE_CRON,
      scheduledTimeMs,
      connections: [
        {
          connectionId: "enabled",
          enabled: true,
          intradaySalesSyncEnabled: true,
          openTicketsSyncEnabled: true,
        },
        { connectionId: "disabled", enabled: false },
        {
          connectionId: "paused",
          enabled: true,
          breakerPausedUntil: "2026-08-02T11:00:00.000Z",
        },
        {
          connectionId: "invalid-breaker",
          enabled: true,
          breakerPausedUntil: "not-a-date",
        },
      ],
    });

    expect(messages).toHaveLength(6);
    expect(new Set(messages.map(({ envelope }) => envelope.connectionId))).toEqual(new Set(["enabled"]));
    expect(messages.map(({ envelope }) => envelope.job).sort()).toEqual([
      "catalog.fetch-winerim",
      "catalog.sync-master",
      "outbound.process",
      "sales.auto-sync",
      "sales.sync-intraday",
      "sales.sync-open-tickets",
    ]);
    expect(messages.every(({ delaySeconds }) => delaySeconds >= 0 && delaySeconds < 70)).toBe(true);
  });

  it("deduplicates repeated delivery of the same cron slot and changes the next slot", async () => {
    const input = {
      cron: FIVE_MINUTE_CRON,
      scheduledTimeMs,
      connections: [{ connectionId: "connection-a", enabled: true }],
    };
    const first = await buildScheduledRuntimeMessages(input);
    const repeated = await buildScheduledRuntimeMessages(input);
    const next = await buildScheduledRuntimeMessages({ ...input, scheduledTimeMs: scheduledTimeMs + 5 * 60 * 1000 });

    expect(first.map(({ envelope }) => envelope.idempotencyKey))
      .toEqual(repeated.map(({ envelope }) => envelope.idempotencyKey));
    expect(first[0].envelope.idempotencyKey).not.toBe(next[0].envelope.idempotencyKey);
  });

  it("ignores unconfigured cron expressions", async () => {
    expect(await buildScheduledRuntimeMessages({
      cron: "0 * * * *",
      scheduledTimeMs,
      connections: [{ connectionId: "connection-a", enabled: true }],
    })).toEqual([]);
  });
});
