import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const fleetMigration = readFileSync(
  `${process.cwd()}/infrastructure/postgres/0015_runtime_fleet_connection_scope.sql`,
  "utf8",
);
const historyRollback = readFileSync(
  `${process.cwd()}/infrastructure/postgres/0013_runtime_canary_control_plane_history.rollback.sql`,
  "utf8",
);
const fleetRollback = readFileSync(
  `${process.cwd()}/infrastructure/postgres/0015_runtime_fleet_connection_scope.rollback.sql`,
  "utf8",
);

describe("runtime fleet-scope rollback", () => {
  it("is staging-only and requires empty control tables", () => {
    for (const rollback of [historyRollback, fleetRollback]) {
      expect(rollback).toContain("public.infrastructure_metadata");
      expect(rollback).toContain("IS DISTINCT FROM 'staging'");
      expect(rollback).toContain("public.runtime_connection_credentials");
      expect(rollback).toContain("public.runtime_canary_connections");
    }
  });

  it("restores the singleton scope and removes fleet validators", () => {
    expect(fleetMigration).toContain("CREATE INDEX IF NOT EXISTS runtime_connection_credentials_scope_idx");
    expect(fleetMigration).toContain("ON public.runtime_connection_credentials(connection_id, run_id)");
    expect(fleetRollback).toContain("DROP INDEX IF EXISTS public.runtime_canary_connections_one_active_per_connection_idx");
    expect(fleetRollback).toContain("DROP INDEX IF EXISTS public.runtime_connection_credentials_scope_idx");
    expect(fleetRollback).toContain("CREATE UNIQUE INDEX runtime_canary_connections_single_active_idx");
    expect(fleetRollback).toContain("DROP FUNCTION IF EXISTS public.assert_runtime_fleet_connection_scope_generation(uuid, text)");
  });

  it("restores original control-plane identities and scoped credential reads", () => {
    expect(historyRollback).toContain("PRIMARY KEY (connection_id, credential_kind)");
    expect(historyRollback).toContain("PRIMARY KEY (connection_id)");
    expect(historyRollback).toContain("DROP COLUMN run_id");
    expect(historyRollback).toContain("CREATE POLICY middleware_runtime_select_active");
    expect(historyRollback).toContain("CREATE INDEX idx_runtime_connection_credentials_active");
    expect(historyRollback).not.toContain("CREATE UNIQUE INDEX idx_runtime_connection_credentials_active");
    expect(historyRollback).not.toContain("GRANT INSERT");
  });
});
