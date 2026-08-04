import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  FLEET_SALES_LIVE_BASE_EXECUTOR_SHA256,
  FLEET_SALES_LIVE_BASE_RUNTIME_SHA256,
  FLEET_SALES_LIVE_CONSUMER_BLOCK,
  FLEET_EXECUTOR_PRIVATE_BINDINGS_BLOCK,
  FLEET_SALES_LIVE_JOBS,
  FLEET_WRITER_FENCE_CONFIG,
  FLEET_WRITER_FENCE_SERVICE,
  FleetSalesLiveRenderError,
  renderFleetSalesLiveConfigs,
  validateFleetSalesLiveConfigs,
} from "../../infrastructure/runtime/fleet-sales-live-render-config.mjs";

const root = resolve(import.meta.dirname, "../..");
const runtimeSource = readFileSync(resolve(root, "wrangler.middleware-runtime-fleet.toml"), "utf8");
const executorSource = readFileSync(
  resolve(root, "wrangler.middleware-runtime-executor-fleet.toml"),
  "utf8",
);
const rendererPath = resolve(
  root,
  "infrastructure/runtime/fleet-sales-live-render-config.mjs",
);

function errorCode(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(FleetSalesLiveRenderError);
    return (error as FleetSalesLiveRenderError).code;
  }
}

function validateRendered(
  renderedRuntimeSource: string,
  renderedExecutorSource: string,
  renderedWriterFenceSource = FLEET_WRITER_FENCE_CONFIG,
  baseRuntimeSource = runtimeSource,
  baseExecutorSource = executorSource,
) {
  return validateFleetSalesLiveConfigs({
    baseRuntimeSource,
    baseExecutorSource,
    renderedRuntimeSource,
    renderedExecutorSource,
    renderedWriterFenceSource,
  });
}

describe("fleet sales-only live config renderer", () => {
  it("changes only the execution flags and adds the exact sales consumer", () => {
    const result = renderFleetSalesLiveConfigs({ runtimeSource, executorSource });
    const expectedRuntime = `${runtimeSource.replace(
      'RUNTIME_EXECUTION_ENABLED = "false"',
      'RUNTIME_EXECUTION_ENABLED = "true"',
    )}\n${FLEET_SALES_LIVE_CONSUMER_BLOCK}\n`;
    const enabledExecutor = [
      "RUNTIME_EXECUTION_ENABLED",
      "RUNTIME_SALES_EXECUTION_ENABLED",
      "RUNTIME_SALES_CURSOR_ENABLED",
      "RUNTIME_SALES_DLQ_READY",
    ].reduce(
      (source, key) => source.replace(`${key} = "false"`, `${key} = "true"`),
      executorSource,
    );
    const expectedExecutor = `${enabledExecutor}\n${FLEET_EXECUTOR_PRIVATE_BINDINGS_BLOCK}\n`;

    expect(result.renderedRuntimeSource).toBe(expectedRuntime);
    expect(result.renderedExecutorSource).toBe(expectedExecutor);
    expect(result.manifest).toMatchObject({
      schemaVersion: 1,
      mode: "fleet-sales-only-live-no-connections",
      executionEnabled: true,
      connectionsActivated: 0,
      jobs: ["sales.auto-sync", "sales.sync-intraday"],
      runtime: {
        baseSha256: FLEET_SALES_LIVE_BASE_RUNTIME_SHA256,
        producerCount: 6,
        cron: "*/5 * * * *",
        consumer: {
          queue: "winerim-rescue-prod-sales",
          maxBatchSize: 1,
          maxBatchTimeout: 5,
          maxRetries: 3,
          maxConcurrency: 1,
          deadLetterQueue: "winerim-rescue-prod-dead-letter",
        },
      },
      executor: {
        baseSha256: FLEET_SALES_LIVE_BASE_EXECUTOR_SHA256,
        consumerCount: 0,
      },
    });
    expect(FLEET_SALES_LIVE_JOBS).toEqual(["sales.auto-sync", "sales.sync-intraday"]);
    expect(result.renderedRuntimeSource.match(/\[\[queues\.consumers\]\]/gu)).toHaveLength(1);
    expect(result.renderedExecutorSource).not.toContain("[[queues.consumers]]");
    expect(result.renderedExecutorSource).toContain('RUNTIME_SALES_EXECUTION_ENABLED = "true"');
    expect(result.renderedExecutorSource).toContain('RUNTIME_SALES_CURSOR_ENABLED = "true"');
    expect(result.renderedExecutorSource).toContain('RUNTIME_SALES_DLQ_READY = "true"');
    expect(result.renderedExecutorSource).toContain('RUNTIME_CATALOG_EXECUTION_ENABLED = "false"');
    expect(result.renderedExecutorSource).toContain('RUNTIME_OUTBOUND_EXECUTION_ENABLED = "false"');
    expect(result.renderedExecutorSource).toContain('binding = "RUNTIME_VAULT_KEY"');
    expect(result.renderedExecutorSource).toContain(
      'binding = "RUNTIME_FLEET_WRITER_FENCE_BUNDLE"',
    );
    expect(result.renderedExecutorSource).toContain('binding = "WRITER_FENCE"');
    expect(result.renderedWriterFenceSource).toBe(FLEET_WRITER_FENCE_CONFIG);
    expect(result.manifest.writerFence).toMatchObject({
      name: FLEET_WRITER_FENCE_SERVICE,
      durableObject: "ConnectionWriterFence",
      globalGrantBound: false,
    });
  });

  it("preserves names, Hyperdrive, service binding, cron and all producers", () => {
    const result = renderFleetSalesLiveConfigs({ runtimeSource, executorSource });
    const manifest = validateRendered(result.renderedRuntimeSource, result.renderedExecutorSource);

    expect(manifest.runtime).toMatchObject({
      name: "winerim-middleware-runtime-rescue-prod-fleet",
      hyperdrive: {
        binding: "MIDDLEWARE_DB",
        id: "bf568eb1d85a41539384f241084c2227",
      },
      executorService: {
        binding: "RUNTIME_EXECUTOR",
        service: "winerim-middleware-runtime-executor-rescue-prod-fleet",
      },
      cron: "*/5 * * * *",
      producerCount: 6,
    });
    expect(manifest.executor).toMatchObject({
      name: "winerim-middleware-runtime-executor-rescue-prod-fleet",
      hyperdrive: {
        binding: "MIDDLEWARE_DB",
        id: "bf568eb1d85a41539384f241084c2227",
      },
    });
    expect(manifest.writerFence).toMatchObject({
      name: FLEET_WRITER_FENCE_SERVICE,
      hyperdrive: {
        binding: "MIDDLEWARE_DB",
        id: "bf568eb1d85a41539384f241084c2227",
      },
    });
  });

  it("fails closed when either canonical inert base drifts", () => {
    const changedRuntimeName = runtimeSource.replace(
      'name = "winerim-middleware-runtime-rescue-prod-fleet"',
      'name = "unreviewed-runtime"',
    );
    const changedExecutorHyperdrive = executorSource.replace(
      'id = "bf568eb1d85a41539384f241084c2227"',
      'id = "unreviewed-hyperdrive"',
    );

    expect(errorCode(() => renderFleetSalesLiveConfigs({
      runtimeSource: changedRuntimeName,
      executorSource,
    }))).toBe("FLEET_SALES_LIVE_BASE_INVALID_RUNTIME_NAME_NOT_RESCUE");
    expect(errorCode(() => renderFleetSalesLiveConfigs({
      runtimeSource,
      executorSource: changedExecutorHyperdrive,
    }))).toBe("FLEET_SALES_LIVE_BASE_INVALID_EXECUTOR_HYPERDRIVE_ID_MISMATCH");
  });

  it("rejects subtle base drift even when the required bindings still parse", () => {
    const changedRuntimeRelease = runtimeSource.replace(
      'RELEASE = "rescue-production-fleet-inert"',
      'RELEASE = "unreviewed-release"',
    );
    const changedExecutorComment = executorSource.replace(
      "# intentionally absent.",
      "# intentionally absent and changed.",
    );

    expect(errorCode(() => renderFleetSalesLiveConfigs({
      runtimeSource: changedRuntimeRelease,
      executorSource,
    }))).toBe("RUNTIME_BASE_SHA256_DRIFT");
    expect(errorCode(() => renderFleetSalesLiveConfigs({
      runtimeSource,
      executorSource: changedExecutorComment,
    }))).toBe("EXECUTOR_BASE_SHA256_DRIFT");
  });

  it("rejects any rendered mutation or additional consumer", () => {
    const result = renderFleetSalesLiveConfigs({ runtimeSource, executorSource });
    const changedCron = result.renderedRuntimeSource.replace(
      'crons = ["*/5 * * * *"]',
      'crons = ["* * * * *"]',
    );
    const extraConsumer = `${result.renderedRuntimeSource}\n[[queues.consumers]]\nqueue = "other"\n`;
    const changedExecutor = result.renderedExecutorSource.replace(
      'RUNTIME_CATALOG_EXECUTION_ENABLED = "false"',
      'RUNTIME_CATALOG_EXECUTION_ENABLED = "true"',
    );

    expect(errorCode(() => validateRendered(changedCron, result.renderedExecutorSource)))
      .toBe("RUNTIME_UNRELATED_CHANGE_DETECTED");
    expect(errorCode(() => validateRendered(extraConsumer, result.renderedExecutorSource)))
      .toBe("RUNTIME_UNRELATED_CHANGE_DETECTED");
    expect(errorCode(() => validateRendered(result.renderedRuntimeSource, changedExecutor)))
      .toBe("EXECUTOR_UNRELATED_CHANGE_DETECTED");
  });

  it("writes two private configs and a secret-free logical manifest", () => {
    const prefix = resolve(tmpdir(), `fleet-sales-live-${process.pid}`);
    const runtimeOutput = `${prefix}-runtime.toml`;
    const executorOutput = `${prefix}-executor.toml`;
    const writerFenceOutput = `${prefix}-writer-fence.toml`;
    const manifestOutput = `${prefix}-manifest.json`;
    for (const path of [runtimeOutput, executorOutput, writerFenceOutput, manifestOutput]) {
      rmSync(path, { force: true });
    }

    try {
      const output = execFileSync(process.execPath, [
        rendererPath,
        `--runtime-output=${runtimeOutput}`,
        `--executor-output=${executorOutput}`,
        `--writer-fence-output=${writerFenceOutput}`,
        `--manifest-output=${manifestOutput}`,
      ], { cwd: root, encoding: "utf8" });
      const cli = JSON.parse(output);
      const manifest = JSON.parse(readFileSync(manifestOutput, "utf8"));

      expect(cli).toMatchObject({
        mode: "fleet-sales-only-live-no-connections",
        connectionsActivated: 0,
        outputs: {
          runtime: runtimeOutput,
          executor: executorOutput,
          writerFence: writerFenceOutput,
          manifest: manifestOutput,
        },
      });
      expect(manifest.jobs).toEqual(["sales.auto-sync", "sales.sync-intraday"]);
      expect(JSON.stringify(manifest)).not.toMatch(/token|password|secret|credential/iu);
      expect(readFileSync(runtimeOutput, "utf8")).toContain(FLEET_SALES_LIVE_CONSUMER_BLOCK);
      expect(readFileSync(executorOutput, "utf8")).not.toContain("[[queues.consumers]]");
      expect(readFileSync(writerFenceOutput, "utf8")).toBe(FLEET_WRITER_FENCE_CONFIG);
      for (const path of [runtimeOutput, executorOutput, writerFenceOutput, manifestOutput]) {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    } finally {
      for (const path of [runtimeOutput, executorOutput, writerFenceOutput, manifestOutput]) {
        rmSync(path, { force: true });
      }
    }
  });
});
