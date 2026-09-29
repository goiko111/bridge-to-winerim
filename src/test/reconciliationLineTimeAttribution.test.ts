import { describe, expect, it } from "vitest";
import { attributeByProviderLine, lineTimeAttributionMode, normalizeLocalTimestamp } from "../../supabase/functions/_shared/reconciliation-v2/lineTimeAttribution";

const w = { businessDay: "2026-09-27", localFrom: "2026-09-27T06:00:00", localTo: "2026-09-28T06:00:00" };
const l = (at: string | null, headerDay = "2026-09-26", qty = 1) => ({ id: `${at}-${qty}`, quantity: qty, provider_sold_at: at, sales_event: { business_day: headerDay, provider_doc_id: "T1" } });

describe("PROVIDER_LINE attribution", () => {
  it("only activates with explicit config", () => {
    expect(lineTimeAttributionMode({ line_time_attribution: "PROVIDER_LINE" })).toBe("PROVIDER_LINE");
    expect(lineTimeAttributionMode({})).toBe("EVENT_DAY");
    expect(lineTimeAttributionMode(null)).toBe("EVENT_DAY");
  });
  it("2+3+1 units on one ticket spanning the cutoff are split by per-line time", () => {
    const r = attributeByProviderLine([l("2026-09-27 05:59:59", "2026-09-26", 2), l("2026-09-27 21:10:00", "2026-09-26", 3), l("2026-09-28 06:00:00", "2026-09-26", 1)], w);
    expect(r.complete).toBe(true);
    expect(r.lines.map((x) => x.quantity)).toEqual([3]);
    expect(r.lines[0].sales_event.business_day).toBe("2026-09-27");
    expect(r.outsideWindow).toBe(2);
    const next = attributeByProviderLine([l("2026-09-28 06:00:00", "2026-09-26", 1)], { businessDay: "2026-09-28", localFrom: "2026-09-28T06:00:00", localTo: "2026-09-29T06:00:00" });
    expect(next.lines.map((x) => x.quantity)).toEqual([1]);
  });
  it("missing or invalid timestamp fails closed, no header fallback", () => {
    for (const bad of [null, "", "2026-09-31 10:00:00", "27/09/2026 10:00", "2026-09-27 25:00:00"]) {
      const r = attributeByProviderLine([l(bad, "2026-09-27")], w);
      expect(r.complete).toBe(false); expect(r.invalidTimestamp).toBe(1); expect(r.lines).toHaveLength(0);
    }
    expect(normalizeLocalTimestamp("2026-09-27T12:53:45")).toBe("2026-09-27T12:53:45");
  });
});
