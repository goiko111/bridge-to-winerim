import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const placeholderConnectionId = "00000000-0000-4000-8000-000000000000";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const identifierPattern = /^[A-Za-z0-9_-]{1,128}$/;

export const runtimeCanaryTemplates = Object.freeze({
  runtime: resolve(repoRoot, "wrangler.middleware-runtime-canary.toml.example"),
  executor: resolve(repoRoot, "wrangler.middleware-runtime-executor-canary.toml.example"),
});

function requiredEnvironment(environment, name) {
  const value = String(environment[name] ?? "").trim();
  if (!value) throw new Error(`RUNTIME_CANARY_PREFLIGHT_MISSING_${name}`);
  return value;
}

export function validateRuntimeCanaryEnvironment(environment = process.env) {
  const connectionId = requiredEnvironment(environment, "RUNTIME_CANARY_CONNECTION_ID");
  if (!uuidPattern.test(connectionId) || connectionId === placeholderConnectionId) {
    throw new Error("RUNTIME_CANARY_PREFLIGHT_INVALID_CONNECTION_ID");
  }

  const storeId = requiredEnvironment(environment, "CLOUDFLARE_RUNTIME_VAULT_STORE_ID");
  const secretName = requiredEnvironment(environment, "CLOUDFLARE_RUNTIME_VAULT_SECRET_NAME");
  if (!identifierPattern.test(storeId)) {
    throw new Error("RUNTIME_CANARY_PREFLIGHT_INVALID_STORE_ID");
  }
  if (!identifierPattern.test(secretName)) {
    throw new Error("RUNTIME_CANARY_PREFLIGHT_INVALID_SECRET_NAME");
  }

  return { connectionId, storeId, secretName };
}

function renderTemplate(template, values) {
  const rendered = template
    .replaceAll("{{RUNTIME_CANARY_CONNECTION_ID}}", values.connectionId)
    .replaceAll("{{CLOUDFLARE_RUNTIME_VAULT_STORE_ID}}", values.storeId)
    .replaceAll("{{CLOUDFLARE_RUNTIME_VAULT_SECRET_NAME}}", values.secretName)
    .replace(/^main\s*=\s*"([^"]+)"/m, (_match, entrypoint) => (
      `main = "${resolve(repoRoot, entrypoint)}"`
    ));
  if (/{{[A-Z0-9_]+}}/.test(rendered)) {
    throw new Error("RUNTIME_CANARY_PREFLIGHT_UNRESOLVED_TEMPLATE");
  }
  return rendered;
}

export function renderRuntimeCanaryConfigs({
  environment = process.env,
  outputDir = "/tmp/winerim-runtime-canary-rendered",
} = {}) {
  const values = validateRuntimeCanaryEnvironment(environment);
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });

  const outputs = {};
  for (const [target, templatePath] of Object.entries(runtimeCanaryTemplates)) {
    const outputPath = resolve(outputDir, `wrangler.middleware-runtime-${target}-canary.toml`);
    const rendered = renderTemplate(readFileSync(templatePath, "utf8"), values);
    writeFileSync(outputPath, rendered, { encoding: "utf8", mode: 0o600 });
    chmodSync(outputPath, 0o600);
    outputs[target] = outputPath;
  }
  return outputs;
}

function wranglerPath() {
  return resolve(repoRoot, "node_modules/wrangler/bin/wrangler.js");
}

function runDryRun(target, configPath) {
  const outdir = resolve("/tmp", `winerim-middleware-${target}-canary-dryrun`);
  const result = spawnSync(process.execPath, [
    wranglerPath(),
    "deploy",
    "--config",
    configPath,
    "--env",
    "staging",
    "--dry-run",
    "--outdir",
    outdir,
  ], { cwd: repoRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`RUNTIME_CANARY_WRANGLER_DRYRUN_FAILED_${target.toUpperCase()}`);
}

function argumentValue(prefix) {
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const command = process.argv[2] ?? "render";
  const target = process.argv[3];
  const outputDir = argumentValue("--output-dir=") ?? "/tmp/winerim-runtime-canary-rendered";
  const outputs = renderRuntimeCanaryConfigs({ outputDir });

  if (command === "render") {
    process.stdout.write(`RUNTIME_CANARY_PREFLIGHT_OK output_dir=${outputDir}\n`);
    return;
  }
  if (command !== "dry-run" || !["runtime", "executor"].includes(target)) {
    throw new Error("USAGE: runtime-canary-config.mjs <render|dry-run runtime|dry-run executor>");
  }
  runDryRun(target, outputs[target]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
