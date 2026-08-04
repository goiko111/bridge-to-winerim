import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertSourceGate,
  assertRollbackReconciled,
  assertTableInventory,
  assertTargetGate,
  buildAtomicRestoreSql,
  buildPgDumpArgs,
  buildProjectedSelectSql,
  buildSafePlan,
  canonicalJson,
  decideResumeAction,
  expectedTargetTables,
  loadTransferConfig,
  manifestDigest,
  preimageEvidenceFromManifest,
  quoteIdentifier,
  requiredEmptyTargetTables,
  requiredSourceTables,
  readState,
  redactError,
  checksumManifest,
  tableTransferPolicy,
  targetReplaceTables,
  transferPolicyDigest,
  resolveSourceTables,
  validateTransferConfig,
  verifyManifest,
  writeState,
} from "../../infrastructure/postgres/data-transfer/toolkit.mjs";

const root = process.cwd();
const configPath = resolve(root, "infrastructure/postgres/data-transfer/config.json");

describe("Lovable export/reconcile staging toolkit", () => {
  it("has a 24-table allowlist with a fail-closed 20-table Lovable legacy inventory", async () => {
    const config = await loadTransferConfig(configPath);
    expect(config.sourceTables).toHaveLength(24);
    expect(config.optionalSourceTables).toEqual([
      "integration_onboarding_requests",
      "middleware_incident_email_attempts",
      "middleware_incident_events",
      "middleware_incidents",
    ]);
    expect(requiredSourceTables(config)).toHaveLength(20);
    expect(config.sourceTables).not.toContain("provider_credentials");
    expect(config.stagingOnlyTables).toEqual([
      "infrastructure_metadata",
      "provider_credentials",
      "runtime_canary_connections",
      "runtime_catalog_source_scope",
      "runtime_connection_credentials",
      "runtime_execution_log",
      "runtime_idempotency",
    ]);
    expect(expectedTargetTables(config)).toHaveLength(31);
    expect(config.runtimeMustRemainEmpty).toEqual([
      "provider_credentials",
      "runtime_canary_connections",
      "runtime_catalog_source_scope",
      "runtime_connection_credentials",
      "runtime_execution_log",
      "runtime_idempotency",
    ]);
    expect(targetReplaceTables(config)).not.toContain("infrastructure_metadata");
    expect(targetReplaceTables(config)).toContain("runtime_idempotency");
    expect(targetReplaceTables(config)).toContain("provider_credentials");
    expect(targetReplaceTables(config)).toEqual(expect.arrayContaining(config.optionalSourceTables));
    expect(tableTransferPolicy(config, "provider_credentials").mode).toBe("empty");
  });

  it("accepts only the four versioned source omissions and requires their target rows empty", async () => {
    const config = await loadTransferConfig(configPath);
    const legacyTables = requiredSourceTables(config);
    expect(resolveSourceTables(config, [...legacyTables, "platform_internal"])).toEqual(legacyTables);
    expect(requiredEmptyTargetTables(config, legacyTables)).toEqual([
      ...config.runtimeMustRemainEmpty,
      ...config.optionalSourceTables,
    ].sort());
    expect(() => resolveSourceTables(
      config,
      legacyTables.filter((table) => table !== "agora_dispatch_locks"),
    )).toThrow(/missing=agora_dispatch_locks/);
    expect(() => resolveSourceTables(
      config,
      [...legacyTables, "platform_internal"],
      { rejectUnexpected: true },
    )).toThrow(/unexpected=platform_internal/);
  });

  it("rejects duplicate, unsafe and cross-owned table configuration", async () => {
    const config = await loadTransferConfig(configPath);
    expect(() => validateTransferConfig({ ...config, sourceTables: [...config.sourceTables, config.sourceTables[0]] })).toThrow(/duplicates/);
    expect(() => validateTransferConfig({ ...config, sourceTables: ["pos_connections; drop table x"] })).toThrow(/unsafe/);
    expect(() => validateTransferConfig({ ...config, optionalSourceTables: ["provider_credentials"] })).toThrow(/Optional source/);
    expect(() => validateTransferConfig({ ...config, runtimeMustRemainEmpty: ["pos_connections"] })).toThrow(/staging-only subset/);
    expect(() => validateTransferConfig({
      ...config,
      sourceTables: [...config.sourceTables, "provider_credentials"],
      stagingOnlyTables: config.stagingOnlyTables.filter((table) => table !== "provider_credentials"),
    })).toThrow(/staging-only subset|provider_credentials/);
    expect(() => validateTransferConfig({
      ...config,
      sanitizedProjections: {
        ...config.sanitizedProjections,
        pos_connections: {
          ...config.sanitizedProjections.pos_connections,
          redactions: { ...config.sanitizedProjections.pos_connections.redactions, api_token: "copy" },
        },
      },
    })).toThrow(/redactions/);
    expect(() => validateTransferConfig({
      ...config,
      sanitizedProjections: {
        ...config.sanitizedProjections,
        pos_connections: {
          ...config.sanitizedProjections.pos_connections,
          expectedColumns: [...config.sanitizedProjections.pos_connections.expectedColumns, "future_password"],
        },
      },
    })).toThrow(/Credential-like/);
  });

  it("builds a fail-closed credential-sanitizing projection for pos_connections", async () => {
    const config = await loadTransferConfig(configPath);
    const policy = tableTransferPolicy(config, "pos_connections");
    const sql = buildProjectedSelectSql({
      schema: config.schema,
      table: "pos_connections",
      columns: policy.expectedColumns,
      policy,
    });
    expect(policy.mode).toBe("sanitized-projection");
    expect(sql).toContain("'https://redacted.invalid'::text AS \"base_url\"");
    expect(sql).toContain("''::text AS \"api_token\"");
    expect(sql).toContain("NULL::text AS \"winerim_api_token\"");
    expect(sql).toContain("'{}'::jsonb AS \"provider_config\"");
    expect(sql).not.toMatch(/\n {2}"api_token",/);
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
      excludedTableData: ["pos_connections"],
    });
    // PostgreSQL snapshot IDs use decimal xid:xid:xip form, so malformed values fail closed.
    expect(() => buildPgDumpArgs({ outputDir: "/tmp/x", schema: "public", tables: [], snapshotId: "bad" })).toThrow();
    expect(args.filter((arg) => arg.startsWith("--table="))).toHaveLength(24);
    expect(args).toContain("--exclude-table-data=public.pos_connections");
    expect(args).toContain("--data-only");
    expect(args).toContain("--no-owner");
    expect(args).not.toContain(expect.stringContaining("postgres://"));
  });

  it("wraps replacement in one transaction without CASCADE and preserves the staging sentinel", async () => {
    const config = await loadTransferConfig(configPath);
    const replaceTables = targetReplaceTables(config);
    const sql = buildAtomicRestoreSql({
      schema: config.schema,
      replaceTables,
      restoreSqlPath: "/private/tmp/restore-data.sql",
      projectedCopies: [{
        table: "pos_connections",
        columns: ["id", "api_token"],
        filePath: "/private/tmp/projected/pos_connections.copy",
      }],
      expectedPreimage: {
        database: "winerim_staging_fixture",
        walLsn: "0/16B6C50",
        tables: replaceTables.map((table) => ({ table, rowCount: table === "pos_connections" ? 1 : 0 })),
      },
    });
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("pg_try_advisory_xact_lock");
    expect(sql).toContain("IN ACCESS EXCLUSIVE MODE");
    expect(sql).toContain("TARGET_QUIESCENCE_WAL_DRIFT");
    expect(sql).toContain("TARGET_QUIESCENCE_ROW_COUNT_DRIFT:pos_connections");
    expect(sql).toContain("session_replication_role = replica");
    expect(sql).toContain('"public"."pos_connections"');
    expect(sql).toContain('"public"."runtime_idempotency"');
    expect(sql).not.toContain("infrastructure_metadata");
    expect(sql).not.toContain("CASCADE");
    expect(sql).toContain('\\copy "public"."pos_connections" ("id", "api_token")');
    expect(sql).toContain("COMMIT;");
    expect(sql.indexOf("IN ACCESS EXCLUSIVE MODE")).toBeLessThan(sql.indexOf("TARGET_QUIESCENCE_WAL_DRIFT"));
    expect(sql.indexOf("TARGET_QUIESCENCE_WAL_DRIFT")).toBeLessThan(sql.indexOf("TRUNCATE TABLE"));
    expect(() => buildAtomicRestoreSql({
      schema: config.schema,
      replaceTables,
      restoreSqlPath: "/private/tmp/restore-data.sql",
    })).toThrow(/quiescence evidence/);
  });

  it("accepts only a checksummed target backup with continuous quiescence evidence as the import preimage", async () => {
    const config = await loadTransferConfig(configPath);
    const replaceTables = targetReplaceTables(config);
    const manifest = checksumManifest({
      schemaVersion: 2,
      kind: "staging-target-backup",
      snapshotLsn: "0/16B6C50",
      source: { database: "winerim_staging_fixture" },
      quiescenceFence: {
        schemaVersion: 1,
        method: "advisory-lock+wal-stability+table-counts",
        startWalLsn: "0/16B6C50",
        endWalLsn: "0/16B6C50",
        relationPersistence: "permanent",
      },
      tables: replaceTables.map((table) => ({ table, rowCount: 0 })),
    });
    expect(preimageEvidenceFromManifest(manifest, replaceTables)).toEqual({
      database: "winerim_staging_fixture",
      walLsn: "0/16B6C50",
      tables: replaceTables.map((table) => ({ table, rowCount: 0 })),
    });
    expect(() => preimageEvidenceFromManifest({
      ...manifest,
      quiescenceFence: { ...manifest.quiescenceFence, endWalLsn: "0/16B6C51" },
    }, replaceTables)).toThrow(/continuous quiescence/);
  });

  it("requires exact target inventory but permits extra source-owned platform tables", async () => {
    const config = await loadTransferConfig(configPath);
    expect(assertTableInventory(expectedTargetTables(config), expectedTargetTables(config))).toEqual({ missing: [], unexpected: [] });
    expect(() => assertTableInventory(["pos_connections"], expectedTargetTables(config))).toThrow(/missing=/);
    expect(assertTableInventory([...config.sourceTables, "platform_internal"], config.sourceTables, { exact: false })).toEqual({ missing: [], unexpected: [] });
  });

  it("checksums deterministic manifests and detects edits", async () => {
    const config = await loadTransferConfig(configPath);
    const base = {
      schemaVersion: 2,
      schemaSha256: "a".repeat(64),
      archiveSha256: "b".repeat(64),
      projectedDataSha256: "d".repeat(64),
      transferPolicySha256: transferPolicyDigest(config, config.sourceTables),
      tables: config.sourceTables.map((table) => {
        const policy = tableTransferPolicy(config, table);
        return {
          table,
          rowCount: 0,
          sha256: "c".repeat(64),
          transferMode: policy.mode,
          ...(policy.mode === "full" ? {} : { columns: policy.expectedColumns }),
        };
      }),
    };
    const checksummed = checksumManifest(base);
    expect(checksummed.manifestSha256).toBe(manifestDigest(checksummed));
    expect(verifyManifest(checksummed, config.sourceTables, transferPolicyDigest(config, config.sourceTables))).toBe(checksummed);
    expect(() => verifyManifest({ ...checksummed, archiveSha256: "e".repeat(64) }, config.sourceTables, transferPolicyDigest(config, config.sourceTables))).toThrow(/digest/);
    expect(() => verifyManifest(checksummed, config.sourceTables, "f".repeat(64))).toThrow(/policy/);
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
    const direct = `postgres://staging_migrator@db.${config.targetProjectRef}.supabase.co/postgres`;
    expect(assertTargetGate(direct, config.targetProjectRef, config).hostname).toBe(`db.${config.targetProjectRef}.supabase.co`);
    expect(() => assertTargetGate(target, "wrong", config)).toThrow(/Target project confirmation/);
    expect(() => assertTargetGate(
      `postgres://postgres:${config.targetProjectRef}@pooler.supabase.com/postgres`,
      config.targetProjectRef,
      config,
    )).toThrow(/components/);
    expect(() => assertTargetGate(
      `postgres://postgres.${config.targetProjectRef}@pooler.supabase.com.evil.test/postgres`,
      config.targetProjectRef,
      config,
    )).toThrow(/components/);
    expect(() => assertTargetGate(
      `postgres://postgres.${config.targetProjectRef}@pooler.supabase.com:6543/postgres`,
      config.targetProjectRef,
      config,
    )).toThrow(/components/);
    expect(() => assertTargetGate("postgres://u@localhost/source", "local-test", config, "postgres://u@localhost/source", { localTest: true })).toThrow(/must differ/);
  });

  it("writes checksummed state atomically and leaves no temporary files under concurrent updates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "winerim-transfer-state-"));
    const statePath = join(directory, "import-state.json");
    try {
      await Promise.all(Array.from({ length: 8 }, (_, index) => writeState(statePath, {
        phase: `TEST_${index}`,
        sourceManifestSha256: "a".repeat(64),
      })));
      const state = await readState(statePath);
      expect(state?.phase).toMatch(/^TEST_[0-7]$/);
      expect(await readdir(directory)).toEqual(["import-state.json"]);
      expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses to declare rollback success before backup reconciliation", () => {
    expect(assertRollbackReconciled({ ok: true })).toEqual({ ok: true });
    expect(() => assertRollbackReconciled({ ok: false })).toThrow(/digest-verified backup manifest/);
    expect(() => assertRollbackReconciled(null)).toThrow(/digest-verified backup manifest/);
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
    expect(cli).toContain('WINERIM_DATA_TRANSFER_TEST_PAUSE_AFTER_BACKUP_MS');
    expect(cli).toContain('localTest && process.env.WINERIM_DATA_TRANSFER_TEST_PAUSE_AFTER_BACKUP_MS');
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
