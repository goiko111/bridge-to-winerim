import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  fleetFencedTargetRawPlan,
  prepareFleetFencedTargetRaw,
} from "../../infrastructure/runtime/prepare-fleet-fenced-target-raw.mjs";

const CONNECTION_ID = "8466c229-773d-4ad9-a747-9bb862d7ae6b";
const OTHER_CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

type ArtifactReference = { path: string; sha256: string };
type TableName = "sales_events" | "sales_line_items" | "stock_sync_log" | "product_mappings";
type AdoptionFixture = {
  version: number;
  kind: string;
  schemaVersion: string;
  connectionId: string;
  exportManifestSha256: string;
  reconciliationManifestSha256: string;
  reconciliationReportSha256: string;
  sourceDatasetSha256: string;
  targetDatasetSha256: string;
  reconciliationStatus: string;
  watermarks: {
    salesEvents: number;
    salesLineItems: number;
    maxBusinessDay: string;
    lastBusinessDaySynced: string;
    lastSyncAt: string;
  };
  bindingSha256: string;
};
type InputFixture = {
  version: number;
  kind: string;
  contract: string;
  connectionId: string;
  target: string;
  capturedAt: string;
  window: { fromBusinessDay: string; throughBusinessDay: string };
  expectedProviderConfigSha256: string;
  credentialProvisioningManifest: ArtifactReference;
  marker: ArtifactReference;
  tables: Record<TableName, ArtifactReference>;
};

function sha256(source: Buffer | string): string {
  return createHash("sha256").update(source).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function adoptionBinding(adoption: AdoptionFixture): string {
  return sha256([
    "winerim-runtime-adopt-existing",
    "3",
    adoption.kind,
    adoption.schemaVersion,
    adoption.connectionId,
    adoption.exportManifestSha256,
    adoption.reconciliationManifestSha256,
    adoption.reconciliationReportSha256,
    adoption.sourceDatasetSha256,
    adoption.targetDatasetSha256,
    String(adoption.watermarks.salesEvents),
    String(adoption.watermarks.salesLineItems),
    adoption.watermarks.maxBusinessDay,
    adoption.watermarks.lastBusinessDaySynced,
    adoption.watermarks.lastSyncAt,
  ].join("|"));
}

function privateJson(path: string, value: unknown): { path: string; sha256: string } {
  const source = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(path, source, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, sha256: sha256(source) };
}

type Fixture = ReturnType<typeof fixture>;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "fleet-fenced-target-raw-"));
  const providerConfig = {
    intraday_sales_sync_enabled: false,
    open_tickets_stock_sync_enabled: false,
    open_tickets_sync_enabled: false,
    migration_note: "fenced target",
  };
  const marker = [{
    id: CONNECTION_ID,
    provider: "agora",
    enabled: false,
    catalog_sync_enabled: false,
    write_mode: "NONE",
    last_business_day_synced: "2026-08-03",
    last_sync_at: "2026-08-04T13:40:25.722Z",
    updated_at: "2026-08-04T13:40:25.722Z",
    provider_config: providerConfig,
  }];
  const tables = {
    sales_events: [
      {
        id: "event-b",
        connection_id: CONNECTION_ID,
        provider_doc_id: "invoice-b",
        business_day: "2026-08-04",
      },
      {
        id: "event-a",
        connection_id: CONNECTION_ID,
        provider_doc_id: "invoice-a",
        business_day: "2026-07-05",
      },
    ],
    sales_line_items: [
      { id: "line-b", connection_id: CONNECTION_ID, sales_event_id: "event-b" },
      { id: "line-a", connection_id: CONNECTION_ID, sales_event_id: "event-a" },
    ],
    stock_sync_log: [
      { id: "receipt-a", connection_id: CONNECTION_ID, sales_event_id: "event-a" },
    ],
    product_mappings: [
      { id: "mapping-a", connection_id: CONNECTION_ID, provider_product_id: "700001" },
    ],
  };
  const adoption: AdoptionFixture = {
    version: 3,
    kind: "AGORA_SHADOW_RECONCILIATION_EVIDENCE",
    schemaVersion: "agora-shadow-v2",
    connectionId: CONNECTION_ID,
    exportManifestSha256: sha256("source-export-manifest"),
    reconciliationManifestSha256: sha256("source-reconciliation-manifest"),
    reconciliationReportSha256: sha256("source-reconciliation-report"),
    sourceDatasetSha256: sha256("source-dataset"),
    targetDatasetSha256: sha256("target-dataset"),
    reconciliationStatus: "RECONCILED_EXACT",
    watermarks: {
      salesEvents: 2,
      salesLineItems: 2,
      maxBusinessDay: "2026-08-04",
      lastBusinessDaySynced: "2026-08-03",
      lastSyncAt: "2026-08-04T13:40:25.722Z",
    },
    bindingSha256: "",
  };
  adoption.bindingSha256 = adoptionBinding(adoption);
  const credentialManifest = {
    version: 3,
    connectionId: CONNECTION_ID,
    runId: "donquijote-20260804-b",
    keyVersion: "v1",
    mode: "adopt-existing",
    active: false,
    activationAllowed: false,
    adoption,
  };
  const paths = {
    credential: join(directory, "credential.manifest.json"),
    marker: join(directory, "marker.json"),
    sales_events: join(directory, "sales-events.json"),
    sales_line_items: join(directory, "sales-line-items.json"),
    stock_sync_log: join(directory, "stock-sync-log.json"),
    product_mappings: join(directory, "product-mappings.json"),
    input: join(directory, "input.json"),
    output: join(directory, "fenced-target-raw.json"),
  };
  const input: InputFixture = {
    version: 1,
    kind: "RUNTIME_FLEET_FENCED_TARGET_RAW_INPUT",
    contract: "fenced-target-raw-v1",
    connectionId: CONNECTION_ID,
    target: "piyvadlzagtracciquap",
    capturedAt: "2026-08-04T14:19:10.694Z",
    window: { fromBusinessDay: "2026-07-05", throughBusinessDay: "2026-08-04" },
    expectedProviderConfigSha256: sha256(canonicalJson(providerConfig)),
    credentialProvisioningManifest: privateJson(paths.credential, credentialManifest),
    marker: privateJson(paths.marker, marker),
    tables: {
      sales_events: privateJson(paths.sales_events, tables.sales_events),
      sales_line_items: privateJson(paths.sales_line_items, tables.sales_line_items),
      stock_sync_log: privateJson(paths.stock_sync_log, tables.stock_sync_log),
      product_mappings: privateJson(paths.product_mappings, tables.product_mappings),
    },
  };

  function rewriteInput(): string {
    return privateJson(paths.input, input).sha256;
  }

  function rewriteArtifact(name: keyof typeof paths, value: unknown): string {
    const reference = privateJson(paths[name], value);
    if (name === "credential") input.credentialProvisioningManifest = reference;
    else if (name === "marker") input.marker = reference;
    else if (Object.prototype.hasOwnProperty.call(input.tables, name)) {
      input.tables[name as TableName] = reference;
    }
    return rewriteInput();
  }

  const inputSha256 = rewriteInput();
  return {
    directory,
    paths,
    input,
    inputSha256,
    marker,
    tables,
    adoption,
    credentialManifest,
    rewriteInput,
    rewriteArtifact,
  };
}

function prepare(data: Fixture, expectedInputSha256 = data.rewriteInput()) {
  return prepareFleetFencedTargetRaw({
    inputPath: data.paths.input,
    expectedInputSha256,
    outputPath: data.paths.output,
  });
}

describe("fleet fenced-target-raw-v1 generator", () => {
  it("advertises a local read-only plan", () => {
    expect(fleetFencedTargetRawPlan()).toEqual({
      status: "RUNTIME_FLEET_FENCED_TARGET_RAW_PLAN_ONLY",
      contract: "fenced-target-raw-v1",
      remoteMutations: 0,
      activationAllowed: false,
      requiredEnvironment: [
        "RUNTIME_FLEET_FENCED_TARGET_RAW_INPUT",
        "RUNTIME_FLEET_FENCED_TARGET_RAW_EXPECTED_INPUT_SHA256",
        "RUNTIME_FLEET_FENCED_TARGET_RAW_OUTPUT",
      ],
    });
  });

  it("writes one deterministic private artifact compatible with the activation contract", () => {
    const first = fixture();
    const result = prepare(first, first.inputSha256);
    const artifact = JSON.parse(readFileSync(result.outputPath, "utf8")) as {
      tables: { sales_events: Array<{ id: string }> };
      [key: string]: unknown;
    };

    expect(result).toMatchObject({
      status: "RUNTIME_FLEET_FENCED_TARGET_RAW_READY",
      contract: "fenced-target-raw-v1",
      remoteMutations: 0,
      activationAllowed: false,
      connectionId: CONNECTION_ID,
      counts: { events: 2, lines: 2, receipts: 1, mappings: 1 },
    });
    expect(statSync(result.outputPath).mode & 0o777).toBe(0o600);
    expect(Object.keys(artifact)).toEqual([
      "schemaVersion",
      "kind",
      "connectionId",
      "target",
      "window",
      "capturedAt",
      "marker",
      "tables",
    ]);
    expect(artifact).toMatchObject({
      schemaVersion: 2,
      kind: "target-raw-corrected",
      connectionId: CONNECTION_ID,
      target: "piyvadlzagtracciquap",
      capturedAt: "2026-08-04T14:19:10.694Z",
      window: { fromBusinessDay: "2026-07-05", throughBusinessDay: "2026-08-04" },
    });
    expect(artifact.tables.sales_events.map((row) => row.id)).toEqual(["event-a", "event-b"]);
    expect(result.outputSha256).toBe(sha256(readFileSync(result.outputPath)));

    const second = fixture();
    const secondResult = prepare(second, second.inputSha256);
    expect(readFileSync(secondResult.outputPath)).toEqual(readFileSync(result.outputPath));
  });

  it("fails closed on input hash or permission drift", () => {
    const hashDrift = fixture();
    expect(() => prepare(hashDrift, "0".repeat(64))).toThrow(
      "RUNTIME_FLEET_FENCED_TARGET_RAW_INPUT_SHA256_MISMATCH",
    );

    const publicInput = fixture();
    chmodSync(publicInput.paths.input, 0o644);
    expect(() => prepare(publicInput, publicInput.inputSha256)).toThrow(
      "RUNTIME_FLEET_FENCED_TARGET_RAW_INPUT_MUST_BE_PRIVATE_0600",
    );
  });

  it("fails closed when a referenced artifact hash or connection drifts", () => {
    const artifactDrift = fixture();
    writeFileSync(artifactDrift.paths.sales_events, "[]\n", { mode: 0o600 });
    expect(() => prepare(artifactDrift)).toThrow(
      "RUNTIME_FLEET_FENCED_TARGET_RAW_SALES_EVENTS_SHA256_MISMATCH",
    );

    const connectionDrift = fixture();
    const rows = structuredClone(connectionDrift.tables.sales_line_items);
    rows[0].connection_id = OTHER_CONNECTION_ID;
    connectionDrift.rewriteArtifact("sales_line_items", rows);
    expect(() => prepare(connectionDrift)).toThrow(
      "RUNTIME_FLEET_FENCED_TARGET_RAW_CONNECTION_MISMATCH",
    );
  });

  it("binds counts, cursor and the corrected target to adoption v3", () => {
    const countDrift = fixture();
    countDrift.rewriteArtifact("sales_events", countDrift.tables.sales_events.slice(1));
    countDrift.rewriteArtifact("sales_line_items", countDrift.tables.sales_line_items.slice(1));
    expect(() => prepare(countDrift)).toThrow(
      "RUNTIME_FLEET_FENCED_TARGET_RAW_WATERMARK_MISMATCH",
    );

    const cursorDrift = fixture();
    const marker = structuredClone(cursorDrift.marker);
    marker[0].last_business_day_synced = "2026-08-02";
    cursorDrift.rewriteArtifact("marker", marker);
    expect(() => prepare(cursorDrift)).toThrow(
      "RUNTIME_FLEET_FENCED_TARGET_RAW_CURSOR_MISMATCH",
    );

    const bindingDrift = fixture();
    const manifest = structuredClone(bindingDrift.credentialManifest);
    manifest.adoption.bindingSha256 = sha256("forged-binding");
    bindingDrift.rewriteArtifact("credential", manifest);
    expect(() => prepare(bindingDrift)).toThrow(
      "RUNTIME_FLEET_FENCED_TARGET_RAW_ADOPTION_BINDING_MISMATCH",
    );
  });

  it("rejects output secrets, orphan rows and events outside the declared window", () => {
    const secret = fixture();
    const marker = structuredClone(secret.marker);
    marker[0].provider_config.api_token = "must-not-leak";
    secret.input.expectedProviderConfigSha256 = sha256(canonicalJson(marker[0].provider_config));
    secret.rewriteArtifact("marker", marker);
    expect(() => prepare(secret)).toThrow("RUNTIME_FLEET_FENCED_TARGET_RAW_SECRET_KEY_AT_");

    const orphan = fixture();
    const lines = structuredClone(orphan.tables.sales_line_items);
    lines[0].sales_event_id = "missing-event";
    orphan.rewriteArtifact("sales_line_items", lines);
    expect(() => prepare(orphan)).toThrow(
      "RUNTIME_FLEET_FENCED_TARGET_RAW_ORPHAN_SALES_LINE_ITEM",
    );

    const outsideWindow = fixture();
    const events = structuredClone(outsideWindow.tables.sales_events);
    events[0].business_day = "2026-07-04";
    outsideWindow.rewriteArtifact("sales_events", events);
    expect(() => prepare(outsideWindow)).toThrow(
      "RUNTIME_FLEET_FENCED_TARGET_RAW_EVENT_OUTSIDE_WINDOW",
    );
  });

  it("requires a new absolute output outside the repository", () => {
    const existing = fixture();
    writeFileSync(existing.paths.output, "occupied", { mode: 0o600 });
    expect(() => prepare(existing)).toThrow(
      "RUNTIME_FLEET_FENCED_TARGET_RAW_OUTPUT_ALREADY_EXISTS",
    );

    const insideRepo = fixture();
    expect(() => prepareFleetFencedTargetRaw({
      inputPath: insideRepo.paths.input,
      expectedInputSha256: insideRepo.inputSha256,
      outputPath: join(process.cwd(), "fenced-target-raw.must-not-write.json"),
    })).toThrow("RUNTIME_FLEET_FENCED_TARGET_RAW_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  });
});
