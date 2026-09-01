import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MIN_DRAIN_MS = 130_000;
const CAPTURE_SEPARATION_MS = 5_000;
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

// These are the only provider_config switches read by the current Agora scheduler.
// Unknown scheduler-looking keys fail closed instead of being guessed or silently ignored.
const KNOWN_PROVIDER_SCHEDULER_KEYS = Object.freeze([
  "intraday_sales_sync_enabled",
  "open_tickets_stock_sync_enabled",
  "open_tickets_sync_enabled",
]);
const SCHEDULER_LIKE_KEY_PATTERN = /(?:^|_)(?:cron|schedule|scheduler|sync)(?:_|$).*?(?:active|enabled)$/i;
const SECRET_KEY_PATTERN = /(?:^|[_-])(?:api[_-]?token|winerim[_-]?(?:api[_-]?)?token|token|secret|password|authorization|bearer|credential|private[_-]?key)(?:$|[_-])/i;

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
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

function plainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function rowsFrom(document) {
  const rows = Array.isArray(document)
    ? document
    : document?.connections ?? document?.rows ?? document?.data;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("LOVABLE_CONNECTION_FENCE_INVALID_SNAPSHOT_CONTRACT");
  }
  return rows;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlBoolean(value) {
  return value ? "true" : "false";
}

function isOutsideRepository(path) {
  const candidate = relative(repoRoot, path);
  return candidate !== "" && (candidate.startsWith("..") || candidate.startsWith("/"));
}

function secretKey(value) {
  const normalized = String(value).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return SECRET_KEY_PATTERN.test(normalized);
}

function collectSecretValues(value, inheritedSecret = false, target = new Set()) {
  if (!value || typeof value !== "object") return target;
  for (const [key, nested] of Object.entries(value)) {
    const secret = inheritedSecret || secretKey(key);
    if (secret && typeof nested === "string" && nested.length >= 4) target.add(nested);
    if (nested && typeof nested === "object") collectSecretValues(nested, secret, target);
  }
  return target;
}

function assertNoSecretDisclosure(sources, secretValues) {
  for (const source of sources) {
    for (const secret of secretValues) {
      if (source.includes(secret)) {
        throw new Error("LOVABLE_CONNECTION_FENCE_SECRET_VALUE_IN_OUTPUT");
      }
    }
  }
}

function readPrivateSnapshot(path) {
  if (!path || !isAbsolute(path)) {
    throw new Error("LOVABLE_CONNECTION_FENCE_SNAPSHOT_PATH_MUST_BE_ABSOLUTE");
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("LOVABLE_CONNECTION_FENCE_SNAPSHOT_MUST_BE_REGULAR_FILE");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("LOVABLE_CONNECTION_FENCE_SNAPSHOT_MUST_BE_PRIVATE_0600");
  }
  if (metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) {
    throw new Error("LOVABLE_CONNECTION_FENCE_SNAPSHOT_INVALID_SIZE");
  }
  return readFileSync(path);
}

function parseJson(source) {
  try {
    return JSON.parse(source.toString("utf8"));
  } catch {
    throw new Error("LOVABLE_CONNECTION_FENCE_INVALID_SNAPSHOT_JSON");
  }
}

function requiredColumns(row) {
  for (const column of ["id", "provider", "enabled", "catalog_sync_enabled", "provider_config"]) {
    if (!Object.hasOwn(row, column)) {
      throw new Error(`LOVABLE_CONNECTION_FENCE_MISSING_COLUMN_${column.toUpperCase()}`);
    }
  }
}

export function lovableConnectionStateSha256(row) {
  if (!plainObject(row)) throw new Error("LOVABLE_CONNECTION_FENCE_ROW_MUST_BE_OBJECT");
  return sha256(canonicalJson(row));
}

function controlState(row, schedulerKeys) {
  return {
    id: row.id,
    provider: row.provider,
    enabled: row.enabled,
    catalogSyncEnabled: row.catalog_sync_enabled,
    providerSchedulers: Object.fromEntries(schedulerKeys.map((key) => [
      key,
      row.provider_config[key],
    ])),
  };
}

function schedulerKeysFrom(providerConfig) {
  const known = new Set(KNOWN_PROVIDER_SCHEDULER_KEYS);
  const unknown = Object.keys(providerConfig)
    .filter((key) => SCHEDULER_LIKE_KEY_PATTERN.test(key) && !known.has(key))
    .sort();
  if (unknown.length > 0) {
    throw new Error(`LOVABLE_CONNECTION_FENCE_UNSUPPORTED_SCHEDULER_KEYS_${sha256(canonicalJson(unknown))}`);
  }
  return KNOWN_PROVIDER_SCHEDULER_KEYS.filter((key) => Object.hasOwn(providerConfig, key));
}

export function validateLovableConnectionFenceInput({
  snapshotDocument,
  snapshotSha256,
  connectionId,
  expectedStateSha256,
}) {
  if (!SHA256_PATTERN.test(snapshotSha256 ?? "")) {
    throw new Error("LOVABLE_CONNECTION_FENCE_INVALID_SNAPSHOT_SHA256");
  }
  if (!UUID_PATTERN.test(connectionId ?? "")) {
    throw new Error("LOVABLE_CONNECTION_FENCE_INVALID_CONNECTION_ID");
  }
  if (!SHA256_PATTERN.test(expectedStateSha256 ?? "")) {
    throw new Error("LOVABLE_CONNECTION_FENCE_INVALID_EXPECTED_STATE_SHA256");
  }

  const matches = rowsFrom(snapshotDocument).filter((row) => row?.id === connectionId);
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? "LOVABLE_CONNECTION_FENCE_CONNECTION_NOT_FOUND"
      : "LOVABLE_CONNECTION_FENCE_DUPLICATE_CONNECTION_ID");
  }
  const row = matches[0];
  if (!plainObject(row)) throw new Error("LOVABLE_CONNECTION_FENCE_ROW_MUST_BE_OBJECT");
  requiredColumns(row);
  if (row.provider !== "agora") {
    throw new Error("LOVABLE_CONNECTION_FENCE_PROVIDER_NOT_AGORA");
  }
  if (typeof row.enabled !== "boolean" || typeof row.catalog_sync_enabled !== "boolean") {
    throw new Error("LOVABLE_CONNECTION_FENCE_CONTROL_COLUMNS_MUST_BE_BOOLEAN");
  }
  if (!plainObject(row.provider_config)) {
    throw new Error("LOVABLE_CONNECTION_FENCE_PROVIDER_CONFIG_MUST_BE_OBJECT");
  }
  const actualStateSha256 = lovableConnectionStateSha256(row);
  if (actualStateSha256 !== expectedStateSha256) {
    throw new Error("LOVABLE_CONNECTION_FENCE_EXPECTED_STATE_SHA256_MISMATCH");
  }

  const schedulerKeys = schedulerKeysFrom(row.provider_config);
  for (const key of schedulerKeys) {
    if (typeof row.provider_config[key] !== "boolean") {
      throw new Error(`LOVABLE_CONNECTION_FENCE_SCHEDULER_NOT_BOOLEAN_${key.toUpperCase()}`);
    }
  }
  if (
    row.enabled === false
    && row.catalog_sync_enabled === false
    && schedulerKeys.every((key) => row.provider_config[key] === false)
  ) {
    throw new Error("LOVABLE_CONNECTION_FENCE_ALREADY_FENCED");
  }

  const before = controlState(row, schedulerKeys);
  const after = {
    ...before,
    enabled: false,
    catalogSyncEnabled: false,
    providerSchedulers: Object.fromEntries(schedulerKeys.map((key) => [key, false])),
  };
  return {
    connectionId,
    snapshotSha256,
    stateSha256: actualStateSha256,
    controlStateSha256: sha256(canonicalJson(before)),
    fencedControlStateSha256: sha256(canonicalJson(after)),
    schedulerKeys,
    before,
    after,
    secretValues: collectSecretValues(row),
  };
}

function schedulerGuard(providerConfig, keys) {
  return keys.map((key) => [
    `provider_config ? ${sqlLiteral(key)}`,
    `jsonb_typeof(provider_config -> ${sqlLiteral(key)}) = 'boolean'`,
    `(provider_config ->> ${sqlLiteral(key)})::boolean = ${sqlBoolean(providerConfig[key])}`,
  ].join("\n        AND ")).join("\n        AND ");
}

function providerConfigMutation(base, keys, values) {
  return keys.reduce(
    (expression, key) => `jsonb_set(${expression}, ARRAY[${sqlLiteral(key)}], '${sqlBoolean(values[key])}'::jsonb, false)`,
    base,
  );
}

function renderMutationSql(plan, direction) {
  const applying = direction === "apply";
  const expected = applying ? plan.before : plan.after;
  const desired = applying ? plan.after : plan.before;
  const providerGuard = schedulerGuard(expected.providerSchedulers, plan.schedulerKeys);
  const configExpression = providerConfigMutation(
    "provider_config",
    plan.schedulerKeys,
    desired.providerSchedulers,
  );
  const expectedLabel = applying ? plan.controlStateSha256 : plan.fencedControlStateSha256;
  const desiredLabel = applying ? plan.fencedControlStateSha256 : plan.controlStateSha256;
  const operation = applying ? "APPLY" : "ROLLBACK";
  return `-- LOVABLE_CONNECTION_FENCE_${operation}_V1
-- connection_id: ${plan.connectionId}
-- expected_control_state_sha256: ${expectedLabel}
-- desired_control_state_sha256: ${desiredLabel}
-- This file is an inert artifact until an operator executes it explicitly.
BEGIN;
DO $lovable_connection_fence$
DECLARE
  affected integer;
BEGIN
  UPDATE public.pos_connections
  SET enabled = ${sqlBoolean(desired.enabled)},
      catalog_sync_enabled = ${sqlBoolean(desired.catalogSyncEnabled)},
      provider_config = ${configExpression}
  WHERE id = ${sqlLiteral(plan.connectionId)}::uuid
    AND provider = 'agora'
    AND enabled = ${sqlBoolean(expected.enabled)}
    AND catalog_sync_enabled = ${sqlBoolean(expected.catalogSyncEnabled)}${providerGuard ? `
    AND ${providerGuard}` : ""};

  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'LOVABLE_CONNECTION_FENCE_${operation}_STATE_MISMATCH expected one row, changed %', affected;
  END IF;
END
$lovable_connection_fence$;
COMMIT;
`;
}

export function renderLovableConnectionFenceApplySql(plan) {
  return renderMutationSql(plan, "apply");
}

export function renderLovableConnectionFenceRollbackSql(plan) {
  return renderMutationSql(plan, "rollback");
}

export function renderLovableConnectionFenceReadbackSql(plan, expected = "fenced") {
  const state = expected === "original" ? plan.before : plan.after;
  const schedulerFields = plan.schedulerKeys.length > 0
    ? plan.schedulerKeys.map((key) => (
      `${sqlLiteral(key)}, provider_config -> ${sqlLiteral(key)}`
    )).join(",\n      ")
    : "'_none', NULL";
  const assertions = plan.schedulerKeys.map((key) => (
    `(provider_config ->> ${sqlLiteral(key)})::boolean = ${sqlBoolean(state.providerSchedulers[key])}`
  ));
  return `-- LOVABLE_CONNECTION_FENCE_READBACK_V1 (${expected})
SELECT
  id,
  provider,
  enabled,
  catalog_sync_enabled,
  jsonb_build_object(
      ${schedulerFields}
  ) AS provider_scheduler_state,
  updated_at,
  (
    provider = 'agora'
    AND enabled = ${sqlBoolean(state.enabled)}
    AND catalog_sync_enabled = ${sqlBoolean(state.catalogSyncEnabled)}${assertions.length ? `
    AND ${assertions.join("\n    AND ")}` : ""}
  ) AS expected_control_state
FROM public.pos_connections
WHERE id = ${sqlLiteral(plan.connectionId)}::uuid;
`;
}

function manifestFor(plan, applySql, rollbackSql, fencedReadbackSql, rollbackReadbackSql) {
  return {
    version: 1,
    artifactType: "lovable-connection-writer-fence",
    status: "PREPARED_NOT_APPLIED",
    remoteMutations: 0,
    connectionId: plan.connectionId,
    sourceSnapshotSha256: plan.snapshotSha256,
    expectedStateSha256: plan.stateSha256,
    expectedControlStateSha256: plan.controlStateSha256,
    fencedControlStateSha256: plan.fencedControlStateSha256,
    providerSchedulerKeysChanged: plan.schedulerKeys,
    minimumDrainMs: MIN_DRAIN_MS,
    captureSeparationMs: CAPTURE_SEPARATION_MS,
    artifacts: {
      applySqlSha256: sha256(applySql),
      rollbackSqlSha256: sha256(rollbackSql),
      fencedReadbackSqlSha256: sha256(fencedReadbackSql),
      rollbackReadbackSqlSha256: sha256(rollbackReadbackSql),
    },
    checklist: [
      "Re-read the private source row and require its full state SHA-256 to equal expectedStateSha256.",
      "Execute only the apply SQL in one transaction; require exactly one matching Agora row.",
      "Run the fenced readback and require expected_control_state=true.",
      `Wait at least ${MIN_DRAIN_MS} ms from the committed fence before collecting authoritative data.`,
      "Capture Lovable baseline A with the read-only REST exporter and bind its semantic manifest SHA-256.",
      `Wait at least ${CAPTURE_SEPARATION_MS} ms, then capture baseline B with the same scope.`,
      "Require A and B to be semantically identical, with no new writes, and reconcile exactly against own-infra.",
      "Do not activate the own writer until the signed writer-fence evidence accepts both captures.",
      "If any check fails, keep own-infra inactive and execute rollback only while its fenced-state guards still match.",
    ],
  };
}

function validateOutputDirectory(outputDir) {
  if (!outputDir || !isAbsolute(outputDir) || !isOutsideRepository(outputDir)) {
    throw new Error("LOVABLE_CONNECTION_FENCE_OUTPUT_MUST_BE_ABSOLUTE_OUTSIDE_REPOSITORY");
  }
  if (isOutsideRepository(dirname(outputDir)) === false) {
    throw new Error("LOVABLE_CONNECTION_FENCE_OUTPUT_PARENT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  mkdirSync(dirname(outputDir), { recursive: true, mode: 0o700 });
  chmodSync(dirname(outputDir), 0o700);
  const realParent = realpathSync(dirname(outputDir));
  if (!isOutsideRepository(realParent)) {
    throw new Error("LOVABLE_CONNECTION_FENCE_OUTPUT_REALPATH_MUST_BE_OUTSIDE_REPOSITORY");
  }
  return { target: resolve(outputDir), realParent };
}

export function prepareLovableConnectionFence({
  snapshotPath,
  expectedSnapshotSha256,
  connectionId,
  expectedStateSha256,
  outputDir,
}) {
  const source = readPrivateSnapshot(snapshotPath);
  const sourceSha256 = sha256(source);
  if (!SHA256_PATTERN.test(expectedSnapshotSha256 ?? "")) {
    throw new Error("LOVABLE_CONNECTION_FENCE_INVALID_EXPECTED_SNAPSHOT_SHA256");
  }
  if (sourceSha256 !== expectedSnapshotSha256) {
    throw new Error("LOVABLE_CONNECTION_FENCE_SNAPSHOT_SHA256_MISMATCH");
  }
  const plan = validateLovableConnectionFenceInput({
    snapshotDocument: parseJson(source),
    snapshotSha256: sourceSha256,
    connectionId,
    expectedStateSha256,
  });
  const applySql = renderLovableConnectionFenceApplySql(plan);
  const rollbackSql = renderLovableConnectionFenceRollbackSql(plan);
  const fencedReadbackSql = renderLovableConnectionFenceReadbackSql(plan, "fenced");
  const rollbackReadbackSql = renderLovableConnectionFenceReadbackSql(plan, "original");
  const manifest = manifestFor(
    plan,
    applySql,
    rollbackSql,
    fencedReadbackSql,
    rollbackReadbackSql,
  );
  const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
  assertNoSecretDisclosure(
    [applySql, rollbackSql, fencedReadbackSql, rollbackReadbackSql, manifestSource],
    plan.secretValues,
  );

  const { target, realParent } = validateOutputDirectory(outputDir);
  const staging = mkdtempSync(join(realParent, `.${basename(target)}.tmp-`));
  chmodSync(staging, 0o700);
  try {
    const files = {
      apply: join(staging, "lovable-connection-fence.apply.sql"),
      rollback: join(staging, "lovable-connection-fence.rollback.sql"),
      readback: join(staging, "lovable-connection-fence.readback.sql"),
      rollbackReadback: join(staging, "lovable-connection-fence.rollback-readback.sql"),
      manifest: join(staging, "lovable-connection-fence.manifest.json"),
    };
    for (const [path, contents] of [
      [files.apply, applySql],
      [files.rollback, rollbackSql],
      [files.readback, fencedReadbackSql],
      [files.rollbackReadback, rollbackReadbackSql],
      [files.manifest, manifestSource],
    ]) {
      writeFileSync(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
      chmodSync(path, 0o600);
    }
    renameSync(staging, target);
    return {
      status: "LOVABLE_CONNECTION_FENCE_ARTIFACTS_READY_NOT_APPLIED",
      remoteMutations: 0,
      connectionId,
      outputDir: target,
      applySqlPath: join(target, basename(files.apply)),
      rollbackSqlPath: join(target, basename(files.rollback)),
      readbackSqlPath: join(target, basename(files.readback)),
      rollbackReadbackSqlPath: join(target, basename(files.rollbackReadback)),
      manifestPath: join(target, basename(files.manifest)),
      minimumDrainMs: MIN_DRAIN_MS,
      stateSha256: plan.stateSha256,
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function argument(name) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function main() {
  if (!process.argv.includes("--render")) {
    process.stdout.write(`${JSON.stringify({
      status: "LOVABLE_CONNECTION_FENCE_LOCAL_TOOL_READY",
      remoteMutations: 0,
      minimumDrainMs: MIN_DRAIN_MS,
      knownProviderSchedulerKeys: KNOWN_PROVIDER_SCHEDULER_KEYS,
    }, null, 2)}\n`);
    return;
  }
  const result = prepareLovableConnectionFence({
    snapshotPath: argument("--snapshot"),
    expectedSnapshotSha256: argument("--expected-snapshot-sha256"),
    connectionId: argument("--connection-id"),
    expectedStateSha256: argument("--expected-state-sha256"),
    outputDir: argument("--output"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
