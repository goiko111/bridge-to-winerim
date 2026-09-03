import { describe, expect, it, vi } from "vitest";

import { loadAgoraFleetReadModel } from "../../cloudflare/workers/middleware-api/src/agoraFleetReadModel";
import type { DatabaseAdapter, QueryResult } from "../../cloudflare/workers/middleware-api/src/db";

describe("Agora fleet API read model", () => {
  it("renders from one bounded snapshot query", async () => {
    const query = vi.fn(async <Row extends Record<string, unknown>>(statement: { text: string; values: readonly unknown[] }) => ({
      rows: [{
        payload: {
          connection: {
            id: "11111111-1111-4111-8111-111111111111",
            location_name: "Uno",
            enabled: true,
            write_mode: "NONE",
            last_sync_at: "2026-09-03T04:25:00.000Z",
            last_business_day_synced: "2026-09-02",
            catalog_sync_enabled: true,
            circuit_breaker_paused_until: null,
            circuit_breaker_reason: null,
            consecutive_failures: 0,
          },
          metrics: {
            enabled: true,
            writeMode: "NONE",
            lastSyncAt: "2026-09-03T04:25:00.000Z",
            lastBusinessDaySynced: "2026-09-02",
            circuitBreakerPausedUntil: null,
            consecutiveFailures: 0,
            verifiedProducts: 2,
            legacyWineVisibleProducts: 0,
            mappedSales7d: 3,
            salesLines7d: 3,
            stockSuccess7d: 3,
            stockFailedOpen: 0,
            outboundOpen: 0,
            outboundFailed: 0,
            activeLeases: 0,
          },
          latestError: null,
        },
        observed_at: "2026-09-03T04:30:00.000Z",
      }],
      rowCount: 1,
    } as unknown as QueryResult<Row>));
    const adapter = { query } as unknown as DatabaseAdapter;

    const output = await loadAgoraFleetReadModel(adapter, 30);

    expect(output.rows).toHaveLength(1);
    expect(output.observedAt).toBe("2026-09-03T04:30:00.000Z");
    expect(query).toHaveBeenCalledTimes(1);
    const statement = query.mock.calls[0][0];
    expect(statement.text).toContain("FROM public.agora_fleet_read_model");
    expect(statement.values).toEqual([30]);
    expect(statement.text).not.toContain("outbound_tasks");
    expect(statement.text).not.toContain("sales_line_items");
  });

  it("fails closed when a persisted snapshot does not match the read-model contract", async () => {
    const adapter = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          payload: {
            connection: { id: "11111111-1111-4111-8111-111111111111" },
            metrics: { activeLeases: 0 },
            latestError: null,
          },
          observed_at: "2026-09-03T04:30:00.000Z",
        }],
        rowCount: 1,
      }),
    } as unknown as DatabaseAdapter;

    await expect(loadAgoraFleetReadModel(adapter, 30)).rejects.toThrow("FLEET_READ_MODEL_CORRUPT");
  });
});
