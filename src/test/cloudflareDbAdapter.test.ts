import { describe, expect, it, vi } from "vitest";
import {
  createHyperdrivePostgresAdapter,
  DatabaseAdapterError,
  sql,
  type DriverQueryConfig,
  type DriverQueryResult,
  type PostgresClientLike,
} from "../../cloudflare/workers/middleware-api/src/db";

type DriverCall = string | DriverQueryConfig;

interface FakeClientControls {
  readonly client: PostgresClientLike;
  readonly calls: DriverCall[];
  readonly connect: ReturnType<typeof vi.fn>;
  readonly end: ReturnType<typeof vi.fn>;
}

function fakeClient(
  handler: (query: DriverCall) => DriverQueryResult = () => ({ rows: [], rowCount: 0 }),
): FakeClientControls {
  const calls: DriverCall[] = [];
  const connect = vi.fn(async () => undefined);
  const end = vi.fn(async () => undefined);
  const client: PostgresClientLike = {
    connect,
    end,
    async query<Row extends Record<string, unknown>>(query: DriverCall) {
      calls.push(query);
      return handler(query) as DriverQueryResult<Row>;
    },
  };
  return { client, calls, connect, end };
}

describe("Cloudflare Hyperdrive Postgres adapter", () => {
  it("opens one client, runs a parameterized SELECT and closes it", async () => {
    const fake = fakeClient((query) => {
      if (typeof query === "string") return { rows: [], rowCount: 0 };
      return { rows: [{ id: query.values[0], enabled: true }], rowCount: 1 };
    });
    const createClient = vi.fn(() => fake.client);
    const db = createHyperdrivePostgresAdapter(
      { connectionString: "postgres://hyperdrive.internal/middleware" },
      { createClient },
    );

    const result = await db.query<{ id: unknown; enabled: boolean }>(
      sql`SELECT id, enabled FROM pos_connections WHERE id = ${"connection-1"}`,
    );

    expect(result).toEqual({ rows: [{ id: "connection-1", enabled: true }], rowCount: 1 });
    expect(fake.calls).toEqual([{
      text: "SELECT id, enabled FROM pos_connections WHERE id = $1",
      values: ["connection-1"],
    }]);
    expect(fake.connect).toHaveBeenCalledOnce();
    expect(fake.end).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith({
      connectionString: "postgres://hyperdrive.internal/middleware",
      applicationName: "winerim-middleware-api",
    });
  });

  it("keeps all transaction queries on the same client and commits", async () => {
    const fake = fakeClient((query) => {
      if (typeof query === "string") return { rows: [], rowCount: null };
      return { rows: [{ ok: true }], rowCount: 1 };
    });
    const db = createHyperdrivePostgresAdapter(
      { connectionString: "postgresql://hyperdrive.internal/middleware" },
      { createClient: () => fake.client },
    );

    const result = await db.transaction(async (transaction) => {
      const first = await transaction.query<{ ok: boolean }>(sql`SELECT ${1}::int AS ok`);
      await transaction.query(sql`UPDATE integration_onboarding_requests SET status = ${"DONE"} WHERE id = ${"request-1"}`);
      return first.rows[0].ok;
    }, { isolationLevel: "serializable", readOnly: false });

    expect(result).toBe(true);
    expect(fake.calls).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      { text: "SELECT $1::int AS ok", values: [1] },
      {
        text: "UPDATE integration_onboarding_requests SET status = $1 WHERE id = $2",
        values: ["DONE", "request-1"],
      },
      "COMMIT",
    ]);
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it("supports an explicit read-only transaction", async () => {
    const fake = fakeClient();
    const db = createHyperdrivePostgresAdapter(
      { connectionString: "postgres://hyperdrive.internal/middleware" },
      { createClient: () => fake.client },
    );

    await db.transaction(async (transaction) => {
      await transaction.query(sql`SELECT 1`);
    }, { isolationLevel: "repeatable-read", readOnly: true });

    expect(fake.calls[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(fake.calls.at(-1)).toBe("COMMIT");
  });

  it("rolls back when the transaction callback fails", async () => {
    const fake = fakeClient();
    const db = createHyperdrivePostgresAdapter(
      { connectionString: "postgres://hyperdrive.internal/middleware" },
      { createClient: () => fake.client },
    );
    const expected = new Error("application validation failed");

    await expect(db.transaction(async (transaction) => {
      await transaction.query(sql`SELECT 1`);
      throw expected;
    })).rejects.toBe(expected);

    expect(fake.calls).toEqual([
      "BEGIN",
      { text: "SELECT 1", values: [] },
      "ROLLBACK",
    ]);
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it("returns a sanitized query error without connection details", async () => {
    const fake = fakeClient(() => {
      throw Object.assign(new Error("password=secret host=db.internal query failed"), { code: "23505" });
    });
    const db = createHyperdrivePostgresAdapter(
      { connectionString: "postgres://user:secret@hyperdrive.internal/middleware" },
      { createClient: () => fake.client },
    );

    let caught: unknown;
    try {
      await db.query(sql`SELECT ${"secret-value"}`);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DatabaseAdapterError);
    expect(caught).toMatchObject({ code: "DB_QUERY_FAILED", driverCode: "23505" });
    expect(JSON.stringify(caught)).not.toContain("secret");
    expect(String(caught)).not.toContain("db.internal");
  });

  it("does not turn a successful query into a retryable failure when cleanup fails", async () => {
    const fake = fakeClient(() => ({ rows: [{ ok: true }], rowCount: 1 }));
    fake.end.mockRejectedValueOnce(new Error("socket already closed"));
    const cleanupErrors: DatabaseAdapterError[] = [];
    const db = createHyperdrivePostgresAdapter(
      { connectionString: "postgres://hyperdrive.internal/middleware" },
      {
        createClient: () => fake.client,
        onCleanupError: (error) => cleanupErrors.push(error),
      },
    );

    await expect(db.query<{ ok: boolean }>(sql`SELECT true AS ok`))
      .resolves.toEqual({ rows: [{ ok: true }], rowCount: 1 });
    expect(cleanupErrors).toHaveLength(1);
    expect(cleanupErrors[0].code).toBe("DB_CLEANUP_FAILED");
  });

  it("fails before creating a client when Hyperdrive binding is invalid", () => {
    const createClient = vi.fn();

    expect(() => createHyperdrivePostgresAdapter(
      { connectionString: "https://not-postgres.example" },
      { createClient },
    )).toThrowError(expect.objectContaining({ code: "DB_BINDING_INVALID" }));
    expect(createClient).not.toHaveBeenCalled();
  });
});
