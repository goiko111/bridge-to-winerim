import test from "node:test";
import assert from "node:assert/strict";

import { ConnectionHydratorDatabase } from "./postgres.mjs";

const CONNECTION_ID = "e465872a-bff5-43de-8e4c-fe4986f0fd4f";

function databaseFixture({ orphanCount = 0, scopeColumns = ["connection_id", "run_id"] } = {}) {
  const database = Object.create(ConnectionHydratorDatabase.prototype);
  database.columns = new Map();
  database.client = {
    async query(sql, parameters = []) {
      if (sql.includes("to_regclass")) return { rows: [{ present: true }] };
      if (sql.includes("information_schema.columns")) {
        const table = parameters[0];
        const columns = table === "runtime_catalog_source_scope"
          ? scopeColumns
          : ["connection_id", "run_id", "active"];
        return {
          rowCount: columns.length,
          rows: columns.map((column_name, index) => ({
            column_name,
            data_type: "text",
            udt_name: "text",
            is_nullable: "NO",
            ordinal_position: index + 1,
          })),
        };
      }
      if (sql.includes("FROM public.runtime_catalog_source_scope scope")) {
        assert.match(sql, /scope\.run_id = canary\.run_id/);
        assert.doesNotMatch(sql, /scope\.active/);
        return { rows: [{ active_count: "2", orphan_count: String(orphanCount) }] };
      }
      if (sql.includes("AND active")) return { rows: [{ count: "0" }] };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    },
  };
  return database;
}

test("derives active catalog scopes from the current run_id schema", async () => {
  const activity = await databaseFixture().runtimeActivity(CONNECTION_ID);
  assert.deepEqual(activity, {
    activeScopes: 0,
    activeCredentials: 0,
    activeCatalogScopes: 2,
  });
});

test("fails closed on orphaned or incomplete catalog scope run_id state", async () => {
  await assert.rejects(
    databaseFixture({ orphanCount: 1 }).runtimeActivity(CONNECTION_ID),
    /RUNTIME_CATALOG_SCOPE_RUN_ID_ORPHANED/,
  );
  await assert.rejects(
    databaseFixture({ scopeColumns: ["connection_id"] }).runtimeActivity(CONNECTION_ID),
    /RUNTIME_CATALOG_SCOPE_COLUMN_MISSING:run_id/,
  );
});
