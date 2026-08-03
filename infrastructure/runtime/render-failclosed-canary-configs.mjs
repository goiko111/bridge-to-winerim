import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const templateRoot = resolve(repoRoot, "cloudflare/canary-failclosed");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CANARY_MESSAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
const RUN_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/;
const HEX32_PATTERN = /^[a-f0-9]{32}$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/;

function required(environment, name) {
  const value = String(environment[name] ?? "").trim();
  if (!value) throw new Error(`FAILCLOSED_CANARY_RENDER_MISSING_${name}`);
  return value;
}

function outputDirectory() {
  const argument = process.argv.find((value) => value.startsWith("--output-dir="));
  return resolve(argument?.slice("--output-dir=".length) ?? "/tmp/winerim-failclosed-canary");
}

function render(template, values) {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  const unresolved = [...rendered.matchAll(/{{([A-Z0-9_]+)}}/g)].map((match) => match[1]);
  if (unresolved.length > 0) {
    throw new Error(`FAILCLOSED_CANARY_RENDER_UNRESOLVED_${[...new Set(unresolved)].join("_")}`);
  }
  return rendered;
}

export function renderFailclosedCanaryConfigs({
  environment = process.env,
  outputDir = outputDirectory(),
} = {}) {
  const runId = required(environment, "CANARY_RUN_ID");
  const connectionId = required(environment, "CANARY_CONNECTION_ID");
  const messageId = required(environment, "CANARY_MESSAGE_ID");
  const idempotencyKey = required(environment, "CANARY_IDEMPOTENCY_KEY");
  const payloadSha256 = required(environment, "CANARY_PAYLOAD_SHA256").toLowerCase();
  const exclusiveCredentialVersion = required(environment, "CANARY_EXCLUSIVE_CREDENTIAL_VERSION");
  const credentialSetSha256 = required(environment, "CANARY_CREDENTIAL_SET_SHA256").toLowerCase();
  const release = required(environment, "CANARY_RELEASE");
  const holderId = required(environment, "CANARY_HOLDER_ID");
  const hyperdriveId = required(environment, "RUNTIME_HYPERDRIVE_ID");
  const executorService = required(environment, "RUNTIME_EXECUTOR_SERVICE_NAME");
  const runtimeVaultStoreId = required(environment, "RUNTIME_VAULT_STORE_ID");
  const runtimeVaultSecretName = required(environment, "RUNTIME_VAULT_SECRET_NAME");
  const runtimeVaultKeyVersion = required(environment, "RUNTIME_VAULT_KEY_VERSION");
  const fenceService = required(environment, "WRITER_FENCE_SERVICE_NAME");
  const proofStoreId = required(environment, "WRITER_FENCE_PROOF_STORE_ID");
  const proofSecretName = required(environment, "WRITER_FENCE_PROOF_SECRET_NAME");
  const grantStoreId = required(environment, "WRITER_FENCE_GRANT_STORE_ID");
  const grantSecretName = required(environment, "WRITER_FENCE_GRANT_SECRET_NAME");
  const archiveBucket = required(environment, "CANARY_DLQ_ARCHIVE_BUCKET");

  if (!RUN_PATTERN.test(runId)) throw new Error("FAILCLOSED_CANARY_RENDER_INVALID_RUN_ID");
  if (!UUID_PATTERN.test(connectionId)) throw new Error("FAILCLOSED_CANARY_RENDER_INVALID_CONNECTION_ID");
  if (![messageId, idempotencyKey].every((value) => CANARY_MESSAGE_PATTERN.test(value))) {
    throw new Error("FAILCLOSED_CANARY_RENDER_INVALID_MESSAGE_IDENTITY");
  }
  if (!/^[a-f0-9]{64}$/.test(exclusiveCredentialVersion)) {
    throw new Error("FAILCLOSED_CANARY_RENDER_INVALID_CREDENTIAL_VERSION");
  }
  if (!/^[a-f0-9]{64}$/.test(credentialSetSha256)) {
    throw new Error("FAILCLOSED_CANARY_RENDER_INVALID_CREDENTIAL_SET_SHA256");
  }
  if (!KEY_VERSION_PATTERN.test(runtimeVaultKeyVersion)) {
    throw new Error("FAILCLOSED_CANARY_RENDER_INVALID_VAULT_KEY_VERSION");
  }
  if (![release, holderId, executorService, runtimeVaultStoreId,
    runtimeVaultSecretName, fenceService,
    proofStoreId, proofSecretName, grantStoreId, grantSecretName]
    .every((value) => ID_PATTERN.test(value))) {
    throw new Error("FAILCLOSED_CANARY_RENDER_INVALID_IDENTIFIER");
  }
  if (!HEX32_PATTERN.test(hyperdriveId)) throw new Error("FAILCLOSED_CANARY_RENDER_INVALID_HYPERDRIVE_ID");
  if (!/^[a-f0-9]{64}$/.test(payloadSha256)) throw new Error("FAILCLOSED_CANARY_RENDER_INVALID_PAYLOAD_SHA256");
  if (!NAME_PATTERN.test(archiveBucket)) throw new Error("FAILCLOSED_CANARY_RENDER_INVALID_ARCHIVE_BUCKET");

  const queueName = `winerim-rescue-prod-canary-${runId}`;
  const dlqName = `${queueName}-dlq`;
  const alarmName = `${queueName}-alarms`;
  const observerFailureName = `${queueName}-observer-failures`;
  for (const name of [queueName, dlqName, alarmName, observerFailureName]) {
    if (!NAME_PATTERN.test(name)) throw new Error("FAILCLOSED_CANARY_RENDER_QUEUE_NAME_TOO_LONG");
  }
  const forbiddenQueues = new Set([
    "winerim-staging-sales",
    "winerim-rescue-prod-sales",
    "winerim-staging-dead-letter",
    "winerim-rescue-prod-dead-letter",
  ]);
  if ([queueName, dlqName, alarmName, observerFailureName].some((name) => forbiddenQueues.has(name))) {
    throw new Error("FAILCLOSED_CANARY_RENDER_SHARED_QUEUE_REJECTED");
  }

  const values = {
    CANARY_RUN_ID: runId,
    CANARY_CONNECTION_ID: connectionId,
    CANARY_MESSAGE_ID: messageId,
    CANARY_IDEMPOTENCY_KEY: idempotencyKey,
    CANARY_PAYLOAD_SHA256: payloadSha256,
    CANARY_EXCLUSIVE_CREDENTIAL_VERSION: exclusiveCredentialVersion,
    CANARY_CREDENTIAL_SET_SHA256: credentialSetSha256,
    RELEASE: release,
    WRITER_FENCE_HOLDER_ID: holderId,
    RUNTIME_HYPERDRIVE_ID: hyperdriveId,
    RUNTIME_EXECUTOR_SERVICE_NAME: executorService,
    RUNTIME_VAULT_STORE_ID: runtimeVaultStoreId,
    RUNTIME_VAULT_SECRET_NAME: runtimeVaultSecretName,
    RUNTIME_VAULT_KEY_VERSION: runtimeVaultKeyVersion,
    WRITER_FENCE_SERVICE_NAME: fenceService,
    WRITER_FENCE_PROOF_STORE_ID: proofStoreId,
    WRITER_FENCE_PROOF_SECRET_NAME: proofSecretName,
    WRITER_FENCE_GRANT_STORE_ID: grantStoreId,
    WRITER_FENCE_GRANT_SECRET_NAME: grantSecretName,
    CANARY_QUEUE_NAME: queueName,
    CANARY_DLQ_QUEUE_NAME: dlqName,
    CANARY_ALARM_QUEUE_NAME: alarmName,
    CANARY_OBSERVER_FAILURE_QUEUE_NAME: observerFailureName,
    CANARY_DLQ_ARCHIVE_BUCKET: archiveBucket,
  };
  const templates = {
    consumer: "wrangler.canary-consumer.toml.example",
    executor: "wrangler.canary-executor.toml.example",
    fence: "wrangler.writer-fence.toml.example",
    observer: "wrangler.dlq-observer.toml.example",
  };
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const outputs = {};
  for (const [key, templateName] of Object.entries(templates)) {
    const outputPath = resolve(outputDir, `wrangler.${key}.toml`);
    const rendered = render(readFileSync(resolve(templateRoot, templateName), "utf8"), values)
      .replace(/^main\s*=\s*"([^"]+)"/m, (_match, path) => `main = "${resolve(repoRoot, path)}"`);
    writeFileSync(outputPath, rendered, { encoding: "utf8", mode: 0o600 });
    chmodSync(outputPath, 0o600);
    outputs[key] = outputPath;
  }
  const deploymentManifest = {
    version: 2,
    runId,
    connectionId,
    scopeNote: `rescue-canary-run:${runId}`,
    credentialBinding: {
      keyVersion: runtimeVaultKeyVersion,
      exclusiveAttestationSha256: exclusiveCredentialVersion,
      credentialSetSha256,
    },
    resources: {
      queues: {
        input: queueName,
        dlq: dlqName,
        alarms: alarmName,
        observerFailures: observerFailureName,
      },
      workers: {
        consumer: queueName,
        executor: executorService,
        fence: fenceService,
        observer: `winerim-rescue-prod-canary-dlq-observer-${runId}`,
      },
      secrets: {
        vault: runtimeVaultSecretName,
        proof: proofSecretName,
        grant: grantSecretName,
      },
      archiveBucket,
    },
    configSha256: Object.fromEntries(Object.entries(outputs).map(([key, path]) => [
      key,
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ])),
  };
  const manifest = `${JSON.stringify(deploymentManifest, null, 2)}\n`;
  const manifestPath = resolve(outputDir, "canary-deployment-manifest.json");
  writeFileSync(manifestPath, manifest, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(manifestPath, 0o600);
  return {
    outputs,
    queueName,
    dlqName,
    alarmName,
    observerFailureName,
    manifestPath,
    manifestSha256: createHash("sha256").update(manifest).digest("hex"),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = renderFailclosedCanaryConfigs();
    process.stdout.write(`${JSON.stringify({
      status: "FAILCLOSED_CANARY_CONFIGS_RENDERED",
      remoteMutations: 0,
      ...result,
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
