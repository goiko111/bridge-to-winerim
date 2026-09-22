import { describe, expect, it } from "vitest";
import {
  AGORA_STABLE_SALES_ORDER_SCOPE_FROM_DAY,
  buildAgoraWinerimSalesOrderScope,
  isStableAgoraSalesOrderScopeEnabled,
} from "../../supabase/functions/_shared/agoraWinerimOrderScope.ts";

const CIENVINOS = "21ee3345-1090-4e83-94f2-43126d6e7695";
const OTHER = "c9b23830-a00b-4786-a50b-43fe526c4d3c";
const DAY = "2026-09-25";

describe("agora winerim order scope", () => {
  it("keeps the same scope when an open ticket grows (canary + day >= cutoff)", () => {
    const keys = ["evt-1", "line-1"];
    const first = buildAgoraWinerimSalesOrderScope({ connectionId: CIENVINOS, day: DAY, keys, qty: 1 });
    const grown = buildAgoraWinerimSalesOrderScope({ connectionId: CIENVINOS, day: DAY, keys, qty: 3 });
    expect(grown).toBe(first);
    expect(first).not.toContain("|1");
  });

  it("is order independent on the identity keys", () => {
    const a = buildAgoraWinerimSalesOrderScope({ connectionId: CIENVINOS, day: DAY, keys: ["b", "a"], qty: 2 });
    const b = buildAgoraWinerimSalesOrderScope({ connectionId: CIENVINOS, day: DAY, keys: ["a", "b"], qty: 5 });
    expect(a).toBe(b);
  });

  it("keeps the legacy quantity-bearing scope outside the canary", () => {
    const keys = ["evt-1", "line-1"];
    const one = buildAgoraWinerimSalesOrderScope({ connectionId: OTHER, day: DAY, keys, qty: 1 });
    const two = buildAgoraWinerimSalesOrderScope({ connectionId: OTHER, day: DAY, keys, qty: 2 });
    expect(one).not.toBe(two);
    expect(two.endsWith("|2")).toBe(true);
  });

  it("never changes the scope of days before the cutoff (no historical re-send)", () => {
    const keys = ["evt-1", "line-1"];
    const closedDay = "2026-09-20";
    expect(isStableAgoraSalesOrderScopeEnabled({ connectionId: CIENVINOS, day: closedDay })).toBe(false);
    expect(
      buildAgoraWinerimSalesOrderScope({ connectionId: CIENVINOS, day: closedDay, keys, qty: 2 }),
    ).toBe([...keys].sort().join("|") + "|2");
  });

  it("enables the stable scope exactly from the cutoff day", () => {
    expect(
      isStableAgoraSalesOrderScopeEnabled({
        connectionId: CIENVINOS,
        day: AGORA_STABLE_SALES_ORDER_SCOPE_FROM_DAY,
      }),
    ).toBe(true);
  });

  it("preserves the prefix of the inactive-stock scope", () => {
    const scope = buildAgoraWinerimSalesOrderScope({
      connectionId: CIENVINOS,
      day: DAY,
      keys: ["g1"],
      qty: 4,
      prefix: "stock_inactive",
    });
    expect(scope).toBe("stock_inactive|g1");
  });

  it("rejects malformed days (fails closed to legacy)", () => {
    expect(isStableAgoraSalesOrderScopeEnabled({ connectionId: CIENVINOS, day: "" })).toBe(false);
    expect(isStableAgoraSalesOrderScopeEnabled({ connectionId: CIENVINOS, day: "hoy" })).toBe(false);
  });
});
