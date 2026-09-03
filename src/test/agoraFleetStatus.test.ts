import { describe, expect, it } from "vitest";
import { evaluateAgoraFleetConnection, type AgoraFleetMetrics } from "@/lib/agoraFleetStatus";

const now = new Date("2026-06-29T12:00:00.000Z").getTime();

function metrics(overrides: Partial<AgoraFleetMetrics> = {}): AgoraFleetMetrics {
  return {
    enabled: true,
    writeMode: "XML_IMPORT",
    lastSyncAt: "2026-06-29T10:00:00.000Z",
    lastBusinessDaySynced: "2026-06-28",
    circuitBreakerPausedUntil: null,
    consecutiveFailures: 0,
    verifiedProducts: 100,
    legacyWineVisibleProducts: 0,
    mappedSales7d: 12,
    salesLines7d: 120,
    stockSuccess7d: 12,
    stockFailedOpen: 0,
    outboundOpen: 0,
    outboundFailed: 0,
    activeLeases: 0,
    ...overrides,
  };
}

describe("Agora fleet status", () => {
  it("marks disabled connections separately", () => {
    expect(evaluateAgoraFleetConnection(metrics({ enabled: false }), now).signal).toBe("disabled");
  });

  it("fails stale connections", () => {
    expect(evaluateAgoraFleetConnection(metrics({ lastSyncAt: "2026-06-27T10:00:00.000Z" }), now).signal).toBe("fail");
  });

  it("fails connections with open breaker before stale checks", () => {
    const verdict = evaluateAgoraFleetConnection(metrics({
      circuitBreakerPausedUntil: "2026-06-29T12:30:00.000Z",
      lastSyncAt: "2026-06-27T10:00:00.000Z",
    }), now);

    expect(verdict.signal).toBe("fail");
    expect(verdict.label).toBe("Breaker abierto");
  });

  it("fails open stock errors before catalog warnings", () => {
    const verdict = evaluateAgoraFleetConnection(metrics({ stockFailedOpen: 2, outboundFailed: 4 }), now);

    expect(verdict.signal).toBe("fail");
    expect(verdict.label).toBe("Stock con fallos");
  });

  it("warns when recent sales do not map to Winerim", () => {
    const verdict = evaluateAgoraFleetConnection(metrics({ mappedSales7d: 0, salesLines7d: 20 }), now);

    expect(verdict.signal).toBe("warn");
    expect(verdict.label).toBe("Ventas sin mapping");
  });

  it("warns about visible legacy wine when sales are not mapped", () => {
    const verdict = evaluateAgoraFleetConnection(metrics({
      legacyWineVisibleProducts: 8,
      mappedSales7d: 0,
      salesLines7d: 20,
    }), now);

    expect(verdict.signal).toBe("warn");
    expect(verdict.label).toBe("Legacy vendible");
  });

  it("passes healthy operational metrics", () => {
    expect(evaluateAgoraFleetConnection(metrics(), now).signal).toBe("ok");
  });
});
