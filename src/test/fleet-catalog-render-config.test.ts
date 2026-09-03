import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  FLEET_CATALOG_CONSUMER_BLOCK,
  FleetCatalogRenderError,
  renderFleetCatalogRuntimeConfig,
  validateFleetCatalogRuntimeConfig,
} from "../../infrastructure/runtime/fleet-catalog-render-config.mjs";

const root = resolve(import.meta.dirname, "../..");
const runtimeSource = readFileSync(resolve(root, "wrangler.middleware-runtime-fleet.toml"), "utf8");
const executorSource = readFileSync(
  resolve(root, "wrangler.middleware-runtime-executor-fleet.toml"),
  "utf8",
);
const fixture = readFileSync(
  resolve(root, "src/test/fixtures/fleet-catalog-consumer.toml"),
  "utf8",
).trim();
const rendererPath = resolve(root, "infrastructure/runtime/fleet-catalog-render-config.mjs");

function errorCode(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(FleetCatalogRenderError);
    return (error as FleetCatalogRenderError).code;
  }
}

describe("fleet catalog-only runtime config renderer", () => {
  it("renders one isolated catalog consumer with bounded parallelism", () => {
    const renderedSource = renderFleetCatalogRuntimeConfig({ baseSource: runtimeSource, executorSource });
    const result = validateFleetCatalogRuntimeConfig({
      baseSource: runtimeSource,
      executorSource,
      renderedSource,
    });

    expect(FLEET_CATALOG_CONSUMER_BLOCK).toBe(fixture);
    expect(result).toMatchObject({
      ok: true,
      mode: "fleet-catalog-only",
      consumerCount: 1,
      queue: "winerim-rescue-prod-catalog",
      maxBatchSize: 1,
      maxBatchTimeout: 5,
      maxRetries: 3,
      maxConcurrency: 2,
      deadLetterQueue: "winerim-rescue-prod-dead-letter",
    });
    expect(renderedSource.match(/\[\[queues\.consumers\]\]/gu)).toHaveLength(1);
    expect(renderedSource).toContain('crons = ["*/5 * * * *"]');
    expect(renderedSource.match(/\[\[queues\.producers\]\]/gu)).toHaveLength(6);
    expect(renderedSource).toContain('binding = "RUNTIME_EXECUTOR"');
    expect(renderedSource).toContain('binding = "MIDDLEWARE_DB"');
  });

  it("rejects any second consumer or unrelated base mutation", () => {
    const renderedSource = renderFleetCatalogRuntimeConfig({ baseSource: runtimeSource, executorSource });
    const withSalesConsumer = `${renderedSource}\n[[queues.consumers]]\nqueue = "winerim-rescue-prod-sales"\n`;
    const changedCron = renderedSource.replace('crons = ["*/5 * * * *"]', 'crons = ["* * * * *"]');

    expect(errorCode(() => validateFleetCatalogRuntimeConfig({
      baseSource: runtimeSource,
      executorSource,
      renderedSource: withSalesConsumer,
    }))).toBe("FLEET_CATALOG_CONSUMER_COUNT_MUST_BE_ONE");
    expect(errorCode(() => validateFleetCatalogRuntimeConfig({
      baseSource: runtimeSource,
      executorSource,
      renderedSource: changedCron,
    }))).toBe("FLEET_CATALOG_BASE_CONFIG_CHANGED");
  });

  it("rejects batching or concurrency drift", () => {
    const renderedSource = renderFleetCatalogRuntimeConfig({ baseSource: runtimeSource, executorSource });
    const batched = renderedSource.replace("max_batch_size = 1", "max_batch_size = 10");
    const serialized = renderedSource.replace("max_concurrency = 2", "max_concurrency = 1");

    expect(errorCode(() => validateFleetCatalogRuntimeConfig({
      baseSource: runtimeSource,
      executorSource,
      renderedSource: batched,
    }))).toBe("FLEET_CATALOG_CONSUMER_CONTRACT_MISMATCH");
    expect(errorCode(() => validateFleetCatalogRuntimeConfig({
      baseSource: runtimeSource,
      executorSource,
      renderedSource: serialized,
    }))).toBe("FLEET_CATALOG_CONSUMER_CONTRACT_MISMATCH");
  });

  it("writes a private local artifact through the CLI", () => {
    const outputPath = resolve(tmpdir(), `fleet-catalog-runtime-${process.pid}.toml`);
    rmSync(outputPath, { force: true });
    try {
      const output = execFileSync(process.execPath, [rendererPath, `--output=${outputPath}`], {
        cwd: root,
        encoding: "utf8",
      });
      const renderedSource = readFileSync(outputPath, "utf8");

      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        mode: "fleet-catalog-only",
        consumerCount: 1,
        outputPath,
      });
      expect(renderedSource).toContain(fixture);
      expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(outputPath, { force: true });
    }
  });
});
