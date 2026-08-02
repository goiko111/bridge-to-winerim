import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Client } = pg;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SNAPSHOT = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9]+$/i;
const PROJECT_REF = /^[a-z0-9]{20}$/;
const SAFE_ERROR = /postgres(?:ql)?:\/\/[^\s]+/gi;

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
  if (config?.schemaVersion !== 1 || !IDENTIFIER.test(config?.schema || "")) {
    throw new Error("Unsupported data-transfer config");
  }
  const source = config.sourceTables;
  const stagingOnly = config.stagingOnlyTables;
  if (!Array.isArray(source) || source.length === 0 || !Array.isArray(stagingOnly)) {
    throw new Error("Data-transfer table lists are required");
  }
  const all = [...source, ...stagingOnly];
  if (new Set(all).size !== all.length || all.some((name) => !IDENTIFIER.test(name))) {
    throw new Error("Data-transfer table allowlist contains duplicates or unsafe names");
  }
  if (!Array.isArray(config.runtimeMustRemainEmpty)
      || config.runtimeMustRemainEmpty.some((name) => !stagingOnly.includes(name))) {
    throw new Error("Runtime empty-table gate must be a staging-only subset");
  }
  if (!PROJECT_REF.test(config.targetProjectRef || "")) {
    throw new Error("Target project ref is required");
  }
  return config;
}

export function expectedTargetTables(config) {
  return [...config.sourceTables, ...config.stagingOnlyTables].sort();
}

export function targetReplaceTables(config) {
  return [...config.sourceTables, ...config.runtimeMustRemainEmpty].sort();
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

export function buildPgDumpArgs({ outputDir, schema, tables, snapshotId }) {
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
  return args;
}

function psqlIncludePath(filePath) {
  return `'${path.resolve(filePath).replaceAll("'", "''")}'`;
}

export function buildAtomicRestoreSql({ schema, replaceTables, restoreSqlPath }) {
  if (!replaceTables.length) throw new Error("Atomic restore needs at least one table");
  const tables = replaceTables.map((table) => qualifiedTable(schema, table)).join(",\n  ");
  return [
    "\\set ON_ERROR_STOP on",
    "BEGIN;",
    "SET LOCAL lock_timeout = '5s';",
    "SET LOCAL statement_timeout = '0';",
    "SET LOCAL idle_in_transaction_session_timeout = '10min';",
    "SET LOCAL session_replication_role = replica;",
    `TRUNCATE TABLE\n  ${tables}\nRESTART IDENTITY;`,
    `\\ir ${psqlIncludePath(restoreSqlPath)}`,
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

export function signManifest(manifest) {
  return { ...manifest, manifestSha256: manifestDigest(manifest) };
}

export function verifyManifest(manifest, expectedTables) {
  if (manifest?.schemaVersion !== 1 || manifest?.manifestSha256 !== manifestDigest(manifest)) {
    throw new Error("Manifest signature mismatch");
  }
  if (!Array.isArray(manifest.tables)) throw new Error("Manifest table list missing");
  assertTableInventory(manifest.tables.map(({ table }) => table), expectedTables);
  for (const table of manifest.tables) {
    if (!IDENTIFIER.test(table.table) || !Number.isSafeInteger(table.rowCount) || table.rowCount < 0 || !SHA256.test(table.sha256)) {
      throw new Error(`Invalid table manifest for ${String(table.table)}`);
    }
  }
  if (!SHA256.test(manifest.archiveSha256 || "") || !SHA256.test(manifest.schemaSha256 || "")) {
    throw new Error("Manifest archive/schema digest missing");
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
  if (localTest) {
    if (!/^(127\.0\.0\.1|localhost)$/.test(parsed.hostname)) throw new Error("Local-test gate only accepts localhost");
  } else if (!decodeURIComponent(url).includes(config.targetProjectRef)) {
    throw new Error("Target URL does not identify the configured staging project");
  }
  if (sourceUrl && normalizedDatabaseIdentity(sourceUrl) === normalizedDatabaseIdentity(url)) {
    throw new Error("Source and target database identities must differ");
  }
  return parsed;
}

function normalizedDatabaseIdentity(url) {
  const parsed = new URL(url);
  return `${parsed.hostname.toLowerCase()}:${parsed.port || "5432"}/${parsed.pathname.replace(/^\//, "")}`;
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

async function streamCanonicalTable(databaseUrl, snapshotId, schema, table) {
  const sql = [
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;",
    `SET TRANSACTION SNAPSHOT '${snapshotId}';`,
    "COPY (",
    "  SELECT row_value",
    `  FROM (SELECT to_jsonb(row_data)::text AS row_value FROM ${qualifiedTable(schema, table)} AS row_data) canonical_rows`,
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

export async function withExportedSnapshot(databaseUrl, callback) {
  const client = new Client({ connectionString: databaseUrl, application_name: "winerim-export-reconcile-snapshot" });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
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
  tables = config.sourceTables,
  kind = "lovable-source",
  exactInventory = false,
}) {
  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  const dumpDir = path.join(outputDir, "dump");
  const manifestPath = path.join(outputDir, "manifest.json");

  try {
    return await withExportedSnapshot(databaseUrl, async ({ client, snapshot }) => {
      const descriptor = await databaseDescriptor(client);
      assertTableInventory(descriptor.tables, exactInventory ? expectedTargetTables(config) : tables, { exact: exactInventory });
      const schemaDescriptor = scopedDescriptor(descriptor, tables);
      const args = buildPgDumpArgs({ outputDir: dumpDir, schema: config.schema, tables, snapshotId: snapshot.snapshot_id });
      await runProcess("pg_dump", args, { databaseUrl });

      const tableManifests = [];
      for (const table of tables) {
        tableManifests.push(await streamCanonicalTable(databaseUrl, snapshot.snapshot_id, config.schema, table));
      }
      const toc = await runProcess("pg_restore", ["--list", dumpDir]);
      const archiveSha256 = await directoryDigest(dumpDir);
      const manifest = signManifest({
        schemaVersion: 1,
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
        tocSha256: sha256(toc),
        tables: tableManifests,
      });
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      return { outputDir, dumpDir, manifestPath, manifest };
    });
  } catch (error) {
    throw new Error(`Export artifact failed; incomplete directory retained for inspection: ${redactError(error)}`);
  }
}

export async function readAndVerifyArtifact(artifactDir, expectedTables) {
  const manifestPath = path.join(artifactDir, "manifest.json");
  const dumpDir = path.join(artifactDir, "dump");
  const manifest = verifyManifest(JSON.parse(await readFile(manifestPath, "utf8")), expectedTables);
  const archiveSha256 = await directoryDigest(dumpDir);
  if (archiveSha256 !== manifest.archiveSha256) throw new Error("Archive digest mismatch");
  const toc = await runProcess("pg_restore", ["--list", dumpDir]);
  if (sha256(toc) !== manifest.tocSha256) throw new Error("Archive TOC digest mismatch");
  const tableData = [...toc.matchAll(/TABLE DATA\s+([^\s]+)\s+([^\s]+)\s+/g)]
    .map((match) => ({ schema: match[1], table: match[2] }));
  if (tableData.some(({ schema }) => schema !== "public")) throw new Error("Archive contains table data outside public schema");
  assertTableInventory(tableData.map(({ table }) => table), expectedTables);
  return { manifest, manifestPath, dumpDir };
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

export async function inspectTarget(databaseUrl, config) {
  const client = new Client({ connectionString: databaseUrl, application_name: "winerim-export-reconcile-target-check" });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const descriptor = await databaseDescriptor(client);
    const sentinel = await targetSentinel(client, config);
    const runtimeCounts = await tableCounts(client, config.schema, config.runtimeMustRemainEmpty);
    await client.query("ROLLBACK");
    assertTableInventory(descriptor.tables, expectedTargetTables(config));
    if (sentinel !== config.sentinel.value) throw new Error("Target staging sentinel mismatch");
    return {
      descriptor,
      sentinel,
      runtimeCounts,
      sourceSchemaSha256: sha256(canonicalJson(scopedDescriptor(descriptor, config.sourceTables))),
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

export async function applyArtifactAtomically({ databaseUrl, artifactDir, config, manifestTables, replaceTables }) {
  const { manifest, dumpDir } = await readAndVerifyArtifact(artifactDir, manifestTables);
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

export async function reconcileTarget({ databaseUrl, sourceManifest, config }) {
  const inspection = await inspectTarget(databaseUrl, config);
  const targetSchema = scopedDescriptor(inspection.descriptor, config.sourceTables);
  const schemaSha256 = sha256(canonicalJson(targetSchema));
  const tables = await withExportedSnapshot(databaseUrl, async ({ snapshot }) => {
    const rows = [];
    for (const table of config.sourceTables) {
      rows.push(await streamCanonicalTable(databaseUrl, snapshot.snapshot_id, config.schema, table));
    }
    return rows;
  });
  const expected = checksumMap(sourceManifest);
  const mismatches = tables.filter((table) => {
    const source = expected.get(table.table);
    return !source || source.rowCount !== table.rowCount || source.sha256 !== table.sha256;
  }).map((table) => ({ table: table.table, source: expected.get(table.table), target: table }));
  const foreignKeyViolations = await checkForeignKeys(databaseUrl, inspection.descriptor.foreignKeys, config);
  return {
    ok: mismatches.length === 0 && foreignKeyViolations.length === 0 && schemaSha256 === sourceManifest.schemaSha256,
    schemaSha256,
    expectedSchemaSha256: sourceManifest.schemaSha256,
    tables,
    mismatches,
    foreignKeyViolations,
    runtimeCounts: inspection.runtimeCounts,
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
  const signed = signManifest({ schemaVersion: 1, ...state, updatedAt: new Date().toISOString() });
  await writeFile(statePath, `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
  return signed;
}

export async function readState(statePath) {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.manifestSha256 !== manifestDigest(state)) throw new Error("State signature mismatch");
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function buildSafePlan(config) {
  return {
    mode: "dry-run",
    sourceEnvironment: config.sourceEnvironment,
    targetEnvironment: config.targetEnvironment,
    targetProjectRef: config.targetProjectRef,
    sourceTables: config.sourceTables,
    stagingOnlyTables: config.stagingOnlyTables,
    gates: [
      "source URL only through LOVABLE_DATABASE_URL",
      "target URL only through STAGING_DATABASE_URL",
      "exported repeatable-read snapshot with LSN/timestamp",
      "target sentinel environment=staging and exact 29-table inventory",
      "runtime staging tables empty before import",
      "target backup before one-transaction replacement",
      "row counts, streaming SHA-256 and FK reconciliation",
      "automatic rollback on post-import mismatch",
    ],
  };
}
