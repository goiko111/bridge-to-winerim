import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateFleetDeployment } from "./validate-fleet-deployment.mjs";

export const FLEET_CATALOG_QUEUE = "winerim-rescue-prod-catalog";
export const FLEET_CATALOG_DLQ = "winerim-rescue-prod-dead-letter";

export const FLEET_CATALOG_CONSUMER_BLOCK = `[[queues.consumers]]
queue = "${FLEET_CATALOG_QUEUE}"
max_batch_size = 1
max_batch_timeout = 5
max_retries = 3
max_concurrency = 2
dead_letter_queue = "${FLEET_CATALOG_DLQ}"`;

const INERT_CONSUMER_MARKER = `# Intentionally no Queue consumer. The reviewed consumer gate must add exactly
# one rescue Queue and its winerim-rescue-prod-dead-letter binding separately.`;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultSourcePath = resolve(repoRoot, "wrangler.middleware-runtime-fleet.toml");
const defaultExecutorPath = resolve(repoRoot, "wrangler.middleware-runtime-executor-fleet.toml");
const defaultOutputPath = "/tmp/winerim-middleware-runtime-fleet-catalog.toml";

export class FleetCatalogRenderError extends Error {
  constructor(code) {
    super(code);
    this.name = "FleetCatalogRenderError";
    this.code = code;
  }
}

function fail(code) {
  throw new FleetCatalogRenderError(code);
}

function consumerBlocks(source) {
  const marker = "[[queues.consumers]]";
  const starts = [];
  let cursor = 0;
  while (true) {
    const start = source.indexOf(marker, cursor);
    if (start === -1) break;
    starts.push(start);
    cursor = start + marker.length;
  }
  return starts.map((start, index) => {
    const nextTable = source.indexOf("\n[", start + marker.length);
    const nextConsumer = starts[index + 1] ?? source.length;
    const end = nextTable === -1 ? source.length : Math.min(nextTable + 1, nextConsumer);
    return source.slice(start, end);
  });
}

function normalizeBlock(source) {
  return source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join("\n");
}

function sha256(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function renderFleetCatalogRuntimeConfig({ baseSource, executorSource }) {
  if (typeof baseSource !== "string" || typeof executorSource !== "string") {
    fail("FLEET_CATALOG_BASE_CONFIG_REQUIRED");
  }
  validateFleetDeployment({ runtimeSource: baseSource, executorSource });
  if (!baseSource.includes(INERT_CONSUMER_MARKER)) {
    fail("FLEET_CATALOG_INERT_MARKER_MISSING");
  }
  if (baseSource.indexOf(INERT_CONSUMER_MARKER) !== baseSource.lastIndexOf(INERT_CONSUMER_MARKER)) {
    fail("FLEET_CATALOG_INERT_MARKER_NOT_UNIQUE");
  }

  const renderedSource = baseSource.replace(
    INERT_CONSUMER_MARKER,
    `# Catalog-only consumer activation. Sales, stock, outbound and maintenance remain unconsumed.\n${FLEET_CATALOG_CONSUMER_BLOCK}`,
  );
  validateFleetCatalogRuntimeConfig({ baseSource, executorSource, renderedSource });
  return renderedSource;
}

export function validateFleetCatalogRuntimeConfig({ baseSource, executorSource, renderedSource }) {
  if (
    typeof baseSource !== "string"
    || typeof executorSource !== "string"
    || typeof renderedSource !== "string"
  ) {
    fail("FLEET_CATALOG_CONFIG_SOURCE_REQUIRED");
  }
  validateFleetDeployment({ runtimeSource: baseSource, executorSource });

  const blocks = consumerBlocks(renderedSource);
  if (blocks.length !== 1) fail("FLEET_CATALOG_CONSUMER_COUNT_MUST_BE_ONE");
  if (normalizeBlock(blocks[0]) !== normalizeBlock(FLEET_CATALOG_CONSUMER_BLOCK)) {
    fail("FLEET_CATALOG_CONSUMER_CONTRACT_MISMATCH");
  }

  const expectedSource = baseSource.replace(
    INERT_CONSUMER_MARKER,
    `# Catalog-only consumer activation. Sales, stock, outbound and maintenance remain unconsumed.\n${FLEET_CATALOG_CONSUMER_BLOCK}`,
  );
  if (expectedSource === baseSource) fail("FLEET_CATALOG_INERT_MARKER_MISSING");
  if (renderedSource !== expectedSource) fail("FLEET_CATALOG_BASE_CONFIG_CHANGED");

  return Object.freeze({
    ok: true,
    mode: "fleet-catalog-only",
    baseSha256: sha256(baseSource),
    renderedSha256: sha256(renderedSource),
    consumerCount: 1,
    queue: FLEET_CATALOG_QUEUE,
    maxBatchSize: 1,
    maxBatchTimeout: 5,
    maxRetries: 3,
    maxConcurrency: 2,
    deadLetterQueue: FLEET_CATALOG_DLQ,
  });
}

function parseCli(argv) {
  const options = {
    sourcePath: defaultSourcePath,
    executorPath: defaultExecutorPath,
    outputPath: defaultOutputPath,
  };
  for (const argument of argv) {
    if (argument.startsWith("--source=")) options.sourcePath = resolve(argument.slice(9));
    else if (argument.startsWith("--executor=")) options.executorPath = resolve(argument.slice(11));
    else if (argument.startsWith("--output=")) options.outputPath = resolve(argument.slice(9));
    else fail("FLEET_CATALOG_RENDER_ARGUMENT_REJECTED");
  }
  return options;
}

function main() {
  const options = parseCli(process.argv.slice(2));
  const baseSource = readFileSync(options.sourcePath, "utf8");
  const executorSource = readFileSync(options.executorPath, "utf8");
  const renderedSource = renderFleetCatalogRuntimeConfig({ baseSource, executorSource });
  const result = validateFleetCatalogRuntimeConfig({
    baseSource,
    executorSource,
    renderedSource,
  });

  mkdirSync(dirname(options.outputPath), { recursive: true });
  writeFileSync(options.outputPath, renderedSource, { encoding: "utf8", mode: 0o600 });
  chmodSync(options.outputPath, 0o600);
  process.stdout.write(`${JSON.stringify({ ...result, outputPath: options.outputPath }, null, 2)}\n`);
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
