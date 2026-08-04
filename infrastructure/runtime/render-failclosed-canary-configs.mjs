import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const CATALOG_PRODUCT_ID_PATTERN = /^\d+$/;
const WRITER_FENCE_MODES = new Set(["legacy-writer-revoked", "bootstrap-no-legacy-writer"]);
const CANARY_POLICIES = Object.freeze({
  "winerim.sales-import-live": Object.freeze({
    lane: "sales-import",
    exclusiveWriterCredentialKind: "winerim",
    agoraCredentialMode: "shared-read-only",
    agoraCatalogApply: false,
    winerimMutation: true,
  }),
  "catalog.sync-master": Object.freeze({
    lane: "catalog",
    exclusiveWriterCredentialKind: "agora",
    agoraCredentialMode: "exclusive-writer",
    agoraCatalogApply: true,
    winerimMutation: false,
  }),
});

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

function configuredPolicy(environment) {
  const job = String(environment.CANARY_RUNTIME_JOB ?? "winerim.sales-import-live").trim();
  const policy = CANARY_POLICIES[job];
  if (!policy) throw new Error("FAILCLOSED_CANARY_RENDER_INVALID_RUNTIME_JOB");
  const lane = String(environment.CANARY_RUNTIME_LANE ?? policy.lane).trim();
  if (lane !== policy.lane) throw new Error("FAILCLOSED_CANARY_RENDER_INVALID_RUNTIME_JOB_LANE");
  const writerFenceMode = String(
    environment.CANARY_WRITER_FENCE_MODE ?? "legacy-writer-revoked",
  ).trim();
  if (!WRITER_FENCE_MODES.has(writerFenceMode)) {
    throw new Error("FAILCLOSED_CANARY_RENDER_INVALID_WRITER_FENCE_MODE");
  }
  if (writerFenceMode === "bootstrap-no-legacy-writer" && job !== "catalog.sync-master") {
    throw new Error("FAILCLOSED_CANARY_RENDER_BOOTSTRAP_REQUIRES_CATALOG_SCOPE");
  }

  if (job !== "catalog.sync-master") {
    return {
      job,
      ...policy,
      writerFenceMode,
      catalogProductId: "",
      catalogBaseUrl: "",
      catalogAllowedHosts: "",
      catalogProfileJson: "",
    };
  }

  const catalogProductId = required(environment, "CANARY_CATALOG_PRODUCT_ID");
  const catalogBaseUrl = required(environment, "RUNTIME_AGORA_CATALOG_BASE_URL");
  const catalogAllowedHosts = required(environment, "RUNTIME_AGORA_CATALOG_ALLOWED_HOSTS")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const rawProfile = required(environment, "RUNTIME_AGORA_CATALOG_PROFILE_JSON");
  if (!CATALOG_PRODUCT_ID_PATTERN.test(catalogProductId)) {
    throw new Error("FAILCLOSED_CANARY_RENDER_INVALID_CATALOG_PRODUCT_ID");
  }
  let target;
  let catalogProfile;
  try {
    target = new URL(catalogBaseUrl);
    catalogProfile = JSON.parse(rawProfile);
  } catch {
    throw new Error("FAILCLOSED_CANARY_RENDER_INVALID_CATALOG_CONFIGURATION");
  }
  if (
    !["http:", "https:"].includes(target.protocol)
    || target.username
    || target.password
    || target.search
    || target.hash
    || (target.pathname !== "/" && target.pathname !== "")
    || !catalogAllowedHosts.includes(target.host.toLowerCase())
    || !catalogProfile
    || typeof catalogProfile !== "object"
    || Array.isArray(catalogProfile)
  ) {
    throw new Error("FAILCLOSED_CANARY_RENDER_INVALID_CATALOG_CONFIGURATION");
  }
  const catalogProfileJson = JSON.stringify(catalogProfile);
  if ([catalogBaseUrl, catalogAllowedHosts.join(","), catalogProfileJson].some((value) => (
    /['\0\r\n]/.test(value)
  ))) {
    throw new Error("FAILCLOSED_CANARY_RENDER_UNSAFE_CATALOG_CONFIGURATION");
  }
  return {
    job,
    ...policy,
    writerFenceMode,
    catalogProductId,
    catalogBaseUrl,
    catalogAllowedHosts: catalogAllowedHosts.join(","),
    catalogProfileJson,
  };
}

function bundleWithWrangler({ key, entrypoint, renderedConfig, outputDir }) {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
    throw new Error("FAILCLOSED_CANARY_RENDER_NODE_22_REQUIRED");
  }

  const wranglerPath = resolve(repoRoot, "node_modules/wrangler/bin/wrangler.js");
  const inputConfigPath = resolve(outputDir, `.wrangler.${key}.bundle-input.toml`);
  const buildDirectory = resolve(outputDir, `.wrangler-${key}-build`);
  const bundlePath = resolve(outputDir, `worker.${key}.mjs`);
  const sourceConfig = renderedConfig
    .replace(/^main\s*=\s*"([^"]+)"/m, `main = "${entrypoint}"`)
    .replace(/^no_bundle\s*=\s*true\s*\n/m, "");
  writeFileSync(inputConfigPath, sourceConfig, { encoding: "utf8", mode: 0o600 });

  try {
    execFileSync(process.execPath, [
      wranglerPath,
      "deploy",
      "--config",
      inputConfigPath,
      "--dry-run",
      "--outdir",
      buildDirectory,
    ], {
      cwd: repoRoot,
      env: { ...process.env, CI: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const builtWorkers = readdirSync(buildDirectory)
      .filter((name) => name.endsWith(".js") && !name.endsWith(".js.map"));
    if (builtWorkers.length !== 1) {
      throw new Error(`FAILCLOSED_CANARY_WRANGLER_OUTPUT_INVALID_${key.toUpperCase()}`);
    }
    copyFileSync(resolve(buildDirectory, builtWorkers[0]), bundlePath);
    chmodSync(bundlePath, 0o600);
    return bundlePath;
  } catch {
    throw new Error(`FAILCLOSED_CANARY_WRANGLER_BUNDLE_FAILED_${key.toUpperCase()}`);
  } finally {
    rmSync(inputConfigPath, { force: true });
    rmSync(buildDirectory, { recursive: true, force: true });
  }
}

export function renderFailclosedCanaryConfigs({
  environment = process.env,
  outputDir = outputDirectory(),
} = {}) {
  const policy = configuredPolicy(environment);
  const runId = required(environment, "CANARY_RUN_ID");
  const connectionId = required(environment, "CANARY_CONNECTION_ID");
  const messageId = required(environment, "CANARY_MESSAGE_ID");
  const idempotencyKey = required(environment, "CANARY_IDEMPOTENCY_KEY");
  const payloadSha256 = required(environment, "CANARY_PAYLOAD_SHA256").toLowerCase();
  const exclusiveCredentialVersion = required(environment, "CANARY_EXCLUSIVE_CREDENTIAL_VERSION");
  const credentialSetSha256 = required(environment, "CANARY_CREDENTIAL_SET_SHA256").toLowerCase();
  const release = required(environment, "CANARY_RELEASE");
  const holderId = required(environment, "CANARY_HOLDER_ID");
  const proofSha256 = required(environment, "CANARY_WRITER_FENCE_PROOF_SHA256").toLowerCase();
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
  if (!/^[a-f0-9]{64}$/.test(proofSha256)) {
    throw new Error("FAILCLOSED_CANARY_RENDER_INVALID_WRITER_FENCE_PROOF_SHA256");
  }
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
    CANARY_RUNTIME_JOB: policy.job,
    CANARY_RUNTIME_LANE: policy.lane,
    CANARY_CATALOG_PRODUCT_ID: policy.catalogProductId,
    RUNTIME_AGORA_CREDENTIAL_MODE: policy.agoraCredentialMode,
    RUNTIME_CATALOG_EXECUTION_ENABLED: String(policy.agoraCatalogApply),
    RUNTIME_CATALOG_APPLY_ENABLED: String(policy.agoraCatalogApply),
    RUNTIME_AGORA_CATALOG_BASE_URL: policy.catalogBaseUrl,
    RUNTIME_AGORA_CATALOG_ALLOWED_HOSTS: policy.catalogAllowedHosts,
    RUNTIME_AGORA_CATALOG_PROFILE_JSON: policy.catalogProfileJson,
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
  const entrypoints = Object.fromEntries(Object.entries(templates).map(([key, templateName]) => {
    const template = readFileSync(resolve(templateRoot, templateName), "utf8");
    const main = template.match(/^main\s*=\s*"([^"]+)"/m)?.[1];
    if (!main) throw new Error(`FAILCLOSED_CANARY_RENDER_MAIN_MISSING_${key.toUpperCase()}`);
    return [key, resolve(repoRoot, main)];
  }));
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const outputs = {};
  const bundles = {};
  for (const [key, templateName] of Object.entries(templates)) {
    const template = readFileSync(resolve(templateRoot, templateName), "utf8");
    const sourceConfig = render(template, values);
    const bundlePath = bundleWithWrangler({
      key,
      entrypoint: entrypoints[key],
      renderedConfig: sourceConfig,
      outputDir,
    });
    const outputPath = resolve(outputDir, `wrangler.${key}.toml`);
    const rendered = sourceConfig
      .replace(/^main\s*=\s*"([^"]+)"/m, `main = "${bundlePath}"\nno_bundle = true`);
    writeFileSync(outputPath, rendered, { encoding: "utf8", mode: 0o600 });
    chmodSync(outputPath, 0o600);
    outputs[key] = outputPath;
    bundles[key] = bundlePath;
  }
  const deploymentManifest = {
    version: 4,
    runId,
    connectionId,
    scopeNote: `rescue-canary-run:${runId}`,
    credentialBinding: {
      keyVersion: runtimeVaultKeyVersion,
      exclusiveAttestationSha256: exclusiveCredentialVersion,
      credentialSetSha256,
    },
    writerFence: {
      mode: policy.writerFenceMode,
      holderId,
      proofSha256,
      exclusiveCredentialRef:
        `runtime-vault://postgres/${connectionId}/agora/${policy.exclusiveWriterCredentialKind}`,
      credentialBinding: createHash("sha256").update([
        "winerim-writer-fence-credential",
        "1",
        `runtime-vault://postgres/${connectionId}/agora/${policy.exclusiveWriterCredentialKind}`,
        exclusiveCredentialVersion,
      ].join("|")).digest("hex"),
    },
    scopePolicy: {
      job: policy.job,
      lane: policy.lane,
      maxOperations: 1,
      productId: policy.catalogProductId || null,
    },
    credentialPolicy: {
      exclusiveWriterCredentialKind: policy.exclusiveWriterCredentialKind,
      agoraCredentialMode: policy.agoraCredentialMode,
    },
    mutationPolicy: {
      agoraCatalogApply: policy.agoraCatalogApply,
      agoraOutboundMutation: false,
      winerimMutation: policy.winerimMutation,
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
    bundleSha256: Object.fromEntries(Object.entries(bundles).map(([key, path]) => [
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
    bundles,
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
