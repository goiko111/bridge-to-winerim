import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import {
  buildRuntimeSalesDeploymentManifest,
  prepareRuntimeSalesDeploymentManifest,
  validateRuntimeSalesDeploymentManifest,
} from "../../infrastructure/runtime/prepare-runtime-sales-deployment-manifest.mjs";

const WORKERS = {
  runtime: "winerim-middleware-runtime-rescue-prod-fleet",
  executor: "winerim-middleware-runtime-executor-rescue-prod-fleet",
  writerFence: "winerim-middleware-runtime-writer-fence-rescue-prod-fleet",
};

const VERSION_IDS = {
  runtime: "09ddda13-5c42-4af6-a0ca-981105142507",
  executor: "43ec9cff-4f2a-4a1b-bfd5-82f90c7e74d6",
  writerFence: "a66a5155-6126-4ae6-85f6-15f4d947ca91",
};

function sha256(source: Buffer | string) {
  return createHash("sha256").update(source).digest("hex");
}

function deploymentStatus(versionId: string, percentage = 100) {
  return Buffer.from(`${JSON.stringify({
    id: "3143d8a7-351a-40f3-af50-4bba51034228",
    source: "wrangler",
    strategy: "percentage",
    author_email: "operator@example.invalid",
    annotations: { "workers/triggered_by": "deployment" },
    versions: [{ version_id: versionId, percentage }],
    created_on: "2026-08-04T15:41:12.430222Z",
  }, null, 2)}\n`);
}

function toml(workerName: string, suffix: string) {
  return Buffer.from([
    `name = "${workerName}"`,
    `main = "workers/${suffix}.ts"`,
    'compatibility_date = "2026-06-12"',
    "workers_dev = false",
    "",
  ].join("\n"));
}

function sources() {
  const writerFenceToml = Buffer.concat([
    toml(WORKERS.writerFence, "writer-fence"),
    Buffer.from([
      "[[durable_objects.bindings]]",
      'name = "CONNECTION_WRITER_FENCE"',
      'class_name = "ConnectionWriterFence"',
      "",
    ].join("\n")),
  ]);
  return {
    runtimeStatusSource: deploymentStatus(VERSION_IDS.runtime),
    runtimeTomlSource: toml(WORKERS.runtime, "runtime"),
    executorStatusSource: deploymentStatus(VERSION_IDS.executor),
    executorTomlSource: toml(WORKERS.executor, "executor"),
    writerFenceStatusSource: deploymentStatus(VERSION_IDS.writerFence),
    writerFenceTomlSource: writerFenceToml,
  };
}

function writePrivate(directory: string, name: string, source: Buffer) {
  const path = join(directory, name);
  writeFileSync(path, source, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function fileFixture() {
  const directory = mkdtempSync(join(tmpdir(), "runtime-sales-deployment-evidence-"));
  chmodSync(directory, 0o700);
  const evidence = sources();
  return {
    runtimeStatusPath: writePrivate(directory, "runtime.deployments.json", evidence.runtimeStatusSource),
    runtimeTomlPath: writePrivate(directory, "runtime.generated.toml", evidence.runtimeTomlSource),
    executorStatusPath: writePrivate(directory, "executor.deployments.json", evidence.executorStatusSource),
    executorTomlPath: writePrivate(directory, "executor.generated.toml", evidence.executorTomlSource),
    writerFenceStatusPath: writePrivate(
      directory,
      "writer-fence.deployments.json",
      evidence.writerFenceStatusSource,
    ),
    writerFenceTomlPath: writePrivate(directory, "writer-fence.generated.toml", evidence.writerFenceTomlSource),
    outputPath: join(mkdtempSync(join(tmpdir(), "runtime-sales-deployment-output-")), "deployment.manifest.json"),
  };
}

describe("runtime sales deployment manifest tooling", () => {
  it("derives a stable v1 manifest only from real status and TOML bytes", () => {
    const evidence = sources();
    const first = buildRuntimeSalesDeploymentManifest(evidence);
    const second = buildRuntimeSalesDeploymentManifest(evidence);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      version: 1,
      kind: "runtime-sales-deployment",
      deploymentId: expect.stringMatching(/^runtime-sales-[a-f0-9]{24}$/),
      jobs: ["sales.auto-sync", "sales.sync-intraday"],
      components: {
        runtime: {
          workerName: WORKERS.runtime,
          versionId: VERSION_IDS.runtime,
          configSha256: sha256(evidence.runtimeTomlSource),
        },
        executor: {
          workerName: WORKERS.executor,
          versionId: VERSION_IDS.executor,
          configSha256: sha256(evidence.executorTomlSource),
        },
        writerFence: {
          workerName: WORKERS.writerFence,
          versionId: VERSION_IDS.writerFence,
          configSha256: sha256(evidence.writerFenceTomlSource),
        },
      },
    });

    const changedBytes = sources();
    changedBytes.runtimeTomlSource = Buffer.concat([changedBytes.runtimeTomlSource, Buffer.from("# byte drift\n")]);
    const changed = buildRuntimeSalesDeploymentManifest(changedBytes);
    expect(changed.components.runtime.configSha256).not.toBe(first.components.runtime.configSha256);
    expect(changed.deploymentId).not.toBe(first.deploymentId);
  });

  it("writes one atomic 0600 manifest outside the repository", () => {
    const fixture = fileFixture();
    const result = prepareRuntimeSalesDeploymentManifest(fixture);
    const manifestSource = readFileSync(result.manifestPath);
    const manifest = JSON.parse(manifestSource.toString("utf8"));

    expect(result).toMatchObject({
      status: "RUNTIME_SALES_DEPLOYMENT_MANIFEST_READY",
      manifestPath: fixture.outputPath,
      manifestSha256: sha256(manifestSource),
      deploymentId: manifest.deploymentId,
      remoteMutations: 0,
    });
    expect(statSync(result.manifestPath).mode & 0o777).toBe(0o600);
    expect(validateRuntimeSalesDeploymentManifest(manifest)).toEqual(manifest);
  });

  it("rejects split traffic, invalid version IDs and wrong worker names", () => {
    const splitTraffic = sources();
    splitTraffic.runtimeStatusSource = deploymentStatus(VERSION_IDS.runtime, 99);
    expect(() => buildRuntimeSalesDeploymentManifest(splitTraffic)).toThrow(
      "RUNTIME_SALES_DEPLOYMENT_MANIFEST_runtime_ACTIVE_VERSION_NOT_EXACTLY_100_PERCENT",
    );

    const multipleVersions = sources();
    const readback = JSON.parse(multipleVersions.executorStatusSource.toString("utf8"));
    readback.versions.push({ version_id: "11111111-1111-4111-8111-111111111111", percentage: 0 });
    multipleVersions.executorStatusSource = Buffer.from(`${JSON.stringify(readback)}\n`);
    expect(() => buildRuntimeSalesDeploymentManifest(multipleVersions)).toThrow(
      "RUNTIME_SALES_DEPLOYMENT_MANIFEST_INVALID_executor_DEPLOYMENT_STATUS",
    );

    const invalidVersion = sources();
    invalidVersion.writerFenceStatusSource = deploymentStatus("not-a-uuid");
    expect(() => buildRuntimeSalesDeploymentManifest(invalidVersion)).toThrow(
      "RUNTIME_SALES_DEPLOYMENT_MANIFEST_writerFence_ACTIVE_VERSION_NOT_EXACTLY_100_PERCENT",
    );

    const wrongWorker = sources();
    wrongWorker.executorTomlSource = toml("wrong-executor", "executor");
    expect(() => buildRuntimeSalesDeploymentManifest(wrongWorker)).toThrow(
      "RUNTIME_SALES_DEPLOYMENT_MANIFEST_executor_WORKER_NAME_MISMATCH",
    );
  });

  it("rejects job/component drift and a deployment ID not derived from evidence", () => {
    const manifest = JSON.parse(JSON.stringify(buildRuntimeSalesDeploymentManifest(sources())));
    manifest.jobs.push("catalog.sync");
    expect(() => validateRuntimeSalesDeploymentManifest(manifest)).toThrow(
      "RUNTIME_SALES_DEPLOYMENT_MANIFEST_INVALID_MANIFEST_IDENTITY_OR_JOBS",
    );

    const missingComponent = JSON.parse(JSON.stringify(buildRuntimeSalesDeploymentManifest(sources())));
    delete missingComponent.components.executor;
    expect(() => validateRuntimeSalesDeploymentManifest(missingComponent)).toThrow(
      "RUNTIME_SALES_DEPLOYMENT_MANIFEST_INVALID_COMPONENTS_STRUCTURE",
    );

    const manualId = JSON.parse(JSON.stringify(buildRuntimeSalesDeploymentManifest(sources())));
    manualId.deploymentId = "runtime-sales-manual-id";
    expect(() => validateRuntimeSalesDeploymentManifest(manualId)).toThrow(
      "RUNTIME_SALES_DEPLOYMENT_MANIFEST_DEPLOYMENT_ID_NOT_DERIVED_FROM_READBACKS",
    );
  });
});
