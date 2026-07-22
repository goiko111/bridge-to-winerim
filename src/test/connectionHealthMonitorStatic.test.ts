import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "supabase/functions/connection-health-monitor/index.ts"),
  "utf8",
);
const sourceFile = ts.createSourceFile(
  "connection-health-monitor.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

function extractConst(name: string): string {
  const statement = sourceFile.statements.find((node) =>
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.some((declaration) =>
      ts.isIdentifier(declaration.name) && declaration.name.text === name
    )
  );
  if (!statement) throw new Error(`Missing const ${name}`);
  return statement.getText(sourceFile);
}

function extractFunction(name: string): string {
  const declaration = sourceFile.statements.find((node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === name
  );
  if (!declaration) throw new Error(`Missing function ${name}`);
  return declaration.getText(sourceFile);
}

function compileMonitorHelper<T>(declarations: string[], returnExpression: string): T {
  const transpiled = ts.transpileModule(declarations.join("\n\n"), {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return new Function(`${transpiled}\nreturn ${returnExpression};`)() as T;
}

describe("connection health alert correlation", () => {
  it("does not emit a breaker alert alongside the primary connectivity outage", () => {
    expect(source).toContain('if (isPaused && probe.status !== "DOWN")');
    expect(source).toContain("breakerOpen: Boolean(isPaused)");
    expect(source).toContain("consecutiveFailures: connection.consecutive_failures || 0");
  });

  it("does not alert on expected catalog eligibility blocks", () => {
    expect(source).toContain("EXPECTED_CATALOG_BLOCK_REASONS");
    expect(source).toContain("EXPECTED_CATALOG_VALIDATION_REASONS");
    expect(source).toContain('"READINESS_ROLLBACK"');
    expect(source).toContain('"wine_inactive"');
    expect(source).toContain('"missing_bottle_sale_price"');
    expect(source).toContain('"missing_glass_sale_price"');
    expect(source).toContain('"missing_magnum_sale_price"');
    expect(source).toContain("!isExpectedCatalogBlockReason(task.blocked_reason)");
    expect(source).toContain("loadRecentBlockedTasks");
    expect(source).toContain(".range(from, from + pageSize - 1)");
    expect(source).toContain("blockedLookupError: blockedRecent.error");
  });

  it("only suppresses compound catalog blocks when every reason is expected", () => {
    const isExpectedCatalogBlockReason = compileMonitorHelper<
      (reason: string | null | undefined) => boolean
    >([
      extractConst("EXPECTED_CATALOG_BLOCK_REASONS"),
      extractConst("EXPECTED_CATALOG_VALIDATION_REASONS"),
      extractFunction("isExpectedCatalogBlockReason"),
    ], "isExpectedCatalogBlockReason");

    expect(isExpectedCatalogBlockReason("READINESS_ROLLBACK")).toBe(true);
    expect(isExpectedCatalogBlockReason("Validation failed: wine_inactive")).toBe(true);
    expect(isExpectedCatalogBlockReason(
      "Validation failed: wine_inactive, missing_bottle_sale_price; missing_glass_sale_price",
    )).toBe(true);

    expect(isExpectedCatalogBlockReason(
      "Validation failed: wine_inactive, unknown_catalog_failure",
    )).toBe(false);
    expect(isExpectedCatalogBlockReason("Validation failed: no products generated")).toBe(false);
    expect(isExpectedCatalogBlockReason("Write capability not confirmed")).toBe(false);
    expect(isExpectedCatalogBlockReason(null)).toBe(false);
    expect(isExpectedCatalogBlockReason(undefined)).toBe(false);
    expect(isExpectedCatalogBlockReason("   ")).toBe(false);
  });

  it("flags provisional open-ticket stock writes as a sales-integrity risk", () => {
    expect(source).toContain('key: "open_ticket_stock_write_risk"');
    expect(source).toContain('type: "sales_integrity"');
    expect(source).toContain("open_tickets_sync_enabled === true");
    expect(source).toContain("open_tickets_stock_sync_enabled === true");
  });

  it("requires the cron secret for every state-changing monitor run", () => {
    expect(source).toContain("if (!dryRun && !cronAuthorized)");
    expect(source).toContain("Any monitor run that writes checks or alerts requires");
  });

  it("treats sync frequency as configuration and checks execution timestamps separately", () => {
    expect(source).not.toContain('key: "sync_frequency_sla"');
    expect(source).toContain('key: "sync_frequency_configuration"');
    expect(source).toContain("syncFrequencyMinutes > 5");
    expect(source).toContain("configurationOnly: true");
    expect(source).toContain('key: "sync_execution_stale"');
    expect(source).toContain('type: "sync_stale"');
    expect(source).toContain('envNumber("MONITOR_SYNC_STALE_AFTER_MINUTES", 20)');
    expect(source).toContain('source: "pos_connections.last_sync_at"');
    expect(source).toContain('source: "provider_config.last_intraday_sales_sync.at"');
    expect(source).toContain('source: "provider_config.last_open_tickets_sync.at"');
    expect(source).toContain('key: "catalog_automation_incomplete"');
    expect(source).toContain('connection.write_mode === "XML_IMPORT"');
    expect(source).toContain("connection.auto_push_verified_ready !== true");
  });

  it("detects real operational staleness while allowing a new-connection grace period", () => {
    const evaluateOperationalSyncStaleness = compileMonitorHelper<
      (connection: Record<string, unknown>, nowMs: number, staleAfterMinutes: number) => {
        at: string | null;
        source: string | null;
        ageMinutes: number | null;
        stale: boolean;
        neverObserved: boolean;
      }
    >([
      extractFunction("parseTimestampMs"),
      extractFunction("latestOperationalSyncEvidence"),
      extractFunction("minutesSinceTimestamp"),
      extractFunction("evaluateOperationalSyncStaleness"),
    ], "evaluateOperationalSyncStaleness");

    const nowMs = Date.parse("2026-07-22T12:00:00.000Z");
    const recent = evaluateOperationalSyncStaleness({
      last_sync_at: "2026-07-22T11:50:00.000Z",
      created_at: "2026-07-01T00:00:00.000Z",
    }, nowMs, 20);
    expect(recent).toMatchObject({
      stale: false,
      neverObserved: false,
      ageMinutes: 10,
      source: "pos_connections.last_sync_at",
    });

    const freshestSignalWins = evaluateOperationalSyncStaleness({
      last_sync_at: "2026-07-22T11:00:00.000Z",
      provider_config: {
        last_intraday_sales_sync: { at: "2026-07-22T11:55:00.000Z" },
        last_open_tickets_sync: { at: "2026-07-22T11:58:00.000Z" },
      },
    }, nowMs, 20);
    expect(freshestSignalWins).toMatchObject({
      stale: false,
      ageMinutes: 2,
      source: "provider_config.last_open_tickets_sync.at",
    });

    expect(evaluateOperationalSyncStaleness({
      last_sync_at: "2026-07-22T11:00:00.000Z",
    }, nowMs, 20)).toMatchObject({ stale: true, neverObserved: false, ageMinutes: 60 });

    expect(evaluateOperationalSyncStaleness({
      created_at: "2026-07-22T11:50:00.000Z",
    }, nowMs, 20)).toMatchObject({ stale: false, neverObserved: true, ageMinutes: 10 });

    expect(evaluateOperationalSyncStaleness({
      created_at: "2026-07-22T11:00:00.000Z",
    }, nowMs, 20)).toMatchObject({ stale: true, neverObserved: true, ageMinutes: 60 });

    expect(evaluateOperationalSyncStaleness({}, nowMs, 20)).toMatchObject({
      stale: true,
      neverObserved: true,
      ageMinutes: null,
    });
  });
});
