import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FleetFullTopologyEvidenceError,
  validateFleetFullBaselineDeployments,
  validateFleetFullConsumerTopology,
  validateFleetFullLiveDeployments,
} from "./fleet-full-topology-evidence.mjs";

export const FLEET_FULL_ACCOUNT_ID = "e75343bb63534d3d029150e90b48ec7c";
export const FLEET_FULL_HYPERDRIVE_ID = "bf568eb1d85a41539384f241084c2227";
export const FLEET_FULL_EXECUTOR_NAME =
  "winerim-middleware-runtime-executor-rescue-prod-fleet-full";
export const FLEET_FULL_WRITER_FENCE_SERVICE =
  "winerim-middleware-runtime-writer-fence-rescue-prod-fleet";
export const FLEET_FULL_RATE_LIMITER_SERVICE =
  "winerim-middleware-outbound-rate-limiter-rescue-prod-fleet";
export const FLEET_FULL_SECRETS_STORE_ID = "40a78272a3d044038359c6c7e15ea52e";
export const FLEET_FULL_VAULT_SECRET_NAME = "winerim-rescue-prod-vault-key-v1";
export const FLEET_FULL_FENCE_BUNDLE_SECRET_NAME =
  "winerim-rescue-prod-fleet-writer-fence-bundle-v1";
export const FLEET_FULL_LIVE_JOBS = Object.freeze([
  "sales.auto-sync",
  "sales.sync-intraday",
  "catalog.fetch-winerim",
  "catalog.sync-master",
  "outbound.process",
]);

export const FLEET_FULL_TEMPLATE_SHA256 = Object.freeze({
  catalog: "7be2e92c94e1d31cdf18c273b324532d70940540c9e082adc43438f3ae6b25ee",
  salesStock: "8b7d1dccb2d154a9ad020375b042e38f2305d44000e465a63448aa0088a6e826",
  outbound: "9691423e3d17a3b1065a37d4e4ef7e67eb46d3dc6609d8f482bf812e874cb849",
  executor: "71ce4422df55c8b36375344c8d55b1a6b486a99a3e8dc2fb7fe592e709c25720",
  rateLimiter: "08fa7f200fe8e7dfd91265ccea091baef983553919d537780ace27436cc4c77b",
});

export const FLEET_FULL_LANES = Object.freeze({
  catalog: Object.freeze({
    lane: "catalog",
    workerName: "winerim-middleware-runtime-rescue-prod-fleet-catalog",
    queueBinding: "MIDDLEWARE_CATALOG_QUEUE",
    queue: "winerim-rescue-prod-catalog",
    deadLetterQueue: "winerim-rescue-prod-catalog-dead-letter",
  }),
  salesStock: Object.freeze({
    lane: "sales-stock",
    workerName: "winerim-middleware-runtime-rescue-prod-fleet-sales-stock",
    queueBinding: "MIDDLEWARE_SALES_STOCK_QUEUE",
    queue: "winerim-rescue-prod-sales",
    deadLetterQueue: "winerim-rescue-prod-sales-dead-letter",
  }),
  outbound: Object.freeze({
    lane: "outbound-queue",
    workerName: "winerim-middleware-runtime-rescue-prod-fleet-outbound",
    queueBinding: "MIDDLEWARE_OUTBOUND_QUEUE",
    queue: "winerim-rescue-prod-outbound",
    deadLetterQueue: "winerim-rescue-prod-outbound-dead-letter",
  }),
});

const SOURCE_PLACEHOLDER = "__SOURCE_COMMIT_SHA__";
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultOutputDir = "/tmp/winerim-fleet-full-inactive";
const defaultLiveOutputDir = "/tmp/winerim-fleet-full-live-prepared";

const COMPONENTS = Object.freeze({
  catalog: Object.freeze({
    templatePath: resolve(repoRoot, "wrangler.middleware-runtime-fleet-full-catalog.toml.example"),
    outputName: "wrangler.middleware-runtime-fleet-full-catalog.toml",
    entryPoint: "cloudflare/workers/middleware-runtime/src/worker.ts",
  }),
  salesStock: Object.freeze({
    templatePath: resolve(
      repoRoot,
      "wrangler.middleware-runtime-fleet-full-sales-stock.toml.example",
    ),
    outputName: "wrangler.middleware-runtime-fleet-full-sales-stock.toml",
    entryPoint: "cloudflare/workers/middleware-runtime/src/worker.ts",
  }),
  outbound: Object.freeze({
    templatePath: resolve(repoRoot, "wrangler.middleware-runtime-fleet-full-outbound.toml.example"),
    outputName: "wrangler.middleware-runtime-fleet-full-outbound.toml",
    entryPoint: "cloudflare/workers/middleware-runtime/src/worker.ts",
  }),
  executor: Object.freeze({
    templatePath: resolve(repoRoot, "wrangler.middleware-runtime-executor-fleet-full.toml.example"),
    outputName: "wrangler.middleware-runtime-executor-fleet-full.toml",
    entryPoint: "cloudflare/workers/middleware-runtime-executor/src/worker.ts",
  }),
  rateLimiter: Object.freeze({
    templatePath: resolve(
      repoRoot,
      "wrangler.middleware-outbound-rate-limiter-fleet-full.toml.example",
    ),
    outputName: "wrangler.middleware-outbound-rate-limiter-fleet-full.toml",
    entryPoint: "cloudflare/workers/middleware-outbound-rate-limiter/src/worker.ts",
  }),
});

const LIVE_EXECUTOR_SWITCHES = Object.freeze([
  "RUNTIME_EXECUTION_ENABLED",
  "RUNTIME_CATALOG_EXECUTION_ENABLED",
  "RUNTIME_CATALOG_FETCH_ENABLED",
  "RUNTIME_CATALOG_APPLY_ENABLED",
  "RUNTIME_SALES_EXECUTION_ENABLED",
  "RUNTIME_SALES_CURSOR_ENABLED",
  "RUNTIME_SALES_DLQ_READY",
  "RUNTIME_OUTBOUND_EXECUTION_ENABLED",
  "RUNTIME_OUTBOUND_MUTATION_ENABLED",
]);
const INACTIVE_RELEASE_PREFIX = "fleet-full-inactive-";
const LIVE_RELEASE_PREFIX = "fleet-full-live-";
const INERT_COMPONENT_COMMENTS = Object.freeze({
  runtime: "# Inert deploy: no queue consumer is bound until a separately reviewed activation gate.",
  executor: "# Inert deploy: all execution switches remain false and no Queue is bound here.",
  rateLimiter: "# Inert by reachability: no public route, preview URL or workers.dev endpoint exists.",
});
const LIVE_COMPONENT_COMMENTS = Object.freeze({
  runtime: "# LIVE lane worker: execution is enabled and it owns exactly its bounded Queue consumer.",
  executor: "# LIVE private executor: reachable only through lane-worker service bindings.",
  rateLimiter: "# LIVE private rate limiter: reachable only through the executor service binding.",
});

export class FleetFullLiveRenderError extends Error {
  constructor(code) {
    super(code);
    this.name = "FleetFullLiveRenderError";
    this.code = code;
  }
}

function fail(code) {
  throw new FleetFullLiveRenderError(code);
}

function sha256(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function occurrences(source, value) {
  return source.split(value).length - 1;
}

function replaceExact(source, current, replacement, code) {
  if (occurrences(source, current) !== 1 || occurrences(source, replacement) !== 0) fail(code);
  return source.replace(current, replacement);
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

function rejectPublicOrSecretSurface(source, component) {
  if (/^\s*(?:route|routes)\s*=/mu.test(source) || /\[\[?routes?\]?\]/u.test(source)) {
    fail(`${component}_PUBLIC_ROUTE_FORBIDDEN`);
  }
  if (/^\s*workers_dev\s*=\s*true\s*$/mu.test(source)) fail(`${component}_WORKERS_DEV_FORBIDDEN`);
  if (/^\s*preview_urls\s*=\s*true\s*$/mu.test(source)) fail(`${component}_PREVIEW_URL_FORBIDDEN`);
  if (/^\s*(?:DATABASE_URL|SUPABASE_ACCESS_TOKEN|API_TOKEN|TOKEN|PASSWORD)\s*=/mu.test(source)) {
    fail(`${component}_EMBEDDED_SECRET_FORBIDDEN`);
  }
}

function exactBinding(blocks, binding) {
  return blocks.filter((block) => assignment(block, "binding") === binding);
}

function validateHyperdrive(source, component) {
  const blocks = tableBlocks(source, "hyperdrive");
  if (
    blocks.length !== 1
    || assignment(blocks[0], "binding") !== "MIDDLEWARE_DB"
    || assignment(blocks[0], "id") !== FLEET_FULL_HYPERDRIVE_ID
  ) fail(`${component}_HYPERDRIVE_DRIFT`);
}

function validateSourceGuard({ sourceCommit, expectedCommit, sourceTreeClean }) {
  if (!COMMIT_PATTERN.test(String(sourceCommit ?? ""))) fail("SOURCE_COMMIT_INVALID");
  if (!COMMIT_PATTERN.test(String(expectedCommit ?? ""))) fail("EXPECTED_SOURCE_COMMIT_REQUIRED");
  if (sourceCommit !== expectedCommit) fail("SOURCE_COMMIT_MISMATCH");
  if (sourceTreeClean !== true) fail("SOURCE_TREE_DIRTY");
}

function validateRuntime(source, component, lane) {
  rejectPublicOrSecretSurface(source, component);
  if (assignment(source, "name") !== lane.workerName) fail(`${component}_NAME_DRIFT`);
  if (assignment(source, "main") !== "cloudflare/workers/middleware-runtime/src/worker.ts") {
    fail(`${component}_MAIN_DRIFT`);
  }
  for (const [key, expected] of Object.entries({
    ENVIRONMENT: "rescue-production",
    RUNTIME_MODE: "fleet-producer",
    RUNTIME_EXECUTION_ENABLED: "false",
    FLEET_RUNTIME_LANE: lane.lane,
  })) {
    if (assignment(source, key) !== expected) fail(`${component}_${key}_DRIFT`);
  }
  if (!/^\s*crons\s*=\s*\["\*\/5 \* \* \* \*"\]\s*$/mu.test(source)) {
    fail(`${component}_CRON_DRIFT`);
  }
  validateHyperdrive(source, component);
  const services = tableBlocks(source, "services");
  if (
    services.length !== 1
    || assignment(services[0], "binding") !== "RUNTIME_EXECUTOR"
    || assignment(services[0], "service") !== FLEET_FULL_EXECUTOR_NAME
  ) fail(`${component}_EXECUTOR_BINDING_DRIFT`);
  const producers = tableBlocks(source, "queues.producers");
  if (
    producers.length !== 1
    || assignment(producers[0], "binding") !== lane.queueBinding
    || assignment(producers[0], "queue") !== lane.queue
  ) fail(`${component}_QUEUE_PRODUCER_DRIFT`);
  if (tableBlocks(source, "queues.consumers").length !== 0) {
    fail(`${component}_INACTIVE_CONSUMER_FORBIDDEN`);
  }
}

function validateExecutor(source) {
  const component = "EXECUTOR";
  rejectPublicOrSecretSurface(source, component);
  if (assignment(source, "name") !== FLEET_FULL_EXECUTOR_NAME) fail("EXECUTOR_NAME_DRIFT");
  if (assignment(source, "main") !== "cloudflare/workers/middleware-runtime-executor/src/worker.ts") {
    fail("EXECUTOR_MAIN_DRIFT");
  }
  const expected = {
    ENVIRONMENT: "rescue-production",
    RUNTIME_MODE: "fleet-executor",
    RUNTIME_EXECUTION_ENABLED: "false",
    RUNTIME_VAULT_KEY_VERSION: "v1",
    WINERIM_API_BASE_URL: "https://app.winerim.com",
    WINERIM_ALLOWED_HOSTS: "app.winerim.com",
    RUNTIME_CATALOG_EXECUTION_ENABLED: "false",
    RUNTIME_CATALOG_FETCH_ENABLED: "false",
    RUNTIME_CATALOG_APPLY_ENABLED: "false",
    RUNTIME_SALES_EXECUTION_ENABLED: "false",
    RUNTIME_SALES_CURSOR_ENABLED: "false",
    RUNTIME_SALES_DLQ_READY: "false",
    RUNTIME_OUTBOUND_EXECUTION_ENABLED: "false",
    RUNTIME_OUTBOUND_MUTATION_ENABLED: "false",
  };
  for (const [key, value] of Object.entries(expected)) {
    if (assignment(source, key) !== value) fail(`EXECUTOR_${key}_DRIFT`);
  }
  validateHyperdrive(source, component);
  if (
    tableBlocks(source, "queues.producers").length !== 0
    || tableBlocks(source, "queues.consumers").length !== 0
  ) fail("EXECUTOR_QUEUE_BINDING_FORBIDDEN");

  const secrets = tableBlocks(source, "secrets_store_secrets");
  if (secrets.length !== 2) fail("EXECUTOR_SECRET_BINDING_COUNT_DRIFT");
  const vault = exactBinding(secrets, "RUNTIME_VAULT_KEY");
  const fenceBundle = exactBinding(secrets, "RUNTIME_FLEET_WRITER_FENCE_BUNDLE");
  if (
    vault.length !== 1
    || assignment(vault[0], "store_id") !== FLEET_FULL_SECRETS_STORE_ID
    || assignment(vault[0], "secret_name") !== FLEET_FULL_VAULT_SECRET_NAME
    || fenceBundle.length !== 1
    || assignment(fenceBundle[0], "store_id") !== FLEET_FULL_SECRETS_STORE_ID
    || assignment(fenceBundle[0], "secret_name") !== FLEET_FULL_FENCE_BUNDLE_SECRET_NAME
  ) fail("EXECUTOR_SECRET_BINDING_DRIFT");

  const services = tableBlocks(source, "services");
  const writerFence = exactBinding(services, "WRITER_FENCE");
  const limiter = exactBinding(services, "OUTBOUND_RATE_LIMITER");
  if (
    services.length !== 2
    || writerFence.length !== 1
    || assignment(writerFence[0], "service") !== FLEET_FULL_WRITER_FENCE_SERVICE
    || limiter.length !== 1
    || assignment(limiter[0], "service") !== FLEET_FULL_RATE_LIMITER_SERVICE
  ) fail("EXECUTOR_SERVICE_BINDING_DRIFT");
}

function validateRateLimiter(source) {
  const component = "RATE_LIMITER";
  rejectPublicOrSecretSurface(source, component);
  if (assignment(source, "name") !== FLEET_FULL_RATE_LIMITER_SERVICE) {
    fail("RATE_LIMITER_NAME_DRIFT");
  }
  if (assignment(source, "main") !== "cloudflare/workers/middleware-outbound-rate-limiter/src/worker.ts") {
    fail("RATE_LIMITER_MAIN_DRIFT");
  }
  if (assignment(source, "ENVIRONMENT") !== "rescue-production") {
    fail("RATE_LIMITER_ENVIRONMENT_DRIFT");
  }
  const bindings = tableBlocks(source, "durable_objects.bindings");
  if (
    bindings.length !== 1
    || assignment(bindings[0], "name") !== "OUTBOUND_RATE_LIMITER"
    || assignment(bindings[0], "class_name") !== "OutboundRateLimiter"
  ) fail("RATE_LIMITER_DURABLE_OBJECT_BINDING_DRIFT");
  const migrations = tableBlocks(source, "migrations");
  if (
    migrations.length !== 1
    || assignment(migrations[0], "tag") !== "v1"
    || !/^\s*new_sqlite_classes\s*=\s*\["OutboundRateLimiter"\]\s*$/mu.test(migrations[0])
  ) fail("RATE_LIMITER_MIGRATION_DRIFT");
  if (
    tableBlocks(source, "queues.producers").length !== 0
    || tableBlocks(source, "queues.consumers").length !== 0
  ) fail("RATE_LIMITER_QUEUE_BINDING_FORBIDDEN");
}

function activationContract(lane) {
  return Object.freeze({
    queue: lane.queue,
    deadLetterQueue: lane.deadLetterQueue,
    maxBatchSize: 1,
    maxBatchTimeout: 5,
    maxRetries: 3,
    maxConcurrency: 1,
    consumerToml: `[[queues.consumers]]\nqueue = "${lane.queue}"\nmax_batch_size = 1\nmax_batch_timeout = 5\nmax_retries = 3\nmax_concurrency = 1\ndead_letter_queue = "${lane.deadLetterQueue}"`,
  });
}

function validateTemplateHashes(templates) {
  for (const key of Object.keys(COMPONENTS)) {
    if (typeof templates[key] !== "string") fail(`TEMPLATE_REQUIRED_${key}`);
    if (sha256(templates[key]) !== FLEET_FULL_TEMPLATE_SHA256[key]) {
      fail(`TEMPLATE_SHA256_DRIFT_${key}`);
    }
    if (occurrences(templates[key], SOURCE_PLACEHOLDER) !== 1) {
      fail(`SOURCE_PLACEHOLDER_DRIFT_${key}`);
    }
  }
}

function topology(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof FleetFullTopologyEvidenceError) fail(error.code);
    throw error;
  }
}

function liveRelease(source, sourceCommit, component) {
  return replaceExact(
    source,
    `RELEASE = "${INACTIVE_RELEASE_PREFIX}${sourceCommit}"`,
    `RELEASE = "${LIVE_RELEASE_PREFIX}${sourceCommit}"`,
    `${component}_RELEASE_DRIFT`,
  );
}

function enableSwitch(source, key, component) {
  return replaceExact(
    source,
    `${key} = "false"`,
    `${key} = "true"`,
    `${component}_${key}_NOT_EXACTLY_ONE_INACTIVE`,
  );
}

function renderLiveRuntime(inactiveSource, sourceCommit, component, lane) {
  let rendered = liveRelease(inactiveSource, sourceCommit, component);
  rendered = enableSwitch(rendered, "RUNTIME_EXECUTION_ENABLED", component);
  rendered = replaceExact(
    rendered,
    INERT_COMPONENT_COMMENTS.runtime,
    LIVE_COMPONENT_COMMENTS.runtime,
    `${component}_OPERATIONAL_COMMENT_DRIFT`,
  );
  if (tableBlocks(rendered, "queues.consumers").length !== 0) {
    fail(`${component}_INACTIVE_CONSUMER_FORBIDDEN`);
  }
  const consumer = activationContract(lane).consumerToml;
  return `${rendered.endsWith("\n") ? rendered : `${rendered}\n`}\n${consumer}\n`;
}

function renderLiveExecutor(inactiveSource, sourceCommit) {
  let rendered = liveRelease(inactiveSource, sourceCommit, "EXECUTOR");
  for (const key of LIVE_EXECUTOR_SWITCHES) rendered = enableSwitch(rendered, key, "EXECUTOR");
  rendered = replaceExact(
    rendered,
    INERT_COMPONENT_COMMENTS.executor,
    LIVE_COMPONENT_COMMENTS.executor,
    "EXECUTOR_OPERATIONAL_COMMENT_DRIFT",
  );
  if (tableBlocks(rendered, "queues.consumers").length !== 0) {
    fail("EXECUTOR_INACTIVE_CONSUMER_FORBIDDEN");
  }
  return rendered;
}

function renderLiveRateLimiter(inactiveSource, sourceCommit) {
  return replaceExact(
    liveRelease(inactiveSource, sourceCommit, "RATE_LIMITER"),
    INERT_COMPONENT_COMMENTS.rateLimiter,
    LIVE_COMPONENT_COMMENTS.rateLimiter,
    "RATE_LIMITER_OPERATIONAL_COMMENT_DRIFT",
  );
}

function expectedLiveRendered(inactiveRendered, sourceCommit) {
  return Object.freeze({
    catalog: renderLiveRuntime(
      inactiveRendered.catalog,
      sourceCommit,
      "CATALOG",
      FLEET_FULL_LANES.catalog,
    ),
    salesStock: renderLiveRuntime(
      inactiveRendered.salesStock,
      sourceCommit,
      "SALES_STOCK",
      FLEET_FULL_LANES.salesStock,
    ),
    outbound: renderLiveRuntime(
      inactiveRendered.outbound,
      sourceCommit,
      "OUTBOUND",
      FLEET_FULL_LANES.outbound,
    ),
    executor: renderLiveExecutor(inactiveRendered.executor, sourceCommit),
    rateLimiter: renderLiveRateLimiter(inactiveRendered.rateLimiter, sourceCommit),
  });
}

function normalizeTomlBlock(source) {
  return source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join("\n");
}

function validateLiveRuntime(source, component, lane) {
  rejectPublicOrSecretSurface(source, component);
  if (assignment(source, "name") !== lane.workerName) fail(`${component}_NAME_DRIFT`);
  if (assignment(source, "RUNTIME_EXECUTION_ENABLED") !== "true") {
    fail(`${component}_EXECUTION_NOT_ENABLED`);
  }
  if (assignment(source, "FLEET_RUNTIME_LANE") !== lane.lane) fail(`${component}_LANE_DRIFT`);
  validateHyperdrive(source, component);
  const services = tableBlocks(source, "services");
  if (
    services.length !== 1
    || assignment(services[0], "binding") !== "RUNTIME_EXECUTOR"
    || assignment(services[0], "service") !== FLEET_FULL_EXECUTOR_NAME
  ) fail(`${component}_EXECUTOR_BINDING_DRIFT`);
  const producers = tableBlocks(source, "queues.producers");
  if (
    producers.length !== 1
    || assignment(producers[0], "binding") !== lane.queueBinding
    || assignment(producers[0], "queue") !== lane.queue
  ) fail(`${component}_QUEUE_PRODUCER_DRIFT`);
  const consumers = tableBlocks(source, "queues.consumers");
  if (
    consumers.length !== 1
    || normalizeTomlBlock(consumers[0]) !== normalizeTomlBlock(activationContract(lane).consumerToml)
  ) {
    fail(`${component}_CONSUMER_CONTRACT_DRIFT`);
  }
}

function validateLiveExecutor(source) {
  rejectPublicOrSecretSurface(source, "EXECUTOR");
  if (assignment(source, "name") !== FLEET_FULL_EXECUTOR_NAME) fail("EXECUTOR_NAME_DRIFT");
  validateHyperdrive(source, "EXECUTOR");
  for (const key of LIVE_EXECUTOR_SWITCHES) {
    if (assignment(source, key) !== "true") fail(`EXECUTOR_${key}_NOT_ENABLED`);
  }
  if (tableBlocks(source, "queues.producers").length !== 0) fail("EXECUTOR_PRODUCER_FORBIDDEN");
  if (tableBlocks(source, "queues.consumers").length !== 0) {
    fail("EXECUTOR_CONSUMER_FORBIDDEN");
  }

  const secrets = tableBlocks(source, "secrets_store_secrets");
  const services = tableBlocks(source, "services");
  if (
    secrets.length !== 2
    || exactBinding(secrets, "RUNTIME_VAULT_KEY").length !== 1
    || exactBinding(secrets, "RUNTIME_FLEET_WRITER_FENCE_BUNDLE").length !== 1
    || services.length !== 2
    || exactBinding(services, "WRITER_FENCE").length !== 1
    || exactBinding(services, "OUTBOUND_RATE_LIMITER").length !== 1
  ) fail("EXECUTOR_PRIVATE_BINDING_DRIFT");
}

function deploymentComponentContract(rendered) {
  return Object.freeze(Object.fromEntries(Object.keys(COMPONENTS).map((key) => [
    key,
    Object.freeze({
      workerName: assignment(rendered[key], "name"),
      renderedSha256: sha256(rendered[key]),
    }),
  ])));
}

export function validateFleetFullInactiveConfigs({
  templates,
  rendered,
  sourceCommit,
  expectedCommit,
  sourceTreeClean,
}) {
  validateSourceGuard({ sourceCommit, expectedCommit, sourceTreeClean });
  validateTemplateHashes(templates);
  for (const key of Object.keys(COMPONENTS)) {
    if (typeof rendered[key] !== "string") fail(`RENDERED_CONFIG_REQUIRED_${key}`);
    const expected = templates[key].replace(SOURCE_PLACEHOLDER, sourceCommit);
    if (rendered[key] !== expected) fail(`RENDERED_UNRELATED_CHANGE_${key}`);
    if (rendered[key].includes(SOURCE_PLACEHOLDER)) fail(`SOURCE_PLACEHOLDER_NOT_RENDERED_${key}`);
  }

  validateRuntime(rendered.catalog, "CATALOG", FLEET_FULL_LANES.catalog);
  validateRuntime(rendered.salesStock, "SALES_STOCK", FLEET_FULL_LANES.salesStock);
  validateRuntime(rendered.outbound, "OUTBOUND", FLEET_FULL_LANES.outbound);
  validateExecutor(rendered.executor);
  validateRateLimiter(rendered.rateLimiter);

  const components = Object.fromEntries(Object.keys(COMPONENTS).map((key) => [key, Object.freeze({
    name: assignment(rendered[key], "name"),
    entryPoint: COMPONENTS[key].entryPoint,
    templateSha256: sha256(templates[key]),
    renderedSha256: sha256(rendered[key]),
    outputName: COMPONENTS[key].outputName,
  })]));
  const lanes = Object.fromEntries(Object.entries(FLEET_FULL_LANES).map(([key, lane]) => [
    key,
    Object.freeze({
      lane: lane.lane,
      workerName: lane.workerName,
      producerBinding: lane.queueBinding,
      ...activationContract(lane),
      consumerPresent: false,
    }),
  ]));

  return Object.freeze({
    schemaVersion: 1,
    mode: "fleet-full-inactive-no-connections",
    source: Object.freeze({ commit: sourceCommit, clean: true }),
    executionEnabled: false,
    activationAllowed: false,
    connectionsActivated: 0,
    components: Object.freeze(components),
    lanes: Object.freeze(lanes),
    rollback: Object.freeze({
      requiredBeforeDeploy: Object.freeze([
        "capture-current-deployment-and-version-id-for-each-component",
        "verify-rendered-sha256-against-this-manifest",
      ]),
      baselineDeploymentIds: null,
      automaticRollbackAllowed: false,
      commandTemplate: "npx wrangler rollback <captured-version-id> --config <rendered-config>",
      sourceCommit: sourceCommit,
    }),
    nextGate: "CAPTURE_BASELINES_THEN_SEPARATE_REVIEWED_ACTIVATION",
  });
}

export function renderFleetFullInactiveConfigs({
  templates,
  sourceCommit,
  expectedCommit,
  sourceTreeClean,
}) {
  validateSourceGuard({ sourceCommit, expectedCommit, sourceTreeClean });
  validateTemplateHashes(templates);
  const rendered = Object.fromEntries(Object.keys(COMPONENTS).map((key) => [
    key,
    templates[key].replace(SOURCE_PLACEHOLDER, sourceCommit),
  ]));
  const manifest = validateFleetFullInactiveConfigs({
    templates,
    rendered,
    sourceCommit,
    expectedCommit,
    sourceTreeClean,
  });
  return Object.freeze({ rendered: Object.freeze(rendered), manifest });
}

export function validateFleetFullLivePreparedConfigs({
  templates,
  inactiveRendered,
  rendered,
  sourceCommit,
  expectedCommit,
  sourceTreeClean,
  baselineDeployments,
}) {
  validateFleetFullInactiveConfigs({
    templates,
    rendered: inactiveRendered,
    sourceCommit,
    expectedCommit,
    sourceTreeClean,
  });
  const expected = expectedLiveRendered(inactiveRendered, sourceCommit);
  for (const key of Object.keys(COMPONENTS)) {
    if (typeof rendered[key] !== "string") fail(`LIVE_RENDERED_CONFIG_REQUIRED_${key}`);
    if (rendered[key] !== expected[key]) fail(`LIVE_RENDERED_UNRELATED_CHANGE_${key}`);
    if (assignment(rendered[key], "RELEASE") !== `${LIVE_RELEASE_PREFIX}${sourceCommit}`) {
      fail(`LIVE_RELEASE_DRIFT_${key}`);
    }
  }

  validateLiveRuntime(rendered.catalog, "CATALOG", FLEET_FULL_LANES.catalog);
  validateLiveRuntime(rendered.salesStock, "SALES_STOCK", FLEET_FULL_LANES.salesStock);
  validateLiveRuntime(rendered.outbound, "OUTBOUND", FLEET_FULL_LANES.outbound);
  validateLiveExecutor(rendered.executor);
  validateRateLimiter(rendered.rateLimiter);

  const deploymentContract = deploymentComponentContract(rendered);
  const baseline = topology(() => validateFleetFullBaselineDeployments({
    evidence: baselineDeployments,
    accountId: FLEET_FULL_ACCOUNT_ID,
    components: deploymentContract,
  }));
  const components = Object.freeze(Object.fromEntries(Object.entries(COMPONENTS).map(([key, spec]) => [
    key,
    Object.freeze({
      workerName: deploymentContract[key].workerName,
      entryPoint: spec.entryPoint,
      outputName: spec.outputName,
      inactiveSha256: sha256(inactiveRendered[key]),
      renderedSha256: deploymentContract[key].renderedSha256,
      baselineDeploymentId: baseline.components[key].deploymentId,
      baselineVersionId: baseline.components[key].versionId,
    }),
  ])));
  const rollbackComponents = Object.freeze(Object.fromEntries(Object.entries(components).map(([key, component]) => {
    const lane = FLEET_FULL_LANES[key];
    return [key, Object.freeze({
      workerName: component.workerName,
      deploymentId: component.baselineDeploymentId,
      versionId: component.baselineVersionId,
      configOutputName: component.outputName,
      removeConsumerCommand: lane ? Object.freeze([
        "npx",
        "wrangler",
        "queues",
        "consumer",
        "remove",
        lane.queue,
        lane.workerName,
      ]) : null,
      command: Object.freeze([
        "npx",
        "wrangler",
        "rollback",
        component.baselineVersionId,
        "--config",
        component.outputName,
      ]),
    })];
  })));

  return Object.freeze({
    schemaVersion: 1,
    mode: "fleet-full-live-prepared",
    source: Object.freeze({ commit: sourceCommit, clean: true }),
    executionEnabled: true,
    activationAllowed: false,
    connectionsActivated: 0,
    deploymentPrerequisites: Object.freeze({
      ownDatabaseActiveRuntimeScopes: 0,
      ownDatabaseEnabledConnections: 0,
      mustBeReadBackImmediatelyBeforeDeploy: true,
    }),
    jobs: FLEET_FULL_LIVE_JOBS,
    components,
    lanes: Object.freeze(Object.fromEntries(Object.entries(FLEET_FULL_LANES).map(([key, lane]) => [
      key,
      Object.freeze({
        lane: lane.lane,
        producerWorkerName: lane.workerName,
        consumerWorkerName: lane.workerName,
        ...activationContract(lane),
      }),
    ]))),
    topologyGate: Object.freeze({
      requiredBeforeConnectionActivation: true,
      evidenceStatus: "MISSING",
      accountId: FLEET_FULL_ACCOUNT_ID,
      inventoryCompleteForQueues: true,
      exactManagedQueueCount: 3,
      executorConsumerCountOnManagedQueues: 0,
      laneConsumerCountOnManagedQueues: 3,
      exactConsumerCountPerQueue: 1,
      legacyConsumerCount: 0,
      competingConsumerCount: 0,
      maxEvidenceAgeSeconds: 900,
      rejectsAnyUnlistedConsumerOnManagedQueues: true,
    }),
    rollback: Object.freeze({
      capturedAt: baseline.capturedAt,
      accountId: FLEET_FULL_ACCOUNT_ID,
      components: rollbackComponents,
      automaticRollbackAllowed: false,
      requiredOnTopologyFailure: true,
    }),
    nextGate: "DEPLOY_WITH_ROLLBACK_THEN_ATTEST_EXCLUSIVE_QUEUE_TOPOLOGY",
  });
}

export function renderFleetFullLivePreparedConfigs({
  templates,
  sourceCommit,
  expectedCommit,
  sourceTreeClean,
  baselineDeployments,
}) {
  const inactive = renderFleetFullInactiveConfigs({
    templates,
    sourceCommit,
    expectedCommit,
    sourceTreeClean,
  });
  const rendered = expectedLiveRendered(inactive.rendered, sourceCommit);
  const manifest = validateFleetFullLivePreparedConfigs({
    templates,
    inactiveRendered: inactive.rendered,
    rendered,
    sourceCommit,
    expectedCommit,
    sourceTreeClean,
    baselineDeployments,
  });
  return Object.freeze({
    inactiveRendered: inactive.rendered,
    rendered,
    manifest,
  });
}

export function attestFleetFullLiveTopology({
  preparedResult,
  templates,
  sourceCommit,
  expectedCommit,
  sourceTreeClean,
  baselineDeployments,
  liveDeployments,
  topologyEvidence,
  verifiedAt,
}) {
  if (!preparedResult || typeof preparedResult !== "object") fail("LIVE_PREPARED_RESULT_REQUIRED");
  const expectedManifest = validateFleetFullLivePreparedConfigs({
    templates,
    inactiveRendered: preparedResult.inactiveRendered,
    rendered: preparedResult.rendered,
    sourceCommit,
    expectedCommit,
    sourceTreeClean,
    baselineDeployments,
  });
  if (canonicalJson(preparedResult.manifest) !== canonicalJson(expectedManifest)) {
    fail("LIVE_PREPARED_MANIFEST_DRIFT");
  }

  const deploymentContract = deploymentComponentContract(preparedResult.rendered);
  const deployed = topology(() => validateFleetFullLiveDeployments({
    evidence: liveDeployments,
    accountId: FLEET_FULL_ACCOUNT_ID,
    components: deploymentContract,
  }));
  if (deployed.sourceCommit !== sourceCommit) fail("LIVE_DEPLOYMENT_SOURCE_COMMIT_DRIFT");
  const queueTopology = topology(() => validateFleetFullConsumerTopology({
    evidence: topologyEvidence,
    verifiedAt,
    accountId: FLEET_FULL_ACCOUNT_ID,
    executorWorkerName: FLEET_FULL_EXECUTOR_NAME,
    executorDeploymentId: deployed.components.executor.deploymentId,
    executorVersionId: deployed.components.executor.versionId,
    lanes: Object.freeze(Object.fromEntries(Object.entries(FLEET_FULL_LANES).map(
      ([key, lane]) => [key, Object.freeze({
        queue: lane.queue,
        deadLetterQueue: lane.deadLetterQueue,
        consumerWorkerName: lane.workerName,
        consumerDeploymentId: deployed.components[key].deploymentId,
        consumerVersionId: deployed.components[key].versionId,
      })],
    ))),
  }));
  if (Date.parse(queueTopology.observedAt) < Date.parse(deployed.capturedAt)) {
    fail("TOPOLOGY_EVIDENCE_PREDATES_LIVE_DEPLOYMENT");
  }

  const components = Object.freeze(Object.fromEntries(Object.entries(expectedManifest.components).map(
    ([key, component]) => [key, Object.freeze({
      ...component,
      deploymentId: deployed.components[key].deploymentId,
      versionId: deployed.components[key].versionId,
    })],
  )));
  const deploymentId = `fleet-full-${sha256(canonicalJson(deployed.components)).slice(0, 24)}`;
  return Object.freeze({
    ...expectedManifest,
    mode: "fleet-full-live-topology-attested",
    activationAllowed: true,
    components,
    deployment: Object.freeze({
      version: 1,
      kind: "runtime-full-lanes-deployment",
      deploymentId,
      capturedAt: deployed.capturedAt,
      sourceCommit,
    }),
    topologyGate: Object.freeze({
      ...expectedManifest.topologyGate,
      evidenceStatus: "VERIFIED",
      observedAt: queueTopology.observedAt,
      verifiedAt: queueTopology.verifiedAt,
      inventorySha256: queueTopology.inventorySha256,
    }),
    queueOwnership: queueTopology,
    nextGate: "SERIAL_CONNECTION_ACTIVATION_ONLY",
  });
}

export function readFleetFullTemplates() {
  return Object.freeze(Object.fromEntries(Object.entries(COMPONENTS).map(([key, component]) => [
    key,
    readFileSync(component.templatePath, "utf8"),
  ])));
}

function parseCli(argv) {
  const options = {
    mode: "inactive",
    outputDir: defaultOutputDir,
    expectedCommit: null,
    baselineDeploymentsPath: null,
    liveDeploymentsPath: null,
    topologyEvidencePath: null,
    verifiedAt: null,
  };
  for (const argument of argv) {
    if (argument.startsWith("--mode=")) options.mode = argument.slice("--mode=".length);
    else if (argument.startsWith("--output-dir=")) options.outputDir = resolve(argument.slice(13));
    else if (argument.startsWith("--expected-commit=")) options.expectedCommit = argument.slice(18);
    else if (argument.startsWith("--baseline-deployments=")) {
      options.baselineDeploymentsPath = resolve(argument.slice("--baseline-deployments=".length));
    } else if (argument.startsWith("--live-deployments=")) {
      options.liveDeploymentsPath = resolve(argument.slice("--live-deployments=".length));
    } else if (argument.startsWith("--topology-evidence=")) {
      options.topologyEvidencePath = resolve(argument.slice("--topology-evidence=".length));
    } else if (argument.startsWith("--verified-at=")) {
      options.verifiedAt = argument.slice("--verified-at=".length);
    }
    else fail("FLEET_FULL_RENDER_ARGUMENT_REJECTED");
  }
  if (!new Set(["inactive", "live-prepared", "live-attest"]).has(options.mode)) {
    fail("FLEET_FULL_RENDER_MODE_REJECTED");
  }
  if (options.mode !== "inactive" && options.outputDir === defaultOutputDir) {
    options.outputDir = defaultLiveOutputDir;
  }
  return options;
}

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function writePrivate(path, source) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function readJson(path, code) {
  if (!path) fail(code);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(code);
  }
}

export function writeFleetFullInactivePackage({ outputDir, result }) {
  if (!result || typeof result !== "object" || !result.rendered || !result.manifest) {
    fail("FLEET_FULL_RENDER_RESULT_REQUIRED");
  }
  const resolvedOutputDir = resolve(String(outputDir ?? ""));
  const outputs = {};
  const operations = {};
  for (const [key, component] of Object.entries(COMPONENTS)) {
    if (typeof result.rendered[key] !== "string") fail(`RENDERED_CONFIG_REQUIRED_${key}`);
    const path = resolve(resolvedOutputDir, component.outputName);
    writePrivate(path, result.rendered[key]);
    outputs[key] = path;
    const dryRunOutdir = resolve(resolvedOutputDir, ".wrangler-dry-run", key);
    operations[key] = Object.freeze({
      workingDirectory: repoRoot,
      entryPoint: component.entryPoint,
      configPath: path,
      dryRunOutdir,
      dryRunCommand: Object.freeze([
        "npx",
        "wrangler",
        "deploy",
        component.entryPoint,
        "--config",
        path,
        "--dry-run",
        "--outdir",
        dryRunOutdir,
      ]),
      deployCommand: Object.freeze([
        "npx",
        "wrangler",
        "deploy",
        component.entryPoint,
        "--config",
        path,
      ]),
    });
  }
  const manifestPath = resolve(resolvedOutputDir, "fleet-full-inactive-manifest.json");
  writePrivate(manifestPath, `${JSON.stringify({ ...result.manifest, outputs, operations }, null, 2)}\n`);
  return Object.freeze({
    outputs: Object.freeze(outputs),
    operations: Object.freeze(operations),
    manifestPath,
  });
}

export function writeFleetFullLivePreparedPackage({ outputDir, result }) {
  if (
    !result
    || typeof result !== "object"
    || !result.rendered
    || result.manifest?.mode !== "fleet-full-live-prepared"
    || result.manifest.activationAllowed !== false
  ) fail("FLEET_FULL_LIVE_PREPARED_RESULT_REQUIRED");
  const resolvedOutputDir = resolve(String(outputDir ?? ""));
  const outputs = {};
  const operations = {};
  for (const [key, component] of Object.entries(COMPONENTS)) {
    const path = resolve(resolvedOutputDir, component.outputName);
    writePrivate(path, result.rendered[key]);
    outputs[key] = path;
    const dryRunOutdir = resolve(resolvedOutputDir, ".wrangler-dry-run", key);
    operations[key] = Object.freeze({
      workingDirectory: repoRoot,
      entryPoint: component.entryPoint,
      configPath: path,
      dryRunOutdir,
      dryRunCommand: Object.freeze([
        "npx",
        "wrangler",
        "deploy",
        component.entryPoint,
        "--config",
        path,
        "--dry-run",
        "--outdir",
        dryRunOutdir,
      ]),
      deployCommand: Object.freeze([
        "npx",
        "wrangler",
        "deploy",
        component.entryPoint,
        "--config",
        path,
      ]),
      rollbackCommand: Object.freeze([
        "npx",
        "wrangler",
        "rollback",
        result.manifest.rollback.components[key].versionId,
        "--config",
        path,
      ]),
      removeConsumerCommand: result.manifest.rollback.components[key].removeConsumerCommand,
    });
  }
  const manifestPath = resolve(resolvedOutputDir, "fleet-full-live-prepared-manifest.json");
  writePrivate(manifestPath, `${JSON.stringify({
    ...result.manifest,
    outputs,
    operations,
  }, null, 2)}\n`);
  return Object.freeze({
    outputs: Object.freeze(outputs),
    operations: Object.freeze(operations),
    manifestPath,
  });
}

export function writeFleetFullLiveAttestation({ outputDir, attestation }) {
  if (
    !attestation
    || attestation.mode !== "fleet-full-live-topology-attested"
    || attestation.activationAllowed !== true
    || attestation.topologyGate?.evidenceStatus !== "VERIFIED"
  ) fail("FLEET_FULL_LIVE_ATTESTATION_REQUIRED");
  const path = resolve(String(outputDir ?? ""), "fleet-full-live-topology-attestation.json");
  writePrivate(path, `${JSON.stringify(attestation, null, 2)}\n`);
  return path;
}

function main() {
  const options = parseCli(process.argv.slice(2));
  const sourceCommit = git(["rev-parse", "HEAD"]);
  const sourceTreeClean = git(["status", "--porcelain=v1", "--untracked-files=all"]) === "";
  const templates = readFleetFullTemplates();
  if (options.mode === "inactive") {
    const result = renderFleetFullInactiveConfigs({
      templates,
      sourceCommit,
      expectedCommit: options.expectedCommit,
      sourceTreeClean,
    });
    const written = writeFleetFullInactivePackage({ outputDir: options.outputDir, result });
    process.stdout.write(`${JSON.stringify({
      ...result.manifest,
      outputs: written.outputs,
      operations: written.operations,
      manifest: written.manifestPath,
    }, null, 2)}\n`);
    return;
  }

  const baselineDeployments = readJson(
    options.baselineDeploymentsPath,
    "BASELINE_DEPLOYMENTS_FILE_REQUIRED",
  );
  const preparedResult = renderFleetFullLivePreparedConfigs({
    templates,
    sourceCommit,
    expectedCommit: options.expectedCommit,
    sourceTreeClean,
    baselineDeployments,
  });
  const written = writeFleetFullLivePreparedPackage({ outputDir: options.outputDir, result: preparedResult });
  if (options.mode === "live-prepared") {
    process.stdout.write(`${JSON.stringify({
      ...preparedResult.manifest,
      outputs: written.outputs,
      operations: written.operations,
      manifest: written.manifestPath,
    }, null, 2)}\n`);
    return;
  }

  const attestation = attestFleetFullLiveTopology({
    preparedResult,
    templates,
    sourceCommit,
    expectedCommit: options.expectedCommit,
    sourceTreeClean,
    baselineDeployments,
    liveDeployments: readJson(options.liveDeploymentsPath, "LIVE_DEPLOYMENTS_FILE_REQUIRED"),
    topologyEvidence: readJson(options.topologyEvidencePath, "TOPOLOGY_EVIDENCE_FILE_REQUIRED"),
    verifiedAt: options.verifiedAt,
  });
  const attestationPath = writeFleetFullLiveAttestation({
    outputDir: options.outputDir,
    attestation,
  });
  process.stdout.write(`${JSON.stringify({ ...attestation, attestation: attestationPath }, null, 2)}\n`);
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
