import pg from "pg";

import {
  IMPORT_TABLES,
  SOURCE_TABLES,
  canonicalize,
  sha256,
} from "./core.mjs";

const { Client } = pg;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function quoteIdentifier(value) {
  assert(IDENTIFIER.test(String(value)), "UNSAFE_SQL_IDENTIFIER");
  return `"${value}"`;
}

function qualifiedTable(table) {
  return `public.${quoteIdentifier(table)}`;
}

function normalizeRow(row) {
  return canonicalize(row);
}

function canonicalColumnOverride(column) {
  const identifier = quoteIdentifier(column.column_name);
  if (column.data_type === "timestamp with time zone") {
    return `CASE WHEN ${identifier} IS NULL THEN NULL ELSE to_char(${identifier} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END`;
  }
  if (column.data_type === "timestamp without time zone") {
    return `CASE WHEN ${identifier} IS NULL THEN NULL ELSE to_char(${identifier}, 'YYYY-MM-DD"T"HH24:MI:SS.MS') END`;
  }
  if (column.data_type === "date") {
    return `CASE WHEN ${identifier} IS NULL THEN NULL ELSE to_char(${identifier}, 'YYYY-MM-DD') END`;
  }
  if (["numeric", "decimal", "bigint"].includes(column.data_type)) {
    return `CASE WHEN ${identifier} IS NULL THEN NULL ELSE ${identifier}::text END`;
  }
  if (["time with time zone", "time without time zone"].includes(column.data_type)) {
    return `CASE WHEN ${identifier} IS NULL THEN NULL ELSE ${identifier}::text END`;
  }
  if (column.data_type === "bytea") {
    return `CASE WHEN ${identifier} IS NULL THEN NULL ELSE encode(${identifier}, 'hex') END`;
  }
  return null;
}

function canonicalRowSelect(table, columns, scopeColumn) {
  let expression = "to_jsonb(source_row)";
  const overrides = columns
    .map((column) => ({ column, expression: canonicalColumnOverride(column) }))
    .filter((entry) => entry.expression);
  for (let index = 0; index < overrides.length; index += 40) {
    const pairs = overrides.slice(index, index + 40).flatMap(({ column, expression: value }) => [
      `'${column.column_name}'`,
      value,
    ]);
    expression += ` || jsonb_build_object(${pairs.join(", ")})`;
  }
  return `SELECT (${expression})::text AS row_json FROM ${qualifiedTable(table)} AS source_row WHERE ${quoteIdentifier(scopeColumn)} = $1::uuid ORDER BY id`;
}

export function isLocalDatabaseUrl(databaseUrl) {
  const value = String(databaseUrl || "");
  return /(?:localhost|127\.0\.0\.1|\[::1\]|host=%2F|host=\/)/i.test(value)
    || /^postgres(?:ql)?:\/{3}/.test(value);
}

export class ConnectionHydratorDatabase {
  constructor({ connectionString, applicationName = "winerim-connection-hydrator" }) {
    if (!connectionString) throw new Error("CONNECTION_HYDRATOR_DATABASE_URL_REQUIRED");
    this.connectionString = connectionString;
    this.client = new Client({
      connectionString,
      application_name: applicationName,
      connectionTimeoutMillis: 10_000,
      query_timeout: 300_000,
      statement_timeout: 300_000,
    });
    this.columns = new Map();
  }

  async connect() {
    await this.client.connect();
  }

  async beginReadOnly() {
    await this.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await this.client.query("SET LOCAL lock_timeout = '10s'");
    await this.client.query("SET LOCAL statement_timeout = '5min'");
    await this.client.query("SET LOCAL idle_in_transaction_session_timeout = '5min'");
  }

  async beginWrite() {
    await this.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE");
    await this.client.query("SET LOCAL lock_timeout = '10s'");
    await this.client.query("SET LOCAL statement_timeout = '5min'");
    await this.client.query("SET LOCAL idle_in_transaction_session_timeout = '5min'");
  }

  async acquireLock(connectionId) {
    await this.client.query(
      "SELECT pg_advisory_xact_lock(hashtext('winerim-connection-hydrator'), hashtext($1::text))",
      [connectionId],
    );
  }

  async watermark() {
    const result = await this.client.query(`
      SELECT clock_timestamp() AS captured_at,
             pg_current_wal_lsn()::text AS wal_lsn,
             txid_current_snapshot()::text AS snapshot,
             current_database() AS database,
             (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier
    `);
    assert(result.rowCount === 1, "DATABASE_WATERMARK_UNAVAILABLE");
    const row = result.rows[0];
    return canonicalize({
      capturedAt: row.captured_at,
      walLsn: row.wal_lsn,
      snapshotSha256: sha256(String(row.snapshot)),
      databaseIdentitySha256: sha256({ database: row.database, systemIdentifier: row.system_identifier }),
    });
  }

  async tableColumns(table) {
    if (this.columns.has(table)) return this.columns.get(table);
    quoteIdentifier(table);
    const result = await this.client.query(`
      SELECT column_name, data_type, udt_name, is_nullable, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [table]);
    assert(result.rowCount > 0, `TARGET_TABLE_MISSING:${table}`);
    const columns = result.rows.map(normalizeRow);
    this.columns.set(table, columns);
    return columns;
  }

  async schema(tables = SOURCE_TABLES) {
    const result = {};
    for (const table of tables) result[table] = await this.tableColumns(table);
    return result;
  }

  async readConnectionTable(table, connectionId) {
    quoteIdentifier(table);
    const columns = await this.tableColumns(table);
    const scopeColumn = table === "pos_connections" ? "id" : "connection_id";
    const result = await this.client.query(canonicalRowSelect(table, columns, scopeColumn), [connectionId]);
    return result.rows.map(({ row_json: rowJson }) => normalizeRow(JSON.parse(rowJson)));
  }

  async readSourceTables(connectionId) {
    const result = {};
    for (const table of SOURCE_TABLES) result[table] = await this.readConnectionTable(table, connectionId);
    return result;
  }

  async readTargetTables(connectionId) {
    const result = {};
    for (const table of IMPORT_TABLES) result[table] = await this.readConnectionTable(table, connectionId);
    return result;
  }

  async runtimeActivity(connectionId) {
    const tableExists = async (table) => {
      const result = await this.client.query("SELECT to_regclass($1) IS NOT NULL AS present", [`public.${table}`]);
      return Boolean(result.rows[0]?.present);
    };
    const countActive = async (table) => {
      if (!await tableExists(table)) return 0;
      const result = await this.client.query(
        `SELECT count(*)::bigint AS count FROM ${qualifiedTable(table)} WHERE connection_id = $1::uuid AND active`,
        [connectionId],
      );
      return Number(result.rows[0]?.count || 0);
    };
    const countActiveCatalogScopes = async () => {
      if (!await tableExists("runtime_catalog_source_scope")) return 0;
      assert(await tableExists("runtime_canary_connections"), "RUNTIME_CATALOG_SCOPE_CANARY_TABLE_MISSING");
      const scopeColumns = new Set((await this.tableColumns("runtime_catalog_source_scope")).map(({ column_name: name }) => name));
      const canaryColumns = new Set((await this.tableColumns("runtime_canary_connections")).map(({ column_name: name }) => name));
      for (const column of ["connection_id", "run_id"]) {
        assert(scopeColumns.has(column), `RUNTIME_CATALOG_SCOPE_COLUMN_MISSING:${column}`);
      }
      for (const column of ["connection_id", "run_id", "active"]) {
        assert(canaryColumns.has(column), `RUNTIME_CANARY_COLUMN_MISSING:${column}`);
      }
      const result = await this.client.query(`
        SELECT
          count(*) FILTER (WHERE canary.active)::bigint AS active_count,
          count(*) FILTER (WHERE canary.run_id IS NULL)::bigint AS orphan_count
        FROM public.runtime_catalog_source_scope scope
        LEFT JOIN public.runtime_canary_connections canary
          ON canary.connection_id = scope.connection_id
         AND scope.run_id = canary.run_id
        WHERE scope.connection_id = $1::uuid
      `, [connectionId]);
      assert(Number(result.rows[0]?.orphan_count || 0) === 0, "RUNTIME_CATALOG_SCOPE_RUN_ID_ORPHANED");
      return Number(result.rows[0]?.active_count || 0);
    };
    return {
      activeScopes: await countActive("runtime_canary_connections"),
      activeCredentials: await countActive("runtime_connection_credentials"),
      activeCatalogScopes: await countActiveCatalogScopes(),
    };
  }

  async assertRowsFitSchema(table, rows) {
    const available = new Set((await this.tableColumns(table)).map((column) => column.column_name));
    for (const row of rows) {
      const missing = Object.keys(row).filter((column) => !available.has(column));
      assert(missing.length === 0, `TARGET_SCHEMA_MISMATCH:${table}:${missing.join(",")}`);
    }
  }

  async insertRows(table, rows) {
    if (!rows.length) return 0;
    await this.assertRowsFitSchema(table, rows);
    const schema = await this.tableColumns(table);
    const byName = new Map(schema.map((column) => [column.column_name, column]));
    let inserted = 0;
    for (const row of rows) {
      const columns = Object.keys(row).sort();
      const values = columns.map((column) => {
        const value = row[column];
        const dataType = byName.get(column)?.data_type;
        return value !== null && value !== undefined && ["json", "jsonb"].includes(dataType)
          ? JSON.stringify(value)
          : value;
      });
      const placeholders = columns.map((column, index) => {
        const dataType = byName.get(column)?.data_type;
        return ["json", "jsonb"].includes(dataType) ? `$${index + 1}::${dataType}` : `$${index + 1}`;
      });
      const result = await this.client.query(
        `INSERT INTO ${qualifiedTable(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${placeholders.join(", ")})`,
        values,
      );
      inserted += result.rowCount;
    }
    return inserted;
  }

  async deleteIds(table, ids) {
    if (!ids.length) return 0;
    quoteIdentifier(table);
    const result = await this.client.query(
      `DELETE FROM ${qualifiedTable(table)} WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return result.rowCount;
  }

  async commit() {
    await this.client.query("COMMIT");
  }

  async rollback() {
    await this.client.query("ROLLBACK");
  }

  async close() {
    await this.client.end();
  }
}
