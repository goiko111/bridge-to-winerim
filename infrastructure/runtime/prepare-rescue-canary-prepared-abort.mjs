import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/;
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

function required(environment, name) {
  const value = String(environment[name] ?? "").trim();
  if (!value) throw new Error(`RESCUE_CANARY_PREPARED_ABORT_MISSING_${name}`);
  return value;
}

export function renderRescueCanaryPreparedAbortSql({ connectionId, runId }) {
  if (!UUID_PATTERN.test(connectionId)) {
    throw new Error("RESCUE_CANARY_PREPARED_ABORT_INVALID_CONNECTION_ID");
  }
  if (!RUN_PATTERN.test(runId)) {
    throw new Error("RESCUE_CANARY_PREPARED_ABORT_INVALID_RUN_ID");
  }
  const scopeNote = `rescue-canary-run:${runId}`;

  return `BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20s';
SELECT pg_advisory_xact_lock(hashtextextended('runtime-canary-control-plane', 0));

LOCK TABLE public.pos_connections,
  public.runtime_canary_connections,
  public.runtime_connection_credentials
  IN SHARE ROW EXCLUSIVE MODE;

DO $verify_rescue_canary_prepared_abort$
BEGIN
  IF (
    SELECT count(*)
    FROM public.pos_connections
    WHERE id = '${connectionId}'::uuid
      AND provider = 'agora'
      AND enabled = false
      AND catalog_sync_enabled = false
      AND sync_mode = 'PULL_ONLY'
      AND write_mode = 'NONE'
      AND backfill_days = 0
  ) <> 1 THEN
    RAISE EXCEPTION 'prepared abort candidate is missing or connection is not inert';
  END IF;
  IF (
    SELECT count(*)
    FROM public.runtime_canary_connections
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND note = '${scopeNote}'
      AND status = 'PREPARED'
      AND active = false
      AND approved_at IS NULL
      AND expires_at IS NULL
      AND deployment_manifest_sha256 IS NULL
      AND writer_fence_grant_sha256 IS NULL
      AND credential_set_sha256 IS NULL
      AND activated_at IS NULL
      AND retired_at IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'exact prepared canary scope is missing or already consumed';
  END IF;
  IF (
    SELECT count(*)
    FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
  ) <> 2 OR (
    SELECT count(*)
    FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND provider = 'agora'
      AND credential_kind IN ('agora', 'winerim')
      AND active = false
      AND activated_at IS NULL
      AND retired_at IS NULL
  ) <> 2 OR (
    SELECT count(DISTINCT credential_kind)
    FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND credential_kind IN ('agora', 'winerim')
  ) <> 2 THEN
    RAISE EXCEPTION 'exact inactive prepared credential generation does not match';
  END IF;
END;
$verify_rescue_canary_prepared_abort$;

UPDATE public.runtime_connection_credentials
SET retired_at = transaction_timestamp()
WHERE connection_id = '${connectionId}'::uuid
  AND run_id = '${runId}'
  AND active = false
  AND activated_at IS NULL
  AND retired_at IS NULL;

UPDATE public.runtime_canary_connections
SET status = 'ABORTED',
    retired_at = transaction_timestamp()
WHERE connection_id = '${connectionId}'::uuid
  AND run_id = '${runId}'
  AND status = 'PREPARED'
  AND active = false
  AND activated_at IS NULL
  AND retired_at IS NULL;

DO $readback_rescue_canary_prepared_abort$
BEGIN
  IF (
    SELECT count(*)
    FROM public.runtime_canary_connections
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND note = '${scopeNote}'
      AND status = 'ABORTED'
      AND active = false
      AND approved_at IS NULL
      AND expires_at IS NULL
      AND deployment_manifest_sha256 IS NULL
      AND writer_fence_grant_sha256 IS NULL
      AND credential_set_sha256 IS NULL
      AND activated_at IS NULL
      AND retired_at IS NOT NULL
  ) <> 1 OR (
    SELECT count(*)
    FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid
      AND run_id = '${runId}'
      AND provider = 'agora'
      AND credential_kind IN ('agora', 'winerim')
      AND active = false
      AND activated_at IS NULL
      AND retired_at IS NOT NULL
  ) <> 2 OR EXISTS (
    SELECT 1
    FROM public.pos_connections
    WHERE id = '${connectionId}'::uuid
      AND (
        provider <> 'agora'
        OR enabled
        OR catalog_sync_enabled
        OR sync_mode <> 'PULL_ONLY'
        OR write_mode <> 'NONE'
        OR backfill_days <> 0
      )
  ) THEN
    RAISE EXCEPTION 'prepared canary abort readback failed';
  END IF;
END;
$readback_rescue_canary_prepared_abort$;

COMMIT;
`;
}

export function rescueCanaryPreparedAbortPlan({ connectionId, runId }) {
  if (!UUID_PATTERN.test(connectionId)) {
    throw new Error("RESCUE_CANARY_PREPARED_ABORT_INVALID_CONNECTION_ID");
  }
  if (!RUN_PATTERN.test(runId)) {
    throw new Error("RESCUE_CANARY_PREPARED_ABORT_INVALID_RUN_ID");
  }
  return {
    status: "RESCUE_CANARY_PREPARED_ABORT_PLAN_READY",
    remoteMutations: 0,
    connectionId,
    runId,
    scopeNote: `rescue-canary-run:${runId}`,
    database: {
      transition: "PREPARED_TO_ABORTED",
      requiresInactiveScope: true,
      requiresExactlyTwoInactiveCredentials: true,
      requiresInertConnection: true,
      preservesRows: true,
      deletesRows: false,
      activatesCredentials: false,
    },
  };
}

export function prepareRescueCanaryPreparedAbort({ environment = process.env, output }) {
  const connectionId = required(environment, "CANARY_CONNECTION_ID");
  const runId = required(environment, "CANARY_RUN_ID");
  const plan = rescueCanaryPreparedAbortPlan({ connectionId, runId });
  const target = resolve(output);
  const relativeTarget = relative(repoRoot, target);
  if (relativeTarget === "" || (!relativeTarget.startsWith("..") && !relativeTarget.startsWith("/"))) {
    throw new Error("RESCUE_CANARY_PREPARED_ABORT_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const realParent = realpathSync(dirname(target));
  const realRelativeParent = relative(repoRoot, realParent);
  if (realRelativeParent === "" || (!realRelativeParent.startsWith("..") && !realRelativeParent.startsWith("/"))) {
    throw new Error("RESCUE_CANARY_PREPARED_ABORT_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  const sql = renderRescueCanaryPreparedAbortSql({ connectionId, runId });
  writeFileSync(target, sql, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(target, 0o600);
  return {
    ...plan,
    sqlPath: target,
    sqlSha256: createHash("sha256").update(sql).digest("hex"),
  };
}

function argument(name) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function main() {
  if (!process.argv.includes("--render")) {
    process.stdout.write(`${JSON.stringify({
      status: "RESCUE_CANARY_PREPARED_ABORT_PLAN_ONLY",
      remoteMutations: 0,
      requiredEnvironment: ["CANARY_CONNECTION_ID", "CANARY_RUN_ID"],
      renderGate: "--render --confirm-connection=<UUID> --output=/secure/path/abort-prepared.sql",
    }, null, 2)}\n`);
    return;
  }
  const connectionId = required(process.env, "CANARY_CONNECTION_ID");
  if (argument("--confirm-connection") !== connectionId) {
    throw new Error("RESCUE_CANARY_PREPARED_ABORT_CONNECTION_CONFIRMATION_REQUIRED");
  }
  const output = argument("--output");
  if (!output) throw new Error("RESCUE_CANARY_PREPARED_ABORT_OUTPUT_REQUIRED");
  process.stdout.write(`${JSON.stringify(prepareRescueCanaryPreparedAbort({ output }), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
