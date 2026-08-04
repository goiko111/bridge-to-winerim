import { readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  FLEET_FULL_EXECUTOR_NAME,
  FLEET_FULL_LANES,
  FLEET_FULL_RATE_LIMITER_SERVICE,
  FLEET_FULL_TEMPLATE_SHA256,
  FleetFullLiveRenderError,
  readFleetFullTemplates,
  renderFleetFullInactiveConfigs,
  validateFleetFullInactiveConfigs,
  writeFleetFullInactivePackage,
} from "../../infrastructure/runtime/fleet-full-live-render-config.mjs";

const SOURCE_COMMIT = "1234567890abcdef1234567890abcdef12345678";
const root = resolve(import.meta.dirname, "../..");

function errorCode(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(FleetFullLiveRenderError);
    return (error as FleetFullLiveRenderError).code;
  }
}

function render() {
  return renderFleetFullInactiveConfigs({
    templates: readFleetFullTemplates(),
    sourceCommit: SOURCE_COMMIT,
    expectedCommit: SOURCE_COMMIT,
    sourceTreeClean: true,
  });
}

describe("full fleet inactive render package", () => {
  it("renders three isolated lanes, one executor and one Durable Object limiter inactive", () => {
    const result = render();

    expect(result.manifest).toMatchObject({
      schemaVersion: 1,
      mode: "fleet-full-inactive-no-connections",
      source: { commit: SOURCE_COMMIT, clean: true },
      executionEnabled: false,
      activationAllowed: false,
      connectionsActivated: 0,
      components: {
        catalog: { entryPoint: "cloudflare/workers/middleware-runtime/src/worker.ts" },
        salesStock: { entryPoint: "cloudflare/workers/middleware-runtime/src/worker.ts" },
        outbound: { entryPoint: "cloudflare/workers/middleware-runtime/src/worker.ts" },
        executor: {
          name: FLEET_FULL_EXECUTOR_NAME,
          entryPoint: "cloudflare/workers/middleware-runtime-executor/src/worker.ts",
        },
        rateLimiter: {
          name: FLEET_FULL_RATE_LIMITER_SERVICE,
          entryPoint: "cloudflare/workers/middleware-outbound-rate-limiter/src/worker.ts",
        },
      },
      nextGate: "CAPTURE_BASELINES_THEN_SEPARATE_REVIEWED_ACTIVATION",
    });
    expect(result.manifest.components).toMatchObject({
      catalog: { templateSha256: FLEET_FULL_TEMPLATE_SHA256.catalog },
      salesStock: { templateSha256: FLEET_FULL_TEMPLATE_SHA256.salesStock },
      outbound: { templateSha256: FLEET_FULL_TEMPLATE_SHA256.outbound },
      executor: { templateSha256: FLEET_FULL_TEMPLATE_SHA256.executor },
      rateLimiter: { templateSha256: FLEET_FULL_TEMPLATE_SHA256.rateLimiter },
    });

    for (const source of Object.values(result.rendered)) {
      expect(source).not.toContain("__SOURCE_COMMIT_SHA__");
      expect(source).not.toContain("[[queues.consumers]]");
      expect(source).not.toMatch(/^\s*(?:route|routes)\s*=/mu);
      expect(source).not.toContain('workers_dev = true');
      expect(source).not.toContain('preview_urls = true');
    }
    for (const key of ["catalog", "salesStock", "outbound"] as const) {
      expect(result.rendered[key]).toContain('RUNTIME_EXECUTION_ENABLED = "false"');
      expect(result.rendered[key]).toContain(`FLEET_RUNTIME_LANE = "${FLEET_FULL_LANES[key].lane}"`);
      expect(result.rendered[key]).toContain(`binding = "${FLEET_FULL_LANES[key].queueBinding}"`);
      expect(result.rendered[key]).toContain(`queue = "${FLEET_FULL_LANES[key].queue}"`);
    }
    expect(result.rendered.executor.match(/RUNTIME_\w+_ENABLED = "true"/gu)).toBeNull();
    expect(result.rendered.executor).toContain('binding = "WRITER_FENCE"');
    expect(result.rendered.executor).toContain('binding = "OUTBOUND_RATE_LIMITER"');
    expect(result.rendered.rateLimiter).toContain('class_name = "OutboundRateLimiter"');
  });

  it("keeps Queue and DLQ contracts unique and bounded without binding consumers yet", () => {
    const { manifest } = render();
    const lanes = Object.values(manifest.lanes);

    expect(new Set(lanes.map((lane) => lane.queue)).size).toBe(3);
    expect(new Set(lanes.map((lane) => lane.deadLetterQueue)).size).toBe(3);
    for (const lane of lanes) {
      expect(lane).toMatchObject({
        maxBatchSize: 1,
        maxBatchTimeout: 5,
        maxRetries: 3,
        maxConcurrency: 1,
        consumerPresent: false,
      });
      expect(lane.deadLetterQueue).not.toBe(lane.queue);
      expect(lane.consumerToml).toContain(`queue = "${lane.queue}"`);
      expect(lane.consumerToml).toContain(`dead_letter_queue = "${lane.deadLetterQueue}"`);
    }
  });

  it("fails closed on dirty, missing or mismatched source provenance", () => {
    const templates = readFleetFullTemplates();
    const base = { templates, sourceCommit: SOURCE_COMMIT, expectedCommit: SOURCE_COMMIT };

    expect(errorCode(() => renderFleetFullInactiveConfigs({
      ...base,
      sourceTreeClean: false,
    }))).toBe("SOURCE_TREE_DIRTY");
    expect(errorCode(() => renderFleetFullInactiveConfigs({
      ...base,
      expectedCommit: null,
      sourceTreeClean: true,
    }))).toBe("EXPECTED_SOURCE_COMMIT_REQUIRED");
    expect(errorCode(() => renderFleetFullInactiveConfigs({
      ...base,
      expectedCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sourceTreeClean: true,
    }))).toBe("SOURCE_COMMIT_MISMATCH");
  });

  it("rejects template drift and any mutation after rendering", () => {
    const templates = readFleetFullTemplates();
    const changedTemplates = {
      ...templates,
      catalog: templates.catalog.replace('RUNTIME_EXECUTION_ENABLED = "false"', 'RUNTIME_EXECUTION_ENABLED = "true"'),
    };
    expect(errorCode(() => renderFleetFullInactiveConfigs({
      templates: changedTemplates,
      sourceCommit: SOURCE_COMMIT,
      expectedCommit: SOURCE_COMMIT,
      sourceTreeClean: true,
    }))).toBe("TEMPLATE_SHA256_DRIFT_catalog");

    const result = render();
    const rendered = {
      ...result.rendered,
      outbound: `${result.rendered.outbound}\n[[queues.consumers]]\nqueue = "unexpected"\n`,
    };
    expect(errorCode(() => validateFleetFullInactiveConfigs({
      templates,
      rendered,
      sourceCommit: SOURCE_COMMIT,
      expectedCommit: SOURCE_COMMIT,
      sourceTreeClean: true,
    }))).toBe("RENDERED_UNRELATED_CHANGE_outbound");
  });

  it("writes private configs and a rollback manifest with rendered hashes", () => {
    const outputDir = resolve(tmpdir(), `winerim-fleet-full-${process.pid}`);
    rmSync(outputDir, { force: true, recursive: true });
    try {
      const result = render();
      const written = writeFleetFullInactivePackage({ outputDir, result });
      const manifest = JSON.parse(readFileSync(written.manifestPath, "utf8"));

      expect(manifest.rollback).toMatchObject({
        baselineDeploymentIds: null,
        automaticRollbackAllowed: false,
        sourceCommit: SOURCE_COMMIT,
      });
      expect(manifest.rollback.requiredBeforeDeploy).toContain(
        "capture-current-deployment-id-for-each-component",
      );
      for (const [key, path] of Object.entries(written.outputs)) {
        expect(readFileSync(path, "utf8")).toBe(result.rendered[key as keyof typeof result.rendered]);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        const operation = manifest.operations[key];
        expect(operation.workingDirectory).toBe(root);
        expect(operation.configPath).toBe(path);
        expect(operation.dryRunCommand.slice(0, 4)).toEqual([
          "npx",
          "wrangler",
          "deploy",
          operation.entryPoint,
        ]);
        expect(operation.dryRunCommand.slice(4, 6)).toEqual(["--config", path]);
        expect(operation.dryRunCommand).toContain("--dry-run");
        expect(operation.deployCommand).toEqual([
          "npx",
          "wrangler",
          "deploy",
          operation.entryPoint,
          "--config",
          path,
        ]);
        expect(statSync(resolve(root, operation.entryPoint)).isFile()).toBe(true);
      }
      expect(statSync(written.manifestPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(outputDir, { force: true, recursive: true });
    }
  });
});
