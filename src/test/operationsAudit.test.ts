import { describe, expect, it } from "vitest";
import {
  causalLatencySeconds,
  connectionEvidenceState,
  isWineEligible,
} from "@/lib/operationsAudit";

describe("operations audit evidence", () => {
  it("does not turn missing timestamps into a healthy connection", () => {
    expect(connectionEvidenceState({
      enabled: true,
      last_sync_at: null,
      sync_frequency_minutes: 60,
      consecutive_failures: 0,
      circuit_breaker_paused_until: null,
    })).toBe("unavailable");
  });

  it("marks old evidence as stale", () => {
    expect(connectionEvidenceState({
      enabled: true,
      last_sync_at: "2026-09-22T08:00:00Z",
      sync_frequency_minutes: 30,
      consecutive_failures: 0,
      circuit_breaker_paused_until: null,
    }, new Date("2026-09-22T12:00:00Z").getTime())).toBe("stale");
  });

  it("rejects food and water from wine mapping", () => {
    expect(isWineEligible({ family: "AGUAS", name: "Agua con gas", isWineCandidate: true }).eligible).toBe(false);
    expect(isWineEligible({ family: "TINTOS WINERIM", name: "Mencía", isWineCandidate: true }).eligible).toBe(true);
  });

  it("only calculates a complete causal sequence", () => {
    expect(causalLatencySeconds({
      detectedAt: "2026-09-22T10:00:00Z",
      queuedAt: "2026-09-22T10:01:00Z",
      appliedAt: "2026-09-22T10:02:00Z",
      verifiedAt: "2026-09-22T10:03:00Z",
    })).toBe(180);
    expect(causalLatencySeconds({
      detectedAt: "2026-09-22T10:00:00Z",
      queuedAt: "2026-09-22T09:59:00Z",
      appliedAt: "2026-09-22T10:02:00Z",
      verifiedAt: "2026-09-22T10:03:00Z",
    })).toBeNull();
  });
});
