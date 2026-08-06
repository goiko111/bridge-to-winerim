import { describe, expect, it } from "vitest";
import {
  DEFAULT_URGENT_POLICY,
  evaluateUrgentAlert,
  isDashboardOnlyAlertType,
  shouldNotifyRecovery,
} from "../../supabase/functions/_shared/connectionHealthAlertPolicy";

const NOW = Date.parse("2026-08-06T08:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe("connection health alert urgency policy", () => {
  it("suppresses email for dashboard-only alert types even when critical and repeated", () => {
    for (const type of ["sales_stale", "stock_sync", "outbound_queue", "circuit_breaker", "api_error"]) {
      const decision = evaluateUrgentAlert(
        { alert_type: type, severity: "critical", occurrences: 25, first_seen_at: minutesAgo(5000) },
        NOW,
      );
      expect(isDashboardOnlyAlertType(type)).toBe(true);
      expect(decision.urgent).toBe(false);
      expect(decision.reason).toBe("dashboard_only_type");
    }
  });

  it("does not email auth on the first check but does on the second", () => {
    const first = evaluateUrgentAlert(
      { alert_type: "auth", severity: "critical", occurrences: 1, first_seen_at: minutesAgo(1) },
      NOW,
    );
    expect(first).toMatchObject({ urgent: false, reason: "below_occurrence_threshold" });

    const second = evaluateUrgentAlert(
      { alert_type: "auth", severity: "critical", occurrences: 2, first_seen_at: minutesAgo(6) },
      NOW,
    );
    expect(second.urgent).toBe(true);
  });

  it("does not email recent connectivity outages but does email prolonged ones", () => {
    expect(evaluateUrgentAlert(
      { alert_type: "connectivity", severity: "critical", occurrences: 3, first_seen_at: minutesAgo(30) },
      NOW,
    )).toMatchObject({ urgent: false, reason: "below_minutes_threshold" });

    expect(evaluateUrgentAlert(
      { alert_type: "connectivity", severity: "critical", occurrences: 2, first_seen_at: minutesAgo(600) },
      NOW,
    )).toMatchObject({ urgent: false, reason: "below_occurrence_threshold" });

    expect(evaluateUrgentAlert(
      { alert_type: "connectivity", severity: "critical", occurrences: 3, first_seen_at: minutesAgo(240) },
      NOW,
    ).urgent).toBe(true);
  });

  it("requires critical severity and honours configurable thresholds", () => {
    expect(evaluateUrgentAlert(
      { alert_type: "auth", severity: "warning", occurrences: 9, first_seen_at: minutesAgo(999) },
      NOW,
    )).toMatchObject({ urgent: false, reason: "not_critical" });

    expect(DEFAULT_URGENT_POLICY).toEqual({
      authAfterOccurrences: 2,
      connectivityAfterOccurrences: 3,
      connectivityAfterMinutes: 240,
    });

    expect(evaluateUrgentAlert(
      { alert_type: "connectivity", severity: "critical", occurrences: 1, first_seen_at: minutesAgo(10) },
      NOW,
      { authAfterOccurrences: 1, connectivityAfterOccurrences: 1, connectivityAfterMinutes: 5 },
    ).urgent).toBe(true);
  });

  it("only emails recovery when the incident previously emailed", () => {
    expect(shouldNotifyRecovery({})).toBe(false);
    expect(shouldNotifyRecovery({ internal_notified_at: minutesAgo(60) })).toBe(true);
    expect(shouldNotifyRecovery({ client_notified_at: minutesAgo(60) })).toBe(true);
    expect(shouldNotifyRecovery({ internal_notified_at: minutesAgo(60), recovery_notified_at: minutesAgo(1) })).toBe(false);
  });
});
