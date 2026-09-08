import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  FleetDeploymentValidationError,
  RESCUE_EXECUTOR_NAME,
  RESCUE_RUNTIME_HYPERDRIVE_ID,
  RESCUE_RUNTIME_NAME,
  validateFleetDeployment,
} from "../../infrastructure/runtime/validate-fleet-deployment.mjs";

const root = resolve(import.meta.dirname, "../..");
const runtimePath = resolve(root, "wrangler.middleware-runtime-fleet.toml");
const executorPath = resolve(root, "wrangler.middleware-runtime-executor-fleet.toml");
const validatorPath = resolve(root, "infrastructure/runtime/validate-fleet-deployment.mjs");
const runtimeSource = readFileSync(runtimePath, "utf8");
const executorSource = readFileSync(executorPath, "utf8");

function errorCode(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(FleetDeploymentValidationError);
    return (error as FleetDeploymentValidationError).code;
  }
}

function validate(runtime = runtimeSource, executor = executorSource) {
  return validateFleetDeployment({ runtimeSource: runtime, executorSource: executor });
}

describe("Cloudflare fleet deployment package", () => {
  it("validates an inert rescue-production runtime and private executor", () => {
    const result = validate();

    expect(result).toMatchObject({
      ok: true,
      environment: "rescue-production",
      phase: "inert-deploy",
      executionEnabled: false,
      activationAllowed: false,
      nextGate: "ADD_EXACTLY_ONE_RESCUE_CONSUMER_SEPARATELY",
      runtime: {
        name: RESCUE_RUNTIME_NAME,
        mode: "fleet-producer",
        lane: "sales-stock",
        producers: 6,
        consumers: 0,
      },
      executor: {
        name: RESCUE_EXECUTOR_NAME,
        mode: "fleet-executor",
        consumers: 0,
        secretBindingsPresent: false,
      },
    });
    expect(runtimeSource).toContain(`id = "${RESCUE_RUNTIME_HYPERDRIVE_ID}"`);
    expect(executorSource).toContain(`id = "${RESCUE_RUNTIME_HYPERDRIVE_ID}"`);
    expect(runtimeSource).not.toContain("[[queues.consumers]]");
    expect(executorSource).not.toContain("[[queues.consumers]]");
  });

  it("runs as a deterministic local-only CLI validator", () => {
    const output = execFileSync(process.execPath, [validatorPath], {
      cwd: root,
      encoding: "utf8",
    });

    expect(output).toContain("FLEET_DEPLOYMENT_INERT_OK");
    expect(output).toContain("environment=rescue-production");
    expect(output).toContain("producers=6 consumers=0 execution=false activation=false");
  });

  it("rejects any initial Queue consumer", () => {
    const withConsumer = `${runtimeSource}\n[[queues.consumers]]\nqueue = "winerim-rescue-prod-sales"\n`;
    expect(errorCode(() => validate(withConsumer))).toBe("FLEET_INITIAL_CONSUMERS_FORBIDDEN");
  });

  it("rejects irrelevant credit or AI configuration", () => {
    const withIrrelevantConfig = `${runtimeSource}\nLOVABLE_AI_CREDITS = "enabled"\n`;
    expect(errorCode(() => validate(withIrrelevantConfig))).toBe(
      "IRRELEVANT_CREDIT_OR_AI_CONFIG_FORBIDDEN",
    );
  });

  it("rejects missing Hyperdrive, executor and Queue bindings", () => {
    const missingRuntimeHyperdrive = runtimeSource.replace(
      `id = "${RESCUE_RUNTIME_HYPERDRIVE_ID}"`,
      "",
    );
    expect(errorCode(() => validate(missingRuntimeHyperdrive))).toBe("RUNTIME_HYPERDRIVE_ID_MISMATCH");

    const missingExecutorService = runtimeSource.replace('binding = "RUNTIME_EXECUTOR"', "");
    expect(errorCode(() => validate(missingExecutorService))).toBe(
      "RUNTIME_EXECUTOR_SERVICE_BINDING_MISSING",
    );

    const missingQueue = runtimeSource.replace('binding = "MIDDLEWARE_CATALOG_QUEUE"', "");
    expect(errorCode(() => validate(missingQueue))).toBe("RUNTIME_QUEUE_BINDINGS_INVALID");
  });

  it("rejects staging, production aliases and any non-rescue environment", () => {
    const wrongRuntimeEnvironment = runtimeSource.replace(
      'ENVIRONMENT = "rescue-production"',
      'ENVIRONMENT = "production"',
    );
    expect(errorCode(() => validate(wrongRuntimeEnvironment))).toBe("RUNTIME_ENVIRONMENT_REJECTED");

    const wrongExecutorEnvironment = executorSource.replace(
      'ENVIRONMENT = "rescue-production"',
      'ENVIRONMENT = "staging"',
    );
    expect(errorCode(() => validate(runtimeSource, wrongExecutorEnvironment))).toBe(
      "EXECUTOR_ENVIRONMENT_REJECTED",
    );
  });

  it("rejects Worker, service and Queue names outside rescue", () => {
    const wrongRuntimeName = runtimeSource.replace(RESCUE_RUNTIME_NAME, "winerim-middleware-runtime");
    expect(errorCode(() => validate(wrongRuntimeName))).toBe("RUNTIME_NAME_NOT_RESCUE");

    const wrongExecutorName = executorSource.replace(
      RESCUE_EXECUTOR_NAME,
      "winerim-middleware-runtime-executor",
    );
    expect(errorCode(() => validate(runtimeSource, wrongExecutorName))).toBe("EXECUTOR_NAME_NOT_RESCUE");

    const wrongQueue = runtimeSource.replace("winerim-rescue-prod-sales", "winerim-staging-sales");
    expect(errorCode(() => validate(wrongQueue))).toBe("RUNTIME_QUEUE_BINDING_NOT_RESCUE");
  });

  it("rejects execution, mutation flags and embedded credentials", () => {
    const enabledRuntime = runtimeSource.replace(
      'RUNTIME_EXECUTION_ENABLED = "false"',
      'RUNTIME_EXECUTION_ENABLED = "true"',
    );
    expect(errorCode(() => validate(enabledRuntime))).toBe("RUNTIME_MUST_START_INERT");

    const enabledExecutor = executorSource.replace(
      'RUNTIME_CATALOG_APPLY_ENABLED = "false"',
      'RUNTIME_CATALOG_APPLY_ENABLED = "true"',
    );
    expect(errorCode(() => validate(runtimeSource, enabledExecutor))).toBe(
      "EXECUTOR_FLAG_MUST_START_DISABLED_RUNTIME_CATALOG_APPLY_ENABLED",
    );

    const embeddedSecret = `${executorSource}\nRUNTIME_VAULT_KEY = "not-allowed"\n`;
    expect(errorCode(() => validate(runtimeSource, embeddedSecret))).toBe(
      "EXECUTOR_EMBEDDED_SECRET_FORBIDDEN",
    );
  });
});
