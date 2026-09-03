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
  lovableConnectionStateSha256,
  prepareLovableConnectionFence,
  renderLovableConnectionFenceApplySql,
  renderLovableConnectionFenceRollbackSql,
  validateLovableConnectionFenceInput,
} from "../../infrastructure/runtime/prepare-lovable-connection-fence.mjs";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const AGORA_SECRET = "agora-private-fixture-token";
const WINERIM_SECRET = "winerim-private-fixture-token";

function sha256(source: string | Buffer) {
  return createHash("sha256").update(source).digest("hex");
}

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    location_name: "Fence Fixture",
    provider: "agora",
    base_url: "https://fence.example:8984",
    api_token: AGORA_SECRET,
    winerim_api_token: WINERIM_SECRET,
    enabled: true,
    catalog_sync_enabled: true,
    provider_config: {
      intraday_sales_sync_enabled: true,
      open_tickets_sync_enabled: true,
      open_tickets_stock_sync_enabled: false,
      sales_timezone: "Europe/Madrid",
      nested_secret: AGORA_SECRET,
    },
    updated_at: "2026-08-04T12:00:00.000Z",
    ...overrides,
  };
}

function fixture(row = connectionRow()) {
  const directory = mkdtempSync(join(tmpdir(), "lovable-fence-input-"));
  chmodSync(directory, 0o700);
  const document = { data: [row, connectionRow({ id: OTHER_ID, location_name: "Other" })] };
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  const snapshotPath = join(directory, "snapshot.json");
  writeFileSync(snapshotPath, bytes, { mode: 0o600 });
  return { directory, document, bytes, snapshotPath, row };
}

function externalOutput(prefix: string) {
  return join(mkdtempSync(join(tmpdir(), `${prefix}-parent-`)), "artifacts");
}

function validatedPlan(row = connectionRow()) {
  return validateLovableConnectionFenceInput({
    snapshotDocument: { rows: [row] },
    snapshotSha256: "a".repeat(64),
    connectionId: CONNECTION_ID,
    expectedStateSha256: lovableConnectionStateSha256(row),
  });
}

describe("Lovable per-connection writer fence preparation", () => {
  it("writes private, reversible, secret-free artifacts without remote mutations", () => {
    const data = fixture();
    const outputDir = externalOutput("lovable-fence");
    const result = prepareLovableConnectionFence({
      snapshotPath: data.snapshotPath,
      expectedSnapshotSha256: sha256(data.bytes),
      connectionId: CONNECTION_ID,
      expectedStateSha256: lovableConnectionStateSha256(data.row),
      outputDir,
    });

    expect(result).toMatchObject({
      status: "LOVABLE_CONNECTION_FENCE_ARTIFACTS_READY_NOT_APPLIED",
      remoteMutations: 0,
      connectionId: CONNECTION_ID,
      minimumDrainMs: 130_000,
    });
    expect(statSync(outputDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(outputDir).sort()).toEqual([
      "lovable-connection-fence.apply.sql",
      "lovable-connection-fence.manifest.json",
      "lovable-connection-fence.readback.sql",
      "lovable-connection-fence.rollback-readback.sql",
      "lovable-connection-fence.rollback.sql",
    ]);
    const artifacts = readdirSync(outputDir).map((name) => join(outputDir, name));
    for (const path of artifacts) expect(statSync(path).mode & 0o777).toBe(0o600);
    const serialized = artifacts.map((path) => readFileSync(path, "utf8")).join("\n");
    expect(serialized).not.toContain(AGORA_SECRET);
    expect(serialized).not.toContain(WINERIM_SECRET);
    expect(serialized).not.toContain("Fence Fixture");

    const apply = readFileSync(result.applySqlPath, "utf8");
    const rollback = readFileSync(result.rollbackSqlPath, "utf8");
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    expect(apply.match(/UPDATE public\.pos_connections/g)).toHaveLength(1);
    expect(apply).toContain(`WHERE id = '${CONNECTION_ID}'::uuid`);
    expect(apply).toContain("enabled = false");
    expect(apply).toContain("catalog_sync_enabled = false");
    expect(apply).toContain("intraday_sales_sync_enabled");
    expect(apply).toContain("open_tickets_sync_enabled");
    expect(rollback).toContain("enabled = true");
    expect(rollback).toContain("catalog_sync_enabled = true");
    expect(manifest.minimumDrainMs).toBe(130_000);
    expect(manifest.checklist.join(" ")).toContain("baseline A");
    expect(manifest.checklist.join(" ")).toContain("baseline B");
    expect(manifest.status).toBe("PREPARED_NOT_APPLIED");
  });

  it("does not invent absent provider_config scheduler fields", () => {
    const row = connectionRow({ provider_config: { sales_timezone: "Europe/Madrid" } });
    const plan = validatedPlan(row);
    const apply = renderLovableConnectionFenceApplySql(plan);
    const rollback = renderLovableConnectionFenceRollbackSql(plan);
    expect(plan.schedulerKeys).toEqual([]);
    expect(apply).not.toContain("intraday_sales_sync_enabled");
    expect(apply).not.toContain("open_tickets_sync_enabled");
    expect(apply).toContain("provider_config = provider_config");
    expect(rollback).toContain("provider_config = provider_config");
  });

  it("rejects provider casing that the SQL fence cannot match exactly", () => {
    const row = connectionRow({ provider: "Agora" });
    const snapshotDocument = { rows: [row] };
    const snapshotSource = Buffer.from(`${JSON.stringify(snapshotDocument)}\n`);

    expect(() => validateLovableConnectionFenceInput({
      snapshotDocument,
      snapshotSha256: createHash("sha256").update(snapshotSource).digest("hex"),
      connectionId: row.id,
      expectedStateSha256: lovableConnectionStateSha256(row),
    })).toThrow("LOVABLE_CONNECTION_FENCE_PROVIDER_NOT_AGORA");
  });

  it("restores the exact original values for scheduler switches it changed", () => {
    const row = connectionRow({
      enabled: true,
      catalog_sync_enabled: false,
      provider_config: {
        intraday_sales_sync_enabled: true,
        open_tickets_sync_enabled: false,
        open_tickets_stock_sync_enabled: true,
      },
    });
    const plan = validatedPlan(row);
    const apply = renderLovableConnectionFenceApplySql(plan);
    const rollback = renderLovableConnectionFenceRollbackSql(plan);
    expect(apply).toContain("catalog_sync_enabled = false");
    expect(rollback).toContain("catalog_sync_enabled = false");
    expect(rollback).toContain("'intraday_sales_sync_enabled'], 'true'::jsonb");
    expect(rollback).toContain("'open_tickets_sync_enabled'], 'false'::jsonb");
    expect(rollback).toContain("'open_tickets_stock_sync_enabled'], 'true'::jsonb");
  });

  it("fails closed on state hash drift, missing columns and duplicate scope", () => {
    const row = connectionRow();
    expect(() => validateLovableConnectionFenceInput({
      snapshotDocument: { rows: [row] },
      snapshotSha256: "a".repeat(64),
      connectionId: CONNECTION_ID,
      expectedStateSha256: "b".repeat(64),
    })).toThrow("LOVABLE_CONNECTION_FENCE_EXPECTED_STATE_SHA256_MISMATCH");

    const missing = connectionRow();
    delete (missing as Record<string, unknown>).catalog_sync_enabled;
    expect(() => validateLovableConnectionFenceInput({
      snapshotDocument: { rows: [missing] },
      snapshotSha256: "a".repeat(64),
      connectionId: CONNECTION_ID,
      expectedStateSha256: lovableConnectionStateSha256(missing),
    })).toThrow("LOVABLE_CONNECTION_FENCE_MISSING_COLUMN_CATALOG_SYNC_ENABLED");

    expect(() => validateLovableConnectionFenceInput({
      snapshotDocument: { rows: [row, row] },
      snapshotSha256: "a".repeat(64),
      connectionId: CONNECTION_ID,
      expectedStateSha256: lovableConnectionStateSha256(row),
    })).toThrow("LOVABLE_CONNECTION_FENCE_DUPLICATE_CONNECTION_ID");
  });

  it("fails closed on unknown scheduler-looking keys and invalid scheduler values", () => {
    const unknown = connectionRow({
      provider_config: { custom_cron_enabled: true },
    });
    expect(() => validatedPlan(unknown)).toThrow("LOVABLE_CONNECTION_FENCE_UNSUPPORTED_SCHEDULER_KEYS_");

    const invalid = connectionRow({
      provider_config: { open_tickets_sync_enabled: "yes" },
    });
    expect(() => validatedPlan(invalid)).toThrow(
      "LOVABLE_CONNECTION_FENCE_SCHEDULER_NOT_BOOLEAN_OPEN_TICKETS_SYNC_ENABLED",
    );
  });

  it("rejects an already fenced row instead of producing a misleading no-op", () => {
    const row = connectionRow({
      enabled: false,
      catalog_sync_enabled: false,
      provider_config: {
        intraday_sales_sync_enabled: false,
        open_tickets_sync_enabled: false,
        open_tickets_stock_sync_enabled: false,
      },
    });
    expect(() => validatedPlan(row)).toThrow("LOVABLE_CONNECTION_FENCE_ALREADY_FENCED");
  });

  it("rejects public or symlinked snapshots, hash drift and repository outputs", () => {
    const data = fixture();
    chmodSync(data.snapshotPath, 0o644);
    expect(() => prepareLovableConnectionFence({
      snapshotPath: data.snapshotPath,
      expectedSnapshotSha256: sha256(data.bytes),
      connectionId: CONNECTION_ID,
      expectedStateSha256: lovableConnectionStateSha256(data.row),
      outputDir: externalOutput("lovable-fence-public"),
    })).toThrow("LOVABLE_CONNECTION_FENCE_SNAPSHOT_MUST_BE_PRIVATE_0600");
    chmodSync(data.snapshotPath, 0o600);

    const link = join(data.directory, "snapshot-link.json");
    symlinkSync(data.snapshotPath, link);
    expect(() => prepareLovableConnectionFence({
      snapshotPath: link,
      expectedSnapshotSha256: sha256(data.bytes),
      connectionId: CONNECTION_ID,
      expectedStateSha256: lovableConnectionStateSha256(data.row),
      outputDir: externalOutput("lovable-fence-link"),
    })).toThrow("LOVABLE_CONNECTION_FENCE_SNAPSHOT_MUST_BE_REGULAR_FILE");

    expect(() => prepareLovableConnectionFence({
      snapshotPath: data.snapshotPath,
      expectedSnapshotSha256: "0".repeat(64),
      connectionId: CONNECTION_ID,
      expectedStateSha256: lovableConnectionStateSha256(data.row),
      outputDir: externalOutput("lovable-fence-hash"),
    })).toThrow("LOVABLE_CONNECTION_FENCE_SNAPSHOT_SHA256_MISMATCH");

    expect(() => prepareLovableConnectionFence({
      snapshotPath: data.snapshotPath,
      expectedSnapshotSha256: sha256(data.bytes),
      connectionId: CONNECTION_ID,
      expectedStateSha256: lovableConnectionStateSha256(data.row),
      outputDir: join(process.cwd(), "lovable-fence-output"),
    })).toThrow("LOVABLE_CONNECTION_FENCE_OUTPUT_MUST_BE_ABSOLUTE_OUTSIDE_REPOSITORY");
  });
});
