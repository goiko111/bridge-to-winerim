import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RESCUE_EXECUTOR_NAME,
  RESCUE_RUNTIME_HYPERDRIVE_ID,
  RESCUE_RUNTIME_NAME,
  validateFleetDeployment,
} from "./validate-fleet-deployment.mjs";

export const FLEET_SALES_LIVE_JOBS = Object.freeze([
  "sales.auto-sync",
  "sales.sync-intraday",
]);
export const FLEET_SALES_LIVE_QUEUE = "winerim-rescue-prod-sales";
export const FLEET_SALES_LIVE_DLQ = "winerim-rescue-prod-dead-letter";
export const FLEET_WRITER_FENCE_SERVICE =
  "winerim-middleware-runtime-writer-fence-rescue-prod-fleet";
export const FLEET_SECRETS_STORE_ID = "40a78272a3d044038359c6c7e15ea52e";
export const FLEET_VAULT_SECRET_NAME = "winerim-rescue-prod-vault-key-v1";
export const FLEET_WRITER_FENCE_BUNDLE_SECRET_NAME =
  "winerim-rescue-prod-fleet-writer-fence-bundle-v1";
export const FLEET_SALES_LIVE_BASE_RUNTIME_SHA256 =
  "892ce9c61bb390b624a609dd9603d48a7b4572f4c83fad79e79cd39b502c8c76";
export const FLEET_SALES_LIVE_BASE_EXECUTOR_SHA256 =
  "46dcfb2ff630e262c0bab240a2a163bcf607f37ac3693529a06df4900ebf672d";

export const FLEET_SALES_LIVE_CONSUMER_BLOCK = `[[queues.consumers]]
queue = "${FLEET_SALES_LIVE_QUEUE}"
max_batch_size = 1
max_batch_timeout = 5
max_retries = 3
max_concurrency = 1
dead_letter_queue = "${FLEET_SALES_LIVE_DLQ}"`;

export const FLEET_EXECUTOR_PRIVATE_BINDINGS_BLOCK = `[[secrets_store_secrets]]
binding = "RUNTIME_VAULT_KEY"
store_id = "${FLEET_SECRETS_STORE_ID}"
secret_name = "${FLEET_VAULT_SECRET_NAME}"

[[secrets_store_secrets]]
binding = "RUNTIME_FLEET_WRITER_FENCE_BUNDLE"
store_id = "${FLEET_SECRETS_STORE_ID}"
secret_name = "${FLEET_WRITER_FENCE_BUNDLE_SECRET_NAME}"

[[services]]
binding = "WRITER_FENCE"
service = "${FLEET_WRITER_FENCE_SERVICE}"`;

export const FLEET_WRITER_FENCE_CONFIG = `name = "${FLEET_WRITER_FENCE_SERVICE}"
main = "cloudflare/canary-failclosed/src/writerFenceWorker.ts"
compatibility_date = "2026-06-12"
compatibility_flags = ["nodejs_compat"]
workers_dev = false
preview_urls = false

[[hyperdrive]]
binding = "MIDDLEWARE_DB"
id = "${RESCUE_RUNTIME_HYPERDRIVE_ID}"

[[durable_objects.bindings]]
name = "CONNECTION_WRITER_FENCE"
class_name = "ConnectionWriterFence"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ConnectionWriterFence"]
`;

const EXECUTION_DISABLED = 'RUNTIME_EXECUTION_ENABLED = "false"';
const EXECUTION_ENABLED = 'RUNTIME_EXECUTION_ENABLED = "true"';
const INERT_EXECUTOR_BINDINGS_COMMENT = `# RUNTIME_VAULT_KEY, RUNTIME_FLEET_WRITER_FENCE_BUNDLE and WRITER_FENCE are
# intentionally absent. They are injected only by the separate activation
# gate; without them, and with execution disabled, the executor is fail-closed.`;
const LIVE_EXECUTOR_BINDINGS_COMMENT = `# Private vault, scoped writer-fence bundle and writer-fence service bindings.
# They remain fail-closed until a matching active connection scope exists.`;
const INERT_RUNTIME_CONSUMER_COMMENT = `# Intentionally no Queue consumer. The reviewed consumer gate must add exactly
# one rescue Queue and its winerim-rescue-prod-dead-letter binding separately.`;
const LIVE_RUNTIME_CONSUMER_COMMENT = `# One bounded sales consumer. With no active connection scopes it cannot enqueue
# or execute connection work; catalog, outbound and maintenance remain disabled.`;
const EXECUTOR_SALES_SWITCHES = Object.freeze([
  "RUNTIME_SALES_EXECUTION_ENABLED",
  "RUNTIME_SALES_CURSOR_ENABLED",
  "RUNTIME_SALES_DLQ_READY",
]);
const EXPECTED_CRON = 'crons = ["*/5 * * * *"]';
const EXPECTED_PRODUCERS = Object.freeze(new Map([
  ["MIDDLEWARE_CATALOG_QUEUE", "winerim-rescue-prod-catalog"],
  ["MIDDLEWARE_SALES_STOCK_QUEUE", FLEET_SALES_LIVE_QUEUE],
  ["MIDDLEWARE_SALES_IMPORT_QUEUE", FLEET_SALES_LIVE_QUEUE],
  ["MIDDLEWARE_STOCK_SYNC_QUEUE", "winerim-rescue-prod-stock"],
  ["MIDDLEWARE_OUTBOUND_QUEUE", "winerim-rescue-prod-outbound"],
  ["MIDDLEWARE_MAINTENANCE_QUEUE", "winerim-rescue-prod-maintenance"],
]));

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultRuntimePath = resolve(repoRoot, "wrangler.middleware-runtime-fleet.toml");
const defaultExecutorPath = resolve(repoRoot, "wrangler.middleware-runtime-executor-fleet.toml");
const defaultRuntimeOutputPath = "/tmp/winerim-middleware-runtime-fleet-sales-live.toml";
const defaultExecutorOutputPath = "/tmp/winerim-middleware-runtime-executor-fleet-sales-live.toml";
const defaultWriterFenceOutputPath = "/tmp/winerim-middleware-runtime-writer-fence-fleet.toml";
const defaultManifestOutputPath = "/tmp/winerim-middleware-fleet-sales-live-manifest.json";

export class FleetSalesLiveRenderError extends Error {
  constructor(code) {
    super(code);
    this.name = "FleetSalesLiveRenderError";
    this.code = code;
  }
}

function fail(code) {
  throw new FleetSalesLiveRenderError(code);
}

function sha256(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function occurrences(source, value) {
  return source.split(value).length - 1;
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
  return starts.map((start) => {
    const next = source.indexOf("\n[", start + marker.length);
    return source.slice(start, next === -1 ? source.length : next + 1);
  });
}

function normalizeBlock(source) {
  return source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join("\n");
}

function replaceExecutionFlag(source, component) {
  if (occurrences(source, EXECUTION_DISABLED) !== 1) {
    fail(`${component}_EXECUTION_FLAG_NOT_EXACTLY_ONE_INERT`);
  }
  if (occurrences(source, EXECUTION_ENABLED) !== 0) {
    fail(`${component}_EXECUTION_ALREADY_ENABLED`);
  }
  return source.replace(EXECUTION_DISABLED, EXECUTION_ENABLED);
}

function enableExecutorSalesSwitches(source) {
  let rendered = replaceExecutionFlag(source, "EXECUTOR");
  for (const key of EXECUTOR_SALES_SWITCHES) {
    const disabled = `${key} = "false"`;
    const enabled = `${key} = "true"`;
    if (occurrences(rendered, disabled) !== 1 || occurrences(rendered, enabled) !== 0) {
      fail(`EXECUTOR_${key}_NOT_EXACTLY_ONE_INERT`);
    }
    rendered = rendered.replace(disabled, enabled);
  }
  return rendered;
}

function replaceOperationalComment(source, current, replacement, label) {
  if (occurrences(source, current) !== 1 || occurrences(source, replacement) !== 0) {
    fail(`${label}_COMMENT_DRIFT`);
  }
  return source.replace(current, replacement);
}

function describeLiveRuntime(source) {
  return replaceOperationalComment(
    source,
    INERT_RUNTIME_CONSUMER_COMMENT,
    LIVE_RUNTIME_CONSUMER_COMMENT,
    "RUNTIME_CONSUMER",
  );
}

function describeLiveExecutor(source) {
  return replaceOperationalComment(
    source,
    INERT_EXECUTOR_BINDINGS_COMMENT,
    LIVE_EXECUTOR_BINDINGS_COMMENT,
    "EXECUTOR_PRIVATE_BINDINGS",
  );
}

function appendSalesConsumer(source) {
  if (tableBlocks(source, "queues.consumers").length !== 0) {
    fail("RUNTIME_BASE_CONSUMER_FORBIDDEN");
  }
  return `${source.endsWith("\n") ? source : `${source}\n`}\n${FLEET_SALES_LIVE_CONSUMER_BLOCK}\n`;
}

function appendExecutorPrivateBindings(source) {
  if (
    tableBlocks(source, "secrets_store_secrets").length !== 0
    || tableBlocks(source, "services").length !== 0
  ) {
    fail("EXECUTOR_BASE_PRIVATE_BINDINGS_FORBIDDEN");
  }
  return `${source.endsWith("\n") ? source : `${source}\n`}\n${FLEET_EXECUTOR_PRIVATE_BINDINGS_BLOCK}\n`;
}

function validateCanonicalBase(runtimeSource, executorSource) {
  try {
    validateFleetDeployment({ runtimeSource, executorSource });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "UNKNOWN";
    fail(`FLEET_SALES_LIVE_BASE_INVALID_${code}`);
  }
  if (sha256(runtimeSource) !== FLEET_SALES_LIVE_BASE_RUNTIME_SHA256) {
    fail("RUNTIME_BASE_SHA256_DRIFT");
  }
  if (sha256(executorSource) !== FLEET_SALES_LIVE_BASE_EXECUTOR_SHA256) {
    fail("EXECUTOR_BASE_SHA256_DRIFT");
  }
}

function validateRuntimeBindings(source) {
  if (assignment(source, "name") !== RESCUE_RUNTIME_NAME) fail("RUNTIME_NAME_DRIFT");
  if (assignment(source, "RUNTIME_EXECUTION_ENABLED") !== "true") {
    fail("RUNTIME_EXECUTION_NOT_ENABLED");
  }

  const hyperdrive = tableBlocks(source, "hyperdrive");
  if (
    hyperdrive.length !== 1
    || assignment(hyperdrive[0], "binding") !== "MIDDLEWARE_DB"
    || assignment(hyperdrive[0], "id") !== RESCUE_RUNTIME_HYPERDRIVE_ID
  ) {
    fail("RUNTIME_HYPERDRIVE_DRIFT");
  }

  const services = tableBlocks(source, "services");
  if (
    services.length !== 1
    || assignment(services[0], "binding") !== "RUNTIME_EXECUTOR"
    || assignment(services[0], "service") !== RESCUE_EXECUTOR_NAME
  ) {
    fail("RUNTIME_EXECUTOR_SERVICE_DRIFT");
  }
  if (occurrences(source, EXPECTED_CRON) !== 1) fail("RUNTIME_CRON_DRIFT");

  const producers = tableBlocks(source, "queues.producers");
  if (producers.length !== EXPECTED_PRODUCERS.size) fail("RUNTIME_PRODUCER_COUNT_DRIFT");
  const observed = new Map();
  for (const block of producers) {
    const binding = assignment(block, "binding");
    const queue = assignment(block, "queue");
    if (!binding || !queue || observed.has(binding)) fail("RUNTIME_PRODUCER_BINDING_DRIFT");
    observed.set(binding, queue);
  }
  for (const [binding, queue] of EXPECTED_PRODUCERS) {
    if (observed.get(binding) !== queue) fail("RUNTIME_PRODUCER_BINDING_DRIFT");
  }

  const consumers = tableBlocks(source, "queues.consumers");
  if (consumers.length !== 1) fail("RUNTIME_CONSUMER_COUNT_MUST_BE_ONE");
  if (normalizeBlock(consumers[0]) !== normalizeBlock(FLEET_SALES_LIVE_CONSUMER_BLOCK)) {
    fail("RUNTIME_SALES_CONSUMER_CONTRACT_DRIFT");
  }
}

function validateExecutorBindings(source) {
  if (assignment(source, "name") !== RESCUE_EXECUTOR_NAME) fail("EXECUTOR_NAME_DRIFT");
  if (assignment(source, "RUNTIME_EXECUTION_ENABLED") !== "true") {
    fail("EXECUTOR_EXECUTION_NOT_ENABLED");
  }
  for (const key of EXECUTOR_SALES_SWITCHES) {
    if (assignment(source, key) !== "true") fail(`EXECUTOR_${key}_NOT_ENABLED`);
  }
  for (const key of [
    "RUNTIME_CATALOG_EXECUTION_ENABLED",
    "RUNTIME_CATALOG_FETCH_ENABLED",
    "RUNTIME_CATALOG_APPLY_ENABLED",
    "RUNTIME_OUTBOUND_EXECUTION_ENABLED",
    "RUNTIME_OUTBOUND_MUTATION_ENABLED",
  ]) {
    if (assignment(source, key) !== "false") fail(`EXECUTOR_${key}_MUST_REMAIN_DISABLED`);
  }
  const hyperdrive = tableBlocks(source, "hyperdrive");
  if (
    hyperdrive.length !== 1
    || assignment(hyperdrive[0], "binding") !== "MIDDLEWARE_DB"
    || assignment(hyperdrive[0], "id") !== RESCUE_RUNTIME_HYPERDRIVE_ID
  ) {
    fail("EXECUTOR_HYPERDRIVE_DRIFT");
  }
  if (tableBlocks(source, "queues.consumers").length !== 0) {
    fail("EXECUTOR_CONSUMER_FORBIDDEN");
  }
  if (tableBlocks(source, "queues.producers").length !== 0) {
    fail("EXECUTOR_PRODUCER_FORBIDDEN");
  }
  const secrets = tableBlocks(source, "secrets_store_secrets");
  if (secrets.length !== 2) fail("EXECUTOR_SECRET_BINDING_COUNT_DRIFT");
  const observedSecrets = new Map(secrets.map((block) => [
    assignment(block, "binding"),
    { storeId: assignment(block, "store_id"), secretName: assignment(block, "secret_name") },
  ]));
  if (
    observedSecrets.get("RUNTIME_VAULT_KEY")?.storeId !== FLEET_SECRETS_STORE_ID
    || observedSecrets.get("RUNTIME_VAULT_KEY")?.secretName !== FLEET_VAULT_SECRET_NAME
    || observedSecrets.get("RUNTIME_FLEET_WRITER_FENCE_BUNDLE")?.storeId
      !== FLEET_SECRETS_STORE_ID
    || observedSecrets.get("RUNTIME_FLEET_WRITER_FENCE_BUNDLE")?.secretName
      !== FLEET_WRITER_FENCE_BUNDLE_SECRET_NAME
  ) {
    fail("EXECUTOR_SECRET_BINDING_DRIFT");
  }
  const services = tableBlocks(source, "services");
  if (
    services.length !== 1
    || assignment(services[0], "binding") !== "WRITER_FENCE"
    || assignment(services[0], "service") !== FLEET_WRITER_FENCE_SERVICE
  ) {
    fail("EXECUTOR_WRITER_FENCE_SERVICE_DRIFT");
  }
}

function validateWriterFenceConfig(source) {
  if (source !== FLEET_WRITER_FENCE_CONFIG) fail("WRITER_FENCE_UNRELATED_CHANGE_DETECTED");
  if (assignment(source, "name") !== FLEET_WRITER_FENCE_SERVICE) fail("WRITER_FENCE_NAME_DRIFT");
  const hyperdrive = tableBlocks(source, "hyperdrive");
  if (
    hyperdrive.length !== 1
    || assignment(hyperdrive[0], "binding") !== "MIDDLEWARE_DB"
    || assignment(hyperdrive[0], "id") !== RESCUE_RUNTIME_HYPERDRIVE_ID
  ) {
    fail("WRITER_FENCE_HYPERDRIVE_DRIFT");
  }
  if (tableBlocks(source, "secrets_store_secrets").length !== 0) {
    fail("WRITER_FENCE_GLOBAL_GRANT_FORBIDDEN");
  }
  const durable = tableBlocks(source, "durable_objects.bindings");
  if (
    durable.length !== 1
    || assignment(durable[0], "name") !== "CONNECTION_WRITER_FENCE"
    || assignment(durable[0], "class_name") !== "ConnectionWriterFence"
  ) {
    fail("WRITER_FENCE_DURABLE_BINDING_DRIFT");
  }
}

export function validateFleetSalesLiveConfigs({
  baseRuntimeSource,
  baseExecutorSource,
  renderedRuntimeSource,
  renderedExecutorSource,
  renderedWriterFenceSource,
}) {
  if (
    typeof baseRuntimeSource !== "string"
    || typeof baseExecutorSource !== "string"
    || typeof renderedRuntimeSource !== "string"
    || typeof renderedExecutorSource !== "string"
    || typeof renderedWriterFenceSource !== "string"
  ) {
    fail("FLEET_SALES_LIVE_CONFIG_SOURCES_REQUIRED");
  }
  validateCanonicalBase(baseRuntimeSource, baseExecutorSource);

  const expectedRuntime = appendSalesConsumer(describeLiveRuntime(
    replaceExecutionFlag(baseRuntimeSource, "RUNTIME"),
  ));
  const expectedExecutor = appendExecutorPrivateBindings(describeLiveExecutor(
    enableExecutorSalesSwitches(baseExecutorSource),
  ));
  if (renderedRuntimeSource !== expectedRuntime) fail("RUNTIME_UNRELATED_CHANGE_DETECTED");
  if (renderedExecutorSource !== expectedExecutor) fail("EXECUTOR_UNRELATED_CHANGE_DETECTED");

  validateRuntimeBindings(renderedRuntimeSource);
  validateExecutorBindings(renderedExecutorSource);
  validateWriterFenceConfig(renderedWriterFenceSource);

  return Object.freeze({
    schemaVersion: 1,
    mode: "fleet-sales-only-live-no-connections",
    executionEnabled: true,
    connectionsActivated: 0,
    jobs: [...FLEET_SALES_LIVE_JOBS],
    runtime: Object.freeze({
      name: RESCUE_RUNTIME_NAME,
      baseSha256: sha256(baseRuntimeSource),
      renderedSha256: sha256(renderedRuntimeSource),
      changes: Object.freeze([
        'RUNTIME_EXECUTION_ENABLED="false"->"true"',
        "add exactly one winerim-rescue-prod-sales consumer",
      ]),
      hyperdrive: Object.freeze({ binding: "MIDDLEWARE_DB", id: RESCUE_RUNTIME_HYPERDRIVE_ID }),
      executorService: Object.freeze({ binding: "RUNTIME_EXECUTOR", service: RESCUE_EXECUTOR_NAME }),
      cron: "*/5 * * * *",
      producerCount: EXPECTED_PRODUCERS.size,
      consumer: Object.freeze({
        queue: FLEET_SALES_LIVE_QUEUE,
        maxBatchSize: 1,
        maxBatchTimeout: 5,
        maxRetries: 3,
        maxConcurrency: 1,
        deadLetterQueue: FLEET_SALES_LIVE_DLQ,
      }),
    }),
    executor: Object.freeze({
      name: RESCUE_EXECUTOR_NAME,
      baseSha256: sha256(baseExecutorSource),
      renderedSha256: sha256(renderedExecutorSource),
      changes: Object.freeze([
        'RUNTIME_EXECUTION_ENABLED="false"->"true"',
        'RUNTIME_SALES_EXECUTION_ENABLED="false"->"true"',
        'RUNTIME_SALES_CURSOR_ENABLED="false"->"true"',
        'RUNTIME_SALES_DLQ_READY="false"->"true"',
      ]),
      hyperdrive: Object.freeze({ binding: "MIDDLEWARE_DB", id: RESCUE_RUNTIME_HYPERDRIVE_ID }),
      consumerCount: 0,
      privateBindings: Object.freeze([
        "RUNTIME_VAULT_KEY",
        "RUNTIME_FLEET_WRITER_FENCE_BUNDLE",
        "WRITER_FENCE",
      ]),
    }),
    writerFence: Object.freeze({
      name: FLEET_WRITER_FENCE_SERVICE,
      renderedSha256: sha256(renderedWriterFenceSource),
      hyperdrive: Object.freeze({ binding: "MIDDLEWARE_DB", id: RESCUE_RUNTIME_HYPERDRIVE_ID }),
      durableObject: "ConnectionWriterFence",
      globalGrantBound: false,
    }),
  });
}

export function renderFleetSalesLiveConfigs({ runtimeSource, executorSource }) {
  if (typeof runtimeSource !== "string" || typeof executorSource !== "string") {
    fail("FLEET_SALES_LIVE_BASE_CONFIGS_REQUIRED");
  }
  validateCanonicalBase(runtimeSource, executorSource);
  const renderedRuntimeSource = appendSalesConsumer(describeLiveRuntime(
    replaceExecutionFlag(runtimeSource, "RUNTIME"),
  ));
  const renderedExecutorSource = appendExecutorPrivateBindings(describeLiveExecutor(
    enableExecutorSalesSwitches(executorSource),
  ));
  const renderedWriterFenceSource = FLEET_WRITER_FENCE_CONFIG;
  const manifest = validateFleetSalesLiveConfigs({
    baseRuntimeSource: runtimeSource,
    baseExecutorSource: executorSource,
    renderedRuntimeSource,
    renderedExecutorSource,
    renderedWriterFenceSource,
  });
  return Object.freeze({
    renderedRuntimeSource,
    renderedExecutorSource,
    renderedWriterFenceSource,
    manifest,
  });
}

function parseCli(argv) {
  const options = {
    runtimePath: defaultRuntimePath,
    executorPath: defaultExecutorPath,
    runtimeOutputPath: defaultRuntimeOutputPath,
    executorOutputPath: defaultExecutorOutputPath,
    writerFenceOutputPath: defaultWriterFenceOutputPath,
    manifestOutputPath: defaultManifestOutputPath,
  };
  for (const argument of argv) {
    if (argument.startsWith("--runtime=")) options.runtimePath = resolve(argument.slice(10));
    else if (argument.startsWith("--executor=")) options.executorPath = resolve(argument.slice(11));
    else if (argument.startsWith("--runtime-output=")) {
      options.runtimeOutputPath = resolve(argument.slice(17));
    } else if (argument.startsWith("--executor-output=")) {
      options.executorOutputPath = resolve(argument.slice(18));
    } else if (argument.startsWith("--manifest-output=")) {
      options.manifestOutputPath = resolve(argument.slice(18));
    } else if (argument.startsWith("--writer-fence-output=")) {
      options.writerFenceOutputPath = resolve(argument.slice(22));
    } else fail("FLEET_SALES_LIVE_RENDER_ARGUMENT_REJECTED");
  }
  return options;
}

function writePrivate(path, source) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function main() {
  const options = parseCli(process.argv.slice(2));
  const result = renderFleetSalesLiveConfigs({
    runtimeSource: readFileSync(options.runtimePath, "utf8"),
    executorSource: readFileSync(options.executorPath, "utf8"),
  });
  writePrivate(options.runtimeOutputPath, result.renderedRuntimeSource);
  writePrivate(options.executorOutputPath, result.renderedExecutorSource);
  writePrivate(options.writerFenceOutputPath, result.renderedWriterFenceSource);
  writePrivate(options.manifestOutputPath, `${JSON.stringify(result.manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    ...result.manifest,
    outputs: {
      runtime: options.runtimeOutputPath,
      executor: options.executorOutputPath,
      writerFence: options.writerFenceOutputPath,
      manifest: options.manifestOutputPath,
    },
  }, null, 2)}\n`);
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
