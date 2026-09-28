import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function files(root: string): string[] {
  return readdirSync(root).flatMap((name) => { const path = join(root, name); return statSync(path).isDirectory() ? files(path) : [path]; });
}

const functionRoot = resolve(process.cwd(), "supabase/functions");
// Scope: only Reconciliation v3 sources (restored from base 961116a). Pre-existing operational code
// (agora-proxy, winerim-proxy, winerimCertifiedSalesImport) is intentionally out of scope.
const RECON_SCOPE = /(reconciliation-v2|winerim-fleet-reader|sync-sales-records|sync-stock-movements|refresh-current-stock|run-daily-reconciliation|read-reconciliation-results|verify-external-resolution|winerimFleetClient|winerimFleetEvidence|candidate_probe)/;
const sources = files(functionRoot).filter((path) => /\.(ts|sql)$/.test(path) && RECON_SCOPE.test(path)).map((path) => [path, readFileSync(path, "utf8")] as const);

describe("runtime guardrails", () => {
  it("integrates the dashboard into the real application route and navigation", () => {
    const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
    const layout = readFileSync(resolve(process.cwd(), "src/components/Layout.tsx"), "utf8");
    expect(app).toContain('path="/audit/reconciliation"');
    expect(app).toContain("DailyReconciliationDashboard");
    expect(layout).toContain('to: "/audit/reconciliation"');
  });

  it("keeps the persisted stable-id exclusion immutable in fleet discovery", () => {
    const source = readFileSync(join(functionRoot, "winerim-fleet-reader/index.ts"), "utf8");
    expect(source).toContain("reconciliation_v2_connection_exclusions");
    expect(source).toContain("CONNECTION_PERSISTED_EXCLUDED");
    expect(source).not.toContain("Ocean Club");
  });

  it("keeps the pre-binding probe fixed, bounded, audited and read-only", () => {
    const source = readFileSync(join(functionRoot, "winerim-fleet-reader/index.ts"), "utf8");
    const client = readFileSync(join(functionRoot, "_shared/reconciliation-v2/winerimFleetClient.ts"), "utf8");
    const probe = readFileSync(join(functionRoot, "_shared/reconciliation-v2/candidateProbe.ts"), "utf8");
    const migration = readdirSync(resolve(process.cwd(), "supabase/migrations")).map((n) => readFileSync(resolve(process.cwd(), "supabase/migrations", n), "utf8")).find((s) => s.includes("reconciliation_v2_begin_candidate_probe")) ?? "";
    expect(probe).toContain("VERIFY_CANDIDATE_SALES");
    expect(source).toContain("reconciliation_v2_begin_candidate_probe");
    expect(source).toContain("reconciliation_v2_candidate_probe_audit");
    expect(source).toContain("MAX_PAGES");
    expect(client).toContain('sales: "/sales/records"');
    expect(source).not.toMatch(/method\s*:\s*["'](?:PUT|PATCH|DELETE)["']/);
    expect(migration).toContain("candidate probe rate limited");
    expect(migration).toContain("revoke all on public.reconciliation_v2_candidate_probe_audit from public, anon, authenticated");
  });

  it("contains no Winerim write endpoint or repair executor", () => {
    const joined = sources.map(([, source]) => source).join("\n");
    expect(joined).not.toMatch(/\/api\/v2\/sales\/import/); expect(joined).not.toMatch(/method:\s*["'](?:PUT|PATCH|DELETE)["']/);
    expect(joined).not.toMatch(/agora_reversal_queue/); expect(joined).not.toMatch(/AUTO_REPAIR_SAFE/);
  });

  it("defaults every mutating evidence function to dry-run and marks bounded incompleteness", () => {
    for (const name of ["winerim-fleet-reader","sync-sales-records","sync-stock-movements","refresh-current-stock","run-daily-reconciliation","verify-external-resolution"]) {
      const source = readFileSync(join(functionRoot, name, "index.ts"), "utf8");
      expect(source, name).toContain("asDryRun(body.dryRun)");
    }
    expect(readFileSync(join(functionRoot, "sync-sales-records/index.ts"), "utf8")).toContain('"SOURCE_INCOMPLETE"');
    expect(readFileSync(join(functionRoot, "sync-stock-movements/index.ts"), "utf8")).toContain('"SOURCE_INCOMPLETE"');
  });

  it("does not embed production-looking secrets", () => {
    const joined = sources.map(([, source]) => source).join("\n");
    expect(joined).not.toMatch(/wfk_[A-Za-z0-9_-]{20,}/); expect(joined).not.toMatch(/eyJ[A-Za-z0-9_-]{80,}/);
  });

  it("keeps tenant authorization in the read edge and never exposes raw tables to the browser", () => {
    const source = readFileSync(join(functionRoot, "read-reconciliation-results/index.ts"), "utf8");
    expect(source).toContain('auth.rpc("can_access_connection"');
    expect(source).toContain("serverClient()");
    expect(source).toContain('code: "CONNECTION_FORBIDDEN"');
    expect(source).toContain('code: "EXPORT_INCOMPLETE"');
  });
});
