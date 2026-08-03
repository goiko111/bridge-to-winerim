import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageRoot = resolve(repoRoot, "cloudflare/canary-failclosed");

function read(relativePath) {
  return readFileSync(resolve(packageRoot, relativePath), "utf8");
}

function requireText(source, expected, code) {
  if (!source.includes(expected)) throw new Error(code);
}

function rejectText(source, rejected, code) {
  if (source.includes(rejected)) throw new Error(code);
}

function main() {
  const consumer = read("wrangler.canary-consumer.toml.example");
  const fence = read("wrangler.writer-fence.toml.example");
  const observer = read("wrangler.dlq-observer.toml.example");
  const scope = read("src/exclusiveScope.ts");
  const fenceClient = read("src/writerFence.ts");
  const dlq = read("src/dlqObserver.ts");

  requireText(consumer, 'queue = "{{CANARY_QUEUE_NAME}}"', "CANARY_QUEUE_NOT_TEMPLATED");
  requireText(consumer, 'dead_letter_queue = "{{CANARY_DLQ_QUEUE_NAME}}"', "CANARY_DLQ_NOT_BOUND");
  requireText(consumer, 'binding = "WRITER_FENCE"', "WRITER_FENCE_SERVICE_NOT_BOUND");
  requireText(consumer, 'binding = "CANARY_WRITER_FENCE_PROOF"', "EXCLUSIVE_PROOF_NOT_BOUND");
  rejectText(consumer, "winerim-staging-sales", "SHARED_STAGING_SALES_QUEUE_FORBIDDEN");
  rejectText(consumer, "winerim-rescue-prod-sales", "SHARED_PRODUCTION_SALES_QUEUE_FORBIDDEN");
  rejectText(consumer, "[[queues.producers]]", "CANARY_CONSUMER_MUST_NOT_PRODUCE");
  rejectText(consumer, "[triggers]", "CANARY_CONSUMER_MUST_NOT_SCHEDULE");

  requireText(fence, 'class_name = "ConnectionWriterFence"', "DURABLE_WRITER_LEASE_MISSING");
  requireText(fence, 'binding = "WRITER_FENCE_GRANT"', "WRITER_FENCE_GRANT_NOT_SECRET_BOUND");
  requireText(observer, 'binding = "CANARY_DLQ_ARCHIVE"', "DLQ_ARCHIVE_MISSING");
  requireText(observer, 'binding = "CANARY_DLQ_ALERTS"', "DLQ_ALARM_PRODUCER_MISSING");
  requireText(observer, 'queue = "{{CANARY_DLQ_QUEUE_NAME}}"', "DLQ_CONSUMER_MISSING");
  requireText(observer, 'queue = "{{CANARY_ALARM_QUEUE_NAME}}"', "ALARM_CONSUMER_MISSING");

  requireText(scope, "message.retry", "OUT_OF_SCOPE_MUST_RETRY");
  rejectText(scope, "message.ack", "OUT_OF_SCOPE_ACK_FORBIDDEN");
  requireText(fenceClient, "WRITER_FENCE_EXCLUSIVE_CREDENTIAL_BINDING_MISSING", "FENCE_CREDENTIAL_FAIL_CLOSED_MISSING");
  requireText(fenceClient, "WRITER_FENCE_LEASE_DENIED_", "FENCE_LEASE_FAIL_CLOSED_MISSING");
  requireText(dlq, "await env.CANARY_DLQ_ARCHIVE.put", "DLQ_ARCHIVE_AWAIT_MISSING");
  requireText(dlq, "await env.CANARY_DLQ_ALERTS.send", "DLQ_ALARM_AWAIT_MISSING");

  const integrationArgument = process.argv.find((value) => value.startsWith("--integration-source="));
  if (integrationArgument) {
    const sourcePath = resolve(integrationArgument.slice("--integration-source=".length));
    const integration = readFileSync(sourcePath, "utf8");
    requireText(integration, "guardExclusiveCanaryBatch", "RUNTIME_SCOPE_GUARD_NOT_INTEGRATED");
    requireText(integration, "acquireExclusiveWriterFence", "RUNTIME_WRITER_FENCE_NOT_INTEGRATED");
    requireText(integration, "CANARY_EXCLUSIVE_QUEUE_NAME", "RUNTIME_EXCLUSIVE_QUEUE_NAME_NOT_ENFORCED");
  }

  process.stdout.write("FAILCLOSED_CANARY_PACKAGE_OK remote_mutations=0\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
