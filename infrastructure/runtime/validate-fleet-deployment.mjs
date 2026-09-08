import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RESCUE_RUNTIME_HYPERDRIVE_ID = "bf568eb1d85a41539384f241084c2227";
export const RESCUE_RUNTIME_NAME = "winerim-middleware-runtime-rescue-prod-fleet";
export const RESCUE_EXECUTOR_NAME = "winerim-middleware-runtime-executor-rescue-prod-fleet";

const EXPECTED_RUNTIME_MAIN = "cloudflare/workers/middleware-runtime/src/worker.ts";
const EXPECTED_EXECUTOR_MAIN = "cloudflare/workers/middleware-runtime-executor/src/worker.ts";
const EXPECTED_ENVIRONMENT = "rescue-production";
const EXPECTED_RUNTIME_MODE = "fleet-producer";
const EXPECTED_EXECUTOR_MODE = "fleet-executor";
const EXPECTED_RUNTIME_LANE = "sales-stock";
const EXPECTED_PRODUCERS = Object.freeze(new Map([
  ["MIDDLEWARE_CATALOG_QUEUE", "winerim-rescue-prod-catalog"],
  ["MIDDLEWARE_SALES_STOCK_QUEUE", "winerim-rescue-prod-sales"],
  ["MIDDLEWARE_SALES_IMPORT_QUEUE", "winerim-rescue-prod-sales"],
  ["MIDDLEWARE_STOCK_SYNC_QUEUE", "winerim-rescue-prod-stock"],
  ["MIDDLEWARE_OUTBOUND_QUEUE", "winerim-rescue-prod-outbound"],
  ["MIDDLEWARE_MAINTENANCE_QUEUE", "winerim-rescue-prod-maintenance"],
]));
const EXECUTOR_DISABLED_FLAGS = Object.freeze([
  "RUNTIME_CATALOG_EXECUTION_ENABLED",
  "RUNTIME_CATALOG_FETCH_ENABLED",
  "RUNTIME_CATALOG_APPLY_ENABLED",
  "RUNTIME_SALES_EXECUTION_ENABLED",
  "RUNTIME_SALES_CURSOR_ENABLED",
  "RUNTIME_SALES_DLQ_READY",
  "RUNTIME_OUTBOUND_EXECUTION_ENABLED",
  "RUNTIME_OUTBOUND_MUTATION_ENABLED",
]);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultRuntimePath = resolve(repoRoot, "wrangler.middleware-runtime-fleet.toml");
const defaultExecutorPath = resolve(repoRoot, "wrangler.middleware-runtime-executor-fleet.toml");

export class FleetDeploymentValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "FleetDeploymentValidationError";
    this.code = code;
  }
}

function fail(code) {
  throw new FleetDeploymentValidationError(code);
}

function uncommented(source) {
  return source
    .split(/\r?\n/u)
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");
}

function assignment(source, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return source.match(new RegExp(`^\\s*${escaped}\\s*=\\s*"([^"]*)"\\s*$`, "mu"))?.[1] ?? null;
}

function tableBlocks(source, tableName) {
  const marker = `[[${tableName}]]`;
  const starts = [];
  let cursor = 0;
  while (true) {
    const start = source.indexOf(marker, cursor);
    if (start === -1) break;
    starts.push(start);
    cursor = start + marker.length;
  }
  return starts.map((start, index) => {
    const next = source.indexOf("\n[", start + marker.length);
    const following = starts[index + 1] ?? source.length;
    const end = next === -1 ? source.length : Math.min(next + 1, following);
    return source.slice(start, end);
  });
}

function requireAssignment(source, key, expected, code) {
  if (assignment(source, key) !== expected) fail(code);
}

function rejectUnsafeSurface(source, component) {
  if (/\[\[?queues\.consumers\]?\]/u.test(source)) fail("FLEET_INITIAL_CONSUMERS_FORBIDDEN");
  if (/^\s*(?:routes?|route)\s*=/mu.test(source) || /\[\[?routes?\]?\]/u.test(source)) {
    fail(`${component}_PUBLIC_ROUTE_FORBIDDEN`);
  }
  if (/^\s*workers_dev\s*=\s*true\s*$/mu.test(source)) fail(`${component}_WORKERS_DEV_FORBIDDEN`);
  if (/^\s*preview_urls\s*=\s*true\s*$/mu.test(source)) fail(`${component}_PREVIEW_URL_FORBIDDEN`);
  if (/(?:lovable|openai|anthropic|ai[_ -]?(?:generation|prompt|assistant)|cr[eé]ditos?|credits?)/iu.test(source)) {
    fail("IRRELEVANT_CREDIT_OR_AI_CONFIG_FORBIDDEN");
  }
  if (/^\s*(?:DATABASE_URL|SUPABASE_ACCESS_TOKEN|API_TOKEN|RUNTIME_VAULT_KEY|RUNTIME_FLEET_WRITER_FENCE_BUNDLE)\s*=/mu.test(source)) {
    fail(`${component}_EMBEDDED_SECRET_FORBIDDEN`);
  }
}

function validateHyperdrive(source, component) {
  const blocks = tableBlocks(source, "hyperdrive");
  if (blocks.length !== 1) fail(`${component}_HYPERDRIVE_BINDING_MISSING`);
  requireAssignment(blocks[0], "binding", "MIDDLEWARE_DB", `${component}_HYPERDRIVE_BINDING_MISSING`);
  requireAssignment(blocks[0], "id", RESCUE_RUNTIME_HYPERDRIVE_ID, `${component}_HYPERDRIVE_ID_MISMATCH`);
}

function validateRuntime(source) {
  const clean = uncommented(source);
  rejectUnsafeSurface(clean, "RUNTIME");
  requireAssignment(clean, "name", RESCUE_RUNTIME_NAME, "RUNTIME_NAME_NOT_RESCUE");
  requireAssignment(clean, "main", EXPECTED_RUNTIME_MAIN, "RUNTIME_MAIN_MISMATCH");
  requireAssignment(clean, "ENVIRONMENT", EXPECTED_ENVIRONMENT, "RUNTIME_ENVIRONMENT_REJECTED");
  requireAssignment(clean, "RUNTIME_MODE", EXPECTED_RUNTIME_MODE, "RUNTIME_MODE_REJECTED");
  requireAssignment(clean, "RUNTIME_EXECUTION_ENABLED", "false", "RUNTIME_MUST_START_INERT");
  requireAssignment(clean, "FLEET_RUNTIME_LANE", EXPECTED_RUNTIME_LANE, "RUNTIME_FLEET_LANE_REJECTED");
  validateHyperdrive(clean, "RUNTIME");

  const serviceBlocks = tableBlocks(clean, "services");
  const executorService = serviceBlocks.find((block) => assignment(block, "binding") === "RUNTIME_EXECUTOR");
  if (!executorService) fail("RUNTIME_EXECUTOR_SERVICE_BINDING_MISSING");
  requireAssignment(
    executorService,
    "service",
    RESCUE_EXECUTOR_NAME,
    "RUNTIME_EXECUTOR_SERVICE_NOT_RESCUE",
  );
  if (serviceBlocks.length !== 1) fail("RUNTIME_UNEXPECTED_SERVICE_BINDING");

  const producerBlocks = tableBlocks(clean, "queues.producers");
  if (producerBlocks.length !== EXPECTED_PRODUCERS.size) fail("RUNTIME_QUEUE_BINDINGS_INCOMPLETE");
  const observed = new Map();
  for (const block of producerBlocks) {
    const binding = assignment(block, "binding");
    const queue = assignment(block, "queue");
    if (!binding || !queue || observed.has(binding)) fail("RUNTIME_QUEUE_BINDINGS_INVALID");
    observed.set(binding, queue);
  }
  for (const [binding, queue] of EXPECTED_PRODUCERS) {
    if (observed.get(binding) !== queue) fail("RUNTIME_QUEUE_BINDING_NOT_RESCUE");
  }
  if ([...observed.keys()].some((binding) => !EXPECTED_PRODUCERS.has(binding))) {
    fail("RUNTIME_UNEXPECTED_QUEUE_BINDING");
  }
  if (!/^\s*crons\s*=\s*\["\*\/5 \* \* \* \*"\]\s*$/mu.test(clean)) {
    fail("RUNTIME_FIVE_MINUTE_TRIGGER_MISSING");
  }
  return Object.freeze({
    name: RESCUE_RUNTIME_NAME,
    mode: EXPECTED_RUNTIME_MODE,
    lane: EXPECTED_RUNTIME_LANE,
    producers: producerBlocks.length,
    consumers: 0,
  });
}

function validateExecutor(source) {
  const clean = uncommented(source);
  rejectUnsafeSurface(clean, "EXECUTOR");
  requireAssignment(clean, "name", RESCUE_EXECUTOR_NAME, "EXECUTOR_NAME_NOT_RESCUE");
  requireAssignment(clean, "main", EXPECTED_EXECUTOR_MAIN, "EXECUTOR_MAIN_MISMATCH");
  requireAssignment(clean, "ENVIRONMENT", EXPECTED_ENVIRONMENT, "EXECUTOR_ENVIRONMENT_REJECTED");
  requireAssignment(clean, "RUNTIME_MODE", EXPECTED_EXECUTOR_MODE, "EXECUTOR_MODE_REJECTED");
  requireAssignment(clean, "RUNTIME_EXECUTION_ENABLED", "false", "EXECUTOR_MUST_START_INERT");
  requireAssignment(clean, "RUNTIME_VAULT_KEY_VERSION", "v1", "EXECUTOR_VAULT_VERSION_MISSING");
  requireAssignment(clean, "WINERIM_API_BASE_URL", "https://app.winerim.com", "EXECUTOR_WINERIM_TARGET_REJECTED");
  requireAssignment(clean, "WINERIM_ALLOWED_HOSTS", "app.winerim.com", "EXECUTOR_WINERIM_HOST_REJECTED");
  for (const flag of EXECUTOR_DISABLED_FLAGS) {
    requireAssignment(clean, flag, "false", `EXECUTOR_FLAG_MUST_START_DISABLED_${flag}`);
  }
  validateHyperdrive(clean, "EXECUTOR");
  if (tableBlocks(clean, "queues.producers").length > 0) fail("EXECUTOR_QUEUE_PRODUCER_FORBIDDEN");
  if (tableBlocks(clean, "services").length > 0) fail("EXECUTOR_UNREVIEWED_SERVICE_BINDING_FORBIDDEN");
  return Object.freeze({
    name: RESCUE_EXECUTOR_NAME,
    mode: EXPECTED_EXECUTOR_MODE,
    consumers: 0,
    secretBindingsPresent: false,
  });
}

export function validateFleetDeployment({ runtimeSource, executorSource }) {
  if (typeof runtimeSource !== "string" || typeof executorSource !== "string") {
    fail("FLEET_CONFIG_SOURCE_REQUIRED");
  }
  const runtime = validateRuntime(runtimeSource);
  const executor = validateExecutor(executorSource);
  return Object.freeze({
    ok: true,
    environment: EXPECTED_ENVIRONMENT,
    phase: "inert-deploy",
    executionEnabled: false,
    activationAllowed: false,
    nextGate: "ADD_EXACTLY_ONE_RESCUE_CONSUMER_SEPARATELY",
    runtime,
    executor,
  });
}

function parseCli(argv) {
  const options = {
    runtimePath: defaultRuntimePath,
    executorPath: defaultExecutorPath,
    json: false,
  };
  for (const argument of argv) {
    if (argument === "--json") options.json = true;
    else if (argument.startsWith("--runtime=")) options.runtimePath = resolve(argument.slice(10));
    else if (argument.startsWith("--executor=")) options.executorPath = resolve(argument.slice(11));
    else fail("FLEET_VALIDATOR_ARGUMENT_REJECTED");
  }
  return options;
}

function main() {
  const options = parseCli(process.argv.slice(2));
  const result = validateFleetDeployment({
    runtimeSource: readFileSync(options.runtimePath, "utf8"),
    executorSource: readFileSync(options.executorPath, "utf8"),
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `FLEET_DEPLOYMENT_INERT_OK environment=${result.environment} runtime=${result.runtime.name} `
      + `executor=${result.executor.name} producers=${result.runtime.producers} consumers=0 `
      + `execution=false activation=false next_gate=${result.nextGate}\n`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
