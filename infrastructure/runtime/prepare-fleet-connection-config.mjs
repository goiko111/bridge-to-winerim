import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_CONFIG_BYTES = 512 * 1024;
const REDACTED_BASE_URLS = new Set([
  "https://redacted.invalid",
  "https://redacted.invalid/",
]);
const SECRET_KEY_PATTERN = /(?:^|[_-])(?:api[_-]?token|winerim[_-]?(?:api[_-]?)?token|token|secret|password|authorization|bearer|credential|private[_-]?key)(?:$|[_-])/i;
const FORBIDDEN_OUTPUT_PATTERN = /(?:api_token|winerim_api_token|catalog_endpoint|restaurant_guid|last_business_day_synced|last_sync_at|last_catalog_sync_at|circuit_breaker|consecutive_failures)/i;

// This is deliberately an allowlist. Historical diagnostics and secret references stay behind.
const SAFE_PROVIDER_CONFIG_KEYS = new Set([
  "agora_family_routing_rules",
  "agora_hidden_glass_variants",
  "agora_product_button_text_mode",
  "agora_product_color_by_wine_type",
  "agora_product_name_overrides",
  "agora_product_presentation_enabled",
  "agora_product_sort_family_ids",
  "agora_product_sort_mode",
  "agora_product_sort_prefix_order",
  "agora_product_sort_prefix_order_by_family",
  "allow_customer_scope_reads",
  "auto_push_on_create",
  "auto_push_on_update",
  "auto_push_update_diff_enabled",
  "auto_push_verified_ready",
  "business_day_cutoff_hour",
  "family_structure_mode",
  "geographic_config",
  "historical_sales_backfill_mode",
  "historical_sales_name_aliases",
  "intraday_sales_source",
  "intraday_sales_sync_enabled",
  "intraday_sales_sync_interval_minutes",
  "legacy_policy",
  "legacy_visibility_policy",
  "live_sales_mode",
  "open_tickets_min_line_age_minutes",
  "open_tickets_restore_lookback_hours",
  "open_tickets_restore_stale_previous_days_enabled",
  "open_tickets_stock_current_day_only",
  "open_tickets_stock_sync_enabled",
  "open_tickets_sync_enabled",
  "preparation_route_source",
  "preparation_routes",
  "price_write_scope",
  "publish_hidden_glass_variants",
  "read_only",
  "read_only_onboarding",
  "sales_timezone",
  "stock_policy",
  "stock_sync_not_before",
  "stock_sync_start_date",
  "store_id",
  "visual_policy",
  "warehouse_location_id",
  "winerim_family_ids",
]);

const ACTIVATION_CONFIG_KEYS = [
  "sync_frequency_minutes",
  "default_wine_family_name",
  "default_vat_rate",
  "default_bottle_format_name",
  "default_glass_format_name",
  "default_family_id",
  "default_vat_id",
  "default_preparation_type_id",
  "default_preparation_order_id",
  "default_warehouse_id",
  "auto_create_families",
  "write_bottle",
  "write_glass",
  "auto_push_on_create",
  "auto_push_on_update",
  "auto_push_bottle",
  "auto_push_glass",
  "require_manual_review_before_push",
  "auto_push_verified_ready",
  "estimated_glasses_per_bottle",
  "selected_sale_center_ids",
];

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function required(environment, name) {
  const value = String(environment[name] ?? "").trim();
  if (!value) throw new Error(`RUNTIME_FLEET_CONNECTION_CONFIG_MISSING_${name}`);
  return value;
}

function isOutsideRepository(path) {
  const candidate = relative(repoRoot, path);
  return candidate !== "" && (candidate.startsWith("..") || candidate.startsWith("/"));
}

function readPrivateFile(path, label) {
  if (!isAbsolute(path)) {
    throw new Error(`RUNTIME_FLEET_CONNECTION_CONFIG_${label}_PATH_MUST_BE_ABSOLUTE`);
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`RUNTIME_FLEET_CONNECTION_CONFIG_${label}_MUST_BE_REGULAR_FILE`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`RUNTIME_FLEET_CONNECTION_CONFIG_${label}_MUST_BE_PRIVATE_0600`);
  }
  if (metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) {
    throw new Error(`RUNTIME_FLEET_CONNECTION_CONFIG_${label}_INVALID_SIZE`);
  }
  return readFileSync(path);
}

function parseJson(source, label) {
  try {
    return JSON.parse(source.toString("utf8"));
  } catch {
    throw new Error(`RUNTIME_FLEET_CONNECTION_CONFIG_INVALID_${label}_JSON`);
  }
}

function rowsFrom(document, label) {
  const rows = Array.isArray(document)
    ? document
    : document?.connections ?? document?.rows ?? document?.data;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`RUNTIME_FLEET_CONNECTION_CONFIG_INVALID_${label}_CONTRACT`);
  }
  return rows;
}

function plainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function secretKey(value) {
  const normalized = String(value).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return SECRET_KEY_PATTERN.test(normalized);
}

function validateJsonValue(value, path, depth = 0) {
  if (depth > 8) {
    throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_PROVIDER_CONFIG_TOO_DEEP");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_PROVIDER_CONFIG_NONFINITE_NUMBER");
    }
    return value;
  }
  if (typeof value === "string") {
    if (/\0|[\r\n]/.test(value)) {
      throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_PROVIDER_CONFIG_INVALID_STRING");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => validateJsonValue(entry, `${path}[${index}]`, depth + 1));
  }
  if (!plainObject(value)) {
    throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_PROVIDER_CONFIG_INVALID_VALUE");
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (secretKey(key)) {
      throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_SECRET_KEY_IN_SAFE_PROVIDER_CONFIG");
    }
    result[key] = validateJsonValue(value[key], `${path}.${key}`, depth + 1);
  }
  return result;
}

function collectSecretValues(row) {
  const values = new Set();
  for (const field of ["api_token", "winerim_api_token"]) {
    const value = row?.[field];
    if (typeof value === "string" && value.length >= 4) values.add(value);
  }
  function walk(value, inheritedSecret = false) {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      const secret = inheritedSecret || secretKey(key);
      if (secret && typeof nested === "string" && nested.length >= 4) values.add(nested);
      if (nested && typeof nested === "object") walk(nested, secret);
    }
  }
  walk(row?.provider_config);
  return values;
}

function safeProviderConfig(row) {
  const source = plainObject(row?.provider_config) ? row.provider_config : {};
  const safe = {};
  const omitted = [];
  for (const key of Object.keys(source).sort()) {
    if (!SAFE_PROVIDER_CONFIG_KEYS.has(key)) {
      omitted.push(key);
      continue;
    }
    if (secretKey(key)) {
      throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_SECRET_KEY_IN_SAFE_PROVIDER_CONFIG");
    }
    safe[key] = validateJsonValue(source[key], `provider_config.${key}`);
  }
  const serialized = canonicalJson(safe);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_PROVIDER_CONFIG_TOO_LARGE");
  }
  return {
    safe,
    omittedCount: omitted.length,
    omittedKeysSha256: sha256(canonicalJson(omitted)),
  };
}

function privateIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224;
}

function privateIpv6(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(":")) return false;
  return host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd")
    || /^fe[89ab]/.test(host);
}

function privateHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".lan")
    || host.endsWith(".internal")
    || privateIpv4(host)
    || privateIpv6(host);
}

export function validateAgoraBaseUrl(value, authorizedPrivateBaseUrlSha256 = null) {
  if (typeof value !== "string" || value !== value.trim() || /[\r\n\0?#]/.test(value)) {
    throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_INVALID_BASE_URL");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_INVALID_BASE_URL");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)
    || parsed.username
    || parsed.password
    || !parsed.hostname) {
    throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_INVALID_BASE_URL");
  }
  const canonical = parsed.toString();
  if (privateHost(parsed.hostname)) {
    if (!SHA256_PATTERN.test(authorizedPrivateBaseUrlSha256 ?? "")
      || sha256(canonical) !== authorizedPrivateBaseUrlSha256) {
      throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_PRIVATE_BASE_URL_NOT_AUTHORIZED");
    }
  }
  return canonical;
}

function normalizeConnectionId(value, label) {
  const connectionId = String(value ?? "").trim().toLowerCase();
  if (!UUID_PATTERN.test(connectionId)) {
    throw new Error(`RUNTIME_FLEET_CONNECTION_CONFIG_INVALID_${label}_CONNECTION_ID`);
  }
  return connectionId;
}

function indexRows(rows, label) {
  const index = new Map();
  for (const row of rows) {
    const connectionId = normalizeConnectionId(row?.id ?? row?.connectionId, label);
    if (index.has(connectionId)) {
      throw new Error(`RUNTIME_FLEET_CONNECTION_CONFIG_DUPLICATE_${label}_CONNECTION_ID`);
    }
    index.set(connectionId, row);
  }
  return index;
}

function assertTargetInert(row) {
  if (
    row?.provider !== "agora"
    || row?.enabled !== false
    || row?.catalog_sync_enabled !== false
    || row?.sync_mode !== "PULL_ONLY"
    || row?.write_mode !== "NONE"
    || row?.backfill_days !== 0
    || !REDACTED_BASE_URLS.has(row?.base_url)
    || !plainObject(row?.provider_config)
    || Object.keys(row.provider_config).length !== 0
    || !new Set(["", null, undefined]).has(row?.api_token)
    || !new Set([null, undefined]).has(row?.winerim_api_token)
  ) {
    throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_TARGET_NOT_INERT_SANITIZED");
  }
}

function activationConfig(row, safeConfigSha256, baseUrlSha256) {
  if (!new Set(["PULL_ONLY", "BIDIRECTIONAL"]).has(row.sync_mode)) {
    throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_INVALID_DESIRED_SYNC_MODE");
  }
  if (!new Set(["NONE", "XML_IMPORT"]).has(row.write_mode)) {
    throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_INVALID_DESIRED_WRITE_MODE");
  }
  if (!Number.isSafeInteger(row.backfill_days) || row.backfill_days < 0) {
    throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_INVALID_DESIRED_BACKFILL_DAYS");
  }
  const config = {};
  for (const key of ACTIVATION_CONFIG_KEYS) {
    if (row[key] !== undefined) config[key] = validateJsonValue(row[key], key);
  }
  return {
    desiredControlPlane: {
      enabled: row.enabled === true,
      catalogSyncEnabled: row.catalog_sync_enabled === true,
      syncMode: row.sync_mode,
      writeMode: row.write_mode,
      backfillDays: row.backfill_days,
    },
    config,
    baseUrlSha256,
    providerConfigSha256: safeConfigSha256,
  };
}

export function validateFleetConnectionConfigInput({
  sourceDocument,
  targetDocument,
  sourceSha256,
  targetSha256,
}) {
  if (!SHA256_PATTERN.test(sourceSha256) || !SHA256_PATTERN.test(targetSha256)) {
    throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_INVALID_INPUT_SHA256");
  }
  const sourceIndex = indexRows(rowsFrom(sourceDocument, "SOURCE"), "SOURCE");
  const targetIndex = indexRows(rowsFrom(targetDocument, "TARGET"), "TARGET");
  const connections = [];
  const allSecrets = new Set();

  for (const [connectionId, source] of sourceIndex) {
    if (source?.provider !== "agora") {
      throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_SOURCE_PROVIDER_NOT_AGORA");
    }
    const target = targetIndex.get(connectionId);
    if (!target) {
      throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_TARGET_CONNECTION_MISSING");
    }
    assertTargetInert(target);
    for (const secret of collectSecretValues(source)) allSecrets.add(secret);
    const baseUrl = validateAgoraBaseUrl(
      source.base_url,
      target.authorized_private_base_url_sha256,
    );
    const providerConfig = safeProviderConfig(source);
    const providerConfigSha256 = sha256(canonicalJson(providerConfig.safe));
    connections.push({
      connectionId,
      targetBaseUrl: target.base_url,
      targetProviderConfig: target.provider_config,
      baseUrl,
      providerConfig: providerConfig.safe,
      omittedProviderConfigKeyCount: providerConfig.omittedCount,
      omittedProviderConfigKeysSha256: providerConfig.omittedKeysSha256,
      activation: activationConfig(source, providerConfigSha256, sha256(baseUrl)),
    });
  }

  return {
    sourceSha256,
    targetSha256,
    connections: connections.sort((left, right) => left.connectionId.localeCompare(right.connectionId)),
    secretValues: allSecrets,
  };
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function connectionSql(connection, rollback) {
  const expectedBaseUrl = rollback ? connection.baseUrl : connection.targetBaseUrl;
  const expectedProviderConfig = rollback
    ? connection.providerConfig
    : connection.targetProviderConfig;
  const nextBaseUrl = rollback ? connection.targetBaseUrl : connection.baseUrl;
  const nextProviderConfig = rollback
    ? connection.targetProviderConfig
    : connection.providerConfig;
  const errorPrefix = rollback ? "FLEET_CONNECTION_CONFIG_ROLLBACK" : "FLEET_CONNECTION_CONFIG_APPLY";
  return `DO $fleet_connection_config$
DECLARE
  affected integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.pos_connections
     WHERE id = ${sqlLiteral(connection.connectionId)}::uuid
       AND provider = 'agora'
       AND enabled = false
       AND catalog_sync_enabled = false
       AND sync_mode = 'PULL_ONLY'
       AND write_mode = 'NONE'
       AND backfill_days = 0
       AND base_url = ${sqlLiteral(expectedBaseUrl)}
       AND provider_config = ${sqlLiteral(canonicalJson(expectedProviderConfig))}::jsonb
  ) THEN
    RAISE EXCEPTION '${errorPrefix}_PRECONDITION_FAILED:${connection.connectionId}';
  END IF;

  UPDATE public.pos_connections
     SET base_url = ${sqlLiteral(nextBaseUrl)},
         provider_config = ${sqlLiteral(canonicalJson(nextProviderConfig))}::jsonb
   WHERE id = ${sqlLiteral(connection.connectionId)}::uuid
     AND provider = 'agora'
     AND enabled = false
     AND catalog_sync_enabled = false
     AND sync_mode = 'PULL_ONLY'
     AND write_mode = 'NONE'
     AND backfill_days = 0
     AND base_url = ${sqlLiteral(expectedBaseUrl)}
     AND provider_config = ${sqlLiteral(canonicalJson(expectedProviderConfig))}::jsonb;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '${errorPrefix}_ROW_COUNT:%:${connection.connectionId}', affected;
  END IF;
END
$fleet_connection_config$;`;
}

export function renderFleetConnectionConfigSql(plan) {
  return `${[
    "-- LOCAL-ONLY artifact. Review before any remote execution.",
    `-- source_sha256=${plan.sourceSha256}`,
    `-- target_sha256=${plan.targetSha256}`,
    "BEGIN;",
    ...plan.connections.map((connection) => connectionSql(connection, false)),
    "COMMIT;",
    "",
  ].join("\n\n")}`;
}

export function renderFleetConnectionConfigRollbackSql(plan) {
  return `${[
    "-- Exact inverse of the matching fleet connection config artifact.",
    `-- source_sha256=${plan.sourceSha256}`,
    `-- target_sha256=${plan.targetSha256}`,
    "BEGIN;",
    ...[...plan.connections].reverse().map((connection) => connectionSql(connection, true)),
    "COMMIT;",
    "",
  ].join("\n\n")}`;
}

function assertNoSecretDisclosure(sources, secrets) {
  for (const source of sources) {
    if (FORBIDDEN_OUTPUT_PATTERN.test(source)) {
      throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_FORBIDDEN_FIELD_IN_OUTPUT");
    }
    for (const secret of secrets) {
      if (source.includes(secret)) {
        throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_SECRET_VALUE_IN_OUTPUT");
      }
    }
  }
}

export function buildFleetConnectionConfigManifests(plan, applySql, rollbackSql) {
  const configCore = {
    version: 1,
    kind: "RUNTIME_FLEET_CONNECTION_CONFIG",
    mode: "local-only",
    remoteMutations: 0,
    activationAllowed: false,
    sourceSha256: plan.sourceSha256,
    targetSha256: plan.targetSha256,
    connectionCount: plan.connections.length,
    applySqlSha256: sha256(applySql),
    rollbackSqlSha256: sha256(rollbackSql),
    connections: plan.connections.map((connection) => ({
      connectionId: connection.connectionId,
      baseUrlSha256: sha256(connection.baseUrl),
      providerConfigSha256: sha256(canonicalJson(connection.providerConfig)),
      omittedProviderConfigKeyCount: connection.omittedProviderConfigKeyCount,
      omittedProviderConfigKeysSha256: connection.omittedProviderConfigKeysSha256,
    })),
  };
  const configManifest = {
    ...configCore,
    logicalManifestSha256: sha256(canonicalJson(configCore)),
  };
  const activationCore = {
    version: 1,
    kind: "RUNTIME_FLEET_CONNECTION_ACTIVATION_DESIRED",
    activationAllowed: false,
    activationBlockReason: "PER_CONNECTION_FENCE_RECONCILIATION_AND_CANARY_REQUIRED",
    remoteMutations: 0,
    sourceSha256: plan.sourceSha256,
    targetSha256: plan.targetSha256,
    connections: plan.connections.map((connection) => ({
      connectionId: connection.connectionId,
      ...connection.activation,
    })),
  };
  return {
    configManifest,
    activationManifest: {
      ...activationCore,
      logicalManifestSha256: sha256(canonicalJson(activationCore)),
    },
  };
}

function validateExternalOutput(outputDir) {
  const target = resolve(outputDir);
  if (!isAbsolute(outputDir) || !isOutsideRepository(target)) {
    throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_OUTPUT_MUST_BE_ABSOLUTE_OUTSIDE_REPOSITORY");
  }
  if (existsSync(target)) {
    throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_OUTPUT_ALREADY_EXISTS");
  }
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const realParent = realpathSync(parent);
  if (!isOutsideRepository(realParent)) {
    throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_OUTPUT_MUST_BE_ABSOLUTE_OUTSIDE_REPOSITORY");
  }
  return { target, realParent };
}

export function fleetConnectionConfigPlan() {
  return {
    status: "RUNTIME_FLEET_CONNECTION_CONFIG_PLAN_ONLY",
    remoteMutations: 0,
    activationAllowed: false,
    writesCredentials: false,
    requiredEnvironment: [
      "RUNTIME_FLEET_CONNECTION_SOURCE_JSON",
      "RUNTIME_FLEET_CONNECTION_TARGET_SNAPSHOT",
      "RUNTIME_FLEET_CONNECTION_EXPECTED_SOURCE_SHA256",
      "RUNTIME_FLEET_CONNECTION_OUTPUT_DIR",
    ],
  };
}

export function prepareFleetConnectionConfig({
  environment = process.env,
  sourcePath,
  targetSnapshotPath,
  expectedSourceSha256,
  outputDir,
}) {
  const resolvedSourcePath = resolve(
    sourcePath ?? required(environment, "RUNTIME_FLEET_CONNECTION_SOURCE_JSON"),
  );
  const resolvedTargetPath = resolve(
    targetSnapshotPath ?? required(environment, "RUNTIME_FLEET_CONNECTION_TARGET_SNAPSHOT"),
  );
  const expectedHash = expectedSourceSha256
    ?? required(environment, "RUNTIME_FLEET_CONNECTION_EXPECTED_SOURCE_SHA256");
  const destination = outputDir ?? required(environment, "RUNTIME_FLEET_CONNECTION_OUTPUT_DIR");
  if (!SHA256_PATTERN.test(expectedHash)) {
    throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_INVALID_EXPECTED_SOURCE_SHA256");
  }

  const sourceBytes = readPrivateFile(resolvedSourcePath, "SOURCE_JSON");
  const actualSourceSha256 = sha256(sourceBytes);
  if (actualSourceSha256 !== expectedHash) {
    throw new Error("RUNTIME_FLEET_CONNECTION_CONFIG_SOURCE_SHA256_MISMATCH");
  }
  const targetBytes = readPrivateFile(resolvedTargetPath, "TARGET_SNAPSHOT");
  const plan = validateFleetConnectionConfigInput({
    sourceDocument: parseJson(sourceBytes, "SOURCE"),
    targetDocument: parseJson(targetBytes, "TARGET"),
    sourceSha256: actualSourceSha256,
    targetSha256: sha256(targetBytes),
  });
  const applySql = renderFleetConnectionConfigSql(plan);
  const rollbackSql = renderFleetConnectionConfigRollbackSql(plan);
  const { configManifest, activationManifest } = buildFleetConnectionConfigManifests(
    plan,
    applySql,
    rollbackSql,
  );
  const configManifestSource = `${JSON.stringify(configManifest, null, 2)}\n`;
  const activationManifestSource = `${JSON.stringify(activationManifest, null, 2)}\n`;
  assertNoSecretDisclosure(
    [applySql, rollbackSql, configManifestSource, activationManifestSource],
    plan.secretValues,
  );

  const { target, realParent } = validateExternalOutput(destination);
  const staging = mkdtempSync(join(realParent, `.${basename(target)}.tmp-`));
  chmodSync(staging, 0o700);
  try {
    const files = {
      applySql: join(staging, "fleet-connection-config.sql"),
      rollbackSql: join(staging, "fleet-connection-config.rollback.sql"),
      configManifest: join(staging, "fleet-connection-config.manifest.json"),
      activationManifest: join(staging, "fleet-connection-activation.manifest.json"),
    };
    writeFileSync(files.applySql, applySql, { encoding: "utf8", mode: 0o600, flag: "wx" });
    writeFileSync(files.rollbackSql, rollbackSql, { encoding: "utf8", mode: 0o600, flag: "wx" });
    writeFileSync(files.configManifest, configManifestSource, {
      encoding: "utf8", mode: 0o600, flag: "wx",
    });
    writeFileSync(files.activationManifest, activationManifestSource, {
      encoding: "utf8", mode: 0o600, flag: "wx",
    });
    for (const path of Object.values(files)) chmodSync(path, 0o600);
    renameSync(staging, target);
    return {
      status: "RUNTIME_FLEET_CONNECTION_CONFIG_ARTIFACTS_READY",
      remoteMutations: 0,
      activationAllowed: false,
      connectionCount: plan.connections.length,
      outputDir: target,
      applySqlPath: join(target, basename(files.applySql)),
      rollbackSqlPath: join(target, basename(files.rollbackSql)),
      configManifestPath: join(target, basename(files.configManifest)),
      activationManifestPath: join(target, basename(files.activationManifest)),
      applySqlSha256: configManifest.applySqlSha256,
      rollbackSqlSha256: configManifest.rollbackSqlSha256,
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function argument(name) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function main() {
  if (!process.argv.includes("--render")) {
    process.stdout.write(`${JSON.stringify(fleetConnectionConfigPlan(), null, 2)}\n`);
    return;
  }
  const result = prepareFleetConnectionConfig({
    sourcePath: argument("--source"),
    targetSnapshotPath: argument("--target"),
    expectedSourceSha256: argument("--expected-source-sha256"),
    outputDir: argument("--output"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
