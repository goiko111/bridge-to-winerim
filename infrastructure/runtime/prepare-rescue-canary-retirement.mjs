import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/;
const RESOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

function required(environment, name) {
  const value = String(environment[name] ?? "").trim();
  if (!value) throw new Error(`RESCUE_CANARY_RETIREMENT_MISSING_${name}`);
  return value;
}

function parseTimestamp(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("RESCUE_CANARY_RETIREMENT_INVALID_APPROVED_AT");
  return new Date(parsed).toISOString();
}

export function renderRescueCanaryRetirementSql({ connectionId, runId, approvedAt }) {
  if (!UUID_PATTERN.test(connectionId)) throw new Error("RESCUE_CANARY_RETIREMENT_INVALID_CONNECTION_ID");
  if (!RUN_PATTERN.test(runId)) throw new Error("RESCUE_CANARY_RETIREMENT_INVALID_RUN_ID");
  const expectedApprovedAt = parseTimestamp(approvedAt);
  const scopeNote = `rescue-canary-run:${runId}`;
  return `\\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE public.pos_connections,
  public.runtime_canary_connections,
  public.runtime_connection_credentials
  IN SHARE ROW EXCLUSIVE MODE;

DO $verify_rescue_canary_retirement$
BEGIN
  IF (
    SELECT count(*)
    FROM public.pos_connections
    WHERE id = '${connectionId}'::uuid
      AND provider = 'agora'
      AND catalog_sync_enabled = false
      AND sync_mode = 'PULL_ONLY'
      AND write_mode = 'NONE'
      AND backfill_days = 0
  ) <> 1 THEN
    RAISE EXCEPTION 'retirement candidate is missing or outside reviewed safe mode';
  END IF;
  IF (
    SELECT count(*)
    FROM public.runtime_canary_connections
    WHERE connection_id = '${connectionId}'::uuid
      AND active = true
      AND approved_at = '${expectedApprovedAt}'::timestamptz
      AND note = '${scopeNote}'
  ) <> 1 THEN
    RAISE EXCEPTION 'exact canary scope identity does not match';
  END IF;
  IF (
    SELECT count(*)
    FROM public.runtime_canary_connections
    WHERE active = true
      AND connection_id <> '${connectionId}'::uuid
  ) <> 0 THEN
    RAISE EXCEPTION 'another active canary scope exists';
  END IF;
END;
$verify_rescue_canary_retirement$;

UPDATE public.runtime_connection_credentials
SET active = false
WHERE connection_id = '${connectionId}'::uuid;

UPDATE public.runtime_canary_connections
SET active = false
WHERE connection_id = '${connectionId}'::uuid
  AND active = true
  AND approved_at = '${expectedApprovedAt}'::timestamptz;

UPDATE public.pos_connections
SET enabled = false,
    catalog_sync_enabled = false,
    sync_mode = 'PULL_ONLY',
    write_mode = 'NONE',
    backfill_days = 0
WHERE id = '${connectionId}'::uuid;

DO $readback_rescue_canary_retirement$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid AND active = true
  )
    OR EXISTS (SELECT 1 FROM public.runtime_canary_connections WHERE active = true)
    OR EXISTS (
      SELECT 1 FROM public.pos_connections
      WHERE id = '${connectionId}'::uuid
        AND (enabled OR catalog_sync_enabled OR sync_mode <> 'PULL_ONLY' OR write_mode <> 'NONE' OR backfill_days <> 0)
    ) THEN
    RAISE EXCEPTION 'rescue canary retirement readback failed';
  END IF;
END;
$readback_rescue_canary_retirement$;

COMMIT;
`;
}

function deploymentResources(deploymentManifest, connectionId, runId) {
  if (
    deploymentManifest?.version !== 1
    || deploymentManifest.connectionId !== connectionId
    || deploymentManifest.runId !== runId
    || deploymentManifest.scopeNote !== `rescue-canary-run:${runId}`
  ) {
    throw new Error("RESCUE_CANARY_RETIREMENT_DEPLOYMENT_MANIFEST_SCOPE_MISMATCH");
  }
  const resources = deploymentManifest.resources;
  const queueName = `winerim-rescue-prod-canary-${runId}`;
  const expected = {
    queues: {
      input: queueName,
      dlq: `${queueName}-dlq`,
      alarms: `${queueName}-alarms`,
      observerFailures: `${queueName}-observer-failures`,
    },
    workers: {
      consumer: queueName,
      observer: `winerim-rescue-prod-canary-dlq-observer-${runId}`,
    },
  };
  if (
    !resources
    || Object.entries(expected.queues).some(([key, value]) => resources.queues?.[key] !== value)
    || Object.entries(expected.workers).some(([key, value]) => resources.workers?.[key] !== value)
  ) {
    throw new Error("RESCUE_CANARY_RETIREMENT_DEPLOYMENT_MANIFEST_RESOURCE_MISMATCH");
  }
  const namedResources = [
    resources.workers.executor,
    resources.workers.fence,
    resources.secrets?.vault,
    resources.secrets?.proof,
    resources.secrets?.grant,
    resources.archiveBucket,
  ];
  if (namedResources.some((value) => !RESOURCE_PATTERN.test(value))) {
    throw new Error("RESCUE_CANARY_RETIREMENT_INVALID_RESOURCE_NAME");
  }
  return resources;
}

export function rescueCanaryRetirementPlan({
  connectionId,
  runId,
  approvedAt,
  deploymentManifest,
  deploymentManifestSha256,
}) {
  if (!UUID_PATTERN.test(connectionId)) throw new Error("RESCUE_CANARY_RETIREMENT_INVALID_CONNECTION_ID");
  if (!RUN_PATTERN.test(runId)) throw new Error("RESCUE_CANARY_RETIREMENT_INVALID_RUN_ID");
  if (!SHA256_PATTERN.test(deploymentManifestSha256)) {
    throw new Error("RESCUE_CANARY_RETIREMENT_INVALID_DEPLOYMENT_MANIFEST_SHA256");
  }
  const resources = deploymentResources(deploymentManifest, connectionId, runId);
  const expectedApprovedAt = parseTimestamp(approvedAt);
  const queues = Object.values(resources.queues);
  const workers = [
    resources.workers.consumer,
    resources.workers.observer,
    resources.workers.executor,
    resources.workers.fence,
  ];
  return {
    status: "RESCUE_CANARY_RETIREMENT_PLAN_READY",
    remoteMutations: 0,
    connectionId,
    runId,
    approvedAt: expectedApprovedAt,
    scopeNote: `rescue-canary-run:${runId}`,
    deploymentManifestSha256,
    database: {
      behavior: "deactivate-only",
      preservesEvidence: true,
      deletesRows: false,
      disablesConnection: true,
    },
    cloudflareOrder: [
      { step: 1, action: "pause-exclusive-consumer", resources: [resources.workers.consumer] },
      { step: 2, action: "verify-all-queues-empty-or-archived", resources: queues },
      { step: 3, action: "apply-reviewed-database-retirement-sql", resource: connectionId },
      {
        step: 4,
        action: "revoke-canary-proof-grant-and-vault-bindings",
        resources: [resources.secrets.proof, resources.secrets.grant, resources.secrets.vault],
      },
      { step: 5, action: "delete-dedicated-workers-after-readback", resources: workers },
      { step: 6, action: "delete-dedicated-queues-after-readback", resources: queues },
      { step: 7, action: "preserve-dlq-and-alarm-ledger", resources: [resources.archiveBucket] },
    ],
    databaseFailureAction: "keep resources; verify scope and credentials; require a fresh gate before consumer resume",
    forbidden: ["shared-queue-delete", "row-delete", "truncate", "stock-write", "cursor-write"],
  };
}

export function prepareRescueCanaryRetirement({ environment = process.env, outputDir }) {
  const connectionId = required(environment, "CANARY_CONNECTION_ID");
  const runId = required(environment, "CANARY_RUN_ID");
  const approvedAt = required(environment, "CANARY_SCOPE_APPROVED_AT");
  const deploymentManifestPath = resolve(required(environment, "CANARY_DEPLOYMENT_MANIFEST"));
  const expectedManifestSha256 = required(environment, "CANARY_DEPLOYMENT_MANIFEST_SHA256").toLowerCase();
  if (!SHA256_PATTERN.test(expectedManifestSha256)) {
    throw new Error("RESCUE_CANARY_RETIREMENT_INVALID_DEPLOYMENT_MANIFEST_SHA256");
  }
  const manifestSource = readFileSync(deploymentManifestPath, "utf8");
  const actualManifestSha256 = createHash("sha256").update(manifestSource).digest("hex");
  if (actualManifestSha256 !== expectedManifestSha256) {
    throw new Error("RESCUE_CANARY_RETIREMENT_DEPLOYMENT_MANIFEST_SHA256_MISMATCH");
  }
  let deploymentManifest;
  try {
    deploymentManifest = JSON.parse(manifestSource);
  } catch {
    throw new Error("RESCUE_CANARY_RETIREMENT_DEPLOYMENT_MANIFEST_INVALID_JSON");
  }
  const plan = rescueCanaryRetirementPlan({
    connectionId,
    runId,
    approvedAt,
    deploymentManifest,
    deploymentManifestSha256: actualManifestSha256,
  });
  const directory = resolve(outputDir);
  const relativeDirectory = relative(repoRoot, directory);
  if (relativeDirectory === "" || (!relativeDirectory.startsWith("..") && !relativeDirectory.startsWith("/"))) {
    throw new Error("RESCUE_CANARY_RETIREMENT_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const realDirectory = realpathSync(directory);
  const realRelativeDirectory = relative(repoRoot, realDirectory);
  if (
    realRelativeDirectory === ""
    || (!realRelativeDirectory.startsWith("..") && !realRelativeDirectory.startsWith("/"))
  ) {
    throw new Error("RESCUE_CANARY_RETIREMENT_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  const sqlPath = resolve(directory, "retire-rescue-canary.sql");
  const retirementManifestPath = resolve(directory, "retire-rescue-canary.json");
  const sql = renderRescueCanaryRetirementSql({ connectionId, runId, approvedAt });
  const manifest = `${JSON.stringify(plan, null, 2)}\n`;
  writeFileSync(sqlPath, sql, { encoding: "utf8", mode: 0o600, flag: "wx" });
  writeFileSync(retirementManifestPath, manifest, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(sqlPath, 0o600);
  chmodSync(retirementManifestPath, 0o600);
  return {
    ...plan,
    sqlPath,
    manifestPath: retirementManifestPath,
    sqlSha256: createHash("sha256").update(sql).digest("hex"),
    manifestSha256: createHash("sha256").update(manifest).digest("hex"),
  };
}

function argument(name) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function main() {
  if (!process.argv.includes("--render")) {
    process.stdout.write(`${JSON.stringify({
      status: "RESCUE_CANARY_RETIREMENT_PLAN_ONLY",
      remoteMutations: 0,
      requiredEnvironment: [
        "CANARY_CONNECTION_ID",
        "CANARY_RUN_ID",
        "CANARY_SCOPE_APPROVED_AT",
        "CANARY_DEPLOYMENT_MANIFEST",
        "CANARY_DEPLOYMENT_MANIFEST_SHA256",
      ],
      renderGate: "--render --confirm-connection=<UUID> --output-dir=/secure/path",
    }, null, 2)}\n`);
    return;
  }
  const connectionId = required(process.env, "CANARY_CONNECTION_ID");
  if (argument("--confirm-connection") !== connectionId) {
    throw new Error("RESCUE_CANARY_RETIREMENT_CONNECTION_CONFIRMATION_REQUIRED");
  }
  const outputDir = argument("--output-dir");
  if (!outputDir) throw new Error("RESCUE_CANARY_RETIREMENT_OUTPUT_DIR_REQUIRED");
  process.stdout.write(`${JSON.stringify(prepareRescueCanaryRetirement({ outputDir }), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
