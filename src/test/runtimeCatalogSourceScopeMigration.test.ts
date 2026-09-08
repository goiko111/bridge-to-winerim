import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  `${process.cwd()}/infrastructure/postgres/0014_runtime_catalog_source_scope.sql`,
  "utf8",
);
const wranglerExample = readFileSync(
  `${process.cwd()}/cloudflare/workers/middleware-catalog-producer/wrangler.toml.example`,
  "utf8",
);

describe("runtime catalog source scope migration", () => {
  it("binds one immutable run to an exact connection, wine, format and product", () => {
    expect(migration).toContain("PRIMARY KEY (connection_id, run_id)");
    expect(migration).toContain("UNIQUE (run_id)");
    expect(migration).toContain("winerim_wine_id text NOT NULL");
    expect(migration).toContain("format IN ('BOTTLE', 'GLASS', 'MAGNUM')");
    expect(migration).toContain("agora_product_id text NOT NULL");
    expect(migration).toContain("RUNTIME_CATALOG_SOURCE_SCOPE_REQUIRES_PREPARED_RUN");
    expect(migration).toContain("RUNTIME_CATALOG_SOURCE_TARGET_MISMATCH");
  });

  it("gives runtime no scope mutation and only column-scoped wine refresh", () => {
    expect(migration).toContain("GRANT SELECT ON public.runtime_catalog_source_scope TO middleware_runtime");
    expect(migration).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE)[^;]*runtime_catalog_source_scope/i);
    expect(migration).toContain("REVOKE UPDATE ON public.winerim_wines FROM middleware_runtime");
    expect(migration).toContain("GRANT UPDATE (");
    expect(migration).not.toMatch(/GRANT\s+(INSERT|DELETE)[^;]*public\.winerim_wines/i);
    expect(migration).not.toMatch(/GRANT UPDATE \([^)]*raw_payload/is);
    expect(migration).toContain("RUNTIME_CATALOG_SOURCE_FORMAT_SCOPE_REJECTED");
    expect(migration).toContain("middleware_runtime_catalog_source_update");
  });

  it("defines one minute trigger and exactly one producer queue binding", () => {
    expect(wranglerExample).toContain('crons = ["* * * * *"]');
    expect(wranglerExample.match(/\[\[queues\.producers\]\]/g)).toHaveLength(1);
    expect(wranglerExample).not.toContain("[[queues.consumers]]");
    expect(wranglerExample).toContain('CATALOG_PRODUCER_ENABLED = "false"');
    expect(wranglerExample).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  });
});
