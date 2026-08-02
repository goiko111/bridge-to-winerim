import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const config = readFileSync(resolve(root, "wrangler.middleware-runtime.toml"), "utf8");
const apiConfig = readFileSync(resolve(root, "wrangler.middleware.toml"), "utf8");
const executorConfig = readFileSync(
  resolve(root, "wrangler.middleware-runtime-executor.toml"),
  "utf8",
);
const hyperdriveExample = readFileSync(
  resolve(root, "wrangler.middleware-runtime.hyperdrive.toml.example"),
  "utf8",
);
const apiHyperdriveExample = readFileSync(
  resolve(root, "wrangler.middleware-api.hyperdrive.toml.example"),
  "utf8",
);
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("Cloudflare middleware runtime staging config", () => {
  it("is staging-only and inert by default", () => {
    expect(config).toContain('main = "cloudflare/workers/middleware-runtime/src/worker.ts"');
    expect(config).toMatch(/workers_dev\s*=\s*false/g);
    expect(config).toContain('[env.staging.vars]');
    expect(config).toContain('RUNTIME_EXECUTION_ENABLED = "false"');
    expect(config).toContain('crons = ["*/5 * * * *"]');
    expect(config).not.toContain("[env.production]");
    expect(config).not.toMatch(/\broutes\s*=/);
    expect(config.match(/\[\[env\.staging\.queues\.consumers\]\]/g)).toHaveLength(1);
    expect(config).toContain('queue = "winerim-staging-stock"');
    expect(config).toContain('dead_letter_queue = "winerim-staging-dead-letter"');
    expect(config).toContain("max_batch_size = 1");
    expect(config).toContain("max_concurrency = 1");
    expect(config).toContain('binding = "RUNTIME_EXECUTOR"');
    expect(config).toContain('service = "winerim-middleware-runtime-executor-staging"');
  });

  it("binds producers only to the verified staging Queue names", () => {
    const producerConfig = config.split("# Canary-only consumer")[0];
    const queueNames = [...producerConfig.matchAll(/^queue\s*=\s*"([^"]+)"$/gm)].map((match) => match[1]);
    expect(new Set(queueNames)).toEqual(new Set([
      "winerim-staging-catalog",
      "winerim-staging-sales",
      "winerim-staging-stock",
      "winerim-staging-outbound",
      "winerim-staging-maintenance",
    ]));
    expect(queueNames).toHaveLength(6);
  });

  it("keeps the private executor staging-only, unrouted and without embedded vault material", () => {
    expect(executorConfig).toContain('main = "cloudflare/workers/middleware-runtime-executor/src/worker.ts"');
    expect(executorConfig).toContain('RUNTIME_EXECUTION_ENABLED = "false"');
    expect(executorConfig).toContain('RUNTIME_VAULT_KEY_VERSION = "v1"');
    expect(executorConfig).toContain('WINERIM_ALLOWED_HOSTS = "app.winerim.com"');
    expect(executorConfig).not.toContain("[env.production]");
    expect(executorConfig).not.toMatch(/\broutes\s*=/);
    expect(executorConfig).not.toContain("RUNTIME_VAULT_KEY =");
    expect(executorConfig).not.toMatch(/store_id\s*=/);
    expect(executorConfig).not.toMatch(/secret_name\s*=/);
  });

  it("binds distinct middleware-owned Hyperdrives in staging", () => {
    const runtimeId = config.match(/\[\[env\.staging\.hyperdrive\]\][\s\S]*?binding\s*=\s*"MIDDLEWARE_DB"[\s\S]*?id\s*=\s*"([a-f0-9]{32})"/)?.[1];
    const apiId = apiConfig.match(/\[\[env\.staging\.hyperdrive\]\][\s\S]*?binding\s*=\s*"MIDDLEWARE_DB"[\s\S]*?id\s*=\s*"([a-f0-9]{32})"/)?.[1];
    expect(runtimeId).toBeTruthy();
    expect(apiId).toBeTruthy();
    expect(runtimeId).not.toBe(apiId);
    expect(config).not.toContain("market-winerim-postgres");
    expect(apiConfig).not.toContain("market-winerim-postgres");
    expect(hyperdriveExample).toContain('binding = "MIDDLEWARE_DB"');
    expect(hyperdriveExample).not.toMatch(/^\s*id\s*=/m);
    expect(hyperdriveExample).toContain("must never be passed to Wrangler directly");
    expect(apiHyperdriveExample).toContain('binding = "MIDDLEWARE_DB"');
    expect(apiHyperdriveExample).toContain("middleware_api");
    expect(apiHyperdriveExample).not.toMatch(/^\s*id\s*=/m);
  });

  it("provides explicit test, dry-run, deploy, status and rollback scripts", () => {
    expect(packageJson.scripts).toMatchObject({
      "cf:runtime:test": "vitest run src/test/cloudflareRuntime*.test.ts",
      "cf:runtime:dry-run:staging": expect.stringContaining("--dry-run"),
      "cf:runtime:deploy:staging": expect.stringContaining("--strict"),
      "cf:runtime:deployments:staging": expect.stringContaining("deployments status"),
      "cf:runtime:rollback:staging": expect.stringContaining("wrangler rollback"),
      "cf:executor:dry-run:staging": expect.stringContaining("wrangler.middleware-runtime-executor.toml"),
    });
  });
});
