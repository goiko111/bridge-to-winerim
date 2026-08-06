// ─────────────────────────────────────────────────────────────────────
// PURE ALERT NOISE POLICY (no Deno / no network / no DB)
// ─────────────────────────────────────────────────────────────────────
// Only genuinely urgent incidents may generate email (internal or client).
// Everything else stays visible in the Alerts panel/tables ONLY.
//
//  - auth (critical)        -> email after N consecutive checks (default 2)
//  - connectivity (critical)-> email after N consecutive checks (default 3)
//                              AND >= M minutes since first_seen_at (default 240)
//  - every other alert type -> dashboard-only, never email
// ─────────────────────────────────────────────────────────────────────

/** Alert types that must never trigger email, only dashboard evidence. */
export const DASHBOARD_ONLY_ALERT_TYPES = [
  "sales_stale",
  "stock_sync",
  "outbound_queue",
  "circuit_breaker",
  "api_error",
  "sync_stale",
  "sales_integrity",
  "configuration",
] as const;

/** Alert types that may escalate to email when the urgent gate is met. */
export const URGENT_ALERT_TYPES = ["auth", "connectivity"] as const;

export interface UrgentPolicyConfig {
  authAfterOccurrences: number;
  connectivityAfterOccurrences: number;
  connectivityAfterMinutes: number;
}

export const DEFAULT_URGENT_POLICY: UrgentPolicyConfig = {
  authAfterOccurrences: 2,
  connectivityAfterOccurrences: 3,
  connectivityAfterMinutes: 240,
};

export interface UrgentAlertInput {
  alert_type?: string | null;
  severity?: string | null;
  occurrences?: number | null;
  first_seen_at?: string | null;
}

export interface UrgentDecision {
  urgent: boolean;
  reason:
    | "urgent"
    | "dashboard_only_type"
    | "not_critical"
    | "below_occurrence_threshold"
    | "below_minutes_threshold";
  occurrences: number;
  minutesOpen: number | null;
}

export function isDashboardOnlyAlertType(alertType: string | null | undefined): boolean {
  if (!alertType) return true;
  return !(URGENT_ALERT_TYPES as readonly string[]).includes(alertType);
}

export function minutesSinceFirstSeen(firstSeenAt: string | null | undefined, nowMs: number): number | null {
  if (!firstSeenAt) return null;
  const ms = Date.parse(firstSeenAt);
  if (Number.isNaN(ms)) return null;
  return (nowMs - ms) / 60_000;
}

/**
 * Single gate applied to BOTH internal and client email paths.
 */
export function evaluateUrgentAlert(
  alert: UrgentAlertInput,
  nowMs: number,
  config: UrgentPolicyConfig = DEFAULT_URGENT_POLICY,
): UrgentDecision {
  const occurrences = Number(alert.occurrences ?? 0) || 0;
  const minutesOpen = minutesSinceFirstSeen(alert.first_seen_at, nowMs);
  const type = alert.alert_type ?? null;

  if (isDashboardOnlyAlertType(type)) {
    return { urgent: false, reason: "dashboard_only_type", occurrences, minutesOpen };
  }
  if (alert.severity !== "critical") {
    return { urgent: false, reason: "not_critical", occurrences, minutesOpen };
  }

  if (type === "auth") {
    if (occurrences < config.authAfterOccurrences) {
      return { urgent: false, reason: "below_occurrence_threshold", occurrences, minutesOpen };
    }
    return { urgent: true, reason: "urgent", occurrences, minutesOpen };
  }

  // connectivity
  if (occurrences < config.connectivityAfterOccurrences) {
    return { urgent: false, reason: "below_occurrence_threshold", occurrences, minutesOpen };
  }
  if (minutesOpen === null || minutesOpen < config.connectivityAfterMinutes) {
    return { urgent: false, reason: "below_minutes_threshold", occurrences, minutesOpen };
  }
  return { urgent: true, reason: "urgent", occurrences, minutesOpen };
}

/** Recovery email is only allowed when the incident actually generated an email. */
export function shouldNotifyRecovery(alert: {
  internal_notified_at?: string | null;
  client_notified_at?: string | null;
  recovery_notified_at?: string | null;
}): boolean {
  if (alert.recovery_notified_at) return false;
  return Boolean(alert.internal_notified_at || alert.client_notified_at);
}
