import { assertSqlStatement, type SqlStatement } from "./sql";
import {
  DatabaseAdapterError,
  type DatabaseAdapter,
  type DatabaseTransaction,
  type DriverQueryResult,
  type HyperdriveBinding,
  type PostgresClientFactory,
  type PostgresClientLike,
  type QueryResult,
  type TransactionIsolationLevel,
  type TransactionOptions,
} from "./types";

export interface HyperdrivePostgresAdapterOptions {
  readonly createClient: PostgresClientFactory;
  readonly applicationName?: string;
  readonly onCleanupError?: (error: DatabaseAdapterError) => void;
}

const ISOLATION_SQL: Record<TransactionIsolationLevel, string> = {
  "read-committed": "READ COMMITTED",
  "repeatable-read": "REPEATABLE READ",
  serializable: "SERIALIZABLE",
};

function driverCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = String((error as { code?: unknown }).code || "");
  return /^[A-Z0-9_]{2,12}$/i.test(code) ? code : undefined;
}

function adapterError(
  code: ConstructorParameters<typeof DatabaseAdapterError>[0],
  error?: unknown,
): DatabaseAdapterError {
  return new DatabaseAdapterError(code, driverCode(error));
}

function validateBinding(binding: HyperdriveBinding): void {
  const connectionString = binding?.connectionString;
  if (
    typeof connectionString !== "string"
    || !/^postgres(?:ql)?:\/\//i.test(connectionString)
  ) {
    throw adapterError("DB_BINDING_INVALID");
  }
}

function applicationName(value: string | undefined): string {
  const normalized = (value || "winerim-middleware-api").trim();
  return /^[A-Za-z0-9_.-]{1,63}$/.test(normalized)
    ? normalized
    : "winerim-middleware-api";
}

function normalizeResult<Row extends Record<string, unknown>>(
  result: DriverQueryResult<Row>,
): QueryResult<Row> {
  return {
    rows: result.rows,
    rowCount: result.rowCount ?? result.rows.length,
  };
}

async function execute<Row extends Record<string, unknown>>(
  client: PostgresClientLike,
  statement: SqlStatement,
): Promise<QueryResult<Row>> {
  assertSqlStatement(statement);
  try {
    const result = await client.query<Row>({
      text: statement.text,
      values: [...statement.values],
    });
    return normalizeResult(result);
  } catch (error) {
    throw adapterError("DB_QUERY_FAILED", error);
  }
}

async function controlQuery(
  client: PostgresClientLike,
  text: string,
  errorCode: "DB_BEGIN_FAILED" | "DB_COMMIT_FAILED" | "DB_ROLLBACK_FAILED",
): Promise<void> {
  try {
    await client.query(text);
  } catch (error) {
    throw adapterError(errorCode, error);
  }
}

function beginSql(options: TransactionOptions): string {
  const isolation = options.isolationLevel
    ? ` ISOLATION LEVEL ${ISOLATION_SQL[options.isolationLevel]}`
    : "";
  const accessMode = options.readOnly ? " READ ONLY" : "";
  return `BEGIN${isolation}${accessMode}`;
}

export function createHyperdrivePostgresAdapter(
  binding: HyperdriveBinding,
  options: HyperdrivePostgresAdapterOptions,
): DatabaseAdapter {
  validateBinding(binding);
  const clientConfig = Object.freeze({
    connectionString: binding.connectionString,
    applicationName: applicationName(options.applicationName),
  });

  const createConnectedClient = async (): Promise<PostgresClientLike> => {
    let client: PostgresClientLike;
    try {
      client = options.createClient(clientConfig);
    } catch (error) {
      throw adapterError("DB_CLIENT_CREATE_FAILED", error);
    }

    try {
      await client.connect();
      return client;
    } catch (error) {
      try {
        await client.end();
      } catch {
        // The connect error is the actionable failure.
      }
      throw adapterError("DB_CONNECT_FAILED", error);
    }
  };

  const closeClient = async (client: PostgresClientLike): Promise<void> => {
    try {
      await client.end();
    } catch (error) {
      options.onCleanupError?.(adapterError("DB_CLEANUP_FAILED", error));
    }
  };

  return {
    async query<Row extends Record<string, unknown>>(statement: SqlStatement): Promise<QueryResult<Row>> {
      const client = await createConnectedClient();
      try {
        return await execute<Row>(client, statement);
      } finally {
        await closeClient(client);
      }
    },

    async transaction<T>(
      work: (transaction: DatabaseTransaction) => Promise<T>,
      transactionOptions: TransactionOptions = {},
    ): Promise<T> {
      const client = await createConnectedClient();
      let began = false;
      try {
        await controlQuery(client, beginSql(transactionOptions), "DB_BEGIN_FAILED");
        began = true;

        const transaction: DatabaseTransaction = Object.freeze({
          query: <Row extends Record<string, unknown>>(statement: SqlStatement) => execute<Row>(client, statement),
        });
        const result = await work(transaction);
        await controlQuery(client, "COMMIT", "DB_COMMIT_FAILED");
        began = false;
        return result;
      } catch (error) {
        if (began) {
          await controlQuery(client, "ROLLBACK", "DB_ROLLBACK_FAILED");
        }
        throw error;
      } finally {
        await closeClient(client);
      }
    },
  };
}
