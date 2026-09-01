export interface HyperdriveBinding {
  readonly connectionString: string;
}

export interface DriverQueryConfig {
  readonly text: string;
  readonly values: unknown[];
}

export interface DriverQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount: number | null;
}

export interface PostgresClientLike {
  connect(): Promise<void>;
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: string | DriverQueryConfig,
  ): Promise<DriverQueryResult<Row>>;
  end(): Promise<void>;
}

export interface PostgresClientConfig {
  readonly connectionString: string;
  readonly applicationName: string;
}

export type PostgresClientFactory = (config: PostgresClientConfig) => PostgresClientLike;

export interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export type TransactionIsolationLevel =
  | "read-committed"
  | "repeatable-read"
  | "serializable";

export interface TransactionOptions {
  readonly isolationLevel?: TransactionIsolationLevel;
  readonly readOnly?: boolean;
}

export interface DatabaseTransaction {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: import("./sql").SqlStatement,
  ): Promise<QueryResult<Row>>;
}

export interface DatabaseAdapter extends DatabaseTransaction {
  transaction<T>(
    work: (transaction: DatabaseTransaction) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
}

export type DatabaseAdapterErrorCode =
  | "DB_BINDING_INVALID"
  | "DB_CLIENT_CREATE_FAILED"
  | "DB_CONNECT_FAILED"
  | "DB_QUERY_FAILED"
  | "DB_BEGIN_FAILED"
  | "DB_COMMIT_FAILED"
  | "DB_ROLLBACK_FAILED"
  | "DB_CLEANUP_FAILED";

export class DatabaseAdapterError extends Error {
  readonly code: DatabaseAdapterErrorCode;
  readonly driverCode?: string;

  constructor(code: DatabaseAdapterErrorCode, driverCode?: string) {
    super(code);
    this.name = "DatabaseAdapterError";
    this.code = code;
    this.driverCode = driverCode;
  }
}
