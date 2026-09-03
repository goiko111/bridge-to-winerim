import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultTemplatePath = resolve(
  repoRoot,
  "cloudflare/workers/fleet-isolation-staging/wrangler.toml.example",
);
const defaultOutputPath = "/tmp/winerim-fleet-isolation-staging.toml";
const RUN_ID_PATTERN = /^[a-z0-9-]{8,24}$/u;

function fail(code) {
  throw new Error(code);
}

function parseArgs(argv) {
  const options = { templatePath: defaultTemplatePath, outputPath: defaultOutputPath, runId: "" };
  for (const argument of argv) {
    if (argument.startsWith("--run-id=")) options.runId = argument.slice(9);
    else if (argument.startsWith("--template=")) options.templatePath = resolve(argument.slice(11));
    else if (argument.startsWith("--output=")) options.outputPath = resolve(argument.slice(9));
    else fail("ISOLATION_RENDER_ARGUMENT_REJECTED");
  }
  if (!RUN_ID_PATTERN.test(options.runId)) fail("ISOLATION_RENDER_RUN_ID_INVALID");
  return options;
}

export function renderIsolationConfig(template, runId) {
  if (typeof template !== "string" || !RUN_ID_PATTERN.test(runId)) {
    fail("ISOLATION_RENDER_INPUT_INVALID");
  }
  const workerName = `winerim-fleet-isolation-${runId}`;
  const queueName = `winerim-fleet-isolation-${runId}`;
  const dlqName = `winerim-fleet-isolation-${runId}-dlq`;
  const replacements = { WORKER_NAME: workerName, QUEUE_NAME: queueName, DLQ_NAME: dlqName };
  let rendered = template;
  for (const [key, value] of Object.entries(replacements)) {
    const placeholder = `{{${key}}}`;
    if (!rendered.includes(placeholder)) fail(`ISOLATION_RENDER_${key}_PLACEHOLDER_MISSING`);
    rendered = rendered.replaceAll(placeholder, value);
  }
  if (/\{\{[^}]+\}\}/u.test(rendered)) fail("ISOLATION_RENDER_PLACEHOLDER_REMAINS");
  if ((rendered.match(/\[\[queues\.consumers\]\]/gu) || []).length !== 1) {
    fail("ISOLATION_RENDER_CONSUMER_COUNT_INVALID");
  }
  for (const expected of [
    "max_batch_size = 10",
    "max_concurrency = 2",
    "HARNESS_MODE = \"STAGING_SYNTHETIC_ONLY\"",
    `dead_letter_queue = \"${dlqName}\"`,
  ]) {
    if (!rendered.includes(expected)) fail("ISOLATION_RENDER_CONTRACT_INVALID");
  }
  return Object.freeze({ rendered, workerName, queueName, dlqName });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const template = readFileSync(options.templatePath, "utf8");
  const result = renderIsolationConfig(template, options.runId);
  mkdirSync(dirname(options.outputPath), { recursive: true });
  writeFileSync(options.outputPath, result.rendered, { encoding: "utf8", mode: 0o600 });
  chmodSync(options.outputPath, 0o600);
  process.stdout.write(`${JSON.stringify({
    workerName: result.workerName,
    queueName: result.queueName,
    dlqName: result.dlqName,
    outputPath: options.outputPath,
  }, null, 2)}\n`);
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
