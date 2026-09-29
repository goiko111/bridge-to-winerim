import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const edge = readFileSync("supabase/functions/read-reconciliation-results/index.ts", "utf8");
const ui = readFileSync("src/features/daily-reconciliation/DailyReconciliationDashboard.tsx", "utf8");

describe("daily reconciliation fleet labels", () => {
  it("returns every enabled Agora connection and overlays an optional binding", () => {
    expect(edge).toContain('db.from("pos_connections").select("id,location_name,provider,enabled").eq("provider", "agora").eq("enabled", true)');
    expect(edge).toContain('status: binding?.status ?? "UNBOUND"');
    expect(edge).toContain("restaurantName: connection.location_name");
    expect(edge).toContain("connections: connections.pages");
  });

  it("shows names plus ERP and keeps unbound restaurants explicitly inert", () => {
    expect(ui).toContain("Conciliación disponible");
    expect(ui).toContain("Pendientes de binding");
    expect(ui).toContain("pendiente de binding");
    expect(ui).toContain('enabled: Boolean(connectionId && selected?.status === "ACTIVE")');
    expect(ui).not.toContain('bindings.filter((row) => row.status === "ACTIVE").map');
  });
});
