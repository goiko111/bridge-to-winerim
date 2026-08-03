import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const redactedBaseUrl = "https://redacted.invalid";
const supportedProviders = new Set([
  "agora", "revo", "square", "toast", "clover", "hiopos", "bdp",
  "waiterone", "cuiner", "yurest", "horepos",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sqlText(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function argumentValue(args, name) {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function normalizeFleetDocument(document) {
  if (Array.isArray(document?.rows)) return document.rows;
  if (Array.isArray(document?.targets)) {
    return document.targets.map((target) => ({
      location_name: target.connection?.location_name,
      connection_id: target.connection?.id,
      connection: target.connection,
      capability: Array.isArray(target.capabilities) ? target.capabilities[0] ?? null : target.capabilities,
      master: target.master,
      mappings: target.mappings,
      tracking: target.tracking,
    }));
  }
  if (Array.isArray(document?.summaries)) {
    return document.summaries.map((summary) => ({
      location_name: summary.location,
      connection_id: summary.id,
      connection: {
        id: summary.id,
        location_name: summary.location,
        provider: summary.provider,
        enabled: summary.flags?.enabled,
        catalog_sync_enabled: summary.flags?.catalog_sync_enabled,
        write_mode: summary.flags?.write_mode,
        sync_mode: summary.flags?.sync_mode,
        circuit_breaker_paused_until: summary.flags?.breaker_until,
        circuit_breaker_reason: summary.flags?.breaker_reason,
        consecutive_failures: summary.flags?.consecutive_failures,
        sync_frequency_minutes: summary.flags?.sync_frequency_minutes,
        last_sync_at: summary.runtime?.last_sync_at,
        last_catalog_sync_at: summary.runtime?.last_catalog_sync_at,
        last_business_day_synced: summary.runtime?.last_business_day_synced,
      },
      capability: summary.capabilities,
      master: summary.master ? {
        ...summary.master,
        products: summary.master.products ?? summary.master.products_summary ?? null,
      } : null,
      mappings: summary.mappings,
      tracking: summary.tracking,
    }));
  }
  throw new Error("RESCUE_BOOTSTRAP_UNSUPPORTED_FLEET_DOCUMENT");
}

export function mergeFleetDocuments(documents) {
  const generatedAt = documents.map((document) => document.generated_at).filter(Boolean).sort().at(-1) ?? null;
  return {
    generated_at: generatedAt,
    rows: documents.flatMap(normalizeFleetDocument),
  };
}

function validateFleetRows(rows, expectedCount) {
  if (!Array.isArray(rows) || rows.length !== expectedCount) {
    throw new Error(`RESCUE_BOOTSTRAP_EXPECTED_${expectedCount}_CONNECTIONS`);
  }
  const ids = new Set();
  for (const row of rows) {
    const id = String(row?.connection_id ?? row?.connection?.id ?? "");
    if (!uuidPattern.test(id)) throw new Error("RESCUE_BOOTSTRAP_INVALID_CONNECTION_ID");
    if (ids.has(id)) throw new Error(`RESCUE_BOOTSTRAP_DUPLICATE_CONNECTION_ID_${id}`);
    if (!String(row?.location_name ?? row?.connection?.location_name ?? "").trim()) {
      throw new Error(`RESCUE_BOOTSTRAP_MISSING_LOCATION_${id}`);
    }
    const provider = String(row?.connection?.provider ?? "agora").toLowerCase();
    if (!supportedProviders.has(provider)) {
      throw new Error(`RESCUE_BOOTSTRAP_UNSUPPORTED_PROVIDER_${provider}`);
    }
    ids.add(id);
  }
}

function connectivityById(connectivity) {
  return new Map((connectivity?.rows ?? []).map((row) => [String(row.connection_id), row]));
}

function readinessById(readiness) {
  if (!readiness) return new Map();
  const entries = Array.isArray(readiness) ? readiness : readiness.connections;
  if (!Array.isArray(entries)) throw new Error("RESCUE_BOOTSTRAP_INVALID_READINESS");
  return new Map(entries.map((row) => {
    const connectionId = String(row.connectionId ?? row.connection_id ?? "");
    if (!uuidPattern.test(connectionId)) throw new Error("RESCUE_BOOTSTRAP_INVALID_READINESS_ID");
    const allowed = new Set(["connectionId", "connection_id", "agoraCredentialReady", "winerimCredentialReady"]);
    const unexpected = Object.keys(row).filter((key) => !allowed.has(key));
    if (unexpected.length) throw new Error(`RESCUE_BOOTSTRAP_READINESS_FIELD_NOT_ALLOWED_${unexpected[0]}`);
    return [connectionId, {
      agoraCredentialReady: row.agoraCredentialReady === true,
      winerimCredentialReady: row.winerimCredentialReady === true,
    }];
  }));
}

function count(statusGroup, key) {
  const value = statusGroup?.[key]?.count ?? statusGroup?.by_status?.[key];
  return Number.isFinite(value) ? value : null;
}

export function buildRescueBootstrapManifest({
  fleet,
  connectivity = { rows: [] },
  credentialReadiness = null,
  fleetFiles = ["fleet.json"],
  connectivityFile = "connectivity.json",
  expectedCount = 30,
} = {}) {
  const rows = fleet?.rows;
  validateFleetRows(rows, expectedCount);
  const connectivityLookup = connectivityById(connectivity);
  const readinessLookup = readinessById(credentialReadiness);

  const connections = rows.map((row) => {
    const connection = row.connection ?? {};
    const id = String(row.connection_id ?? connection.id);
    const locationName = String(row.location_name ?? connection.location_name).trim();
    const provider = String(connection.provider ?? "agora").toLowerCase();
    const connectionTest = connectivityLookup.get(id) ?? null;
    const readiness = readinessLookup.get(id) ?? {
      agoraCredentialReady: false,
      winerimCredentialReady: false,
    };
    const credentialsReady = readiness.agoraCredentialReady && readiness.winerimCredentialReady;
    const previouslyReachable = connectionTest?.success === true;

    return {
      id,
      locationName,
      bootstrapRow: {
        id,
        location_name: locationName,
        provider,
        base_url: redactedBaseUrl,
        api_token: "",
        winerim_api_token: null,
        enabled: false,
        catalog_sync_enabled: false,
        sync_mode: "PULL_ONLY",
        write_mode: "NONE",
        sync_frequency_minutes: 5,
        backfill_days: 0,
        last_sync_at: null,
        last_catalog_sync_at: null,
        last_business_day_synced: null,
        circuit_breaker_paused_until: null,
        circuit_breaker_reason: null,
        consecutive_failures: 0,
      },
      observedBeforeOutage: {
        enabled: connection.enabled === true,
        provider,
        catalogSyncEnabled: connection.catalog_sync_enabled === true,
        syncMode: connection.sync_mode ?? null,
        writeMode: connection.write_mode ?? null,
        lastSyncAt: connection.last_sync_at ?? null,
        lastCatalogSyncAt: connection.last_catalog_sync_at ?? null,
        lastBusinessDaySynced: connection.last_business_day_synced ?? null,
        connectionTest: connectionTest ? {
          success: connectionTest.success === true,
          httpStatus: connectionTest.edge_http_status ?? null,
          durationMs: connectionTest.duration_ms ?? null,
        } : null,
        master: {
          families: row.master?.families ?? null,
          products: row.master?.products ?? null,
          winerimFamilies: row.master?.winerim_families ?? null,
          visibleWinerimFamilies: row.master?.visible_winerim_families ?? null,
          fetchedAt: row.master?.fetched_at ?? null,
        },
        mappings: {
          confirmed: count(row.mappings, "CONFIRMED"),
          pending: count(row.mappings, "PENDING"),
          rejected: count(row.mappings, "REJECTED"),
        },
        tracking: {
          verified: count(row.tracking, "VERIFIED"),
          notPushed: count(row.tracking, "NOT_PUSHED"),
        },
      },
      gates: {
        agoraCredentialReady: readiness.agoraCredentialReady,
        winerimCredentialReady: readiness.winerimCredentialReady,
        transportConfigReady: false,
        providerConfigReady: false,
        catalogRowsReconciled: false,
        mappingRowsReconciled: false,
        historicalSalesImportedWithoutStock: false,
        liveCutoverTimestampSet: false,
        idempotencySeeded: false,
        canActivate: false,
      },
      recommendedWave: credentialsReady && previouslyReachable ? 1 : previouslyReachable ? 2 : 3,
    };
  }).sort((left, right) => left.locationName.localeCompare(right.locationName, "es"));

  const body = {
    schemaVersion: 1,
    kind: "winerim-rescue-bootstrap",
    source: {
      fleetFiles: fleetFiles.map((path) => basename(path)),
      fleetGeneratedAt: fleet.generated_at ?? null,
      connectivityFile: basename(connectivityFile),
      connectivityGeneratedAt: connectivity.generated_at ?? null,
    },
    safety: {
      allConnectionsDisabled: true,
      catalogSyncDisabled: true,
      writeMode: "NONE",
      noOperationalQueueRows: true,
      noCursorCopiedFromEvidence: true,
      noCredentialValuesIncluded: true,
      historicalSalesMustBeImportedWithStockDisabled: true,
    },
    counts: {
      connections: connections.length,
      wave1: connections.filter((row) => row.recommendedWave === 1).length,
      wave2: connections.filter((row) => row.recommendedWave === 2).length,
      wave3: connections.filter((row) => row.recommendedWave === 3).length,
    },
    connections,
  };

  return { ...body, manifestSha256: sha256(canonicalJson(body)) };
}

export function buildRescueBootstrapSql(manifest) {
  const values = manifest.connections.map(({ bootstrapRow: row }) => `(
    ${sqlText(row.id)}, ${sqlText(row.location_name)}, ${sqlText(row.provider)},
    ${sqlText(row.base_url)}, ${sqlText(row.api_token)}, ${sqlText(row.winerim_api_token)},
    FALSE, FALSE, ${sqlText(row.sync_mode)}, ${sqlText(row.write_mode)},
    ${row.sync_frequency_minutes}, ${row.backfill_days}, NULL, NULL, NULL, NULL, NULL, 0
  )`).join(",\n");
  const ids = manifest.connections.map(({ id }) => sqlText(id)).join(", ");

  return `-- Generated rescue seed. It is inert by construction and contains no credentials.\nBEGIN;\n\nINSERT INTO public.pos_connections (\n  id, location_name, provider, base_url, api_token, winerim_api_token,\n  enabled, catalog_sync_enabled, sync_mode, write_mode,\n  sync_frequency_minutes, backfill_days, last_sync_at, last_catalog_sync_at,\n  last_business_day_synced, circuit_breaker_paused_until, circuit_breaker_reason,\n  consecutive_failures\n) VALUES\n${values}\nON CONFLICT (id) DO NOTHING;\n\nDO $rescue_gate$\nBEGIN\n  IF EXISTS (\n    SELECT 1\n    FROM public.pos_connections\n    WHERE id IN (${ids})\n      AND (enabled OR catalog_sync_enabled OR write_mode <> 'NONE')\n  ) THEN\n    RAISE EXCEPTION 'RESCUE_BOOTSTRAP_REFUSES_ACTIVE_CONNECTIONS';\n  END IF;\nEND\n$rescue_gate$;\n\nCOMMIT;\n`;
}

export function writeRescueBootstrapPackage({ manifest, outputDir }) {
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  chmodSync(outputDir, 0o700);
  const manifestPath = resolve(outputDir, "rescue-bootstrap.json");
  const sqlPath = resolve(outputDir, "rescue-connections-disabled.sql");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(sqlPath, buildRescueBootstrapSql(manifest), { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
  chmodSync(sqlPath, 0o600);
  return { manifestPath, sqlPath };
}

function main(args = process.argv.slice(2)) {
  const fleetPathValue = argumentValue(args, "fleet");
  const connectivityPath = argumentValue(args, "connectivity");
  const outputDir = argumentValue(args, "output-dir");
  const readinessPath = argumentValue(args, "credential-readiness");
  const expectedCount = Number(argumentValue(args, "expected-count") ?? 30);
  if (!fleetPathValue || !connectivityPath || !outputDir) {
    throw new Error("USAGE: build-rescue-bootstrap.mjs --fleet=PATH --connectivity=PATH --output-dir=PATH [--credential-readiness=PATH]");
  }
  const fleetPaths = fleetPathValue.split(",").map((value) => value.trim()).filter(Boolean);
  const fleet = mergeFleetDocuments(fleetPaths.map(readJson));
  const connectivity = readJson(connectivityPath);
  const credentialReadiness = readinessPath ? readJson(readinessPath) : null;
  const manifest = buildRescueBootstrapManifest({
    fleet,
    connectivity,
    credentialReadiness,
    fleetFiles: fleetPaths,
    connectivityFile: connectivityPath,
    expectedCount,
  });
  const outputs = writeRescueBootstrapPackage({ manifest, outputDir: resolve(outputDir) });
  process.stdout.write(`RESCUE_BOOTSTRAP_PACKAGE_READY connections=${manifest.counts.connections} wave1=${manifest.counts.wave1} wave2=${manifest.counts.wave2} wave3=${manifest.counts.wave3} manifest_sha256=${manifest.manifestSha256} output_dir=${resolve(outputDir)}\n`);
  return outputs;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
