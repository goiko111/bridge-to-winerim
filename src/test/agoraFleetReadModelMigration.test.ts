import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  `${process.cwd()}/supabase/migrations/20260903043000_agora_fleet_read_model.sql`,
  "utf8",
);
const rollback = readFileSync(
  `${process.cwd()}/infrastructure/postgres/0017_agora_fleet_read_model.rollback.sql`,
  "utf8",
);
const productionPrerequisite = readFileSync(
  `${process.cwd()}/infrastructure/postgres/0018_runtime_fleet_production_prerequisite.sql`,
  "utf8",
);
const productionRollback = readFileSync(
  `${process.cwd()}/infrastructure/postgres/0018_runtime_fleet_production_prerequisite.rollback.sql`,
  "utf8",
);

describe("Agora fleet read model migration", () => {
  it("uses a dedicated non-login, non-bypass source reader", () => {
    expect(migration).toContain(
      "CREATE ROLE middleware_fleet_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
    );
    expect(migration).toContain("GRANT middleware_fleet_reader TO middleware_runtime");
    expect(migration).not.toMatch(
      /GRANT\s+(INSERT|UPDATE|DELETE)[^;]*TO middleware_fleet_reader/is,
    );
  });

  it("fails closed unless the multi-connection fleet scope is installed", () => {
    expect(migration).toContain("runtime_canary_connections_one_active_per_connection_idx");
    expect(migration).toContain("runtime_canary_connections_single_active_idx");
    expect(migration).toContain(
      "runtime fleet connection scope must allow one active generation per connection",
    );
  });

  it("gates every source table through an active, unexpired scope", () => {
    const policies = migration.match(/CREATE POLICY middleware_fleet_reader_[a-z_]+/g) ?? [];
    expect(policies).toHaveLength(8);
    expect(migration).toContain("scope.active = true");
    expect(migration).toContain("scope.approved_at IS NOT NULL");
    expect(migration).toContain("scope.expires_at > now()");
    expect(migration).toContain("public.sales_line_items");
    expect(migration).toContain("public.stock_sync_log");
    expect(migration).toContain("public.outbound_tasks");
  });

  it("rolls back only the derived table and dedicated reader contract", () => {
    expect(rollback).toContain("DROP TABLE IF EXISTS public.agora_fleet_read_model");
    expect(rollback).toContain("REVOKE middleware_fleet_reader FROM middleware_runtime");
    expect(rollback).toContain("DROP ROLE middleware_fleet_reader");
    expect(rollback.match(/DROP POLICY IF EXISTS middleware_fleet_reader_/g)).toHaveLength(8);
    expect(rollback).not.toMatch(/DROP TABLE IF EXISTS public\.(sales_line_items|stock_sync_log|outbound_tasks)/);
  });

  it("adds the production prerequisite without replacing live fleet scope objects", () => {
    expect(productionPrerequisite).toContain("NOT IN ('staging', 'rescue-production')");
    expect(productionPrerequisite).toContain(
      "CREATE INDEX runtime_connection_credentials_scope_idx",
    );
    expect(productionPrerequisite).toContain("runtime fleet production prerequisite has drift");
    expect(productionPrerequisite).not.toMatch(/(UPDATE|DELETE)\s+public\.runtime_canary_connections/i);
    expect(productionPrerequisite).not.toContain(
      "DROP INDEX IF EXISTS public.runtime_canary_connections_one_active_per_connection_idx",
    );
  });

  it("uses a production-only rollback that preserves writers and business ledgers", () => {
    expect(productionRollback).toContain("NOT IN ('staging', 'rescue-production')");
    expect(productionRollback).toContain("DROP TABLE IF EXISTS public.agora_fleet_read_model");
    expect(productionRollback).toContain(
      "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'middleware_fleet_reader')",
    );
    expect(productionRollback).toContain(
      "DROP INDEX public.runtime_connection_credentials_scope_idx",
    );
    expect(productionRollback).not.toMatch(
      /(UPDATE|DELETE)\s+public\.(runtime_canary_connections|runtime_connection_credentials)/i,
    );
    expect(productionRollback).not.toMatch(
      /DROP TABLE(?: IF EXISTS)? public\.(sales_events|sales_line_items|stock_sync_log|outbound_tasks)/,
    );
  });
});
