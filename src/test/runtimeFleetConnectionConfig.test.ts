import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import {
  fleetConnectionConfigPlan,
  prepareFleetConnectionConfig,
  renderFleetConnectionConfigRollbackSql,
  renderFleetConnectionConfigSql,
  validateAgoraBaseUrl,
  validateFleetConnectionConfigInput,
} from "../../infrastructure/runtime/prepare-fleet-connection-config.mjs";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const AGORA_SECRET = "agora-super-secret-fixture";
const WINERIM_SECRET = "winerim-super-secret-fixture";

function sha256(source: string | Buffer) {
  return createHash("sha256").update(source).digest("hex");
}

function sourceRow(id: string, suffix: string) {
  return {
    id,
    location_name: `Agora ${suffix}`,
    provider: "agora",
    base_url: `https://${suffix}.agora.example:8984`,
    api_token: `${AGORA_SECRET}-${suffix}`,
    winerim_api_token: `${WINERIM_SECRET}-${suffix}`,
    enabled: true,
    catalog_sync_enabled: true,
    sync_mode: "BIDIRECTIONAL",
    write_mode: "XML_IMPORT",
    backfill_days: 30,
    sync_frequency_minutes: 5,
    auto_push_on_create: true,
    auto_push_on_update: true,
    selected_sale_center_ids: [1, 2],
    provider_config: {
      sales_timezone: "Europe/Madrid",
      intraday_sales_sync_enabled: true,
      open_tickets_sync_enabled: true,
      open_tickets_stock_sync_enabled: false,
      preparation_routes: { BOTTLE: { typeId: 1, orderId: 2 } },
      agora_product_name_overrides: { "7001": `B Wine ${suffix}` },
      provider_token_secret_name: `do-not-copy-${AGORA_SECRET}-${suffix}`,
      last_intraday_sales_sync: { at: "2026-08-04T10:00:00.000Z" },
    },
  };
}

function targetRow(id: string) {
  return {
    id,
    provider: "agora",
    base_url: "https://redacted.invalid",
    api_token: "",
    winerim_api_token: null,
    provider_config: {},
    enabled: false,
    catalog_sync_enabled: false,
    sync_mode: "PULL_ONLY",
    write_mode: "NONE",
    backfill_days: 0,
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "fleet-config-input-"));
  chmodSync(directory, 0o700);
  const source = { data: [sourceRow(B, "b"), sourceRow(A, "a")] };
  const target = { rows: [targetRow(A), targetRow(B)] };
  const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
  const targetBytes = Buffer.from(`${JSON.stringify(target, null, 2)}\n`);
  const sourcePath = join(directory, "source.json");
  const targetPath = join(directory, "target.json");
  writeFileSync(sourcePath, sourceBytes, { mode: 0o600 });
  writeFileSync(targetPath, targetBytes, { mode: 0o600 });
  return { directory, source, target, sourceBytes, targetBytes, sourcePath, targetPath };
}

function outputPath(prefix: string) {
  return join(mkdtempSync(join(tmpdir(), `${prefix}-parent-`)), "artifacts");
}

describe("fleet connection non-secret config preparation", () => {
  it("writes private local-only apply, rollback and separate blocked activation artifacts", () => {
    const data = fixture();
    const outputDir = outputPath("fleet-config");
    const result = prepareFleetConnectionConfig({
      sourcePath: data.sourcePath,
      targetSnapshotPath: data.targetPath,
      expectedSourceSha256: sha256(data.sourceBytes),
      outputDir,
    });

    expect(result).toMatchObject({
      status: "RUNTIME_FLEET_CONNECTION_CONFIG_ARTIFACTS_READY",
      remoteMutations: 0,
      activationAllowed: false,
      connectionCount: 2,
    });
    expect(statSync(outputDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(outputDir).sort()).toEqual([
      "fleet-connection-activation.manifest.json",
      "fleet-connection-config.manifest.json",
      "fleet-connection-config.rollback.sql",
      "fleet-connection-config.sql",
    ]);

    const artifacts = [
      result.applySqlPath,
      result.rollbackSqlPath,
      result.configManifestPath,
      result.activationManifestPath,
    ];
    for (const path of artifacts) expect(statSync(path).mode & 0o777).toBe(0o600);
    const serialized = artifacts.map((path) => readFileSync(path, "utf8")).join("\n");
    expect(serialized).not.toContain(AGORA_SECRET);
    expect(serialized).not.toContain(WINERIM_SECRET);
    expect(serialized).not.toContain("provider_token_secret_name");
    expect(serialized).not.toContain("last_intraday_sales_sync");
    expect(serialized).not.toMatch(/api_token|winerim_api_token|catalog_endpoint|restaurant_guid/i);

    const apply = readFileSync(result.applySqlPath, "utf8");
    const rollback = readFileSync(result.rollbackSqlPath, "utf8");
    const activation = JSON.parse(readFileSync(result.activationManifestPath, "utf8"));
    expect(apply).toContain("SET base_url = 'https://a.agora.example:8984/'");
    expect(apply).toContain('"sales_timezone":"Europe/Madrid"');
    expect(apply).toContain("enabled = false");
    expect(apply).toContain("catalog_sync_enabled = false");
    expect(apply).toContain("sync_mode = 'PULL_ONLY'");
    expect(apply).toContain("write_mode = 'NONE'");
    expect(apply).toContain("backfill_days = 0");
    expect(rollback).toContain("SET base_url = 'https://redacted.invalid'");
    expect(rollback).toContain("provider_config = '{}'::jsonb");
    expect(activation.activationAllowed).toBe(false);
    expect(activation.connections[0].desiredControlPlane).toEqual({
      enabled: true,
      catalogSyncEnabled: true,
      syncMode: "BIDIRECTIONAL",
      writeMode: "XML_IMPORT",
      backfillDays: 30,
    });
    expect(fleetConnectionConfigPlan()).toMatchObject({
      remoteMutations: 0,
      activationAllowed: false,
      writesCredentials: false,
    });
  });

  it("renders an exact inverse rollback with the same fail-closed inert guards", () => {
    const data = fixture();
    const plan = validateFleetConnectionConfigInput({
      sourceDocument: data.source,
      targetDocument: data.target,
      sourceSha256: sha256(data.sourceBytes),
      targetSha256: sha256(data.targetBytes),
    });
    const apply = renderFleetConnectionConfigSql(plan);
    const rollback = renderFleetConnectionConfigRollbackSql(plan);

    expect(apply.match(/UPDATE public\.pos_connections/g)).toHaveLength(2);
    expect(rollback.match(/UPDATE public\.pos_connections/g)).toHaveLength(2);
    expect(apply).toContain("base_url = 'https://redacted.invalid'");
    expect(rollback).toContain("base_url = 'https://a.agora.example:8984/'");
    expect(rollback).toContain("SET base_url = 'https://redacted.invalid'");
    expect(rollback).toContain("provider_config = '{}'::jsonb");
    expect(rollback).not.toMatch(/DELETE|TRUNCATE|enabled\s*=\s*true/i);
  });

  it("rejects unapproved private URLs and accepts only a hash-bound authorization", () => {
    expect(() => validateAgoraBaseUrl("http://192.168.1.22:8984"))
      .toThrow("RUNTIME_FLEET_CONNECTION_CONFIG_PRIVATE_BASE_URL_NOT_AUTHORIZED");
    const canonical = "http://192.168.1.22:8984/";
    expect(validateAgoraBaseUrl("http://192.168.1.22:8984", sha256(canonical))).toBe(canonical);
    for (const url of [
      "https://user:pass@agora.example",
      "https://agora.example?token=nope",
      "https://agora.example/#fragment",
      "file:///tmp/agora",
      "http://localhost:8984",
    ]) {
      expect(() => validateAgoraBaseUrl(url)).toThrow();
    }
  });

  it("rejects non-Agora rows, duplicate identities and non-inert targets", () => {
    const data = fixture();
    const base = {
      sourceSha256: sha256(data.sourceBytes),
      targetSha256: sha256(data.targetBytes),
    };
    const nonAgora = structuredClone(data.source);
    nonAgora.data[0].provider = "revo";
    expect(() => validateFleetConnectionConfigInput({
      ...base, sourceDocument: nonAgora, targetDocument: data.target,
    })).toThrow("RUNTIME_FLEET_CONNECTION_CONFIG_SOURCE_PROVIDER_NOT_AGORA");

    const duplicate = { data: [data.source.data[0], data.source.data[0]] };
    expect(() => validateFleetConnectionConfigInput({
      ...base, sourceDocument: duplicate, targetDocument: data.target,
    })).toThrow("RUNTIME_FLEET_CONNECTION_CONFIG_DUPLICATE_SOURCE_CONNECTION_ID");

    const unsafeTarget = structuredClone(data.target);
    unsafeTarget.rows[0].enabled = true;
    expect(() => validateFleetConnectionConfigInput({
      ...base, sourceDocument: data.source, targetDocument: unsafeTarget,
    })).toThrow("RUNTIME_FLEET_CONNECTION_CONFIG_TARGET_NOT_INERT_SANITIZED");

    const tokenizedTarget = structuredClone(data.target);
    tokenizedTarget.rows[0].api_token = "must-not-exist";
    expect(() => validateFleetConnectionConfigInput({
      ...base, sourceDocument: data.source, targetDocument: tokenizedTarget,
    })).toThrow("RUNTIME_FLEET_CONNECTION_CONFIG_TARGET_NOT_INERT_SANITIZED");
  });

  it("fails closed on source hash drift, public inputs, symlinks and repository outputs", () => {
    const data = fixture();
    expect(() => prepareFleetConnectionConfig({
      sourcePath: data.sourcePath,
      targetSnapshotPath: data.targetPath,
      expectedSourceSha256: "0".repeat(64),
      outputDir: outputPath("fleet-config-hash"),
    })).toThrow("RUNTIME_FLEET_CONNECTION_CONFIG_SOURCE_SHA256_MISMATCH");

    chmodSync(data.sourcePath, 0o644);
    expect(() => prepareFleetConnectionConfig({
      sourcePath: data.sourcePath,
      targetSnapshotPath: data.targetPath,
      expectedSourceSha256: sha256(data.sourceBytes),
      outputDir: outputPath("fleet-config-public"),
    })).toThrow("RUNTIME_FLEET_CONNECTION_CONFIG_SOURCE_JSON_MUST_BE_PRIVATE_0600");
    chmodSync(data.sourcePath, 0o600);

    const symlink = join(data.directory, "source-link.json");
    symlinkSync(data.sourcePath, symlink);
    expect(() => prepareFleetConnectionConfig({
      sourcePath: symlink,
      targetSnapshotPath: data.targetPath,
      expectedSourceSha256: sha256(data.sourceBytes),
      outputDir: outputPath("fleet-config-link"),
    })).toThrow("RUNTIME_FLEET_CONNECTION_CONFIG_SOURCE_JSON_MUST_BE_REGULAR_FILE");

    expect(() => prepareFleetConnectionConfig({
      sourcePath: data.sourcePath,
      targetSnapshotPath: data.targetPath,
      expectedSourceSha256: sha256(data.sourceBytes),
      outputDir: join(process.cwd(), "fleet-config-artifacts"),
    })).toThrow("RUNTIME_FLEET_CONNECTION_CONFIG_OUTPUT_MUST_BE_ABSOLUTE_OUTSIDE_REPOSITORY");
  });

  it("rejects a source secret copied into an otherwise allowed config value", () => {
    const data = fixture();
    data.source.data[0].provider_config.agora_product_name_overrides = {
      "7001": data.source.data[0].api_token,
    };
    const sourceBytes = Buffer.from(`${JSON.stringify(data.source)}\n`);
    writeFileSync(data.sourcePath, sourceBytes, { mode: 0o600 });
    expect(() => prepareFleetConnectionConfig({
      sourcePath: data.sourcePath,
      targetSnapshotPath: data.targetPath,
      expectedSourceSha256: sha256(sourceBytes),
      outputDir: outputPath("fleet-config-leak"),
    })).toThrow("RUNTIME_FLEET_CONNECTION_CONFIG_SECRET_VALUE_IN_OUTPUT");
  });

  it("rejects secret-looking nested config keys and invalid desired activation modes", () => {
    const data = fixture();
    data.source.data[0].provider_config.preparation_routes = {
      BOTTLE: { typeId: 1, accessToken: "nested-secret" },
    };
    expect(() => validateFleetConnectionConfigInput({
      sourceDocument: data.source,
      targetDocument: data.target,
      sourceSha256: sha256(data.sourceBytes),
      targetSha256: sha256(data.targetBytes),
    })).toThrow("RUNTIME_FLEET_CONNECTION_CONFIG_SECRET_KEY_IN_SAFE_PROVIDER_CONFIG");

    const invalidMode = fixture();
    invalidMode.source.data[0].sync_mode = "UNSAFE_MODE";
    expect(() => validateFleetConnectionConfigInput({
      sourceDocument: invalidMode.source,
      targetDocument: invalidMode.target,
      sourceSha256: sha256(invalidMode.sourceBytes),
      targetSha256: sha256(invalidMode.targetBytes),
    })).toThrow("RUNTIME_FLEET_CONNECTION_CONFIG_INVALID_DESIRED_SYNC_MODE");
  });
});
