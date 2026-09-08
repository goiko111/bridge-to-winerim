import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import {
  renderRuntimeCanaryConfigs,
  validateRuntimeCanaryEnvironment,
} from "../../scripts/runtime-canary-config.mjs";
// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import {
  buildRuntimeCanaryRemovalCommand,
  runtimeCanaryWorkerName,
} from "../../scripts/remove-runtime-canary-consumer.mjs";

const validEnvironment = {
  RUNTIME_CANARY_CONNECTION_ID: "11111111-1111-4111-8111-111111111111",
  CLOUDFLARE_RUNTIME_VAULT_STORE_ID: "store_fixture_01",
  CLOUDFLARE_RUNTIME_VAULT_SECRET_NAME: "runtime_vault_key_v1",
};

describe("runtime canary deployment safety", () => {
  it("fails closed without reviewed connection and Secrets Store coordinates", () => {
    expect(() => validateRuntimeCanaryEnvironment({})).toThrow(
      "RUNTIME_CANARY_PREFLIGHT_MISSING_RUNTIME_CANARY_CONNECTION_ID",
    );
    expect(() => validateRuntimeCanaryEnvironment({
      ...validEnvironment,
      RUNTIME_CANARY_CONNECTION_ID: "00000000-0000-4000-8000-000000000000",
    })).toThrow("RUNTIME_CANARY_PREFLIGHT_INVALID_CONNECTION_ID");
  });

  it("renders non-deployable templates into private temporary Wrangler configs", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "runtime-canary-config-test."));
    const outputs = renderRuntimeCanaryConfigs({
      environment: validEnvironment,
      outputDir,
    });

    const runtime = readFileSync(outputs.runtime, "utf8");
    const executor = readFileSync(outputs.executor, "utf8");
    expect(runtime).toContain('name = "winerim-middleware-runtime-canary-staging"');
    expect(runtime).toContain('queue = "winerim-staging-sales"');
    expect(runtime).toContain(validEnvironment.RUNTIME_CANARY_CONNECTION_ID);
    expect(executor).toContain("[[env.staging.secrets_store_secrets]]");
    expect(executor).toContain('binding = "RUNTIME_VAULT_KEY"');
    expect(executor).toContain(`store_id = "${validEnvironment.CLOUDFLARE_RUNTIME_VAULT_STORE_ID}"`);
    expect(executor).toContain(`secret_name = "${validEnvironment.CLOUDFLARE_RUNTIME_VAULT_SECRET_NAME}"`);
    expect(runtime).not.toMatch(/{{[A-Z0-9_]+}}/);
    expect(executor).not.toMatch(/{{[A-Z0-9_]+}}/);
    expect(statSync(outputs.runtime).mode & 0o777).toBe(0o600);
    expect(statSync(outputs.executor).mode & 0o777).toBe(0o600);
  });

  it("plans removal of the dedicated consumer Worker without mutating remote state", () => {
    const invocation = buildRuntimeCanaryRemovalCommand();
    expect(runtimeCanaryWorkerName).toBe("winerim-middleware-runtime-canary-staging");
    expect(invocation.args).toEqual(expect.arrayContaining([
      "delete",
      runtimeCanaryWorkerName,
      "--dry-run",
    ]));
    expect(invocation.args).not.toContain("--force");
  });
});
