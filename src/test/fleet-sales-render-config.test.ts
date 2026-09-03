import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  FLEET_SALES_CONSUMER_BLOCK,
  FleetSalesRenderError,
  renderFleetSalesRuntimeConfig,
  validateFleetSalesRuntimeConfig,
} from "../../infrastructure/runtime/fleet-sales-render-config.mjs";

const root = resolve(import.meta.dirname, "../..");
const runtimeSource = readFileSync(resolve(root, "wrangler.middleware-runtime-fleet.toml"), "utf8");
const executorSource = readFileSync(
  resolve(root, "wrangler.middleware-runtime-executor-fleet.toml"),
  "utf8",
);
const fixture = readFileSync(
  resolve(root, "src/test/fixtures/fleet-sales-consumer.toml"),
  "utf8",
).trim();
const rendererPath = resolve(root, "infrastructure/runtime/fleet-sales-render-config.mjs");

function errorCode(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(FleetSalesRenderError);
    return (error as FleetSalesRenderError).code;
  }
}

describe("fleet sales-only runtime config renderer", () => {
  it("renders exactly the reviewed sales consumer and preserves cron and bindings", () => {
    const renderedSource = renderFleetSalesRuntimeConfig({ baseSource: runtimeSource, executorSource });
    const result = validateFleetSalesRuntimeConfig({
      baseSource: runtimeSource,
      executorSource,
      renderedSource,
    });

    expect(FLEET_SALES_CONSUMER_BLOCK).toBe(fixture);
    expect(result).toMatchObject({
      ok: true,
      mode: "fleet-sales-only",
      consumerCount: 1,
      queue: "winerim-rescue-prod-sales",
      maxBatchSize: 1,
      maxBatchTimeout: 5,
      maxRetries: 3,
      maxConcurrency: 1,
      deadLetterQueue: "winerim-rescue-prod-dead-letter",
    });
    expect(renderedSource.match(/\[\[queues\.consumers\]\]/gu)).toHaveLength(1);
    expect(renderedSource).toContain('crons = ["*/5 * * * *"]');
    expect(renderedSource.match(/\[\[queues\.producers\]\]/gu)).toHaveLength(6);
    expect(renderedSource).toContain('binding = "RUNTIME_EXECUTOR"');
    expect(renderedSource).toContain('binding = "MIDDLEWARE_DB"');
  });

  it("fails closed if any additional consumer is present", () => {
    const renderedSource = renderFleetSalesRuntimeConfig({ baseSource: runtimeSource, executorSource });
    const withCatalogConsumer = `${renderedSource}\n\n[[queues.consumers]]\nqueue = "winerim-rescue-prod-catalog"\n`;
    const withStockConsumer = `${renderedSource}\n\n[[queues.consumers]]\nqueue = "winerim-rescue-prod-stock"\n`;

    expect(errorCode(() => validateFleetSalesRuntimeConfig({
      baseSource: runtimeSource,
      executorSource,
      renderedSource: withCatalogConsumer,
    }))).toBe("FLEET_SALES_CONSUMER_COUNT_MUST_BE_ONE");
    expect(errorCode(() => validateFleetSalesRuntimeConfig({
      baseSource: runtimeSource,
      executorSource,
      renderedSource: withStockConsumer,
    }))).toBe("FLEET_SALES_CONSUMER_COUNT_MUST_BE_ONE");
  });

  it("rejects a changed consumer contract or any unrelated base config mutation", () => {
    const renderedSource = renderFleetSalesRuntimeConfig({ baseSource: runtimeSource, executorSource });
    const wrongConcurrency = renderedSource.replace("max_concurrency = 1", "max_concurrency = 2");
    const changedCron = renderedSource.replace('crons = ["*/5 * * * *"]', 'crons = ["* * * * *"]');

    expect(errorCode(() => validateFleetSalesRuntimeConfig({
      baseSource: runtimeSource,
      executorSource,
      renderedSource: wrongConcurrency,
    }))).toBe("FLEET_SALES_CONSUMER_CONTRACT_MISMATCH");
    expect(errorCode(() => validateFleetSalesRuntimeConfig({
      baseSource: runtimeSource,
      executorSource,
      renderedSource: changedCron,
    }))).toBe("FLEET_SALES_BASE_CONFIG_CHANGED");
  });

  it("renders a private local artifact through the CLI", () => {
    const outputPath = resolve(tmpdir(), `fleet-sales-runtime-${process.pid}.toml`);
    rmSync(outputPath, { force: true });
    try {
      const output = execFileSync(process.execPath, [rendererPath, `--output=${outputPath}`], {
        cwd: root,
        encoding: "utf8",
      });
      const renderedSource = readFileSync(outputPath, "utf8");

      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        mode: "fleet-sales-only",
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
