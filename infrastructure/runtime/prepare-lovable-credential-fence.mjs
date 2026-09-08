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
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const PRIVATE_SNAPSHOT_MODES = new Set([0o400, 0o600]);
const KNOWN_PROVIDER_SCHEDULER_KEYS = Object.freeze([
  "intraday_sales_sync_enabled",
  "open_tickets_sync_enabled",
  "open_tickets_stock_sync_enabled",
]);
const SCHEDULER_LIKE_KEY_PATTERN = /(?:^|_)(?:cron|schedule|scheduler|sync)(?:_|$).*?(?:active|enabled)$/i;
const SECRET_KEY_PATTERN = /(?:^|[_-])(?:api[_-]?token|winerim[_-]?(?:api[_-]?)?token|token|secret|password|authorization|bearer|credential|private[_-]?key)(?:$|[_-])/i;
const PSQL_VARIABLES = Object.freeze({
  agora: "lovable_api_token",
  winerim: "lovable_winerim_api_token",
});
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

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

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function rowsFrom(document) {
  if (plainObject(document) && typeof document.id === "string") return [document];
  const rows = Array.isArray(document)
    ? document
    : document?.connections ?? document?.rows ?? document?.data;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("LOVABLE_CREDENTIAL_FENCE_INVALID_SNAPSHOT_CONTRACT");
  }
  return rows;
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
    if (secret && typeof nested === "string" && nested.length > 0) target.add(nested);
    if (nested && typeof nested === "object") collectSecretValues(nested, secret, target);
  }
  return target;
}

function assertNoSecretDisclosure(sources, secretValues) {
  for (const source of sources) {
    for (const secret of secretValues) {
      if (source.includes(secret)) {
        throw new Error("LOVABLE_CREDENTIAL_FENCE_SECRET_VALUE_IN_OUTPUT");
      }
    }
  }
}

function readPrivateSnapshot(path) {
  if (!path || !isAbsolute(path)) {
    throw new Error("LOVABLE_CREDENTIAL_FENCE_SNAPSHOT_PATH_MUST_BE_ABSOLUTE");
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("LOVABLE_CREDENTIAL_FENCE_SNAPSHOT_MUST_BE_REGULAR_FILE");
  }
  const mode = metadata.mode & 0o777;
  if (!PRIVATE_SNAPSHOT_MODES.has(mode)) {
    throw new Error("LOVABLE_CREDENTIAL_FENCE_SNAPSHOT_MUST_BE_PRIVATE_0400_OR_0600");
  }
  if (metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) {
    throw new Error("LOVABLE_CREDENTIAL_FENCE_SNAPSHOT_INVALID_SIZE");
  }
  return { source: readFileSync(path), mode };
}

function parseJson(source) {
  try {
    return JSON.parse(source.toString("utf8"));
  } catch {
    throw new Error("LOVABLE_CREDENTIAL_FENCE_INVALID_SNAPSHOT_JSON");
  }
}

function validateSchedulers(providerConfig) {
  const known = new Set(KNOWN_PROVIDER_SCHEDULER_KEYS);
  const unknown = Object.keys(providerConfig)
    .filter((key) => SCHEDULER_LIKE_KEY_PATTERN.test(key) && !known.has(key))
    .sort();
  if (unknown.length > 0) {
    throw new Error(`LOVABLE_CREDENTIAL_FENCE_UNSUPPORTED_SCHEDULER_KEYS_${sha256(canonicalJson(unknown))}`);
  }
  for (const key of KNOWN_PROVIDER_SCHEDULER_KEYS) {
    if (!Object.hasOwn(providerConfig, key) || providerConfig[key] !== false) {
      throw new Error(`LOVABLE_CREDENTIAL_FENCE_SCHEDULER_MUST_BE_FALSE_${key.toUpperCase()}`);
    }
  }
}

function nonSecretControlState(row) {
  return {
    id: row.id,
    provider: row.provider,
    enabled: row.enabled,
    catalogSyncEnabled: row.catalog_sync_enabled,
    providerSchedulers: Object.fromEntries(KNOWN_PROVIDER_SCHEDULER_KEYS.map((key) => [
      key,
      row.provider_config[key],
    ])),
    credentials: {
      apiTokenPresent: typeof row.api_token === "string" && row.api_token.length > 0,
      winerimApiTokenPresent: typeof row.winerim_api_token === "string"
        && row.winerim_api_token.length > 0,
    },
  };
}

export function validateLovableCredentialFenceInput({ snapshotDocument, connectionId }) {
  if (!UUID_PATTERN.test(connectionId ?? "")) {
    throw new Error("LOVABLE_CREDENTIAL_FENCE_INVALID_CONNECTION_ID");
  }
  const matches = rowsFrom(snapshotDocument).filter((row) => row?.id === connectionId);
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? "LOVABLE_CREDENTIAL_FENCE_CONNECTION_NOT_FOUND"
      : "LOVABLE_CREDENTIAL_FENCE_DUPLICATE_CONNECTION_ID");
  }
  const row = matches[0];
  if (!plainObject(row)) throw new Error("LOVABLE_CREDENTIAL_FENCE_ROW_MUST_BE_OBJECT");
  for (const column of [
    "id",
    "provider",
    "enabled",
    "catalog_sync_enabled",
    "provider_config",
    "api_token",
    "winerim_api_token",
  ]) {
    if (!Object.hasOwn(row, column)) {
      throw new Error(`LOVABLE_CREDENTIAL_FENCE_MISSING_COLUMN_${column.toUpperCase()}`);
    }
  }
  if (row.provider !== "agora") {
    throw new Error("LOVABLE_CREDENTIAL_FENCE_PROVIDER_NOT_AGORA");
  }
  if (row.enabled !== false) {
    throw new Error("LOVABLE_CREDENTIAL_FENCE_ENABLED_MUST_BE_FALSE");
  }
  if (row.catalog_sync_enabled !== false) {
    throw new Error("LOVABLE_CREDENTIAL_FENCE_CATALOG_SYNC_ENABLED_MUST_BE_FALSE");
  }
  if (!plainObject(row.provider_config)) {
    throw new Error("LOVABLE_CREDENTIAL_FENCE_PROVIDER_CONFIG_MUST_BE_OBJECT");
  }
  validateSchedulers(row.provider_config);
  if (typeof row.api_token !== "string" || row.api_token.length === 0) {
    throw new Error("LOVABLE_CREDENTIAL_FENCE_API_TOKEN_MUST_BE_PRESENT");
  }
  if (typeof row.winerim_api_token !== "string" || row.winerim_api_token.length === 0) {
    throw new Error("LOVABLE_CREDENTIAL_FENCE_WINERIM_API_TOKEN_MUST_BE_PRESENT");
  }

  const controlState = nonSecretControlState(row);
  return {
    connectionId,
    controlState,
    controlStateSha256: sha256(canonicalJson(controlState)),
    credentialDigests: {
      agoraMd5: createHash("md5").update(row.api_token).digest("hex"),
      winerimMd5: createHash("md5").update(row.winerim_api_token).digest("hex"),
    },
    secretValues: collectSecretValues(row),
  };
}

function renderPsqlVariableGate() {
  return `\\set ON_ERROR_STOP on
\\if :{?${PSQL_VARIABLES.agora}}
\\else
\\echo 'LOVABLE_CREDENTIAL_FENCE_MISSING_PSQL_VARIABLE_${PSQL_VARIABLES.agora}'
\\quit 3
\\endif
\\if :{?${PSQL_VARIABLES.winerim}}
\\else
\\echo 'LOVABLE_CREDENTIAL_FENCE_MISSING_PSQL_VARIABLE_${PSQL_VARIABLES.winerim}'
\\quit 3
\\endif
SELECT (
  length(:'${PSQL_VARIABLES.agora}') > 0
  AND length(:'${PSQL_VARIABLES.winerim}') > 0
) AS lovable_credential_fence_input_valid \\gset
\\if :lovable_credential_fence_input_valid
\\else
\\echo 'LOVABLE_CREDENTIAL_FENCE_EMPTY_PSQL_CREDENTIAL_VARIABLE'
\\quit 3
\\endif
`;
}

function schedulerSqlGuards() {
  return KNOWN_PROVIDER_SCHEDULER_KEYS.map((key) => [
    `provider_config ? ${sqlLiteral(key)}`,
    `jsonb_typeof(provider_config -> ${sqlLiteral(key)}) = 'boolean'`,
    `(provider_config ->> ${sqlLiteral(key)})::boolean = false`,
  ].join("\n    AND ")).join("\n    AND ");
}

function renderExactOneCommit(operation, updateSql) {
  return `${renderPsqlVariableGate()}
BEGIN;
WITH changed AS (
${updateSql}
  RETURNING 1
)
SELECT (count(*) = 1) AS lovable_credential_fence_exactly_one
FROM changed \\gset
\\if :lovable_credential_fence_exactly_one
COMMIT;
\\else
ROLLBACK;
\\echo 'LOVABLE_CREDENTIAL_FENCE_${operation}_STATE_MISMATCH'
\\quit 3
\\endif
`;
}

export function renderLovableCredentialFenceApplySql(plan) {
  return `-- LOVABLE_CREDENTIAL_FENCE_APPLY_V1
-- connection_id: ${plan.connectionId}
-- expected_control_state_sha256: ${plan.controlStateSha256}
-- Local artifact only. Requires psql variables; contains no credential values.
${renderExactOneCommit("APPLY", `  UPDATE public.pos_connections
  SET api_token = '',
      winerim_api_token = NULL
  WHERE id = ${sqlLiteral(plan.connectionId)}::uuid
    AND provider = 'agora'
    AND enabled = false
    AND catalog_sync_enabled = false
    AND ${schedulerSqlGuards()}
    AND api_token = :'${PSQL_VARIABLES.agora}'
    AND winerim_api_token = :'${PSQL_VARIABLES.winerim}'`)}
`;
}

export function renderLovableCredentialFenceBrowserApplySql(plan) {
  return `-- LOVABLE_CREDENTIAL_FENCE_BROWSER_APPLY_V1
-- connection_id: ${plan.connectionId}
-- expected_control_state_sha256: ${plan.controlStateSha256}
-- Hash-guarded SQL Editor artifact. Contains no credential values.
BEGIN;
DO $lovable_credential_fence_browser_apply$
DECLARE
  changed_rows integer;
BEGIN
  UPDATE public.pos_connections
  SET api_token = '',
      winerim_api_token = NULL
  WHERE id = ${sqlLiteral(plan.connectionId)}::uuid
    AND provider = 'agora'
    AND enabled = false
    AND catalog_sync_enabled = false
    AND ${schedulerSqlGuards()}
    AND md5(api_token) = ${sqlLiteral(plan.credentialDigests.agoraMd5)}
    AND md5(winerim_api_token) = ${sqlLiteral(plan.credentialDigests.winerimMd5)};
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'LOVABLE_CREDENTIAL_FENCE_BROWSER_APPLY_STATE_MISMATCH';
  END IF;
  IF (
    SELECT count(*) FROM public.pos_connections
    WHERE id = ${sqlLiteral(plan.connectionId)}::uuid
      AND provider = 'agora'
      AND enabled = false
      AND catalog_sync_enabled = false
      AND ${schedulerSqlGuards()}
      AND api_token = ''
      AND winerim_api_token IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'LOVABLE_CREDENTIAL_FENCE_BROWSER_APPLY_READBACK_FAILED';
  END IF;
END;
$lovable_credential_fence_browser_apply$;
COMMIT;
`;
}

export function renderLovableCredentialFenceRollbackSql(plan) {
  return `-- LOVABLE_CREDENTIAL_FENCE_ROLLBACK_V1
-- connection_id: ${plan.connectionId}
-- expected_control_state_sha256: ${plan.controlStateSha256}
-- Supply the original private snapshot values through psql variables.
${renderExactOneCommit("ROLLBACK", `  UPDATE public.pos_connections
  SET api_token = :'${PSQL_VARIABLES.agora}',
      winerim_api_token = :'${PSQL_VARIABLES.winerim}'
  WHERE id = ${sqlLiteral(plan.connectionId)}::uuid
    AND provider = 'agora'
    AND enabled = false
    AND catalog_sync_enabled = false
    AND ${schedulerSqlGuards()}
    AND api_token = ''
    AND winerim_api_token IS NULL`)}
`;
}

export function renderLovableCredentialFenceReadbackSql(plan) {
  const schedulerAssertions = KNOWN_PROVIDER_SCHEDULER_KEYS.map((key) => (
    `COALESCE((provider_config ->> ${sqlLiteral(key)})::boolean = false, false)`
  ));
  return `-- LOVABLE_CREDENTIAL_FENCE_READBACK_V1
-- This query returns only identifiers, control flags and credential-presence booleans.
SELECT
  id,
  provider,
  enabled,
  catalog_sync_enabled,
  ${KNOWN_PROVIDER_SCHEDULER_KEYS.map((key) => (
    `COALESCE((provider_config ->> ${sqlLiteral(key)})::boolean = false, false) AS ${key}_is_false`
  )).join(",\n  ")},
  (api_token = '') AS api_token_removed,
  (winerim_api_token IS NULL) AS winerim_api_token_removed,
  (
    provider = 'agora'
    AND enabled = false
    AND catalog_sync_enabled = false
    AND ${schedulerAssertions.join("\n    AND ")}
    AND api_token = ''
    AND winerim_api_token IS NULL
  ) AS expected_credential_fence_state
FROM public.pos_connections
WHERE id = ${sqlLiteral(plan.connectionId)}::uuid;
`;
}

function buildManifest(plan, {
  snapshotSha256,
  snapshotMode,
  applySql,
  browserApplySql,
  rollbackSql,
  readbackSql,
}) {
  return {
    version: 1,
    artifactType: "lovable-per-connection-credential-fence",
    status: "PREPARED_NOT_APPLIED",
    remoteMutations: 0,
    connectionId: plan.connectionId,
    sourceSnapshotSha256: snapshotSha256,
    sourceSnapshotMode: snapshotMode.toString(8).padStart(4, "0"),
    expectedControlStateSha256: plan.controlStateSha256,
    expectedBefore: {
      provider: "agora",
      enabled: false,
      catalogSyncEnabled: false,
      providerSchedulers: Object.fromEntries(KNOWN_PROVIDER_SCHEDULER_KEYS.map((key) => [key, false])),
      apiTokenPresent: true,
      winerimApiTokenPresent: true,
    },
    expectedAfter: {
      provider: "agora",
      enabled: false,
      catalogSyncEnabled: false,
      providerSchedulers: Object.fromEntries(KNOWN_PROVIDER_SCHEDULER_KEYS.map((key) => [key, false])),
      apiTokenRemoved: true,
      winerimApiTokenRemoved: true,
    },
    psqlVariablesRequiredForApplyAndRollback: [PSQL_VARIABLES.agora, PSQL_VARIABLES.winerim],
    artifacts: {
      applySqlSha256: sha256(applySql),
      browserApplySqlSha256: sha256(browserApplySql),
      rollbackSqlSha256: sha256(rollbackSql),
      readbackSqlSha256: sha256(readbackSql),
    },
    checklist: [
      "Keep the source snapshot private and supply both original credentials only as psql variables.",
      "Apply only while the connection, catalog and every known scheduler remain disabled.",
      "Require exactly one guarded row to change; otherwise the transaction rolls back.",
      "Run readback.sql and require expected_credential_fence_state=true before treating Lovable as credential-fenced.",
      "Rollback only while the same connection remains disabled and both credentials remain removed.",
    ],
  };
}

function validateOutputDirectory(outputDir) {
  if (!outputDir || !isAbsolute(outputDir) || !isOutsideRepository(outputDir)) {
    throw new Error("LOVABLE_CREDENTIAL_FENCE_OUTPUT_MUST_BE_ABSOLUTE_OUTSIDE_REPOSITORY");
  }
  mkdirSync(dirname(outputDir), { recursive: true, mode: 0o700 });
  chmodSync(dirname(outputDir), 0o700);
  const realParent = realpathSync(dirname(outputDir));
  if (!isOutsideRepository(realParent)) {
    throw new Error("LOVABLE_CREDENTIAL_FENCE_OUTPUT_REALPATH_MUST_BE_OUTSIDE_REPOSITORY");
  }
  return { target: resolve(outputDir), realParent };
}

export function prepareLovableCredentialFence({ snapshotPath, connectionId, outputDir }) {
  const { source, mode } = readPrivateSnapshot(snapshotPath);
  const snapshotSha256 = sha256(source);
  const plan = validateLovableCredentialFenceInput({
    snapshotDocument: parseJson(source),
    connectionId,
  });
  const applySql = renderLovableCredentialFenceApplySql(plan);
  const browserApplySql = renderLovableCredentialFenceBrowserApplySql(plan);
  const rollbackSql = renderLovableCredentialFenceRollbackSql(plan);
  const readbackSql = renderLovableCredentialFenceReadbackSql(plan);
  const manifest = buildManifest(plan, {
    snapshotSha256,
    snapshotMode: mode,
    applySql,
    browserApplySql,
    rollbackSql,
    readbackSql,
  });
  const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
  assertNoSecretDisclosure(
    [applySql, browserApplySql, rollbackSql, readbackSql, manifestSource],
    plan.secretValues,
  );

  const { target, realParent } = validateOutputDirectory(outputDir);
  const staging = mkdtempSync(join(realParent, `.${basename(target)}.tmp-`));
  chmodSync(staging, 0o700);
  try {
    const files = {
      apply: join(staging, "lovable-credential-fence.apply.sql"),
      browserApply: join(staging, "lovable-credential-fence.apply-browser.sql"),
      rollback: join(staging, "lovable-credential-fence.rollback.sql"),
      readback: join(staging, "lovable-credential-fence.readback.sql"),
      manifest: join(staging, "lovable-credential-fence.manifest.json"),
    };
    for (const [path, contents] of [
      [files.apply, applySql],
      [files.browserApply, browserApplySql],
      [files.rollback, rollbackSql],
      [files.readback, readbackSql],
      [files.manifest, manifestSource],
    ]) {
      writeFileSync(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
      chmodSync(path, 0o600);
    }
    renameSync(staging, target);
    return {
      status: "LOVABLE_CREDENTIAL_FENCE_ARTIFACTS_READY_NOT_APPLIED",
      remoteMutations: 0,
      connectionId,
      outputDir: target,
      applySqlPath: join(target, basename(files.apply)),
      browserApplySqlPath: join(target, basename(files.browserApply)),
      rollbackSqlPath: join(target, basename(files.rollback)),
      readbackSqlPath: join(target, basename(files.readback)),
      manifestPath: join(target, basename(files.manifest)),
      sourceSnapshotSha256: snapshotSha256,
      expectedControlStateSha256: plan.controlStateSha256,
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
      status: "LOVABLE_CREDENTIAL_FENCE_LOCAL_TOOL_READY",
      remoteMutations: 0,
      acceptedSnapshotModes: ["0400", "0600"],
      requiredDisabledSchedulers: KNOWN_PROVIDER_SCHEDULER_KEYS,
    }, null, 2)}\n`);
    return;
  }
  const result = prepareLovableCredentialFence({
    snapshotPath: argument("--snapshot"),
    connectionId: argument("--connection-id"),
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
