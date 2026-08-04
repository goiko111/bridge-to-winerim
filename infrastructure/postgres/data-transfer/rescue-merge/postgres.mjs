import pg from "pg";

import { canonicalJson, sha256 } from "./planner.mjs";

const { Client } = pg;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function quoteIdentifier(value) {
  if (!IDENTIFIER.test(String(value))) throw new Error("UNSAFE_SQL_IDENTIFIER");
  return `"${value}"`;
}

function qualifiedTable(table) {
  return `"public".${quoteIdentifier(table)}`;
}

function lockParts(namespace) {
  const hex = sha256(namespace).slice(0, 16);
  const left = Number.parseInt(hex.slice(0, 8), 16) | 0;
  const right = Number.parseInt(hex.slice(8, 16), 16) | 0;
  return [left, right];
}

export function databaseIdentityDigest({ database, systemIdentifier }) {
  return sha256(canonicalJson({
    database: String(database),
    systemIdentifier: String(systemIdentifier),
  }));
}

function canonicalColumnOverride(column) {
  const identifier = quoteIdentifier(column.column_name);
  const type = column.data_type;
  if (type === "timestamp with time zone") {
    return `CASE WHEN ${identifier} IS NULL THEN NULL ELSE to_char(${identifier} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END`;
  }
  if (type === "timestamp without time zone") {
    return `CASE WHEN ${identifier} IS NULL THEN NULL ELSE to_char(${identifier}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END`;
  }
  if (type === "time with time zone" || type === "time without time zone") {
    return `CASE WHEN ${identifier} IS NULL THEN NULL ELSE ${identifier}::text END`;
  }
  if (type === "date") {
    return `CASE WHEN ${identifier} IS NULL THEN NULL ELSE to_char(${identifier}, 'YYYY-MM-DD') END`;
  }
  if (type === "numeric" || type === "decimal" || type === "bigint") {
    return `CASE WHEN ${identifier} IS NULL THEN NULL ELSE ${identifier}::text END`;
  }
  if (type === "bytea") {
    return `CASE WHEN ${identifier} IS NULL THEN NULL ELSE encode(${identifier}, 'hex') END`;
  }
  return null;
}

function buildCanonicalRowSelect(table, columns) {
  if (!columns.length) throw new Error(`TABLE_HAS_NO_COLUMNS:${table}`);
  const overrides = columns
    .map((column) => ({ column, expression: canonicalColumnOverride(column) }))
    .filter(({ expression }) => expression);
  let expression = "to_jsonb(source_row)";
  for (let index = 0; index < overrides.length; index += 40) {
    const pairs = overrides.slice(index, index + 40).flatMap(({ column, expression: value }) => [
      `'${column.column_name}'`,
      value,
    ]);
    expression += ` || jsonb_build_object(${pairs.join(", ")})`;
  }
  return `SELECT (${expression})::text AS row_json FROM ${qualifiedTable(table)} AS source_row`;
}

function encodeInsertValue(value, column) {
  if (value === null || value === undefined) return value;
  if (column.data_type === "json" || column.data_type === "jsonb") return JSON.stringify(value);
  if (column.data_type === "bytea") return Buffer.from(String(value), "hex");
  if (typeof value === "object" && !Array.isArray(value)) throw new Error("NON_JSON_OBJECT_COLUMN");
  return value;
}

function insertCast(column) {
  if (column.data_type === "json") return "::json";
  if (column.data_type === "jsonb") return "::jsonb";
  return "";
}

export class PostgresRescueMergeDatabase {
  constructor({ connectionString }) {
    if (!connectionString) throw new Error("RESCUE_MERGE_TARGET_DATABASE_URL_REQUIRED");
    this.client = new Client({
      connectionString,
      application_name: "winerim-rescue-merge-executor",
      connectionTimeoutMillis: 10_000,
      query_timeout: 300_000,
      statement_timeout: 300_000,
    });
    this.columns = new Map();
  }

  async connect() {
    await this.client.connect();
  }

  async beginSerializable() {
    await this.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE");
    await this.client.query("SET LOCAL lock_timeout = '10s'");
    await this.client.query("SET LOCAL statement_timeout = '5min'");
    await this.client.query("SET LOCAL idle_in_transaction_session_timeout = '5min'");
  }

  async acquireAdvisoryLock(namespace) {
    const [left, right] = lockParts(namespace);
    await this.client.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [left, right]);
  }

  async databaseIdentitySha256() {
    const result = await this.client.query(`
      SELECT current_database() AS database,
             system_identifier::text AS system_identifier
      FROM pg_control_system()
    `);
    if (result.rowCount !== 1 || !result.rows[0]?.system_identifier) {
      throw new Error("DATABASE_IDENTITY_PROBE_UNAVAILABLE");
    }
    return databaseIdentityDigest({
      database: result.rows[0].database,
      systemIdentifier: result.rows[0].system_identifier,
    });
  }

  async tableColumns(table) {
    if (this.columns.has(table)) return this.columns.get(table);
    quoteIdentifier(table);
    const result = await this.client.query(`
      SELECT column_name, data_type, udt_name, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [table]);
    if (!result.rowCount) throw new Error(`TABLE_SCHEMA_NOT_FOUND:${table}`);
    this.columns.set(table, result.rows);
    return result.rows;
  }

  async readTables(tables) {
    const result = {};
    for (const table of tables) {
      const columns = await this.tableColumns(table);
      const rows = await this.client.query(buildCanonicalRowSelect(table, columns));
      result[table] = rows.rows.map(({ row_json: rowJson }) => JSON.parse(rowJson));
    }
    return result;
  }

  async insertRow(table, row) {
    const columns = await this.tableColumns(table);
    const byName = new Map(columns.map((column) => [column.column_name, column]));
    const names = Object.keys(row).sort();
    if (!names.length || names.some((name) => !IDENTIFIER.test(name) || !byName.has(name))) {
      throw new Error(`INSERT_SCHEMA_MISMATCH:${table}`);
    }
    const values = names.map((name) => encodeInsertValue(row[name], byName.get(name)));
    const placeholders = names.map((name, index) => `$${index + 1}${insertCast(byName.get(name))}`);
    const sql = `INSERT INTO ${qualifiedTable(table)} (${names.map(quoteIdentifier).join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING 1 AS inserted`;
    const result = await this.client.query(sql, values);
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
