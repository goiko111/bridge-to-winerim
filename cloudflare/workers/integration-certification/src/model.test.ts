import { describe, expect, it } from "vitest";

import {
  certifyIntegration,
  parseMonitoringPolicy,
  serviceWindowState,
  type IntegrationEvidence,
} from "./model";

const NOW = "2026-08-09T18:00:00.000Z";

function evidence(overrides: Partial<IntegrationEvidence> = {}): IntegrationEvidence {
  return {
    observedAt: NOW,
    enabled: true,
    catalogSyncEnabled: true,
    activeScopeCount: 1,
    activeCredentialCount: 2,
    breakerPausedUntil: null,
    latestJobs: [
      { job: "catalog.fetch-winerim", outcome: "SUCCESS", observedAt: "2026-08-09T17:55:10.000Z" },
      { job: "catalog.sync-master", outcome: "SUCCESS", observedAt: "2026-08-09T17:56:10.000Z" },
      { job: "sales.auto-sync", outcome: "SUCCESS", observedAt: "2026-08-09T17:55:40.000Z" },
    ],
    recentConnectivityFailures: 0,
    expectedCatalogProducts: 10,
    confirmedCatalogProducts: 10,
    missingCatalogProducts: 0,
    priceDivergences: 0,
    masterFetchedAt: "2026-08-09T17:56:10.000Z",
    recentSalesEvents: 3,
    recentWineLines: 2,
    recentUnmappedWineLines: 0,
    recentStockFailures: 0,
    duplicateStockApplications: 0,
    stockCoverageSince: "2026-08-09T17:55:00.000Z",
    stockRequiredClaims: 1,
    stockCertifiedClaims: 1,
    salesOnlyClaims: 1,
    missingStockCertifications: 0,
    unknownStockPolicyClaims: 0,
    stockShortfallClaims: 0,
    liveQueueTasks: 0,
    failedQueueTasksRecent: 0,
    cursorLagDays: 0,
    previousState: "CATCHUP_PENDING",
    previousHealthyCycleStreak: 1,
    ...overrides,
  };
}

const restaurantHours = parseMonitoringPolicy({
  timezone: "Europe/Madrid",
  weeklySchedule: {
    sun: [{ start: "11:00", end: "01:30" }],
    mon: [{ start: "11:00", end: "01:30" }],
  },
  offlineGraceMinutes: 30,
});

describe("integration certification model", () => {
  it("requires two complete healthy cycles before ONLINE_OK", () => {
    expect(certifyIntegration(evidence({ previousHealthyCycleStreak: 0 })).state).toBe("CATCHUP_PENDING");
    expect(certifyIntegration(evidence()).state).toBe("ONLINE_OK");
  });

  it("classifies a TPV shutdown outside configured hours as expected", () => {
    const observedAt = "2026-08-10T03:00:00.000Z";
    const result = certifyIntegration(evidence({
      observedAt,
      latestJobs: [
        { job: "catalog.fetch-winerim", outcome: "SUCCESS", observedAt },
        { job: "catalog.sync-master", outcome: "RETRY", observedAt, errorClass: "HTTP_530" },
        { job: "sales.auto-sync", outcome: "RETRY", observedAt, errorClass: "HTTP_530" },
      ],
      recentConnectivityFailures: 8,
      masterFetchedAt: observedAt,
    }), restaurantHours);
    expect(result.state).toBe("OFFLINE_EXPECTED");
    expect(result.reasons).toContain("OUTSIDE_CONFIGURED_SERVICE_HOURS");
  });

  it("keeps catalog or queue deltas visible while a TPV is off", () => {
    const observedAt = "2026-08-10T03:00:00.000Z";
    const result = certifyIntegration(evidence({
      observedAt,
      latestJobs: [
        { job: "catalog.fetch-winerim", outcome: "SUCCESS", observedAt },
        { job: "catalog.sync-master", outcome: "RETRY", observedAt, errorClass: "HTTP_530" },
        { job: "sales.auto-sync", outcome: "RETRY", observedAt, errorClass: "HTTP_530" },
      ],
      recentConnectivityFailures: 8,
      missingCatalogProducts: 1,
      confirmedCatalogProducts: 9,
      liveQueueTasks: 1,
    }), restaurantHours);
    expect(result.state).toBe("CATCHUP_PENDING");
    expect(result.reasons).toEqual(expect.arrayContaining([
      "CATALOG_PRODUCTS_MISSING",
      "LIVE_QUEUE_DEBT",
      "PENDING_CHANGES_DURING_OFFLINE",
    ]));
  });

  it("escalates repeated connectivity failures during service", () => {
    const failed = evidence({
      latestJobs: [
        { job: "catalog.fetch-winerim", outcome: "SUCCESS", observedAt: NOW },
        { job: "catalog.sync-master", outcome: "RETRY", observedAt: NOW },
        { job: "sales.auto-sync", outcome: "RETRY", observedAt: NOW },
      ],
      recentConnectivityFailures: 4,
      masterFetchedAt: NOW,
    });
    expect(certifyIntegration(failed, restaurantHours).state).toBe("P0");
  });

  it("never hides stock or writer integrity failures outside service hours", () => {
    const observedAt = "2026-08-10T03:00:00.000Z";
    expect(certifyIntegration(evidence({
      observedAt,
      activeScopeCount: 2,
      recentStockFailures: 1,
      latestJobs: [],
    }), restaurantHours).state).toBe("P0");
  });

  it("fails closed when a completed stock-enabled sale lacks its stock receipt", () => {
    const result = certifyIntegration(evidence({
      stockRequiredClaims: 1,
      stockCertifiedClaims: 0,
      missingStockCertifications: 1,
    }));
    expect(result.state).toBe("P0");
    expect(result.reasons).toContain("STOCK_APPLICATION_MISSING");
  });

  it("accepts history-only sales when the Winerim stock variant is disabled", () => {
    const result = certifyIntegration(evidence({
      stockRequiredClaims: 0,
      stockCertifiedClaims: 0,
      salesOnlyClaims: 3,
    }));
    expect(result.checklist.stockOk).toBe(true);
  });

  it("raises P0 when a stock-enabled sale started below the sold quantity", () => {
    const result = certifyIntegration(evidence({ stockShortfallClaims: 1 }));
    expect(result.state).toBe("P0");
    expect(result.reasons).toContain("STOCK_SHORTFALL_OBSERVED");
  });

  it("keeps catalog divergence and live debt degraded after connectivity returns", () => {
    const result = certifyIntegration(evidence({
      missingCatalogProducts: 1,
      confirmedCatalogProducts: 9,
      priceDivergences: 1,
      liveQueueTasks: 1,
    }));
    expect(result.state).toBe("DEGRADED");
    expect(result.reasons).toEqual(expect.arrayContaining([
      "CATALOG_PRODUCTS_MISSING",
      "CATALOG_PRICE_DIVERGENCE",
      "LIVE_QUEUE_DEBT",
    ]));
  });

  it("accepts a fresh catalog apply/readback when the legacy master cache is stale", () => {
    const result = certifyIntegration(evidence({
      masterFetchedAt: "2026-08-01T00:00:00.000Z",
    }));
    expect(result.checklist.catalogOk).toBe(true);
    expect(result.reasons).not.toContain("AGORA_MASTER_STALE");
  });

  it("treats an unconfigured schedule as 24x7 instead of silencing outages", () => {
    expect(serviceWindowState(NOW, parseMonitoringPolicy({}))).toBe("UNCONFIGURED");
    const result = certifyIntegration(evidence({ latestJobs: [], recentConnectivityFailures: 4 }));
    expect(result.state).toBe("P0");
  });

  it("supports overnight service windows and their closing grace", () => {
    expect(serviceWindowState("2026-08-09T23:45:00.000Z", restaurantHours)).toBe("ACTIVE");
    expect(serviceWindowState("2026-08-10T03:00:00.000Z", restaurantHours)).toBe("INACTIVE");
  });
});
