import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Client } = pg;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SNAPSHOT = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9]+$/i;
const WAL_LSN = /^[0-9a-f]+\/[0-9a-f]+$/i;
const PROJECT_REF = /^[a-z0-9]{20}$/;
const SAFE_ERROR = /postgres(?:ql)?:\/\/[^\s]+/gi;
const MANIFEST_SCHEMA_VERSION = 2;
const QUIESCENCE_SCHEMA_VERSION = 1;
const TRANSFER_ADVISORY_LOCK_KEYS = [20260804, 1001];
const CREDENTIAL_COLUMN = /(?:token|secret|password|credential|(?:^|_)key(?:_|$)|(?:^|_)url$|endpoint|provider_config|restaurant_guid)/i;
const REQUIRED_POS_REDACTIONS = {
  base_url: "redacted-url",
  api_token: "empty-text",
  winerim_api_token: "null-text",
  catalog_endpoint: "null-text",
  provider_config: "empty-json-object",
  restaurant_guid: "null-text",
};
const REDACTION_SQL = {
  "redacted-url": "'https://redacted.invalid'::text",
  "empty-text": "''::text",
  "null-text": "NULL::text",
  "empty-json-object": "'{}'::jsonb",
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = path.join(moduleDir, "config.json");

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function quoteIdentifier(value) {
  if (!IDENTIFIER.test(String(value))) throw new Error(`Unsafe SQL identifier: ${String(value)}`);
  return `"${value}"`;
}

export function qualifiedTable(schema, table) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

export async function loadTransferConfig(configPath = DEFAULT_CONFIG_PATH) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  validateTransferConfig(config);
  return config;
}

export function validateTransferConfig(config) {
  if (config?.schemaVersion !== 3 || !IDENTIFIER.test(config?.schema || "")) {
    throw new Error("Unsupported data-transfer config");
  }
  const source = config.sourceTables;
  const optionalSource = config.optionalSourceTables;
  const stagingOnly = config.stagingOnlyTables;
  if (!Array.isArray(source) || source.length === 0 || !Array.isArray(optionalSource) || !Array.isArray(stagingOnly)) {
    throw new Error("Data-transfer table lists are required");
  }
  const all = [...source, ...stagingOnly];
  if (new Set(all).size !== all.length || all.some((name) => !IDENTIFIER.test(name))) {
    throw new Error("Data-transfer table allowlist contains duplicates or unsafe names");
  }
  if (new Set(optionalSource).size !== optionalSource.length
      || optionalSource.some((name) => !IDENTIFIER.test(name) || !source.includes(name))) {
    throw new Error("Optional source tables must be a unique safe subset of the source allowlist");
  }
  if (!Array.isArray(config.runtimeMustRemainEmpty)
      || config.runtimeMustRemainEmpty.some((name) => !stagingOnly.includes(name))) {
    throw new Error("Runtime empty-table gate must be a staging-only subset");
  }
  if (!PROJECT_REF.test(config.targetProjectRef || "")) {
    throw new Error("Target project ref is required");
  }
  if (source.includes("provider_credentials")
      || !stagingOnly.includes("provider_credentials")
      || !config.runtimeMustRemainEmpty.includes("provider_credentials")) {
    throw new Error("provider_credentials must be staging-only and required empty");
  }
  const projections = config.sanitizedProjections;
  if (!projections || typeof projections !== "object" || Array.isArray(projections)) {
    throw new Error("Sanitized projection config is required");
  }
  for (const [table, projection] of Object.entries(projections)) {
    if (!source.includes(table) || !IDENTIFIER.test(table)) {
      throw new Error(`Sanitized projection references a non-source table: ${table}`);
    }
    const columns = projection?.expectedColumns;
    const redactions = projection?.redactions;
    if (!Array.isArray(columns) || columns.length === 0
        || new Set(columns).size !== columns.length
        || columns.some((column) => !IDENTIFIER.test(column))) {
      throw new Error(`Invalid sanitized projection columns for ${table}`);
    }
    if (!redactions || typeof redactions !== "object" || Array.isArray(redactions)
        || Object.entries(redactions).some(([column, action]) => (
          !columns.includes(column) || !Object.hasOwn(REDACTION_SQL, action)
        ))) {
      throw new Error(`Invalid sanitized projection redactions for ${table}`);
    }
    const unredactedCredentialColumns = columns.filter((column) => CREDENTIAL_COLUMN.test(column) && !redactions[column]);
    if (unredactedCredentialColumns.length) {
      throw new Error(`Credential-like projection columns must be explicitly redacted for ${table}: ${unredactedCredentialColumns.join(",")}`);
    }
  }
  const posProjection = projections.pos_connections;
  if (!posProjection || Object.entries(REQUIRED_POS_REDACTIONS).some(([column, action]) => (
    posProjection.redactions[column] !== action
  ))) {
    throw new Error("pos_connections credential redactions are incomplete");
  }
  return config;
}

export function expectedTargetTables(config) {
  return [...config.sourceTables, ...config.stagingOnlyTables].sort();
}

export function requiredSourceTables(config) {
  const optional = new Set(config.optionalSourceTables);
  return config.sourceTables.filter((table) => !optional.has(table));
}

export function resolveSourceTables(config, actualTables, { rejectUnexpected = false } = {}) {
  if (!Array.isArray(actualTables) || new Set(actualTables).size !== actualTables.length) {
    throw new Error("Source table inventory is missing or contains duplicates");
  }
  const actual = new Set(actualTables);
  const allowed = new Set(config.sourceTables);
  const missing = requiredSourceTables(config).filter((table) => !actual.has(table));
  const unexpected = rejectUnexpected ? actualTables.filter((table) => !allowed.has(table)) : [];
  if (missing.length || unexpected.length) {
    throw new Error(`Source table inventory mismatch: missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`);
  }
  return config.sourceTables.filter((table) => actual.has(table));
}

export function requiredEmptyTargetTables(config, sourceTables = config.sourceTables) {
  const selected = new Set(sourceTables);
  return [
    ...config.runtimeMustRemainEmpty,
    ...config.optionalSourceTables.filter((table) => !selected.has(table)),
  ].sort();
}

export function targetReplaceTables(config) {
  return [...config.sourceTables, ...config.runtimeMustRemainEmpty].sort();
}

export function tableTransferPolicy(config, table) {
  if (config.runtimeMustRemainEmpty.includes(table)) return { mode: "empty" };
  const projection = config.sanitizedProjections[table];
  if (projection) return { mode: "sanitized-projection", ...projection };
  return { mode: "full" };
}

export function transferPolicyDigest(config, tables) {
  const descriptor = tables.map((table) => ({ table, ...tableTransferPolicy(config, table) }));
  return sha256(canonicalJson(descriptor));
}

function tableColumns(descriptor, table) {
  return descriptor.columns
    .filter((column) => column.table === table)
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((column) => column.column);
}

function assertProjectionColumns(descriptor, table, policy) {
  const actual = tableColumns(descriptor, table);
  if (policy.mode === "sanitized-projection"
      && canonicalJson(actual) !== canonicalJson(policy.expectedColumns)) {
    throw new Error(`Sanitized projection schema mismatch for ${table}: expected=${policy.expectedColumns.join(",")}; actual=${actual.join(",")}`);
  }
  if (actual.length === 0) throw new Error(`No columns found for transfer table ${table}`);
  return policy.mode === "sanitized-projection" ? policy.expectedColumns : actual;
}

export function buildProjectedSelectSql({ schema, table, columns, policy }) {
  if (!columns.length || !["empty", "sanitized-projection"].includes(policy.mode)) {
    throw new Error(`Table ${table} does not have a projected transfer policy`);
  }
  const expressions = columns.map((column) => {
    const action = policy.mode === "sanitized-projection" ? policy.redactions[column] : null;
    return action
      ? `${REDACTION_SQL[action]} AS ${quoteIdentifier(column)}`
      : quoteIdentifier(column);
  });
  return `SELECT\n  ${expressions.join(",\n  ")}\nFROM ${qualifiedTable(schema, table)}${policy.mode === "empty" ? "\nWHERE false" : ""}`;
}

export function assertTableInventory(actual, expected, { exact = true } = {}) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((table) => !actualSet.has(table));
  const unexpected = exact ? actual.filter((table) => !expectedSet.has(table)) : [];
  if (missing.length || unexpected.length) {
    throw new Error(`Table inventory mismatch: missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`);
  }
  return { missing, unexpected };
}

export function buildPgDumpArgs({ outputDir, schema, tables, snapshotId, excludedTableData = [] }) {
  if (!SNAPSHOT.test(snapshotId)) throw new Error("Invalid exported snapshot identifier");
  const args = [
    "--format=directory",
    "--jobs=1",
    "--data-only",
    "--no-owner",
    "--no-privileges",
    "--no-comments",
    "--no-publications",
    "--no-subscriptions",
    `--snapshot=${snapshotId}`,
    `--file=${outputDir}`,
  ];
  for (const table of tables) args.push(`--table=${schema}.${table}`);
  for (const table of excludedTableData) args.push(`--exclude-table-data=${schema}.${table}`);
  return args;
}

function psqlIncludePath(filePath) {
  return `'${path.resolve(filePath).replaceAll("'", "''")}'`;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function validateQuiescenceEvidence(evidence, replaceTables) {
  if (!evidence || typeof evidence !== "object"
      || !WAL_LSN.test(evidence.walLsn || "")
      || typeof evidence.database !== "string"
      || evidence.database.length === 0
      || !Array.isArray(evidence.tables)) {
    throw new Error("Target quiescence evidence is missing or invalid");
  }
  const expected = [...replaceTables].sort();
  const actual = evidence.tables.map(({ table }) => table).sort();
  assertTableInventory(actual, expected);
  for (const entry of evidence.tables) {
    if (!IDENTIFIER.test(entry.table) || !Number.isSafeInteger(entry.rowCount) || entry.rowCount < 0) {
      throw new Error(`Invalid target quiescence row count for ${String(entry.table)}`);
    }
  }
  return evidence;
}

export function preimageEvidenceFromManifest(manifest, replaceTables) {
  if (manifest?.kind !== "staging-target-backup"
      || manifest?.quiescenceFence?.schemaVersion !== QUIESCENCE_SCHEMA_VERSION
      || manifest?.quiescenceFence?.method !== "advisory-lock+wal-stability+table-counts"
      || manifest?.quiescenceFence?.startWalLsn !== manifest?.snapshotLsn
      || manifest?.quiescenceFence?.endWalLsn !== manifest?.snapshotLsn
      || manifest?.quiescenceFence?.relationPersistence !== "permanent") {
    throw new Error("Target backup does not contain verified continuous quiescence evidence");
  }
  return validateQuiescenceEvidence({
    database: manifest.source?.database,
    walLsn: manifest.snapshotLsn,
    tables: manifest.tables.map(({ table, rowCount }) => ({ table, rowCount })),
  }, replaceTables);
}

export function buildAtomicRestoreSql({
  schema,
  replaceTables,
  restoreSqlPath,
  projectedCopies = [],
  expectedPreimage,
}) {
  if (!replaceTables.length) throw new Error("Atomic restore needs at least one table");
  const evidence = validateQuiescenceEvidence(expectedPreimage, replaceTables);
  const tables = replaceTables.map((table) => qualifiedTable(schema, table)).join(",\n  ");
  const rowCountChecks = evidence.tables
    .sort((left, right) => left.table.localeCompare(right.table))
    .map(({ table, rowCount }) => [
      `  IF (SELECT count(*) FROM ${qualifiedTable(schema, table)}) <> ${rowCount} THEN`,
      `    RAISE EXCEPTION 'TARGET_QUIESCENCE_ROW_COUNT_DRIFT:${table}';`,
      "  END IF;",
    ].join("\n"));
  return [
    "\\set ON_ERROR_STOP on",
    "BEGIN;",
    "SET LOCAL lock_timeout = '5s';",
    "SET LOCAL statement_timeout = '0';",
    "SET LOCAL idle_in_transaction_session_timeout = '10min';",
    "DO $winerim_transfer_advisory_fence$",
    "BEGIN",
    `  IF NOT pg_try_advisory_xact_lock(${TRANSFER_ADVISORY_LOCK_KEYS[0]}, ${TRANSFER_ADVISORY_LOCK_KEYS[1]}) THEN`,
    "    RAISE EXCEPTION 'TARGET_QUIESCENCE_ADVISORY_LOCK_BUSY';",
    "  END IF;",
    "END",
    "$winerim_transfer_advisory_fence$;",
    `LOCK TABLE\n  ${tables}\nIN ACCESS EXCLUSIVE MODE;`,
    "DO $winerim_transfer_quiescence_check$",
    "BEGIN",
    `  IF current_database() <> ${sqlLiteral(evidence.database)} THEN`,
    "    RAISE EXCEPTION 'TARGET_QUIESCENCE_DATABASE_MISMATCH';",
    "  END IF;",
    `  IF pg_current_wal_lsn() <> ${sqlLiteral(evidence.walLsn)}::pg_lsn THEN`,
    "    RAISE EXCEPTION 'TARGET_QUIESCENCE_WAL_DRIFT';",
    "  END IF;",
    ...rowCountChecks,
    "END",
    "$winerim_transfer_quiescence_check$;",
    "SET LOCAL session_replication_role = replica;",
    `TRUNCATE TABLE\n  ${tables}\nRESTART IDENTITY;`,
    `\\ir ${psqlIncludePath(restoreSqlPath)}`,
    ...projectedCopies.map(({ table, columns, filePath }) => (
      `\\copy ${qualifiedTable(schema, table)} (${columns.map(quoteIdentifier).join(", ")}) FROM ${psqlIncludePath(filePath)} WITH (FORMAT binary)`
    )),
    "SET LOCAL session_replication_role = origin;",
    "COMMIT;",
    "",
  ].join("\n");
}

export function safeCommand(command, args) {
  return [command, ...args].map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(" ");
}

export function redactError(value) {
  return String(value || "").replace(SAFE_ERROR, "[REDACTED_DATABASE_URL]").slice(-4000);
}

export function manifestDigest(manifest) {
  const unsigned = { ...manifest };
  delete unsigned.manifestSha256;
  return sha256(canonicalJson(unsigned));
}

export function checksumManifest(manifest) {
  return { ...manifest, manifestSha256: manifestDigest(manifest) };
}

export function verifyManifest(manifest, expectedTables, expectedPolicySha256) {
  if (manifest?.schemaVersion !== MANIFEST_SCHEMA_VERSION || manifest?.manifestSha256 !== manifestDigest(manifest)) {
    throw new Error("Manifest digest mismatch");
  }
  if (!Array.isArray(manifest.tables)) throw new Error("Manifest table list missing");
  assertTableInventory(manifest.tables.map(({ table }) => table), expectedTables);
  for (const table of manifest.tables) {
    if (!IDENTIFIER.test(table.table) || !Number.isSafeInteger(table.rowCount) || table.rowCount < 0
        || !SHA256.test(table.sha256) || !["full", "empty", "sanitized-projection"].includes(table.transferMode)) {
      throw new Error(`Invalid table manifest for ${String(table.table)}`);
    }
    if (table.transferMode !== "full"
        && (!Array.isArray(table.columns) || table.columns.length === 0 || table.columns.some((column) => !IDENTIFIER.test(column)))) {
      throw new Error(`Projected table columns missing for ${String(table.table)}`);
    }
  }
  if (!SHA256.test(manifest.archiveSha256 || "") || !SHA256.test(manifest.projectedDataSha256 || "")
      || !SHA256.test(manifest.schemaSha256 || "") || !SHA256.test(manifest.transferPolicySha256 || "")) {
    throw new Error("Manifest archive/projection/schema/policy digest missing");
  }
  if (!SHA256.test(expectedPolicySha256 || "") || manifest.transferPolicySha256 !== expectedPolicySha256) {
    throw new Error("Manifest transfer policy mismatch");
  }
  if (manifest.kind === "staging-target-backup") {
    preimageEvidenceFromManifest(manifest, expectedTables);
  }
  return manifest;
}

export function decideResumeAction(state, targetMatchesSource) {
  if (!state) return "CREATE_TARGET_SNAPSHOT";
  if (state.phase === "RECONCILED") return "NOOP_ALREADY_COMPLETE";
  if (state.phase === "IMPORT_APPLIED" && targetMatchesSource) return "MARK_RECONCILED";
  if (state.phase === "IMPORT_APPLIED") return "ROLLBACK_REQUIRED";
  if (state.phase === "TARGET_SNAPSHOT_READY") return "APPLY_IMPORT";
  if (state.phase === "ROLLED_BACK") return "APPLY_IMPORT";
  return "CREATE_TARGET_SNAPSHOT";
}

export function assertSourceGate(url, confirmation, config) {
  if (confirmation !== config.sourceEnvironment) throw new Error("Source confirmation gate failed");
  const parsed = new URL(url);
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || !parsed.hostname) throw new Error("Invalid source database URL");
  return parsed;
}

export function assertTargetGate(url, confirmation, config, sourceUrl = null, { localTest = false } = {}) {
  if (confirmation !== (localTest ? "local-test" : config.targetProjectRef)) {
    throw new Error("Target project confirmation gate failed");
  }
  const parsed = new URL(url);
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || !parsed.hostname) throw new Error("Invalid target database URL");
  const hostname = parsed.hostname.toLowerCase();
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const username = decodeURIComponent(parsed.username);
  if (localTest) {
    if (!/^(127\.0\.0\.1|localhost)$/.test(hostname)) throw new Error("Local-test gate only accepts localhost");
  } else {
    const ref = config.targetProjectRef;
    const directIdentity = hostname === `db.${ref}.supabase.co` && username.length > 0;
    const usernameParts = username.split(".");
    const poolerIdentity = /^(?:[a-z0-9-]+\.)*pooler\.supabase\.com$/.test(hostname)
      && usernameParts.length >= 2
      && usernameParts.at(-1) === ref
      && usernameParts.slice(0, -1).every((part) => IDENTIFIER.test(part));
    if ((!directIdentity && !poolerIdentity) || database !== "postgres" || (parsed.port && parsed.port !== "5432")) {
      throw new Error("Target URL components do not exactly identify the configured staging project");
    }
  }
  if (sourceUrl && normalizedDatabaseIdentity(sourceUrl) === normalizedDatabaseIdentity(url)) {
    throw new Error("Source and target database identities must differ");
  }
  return parsed;
}

function normalizedDatabaseIdentity(url) {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  return canonicalJson({ hostname: parsed.hostname.toLowerCase(), port: parsed.port || "5432", database });
}

function processEnv(databaseUrl, extra = {}) {
  const parsed = new URL(databaseUrl);
  const sslMode = parsed.searchParams.get("sslmode");
  return {
    ...process.env,
    ...extra,
    PGHOST: decodeURIComponent(parsed.hostname),
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    ...(sslMode ? { PGSSLMODE: sslMode } : {}),
    PGCONNECT_TIMEOUT: "10",
    PGAPPNAME: "winerim-export-reconcile",
  };
}

async function runProcess(command, args, { databaseUrl, input = null, stdout = "capture", env = {} } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: databaseUrl ? processEnv(databaseUrl, env) : { ...process.env, ...env },
      stdio: [input === null ? "ignore" : "pipe", stdout === "inherit" ? "inherit" : "pipe", "pipe"],
    });
    const output = [];
    const errors = [];
    if (stdout !== "inherit") child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    if (input !== null) child.stdin.end(input);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const diagnosticSha256 = sha256(Buffer.concat(errors));
        reject(new Error(`${command} failed (${code}); diagnosticSha256=${diagnosticSha256}`));
      } else {
        resolve(Buffer.concat(output).toString("utf8"));
      }
    });
  });
}

async function runProcessToFile(command, args, { databaseUrl, input, outputPath, env = {} }) {
  const outputHandle = await open(outputPath, "wx", 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env: databaseUrl ? processEnv(databaseUrl, env) : { ...process.env, ...env },
        stdio: ["pipe", outputHandle.fd, "pipe"],
      });
      const errors = [];
      child.stderr.on("data", (chunk) => errors.push(chunk));
      child.stdin.end(input);
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`${command} failed (${code}); diagnosticSha256=${sha256(Buffer.concat(errors))}`));
        } else {
          resolve();
        }
      });
    });
    await outputHandle.sync();
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await outputHandle.close();
  }
}

function fullTableSelectSql(schema, table) {
  return `SELECT * FROM ${qualifiedTable(schema, table)}`;
}

async function streamCanonicalTable(databaseUrl, snapshotId, schema, table, selectSql = fullTableSelectSql(schema, table)) {
  const sql = [
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;",
    `SET TRANSACTION SNAPSHOT '${snapshotId}';`,
    "COPY (",
    "  SELECT row_value",
    `  FROM (SELECT to_jsonb(row_data)::text AS row_value FROM (${selectSql}) AS row_data) canonical_rows`,
    "  ORDER BY row_value COLLATE \"C\"",
    ") TO STDOUT WITH (FORMAT text);",
    "ROLLBACK;",
    "",
  ].join("\n");

  return await new Promise((resolve, reject) => {
    const child = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1"], {
      env: processEnv(databaseUrl, { PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=0" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const hash = createHash("sha256");
    const errors = [];
    let rowCount = 0;
    child.stdout.on("data", (chunk) => {
      hash.update(chunk);
      for (const byte of chunk) if (byte === 10) rowCount++;
    });
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.stdin.end(sql);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`psql checksum failed for ${table}; diagnosticSha256=${sha256(Buffer.concat(errors))}`));
      else resolve({ table, rowCount, sha256: hash.digest("hex") });
    });
  });
}

async function writeProjectedTableData({ databaseUrl, snapshotId, selectSql, outputPath }) {
  const sql = [
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;",
    `SET TRANSACTION SNAPSHOT '${snapshotId}';`,
    `COPY (${selectSql}) TO STDOUT WITH (FORMAT binary);`,
    "ROLLBACK;",
    "",
  ].join("\n");
  await runProcessToFile("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1"], {
    databaseUrl,
    input: sql,
    outputPath,
    env: { PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=0" },
  });
}

async function directoryDigest(root) {
  const hash = createHash("sha256");
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relative = path.relative(root, fullPath);
      hash.update(relative);
      hash.update("\0");
      if (entry.isDirectory()) await walk(fullPath);
      else hash.update(await readFile(fullPath));
      hash.update("\0");
    }
  }
  await walk(root);
  return hash.digest("hex");
}

const descriptorSql = `
SELECT json_build_object(
  'database', current_database(),
  'serverVersionNum', current_setting('server_version_num')::integer,
  'tables', COALESCE((
    SELECT json_agg(table_name ORDER BY table_name)
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  ), '[]'::json),
  'columns', COALESCE((
    SELECT json_agg(json_build_object(
      'table', table_name,
      'column', column_name,
      'ordinal', ordinal_position,
      'dataType', data_type,
      'udt', udt_name,
      'nullable', is_nullable,
      'identity', is_identity,
      'generated', is_generated
    ) ORDER BY table_name, ordinal_position)
    FROM information_schema.columns
    WHERE table_schema = 'public'
  ), '[]'::json),
  'foreignKeys', COALESCE((
    SELECT json_agg(json_build_object(
      'name', constraint_name,
      'childTable', table_name,
      'childColumns', child_columns,
      'parentTable', foreign_table_name,
      'parentColumns', parent_columns
    ) ORDER BY table_name, constraint_name)
    FROM (
      SELECT
        constraint_row.conname AS constraint_name,
        child_table.relname AS table_name,
        parent_table.relname AS foreign_table_name,
        array_agg(child_column.attname ORDER BY key_pair.ordinality) AS child_columns,
        array_agg(parent_column.attname ORDER BY key_pair.ordinality) AS parent_columns
      FROM pg_constraint constraint_row
      JOIN pg_class child_table ON child_table.oid = constraint_row.conrelid
      JOIN pg_namespace child_namespace ON child_namespace.oid = child_table.relnamespace
      JOIN pg_class parent_table ON parent_table.oid = constraint_row.confrelid
      JOIN LATERAL unnest(constraint_row.conkey, constraint_row.confkey)
        WITH ORDINALITY AS key_pair(child_attnum, parent_attnum, ordinality) ON true
      JOIN pg_attribute child_column
        ON child_column.attrelid = child_table.oid
       AND child_column.attnum = key_pair.child_attnum
      JOIN pg_attribute parent_column
        ON parent_column.attrelid = parent_table.oid
       AND parent_column.attnum = key_pair.parent_attnum
      WHERE constraint_row.contype = 'f' AND child_namespace.nspname = 'public'
      GROUP BY constraint_row.conname, child_table.relname, parent_table.relname
    ) fk_rows
  ), '[]'::json)
) AS descriptor;
`;

function scopedDescriptor(descriptor, tables) {
  const allowed = new Set(tables);
  return {
    columns: descriptor.columns.filter((column) => allowed.has(column.table)),
    foreignKeys: descriptor.foreignKeys.filter((fk) => allowed.has(fk.childTable) && allowed.has(fk.parentTable)),
  };
}

async function databaseDescriptor(client) {
  const result = await client.query(descriptorSql);
  return result.rows[0].descriptor;
}

async function assertPermanentTransferRelations(client, schema, tables) {
  const result = await client.query(`
    SELECT relation.relname AS table_name, relation.relpersistence AS persistence
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = $1
      AND relation.relkind IN ('r', 'p')
      AND relation.relname = ANY($2::text[])
    ORDER BY relation.relname
  `, [schema, tables]);
  assertTableInventory(result.rows.map(({ table_name: table }) => table), [...tables].sort());
  const nonPermanent = result.rows.filter(({ persistence }) => persistence !== "p");
  if (nonPermanent.length) {
    throw new Error(`Transfer tables must be permanent/WAL-logged: ${nonPermanent.map(({ table_name: table }) => table).join(",")}`);
  }
}

async function acquireTransferAdvisoryLock(client) {
  const result = await client.query(
    "SELECT pg_try_advisory_xact_lock($1, $2) AS locked",
    TRANSFER_ADVISORY_LOCK_KEYS,
  );
  if (result.rows[0]?.locked !== true) throw new Error("Target transfer advisory lock is busy");
}

export async function withExportedSnapshot(databaseUrl, callback, { advisoryFence = false } = {}) {
  const client = new Client({ connectionString: databaseUrl, application_name: "winerim-export-reconcile-snapshot" });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    if (advisoryFence) await acquireTransferAdvisoryLock(client);
    const result = await client.query(`
      SELECT pg_export_snapshot() AS snapshot_id,
             pg_current_wal_lsn()::text AS snapshot_lsn,
             transaction_timestamp()::text AS snapshot_at,
             current_database() AS database_name,
             current_setting('server_version_num')::integer AS server_version_num
    `);
    const snapshot = result.rows[0];
    if (!SNAPSHOT.test(snapshot.snapshot_id)) throw new Error("Database returned an invalid snapshot identifier");
    return await callback({ client, snapshot });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

export async function createExportArtifact({
  databaseUrl,
  outputDir,
  config,
  tables = null,
  kind = "lovable-source",
  exactInventory = false,
}) {
  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  const dumpDir = path.join(outputDir, "dump");
  const projectedDir = path.join(outputDir, "projected");
  const manifestPath = path.join(outputDir, "manifest.json");

  try {
    const targetBackup = kind === "staging-target-backup";
    return await withExportedSnapshot(databaseUrl, async ({ client, snapshot }) => {
      const descriptor = await databaseDescriptor(client);
      const transferTables = tables || resolveSourceTables(config, descriptor.tables);
      assertTableInventory(descriptor.tables, exactInventory ? expectedTargetTables(config) : transferTables, { exact: exactInventory });
      if (targetBackup) await assertPermanentTransferRelations(client, config.schema, transferTables);
      const schemaDescriptor = scopedDescriptor(descriptor, transferTables);
      const transferPlans = transferTables.map((table) => {
        const policy = tableTransferPolicy(config, table);
        return { table, policy, columns: assertProjectionColumns(descriptor, table, policy) };
      });
      const projectedPlans = transferPlans.filter(({ policy }) => policy.mode !== "full");
      for (const { table, policy } of projectedPlans) {
        if (policy.mode !== "empty") continue;
        const result = await client.query(`SELECT count(*)::bigint AS count FROM ${qualifiedTable(config.schema, table)}`);
        if (Number(result.rows[0].count) !== 0) {
          throw new Error(`Required-empty table is not empty: ${table}`);
        }
      }
      await mkdir(projectedDir, { mode: 0o700 });
      const args = buildPgDumpArgs({
        outputDir: dumpDir,
        schema: config.schema,
        tables: transferTables,
        snapshotId: snapshot.snapshot_id,
        excludedTableData: projectedPlans.map(({ table }) => table),
      });
      await runProcess("pg_dump", args, { databaseUrl });

      const tableManifests = [];
      for (const { table, policy, columns } of transferPlans) {
        const selectSql = policy.mode === "full"
          ? fullTableSelectSql(config.schema, table)
          : buildProjectedSelectSql({ schema: config.schema, table, columns, policy });
        if (policy.mode !== "full") {
          await writeProjectedTableData({
            databaseUrl,
            snapshotId: snapshot.snapshot_id,
            selectSql,
            outputPath: path.join(projectedDir, `${table}.copy`),
          });
        }
        const tableManifest = await streamCanonicalTable(
          databaseUrl,
          snapshot.snapshot_id,
          config.schema,
          table,
          selectSql,
        );
        tableManifests.push({
          ...tableManifest,
          transferMode: policy.mode,
          ...(policy.mode === "full" ? {} : { columns }),
        });
      }
      const toc = await runProcess("pg_restore", ["--list", dumpDir]);
      const archiveSha256 = await directoryDigest(dumpDir);
      const projectedDataSha256 = await directoryDigest(projectedDir);
      let quiescenceFence;
      if (targetBackup) {
        const walCheck = await client.query(
          "SELECT pg_current_wal_lsn()::text AS end_wal_lsn, pg_current_wal_lsn() = $1::pg_lsn AS stable",
          [snapshot.snapshot_lsn],
        );
        if (walCheck.rows[0]?.stable !== true) {
          throw new Error("Target WAL changed while the pre-import backup was being captured");
        }
        quiescenceFence = {
          schemaVersion: QUIESCENCE_SCHEMA_VERSION,
          method: "advisory-lock+wal-stability+table-counts",
          startWalLsn: snapshot.snapshot_lsn,
          endWalLsn: walCheck.rows[0].end_wal_lsn,
          relationPersistence: "permanent",
        };
      }
      const manifest = checksumManifest({
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        kind,
        createdAt: new Date().toISOString(),
        snapshotAt: snapshot.snapshot_at,
        snapshotLsn: snapshot.snapshot_lsn,
        snapshotIdSha256: sha256(snapshot.snapshot_id),
        source: {
          database: snapshot.database_name,
          serverVersionNum: snapshot.server_version_num,
        },
        schema: config.schema,
        schemaSha256: sha256(canonicalJson(schemaDescriptor)),
        archiveSha256,
        projectedDataSha256,
        transferPolicySha256: transferPolicyDigest(config, transferTables),
        tocSha256: sha256(toc),
        tables: tableManifests,
        ...(quiescenceFence ? { quiescenceFence } : {}),
      });
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      return { outputDir, dumpDir, manifestPath, manifest };
    }, { advisoryFence: targetBackup });
  } catch (error) {
    throw new Error(`Export artifact failed; incomplete directory retained for inspection: ${redactError(error)}`);
  }
}

export async function readAndVerifyArtifact(artifactDir, expectedTables, config) {
  const manifestPath = path.join(artifactDir, "manifest.json");
  const dumpDir = path.join(artifactDir, "dump");
  const projectedDir = path.join(artifactDir, "projected");
  const expectedPolicySha256 = transferPolicyDigest(config, expectedTables);
  const manifest = verifyManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
    expectedTables,
    expectedPolicySha256,
  );
  if (manifest.schema !== config.schema) throw new Error("Manifest schema mismatch");
  for (const table of manifest.tables) {
    const policy = tableTransferPolicy(config, table.table);
    if (table.transferMode !== policy.mode) {
      throw new Error(`Manifest transfer mode mismatch for ${table.table}`);
    }
    if (policy.mode === "sanitized-projection"
        && canonicalJson(table.columns) !== canonicalJson(policy.expectedColumns)) {
      throw new Error(`Manifest projected columns mismatch for ${table.table}`);
    }
  }
  const archiveSha256 = await directoryDigest(dumpDir);
  if (archiveSha256 !== manifest.archiveSha256) throw new Error("Archive digest mismatch");
  const projectedEntries = await readdir(projectedDir, { withFileTypes: true });
  const projectedTables = manifest.tables.filter(({ transferMode }) => transferMode !== "full");
  const expectedProjectedFiles = projectedTables.map(({ table }) => `${table}.copy`).sort();
  const actualProjectedFiles = projectedEntries.map(({ name }) => name).sort();
  if (canonicalJson(actualProjectedFiles) !== canonicalJson(expectedProjectedFiles)) {
    throw new Error(`Projected data inventory mismatch: expected=${expectedProjectedFiles.join(",") || "none"}; actual=${actualProjectedFiles.join(",") || "none"}`);
  }
  for (const entry of projectedEntries) {
    const filePath = path.join(projectedDir, entry.name);
    const info = await lstat(filePath);
    if (!entry.isFile() || !info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Projected data entry is not a regular file: ${entry.name}`);
    }
  }
  const projectedDataSha256 = await directoryDigest(projectedDir);
  if (projectedDataSha256 !== manifest.projectedDataSha256) throw new Error("Projected data digest mismatch");
  const toc = await runProcess("pg_restore", ["--list", dumpDir]);
  if (sha256(toc) !== manifest.tocSha256) throw new Error("Archive TOC digest mismatch");
  const tableData = [...toc.matchAll(/TABLE DATA\s+([^\s]+)\s+([^\s]+)\s+/g)]
    .map((match) => ({ schema: match[1], table: match[2] }));
  if (tableData.some(({ schema }) => schema !== config.schema)) throw new Error("Archive contains table data outside the configured schema");
  assertTableInventory(
    tableData.map(({ table }) => table),
    manifest.tables.filter(({ transferMode }) => transferMode === "full").map(({ table }) => table),
  );
  const projectedCopies = projectedTables.map(({ table, columns }) => ({
    table,
    columns,
    filePath: path.join(projectedDir, `${table}.copy`),
  }));
  return { manifest, manifestPath, dumpDir, projectedCopies };
}

export async function readAndVerifySourceArtifact(artifactDir, config) {
  const manifestPath = path.join(artifactDir, "manifest.json");
  const candidate = JSON.parse(await readFile(manifestPath, "utf8"));
  const candidateTables = Array.isArray(candidate?.tables)
    ? candidate.tables.map((table) => table?.table)
    : null;
  const sourceTables = resolveSourceTables(config, candidateTables, { rejectUnexpected: true });
  return await readAndVerifyArtifact(artifactDir, sourceTables, config);
}

async function targetSentinel(client, config) {
  const table = qualifiedTable(config.schema, config.sentinel.table);
  const result = await client.query(`SELECT value FROM ${table} WHERE key = $1`, [config.sentinel.key]);
  return result.rows[0]?.value || null;
}

async function tableCounts(client, schema, tables) {
  const counts = {};
  for (const table of tables) {
    const result = await client.query(`SELECT count(*)::bigint AS count FROM ${qualifiedTable(schema, table)}`);
    counts[table] = Number(result.rows[0].count);
  }
  return counts;
}

export async function captureTargetQuiescenceEvidence(databaseUrl, config, tables = targetReplaceTables(config)) {
  const client = new Client({ connectionString: databaseUrl, application_name: "winerim-export-reconcile-quiescence" });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await acquireTransferAdvisoryLock(client);
    await assertPermanentTransferRelations(client, config.schema, tables);
    const start = await client.query(`
      SELECT current_database() AS database_name,
             pg_current_wal_lsn()::text AS wal_lsn
    `);
    const counts = await tableCounts(client, config.schema, tables);
    const end = await client.query(
      "SELECT pg_current_wal_lsn()::text AS wal_lsn, pg_current_wal_lsn() = $1::pg_lsn AS stable",
      [start.rows[0].wal_lsn],
    );
    if (end.rows[0]?.stable !== true) {
      throw new Error("Target WAL changed while quiescence evidence was being captured");
    }
    await client.query("ROLLBACK");
    return validateQuiescenceEvidence({
      database: start.rows[0].database_name,
      walLsn: end.rows[0].wal_lsn,
      tables: tables.map((table) => ({ table, rowCount: counts[table] })),
    }, tables);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

export async function inspectTarget(databaseUrl, config, sourceTables = config.sourceTables) {
  const client = new Client({ connectionString: databaseUrl, application_name: "winerim-export-reconcile-target-check" });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const descriptor = await databaseDescriptor(client);
    const sentinel = await targetSentinel(client, config);
    const runtimeCounts = await tableCounts(client, config.schema, config.runtimeMustRemainEmpty);
    const absentOptionalTables = config.optionalSourceTables.filter((table) => !sourceTables.includes(table));
    const absentOptionalCounts = await tableCounts(client, config.schema, absentOptionalTables);
    await client.query("ROLLBACK");
    assertTableInventory(descriptor.tables, expectedTargetTables(config));
    if (sentinel !== config.sentinel.value) throw new Error("Target staging sentinel mismatch");
    return {
      descriptor,
      sentinel,
      runtimeCounts,
      absentOptionalCounts,
      sourceSchemaSha256: sha256(canonicalJson(scopedDescriptor(descriptor, sourceTables))),
    };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

async function restoreSqlFromArchive(dumpDir, restoreSqlPath) {
  await runProcess("pg_restore", [
    "--data-only",
    "--no-owner",
    "--no-privileges",
    `--file=${restoreSqlPath}`,
    dumpDir,
  ]);
  await stat(restoreSqlPath);
}

export async function applyArtifactAtomically({
  databaseUrl,
  artifactDir,
  config,
  manifestTables,
  replaceTables,
  expectedPreimage,
}) {
  const { manifest, dumpDir, projectedCopies } = await readAndVerifyArtifact(artifactDir, manifestTables, config);
  const workDir = path.join(artifactDir, ".restore-work");
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const restoreSqlPath = path.join(workDir, "restore-data.sql");
  const atomicSqlPath = path.join(workDir, "atomic-restore.sql");
  try {
    await restoreSqlFromArchive(dumpDir, restoreSqlPath);
    await writeFile(atomicSqlPath, buildAtomicRestoreSql({
      schema: config.schema,
      replaceTables,
      restoreSqlPath,
      projectedCopies,
      expectedPreimage,
    }), { mode: 0o600 });
    await runProcess("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "--file", atomicSqlPath], {
      databaseUrl,
      env: { PGOPTIONS: "-c statement_timeout=0 -c lock_timeout=5000" },
    });
    return manifest;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function checksumMap(manifest) {
  return new Map(manifest.tables.map((table) => [table.table, table]));
}

export async function reconcileTarget({
  databaseUrl,
  sourceManifest,
  config,
  tables = sourceManifest.tables.map(({ table }) => table),
}) {
  const inspection = await inspectTarget(databaseUrl, config, tables);
  assertTableInventory(sourceManifest.tables.map(({ table }) => table), tables);
  const targetSchema = scopedDescriptor(inspection.descriptor, tables);
  const schemaSha256 = sha256(canonicalJson(targetSchema));
  const tableManifests = await withExportedSnapshot(databaseUrl, async ({ snapshot }) => {
    const rows = [];
    for (const table of tables) {
      rows.push(await streamCanonicalTable(databaseUrl, snapshot.snapshot_id, config.schema, table));
    }
    return rows;
  });
  const expected = checksumMap(sourceManifest);
  const mismatches = tableManifests.filter((table) => {
    const source = expected.get(table.table);
    return !source || source.rowCount !== table.rowCount || source.sha256 !== table.sha256;
  }).map((table) => ({ table: table.table, source: expected.get(table.table), target: table }));
  const foreignKeyViolations = await checkForeignKeys(databaseUrl, inspection.descriptor.foreignKeys, config);
  const emptyTableViolations = Object.entries(inspection.runtimeCounts)
    .concat(Object.entries(inspection.absentOptionalCounts))
    .filter(([, count]) => count !== 0)
    .map(([table, count]) => ({ table, count }));
  return {
    ok: mismatches.length === 0
      && foreignKeyViolations.length === 0
      && emptyTableViolations.length === 0
      && schemaSha256 === sourceManifest.schemaSha256,
    schemaSha256,
    expectedSchemaSha256: sourceManifest.schemaSha256,
    tables: tableManifests,
    mismatches,
    foreignKeyViolations,
    emptyTableViolations,
    runtimeCounts: inspection.runtimeCounts,
    absentOptionalCounts: inspection.absentOptionalCounts,
  };
}

async function checkForeignKeys(databaseUrl, foreignKeys, config) {
  const client = new Client({ connectionString: databaseUrl, application_name: "winerim-export-reconcile-fk-check" });
  await client.connect();
  const allowed = new Set(expectedTargetTables(config));
  const violations = [];
  try {
    await client.query("BEGIN READ ONLY");
    for (const fk of foreignKeys) {
      if (!allowed.has(fk.childTable) || !allowed.has(fk.parentTable)) continue;
      if (!fk.childColumns?.length || fk.childColumns.length !== fk.parentColumns?.length) {
        throw new Error(`Unsupported FK metadata for ${fk.name}`);
      }
      const child = qualifiedTable(config.schema, fk.childTable);
      const parent = qualifiedTable(config.schema, fk.parentTable);
      const present = fk.childColumns.map((column) => `child.${quoteIdentifier(column)} IS NOT NULL`).join(" AND ");
      const match = fk.childColumns.map((column, index) => (
        `parent.${quoteIdentifier(fk.parentColumns[index])} = child.${quoteIdentifier(column)}`
      )).join(" AND ");
      const result = await client.query(`SELECT count(*)::bigint AS count FROM ${child} child WHERE ${present} AND NOT EXISTS (SELECT 1 FROM ${parent} parent WHERE ${match})`);
      const count = Number(result.rows[0].count);
      if (count > 0) violations.push({ constraint: fk.name, count });
    }
    await client.query("ROLLBACK");
    return violations;
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

export async function writeState(statePath, state) {
  const { manifestSha256: _previousDigest, ...unsignedState } = state;
  const checksummed = checksumManifest({ schemaVersion: 1, ...unsignedState, updatedAt: new Date().toISOString() });
  const directory = path.dirname(statePath);
  const tempPath = path.join(directory, `.${path.basename(statePath)}.${process.pid}.${randomUUID()}.tmp`);
  let stateHandle;
  try {
    stateHandle = await open(tempPath, "wx", 0o600);
    await stateHandle.writeFile(`${JSON.stringify(checksummed, null, 2)}\n`, "utf8");
    await stateHandle.sync();
    await stateHandle.close();
    stateHandle = null;
    await rename(tempPath, statePath);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return checksummed;
  } finally {
    await stateHandle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function readState(statePath) {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.manifestSha256 !== manifestDigest(state)) throw new Error("State digest mismatch");
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function assertRollbackReconciled(reconciliation) {
  if (!reconciliation?.ok) {
    throw new Error("Rollback target does not reconcile with the digest-verified backup manifest");
  }
  return reconciliation;
}

export function buildSafePlan(config) {
  return {
    mode: "dry-run",
    sourceEnvironment: config.sourceEnvironment,
    targetEnvironment: config.targetEnvironment,
    targetProjectRef: config.targetProjectRef,
    sourceTables: config.sourceTables,
    optionalSourceTables: config.optionalSourceTables,
    requiredSourceTables: requiredSourceTables(config),
    stagingOnlyTables: config.stagingOnlyTables,
    gates: [
      "source URL only through LOVABLE_DATABASE_URL",
      "target URL only through STAGING_DATABASE_URL",
      "exported repeatable-read snapshot with LSN/timestamp",
      "provider_credentials staging-only and required empty",
      "pos_connections exported through an exact checksummed credential-sanitizing projection",
      "only the four versioned optional source tables may be absent",
      "target sentinel environment=staging and exact 30-table inventory",
      "source-absent optional target tables required empty",
      "runtime staging tables empty before import",
      "target backup with advisory fence and continuous WAL stability evidence",
      "atomic ACCESS EXCLUSIVE lock plus preimage LSN/count checks before TRUNCATE",
      "row counts, streaming SHA-256, FK and required-empty reconciliation",
      "backup-manifest reconciliation before any ROLLED_BACK state",
    ],
  };
}
