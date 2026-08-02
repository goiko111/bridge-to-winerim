import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const runtimeCanaryWorkerName = "winerim-middleware-runtime-canary-staging";

export function buildRuntimeCanaryRemovalCommand({ dryRun = true } = {}) {
  const args = [
    resolve(repoRoot, "node_modules/wrangler/bin/wrangler.js"),
    "delete",
    runtimeCanaryWorkerName,
    "--config",
    resolve(repoRoot, "wrangler.middleware-runtime.toml"),
    "--env",
    "staging",
  ];
  if (dryRun) args.push("--dry-run");
  return { command: process.execPath, args };
}
function main() {
  const apply = process.argv.includes("--apply");
  const dryRun = process.argv.includes("--dry-run");
  if (apply && dryRun) throw new Error("RUNTIME_CANARY_REMOVE_MODE_CONFLICT");

  const confirmation = process.argv
    .find((value) => value.startsWith("--confirm-worker="))
    ?.slice("--confirm-worker=".length);
  if (apply && confirmation !== runtimeCanaryWorkerName) {
    throw new Error(`RUNTIME_CANARY_REMOVE_CONFIRMATION_REQUIRED: --confirm-worker=${runtimeCanaryWorkerName}`);
  }

  const invocation = buildRuntimeCanaryRemovalCommand({ dryRun: dryRun || apply });
  if (!dryRun && !apply) {
    process.stdout.write(JSON.stringify({
      action: "plan-only",
      remoteMutation: false,
      worker: runtimeCanaryWorkerName,
      removesDedicatedWorkerAndConsumer: true,
      dryRunCommand: [invocation.command, ...buildRuntimeCanaryRemovalCommand({ dryRun: true }).args],
      applyRequires: `--apply --confirm-worker=${runtimeCanaryWorkerName}`,
    }, null, 2) + "\n");
    return;
  }

  const executed = buildRuntimeCanaryRemovalCommand({ dryRun: !apply });
  const result = spawnSync(executed.command, executed.args, { cwd: repoRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("RUNTIME_CANARY_REMOVE_COMMAND_FAILED");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
