import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error Operational ESM module is exercised directly by Vitest.
import {
  STAGING_PROJECT_REF,
  validateStagingDatabaseUrl,
} from "../../infrastructure/postgres/staging-target.mjs";

const root = resolve(import.meta.dirname, "../..");

describe("staging runtime schema upgrade gates", () => {
  it("pins the immutable Supabase project by URL components", () => {
    expect(STAGING_PROJECT_REF).toBe("qpbmqvfnunkylvtvnyyx");
    expect(validateStagingDatabaseUrl(
      `postgresql://staging_migrator@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`,
    )).toMatchObject({ projectRef: STAGING_PROJECT_REF, mode: "direct", database: "postgres", port: "5432" });
    expect(validateStagingDatabaseUrl(
      `postgresql://postgres.${STAGING_PROJECT_REF}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`,
    )).toMatchObject({ projectRef: STAGING_PROJECT_REF, mode: "pooler" });
  });

  it("rejects wrong refs, databases, ports and password-based identity tricks", () => {
    expect(() => validateStagingDatabaseUrl(
      "postgresql://postgres@db.other.supabase.co:5432/postgres",
    )).toThrow(/IDENTITY/);
    expect(() => validateStagingDatabaseUrl(
      `postgresql://postgres.${STAGING_PROJECT_REF}@pooler.supabase.com:6543/postgres`,
    )).toThrow(/PORT/);
    expect(() => validateStagingDatabaseUrl(
      `postgresql://postgres.${STAGING_PROJECT_REF}@pooler.supabase.com:5432/not_postgres`,
    )).toThrow(/IDENTITY/);
    expect(() => validateStagingDatabaseUrl(
      `postgresql://postgres:${STAGING_PROJECT_REF}@pooler.supabase.com:5432/postgres`,
    )).toThrow(/IDENTITY/);
  });

  it("keeps workflow and scripts fail-closed and production-free", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/deploy-middleware-staging.yml"), "utf8");
    const upgrade = readFileSync(resolve(root, "infrastructure/postgres/upgrade-staging-runtime.sh"), "utf8");
    const rollback = readFileSync(resolve(root, "infrastructure/postgres/rollback-runtime-upgrade.sql"), "utf8");
    const validate = readFileSync(resolve(root, "infrastructure/postgres/validate.sh"), "utf8");
    expect(workflow).toContain("upgrade-runtime-28-to-30");
    expect(workflow).toContain("--confirm-project-ref qpbmqvfnunkylvtvnyyx");
    expect(workflow).not.toContain("STAGING_DB_HOST");
    expect(workflow).not.toContain("STAGING_DB_NAME");
    expect(upgrade).toContain("RESULT=PLAN_ONLY");
    expect(upgrade).toContain("YES_ENCRYPTED_VOLUME");
    expect(upgrade).toContain("BACKUP_RESTORE_TEST_FAILED");
    expect(upgrade).toContain("pg_advisory_xact_lock");
    expect(upgrade).toContain("combined_migration");
    expect(rollback).toContain("runtime upgrade rollback requires empty canary and credential tables");
    expect(validate).toContain('STAGING_VERIFIER="$SCRIPT_DIR/verify-staging.sh"');
    expect(validate).toContain('&& "$STAGING_VERIFIER" "$DATABASE_URL"');
    expect(`${workflow}\n${upgrade}\n${rollback}`).not.toMatch(/production_database|prod-project/i);
  });
});
