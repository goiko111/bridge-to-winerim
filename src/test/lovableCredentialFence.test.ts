import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import {
  prepareLovableCredentialFence,
  renderLovableCredentialFenceApplySql,
  renderLovableCredentialFenceBrowserApplySql,
  renderLovableCredentialFenceReadbackSql,
  renderLovableCredentialFenceRollbackSql,
  validateLovableCredentialFenceInput,
} from "../../infrastructure/runtime/prepare-lovable-credential-fence.mjs";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const AGORA_SECRET = "agora-private-fence-value";
const WINERIM_SECRET = "winerim-private-fence-value";
const scriptPath = join(
  process.cwd(),
  "infrastructure/runtime/prepare-lovable-credential-fence.mjs",
);

function sha256(source: string | Buffer) {
  return createHash("sha256").update(source).digest("hex");
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    provider: "agora",
    enabled: false,
    catalog_sync_enabled: false,
    api_token: AGORA_SECRET,
    winerim_api_token: WINERIM_SECRET,
    provider_config: {
      intraday_sales_sync_enabled: false,
      open_tickets_sync_enabled: false,
      open_tickets_stock_sync_enabled: false,
      nested_secret: "nested-private-value",
    },
    ...overrides,
  };
}

function privateSnapshot(mode: 0o400 | 0o600 = 0o600, value = row()) {
  const directory = mkdtempSync(join(tmpdir(), "lovable-credential-fence-input-"));
  chmodSync(directory, 0o700);
  const bytes = Buffer.from(`${JSON.stringify({ data: [value] }, null, 2)}\n`);
  const snapshotPath = join(directory, "pos-connection.json");
  writeFileSync(snapshotPath, bytes, { mode });
  chmodSync(snapshotPath, mode);
  return { bytes, directory, snapshotPath };
}

function output(prefix = "lovable-credential-fence") {
  const parent = mkdtempSync(join(tmpdir(), `${prefix}-parent-`));
  chmodSync(parent, 0o700);
  return join(parent, "artifacts");
}

function plan(value = row()) {
  return validateLovableCredentialFenceInput({
    snapshotDocument: { rows: [value] },
    connectionId: CONNECTION_ID,
  });
}

describe("Lovable per-connection credential fence preparation", () => {
  it.each([0o400, 0o600] as const)(
    "creates private reversible artifacts from a %o snapshot without remote writes",
    (mode) => {
      const input = privateSnapshot(mode);
      const outputDir = output(`lovable-credential-fence-${mode.toString(8)}`);
      const result = prepareLovableCredentialFence({
        snapshotPath: input.snapshotPath,
        connectionId: CONNECTION_ID,
        outputDir,
      });

      expect(result).toMatchObject({
        status: "LOVABLE_CREDENTIAL_FENCE_ARTIFACTS_READY_NOT_APPLIED",
        remoteMutations: 0,
        connectionId: CONNECTION_ID,
        sourceSnapshotSha256: sha256(input.bytes),
      });
      expect(statSync(outputDir).mode & 0o777).toBe(0o700);
      expect(readdirSync(outputDir).sort()).toEqual([
        "lovable-credential-fence.apply-browser.sql",
        "lovable-credential-fence.apply.sql",
        "lovable-credential-fence.manifest.json",
        "lovable-credential-fence.readback.sql",
        "lovable-credential-fence.rollback.sql",
      ]);
      const paths = readdirSync(outputDir).map((name) => join(outputDir, name));
      for (const path of paths) expect(statSync(path).mode & 0o777).toBe(0o600);

      const apply = readFileSync(result.applySqlPath, "utf8");
      const browserApply = readFileSync(result.browserApplySqlPath, "utf8");
      const rollback = readFileSync(result.rollbackSqlPath, "utf8");
      const readback = readFileSync(result.readbackSqlPath, "utf8");
      const manifestSource = readFileSync(result.manifestPath, "utf8");
      const manifest = JSON.parse(manifestSource);
      const combined = [apply, browserApply, rollback, readback, manifestSource].join("\n");

      expect(combined).not.toContain(AGORA_SECRET);
      expect(combined).not.toContain(WINERIM_SECRET);
      expect(combined).not.toContain("nested-private-value");
      expect(apply).toContain("SET api_token = ''");
      expect(apply).toContain("winerim_api_token = NULL");
      expect(apply).toContain("api_token = :'lovable_api_token'");
      expect(apply).toContain("winerim_api_token = :'lovable_winerim_api_token'");
      expect(apply).toContain("enabled = false");
      expect(apply).toContain("catalog_sync_enabled = false");
      expect(apply).toContain("LOVABLE_CREDENTIAL_FENCE_APPLY_STATE_MISMATCH");
      expect(browserApply).toContain("LOVABLE_CREDENTIAL_FENCE_BROWSER_APPLY_STATE_MISMATCH");
      expect(browserApply).toContain("LOVABLE_CREDENTIAL_FENCE_BROWSER_APPLY_READBACK_FAILED");
      expect(browserApply).toContain("md5(api_token)");
      expect(browserApply).toContain("md5(winerim_api_token)");
      expect(browserApply).not.toContain("\\set");
      expect(rollback).toContain("SET api_token = :'lovable_api_token'");
      expect(rollback).toContain("winerim_api_token = :'lovable_winerim_api_token'");
      expect(rollback).toContain("api_token = ''");
      expect(rollback).toContain("winerim_api_token IS NULL");
      expect(rollback).toContain("LOVABLE_CREDENTIAL_FENCE_ROLLBACK_STATE_MISMATCH");
      expect(readback).not.toContain("api_token,");
      expect(readback).not.toContain("winerim_api_token,");
      expect(readback).toContain("(api_token = '') AS api_token_removed");
      expect(readback).toContain("(winerim_api_token IS NULL) AS winerim_api_token_removed");
      expect(manifest).toMatchObject({
        status: "PREPARED_NOT_APPLIED",
        remoteMutations: 0,
        sourceSnapshotMode: mode.toString(8).padStart(4, "0"),
        expectedBefore: {
          enabled: false,
          catalogSyncEnabled: false,
          apiTokenPresent: true,
          winerimApiTokenPresent: true,
        },
        expectedAfter: {
          apiTokenRemoved: true,
          winerimApiTokenRemoved: true,
        },
      });
      expect(manifest.artifacts).toEqual({
        applySqlSha256: sha256(apply),
        browserApplySqlSha256: sha256(browserApply),
        rollbackSqlSha256: sha256(rollback),
        readbackSqlSha256: sha256(readback),
      });
    },
  );

  it("fails closed unless the connection, catalog and every scheduler are explicitly false", () => {
    expect(() => plan(row({ enabled: true }))).toThrow(
      "LOVABLE_CREDENTIAL_FENCE_ENABLED_MUST_BE_FALSE",
    );
    expect(() => plan(row({ catalog_sync_enabled: true }))).toThrow(
      "LOVABLE_CREDENTIAL_FENCE_CATALOG_SYNC_ENABLED_MUST_BE_FALSE",
    );
    expect(() => plan(row({
      provider_config: {
        intraday_sales_sync_enabled: true,
        open_tickets_sync_enabled: false,
        open_tickets_stock_sync_enabled: false,
      },
    }))).toThrow(
      "LOVABLE_CREDENTIAL_FENCE_SCHEDULER_MUST_BE_FALSE_INTRADAY_SALES_SYNC_ENABLED",
    );
    expect(() => plan(row({
      provider_config: {
        intraday_sales_sync_enabled: false,
        open_tickets_stock_sync_enabled: false,
      },
    }))).toThrow(
      "LOVABLE_CREDENTIAL_FENCE_SCHEDULER_MUST_BE_FALSE_OPEN_TICKETS_SYNC_ENABLED",
    );
  });

  it("fails closed when either credential is absent", () => {
    for (const apiToken of ["", null, undefined]) {
      expect(() => plan(row({ api_token: apiToken }))).toThrow(
        "LOVABLE_CREDENTIAL_FENCE_API_TOKEN_MUST_BE_PRESENT",
      );
    }
    for (const winerimToken of ["", null, undefined]) {
      expect(() => plan(row({ winerim_api_token: winerimToken }))).toThrow(
        "LOVABLE_CREDENTIAL_FENCE_WINERIM_API_TOKEN_MUST_BE_PRESENT",
      );
    }
  });

  it("rejects every snapshot mode except exactly 0400 or 0600", () => {
    for (const mode of [0o000, 0o200, 0o440, 0o640, 0o644]) {
      const input = privateSnapshot(0o600);
      chmodSync(input.snapshotPath, mode);
      expect(() => prepareLovableCredentialFence({
        snapshotPath: input.snapshotPath,
        connectionId: CONNECTION_ID,
        outputDir: output(`lovable-credential-fence-mode-${mode.toString(8)}`),
      })).toThrow("LOVABLE_CREDENTIAL_FENCE_SNAPSHOT_MUST_BE_PRIVATE_0400_OR_0600");
    }
  });

  it("renders guarded apply, reversible rollback and boolean-only readback", () => {
    const validated = plan();
    const apply = renderLovableCredentialFenceApplySql(validated);
    const browserApply = renderLovableCredentialFenceBrowserApplySql(validated);
    const rollback = renderLovableCredentialFenceRollbackSql(validated);
    const readback = renderLovableCredentialFenceReadbackSql(validated);

    for (const source of [apply, rollback]) {
      expect(source).toContain(`WHERE id = '${CONNECTION_ID}'::uuid`);
      expect(source).toContain("provider = 'agora'");
      expect(source).toContain("enabled = false");
      expect(source).toContain("catalog_sync_enabled = false");
      expect(source).toContain("intraday_sales_sync_enabled");
      expect(source).toContain("open_tickets_sync_enabled");
      expect(source).toContain("open_tickets_stock_sync_enabled");
      expect(source).toContain("SELECT (count(*) = 1)");
      expect(source).toContain("ROLLBACK;");
    }
    expect(browserApply).toContain("GET DIAGNOSTICS changed_rows = ROW_COUNT");
    expect(browserApply).toContain("COMMIT;");
    expect(readback).toContain("expected_credential_fence_state");
    expect(readback).not.toMatch(/^\s*api_token\s*[,\n]/m);
    expect(readback).not.toMatch(/^\s*winerim_api_token\s*[,\n]/m);
  });

  it("does not leak secrets through CLI stdout, stderr or generated files", () => {
    const input = privateSnapshot();
    const outputDir = output("lovable-credential-fence-cli");
    const execution = spawnSync(process.execPath, [
      scriptPath,
      "--render",
      `--snapshot=${input.snapshotPath}`,
      `--connection-id=${CONNECTION_ID}`,
      `--output=${outputDir}`,
    ], { encoding: "utf8" });

    expect(execution.status).toBe(0);
    expect(execution.stdout).toContain("LOVABLE_CREDENTIAL_FENCE_ARTIFACTS_READY_NOT_APPLIED");
    expect(execution.stdout).not.toContain(AGORA_SECRET);
    expect(execution.stdout).not.toContain(WINERIM_SECRET);
    expect(execution.stderr).not.toContain(AGORA_SECRET);
    expect(execution.stderr).not.toContain(WINERIM_SECRET);
    const generated = readdirSync(outputDir)
      .map((name) => readFileSync(join(outputDir, name), "utf8"))
      .join("\n");
    expect(generated).not.toContain(AGORA_SECRET);
    expect(generated).not.toContain(WINERIM_SECRET);
  });
});
