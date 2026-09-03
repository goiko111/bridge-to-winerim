# Hyperdrive Postgres adapter

This module is independent from the Lovable Cloud REST API. It accepts the
Cloudflare Hyperdrive binding and a small `pg`-compatible client factory.

## Integration contract

The clean infrastructure branch adds `pg` and its TypeScript types and enables
`nodejs_compat`. The remaining remote gate is to create the middleware's own
Hyperdrive and bind it as `MIDDLEWARE_DB` in staging.

```ts
import { Client } from "pg";
import {
  allowlistedIdentifier,
  createHyperdrivePostgresAdapter,
  sql,
  type HyperdriveBinding,
  type PostgresClientFactory,
} from "./db";

interface Env {
  MIDDLEWARE_DB: HyperdriveBinding;
}

const createClient: PostgresClientFactory = ({ connectionString, applicationName }) => {
  const client = new Client({
    connectionString,
    application_name: applicationName,
  });

  return {
    connect: () => client.connect(),
    query: async (query) => {
      const result = await client.query(query);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    end: () => client.end(),
  };
};

const db = createHyperdrivePostgresAdapter(env.MIDDLEWARE_DB, { createClient });

const connection = await db.query<{ id: string; enabled: boolean }>(sql`
  SELECT id, enabled
  FROM pos_connections
  WHERE id = ${connectionId}
`);
```

Every ordinary interpolation becomes a positional parameter. A dynamic table
or column name is rejected as a value by Postgres and must instead pass an
explicit allowlist:

```ts
const table = allowlistedIdentifier(tableName, [
  "public.pos_connections",
  "public.sales_events",
] as const);

const result = await db.query(sql`SELECT id FROM ${table} WHERE id = ${id}`);
```

Transactions are supported and keep one driver client for `BEGIN`, all work,
and `COMMIT` or `ROLLBACK`:

```ts
await db.transaction(async (tx) => {
  await tx.query(sql`UPDATE integration_onboarding_requests SET status = ${status} WHERE id = ${id}`);
  await tx.query(sql`INSERT INTO audit_log (request_id) VALUES (${id})`);
}, { isolationLevel: "serializable" });
```

Keep transactions short: Hyperdrive pins their database connection until the
transaction completes. A commit whose network response is uncertain still
requires the middleware's existing idempotency contract at the operation
level.
