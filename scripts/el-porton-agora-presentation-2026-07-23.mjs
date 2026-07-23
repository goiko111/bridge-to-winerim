#!/usr/bin/env node

/**
 * Controlled El Porton de Sorni presentation normalizer.
 *
 * Default mode is strictly read-only. The production path delegates all
 * presentation planning and writes to agora-proxy action
 * normalize-winerim-product-presentation. It snapshots the exact previous
 * presentation config and rollback XML before the canary write. Operational
 * provider_config keys are preserved if another process updates them.
 */

import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CONNECTION_ID = "a3bc8cbe-baf0-4b4c-b460-1baafd8cdbc2";
const LOCATION_NAME = "El Porton de Sorni";
const PROFILE = "PORTON_DO_COUNTRY_V1";
const ACTION = "normalize-winerim-product-presentation";
const CONFIRM_VALUE = "NORMALIZE_WINERIM_PRESENTATION";
const RESTORE_CONFIRM_VALUE = "RESTORE_WINERIM_PRESENTATION";
const DEFAULT_ENV_FILE = path.resolve(".env");
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 520, 522, 523, 524]);

const TARGET_PRESENTATION = {
  agora_product_presentation_enabled: true,
  agora_product_sort_mode: "ALPHABETICAL_WINE_NAME",
  agora_product_button_text_mode: "WINE_NAME_WITH_FORMAT_SUFFIX",
  agora_product_color_by_wine_type: {
    tinto: "#800040",
    blanco: "#FFFFFF",
    rosado: "#DC82EF",
    espumoso: "#FF8080",
    dulce: "#F5A623",
    fortificado: "#F1C097",
  },
  family_structure_mode: "WINE_TYPE_SPAIN_DO_FOREIGN_COUNTRY",
};
const PRESENTATION_KEYS = Object.keys(TARGET_PRESENTATION);

const REQUIRED_FAMILY_MAPPINGS = [
  "botella_tinto",
  "botella_blanco",
  "botella_rosado",
  "botella_espumoso",
  "botella_dulce",
  "botella_fortificado",
  "copa",
  "magnum",
];

function parseArgs(argv) {
  const args = {
    apply: false,
    rollback: null,
    confirm: null,
    snapshotOutput: null,
    canaryProductId: null,
    envFile: process.env.LOVABLE_ENV_FILE || DEFAULT_ENV_FILE,
    includeXml: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--rollback") args.rollback = String(argv[++index] || "");
    else if (arg === "--snapshot-output") args.snapshotOutput = String(argv[++index] || "");
    else if (arg === "--canary-product-id") args.canaryProductId = String(argv[++index] || "");
    else if (arg === "--env-file") args.envFile = String(argv[++index] || "");
    else if (arg === "--include-xml") args.includeXml = true;
    else if (arg === "--confirm") args.confirm = String(argv[++index] || "");
    else if (arg.startsWith("--confirm=")) args.confirm = arg.slice("--confirm=".length);
    else if (arg === "--help") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.apply && args.rollback) throw new Error("Choose either --apply or --rollback");
  if ((args.apply || args.rollback) && args.confirm !== CONFIRM_VALUE) {
    throw new Error(`Production mode requires --confirm=${CONFIRM_VALUE}`);
  }
  if (args.apply && !args.snapshotOutput) {
    throw new Error("--apply requires --snapshot-output before any production change");
  }
  if (args.rollback && !args.rollback.trim()) throw new Error("--rollback requires a snapshot path");
  return args;
}

function usage() {
  return `Usage:
  node scripts/el-porton-agora-presentation-2026-07-23.mjs
  node scripts/el-porton-agora-presentation-2026-07-23.mjs --include-xml

  node scripts/el-porton-agora-presentation-2026-07-23.mjs \\
    --apply \\
    --confirm=${CONFIRM_VALUE} \\
    --snapshot-output /private/path/el-porton-presentation.json \\
    [--canary-product-id PRODUCT_ID]

  node scripts/el-porton-agora-presentation-2026-07-23.mjs \\
    --rollback /private/path/el-porton-presentation.json \\
    --confirm=${CONFIRM_VALUE}

Default mode never changes provider_config or Agora. Apply performs, in order:
exact config snapshot, target config, action dry-run, canary, full apply, fresh
verification and idempotence. Rollback restores exact XML and the snapshotted
presentation keys while preserving concurrent operational provider_config keys.`;
}

function parseDotEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function sha256(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function targetProviderConfig(previousConfig) {
  return {
    ...clone(previousConfig),
    ...TARGET_PRESENTATION,
    agora_product_color_by_wine_type: {
      ...(previousConfig?.agora_product_color_by_wine_type &&
        typeof previousConfig.agora_product_color_by_wine_type === "object"
        ? clone(previousConfig.agora_product_color_by_wine_type)
        : {}),
      ...TARGET_PRESENTATION.agora_product_color_by_wine_type,
    },
  };
}

function presentationSlice(config) {
  const source = config && typeof config === "object" ? config : {};
  return {
    agora_product_presentation_enabled: source.agora_product_presentation_enabled ?? null,
    agora_product_sort_mode: source.agora_product_sort_mode ?? null,
    agora_product_button_text_mode: source.agora_product_button_text_mode ?? null,
    agora_product_color_by_wine_type: source.agora_product_color_by_wine_type ?? null,
    family_structure_mode: source.family_structure_mode ?? null,
  };
}

function configWithPresentation(baseConfig, presentationConfig) {
  const merged = clone(baseConfig || {});
  for (const key of PRESENTATION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(presentationConfig || {}, key)) {
      merged[key] = clone(presentationConfig[key]);
    } else {
      delete merged[key];
    }
  }
  return merged;
}

function operationalConfigSlice(config) {
  const operational = clone(config || {});
  for (const key of PRESENTATION_KEYS) delete operational[key];
  return operational;
}

function presentationDiff(previous, target) {
  return Object.keys(TARGET_PRESENTATION).flatMap((key) => {
    const before = stableJson(previous?.[key] ?? null);
    const after = stableJson(target?.[key] ?? null);
    return before === after ? [] : [{ key, before: previous?.[key] ?? null, after: target?.[key] ?? null }];
  });
}

function assertXml(value, label) {
  const xml = String(value || "").trim();
  if (!xml.startsWith("<?xml") || !/<Import\b/.test(xml) || !/<\/Import>\s*$/.test(xml)) {
    throw new Error(`${label} is not a complete Agora Import XML document`);
  }
  return xml;
}

function assertFreshAudit(audit, qualifiedCount) {
  if (!audit || audit.success === false) throw new Error("Fresh audit did not return success");
  if (audit.missing !== 0 || audit.different !== 0 || audit.unownedExisting !== 0) {
    throw new Error(`Fresh audit is not exact: ${audit.matched}/${audit.expected}`);
  }
  if (qualifiedCount !== Number(audit.expected || 0)) {
    throw new Error(`Verified ownership is incomplete: ${qualifiedCount}/${audit.expected}`);
  }
}

function assertDryRun(result, expectedProducts, { requireXml = false } = {}) {
  if (!result || result.success !== true || result.dryRun !== true) {
    throw new Error("Presentation action did not return a successful dry-run");
  }
  if (Number(result.summary?.eligible || 0) !== expectedProducts) {
    throw new Error(`Presentation dry-run eligible=${result.summary?.eligible}; expected ${expectedProducts}`);
  }
  if (Array.isArray(result.summary?.skipped) && result.summary.skipped.length > 0) {
    throw new Error(`Presentation dry-run skipped ${result.summary.skipped.length} requested product(s)`);
  }
  if (requireXml) {
    assertXml(result.xml, "Plan XML");
    assertXml(result.rollbackXml, "Rollback XML");
  }
}

function assertWriteResult(result, label) {
  if (!result || result.success !== true || result.dryRun !== false) {
    throw new Error(`${label} did not return a successful production result`);
  }
  const verification = result.verification || {};
  if (verification.productsCatalogFetched !== true || verification.familiesCatalogFetched !== true) {
    throw new Error(`${label} could not fetch fresh catalogs for verification`);
  }
  if ((verification.productFailures || []).length > 0 || (verification.familyFailures || []).length > 0) {
    throw new Error(`${label} fresh verification contains failures`);
  }
}

function assertIdempotent(result, expectedProducts, label) {
  assertDryRun(result, expectedProducts);
  if (Number(result.summary?.changedProducts || 0) !== 0 || Number(result.summary?.changedFamilies || 0) !== 0) {
    throw new Error(`${label} is not idempotent: products=${result.summary?.changedProducts}, families=${result.summary?.changedFamilies}`);
  }
}

async function persistSnapshot(filePath, snapshot) {
  await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const fileEnv = parseDotEnv(await readFile(args.envFile, "utf8"));
  const env = { ...fileEnv, ...process.env };
  const backendUrl = String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || "").replace(/\/$/, "");
  const backendKey = env.SUPABASE_SERVICE_ROLE_KEY || env.LOVABLE_CLOUD_SERVICE_ROLE_KEY ||
    env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "";
  if (!backendUrl || !backendKey) throw new Error("Missing Lovable Cloud URL/key");

  const authHeaders = {
    apikey: backendKey,
    Authorization: `Bearer ${backendKey}`,
    "Content-Type": "application/json",
  };

  async function request(url, options = {}, attempts = 4) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 180_000);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        const responseText = await response.text();
        let data = null;
        if (responseText) {
          try { data = JSON.parse(responseText); } catch { data = responseText; }
        }
        if (response.ok) return { response, data };
        const message = typeof data === "string" ? data.slice(0, 800) : JSON.stringify(data).slice(0, 800);
        if (!RETRYABLE_STATUS.has(response.status) || attempt === attempts) {
          throw new Error(`HTTP ${response.status}: ${message}`);
        }
        lastError = new Error(`HTTP ${response.status}: ${message}`);
      } catch (error) {
        lastError = error;
        if (attempt === attempts) throw error;
      } finally {
        clearTimeout(timeout);
      }
      await sleep(Math.min(15_000, 1_000 * (2 ** (attempt - 1))));
    }
    throw lastError || new Error("Request failed");
  }

  async function restAll(resource, pageSize = 1000) {
    const rows = [];
    for (let offset = 0; ; offset += pageSize) {
      const { data } = await request(`${backendUrl}/rest/v1/${resource}`, {
        headers: { ...authHeaders, Range: `${offset}-${offset + pageSize - 1}` },
        timeoutMs: 60_000,
      });
      if (!Array.isArray(data)) throw new Error(`Expected an array from ${resource}`);
      rows.push(...data);
      if (data.length < pageSize) return rows;
    }
  }

  async function invoke(action, body) {
    const { data } = await request(`${backendUrl}/functions/v1/agora-proxy`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ action, ...body }),
      timeoutMs: 240_000,
    });
    if (!data || data.success === false) {
      throw new Error(`${action}: ${data?.error || data?.reason || JSON.stringify(data).slice(0, 800)}`);
    }
    return data;
  }

  async function invokeAllowFailure(action, body) {
    const { data } = await request(`${backendUrl}/functions/v1/agora-proxy`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ action, ...body }),
      timeoutMs: 240_000,
    });
    if (!data || typeof data !== "object") {
      throw new Error(`${action}: invalid response`);
    }
    return data;
  }

  async function readConnection() {
    const rows = await restAll(`pos_connections?id=eq.${CONNECTION_ID}&select=*`);
    const connection = rows[0];
    if (!connection) throw new Error("El Porton connection was not found");
    if (String(connection.id) !== CONNECTION_ID || normalize(connection.location_name) !== normalize(LOCATION_NAME)) {
      throw new Error("Connection identity mismatch");
    }
    return connection;
  }

  async function activeQueue() {
    return restAll(`outbound_tasks?connection_id=eq.${CONNECTION_ID}&status=in.(QUEUED,RUNNING)&select=id,task_type,status,created_at`);
  }

  async function assertNoActiveQueue(label) {
    const tasks = await activeQueue();
    if (tasks.length > 0) throw new Error(`${label}: ${tasks.length} active outbound task(s)`);
    return tasks;
  }

  async function patchProviderConfig(providerConfig) {
    const { data } = await request(`${backendUrl}/rest/v1/pos_connections?id=eq.${CONNECTION_ID}`, {
      method: "PATCH",
      headers: { ...authHeaders, Prefer: "return=representation" },
      body: JSON.stringify({ provider_config: providerConfig }),
      timeoutMs: 60_000,
    });
    const updated = Array.isArray(data) ? data[0] : null;
    if (!updated) throw new Error("provider_config PATCH returned no connection row");
    return updated;
  }

  async function readPreflight() {
    const [connection, queue, mappings, trackingRows, audit] = await Promise.all([
      readConnection(),
      activeQueue(),
      restAll(`wine_type_family_mappings?connection_id=eq.${CONNECTION_ID}&select=mapping_key,agora_family_id,agora_family_name`),
      restAll(`winerim_push_tracking?connection_id=eq.${CONNECTION_ID}&source=eq.WINERIM&sync_status=eq.VERIFIED&select=winerim_wine_id,format,agora_product_id,sync_status,source`),
      invoke("audit-winerim-products", { connectionId: CONNECTION_ID }),
    ]);

    if (connection.enabled !== true || connection.write_mode !== "XML_IMPORT") {
      throw new Error(`Connection is not active XML_IMPORT: enabled=${connection.enabled}, write_mode=${connection.write_mode}`);
    }
    if (connection.circuit_breaker_paused_until && new Date(connection.circuit_breaker_paused_until) > new Date()) {
      throw new Error(`Circuit breaker open until ${connection.circuit_breaker_paused_until}`);
    }
    if (queue.length > 0) throw new Error(`Preflight found ${queue.length} active outbound task(s)`);

    const mappingKeys = new Set(mappings.map((row) => String(row.mapping_key || "")));
    const missingMappings = REQUIRED_FAMILY_MAPPINGS.filter((key) => !mappingKeys.has(key));
    if (missingMappings.length > 0) throw new Error(`Missing family mappings: ${missingMappings.join(", ")}`);

    const verifiedProofs = new Set(trackingRows.map((row) =>
      `${row.agora_product_id}:${row.winerim_wine_id}:${String(row.format || "").toUpperCase()}`
    ));
    const qualified = (audit.details || []).filter((item) =>
      item.status === "MATCH" && item.ownedByWinerim === true &&
      verifiedProofs.has(`${item.productId}:${item.expectedWinerimWineId}:${String(item.expectedFormat || "").toUpperCase()}`)
    );
    const productIds = [...new Set(qualified.map((item) => String(item.productId)))].sort((a, b) => Number(a) - Number(b));
    assertFreshAudit(audit, productIds.length);

    return { connection, queue, mappings, trackingRows, audit, qualified, productIds };
  }

  async function restoreFromSnapshot(snapshot, { requireTargetConfig = true } = {}) {
    const current = await readConnection();
    const currentConfig = clone(current.provider_config || {});
    const currentPresentationHash = sha256(stableJson(presentationSlice(currentConfig)));
    const targetPresentationHash = sha256(stableJson(presentationSlice(snapshot.targetProviderConfig)));
    const previousPresentationHash = sha256(stableJson(presentationSlice(snapshot.previousProviderConfig)));
    if (requireTargetConfig && ![targetPresentationHash, previousPresentationHash].includes(currentPresentationHash)) {
      throw new Error("Rollback refused: live presentation config differs from both snapshotted states");
    }
    await assertNoActiveQueue("Rollback refused");
    let xmlResult = null;
    let familyOrderOnlyRestore = false;
    if (snapshot.rollbackXml) {
      xmlResult = await invokeAllowFailure("restore-winerim-product-presentation", {
        connectionId: CONNECTION_ID,
        rollbackXml: assertXml(snapshot.rollbackXml, "Rollback XML"),
        confirm: RESTORE_CONFIRM_VALUE,
      });
      const productFailures = Array.isArray(xmlResult?.verification?.productFailures)
        ? xmlResult.verification.productFailures
        : [];
      const familyFailures = Array.isArray(xmlResult?.verification?.familyFailures)
        ? xmlResult.verification.familyFailures
        : [];
      familyOrderOnlyRestore = xmlResult?.success !== true &&
        productFailures.length === 0 &&
        familyFailures.length > 0 &&
        familyFailures.every((failure) =>
          Array.isArray(failure?.differences) &&
          failure.differences.length === 1 &&
          failure.differences[0] === "Order"
        );
      if (xmlResult?.success !== true && !familyOrderOnlyRestore) {
        throw new Error(`Rollback XML could not be verified: ${JSON.stringify(xmlResult)}`);
      }
    }
    const configAlreadyRestored = currentPresentationHash === previousPresentationHash;
    if (!configAlreadyRestored) {
      const operationalBefore = operationalConfigSlice(currentConfig);
      const rollbackConfig = configWithPresentation(currentConfig, snapshot.previousProviderConfig);
      const restored = await patchProviderConfig(rollbackConfig);
      if (sha256(stableJson(presentationSlice(restored.provider_config || {}))) !== previousPresentationHash) {
        throw new Error("Exact presentation config restoration could not be verified");
      }
      if (stableJson(operationalConfigSlice(restored.provider_config || {})) !== stableJson(operationalBefore)) {
        throw new Error("Rollback changed concurrent operational provider_config keys");
      }
    }
    const audit = await invoke("audit-winerim-products", { connectionId: CONNECTION_ID });
    assertFreshAudit(audit, Array.isArray(snapshot.verifiedProductIds) ? snapshot.verifiedProductIds.length : Number(audit.expected || 0));
    return {
      success: true,
      configRestored: true,
      configAlreadyRestored,
      xmlRestored: Boolean(snapshot.rollbackXml),
      familyOrderOnlyRestore,
      xmlResult,
      audit: {
        expected: audit.expected,
        matched: audit.matched,
        missing: audit.missing,
        different: audit.different,
        unownedExisting: audit.unownedExisting,
      },
    };
  }

  if (args.rollback) {
    const snapshot = JSON.parse(await readFile(args.rollback, "utf8"));
    if (snapshot.schemaVersion !== 2 || snapshot.connectionId !== CONNECTION_ID || snapshot.profile !== PROFILE) {
      throw new Error("Snapshot does not belong to this connection/profile/version");
    }
    if (sha256(stableJson(snapshot.previousProviderConfig)) !== snapshot.hashes?.previousProviderConfig ||
        sha256(stableJson(snapshot.targetProviderConfig)) !== snapshot.hashes?.targetProviderConfig ||
        sha256(snapshot.rollbackXml || "") !== snapshot.hashes?.rollbackXml) {
      throw new Error("Snapshot integrity check failed");
    }
    const rollback = await restoreFromSnapshot(snapshot);
    snapshot.state = "ROLLED_BACK";
    snapshot.rolledBackAt = new Date().toISOString();
    snapshot.rollbackResult = rollback;
    await persistSnapshot(args.rollback, snapshot);
    console.log(JSON.stringify({
      mode: "ROLLBACK",
      connectionId: CONNECTION_ID,
      state: snapshot.state,
      rollback,
    }, null, 2));
    return;
  }

  const preflight = await readPreflight();
  const previousProviderConfig = clone(preflight.connection.provider_config || {});
  const targetConfig = targetProviderConfig(previousProviderConfig);
  const configReady = stableJson(previousProviderConfig) === stableJson(targetConfig);

  if (!args.apply) {
    let actionDryRun = {
      status: "PENDING_TARGET_CONFIG",
      reason: "The shared action reads live provider_config; no temporary production config write is permitted in read-only mode.",
    };
    if (configReady) {
      const result = await invoke(ACTION, {
        connectionId: CONNECTION_ID,
        productIds: preflight.productIds,
        dryRun: true,
        includeXml: true,
      });
      assertDryRun(result, preflight.productIds.length, { requireXml: true });
      actionDryRun = {
        status: "READY",
        summary: result.summary,
        families: result.families,
        xmlHash: sha256(result.xml),
        rollbackXmlHash: sha256(result.rollbackXml),
        ...(args.includeXml ? { xml: result.xml, rollbackXml: result.rollbackXml } : {}),
      };
    }

    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      mode: "READ_ONLY",
      profile: PROFILE,
      connectionId: CONNECTION_ID,
      locationName: preflight.connection.location_name,
      preflight: {
        activeQueue: preflight.queue.length,
        breakerPausedUntil: preflight.connection.circuit_breaker_paused_until,
        freshAudit: {
          expected: preflight.audit.expected,
          matched: preflight.audit.matched,
          missing: preflight.audit.missing,
          different: preflight.audit.different,
          unownedExisting: preflight.audit.unownedExisting,
        },
        verifiedProducts: preflight.productIds.length,
        requiredFamilyMappings: REQUIRED_FAMILY_MAPPINGS.length,
      },
      providerConfig: {
        ready: configReady,
        current: presentationSlice(previousProviderConfig),
        target: presentationSlice(targetConfig),
        changes: presentationDiff(previousProviderConfig, targetConfig),
      },
      actionDryRun,
      productionWrites: 0,
    }, null, 2));
    return;
  }

  const snapshotPath = path.resolve(args.snapshotOutput);
  const snapshot = {
    schemaVersion: 2,
    profile: PROFILE,
    connectionId: CONNECTION_ID,
    locationName: preflight.connection.location_name,
    generatedAt: new Date().toISOString(),
    state: "SNAPSHOT_CREATED",
    previousProviderConfig,
    targetProviderConfig: targetConfig,
    verifiedProductIds: preflight.productIds,
    preflight: {
      activeQueue: preflight.queue.length,
      audit: {
        expected: preflight.audit.expected,
        matched: preflight.audit.matched,
        missing: preflight.audit.missing,
        different: preflight.audit.different,
        unownedExisting: preflight.audit.unownedExisting,
      },
      mappings: preflight.mappings,
    },
    rollbackXml: null,
    hashes: {
      previousProviderConfig: sha256(stableJson(previousProviderConfig)),
      targetProviderConfig: sha256(stableJson(targetConfig)),
      rollbackXml: sha256(""),
    },
  };
  await persistSnapshot(snapshotPath, snapshot);

  let configWasStaged = false;
  try {
    const latestBeforeStage = await readConnection();
    const latestPresentationHash = sha256(stableJson(presentationSlice(latestBeforeStage.provider_config || {})));
    const previousPresentationHash = sha256(stableJson(presentationSlice(previousProviderConfig)));
    const targetPresentationHash = sha256(stableJson(presentationSlice(targetConfig)));
    if (![previousPresentationHash, targetPresentationHash].includes(latestPresentationHash)) {
      throw new Error("Presentation config changed concurrently before staging");
    }
    const targetConfigForStage = targetProviderConfig(latestBeforeStage.provider_config || {});
    snapshot.targetProviderConfig = targetConfigForStage;
    snapshot.hashes.targetProviderConfig = sha256(stableJson(targetConfigForStage));
    await persistSnapshot(snapshotPath, snapshot);
    const staged = await patchProviderConfig(targetConfigForStage);
    configWasStaged = true;
    if (sha256(stableJson(staged.provider_config || {})) !== snapshot.hashes.targetProviderConfig) {
      throw new Error("Target provider_config could not be verified exactly");
    }
    snapshot.state = "TARGET_CONFIG_STAGED";
    snapshot.targetConfigStagedAt = new Date().toISOString();
    await persistSnapshot(snapshotPath, snapshot);

    await assertNoActiveQueue("Before presentation dry-run");
    const fullDryRun = await invoke(ACTION, {
      connectionId: CONNECTION_ID,
      productIds: preflight.productIds,
      dryRun: true,
      includeXml: true,
    });
    assertDryRun(fullDryRun, preflight.productIds.length, { requireXml: true });
    snapshot.rollbackXml = fullDryRun.rollbackXml;
    snapshot.planXml = fullDryRun.xml;
    snapshot.hashes.rollbackXml = sha256(fullDryRun.rollbackXml);
    snapshot.hashes.planXml = sha256(fullDryRun.xml);
    snapshot.dryRun = { summary: fullDryRun.summary, families: fullDryRun.families };
    snapshot.state = "DRY_RUN_VERIFIED";
    await persistSnapshot(snapshotPath, snapshot);

    if (Number(fullDryRun.summary.changedProducts || 0) === 0 && Number(fullDryRun.summary.changedFamilies || 0) === 0) {
      const finalAudit = await invoke("audit-winerim-products", { connectionId: CONNECTION_ID });
      assertFreshAudit(finalAudit, preflight.productIds.length);
      snapshot.state = "COMPLETE_ALREADY_IDEMPOTENT";
      snapshot.completedAt = new Date().toISOString();
      snapshot.finalAudit = finalAudit;
      await persistSnapshot(snapshotPath, snapshot);
      console.log(JSON.stringify({
        mode: "APPLY",
        connectionId: CONNECTION_ID,
        state: snapshot.state,
        changedProducts: 0,
        changedFamilies: 0,
        snapshotOutput: snapshotPath,
      }, null, 2));
      return;
    }

    const changedPreview = Array.isArray(fullDryRun.preview) ? fullDryRun.preview : [];
    const requestedCanary = args.canaryProductId?.trim();
    if (requestedCanary && !preflight.productIds.includes(requestedCanary)) {
      throw new Error(`Requested canary ${requestedCanary} is not in the verified product set`);
    }
    const fallbackCanaryProductId = String(
      preflight.qualified.find((item) => String(item.expectedFormat || "").toUpperCase() === "BOTTLE")?.productId ||
      preflight.productIds[0] ||
      "",
    );
    let canary = requestedCanary
      ? { productId: requestedCanary }
      : changedPreview.find((item) => item.format === "BOTTLE") || changedPreview[0] ||
        (fallbackCanaryProductId ? { productId: fallbackCanaryProductId } : null);
    if (!canary) {
      throw new Error("No changed verified product is available for the canary");
    }
    if (!preflight.productIds.includes(String(canary.productId))) {
      throw new Error(`Canary ${canary.productId} is not in the verified product set`);
    }

    const canaryDryRun = await invoke(ACTION, {
      connectionId: CONNECTION_ID,
      productIds: [String(canary.productId)],
      dryRun: true,
      includeXml: true,
    });
    assertDryRun(canaryDryRun, 1, { requireXml: true });
    if (Number(canaryDryRun.summary.changedProducts || 0) === 0 && Number(canaryDryRun.summary.changedFamilies || 0) === 0) {
      throw new Error(`Canary ${canary.productId} has no presentation change to validate`);
    }
    canary = canaryDryRun.preview?.[0] || canary;

    await assertNoActiveQueue("Before canary write");
    const canaryResult = await invoke(ACTION, {
      connectionId: CONNECTION_ID,
      productIds: [String(canary.productId)],
      dryRun: false,
      confirm: CONFIRM_VALUE,
    });
    assertWriteResult(canaryResult, "Canary");
    const canaryIdempotence = await invoke(ACTION, {
      connectionId: CONNECTION_ID,
      productIds: [String(canary.productId)],
      dryRun: true,
    });
    assertIdempotent(canaryIdempotence, 1, "Canary");
    snapshot.canary = {
      productId: String(canary.productId),
      wineId: canary.wineId,
      format: canary.format,
      summary: canaryResult.summary,
      verifiedAt: new Date().toISOString(),
    };
    snapshot.state = "CANARY_VERIFIED";
    await persistSnapshot(snapshotPath, snapshot);

    await assertNoActiveQueue("Before full presentation write");
    const applyResult = await invoke(ACTION, {
      connectionId: CONNECTION_ID,
      productIds: preflight.productIds,
      dryRun: false,
      confirm: CONFIRM_VALUE,
    });
    assertWriteResult(applyResult, "Full presentation apply");

    const [finalAudit, idempotence, finalQueue, finalConnection] = await Promise.all([
      invoke("audit-winerim-products", { connectionId: CONNECTION_ID }),
      invoke(ACTION, {
        connectionId: CONNECTION_ID,
        productIds: preflight.productIds,
        dryRun: true,
      }),
      activeQueue(),
      readConnection(),
    ]);
    assertFreshAudit(finalAudit, preflight.productIds.length);
    assertIdempotent(idempotence, preflight.productIds.length, "Full presentation");
    if (finalQueue.length > 0) throw new Error(`Final verification found ${finalQueue.length} active task(s)`);
    if (stableJson(presentationSlice(finalConnection.provider_config || {})) !==
        stableJson(presentationSlice(snapshot.targetProviderConfig))) {
      throw new Error("Target presentation config drifted during the operation");
    }

    snapshot.apply = { summary: applyResult.summary, verification: applyResult.verification };
    snapshot.final = {
      audit: {
        expected: finalAudit.expected,
        matched: finalAudit.matched,
        missing: finalAudit.missing,
        different: finalAudit.different,
        unownedExisting: finalAudit.unownedExisting,
      },
      idempotence: idempotence.summary,
      activeQueue: finalQueue.length,
    };
    snapshot.state = "COMPLETE";
    snapshot.completedAt = new Date().toISOString();
    await persistSnapshot(snapshotPath, snapshot);

    console.log(JSON.stringify({
      mode: "APPLY",
      connectionId: CONNECTION_ID,
      state: snapshot.state,
      dryRun: snapshot.dryRun.summary,
      canary: snapshot.canary,
      apply: snapshot.apply,
      final: snapshot.final,
      snapshotOutput: snapshotPath,
      ...(args.includeXml ? { planXml: snapshot.planXml, rollbackXml: snapshot.rollbackXml } : {}),
    }, null, 2));
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    let automaticRollback = null;
    try {
      if (configWasStaged) {
        automaticRollback = await restoreFromSnapshot(snapshot);
      }
    } catch (rollbackError) {
      automaticRollback = {
        success: false,
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      };
    }
    snapshot.state = automaticRollback?.success === false ? "FAILED_ROLLBACK_REQUIRED" : "ROLLED_BACK_AFTER_FAILURE";
    snapshot.failedAt = new Date().toISOString();
    snapshot.failure = failure;
    snapshot.automaticRollback = automaticRollback;
    await persistSnapshot(snapshotPath, snapshot);
    throw new Error(`${failure}. Automatic rollback: ${JSON.stringify(automaticRollback)}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
