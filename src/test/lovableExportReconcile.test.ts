import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertSourceGate,
  assertTableInventory,
  assertTargetGate,
  buildAtomicRestoreSql,
  buildPgDumpArgs,
  buildSafePlan,
  canonicalJson,
  decideResumeAction,
  expectedTargetTables,
  loadTransferConfig,
  manifestDigest,
  quoteIdentifier,
  redactError,
  signManifest,
  targetReplaceTables,
  validateTransferConfig,
  verifyManifest,
} from "../../infrastructure/postgres/data-transfer/toolkit.mjs";

const root = process.cwd();
const configPath = resolve(root, "infrastructure/postgres/data-transfer/config.json");

describe("Lovable export/reconcile staging toolkit", () => {
  it("has an explicit 25-table source allowlist and preserves the three staging-owned tables", async () => {
    const config = await loadTransferConfig(configPath);
    expect(config.sourceTables).toHaveLength(25);
    expect(config.stagingOnlyTables).toEqual([
      "infrastructure_metadata",
      "runtime_execution_log",
      "runtime_idempotency",
    ]);
    expect(expectedTargetTables(config)).toHaveLength(28);
    expect(targetReplaceTables(config)).not.toContain("infrastructure_metadata");
    expect(targetReplaceTables(config)).toContain("runtime_idempotency");
  });

  it("rejects duplicate, unsafe and cross-owned table configuration", async () => {
    const config = await loadTransferConfig(configPath);
    expect(() => validateTransferConfig({ ...config, sourceTables: [...config.sourceTables, config.sourceTables[0]] })).toThrow(/duplicates/);
    expect(() => validateTransferConfig({ ...config, sourceTables: ["pos_connections; drop table x"] })).toThrow(/unsafe/);
    expect(() => validateTransferConfig({ ...config, runtimeMustRemainEmpty: ["pos_connections"] })).toThrow(/staging-only subset/);
  });

  it("quotes only constrained SQL identifiers", () => {
    expect(quoteIdentifier("sales_events")).toBe('"sales_events"');
    expect(() => quoteIdentifier("sales-events")).toThrow(/Unsafe SQL identifier/);
  });

  it("builds a consistent data-only dump plan with a table flag for every allowlisted table", async () => {
    const config = await loadTransferConfig(configPath);
    const args = buildPgDumpArgs({
      outputDir: "/private/tmp/export/dump",
      schema: config.schema,
      tables: config.sourceTables,
      snapshotId: "000003A1-0000001B-1",
    });
    // PostgreSQL snapshot IDs use decimal xid:xid:xip form, so malformed values fail closed.
    expect(() => buildPgDumpArgs({ outputDir: "/tmp/x", schema: "public", tables: [], snapshotId: "bad" })).toThrow();
    expect(args.filter((arg) => arg.startsWith("--table="))).toHaveLength(25);
    expect(args).toContain("--data-only");
    expect(args).toContain("--no-owner");
    expect(args).not.toContain(expect.stringContaining("postgres://"));
  });

  it("wraps replacement in one transaction without CASCADE and preserves the staging sentinel", async () => {
    const config = await loadTransferConfig(configPath);
    const sql = buildAtomicRestoreSql({
      schema: config.schema,
      replaceTables: targetReplaceTables(config),
      restoreSqlPath: "/private/tmp/restore-data.sql",
    });
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("session_replication_role = replica");
    expect(sql).toContain('"public"."pos_connections"');
    expect(sql).toContain('"public"."runtime_idempotency"');
    expect(sql).not.toContain("infrastructure_metadata");
    expect(sql).not.toContain("CASCADE");
    expect(sql).toContain("COMMIT;");
  });

  it("requires exact target inventory but permits extra source-owned platform tables", async () => {
    const config = await loadTransferConfig(configPath);
    expect(assertTableInventory(expectedTargetTables(config), expectedTargetTables(config))).toEqual({ missing: [], unexpected: [] });
    expect(() => assertTableInventory(["pos_connections"], expectedTargetTables(config))).toThrow(/missing=/);
    expect(assertTableInventory([...config.sourceTables, "platform_internal"], config.sourceTables, { exact: false })).toEqual({ missing: [], unexpected: [] });
  });

  it("signs deterministic manifests and detects edits", async () => {
    const config = await loadTransferConfig(configPath);
    const base = {
      schemaVersion: 1,
      schemaSha256: "a".repeat(64),
      archiveSha256: "b".repeat(64),
      tables: config.sourceTables.map((table) => ({ table, rowCount: 0, sha256: "c".repeat(64) })),
    };
    const signed = signManifest(base);
    expect(signed.manifestSha256).toBe(manifestDigest(signed));
    expect(verifyManifest(signed, config.sourceTables)).toBe(signed);
    expect(() => verifyManifest({ ...signed, archiveSha256: "d".repeat(64) }, config.sourceTables)).toThrow(/signature/);
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("makes the resume state machine explicit", () => {
    expect(decideResumeAction(null, false)).toBe("CREATE_TARGET_SNAPSHOT");
    expect(decideResumeAction({ phase: "TARGET_SNAPSHOT_READY" }, false)).toBe("APPLY_IMPORT");
    expect(decideResumeAction({ phase: "IMPORT_APPLIED" }, true)).toBe("MARK_RECONCILED");
    expect(decideResumeAction({ phase: "IMPORT_APPLIED" }, false)).toBe("ROLLBACK_REQUIRED");
    expect(decideResumeAction({ phase: "RECONCILED" }, true)).toBe("NOOP_ALREADY_COMPLETE");
  });

  it("requires independent source/target identities and the exact staging project confirmation", async () => {
    const config = await loadTransferConfig(configPath);
    expect(assertSourceGate("postgres://reader@source.internal/lovable", "lovable-production", config).hostname).toBe("source.internal");
    expect(() => assertSourceGate("postgres://reader@source.internal/lovable", "staging", config)).toThrow(/Source confirmation/);
    const target = `postgres://postgres.${config.targetProjectRef}@pooler.supabase.com/postgres`;
    expect(assertTargetGate(target, config.targetProjectRef, config).hostname).toBe("pooler.supabase.com");
    expect(() => assertTargetGate(target, "wrong", config)).toThrow(/Target project confirmation/);
    expect(() => assertTargetGate("postgres://u@localhost/source", "local-test", config, "postgres://u@localhost/source", { localTest: true })).toThrow(/must differ/);
  });

  it("redacts database URLs from failures", () => {
    const output = redactError("failed postgres://user:password@example.test/db now");
    expect(output).not.toContain("password");
    expect(output).toContain("[REDACTED_DATABASE_URL]");
  });

  it("keeps the CLI dry-run by default and URLs out of source", async () => {
    const cli = await readFile(resolve(root, "scripts/lovable-export-reconcile.mjs"), "utf8");
    expect(cli).toContain('if (!options.apply)');
    expect(cli).toContain('process.env[name]');
    expect(cli).toContain('options.resume');
    expect(cli).toContain('sourceSchemaSha256');
    expect(cli).not.toMatch(/--(?:source|target)-(?:url|dsn)/);
    const config = await loadTransferConfig(configPath);
    expect(buildSafePlan(config).mode).toBe("dry-run");
  });

  it("never places database URLs in generated pg_dump arguments", async () => {
    const config = await loadTransferConfig(configPath);
    const command = buildPgDumpArgs({
      outputDir: "/tmp/dump",
      schema: config.schema,
      tables: config.sourceTables,
      snapshotId: "000003A1-0000001B-1",
    }).join(" ");
    expect(command).not.toContain("password");
    expect(command).not.toContain("postgres://");
    expect(command).not.toContain("postgresql://");
  });
});
