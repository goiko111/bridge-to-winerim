import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const config = readFileSync(resolve(root, "wrangler.middleware-runtime.toml"), "utf8");
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
    expect(config).not.toContain("queues.consumers");
  });

  it("binds producers only to the verified staging Queue names", () => {
    const queueNames = [...config.matchAll(/^queue\s*=\s*"([^"]+)"$/gm)].map((match) => match[1]);
    expect(new Set(queueNames)).toEqual(new Set([
      "winerim-staging-catalog",
      "winerim-staging-sales",
      "winerim-staging-stock",
      "winerim-staging-outbound",
      "winerim-staging-maintenance",
    ]));
    expect(queueNames).toHaveLength(6);
  });

  it("keeps Hyperdrive out of the deployable config until a real ID exists", () => {
    expect(config).not.toContain("hyperdrive");
    expect(config).not.toContain("MIDDLEWARE_DB");
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
    });
  });
});
