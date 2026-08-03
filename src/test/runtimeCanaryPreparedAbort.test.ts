import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import {
  prepareRescueCanaryPreparedAbort,
  renderRescueCanaryPreparedAbortSql,
  rescueCanaryPreparedAbortPlan,
} from "../../infrastructure/runtime/prepare-rescue-canary-prepared-abort.mjs";

const CONNECTION_ID = "ba44c13a-5f48-4a49-8b3f-04049b244d94";
const RUN_ID = "elbejeque-20260803-b";
const root = resolve(import.meta.dirname, "../..");

describe("prepared runtime canary abort", () => {
  it("renders an exact append-only PREPARED to ABORTED transaction", () => {
    const sql = renderRescueCanaryPreparedAbortSql({ connectionId: CONNECTION_ID, runId: RUN_ID });

    expect(sql).toContain("SELECT pg_advisory_xact_lock(hashtextextended('runtime-canary-control-plane', 0))");
    expect(sql).toContain("status = 'PREPARED'");
    expect(sql).toContain("status = 'ABORTED'");
    expect(sql).toContain("AND active = false");
    expect(sql).toContain("AND activated_at IS NULL");
    expect(sql).toContain("AND retired_at IS NULL");
    expect(sql).toContain("SET retired_at = transaction_timestamp()");
    expect(sql).toContain("credential_kind IN ('agora', 'winerim')");
    expect(sql).toContain("exact inactive prepared credential generation does not match");
    expect(sql).toContain("prepared abort candidate is missing or connection is not inert");
    expect(sql).not.toMatch(/\bDELETE\b/);
  });

  it("describes a no-delete, no-activation plan", () => {
    expect(rescueCanaryPreparedAbortPlan({ connectionId: CONNECTION_ID, runId: RUN_ID })).toMatchObject({
      status: "RESCUE_CANARY_PREPARED_ABORT_PLAN_READY",
      remoteMutations: 0,
      connectionId: CONNECTION_ID,
      runId: RUN_ID,
      database: {
        transition: "PREPARED_TO_ABORTED",
        requiresInactiveScope: true,
        requiresExactlyTwoInactiveCredentials: true,
        requiresInertConnection: true,
        preservesRows: true,
        deletesRows: false,
        activatesCredentials: false,
      },
    });
  });

  it("writes a private SQL artifact outside the repository", () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), "winerim-prepared-abort-test-"));
    const output = join(outputDirectory, "abort.sql");
    try {
      const result = prepareRescueCanaryPreparedAbort({
        environment: { CANARY_CONNECTION_ID: CONNECTION_ID, CANARY_RUN_ID: RUN_ID },
        output,
      });
      expect(result.status).toBe("RESCUE_CANARY_PREPARED_ABORT_PLAN_READY");
      expect(result.sqlSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(statSync(output).mode & 0o777).toBe(0o600);
      expect(readFileSync(output, "utf8")).toContain(`run_id = '${RUN_ID}'`);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("rejects invalid identities and in-repository output", () => {
    expect(() => renderRescueCanaryPreparedAbortSql({ connectionId: "invalid", runId: RUN_ID }))
      .toThrow("RESCUE_CANARY_PREPARED_ABORT_INVALID_CONNECTION_ID");
    expect(() => renderRescueCanaryPreparedAbortSql({ connectionId: CONNECTION_ID, runId: "B" }))
      .toThrow("RESCUE_CANARY_PREPARED_ABORT_INVALID_RUN_ID");
    expect(() => prepareRescueCanaryPreparedAbort({
      environment: { CANARY_CONNECTION_ID: CONNECTION_ID, CANARY_RUN_ID: RUN_ID },
      output: resolve(root, "tmp-abort.sql"),
    })).toThrow("RESCUE_CANARY_PREPARED_ABORT_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  });

  it("ships exactly one migration with terminal and rotation-compatible constraints", () => {
    const migrations = readdirSync(resolve(root, "supabase/migrations"))
      .filter((name) => name.endsWith("_runtime_canary_prepared_abort.sql"));
    expect(migrations).toHaveLength(1);
    const migration = readFileSync(resolve(root, "supabase/migrations", migrations[0]), "utf8");

    expect(migration).toContain("status = 'ABORTED'");
    expect(migration).toMatch(/status = 'ABORTED'[\s\S]*?activated_at IS NULL/);
    expect(migration).toMatch(/runtime_connection_credentials_lifecycle_check[\s\S]*?activated_at IS NULL[\s\S]*?retired_at IS NOT NULL/);
    expect(migration).toContain("RUNTIME_CANARY_SCOPE_TERMINAL");
    expect(migration).toContain("RUNTIME_CREDENTIAL_TERMINAL");
    expect(migration).not.toMatch(/\bDELETE\b/);
  });
});
