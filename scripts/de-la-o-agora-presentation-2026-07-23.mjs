#!/usr/bin/env node

/**
 * Controlled presentation normalizer for De la O.
 *
 * Read-only by default. Production modes require an explicit confirmation and
 * a private artifact file containing the exact provider_config and XML needed
 * for rollback before the first write is attempted.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

const CONNECTION_ID = "99f3a782-844f-4515-a570-662a111ced2e";
const EXCLUDED_PRODUCT_IDS = new Set(["680888"]);
const NORMALIZE_CONFIRM = "NORMALIZE_WINERIM_PRESENTATION";
const CONFIGURE_CONFIRM = "CONFIGURE_DE_LA_O_PRESENTATION";
const ROLLBACK_CONFIG_CONFIRM = "ROLLBACK_DE_LA_O_PRESENTATION_CONFIG";
const DEFAULT_ENV_FILE = new URL("../.env", import.meta.url).pathname;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 520, 522, 523, 524]);

const TARGET_PRESENTATION_CONFIG = {
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
};

const MODES = new Set([
  "snapshot",
  "configure",
  "dry-run",
  "canary",
  "apply",
  "verify",
  "rollback-config",
]);

function parseArgs(argv) {
  const args = {
    mode: "snapshot",
    confirm: "",
    productId: "",
    artifactFile: "",
    includeXml: false,
    allChanges: false,
    envFile: process.env.LOVABLE_ENV_FILE || DEFAULT_ENV_FILE,
  };
  const readValue = (arg, index) => {
    const equalsAt = arg.indexOf("=");
    if (equalsAt >= 0) return { value: arg.slice(equalsAt + 1), index };
    return { value: String(argv[index + 1] || ""), index: index + 1 };
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--include-xml") args.includeXml = true;
    else if (arg === "--all-changes") args.allChanges = true;
    else if (arg === "--help") args.help = true;
    else if (arg === "--mode" || arg.startsWith("--mode=")) {
      const parsed = readValue(arg, index);
      args.mode = parsed.value;
      index = parsed.index;
    } else if (arg === "--confirm" || arg.startsWith("--confirm=")) {
      const parsed = readValue(arg, index);
      args.confirm = parsed.value;
      index = parsed.index;
    } else if (arg === "--product-id" || arg.startsWith("--product-id=")) {
      const parsed = readValue(arg, index);
      args.productId = parsed.value;
      index = parsed.index;
    } else if (arg === "--artifact-file" || arg.startsWith("--artifact-file=")) {
      const parsed = readValue(arg, index);
      args.artifactFile = parsed.value;
      index = parsed.index;
    } else if (arg === "--env-file" || arg.startsWith("--env-file=")) {
      const parsed = readValue(arg, index);
      args.envFile = parsed.value;
      index = parsed.index;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!MODES.has(args.mode)) throw new Error(`Unsupported mode: ${args.mode}`);
  return args;
}

function usage() {
  return `Usage:
  # Read-only exact snapshot; also runs the action dry-run when config is ready
  node scripts/de-la-o-agora-presentation-2026-07-23.mjs

  # Future authorized operations
  node scripts/de-la-o-agora-presentation-2026-07-23.mjs --mode configure \\
    --confirm=${CONFIGURE_CONFIRM} --artifact-file /secure/de-la-o-config.json
  node scripts/de-la-o-agora-presentation-2026-07-23.mjs --mode dry-run
  node scripts/de-la-o-agora-presentation-2026-07-23.mjs --mode canary \\
    --product-id PRODUCT_ID --confirm=${NORMALIZE_CONFIRM} \\
    --artifact-file /secure/de-la-o-canary.json
  node scripts/de-la-o-agora-presentation-2026-07-23.mjs --mode apply \\
    --product-id CANARY_PRODUCT_ID --confirm=${NORMALIZE_CONFIRM} \\
    --artifact-file /secure/de-la-o-apply.json
  node scripts/de-la-o-agora-presentation-2026-07-23.mjs --mode verify
  node scripts/de-la-o-agora-presentation-2026-07-23.mjs --mode rollback-config \\
    --confirm=${ROLLBACK_CONFIG_CONFIRM} --artifact-file /secure/de-la-o-apply.json

The artifact path must be absolute and must not already exist for configure,
canary or apply. It contains sensitive provider_config and exact rollback XML;
the script creates it with mode 0600. XML rollback is captured but is never
posted directly to Agora by this local script.`;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function targetProviderConfig(previous) {
  return {
    ...clone(previous),
    ...clone(TARGET_PRESENTATION_CONFIG),
    agora_product_color_by_wine_type: clone(TARGET_PRESENTATION_CONFIG.agora_product_color_by_wine_type),
  };
}

function presentationConfigMatches(config) {
  const current = config && typeof config === "object" ? config : {};
  if (current.agora_product_presentation_enabled !== true) return false;
  if (String(current.agora_product_sort_mode || "").toUpperCase() !== TARGET_PRESENTATION_CONFIG.agora_product_sort_mode) return false;
  if (String(current.agora_product_button_text_mode || "").toUpperCase() !== TARGET_PRESENTATION_CONFIG.agora_product_button_text_mode) return false;
  const colors = current.agora_product_color_by_wine_type;
  if (!colors || typeof colors !== "object") return false;
  return Object.entries(TARGET_PRESENTATION_CONFIG.agora_product_color_by_wine_type).every(
    ([type, color]) => String(colors[type] || "").toUpperCase() === color,
  );
}

function presentationConfigSummary(config) {
  const current = config && typeof config === "object" ? config : {};
  return {
    agora_product_presentation_enabled: current.agora_product_presentation_enabled ?? null,
    agora_product_sort_mode: current.agora_product_sort_mode ?? null,
    agora_product_button_text_mode: current.agora_product_button_text_mode ?? null,
    agora_product_color_by_wine_type: current.agora_product_color_by_wine_type ?? null,
  };
}

function validateXml(xml, label) {
  if (!xml) throw new Error(`${label} XML was not returned`);
  const result = spawnSync("/usr/bin/xmllint", ["--noout", "-"], {
    input: String(xml),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Invalid ${label} XML: ${String(result.stderr || "").trim()}`);
}

function actionSummary(result, includeXml = false, allChanges = false) {
  const xml = result?.xml || "";
  const rollbackXml = result?.rollbackXml || "";
  return {
    dryRun: result?.dryRun,
    summary: result?.summary || null,
    families: result?.families || [],
    preview: allChanges ? (result?.preview || []) : (result?.preview || []).slice(0, 25),
    hashes: {
      proposedXmlSha256: xml ? sha256(xml) : null,
      rollbackXmlSha256: rollbackXml ? sha256(rollbackXml) : null,
    },
    xml: includeXml ? xml || null : undefined,
    rollbackXml: includeXml ? rollbackXml || null : undefined,
  };
}

function assertExactCatalog(context) {
  const audit = context.audit;
  const exact = Number(audit.expected || 0) === Number(audit.matched || 0) &&
    Number(audit.missing || 0) === 0 &&
    Number(audit.different || 0) === 0 &&
    Number(audit.unownedExisting || 0) === 0 &&
    context.auditIssues.length === 0;
  if (!exact) {
    throw new Error(
      `Fresh catalog gate failed: expected=${audit.expected}, matched=${audit.matched}, ` +
      `missing=${audit.missing}, different=${audit.different}, unowned=${audit.unownedExisting}, issues=${context.auditIssues.length}`,
    );
  }
  if (context.strictVerifiedCount !== Number(audit.expected || 0)) {
    throw new Error(`Strict VERIFIED gate covers ${context.strictVerifiedCount}/${audit.expected} expected products`);
  }
}

function assertStableWriteGates(context) {
  assertExactCatalog(context);
  if (context.queueRows.length > 0) throw new Error(`Active queue is not empty: ${context.queueRows.length}`);
  if (context.allowedProductIds.length === 0) throw new Error("No strictly verified product remains in the allowlist");
}

function assertTargetConfig(context) {
  if (!context.configMatchesTarget) {
    throw new Error("Target provider_config is not active. Run the separately authorized configure mode first.");
  }
}

function requireArtifactPath(args) {
  if (!args.artifactFile || !isAbsolute(args.artifactFile)) {
    throw new Error("A new absolute --artifact-file path is required before any production write");
  }
}

async function createArtifact(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

async function updateArtifact(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "w", mode: 0o600 });
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
  if (!backendUrl || !backendKey) throw new Error("Lovable Cloud URL/key not found");

  const authHeaders = {
    apikey: backendKey,
    Authorization: `Bearer ${backendKey}`,
    "Content-Type": "application/json",
  };

  const request = async (url, options = {}, attempts = 4) => {
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
        const detail = typeof data === "string" ? data.slice(0, 800) : JSON.stringify(data).slice(0, 800);
        if (!RETRYABLE_STATUS.has(response.status) || attempt === attempts) {
          throw new Error(`HTTP ${response.status}: ${detail}`);
        }
        lastError = new Error(`HTTP ${response.status}: ${detail}`);
      } catch (error) {
        lastError = error;
        if (attempt === attempts) throw error;
      } finally {
        clearTimeout(timeout);
      }
      await sleep(Math.min(15_000, 1_000 * (2 ** (attempt - 1))));
    }
    throw lastError || new Error("Request failed");
  };

  const restAll = async (resource, pageSize = 1000) => {
    const rows = [];
    for (let offset = 0; ; offset += pageSize) {
      const { data } = await request(`${backendUrl}/rest/v1/${resource}`, {
        method: "GET",
        headers: { ...authHeaders, Range: `${offset}-${offset + pageSize - 1}` },
        timeoutMs: 60_000,
      });
      if (!Array.isArray(data)) throw new Error(`Expected an array from ${resource}`);
      rows.push(...data);
      if (data.length < pageSize) break;
    }
    return rows;
  };

  const invoke = async (action, body, attempts = 4) => {
    const { data } = await request(`${backendUrl}/functions/v1/agora-proxy`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ action, ...body }),
      timeoutMs: 300_000,
    }, attempts);
    if (!data || typeof data !== "object") throw new Error(`${action}: invalid response`);
    return data;
  };

  const requireActionSuccess = (action, result) => {
    if (result.success === false) {
      throw new Error(`${action}: ${result.error || result.reason || JSON.stringify(result).slice(0, 800)}`);
    }
    return result;
  };

  const patchProviderConfig = async (providerConfig) => {
    const { data } = await request(
      `${backendUrl}/rest/v1/pos_connections?id=eq.${CONNECTION_ID}&select=id,location_name,provider_config`,
      {
        method: "PATCH",
        headers: { ...authHeaders, Prefer: "return=representation" },
        body: JSON.stringify({ provider_config: providerConfig }),
        timeoutMs: 60_000,
      },
      1,
    );
    if (!Array.isArray(data) || data.length !== 1) throw new Error("provider_config PATCH did not return exactly one row");
    return data[0];
  };

  const loadContext = async () => {
    const [connectionRows, queueRows, trackingRows] = await Promise.all([
      restAll(`pos_connections?id=eq.${CONNECTION_ID}&select=id,location_name,enabled,write_mode,provider_config`),
      restAll(`outbound_tasks?connection_id=eq.${CONNECTION_ID}&status=in.(QUEUED,RUNNING)&select=id,task_type,status,created_at`),
      restAll(`winerim_push_tracking?connection_id=eq.${CONNECTION_ID}&source=eq.WINERIM&sync_status=eq.VERIFIED&select=agora_product_id,winerim_wine_id,format,source,sync_status`),
    ]);
    const connection = connectionRows[0];
    if (!connection || normalize(connection.location_name) !== "de la o") {
      throw new Error(`Connection scope mismatch for ${CONNECTION_ID}`);
    }

    const audit = requireActionSuccess(
      "audit-winerim-products",
      await invoke("audit-winerim-products", { connectionId: CONNECTION_ID }),
    );
    const auditIssues = (audit.details || []).filter((item) => item.status !== "MATCH" || !item.ownedByWinerim);
    const verifiedKeys = new Set(trackingRows.map((row) =>
      `${row.agora_product_id}:${row.winerim_wine_id}:${String(row.format || "").toUpperCase()}`
    ));
    const strictVerified = (audit.details || []).filter((item) => verifiedKeys.has(
      `${item.productId}:${item.expectedWinerimWineId}:${String(item.expectedFormat || "").toUpperCase()}`
    ));
    const explicitlyExcluded = strictVerified.filter((item) => EXCLUDED_PRODUCT_IDS.has(String(item.productId)));
    const allowedDetails = strictVerified.filter((item) => !EXCLUDED_PRODUCT_IDS.has(String(item.productId)));
    const priorProviderConfig = clone(connection.provider_config || {});

    return {
      connection,
      queueRows,
      trackingRows,
      audit,
      auditIssues,
      strictVerifiedCount: strictVerified.length,
      explicitlyExcluded,
      allowedDetails,
      allowedProductIds: allowedDetails.map((item) => String(item.productId)).sort((a, b) => Number(a) - Number(b)),
      priorProviderConfig,
      targetProviderConfig: targetProviderConfig(priorProviderConfig),
      configMatchesTarget: presentationConfigMatches(priorProviderConfig),
    };
  };

  const runNormalizerDryRun = async (context, productIds) => {
    assertStableWriteGates(context);
    assertTargetConfig(context);
    const result = requireActionSuccess(
      "normalize-winerim-product-presentation",
      await invoke("normalize-winerim-product-presentation", {
        connectionId: CONNECTION_ID,
        dryRun: true,
        includeXml: true,
        productIds,
      }),
    );
    validateXml(result.xml, "proposed");
    validateXml(result.rollbackXml, "rollback");
    return result;
  };

  const baseReport = (context) => ({
    generatedAt: new Date().toISOString(),
    mode: args.mode,
    connection: {
      id: context.connection.id,
      locationName: context.connection.location_name,
      enabled: context.connection.enabled,
      writeMode: context.connection.write_mode,
    },
    gates: {
      activeQueue: context.queueRows.length,
      freshExpected: context.audit.expected,
      freshMatched: context.audit.matched,
      freshMissing: context.audit.missing,
      freshDifferent: context.audit.different,
      freshUnownedExisting: context.audit.unownedExisting,
      auditIssues: context.auditIssues.length,
      strictlyVerifiedProducts: context.strictVerifiedCount,
      allowedProductIds: context.allowedProductIds.length,
    },
    explicitExclusion: {
      productIds: [...EXCLUDED_PRODUCT_IDS],
      presentInStrictVerifiedSet: context.explicitlyExcluded.map((item) => String(item.productId)),
      reason: "Product 680888 is not owned for this operation and must remain untouched.",
    },
    providerConfig: {
      beforeSha256: sha256(stableJson(context.priorProviderConfig)),
      targetSha256: sha256(stableJson(context.targetProviderConfig)),
      matchesTarget: context.configMatchesTarget,
      currentPresentation: presentationConfigSummary(context.priorProviderConfig),
      targetPresentation: clone(TARGET_PRESENTATION_CONFIG),
    },
    relativeOrder: {
      rule: "Winerim-owned products are alphabetical among the allowlist and start after the highest legacy order in each shared family.",
      legacyTouched: false,
      canaryOrderIsTemporary: true,
    },
  });

  if (args.mode === "rollback-config") {
    if (!args.artifactFile || !isAbsolute(args.artifactFile)) throw new Error("rollback-config requires an absolute --artifact-file");
    if (args.confirm !== ROLLBACK_CONFIG_CONFIRM) {
      throw new Error(`rollback-config requires --confirm=${ROLLBACK_CONFIG_CONFIRM}`);
    }
    const artifact = JSON.parse(await readFile(args.artifactFile, "utf8"));
    if (artifact.connectionId !== CONNECTION_ID) throw new Error("Rollback artifact belongs to another connection");
    const rollbackConfig = artifact.providerConfigRollback || artifact.providerConfigBefore;
    if (!rollbackConfig || typeof rollbackConfig !== "object") throw new Error("Rollback artifact has no provider_config snapshot");
    const connectionRows = await restAll(
      `pos_connections?id=eq.${CONNECTION_ID}&select=id,location_name,provider_config`,
    );
    const connection = connectionRows[0];
    if (!connection || normalize(connection.location_name) !== "de la o") {
      throw new Error(`Connection scope mismatch for ${CONNECTION_ID}`);
    }
    const rollbackXml = artifact.applyResponse?.rollbackXml ||
      artifact.preflight?.rollbackXml || artifact.dryRun?.rollbackXml;
    validateXml(rollbackXml, "rollback");
    const xmlRestore = await invoke("restore-winerim-product-presentation", {
      connectionId: CONNECTION_ID,
      rollbackXml,
      confirm: "RESTORE_WINERIM_PRESENTATION",
    });
    const updated = await patchProviderConfig(rollbackConfig);
    const restored = stableJson(updated.provider_config) === stableJson(rollbackConfig);
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      mode: args.mode,
      connectionId: CONNECTION_ID,
      providerConfigRestored: restored,
      providerConfigSha256: sha256(stableJson(updated.provider_config)),
      xmlRestore,
      note: "XML and provider_config were restored through the scoped resilient rollback path.",
    }, null, 2));
    if (!restored) process.exitCode = 2;
    return;
  }

  const context = await loadContext();
  assertExactCatalog(context);

  if (args.mode === "snapshot") {
    const report = baseReport(context);
    if (context.configMatchesTarget && context.queueRows.length === 0) {
      const dryRun = await runNormalizerDryRun(context, context.allowedProductIds);
      report.normalizerDryRun = actionSummary(dryRun, args.includeXml, args.allChanges);
    } else {
      report.normalizerDryRun = {
        executed: false,
        reason: context.queueRows.length > 0 ? "ACTIVE_QUEUE" : "TARGET_PROVIDER_CONFIG_NOT_STAGED",
      };
    }
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (args.mode === "configure") {
    requireArtifactPath(args);
    assertStableWriteGates(context);
    if (args.confirm !== CONFIGURE_CONFIRM) throw new Error(`Configure mode requires --confirm=${CONFIGURE_CONFIRM}`);
    const artifact = {
      schemaVersion: 1,
      connectionId: CONNECTION_ID,
      createdAt: new Date().toISOString(),
      operation: "configure",
      providerConfigBefore: context.priorProviderConfig,
      providerConfigTarget: context.targetProviderConfig,
      providerConfigBeforeSha256: sha256(stableJson(context.priorProviderConfig)),
      providerConfigTargetSha256: sha256(stableJson(context.targetProviderConfig)),
      excludedProductIds: [...EXCLUDED_PRODUCT_IDS],
      status: "PREPARED",
    };
    await createArtifact(args.artifactFile, artifact);
    if (context.configMatchesTarget) {
      artifact.status = "NO_CHANGE_REQUIRED";
      await updateArtifact(args.artifactFile, artifact);
      console.log(JSON.stringify({ ...baseReport(context), artifactFile: args.artifactFile, configured: false, reason: artifact.status }, null, 2));
      return;
    }
    try {
      const updated = await patchProviderConfig(context.targetProviderConfig);
      if (!presentationConfigMatches(updated.provider_config)) throw new Error("Target provider_config did not persist exactly");
      const configuredContext = await loadContext();
      const dryRun = await runNormalizerDryRun(configuredContext, configuredContext.allowedProductIds);
      artifact.status = "CONFIGURED_AND_DRY_RUN_VERIFIED";
      artifact.configurationVerifiedAt = new Date().toISOString();
      artifact.dryRun = actionSummary(dryRun, true, true);
      await updateArtifact(args.artifactFile, artifact);
      console.log(JSON.stringify({
        ...baseReport(configuredContext),
        artifactFile: args.artifactFile,
        configured: true,
        dryRun: actionSummary(dryRun, args.includeXml, args.allChanges),
      }, null, 2));
    } catch (error) {
      const rollback = await patchProviderConfig(context.priorProviderConfig).then(
        (row) => ({ success: stableJson(row.provider_config) === stableJson(context.priorProviderConfig) }),
        (rollbackError) => ({ success: false, error: String(rollbackError) }),
      );
      artifact.status = "FAILED_CONFIG_ROLLED_BACK";
      artifact.error = String(error);
      artifact.automaticConfigRollback = rollback;
      await updateArtifact(args.artifactFile, artifact);
      throw error;
    }
    return;
  }

  if (args.mode === "dry-run" || args.mode === "verify") {
    const dryRun = await runNormalizerDryRun(context, context.allowedProductIds);
    const idempotent = Number(dryRun.summary?.changedProducts || 0) === 0 &&
      Number(dryRun.summary?.changedFamilies || 0) === 0;
    console.log(JSON.stringify({
      ...baseReport(context),
      idempotent,
      dryRun: actionSummary(dryRun, args.includeXml, args.allChanges),
    }, null, 2));
    if (args.mode === "verify" && !idempotent) process.exitCode = 2;
    return;
  }

  if (args.mode === "canary") {
    requireArtifactPath(args);
    assertStableWriteGates(context);
    assertTargetConfig(context);
    if (args.confirm !== NORMALIZE_CONFIRM) throw new Error(`Canary mode requires --confirm=${NORMALIZE_CONFIRM}`);
    if (!args.productId) throw new Error("Canary mode requires one explicit --product-id");
    if (EXCLUDED_PRODUCT_IDS.has(args.productId)) throw new Error(`Product ${args.productId} is explicitly excluded`);
    if (!context.allowedProductIds.includes(args.productId)) throw new Error(`Product ${args.productId} is outside the strict VERIFIED allowlist`);

    const preflight = await runNormalizerDryRun(context, [args.productId]);
    const changedProducts = Number(preflight.summary?.changedProducts || 0);
    if (changedProducts > 1) throw new Error(`Canary preflight would change ${changedProducts} products`);
    const artifact = {
      schemaVersion: 1,
      connectionId: CONNECTION_ID,
      createdAt: new Date().toISOString(),
      operation: "canary",
      productIds: [args.productId],
      excludedProductIds: [...EXCLUDED_PRODUCT_IDS],
      providerConfigBefore: context.priorProviderConfig,
      providerConfigRollback: context.priorProviderConfig,
      preflight: actionSummary(preflight, true, true),
      status: "PREPARED",
    };
    await createArtifact(args.artifactFile, artifact);
    if (changedProducts === 0) {
      artifact.status = "ALREADY_IDEMPOTENT";
      await updateArtifact(args.artifactFile, artifact);
      console.log(JSON.stringify({ ...baseReport(context), artifactFile: args.artifactFile, applied: false, reason: artifact.status }, null, 2));
      return;
    }

    let applied;
    try {
      applied = await invoke("normalize-winerim-product-presentation", {
        connectionId: CONNECTION_ID,
        dryRun: false,
        confirm: NORMALIZE_CONFIRM,
        productIds: [args.productId],
      }, 1);
    } catch (error) {
      artifact.status = "APPLY_OUTCOME_UNKNOWN_VERIFY_FRESH_BEFORE_RETRY";
      artifact.error = String(error);
      await updateArtifact(args.artifactFile, artifact);
      throw error;
    }
    artifact.applyResponse = applied;
    if (applied.rollbackXml) validateXml(applied.rollbackXml, "apply rollback");
    if (applied.success === false) {
      artifact.status = "APPLY_FAILED_XML_ROLLBACK_REQUIRED";
      await updateArtifact(args.artifactFile, artifact);
      throw new Error(`Canary apply failed: ${applied.error || "verification failed"}`);
    }

    const postContext = await loadContext();
    assertExactCatalog(postContext);
    const postDryRun = await runNormalizerDryRun(postContext, [args.productId]);
    const idempotent = Number(postDryRun.summary?.changedProducts || 0) === 0 &&
      Number(postDryRun.summary?.changedFamilies || 0) === 0;
    artifact.status = idempotent ? "APPLIED_VERIFIED_IDEMPOTENT" : "APPLIED_NOT_IDEMPOTENT_XML_ROLLBACK_REQUIRED";
    artifact.postApply = {
      freshAudit: {
        expected: postContext.audit.expected,
        matched: postContext.audit.matched,
        missing: postContext.audit.missing,
        different: postContext.audit.different,
      },
      dryRun: actionSummary(postDryRun, true, true),
      idempotent,
    };
    await updateArtifact(args.artifactFile, artifact);
    console.log(JSON.stringify({
      ...baseReport(postContext),
      artifactFile: args.artifactFile,
      applied: true,
      idempotent,
      verification: applied.verification || null,
    }, null, 2));
    if (!idempotent) process.exitCode = 2;
    return;
  }

  if (args.mode === "apply") {
    requireArtifactPath(args);
    assertStableWriteGates(context);
    assertTargetConfig(context);
    if (args.confirm !== NORMALIZE_CONFIRM) throw new Error(`Apply mode requires --confirm=${NORMALIZE_CONFIRM}`);
    if (!args.productId) throw new Error("Apply mode requires --product-id for the previously verified canary");
    if (EXCLUDED_PRODUCT_IDS.has(args.productId) || !context.allowedProductIds.includes(args.productId)) {
      throw new Error(`Canary product ${args.productId} is outside the strict VERIFIED allowlist`);
    }

    const canaryProof = await runNormalizerDryRun(context, [args.productId]);
    const canaryIdempotent = Number(canaryProof.summary?.changedProducts || 0) === 0 &&
      Number(canaryProof.summary?.changedFamilies || 0) === 0;
    if (!canaryIdempotent) throw new Error("The selected canary is not already idempotent; complete canary mode first");
    const preflight = await runNormalizerDryRun(context, context.allowedProductIds);
    const artifact = {
      schemaVersion: 1,
      connectionId: CONNECTION_ID,
      createdAt: new Date().toISOString(),
      operation: "apply",
      canaryProductId: args.productId,
      productIds: context.allowedProductIds,
      excludedProductIds: [...EXCLUDED_PRODUCT_IDS],
      providerConfigBefore: context.priorProviderConfig,
      providerConfigRollback: context.priorProviderConfig,
      canaryProof: actionSummary(canaryProof, true, true),
      preflight: actionSummary(preflight, true, true),
      status: "PREPARED",
    };
    await createArtifact(args.artifactFile, artifact);
    const changedProducts = Number(preflight.summary?.changedProducts || 0);
    const changedFamilies = Number(preflight.summary?.changedFamilies || 0);
    if (changedProducts === 0 && changedFamilies === 0) {
      artifact.status = "ALREADY_IDEMPOTENT";
      await updateArtifact(args.artifactFile, artifact);
      console.log(JSON.stringify({ ...baseReport(context), artifactFile: args.artifactFile, applied: false, reason: artifact.status }, null, 2));
      return;
    }

    let applied;
    try {
      applied = await invoke("normalize-winerim-product-presentation", {
        connectionId: CONNECTION_ID,
        dryRun: false,
        confirm: NORMALIZE_CONFIRM,
        productIds: context.allowedProductIds,
      }, 1);
    } catch (error) {
      artifact.status = "APPLY_OUTCOME_UNKNOWN_VERIFY_FRESH_BEFORE_RETRY";
      artifact.error = String(error);
      await updateArtifact(args.artifactFile, artifact);
      throw error;
    }
    artifact.applyResponse = applied;
    if (applied.rollbackXml) validateXml(applied.rollbackXml, "apply rollback");
    if (applied.success === false) {
      artifact.status = "APPLY_FAILED_XML_ROLLBACK_REQUIRED";
      await updateArtifact(args.artifactFile, artifact);
      throw new Error(`Full apply failed: ${applied.error || "verification failed"}`);
    }

    const postContext = await loadContext();
    assertExactCatalog(postContext);
    const postDryRun = await runNormalizerDryRun(postContext, postContext.allowedProductIds);
    const idempotent = Number(postDryRun.summary?.changedProducts || 0) === 0 &&
      Number(postDryRun.summary?.changedFamilies || 0) === 0;
    artifact.status = idempotent ? "APPLIED_VERIFIED_IDEMPOTENT" : "APPLIED_NOT_IDEMPOTENT_XML_ROLLBACK_REQUIRED";
    artifact.postApply = {
      freshAudit: {
        expected: postContext.audit.expected,
        matched: postContext.audit.matched,
        missing: postContext.audit.missing,
        different: postContext.audit.different,
      },
      dryRun: actionSummary(postDryRun, true, true),
      idempotent,
    };
    await updateArtifact(args.artifactFile, artifact);
    console.log(JSON.stringify({
      ...baseReport(postContext),
      artifactFile: args.artifactFile,
      applied: true,
      idempotent,
      verification: applied.verification || null,
    }, null, 2));
    if (!idempotent) process.exitCode = 2;
    return;
  }

}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
