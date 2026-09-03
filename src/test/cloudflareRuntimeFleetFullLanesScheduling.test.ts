import { describe, expect, it } from "vitest";

import {
  buildFleetScheduledRuntimeMessages,
  type ActiveFleetScheduledScope,
} from "../../cloudflare/workers/middleware-runtime/src/fleet";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const SCHEDULED_TIME = Date.parse("2026-08-05T20:00:00.000Z");

function activeScope(overrides: Partial<ActiveFleetScheduledScope> = {}): ActiveFleetScheduledScope {
  return {
    connectionId: CONNECTION_ID,
    runId: "run-fleet-a",
    credentialSetSha256: "a".repeat(64),
    generationMode: "bootstrap",
    deploymentManifestSha256: "b".repeat(64),
    writerFenceGrantSha256: "c".repeat(64),
    enabled: true,
    breakerPausedUntil: null,
    intradaySalesSyncEnabled: true,
    openTicketsSyncEnabled: false,
    ...overrides,
  };
}

describe("fleet full-lanes scheduler", () => {
  it("enqueues catalog refresh before sync once the fleet refresh port is connected", async () => {
    const catalog = await buildFleetScheduledRuntimeMessages({
      cron: "*/5 * * * *",
      scheduledTimeMs: SCHEDULED_TIME,
      lane: "catalog",
      scopes: [activeScope()],
    });
    const outbound = await buildFleetScheduledRuntimeMessages({
      cron: "*/5 * * * *",
      scheduledTimeMs: SCHEDULED_TIME,
      lane: "outbound-queue",
      scopes: [activeScope()],
    });

    expect(catalog.map(({ envelope }) => envelope.job)).toEqual([
      "catalog.fetch-winerim",
      "catalog.sync-master",
    ]);
    expect(outbound.map(({ envelope }) => envelope.job)).toEqual(["outbound.process"]);
  });

  it("keeps one-minute reconciliation ordered and inside its minute", async () => {
    const messages = await buildFleetScheduledRuntimeMessages({
      cron: "* * * * *",
      scheduledTimeMs: SCHEDULED_TIME,
      lane: "catalog",
      scopes: [activeScope()],
      allowOneMinuteReconciliation: true,
    });

    expect(messages.map(({ envelope }) => envelope.job)).toEqual([
      "catalog.fetch-winerim",
      "catalog.sync-master",
    ]);
    expect(messages[0].delaySeconds).toBeLessThan(messages[1].delaySeconds);
    expect(messages.every(({ delaySeconds }) => delaySeconds >= 0 && delaySeconds < 60)).toBe(true);
  });
});
