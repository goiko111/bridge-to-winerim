import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import {
  buildRescueBootstrapManifest,
  buildRescueBootstrapSql,
  mergeFleetDocuments,
  writeRescueBootstrapPackage,
} from "../../scripts/build-rescue-bootstrap.mjs";

const connectionId = "11111111-1111-4111-8111-111111111111";
const fleet = {
  generated_at: "2026-07-30T16:20:00Z",
  rows: [{
    location_name: "Restaurante de prueba",
    connection_id: connectionId,
    connection: {
      id: connectionId,
      location_name: "Restaurante de prueba",
      enabled: true,
      catalog_sync_enabled: true,
      sync_mode: "BIDIRECTIONAL",
      write_mode: "XML_IMPORT",
      last_sync_at: "2026-07-30T16:16:48Z",
      last_catalog_sync_at: "2026-07-30T16:17:53Z",
      last_business_day_synced: "2026-07-29",
    },
    master: {
      families: 20,
      products: 300,
      winerim_families: 8,
      visible_winerim_families: 8,
      fetched_at: "2026-07-30T16:16:58Z",
    },
    mappings: { CONFIRMED: { count: 42 }, PENDING: { count: 2 }, REJECTED: { count: 1 } },
    tracking: { VERIFIED: { count: 40 }, NOT_PUSHED: { count: 3 } },
  }],
};
const connectivity = {
  generated_at: "2026-07-30T16:20:00Z",
  rows: [{
    connection_id: connectionId,
    success: true,
    edge_http_status: 200,
    duration_ms: 250,
  }],
};

describe("rescue bootstrap", () => {
  it("converts live observations into inert connection rows without copying cursors", () => {
    const manifest = buildRescueBootstrapManifest({
      fleet,
      connectivity,
      credentialReadiness: [{
        connectionId,
        agoraCredentialReady: true,
        winerimCredentialReady: true,
      }],
      expectedCount: 1,
    });

    expect(manifest.counts).toEqual({ connections: 1, wave1: 1, wave2: 0, wave3: 0 });
    expect(manifest.connections[0].observedBeforeOutage.enabled).toBe(true);
    expect(manifest.connections[0].observedBeforeOutage.lastBusinessDaySynced).toBe("2026-07-29");
    expect(manifest.connections[0].bootstrapRow).toMatchObject({
      base_url: "https://redacted.invalid",
      api_token: "",
      winerim_api_token: null,
      enabled: false,
      catalog_sync_enabled: false,
      sync_mode: "PULL_ONLY",
      write_mode: "NONE",
      backfill_days: 0,
      last_business_day_synced: null,
    });
    expect(manifest.connections[0].gates.canActivate).toBe(false);
  });

  it("emits a fail-closed seed that cannot activate runtime or restore old cursors", () => {
    const manifest = buildRescueBootstrapManifest({ fleet, connectivity, expectedCount: 1 });
    const sql = buildRescueBootstrapSql(manifest);

    expect(sql).toContain("FALSE, FALSE, 'PULL_ONLY', 'NONE'");
    expect(sql).toContain("RESCUE_BOOTSTRAP_REFUSES_ACTIVE_CONNECTIONS");
    expect(sql).not.toContain("2026-07-29");
    expect(sql).not.toContain("BIDIRECTIONAL");
    expect(sql).not.toContain("XML_IMPORT");
  });

  it("rejects readiness files that could smuggle credential values", () => {
    expect(() => buildRescueBootstrapManifest({
      fleet,
      connectivity,
      credentialReadiness: [{
        connectionId,
        agoraCredentialReady: true,
        winerimCredentialReady: true,
        token: "must-not-be-accepted",
      }],
      expectedCount: 1,
    })).toThrow("RESCUE_BOOTSTRAP_READINESS_FIELD_NOT_ALLOWED_token");
  });

  it("writes private deterministic package artifacts", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "winerim-rescue-bootstrap."));
    const manifest = buildRescueBootstrapManifest({ fleet, connectivity, expectedCount: 1 });
    const outputs = writeRescueBootstrapPackage({ manifest, outputDir });

    expect(JSON.parse(readFileSync(outputs.manifestPath, "utf8")).manifestSha256).toBe(manifest.manifestSha256);
    expect(readFileSync(outputs.sqlPath, "utf8")).toContain(connectionId);
    expect(statSync(outputs.manifestPath).mode & 0o777).toBe(0o600);
    expect(statSync(outputs.sqlPath).mode & 0o777).toBe(0o600);
  });

  it("normalizes detailed fleet shards and preserves a disabled non-Agora provider", () => {
    const yurestId = "22222222-2222-4222-8222-222222222222";
    const merged = mergeFleetDocuments([{
      generated_at: "2026-07-31T08:00:00Z",
      summaries: [{
        id: yurestId,
        location: "Yurest de prueba",
        provider: "yurest",
        flags: { enabled: false, sync_mode: "PULL_ONLY", write_mode: "NONE" },
        runtime: { last_business_day_synced: null },
        mappings: { total: 0, by_status: {} },
        tracking: { total: 0, by_status: {} },
      }],
    }]);
    const manifest = buildRescueBootstrapManifest({
      fleet: merged,
      connectivity: { rows: [] },
      fleetFiles: ["qz.json"],
      expectedCount: 1,
    });

    expect(manifest.connections[0].bootstrapRow.provider).toBe("yurest");
    expect(manifest.connections[0].bootstrapRow.enabled).toBe(false);
    expect(manifest.connections[0].recommendedWave).toBe(3);
    expect(manifest.source.fleetFiles).toEqual(["qz.json"]);
  });
});
