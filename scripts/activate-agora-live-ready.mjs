#!/usr/bin/env node

/**
 * Staged Agora activation runbook.
 *
 * Default mode is read-only. Live writes require both --apply and
 * --confirm-live-ready-pending-sale. Credentials are loaded from environment
 * variables and are never written to snapshots or stdout.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_ENV_FILE = "/Users/GOIKO/Documents/Playground/bridge-to-winerim-audit/bridge-to-winerim-main/.env";
const TARGETS = [
  { key: "finca-eslava", aliases: ["finca eslava"], saleCenterIds: ["1", "4", "5"] },
  {
    key: "vinatea",
    aliases: ["vinatea", "vina tea"],
    saleCenterIds: ["4", "12", "15", "16"],
    preparationRoutes: {
      BOTTLE: { typeId: "8", orderId: "1" },
      GLASS: { typeId: "8", orderId: "1" },
      MAGNUM: { typeId: "8", orderId: "1" },
    },
  },
  { key: "don-quijote-marbella", aliases: ["don quijote marbella", "restaurante don quijote marbella"], saleCenterIds: ["2", "3", "4"] },
  { key: "abadia-yuste", aliases: ["abadia yuste", "abadía yuste"], saleCenterIds: ["1", "3", "7", "8", "11"] },
  { key: "de-la-o", aliases: ["de la o"], saleCenterIds: ["2", "4"] },
  { key: "el-porton-de-sorni", aliases: ["el porton de sorni", "el portón de sorní"], saleCenterIds: ["1", "2"] },
  { key: "el-higueron", aliases: ["el higueron", "el higuerón", "higueron", "higuerón"], saleCenterIds: ["1", "2", "4", "5", "6", "7", "8", "9", "10", "11", "13"] },
  { key: "qtomas", aliases: ["qtomas", "q tomas", "restaurante qtomas"], saleCenterIds: ["12", "16", "17"] },
  { key: "ocean-club", aliases: ["ocean club"], canCreate: true, saleCenterEnv: "OCEAN_SALE_CENTER_IDS" },
];
const PILOT_KEYS = {
  GLASS: "copa",
  MAGNUM: "magnum",
  tinto: "botella_tinto",
  blanco: "botella_blanco",
  rosado: "botella_rosado",
  espumoso: "botella_espumoso",
  cava: "botella_espumoso",
  champagne: "botella_espumoso",
  generoso: "botella_fortificado",
  fortificado: "botella_fortificado",
  dulce: "botella_dulce",
  postre: "botella_dulce",
};
const MUTABLE_CONNECTION_FIELDS = [
  "enabled", "sync_mode", "sync_frequency_minutes", "backfill_days",
  "catalog_sync_enabled", "write_mode", "write_bottle", "write_glass",
  "auto_create_families", "auto_push_on_create", "auto_push_on_update",
  "auto_push_bottle", "auto_push_glass", "auto_push_verified_ready",
  "require_manual_review_before_push", "default_vat_id", "default_vat_rate",
  "default_preparation_type_id", "default_preparation_order_id",
  "default_warehouse_id", "selected_sale_center_ids", "last_business_day_synced",
  "circuit_breaker_paused_until", "circuit_breaker_reason", "consecutive_failures",
  "provider_config",
];
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 520, 522, 523, 524]);

function parseArgs(argv) {
  const result = {
    apply: false,
    confirmed: false,
    enableAfterVerification: false,
    allowCurrentPublicBackendPolicy: false,
    useDisabledConnectionAsLock: false,
    targets: [],
    envFile: process.env.LOVABLE_ENV_FILE || DEFAULT_ENV_FILE,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") result.apply = true;
    else if (arg === "--confirm-live-ready-pending-sale") result.confirmed = true;
    else if (arg === "--enable-after-verification") result.enableAfterVerification = true;
    else if (arg === "--allow-current-public-backend-policy") result.allowCurrentPublicBackendPolicy = true;
    else if (arg === "--use-disabled-connection-as-lock") result.useDisabledConnectionAsLock = true;
    else if (arg === "--target") result.targets.push(...String(argv[++i] || "").split(",").filter(Boolean));
    else if (arg === "--env-file") result.envFile = argv[++i];
    else if (arg === "--help") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function usage() {
  return `Usage:
  node scripts/activate-agora-live-ready.mjs [--target finca-eslava,ocean-club]
  node scripts/activate-agora-live-ready.mjs --apply --confirm-live-ready-pending-sale [--enable-after-verification] [--target ...]

Ocean Club creation additionally requires:
  OCEAN_BASE_URL, OCEAN_AGORA_API_TOKEN, OCEAN_WINERIM_API_TOKEN
  OCEAN_SALE_CENTER_IDS (comma-separated explicit allowlist)

The temporary --allow-current-public-backend-policy switch is only valid for
the current Lovable Cloud project while its existing frontend write policy is
still in force. Without a service-role key it additionally requires
--use-disabled-connection-as-lock, which pauses the connection and verifies
that no scheduled job is running before continuing. Prefer a service-role key
whenever one is available.`;
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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

function redact(value, key = "") {
  if (/token|secret|password|api[_-]?key|authorization|bearer/i.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asBoolean(value) {
  return value === true || String(value).toLowerCase() === "true";
}

function isDeleted(entity) {
  return asBoolean(entity?.Deleted) || asBoolean(entity?.IsDeleted) ||
    Boolean(String(entity?.DeletionDate || entity?.deletionDate || entity?.deletion_date || "").trim()) ||
    normalize(entity?.Status) === "deleted";
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function chunks(values, size) {
  const result = [];
  for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
  return result;
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function productId(wineId, format) {
  const numericId = Number(wineId || 0);
  if (!Number.isFinite(numericId)) throw new Error(`Invalid Winerim wine id: ${wineId}`);
  return String((format === "GLASS" ? 700000 : format === "MAGNUM" ? 900000 : 500000) + numericId);
}

function expectedFamilyKey(wine, format) {
  if (format === "GLASS" || format === "MAGNUM") return PILOT_KEYS[format];
  return PILOT_KEYS[normalize(wine.wine_type).replace(/\s+/g, "_")] || null;
}

function expectedFormats(wine) {
  if (!wine.is_active) return [];
  const formats = [];
  if (positive(wine.bottle_sale_price)) formats.push("BOTTLE");
  if (positive(wine.glass_sale_price)) formats.push("GLASS");
  if (positive(wine.magnum_sale_price)) formats.push("MAGNUM");
  return formats;
}

function inferPreparationFormat(product, familyName) {
  const text = normalize(`${familyName || ""} ${product.Name || ""} ${product.ButtonText || ""}`);
  if (/\b(copa|copas|glass)\b/.test(text)) return "GLASS";
  if (/\b(magnum|mag)\b/.test(text)) return "MAGNUM";
  return "BOTTLE";
}

function inferPreparationRoutes(master, requiredFormats) {
  const preparationTypes = (master.preparationTypes || []).filter((item) => !isDeleted(item));
  const preparationOrders = (master.preparationOrders || []).filter((item) => !isDeleted(item));
  if (preparationTypes.length === 0 && preparationOrders.length === 0) {
    return {
      routes: Object.fromEntries(Array.from(requiredFormats).map((format) => [format, { typeId: "", orderId: "" }])),
      source: "NO_PREPARATION_MODEL",
    };
  }
  if (preparationTypes.length === 0 || preparationOrders.length === 0) {
    throw new Error("Agora preparation configuration is incomplete: both Types and Orders are required.");
  }

  const validTypeIds = new Set(preparationTypes.map((item) => String(item.Id)));
  const validOrderIds = new Set(preparationOrders.map((item) => String(item.Id)));
  const familyNameById = new Map((master.families || []).map((family) => [String(family.Id), String(family.Name || "")]));
  const countsByFormat = new Map();
  for (const product of master.products || []) {
    const familyName = familyNameById.get(String(product.FamilyId || "")) || "";
    if (!/(vino|bodega|tinto|blanco|rosado|espum|champ|copa|magnum|generoso|fortific|dulce)/i.test(familyName)) continue;
    const typeId = String(product.PreparationTypeId || "");
    const orderId = String(product.PreparationOrderId || "");
    if (!typeId || !orderId || !validTypeIds.has(typeId) || !validOrderIds.has(orderId)) continue;
    const format = inferPreparationFormat(product, familyName);
    const formatCounts = countsByFormat.get(format) || new Map();
    const key = `${typeId}:${orderId}`;
    formatCounts.set(key, Number(formatCounts.get(key) || 0) + 1);
    countsByFormat.set(format, formatCounts);
  }

  const genericTypes = preparationTypes.filter((item) => /bebid|vino|bar/i.test(String(item.Name || "")));
  const genericOrders = preparationOrders.filter((item) => /bebid|vino|bar/i.test(String(item.Name || "")));
  const genericPair = genericTypes.length === 1 && genericOrders.length === 1
    ? { typeId: String(genericTypes[0].Id), orderId: String(genericOrders[0].Id) }
    : null;

  const dominantPair = (format) => {
    const entries = Array.from(countsByFormat.get(format)?.entries() || [])
      .sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return null;
    if (entries.length > 1 && entries[0][1] === entries[1][1]) {
      throw new Error(`Agora preparation routing is ambiguous for ${format}: ${entries[0][0]} and ${entries[1][0]} have the same usage.`);
    }
    const [typeId, orderId] = entries[0][0].split(":");
    return { typeId, orderId };
  };

  const bottlePair = dominantPair("BOTTLE") || genericPair;
  const routes = {};
  for (const format of requiredFormats) {
    const pair = dominantPair(format) || (format === "MAGNUM" ? bottlePair : null) || genericPair;
    if (!pair) {
      throw new Error(`Agora preparation routing cannot be inferred safely for ${format}. Configure an explicit route before activation.`);
    }
    routes[format] = pair;
  }
  return { routes, source: countsByFormat.size > 0 ? "EXISTING_WINE_PRODUCTS" : "UNIQUE_GENERIC_PAIR" };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.apply && !args.confirmed) {
    throw new Error("Live mode requires --confirm-live-ready-pending-sale. The final sale test is still mandatory.");
  }

  let fileEnv = {};
  try {
    fileEnv = parseDotEnv(await readFile(args.envFile, "utf8"));
  } catch (error) {
    if (!process.env.VITE_SUPABASE_URL && !process.env.SUPABASE_URL) throw error;
  }
  const env = { ...fileEnv, ...process.env };
  const backendUrl = String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || "").replace(/\/$/, "");
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || env.LOVABLE_CLOUD_SERVICE_ROLE_KEY;
  const backendKey = serviceRoleKey || env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
  if (!backendUrl || !backendKey) throw new Error("Lovable Cloud URL/key not found in environment.");
  const currentProjectId = String(env.VITE_SUPABASE_PROJECT_ID || "");
  const publicPolicyWriteAllowed = args.allowCurrentPublicBackendPolicy &&
    currentProjectId === "csiertktrefwewsmequr";
  if (args.apply && !serviceRoleKey && !publicPolicyWriteAllowed) {
    throw new Error(
      "Live activation requires a service-role key. The current project may use " +
      "--allow-current-public-backend-policy only while its existing frontend write policy remains active.",
    );
  }
  if (args.apply && !serviceRoleKey && publicPolicyWriteAllowed) {
    if (!args.useDisabledConnectionAsLock) {
      throw new Error(
        "Public-policy activation requires --use-disabled-connection-as-lock so scheduled jobs are excluded.",
      );
    }
    console.warn("[security] Using the current Lovable Cloud frontend write policy; remove this path after RLS hardening.");
  }

  const request = async (url, options = {}, attempts = 5) => {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs || 60_000) });
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (response.ok) return { response, data };
        const message = typeof data === "string" ? data.slice(0, 500) : JSON.stringify(data).slice(0, 500);
        if (!RETRYABLE_STATUS.has(response.status)) {
          const error = new Error(`HTTP ${response.status}: ${message}`);
          error.nonRetryable = true;
          throw error;
        }
        if (attempt === attempts) {
          throw new Error(`HTTP ${response.status}: ${message}`);
        }
        lastError = new Error(`HTTP ${response.status}: ${message}`);
      } catch (error) {
        if (error?.nonRetryable) throw error;
        lastError = error;
        if (attempt === attempts) break;
      }
      await sleep(Math.min(20_000, 1_250 * (2 ** (attempt - 1))));
    }
    throw lastError || new Error("Request failed");
  };

  const authHeaders = {
    apikey: backendKey,
    Authorization: `Bearer ${backendKey}`,
    "Content-Type": "application/json",
  };
  const rest = async (method, resource, body, extraHeaders = {}) => {
    const { data, response } = await request(`${backendUrl}/rest/v1/${resource}`, {
      method,
      headers: { ...authHeaders, ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: 45_000,
    });
    return { data, response };
  };
  const restAll = async (resource, pageSize = 1000) => {
    const rows = [];
    for (let offset = 0; ; offset += pageSize) {
      const { data } = await rest("GET", resource, undefined, { Range: `${offset}-${offset + pageSize - 1}` });
      if (!Array.isArray(data)) throw new Error(`Expected array from ${resource}`);
      rows.push(...data);
      if (data.length < pageSize) break;
    }
    return rows;
  };
  const rpc = async (name, body) => {
    const { data } = await rest("POST", `rpc/${name}`, body);
    return data;
  };
  const patchConnection = async (id, update) => {
    const { data } = await rest("PATCH", `pos_connections?id=eq.${encodeURIComponent(id)}`, update, { Prefer: "return=representation" });
    return Array.isArray(data) ? data[0] : data;
  };
  const invoke = async (name, body, { allowFailure = false } = {}) => {
    const { data } = await request(`${backendUrl}/functions/v1/${name}`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(body),
      timeoutMs: 140_000,
    }, 4);
    if (!allowFailure && data && typeof data === "object" && data.success === false) {
      throw new Error(`${name}/${body.action}: ${data.error || data.reason || JSON.stringify(data).slice(0, 700)}`);
    }
    return data;
  };

  const selectedKeys = args.targets.length > 0 ? new Set(args.targets.map(normalize).map((value) => value.replace(/\s+/g, "-"))) : null;
  const targetDefinitions = TARGETS.filter((target) => !selectedKeys || selectedKeys.has(target.key));
  if (targetDefinitions.length === 0) throw new Error("No valid targets selected.");

  console.log(`[mode] ${args.apply ? "APPLY" : "DRY_RUN"}`);
  console.log(`[scope] ${targetDefinitions.map((target) => target.key).join(", ")}`);
  const connections = await restAll("pos_connections?provider=eq.agora&select=*");
  const resolved = [];
  for (const definition of targetDefinitions) {
    let connection = connections.find((candidate) => definition.aliases.some((alias) => normalize(candidate.location_name) === normalize(alias)));
    if (!connection && definition.canCreate && args.apply) {
      const required = ["OCEAN_BASE_URL", "OCEAN_AGORA_API_TOKEN", "OCEAN_WINERIM_API_TOKEN"];
      const missing = required.filter((key) => !env[key]);
      if (missing.length > 0) throw new Error(`Ocean Club is absent; missing environment values: ${missing.join(", ")}`);
      const createPayload = {
        location_name: "Ocean Club",
        provider: "agora",
        base_url: String(env.OCEAN_BASE_URL).replace(/\/#\/?$/, "").replace(/\/$/, ""),
        api_token: env.OCEAN_AGORA_API_TOKEN,
        winerim_api_token: env.OCEAN_WINERIM_API_TOKEN,
        enabled: false,
        sync_mode: "PULL_ONLY",
        sync_frequency_minutes: 5,
        backfill_days: 1,
        write_mode: "NONE",
        catalog_sync_enabled: false,
        auto_push_on_create: false,
        auto_push_on_update: false,
        auto_push_verified_ready: false,
        provider_config: { read_only_onboarding: true, activation_status: "STAGING" },
      };
      const { data } = await rest("POST", "pos_connections", createPayload, { Prefer: "return=representation" });
      connection = data?.[0];
      if (!connection) throw new Error("Ocean Club connection could not be created.");
      connection.__createdByRunbook = true;
    }
    resolved.push({ definition, connection });
  }

  const missingConnections = resolved.filter((item) => !item.connection).map((item) => item.definition.key);
  if (missingConnections.length > 0) {
    throw new Error(`Connections not found: ${missingConnections.join(", ")}. Run Ocean with --apply and env credentials if it must be created.`);
  }

  if (!args.apply) {
    for (const { definition, connection } of resolved) {
      const [wineRows, activeTasks, familyMappings] = await Promise.all([
        restAll(`winerim_wines?connection_id=eq.${connection.id}&select=winerim_id,is_active,wine_type,bottle_sale_price,glass_sale_price,magnum_sale_price`),
        restAll(`outbound_tasks?connection_id=eq.${connection.id}&status=in.(QUEUED,RUNNING)&select=id,status,task_type,created_at`),
        restAll(`wine_type_family_mappings?connection_id=eq.${connection.id}&select=mapping_key,agora_family_id,agora_family_name`),
      ]);
      const eligible = wineRows.reduce((total, wine) => total + expectedFormats(wine).length, 0);
      console.log(`[dry-run] ${definition.key}: connection=${connection.id} enabled=${connection.enabled} eligibleFormats=${eligible} activeTasks=${activeTasks.length} familyMappings=${familyMappings.length}`);
    }
    console.log("[dry-run] No writes performed. Re-run with --apply --confirm-live-ready-pending-sale after review.");
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotDir = path.resolve("docs/operations", `agora-live-ready-${stamp}`);
  await mkdir(snapshotDir, { recursive: true });
  const finalResults = [];

  const processQueue = async (connectionId) => {
    let last;
    for (let attempt = 0; attempt < 120; attempt++) {
      // Keep the runbook synchronous. The connection is disabled during staging,
      // and serverLoop=false prevents delayed queue callbacks from outliving rollback.
      last = await invoke("agora-proxy", { action: "process-xml-outbound-queue", connectionId, serverLoop: false });
      if (last?.breakerTripped) throw new Error(`Circuit breaker tripped with ${last.remaining || 0} tasks remaining.`);
      if (last?.done || Number(last?.remaining || 0) === 0) return last;
      await sleep(750);
    }
    throw new Error(`Queue did not drain; last result=${JSON.stringify(last).slice(0, 500)}`);
  };

  for (const { definition, connection: initialConnection } of resolved) {
    let connection = initialConnection;
    const originalConnection = structuredClone(initialConnection);
    const lockToken = crypto.randomUUID();
    const heldLocks = [];
    let newlyCreatedFamilies = [];
    let touchedPilotFamilies = [];
    let familyVisibilityBefore = new Map();
    let newlyIntroducedProducts = [];
    let snapshot;
    let releaseLocks = async () => {};
    let lockHeartbeat = null;
    let lockHeartbeatInFlight = null;
    let lockHeartbeatStopped = false;
    let lockHeartbeatError = null;
    let assertActivationLock = () => {};
    let captureCreatedRows = async () => {};
    const createdRowIds = {
      familyMappings: new Set(),
      productMappings: new Set(),
      tracking: new Set(),
      capabilities: new Set(),
      tasks: new Set(),
    };
    console.log(`\n[activate] ${connection.location_name} (${definition.key})`);
    try {
      const acquireLock = async (job, waitMs = 600_000) => {
        if (args.useDisabledConnectionAsLock) return;
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
          const acquired = await rpc("acquire_agora_dispatch_lock", {
            p_connection_id: connection.id,
            p_job: job,
            p_lock_token: lockToken,
            p_ttl_seconds: 1800,
          });
          if (acquired === true) {
            if (!heldLocks.includes(job)) heldLocks.push(job);
            return;
          }
          await sleep(5000);
        }
        throw new Error(`Timed out waiting for exclusive ${job} lock.`);
      };
      releaseLocks = async () => {
        lockHeartbeatStopped = true;
        if (lockHeartbeat) clearInterval(lockHeartbeat);
        lockHeartbeat = null;
        if (lockHeartbeatInFlight) await lockHeartbeatInFlight;
        for (const job of [...heldLocks].reverse()) {
          await rpc("release_agora_dispatch_lock", {
            p_connection_id: connection.id,
            p_job: job,
            p_lock_token: lockToken,
          }).catch(() => null);
        }
        heldLocks.length = 0;
      };

      await acquireLock("activation", 30_000);
      if (!args.useDisabledConnectionAsLock) {
        lockHeartbeat = setInterval(async () => {
          if (lockHeartbeatStopped || lockHeartbeatInFlight) return;
          lockHeartbeatInFlight = (async () => {
            try {
              const renewed = await rpc("acquire_agora_dispatch_lock", {
                p_connection_id: connection.id,
                p_job: "activation",
                p_lock_token: lockToken,
                p_ttl_seconds: 1800,
              });
              if (renewed !== true) lockHeartbeatError = new Error("Exclusive activation lock could not be renewed.");
            } catch (error) {
              lockHeartbeatError = error;
            } finally {
              lockHeartbeatInFlight = null;
            }
          })();
          await lockHeartbeatInFlight;
        }, 240_000);
      }
      assertActivationLock = () => {
        if (lockHeartbeatError) throw lockHeartbeatError;
      };
      const providerConfigBefore = connection.provider_config && typeof connection.provider_config === "object" ? connection.provider_config : {};
      const stagingPatch = {
        enabled: false,
        catalog_sync_enabled: false,
        auto_push_on_create: false,
        auto_push_on_update: false,
        auto_push_verified_ready: false,
        require_manual_review_before_push: true,
        provider_config: { ...providerConfigBefore, activation_status: "STAGING", read_only_onboarding: false },
      };
      connection = await patchConnection(connection.id, stagingPatch);
      if (args.useDisabledConnectionAsLock) await sleep(5_000);
      const activationStockStartAt = new Date().toISOString();
      const taskSnapshotPromise = Promise.all([
        restAll(
          `outbound_tasks?connection_id=eq.${connection.id}&status=in.(QUEUED,RUNNING)&select=id,task_type,status,attempts,last_error,blocked_reason,created_at,updated_at`,
        ),
        restAll(
          `outbound_tasks?connection_id=eq.${connection.id}&status=in.(FAILED,BLOCKED)&select=id,task_type,status,attempts,last_error,blocked_reason,created_at,updated_at`,
        ),
      ]).then(([activeRows, failedRows]) => [...activeRows, ...failedRows]);

      const [familyMappingsBefore, productMappingsBefore, trackingBefore, tasksBefore, capsBefore, masterBefore] = await Promise.all([
        restAll(`wine_type_family_mappings?connection_id=eq.${connection.id}&select=*`),
        restAll(`product_mappings?connection_id=eq.${connection.id}&select=*`),
        restAll(`winerim_push_tracking?connection_id=eq.${connection.id}&select=*`),
        taskSnapshotPromise,
        restAll(`provider_capabilities?connection_id=eq.${connection.id}&select=*`),
        restAll(`agora_master_data?connection_id=eq.${connection.id}&select=*`),
      ]);
      snapshot = {
        generatedAt: new Date().toISOString(),
        connection: originalConnection,
        familyMappings: familyMappingsBefore,
        productMappings: productMappingsBefore,
        tracking: trackingBefore,
        outboundTasks: tasksBefore,
        capabilities: capsBefore,
        masterData: masterBefore,
      };
      const baselineIds = {
        familyMappings: new Set(familyMappingsBefore.map((row) => String(row.id))),
        productMappings: new Set(productMappingsBefore.map((row) => String(row.id))),
        tracking: new Set(trackingBefore.map((row) => String(row.id))),
        capabilities: new Set(capsBefore.map((row) => String(row.id))),
        tasks: new Set(tasksBefore.map((row) => String(row.id))),
      };
      captureCreatedRows = async () => {
        const tableSpecs = [
          ["wine_type_family_mappings", "familyMappings"],
          ["product_mappings", "productMappings"],
          ["winerim_push_tracking", "tracking"],
          ["provider_capabilities", "capabilities"],
        ];
        for (const [table, key] of tableSpecs) {
          const currentRows = await restAll(`${table}?connection_id=eq.${connection.id}&select=id`);
          for (const row of currentRows) {
            const id = String(row.id);
            if (!baselineIds[key].has(id)) createdRowIds[key].add(id);
          }
        }
        const createdTasks = await restAll(
          `outbound_tasks?connection_id=eq.${connection.id}&created_at=gte.${encodeURIComponent(activationStockStartAt)}&select=id`,
        );
        for (const row of createdTasks) createdRowIds.tasks.add(String(row.id));
      };
      await writeFile(path.join(snapshotDir, `${definition.key}-before.json`), JSON.stringify(redact(snapshot), null, 2));
      const activeTasksBefore = tasksBefore.filter((task) => task.status === "QUEUED" || task.status === "RUNNING");
      if (activeTasksBefore.length > 0) {
        throw new Error(`Activation requires an empty outbound queue; found ${activeTasksBefore.length} pre-existing active tasks.`);
      }

      const testResult = await invoke("agora-proxy", { action: "test", connectionId: connection.id });
      if (testResult?.success === false) throw new Error(`Agora read test failed: ${JSON.stringify(testResult).slice(0, 500)}`);
      const openTicketsProbe = await invoke("agora-proxy", { action: "probe-open-tickets", connectionId: connection.id }, { allowFailure: true });
      if (openTicketsProbe?.success !== true) {
        throw new Error(`Agora live tickets probe failed: ${JSON.stringify(openTicketsProbe).slice(0, 700)}`);
      }
      let masterSync = await invoke("agora-proxy", { action: "sync-master-data", connectionId: connection.id, preserveWriteMode: true });
      const master = masterSync.masterData || {};
      const activePriceLists = (master.priceLists || []).filter((item) => !isDeleted(item));
      if (activePriceLists.length === 0) throw new Error("No active Agora price lists.");
      const activePriceListIds = new Set(activePriceLists.map((item) => String(item.Id)));
      const saleCenterPriceListId = (item) => String(item.CurrentPriceListId || item.PriceListId || item.PriceList || "");
      const activeSaleCenters = (master.saleCenters || []).filter((item) => !isDeleted(item) && activePriceListIds.has(saleCenterPriceListId(item)));
      const configuredSaleCenterIds = definition.saleCenterIds || String(env[definition.saleCenterEnv] || "")
        .split(",").map((value) => value.trim()).filter(Boolean);
      if (configuredSaleCenterIds.length === 0) {
        throw new Error("An explicit Agora sale-center allowlist is required before product writes.");
      }
      const invalidSaleCenterIds = configuredSaleCenterIds.filter((id) =>
        !activeSaleCenters.some((center) => String(center.Id) === String(id))
      );
      if (invalidSaleCenterIds.length > 0) {
        throw new Error(`Configured Agora sale centers are missing, deleted or linked to inactive price lists: ${invalidSaleCenterIds.join(", ")}`);
      }
      const selectedSaleCenterIds = configuredSaleCenterIds.map(String);

      const vat = (master.vats || []).find((item) => {
        const rate = Number(item.VatRate);
        return rate === 0.1 || rate === 10;
      }) || (master.vats || [])[0];
      if (!vat?.Id) throw new Error("No Agora VAT available.");
      const activeWarehouses = (master.warehouses || []).filter((item) => !isDeleted(item));
      const existingWarehouse = activeWarehouses.find((item) => String(item.Id) === String(connection.default_warehouse_id || ""));
      const wineWarehouses = activeWarehouses.filter((item) => /\b(vino|vinos|bodega)\b/i.test(String(item.Name || "")));
      const beverageWarehouses = activeWarehouses.filter((item) => /\b(bebida|bebidas|bar)\b/i.test(String(item.Name || "")));
      const warehouse = existingWarehouse || (wineWarehouses.length === 1 ? wineWarehouses[0] : null) ||
        (beverageWarehouses.length === 1 ? beverageWarehouses[0] : null) ||
        (activeWarehouses.length === 1 ? activeWarehouses[0] : null);
      if (!warehouse) throw new Error("Agora warehouse routing is ambiguous; configure the wine warehouse before activation.");
      const defaultsPatch = {
        write_mode: "XML_IMPORT",
        write_bottle: true,
        write_glass: true,
        auto_create_families: true,
        default_vat_id: String(vat.Id),
        default_vat_rate: Number(vat.VatRate) === 0.1 ? 10 : Number(vat.VatRate || 10),
        default_warehouse_id: String(warehouse.Id),
        selected_sale_center_ids: selectedSaleCenterIds,
        provider_config: {
          ...(connection.provider_config || {}),
          price_write_scope: "SELECTED_SALE_CENTERS",
        },
      };
      connection = await patchConnection(connection.id, defaultsPatch);

      let catalog = await invoke("winerim-proxy", {
        action: "fetch-catalog", connectionId: connection.id, mode: "start", detailOffset: 0, detailBatchSize: 200,
        scheduleNextBatch: false, runSelfHealing: false,
      });
      let catalogDetailFailures = Number(catalog.detailRequestsFailed || catalog.detailsMissing || 0);
      while (!catalog.complete) {
        catalog = await invoke("winerim-proxy", {
          action: "fetch-catalog", connectionId: connection.id, mode: "enrich",
          detailOffset: catalog.nextDetailOffset, detailBatchSize: 200,
          scheduleNextBatch: false, runSelfHealing: false,
        });
        catalogDetailFailures += Number(catalog.detailRequestsFailed || catalog.detailsMissing || 0);
      }
      if (catalogDetailFailures > 0) {
        const failedDetailRows = await restAll(
          `winerim_wines?connection_id=eq.${connection.id}&pricing_status=in.(FAILED,RETRYING)&select=winerim_id,name,is_active,pricing_status,pricing_missing_reason`,
        );
        const blockingDetailFailures = failedDetailRows.filter((wine) => wine.is_active === true);
        if (blockingDetailFailures.length > 0) {
          throw new Error(
            `Winerim catalog enrichment failed for active wines (${blockingDetailFailures.length}): ` +
            JSON.stringify(blockingDetailFailures.slice(0, 20)),
          );
        }
        console.log(
          `[catalog] ${connection.location_name}: ignored ${failedDetailRows.length} detail failures for inactive wines.`,
        );
      }

      const masterRowsForRouting = await restAll(
        `agora_master_data?connection_id=eq.${connection.id}&select=families_json,preparation_types_json,preparation_orders_json,products_summary_json`,
      );
      const masterForRouting = masterRowsForRouting[0] || {};
      const wines = await restAll(`winerim_wines?connection_id=eq.${connection.id}&select=winerim_id,name,wine_type,is_active,pricing_status,bottle_sale_price,glass_sale_price,magnum_sale_price`);
      const requiredFormats = new Set(wines.flatMap((wine) => expectedFormats(wine)));
      const availablePreparationTypeIds = new Set(
        (masterForRouting.preparation_types_json || []).filter((item) => !isDeleted(item)).map((item) => String(item.Id)),
      );
      const availablePreparationOrderIds = new Set(
        (masterForRouting.preparation_orders_json || []).filter((item) => !isDeleted(item)).map((item) => String(item.Id)),
      );
      const explicitPreparationRoutes = definition.preparationRoutes || null;
      if (explicitPreparationRoutes) {
        for (const format of requiredFormats) {
          const route = explicitPreparationRoutes[format];
          if (
            !route ||
            !availablePreparationTypeIds.has(String(route.typeId)) ||
            !availablePreparationOrderIds.has(String(route.orderId))
          ) {
            throw new Error(`Configured Agora preparation route is invalid for ${format}.`);
          }
        }
      }
      const preparation = explicitPreparationRoutes
        ? { routes: explicitPreparationRoutes, source: "EXPLICIT_VERIFIED_LEGACY_ROUTE" }
        : inferPreparationRoutes({
          families: masterForRouting.families_json || [],
          preparationTypes: masterForRouting.preparation_types_json || [],
          preparationOrders: masterForRouting.preparation_orders_json || [],
          products: masterForRouting.products_summary_json || [],
        }, requiredFormats);
      const defaultPreparation = preparation.routes.BOTTLE || Object.values(preparation.routes)[0] || { typeId: "", orderId: "" };
      connection = await patchConnection(connection.id, {
        default_preparation_type_id: defaultPreparation.typeId || null,
        default_preparation_order_id: defaultPreparation.orderId || null,
        provider_config: {
          ...(connection.provider_config || {}),
          price_write_scope: "SELECTED_SALE_CENTERS",
          preparation_routes: preparation.routes,
          preparation_route_source: preparation.source,
        },
      });

      assertActivationLock();
      const familyResult = await invoke("agora-proxy", { action: "create-pilot-families", connectionId: connection.id });
      newlyCreatedFamilies = familyResult.created || [];
      const allPilotFamilies = [...(familyResult.reused || []), ...(familyResult.created || [])];
      touchedPilotFamilies = allPilotFamilies;
      const familyMasterById = new Map((master.families || []).map((family) => [String(family.Id), family]));
      familyVisibilityBefore = new Map(allPilotFamilies.map((family) => {
        const previous = familyMasterById.get(String(family.id));
        return [String(family.id), previous ? asBoolean(previous.ShowInPos) : false];
      }));
      const familyByKey = new Map(allPilotFamilies.map((item) => [item.key, item]));
      if (familyByKey.size !== 8) throw new Error(`Expected 8 Winerim family mappings, got ${familyByKey.size}.`);
      if (newlyCreatedFamilies.length > 0) {
        await invoke("agora-proxy", {
          action: "set-family-visibility", connectionId: connection.id,
          updates: newlyCreatedFamilies.map((family) => ({ familyId: String(family.id), showInPos: false })),
        });
      }

      const expected = [];
      const unroutable = [];
      for (const wine of wines) {
        for (const format of expectedFormats(wine)) {
          const familyKey = expectedFamilyKey(wine, format);
          const family = familyKey ? familyByKey.get(familyKey) : null;
          if (!family) unroutable.push({ winerimId: wine.winerim_id, name: wine.name, wineType: wine.wine_type, format });
          else expected.push({ wine, format, productId: productId(wine.winerim_id, format), familyKey, familyId: String(family.id) });
        }
      }
      if (unroutable.length > 0) {
        throw new Error(`Unroutable Winerim formats (${unroutable.length}): ${JSON.stringify(unroutable.slice(0, 10))}`);
      }
      if (expected.length === 0) throw new Error("No active Winerim formats with a positive price.");
      const expectedByProductId = new Map(expected.map((item) => [item.productId, item]));
      const recoverExactOwnership = async (matches) => {
        if (matches.length === 0) return;
        const recoveredAt = new Date().toISOString();
        const mappingRows = [];
        const trackingRows = [];
        for (const match of matches) {
          const expectedItem = expectedByProductId.get(String(match.productId));
          if (!expectedItem) {
            throw new Error(`Ownership recovery target ${match.productId} is not in the expected catalog.`);
          }
          mappingRows.push({
            connection_id: connection.id,
            provider_product_id: String(match.productId),
            provider_product_name: String(match.actualName || match.expectedName || expectedItem.wine.name),
            winerim_wine_id: String(match.expectedWinerimWineId),
            winerim_wine_name: expectedItem.wine.name,
            match_method: "XML_IMPORT",
            match_score: 100,
            match_reasons: [
              "Deterministic Agora ID",
              "Exact fresh catalog match",
              "Prior Winerim push tracking",
            ],
            status: "CONFIRMED",
            format_type: String(match.expectedFormat || "").toUpperCase(),
            agora_product_id: String(match.productId),
            last_synced_at: recoveredAt,
            last_sync_error: null,
          });
          trackingRows.push({
            connection_id: connection.id,
            winerim_wine_id: String(match.expectedWinerimWineId),
            format: String(match.expectedFormat || "").toUpperCase(),
            agora_product_id: String(match.productId),
            agora_family_id: String(match.expectedFamilyId || expectedItem.familyId),
            source: "WINERIM",
            sync_status: "VERIFIED",
            task_id: null,
            last_error: null,
            pushed_at: recoveredAt,
            verified_at: recoveredAt,
          });
        }
        await rest(
          "POST",
          "product_mappings?on_conflict=connection_id,provider_product_id",
          mappingRows,
          { Prefer: "resolution=merge-duplicates,return=minimal" },
        );
        await rest(
          "POST",
          "winerim_push_tracking?on_conflict=connection_id,winerim_wine_id,format",
          trackingRows,
          { Prefer: "resolution=merge-duplicates,return=minimal" },
        );
      };

      const mappingsBefore = await restAll(`product_mappings?connection_id=eq.${connection.id}&status=eq.CONFIRMED&select=provider_product_id,winerim_wine_id,format_type,match_method`);
      const nonDeterministicWinerimMappings = mappingsBefore.filter((mapping) => {
        if (!String(mapping.match_method || "").startsWith("XML_IMPORT")) return false;
        if (!mapping.winerim_wine_id || !["BOTTLE", "GLASS", "MAGNUM"].includes(mapping.format_type)) return false;
        return String(mapping.provider_product_id) !== productId(mapping.winerim_wine_id, mapping.format_type);
      });
      if (nonDeterministicWinerimMappings.length > 0) {
        throw new Error(`Non-deterministic Winerim mappings require manual migration before bulk activation (${nonDeterministicWinerimMappings.length}).`);
      }

      const catalogAudit = await invoke("agora-proxy", {
        action: "audit-winerim-products",
        connectionId: connection.id,
        winerimWineIds: wines.map((wine) => String(wine.winerim_id)),
      });
      const auditByProductId = new Map((catalogAudit.details || []).map((item) => [String(item.productId), item]));
      const priorWinerimTrackingKeys = new Set(
        trackingBefore
          .filter((tracking) => tracking.source === "WINERIM" && tracking.agora_product_id)
          .map((tracking) =>
            `${tracking.agora_product_id}:${tracking.winerim_wine_id}:${String(tracking.format || "").toUpperCase()}`
          ),
      );
      const recoverableUnownedMatches = (catalogAudit.details || []).filter((item) =>
        item.status === "MATCH" &&
        !item.ownedByWinerim &&
        priorWinerimTrackingKeys.has(
          `${item.productId}:${item.expectedWinerimWineId}:${String(item.expectedFormat || "").toUpperCase()}`
        )
      );
      const recoverableUnownedProductIds = new Set(
        recoverableUnownedMatches.map((item) => String(item.productId)),
      );
      const auditCollisions = (catalogAudit.details || []).filter((item) =>
        item.status !== "MISSING" &&
        !item.ownedByWinerim &&
        !recoverableUnownedProductIds.has(String(item.productId))
      );
      if (auditCollisions.length > 0) {
        throw new Error(`Deterministic Agora ID collisions detected (${auditCollisions.length}): ${JSON.stringify(auditCollisions.slice(0, 10))}`);
      }
      if (recoverableUnownedMatches.length > 0) {
        console.log(
          `[repair] ${connection.location_name}: ${recoverableUnownedMatches.length} exact Winerim products require ownership recovery.`,
        );
        await recoverExactOwnership(recoverableUnownedMatches);
      }
      const auditDifferences = (catalogAudit.details || []).filter((item) =>
        item.status === "DIFFERENT" && item.ownedByWinerim
      );
      if (auditDifferences.length > 0) {
        console.log(`[repair] ${connection.location_name}: ${auditDifferences.length} owned Winerim products require a differential update.`);
      }
      newlyIntroducedProducts = expected
        .filter((item) => auditByProductId.get(item.productId)?.status === "MISSING")
        .map((item) => item.productId);

      const signatureGroups = new Map();
      for (const wine of wines) {
        const formats = expectedFormats(wine).filter((format) => {
          const expectedId = productId(wine.winerim_id, format);
          return auditByProductId.get(expectedId)?.status === "MISSING";
        });
        if (formats.length === 0) continue;
        const signature = formats.join("+");
        const ids = signatureGroups.get(signature) || [];
        ids.push(String(wine.winerim_id));
        signatureGroups.set(signature, ids);
      }
      for (const [signature, ids] of signatureGroups) {
        for (const batch of chunks(ids, 20)) {
          assertActivationLock();
          await invoke("agora-proxy", {
            action: "queue-xml-outbound", connectionId: connection.id,
            winerimWineIds: batch, formatTypes: signature.split("+"),
          });
        }
      }
      await processQueue(connection.id);
      masterSync = await invoke("agora-proxy", { action: "sync-master-data", connectionId: connection.id, preserveWriteMode: true });

      const autoConfig = {
        ...(connection.provider_config || {}),
        activation_status: "VERIFYING",
        read_only_onboarding: false,
        legacy_visibility_policy: providerConfigBefore.legacy_visibility_policy || "VISIBLE_DURING_PILOT",
        price_write_scope: "SELECTED_SALE_CENTERS",
        sales_timezone: "Europe/Madrid",
        business_day_cutoff_hour: Number(providerConfigBefore.business_day_cutoff_hour ?? 12),
        auto_push_update_diff_enabled: true,
        open_tickets_sync_enabled: true,
        open_tickets_stock_sync_enabled: true,
        intraday_sales_sync_enabled: true,
        open_tickets_min_line_age_minutes: 2,
        open_tickets_stock_current_day_only: true,
        open_tickets_restore_stale_previous_days_enabled:
          providerConfigBefore.open_tickets_restore_stale_previous_days_enabled ?? false,
        stock_sync_not_before: providerConfigBefore.stock_sync_not_before || isoDay(new Date()),
        stock_sync_not_before_at: providerConfigBefore.stock_sync_not_before_at || activationStockStartAt,
      };
      delete autoConfig.auto_push_update_winerim_ids;
      delete autoConfig.auto_push_update_canary_winerim_ids;
      connection = await patchConnection(connection.id, {
        auto_push_on_create: true,
        auto_push_on_update: true,
        auto_push_bottle: true,
        auto_push_glass: true,
        auto_push_verified_ready: true,
        require_manual_review_before_push: false,
        provider_config: autoConfig,
      });

      // Keep each differential evaluation small: large catalogs can exhaust the
      // hosted Edge Function CPU while generating XML and checking ownership.
      for (const batch of chunks(wines.map((wine) => String(wine.winerim_id)), 10)) {
        await invoke("agora-proxy", {
          action: "evaluate-auto-push", connectionId: connection.id,
          winerimWineIds: batch, eventType: "UPDATE",
        });
      }
      await processQueue(connection.id);
      await invoke("agora-proxy", { action: "sync-master-data", connectionId: connection.id, preserveWriteMode: true });

      let finalCatalogAudit = await invoke("agora-proxy", {
        action: "audit-winerim-products",
        connectionId: connection.id,
        winerimWineIds: wines.map((wine) => String(wine.winerim_id)),
      });
      if (Number(finalCatalogAudit.unownedExisting || 0) > 0) {
        const currentTracking = await restAll(
          `winerim_push_tracking?connection_id=eq.${connection.id}&source=eq.WINERIM&select=agora_product_id,winerim_wine_id,format`,
        );
        const currentTrackingKeys = new Set(
          currentTracking
            .filter((tracking) => tracking.agora_product_id)
            .map((tracking) =>
              `${tracking.agora_product_id}:${tracking.winerim_wine_id}:${String(tracking.format || "").toUpperCase()}`
            ),
        );
        const finalRecoverableMatches = (finalCatalogAudit.details || []).filter((item) =>
          item.status === "MATCH" &&
          !item.ownedByWinerim &&
          currentTrackingKeys.has(
            `${item.productId}:${item.expectedWinerimWineId}:${String(item.expectedFormat || "").toUpperCase()}`
          )
        );
        if (finalRecoverableMatches.length > 0) {
          console.log(
            `[repair] ${connection.location_name}: recovering ${finalRecoverableMatches.length} exact products after queue verification.`,
          );
          await recoverExactOwnership(finalRecoverableMatches);
          finalCatalogAudit = await invoke("agora-proxy", {
            action: "audit-winerim-products",
            connectionId: connection.id,
            winerimWineIds: wines.map((wine) => String(wine.winerim_id)),
          });
        }
      }
      if (
        Number(finalCatalogAudit.missing || 0) > 0 ||
        Number(finalCatalogAudit.different || 0) > 0 ||
        Number(finalCatalogAudit.unownedExisting || 0) > 0
      ) {
        throw new Error(`Fresh Agora catalog audit failed: ${JSON.stringify({
          missing: finalCatalogAudit.missing,
          different: finalCatalogAudit.different,
          unownedExisting: finalCatalogAudit.unownedExisting,
        })}`);
      }

      const [freshMasterRows, freshMappings, freshTracking, activeTasks] = await Promise.all([
        restAll(`agora_master_data?connection_id=eq.${connection.id}&select=products_summary_json,families_json,fetched_at`),
        restAll(`product_mappings?connection_id=eq.${connection.id}&status=eq.CONFIRMED&select=provider_product_id,winerim_wine_id,format_type,status`),
        restAll(`winerim_push_tracking?connection_id=eq.${connection.id}&select=winerim_wine_id,format,agora_product_id,agora_family_id,source,sync_status,last_error,verified_at`),
        restAll(`outbound_tasks?connection_id=eq.${connection.id}&status=in.(QUEUED,RUNNING)&select=id,status,task_type,created_at`),
      ]);
      const freshProducts = freshMasterRows[0]?.products_summary_json || [];
      const freshProductById = new Map(freshProducts.map((product) => [String(product.Id), product]));
      newlyIntroducedProducts = newlyIntroducedProducts.filter((id) => freshProductById.has(id));
      const mappingKeys = new Set(freshMappings.map((mapping) => `${mapping.winerim_wine_id}:${mapping.format_type}:${mapping.provider_product_id}`));
      const trackingByKey = new Map(freshTracking.map((tracking) => [`${tracking.winerim_wine_id}:${tracking.format}`, tracking]));
      const expectedTrackingKeys = new Set(expected.map((item) => `${item.wine.winerim_id}:${item.format}`));
      const failures = [];
      for (const item of expected) {
        const product = freshProductById.get(item.productId);
        const tracking = trackingByKey.get(`${item.wine.winerim_id}:${item.format}`);
        if (!product) failures.push({ code: "PRODUCT_MISSING", id: item.productId, wine: item.wine.name, format: item.format });
        else {
          if (String(product.FamilyId || "") !== item.familyId) failures.push({ code: "FAMILY_MISMATCH", id: item.productId, expected: item.familyId, actual: product.FamilyId });
          if (asBoolean(product.UseAsDirectSale)) failures.push({ code: "DIRECT_SALE_ENABLED", id: item.productId });
          if (!asBoolean(product.SaleableAsMain)) failures.push({ code: "NOT_SALEABLE_AS_MAIN", id: item.productId });
        }
        if (!mappingKeys.has(`${item.wine.winerim_id}:${item.format}:${item.productId}`)) failures.push({ code: "MAPPING_MISSING", id: item.productId });
        if (tracking?.sync_status !== "VERIFIED") failures.push({ code: "NOT_VERIFIED", id: item.productId, status: tracking?.sync_status || null, error: tracking?.last_error || null });
      }
      for (const tracking of freshTracking) {
        const key = `${tracking.winerim_wine_id}:${tracking.format}`;
        if (tracking.source !== "WINERIM" || expectedTrackingKeys.has(key) || !tracking.agora_product_id) continue;
        const product = freshProductById.get(String(tracking.agora_product_id));
        if (product && (asBoolean(product.UseAsDirectSale) || asBoolean(product.SaleableAsMain))) {
          failures.push({
            code: "RETIRED_FORMAT_STILL_SALEABLE",
            id: String(tracking.agora_product_id),
            winerimId: tracking.winerim_wine_id,
            format: tracking.format,
          });
        }
      }
      if (activeTasks.length > 0) failures.push({ code: "ACTIVE_QUEUE", count: activeTasks.length });
      if (failures.length > 0) throw new Error(`Catalog verification failed (${failures.length}): ${JSON.stringify(failures.slice(0, 15))}`);

      const verifyResult = await invoke("agora-proxy", { action: "verify-products", connectionId: connection.id }, { allowFailure: true });
      if (verifyResult?.success === false || Number(verifyResult?.missingCentralPrice || 0) > 0) {
        throw new Error(`Price/scope verification failed: ${JSON.stringify(verifyResult).slice(0, 900)}`);
      }

      await invoke("agora-proxy", {
        action: "set-family-visibility", connectionId: connection.id,
        updates: allPilotFamilies.map((family) => ({ familyId: String(family.id), showInPos: true })),
      });

      const today = isoDay(new Date());
      const yesterday = isoDay(new Date(Date.now() - 86_400_000));
      const shouldEnable = originalConnection.enabled === true || args.enableAfterVerification;
      const prospectiveSalesCursor = originalConnection.enabled === true && originalConnection.last_business_day_synced
        ? originalConnection.last_business_day_synced
        : yesterday;
      const pendingStatus = shouldEnable ? "LIVE_PENDING_SALE_CANARY" : "CATALOG_READY_PENDING_SALE";
      const finalConfig = { ...autoConfig, activation_status: pendingStatus };
      assertActivationLock();
      connection = await patchConnection(connection.id, {
        enabled: shouldEnable,
        sync_mode: "BIDIRECTIONAL",
        sync_frequency_minutes: 5,
        backfill_days: 1,
        catalog_sync_enabled: shouldEnable,
        auto_push_on_create: shouldEnable,
        auto_push_on_update: shouldEnable,
        auto_push_verified_ready: shouldEnable,
        last_business_day_synced: prospectiveSalesCursor,
        circuit_breaker_paused_until: null,
        circuit_breaker_reason: null,
        consecutive_failures: 0,
        provider_config: finalConfig,
      });
      const finalTest = await invoke("agora-proxy", { action: "test", connectionId: connection.id });
      if (finalTest?.success === false) throw new Error("Final Agora health test failed.");
      const firstOpenTicketsSync = shouldEnable
        ? await invoke("agora-proxy", { action: "sync-open-tickets", connectionId: connection.id })
        : null;

      // Historical failure counts are report-only. Keep the activation result
      // independent from an unbounded scan of the shared outbound table.
      const failureWindowDays = 30;
      const failureCutoff = new Date(Date.now() - failureWindowDays * 86_400_000).toISOString();
      let recentFailures = [];
      let failureAuditError = null;
      try {
        recentFailures = await restAll(
          `outbound_tasks?connection_id=eq.${connection.id}&status=in.(FAILED,BLOCKED)&created_at=gte.${encodeURIComponent(failureCutoff)}&select=id,status,task_type,last_error,blocked_reason,created_at&order=created_at.desc`,
        );
      } catch (error) {
        failureAuditError = error instanceof Error ? error.message : String(error);
        console.warn(`[warning] ${connection.location_name}: recent failure count unavailable: ${failureAuditError}`);
      }
      const result = {
        key: definition.key,
        locationName: connection.location_name,
        status: pendingStatus,
        expectedFormats: expected.length,
        wines: wines.length,
        familyCount: allPilotFamilies.length,
        legacyChanged: false,
        activeQueue: 0,
        historicalFailedOrBlockedTasks: failureAuditError ? null : recentFailures.length,
        historicalFailureWindowDays: failureWindowDays,
        historicalFailureAuditError: failureAuditError,
        catalogAudit: {
          expected: finalCatalogAudit.expected,
          matched: finalCatalogAudit.matched,
          missing: finalCatalogAudit.missing,
          different: finalCatalogAudit.different,
        },
        openTicketsProbe: redact(openTicketsProbe),
        firstOpenTicketsSync: redact(firstOpenTicketsSync),
        saleTestPending: true,
      };
      finalResults.push(result);
      await writeFile(path.join(snapshotDir, `${definition.key}-result.json`), JSON.stringify(result, null, 2));
      await releaseLocks();
      console.log(`[ready] ${connection.location_name}: ${expected.length} formats verified; status=${pendingStatus}; real sale test pending.`);

    } catch (error) {
      console.error(`[failed] ${connection.location_name}: ${error.message}`);
      try {
        await captureCreatedRows();
        for (const idBatch of chunks(Array.from(createdRowIds.tasks), 100)) {
          await rest("PATCH", `outbound_tasks?id=in.(${idBatch.join(",")})&status=in.(QUEUED,RUNNING)`, {
            status: "BLOCKED",
            blocked_reason: "ACTIVATION_ROLLBACK_CANCELLED",
            last_error: "Cancelled by staged activation rollback before sign-off.",
            next_retry_at: null,
          });
        }
        if (newlyIntroducedProducts.length > 0) {
          for (const batch of chunks(newlyIntroducedProducts, 100)) {
            await invoke("agora-proxy", {
              action: "set-product-visibility", connectionId: connection.id,
              updates: batch.map((id) => ({ productId: id, visible: false })),
            }, { allowFailure: true });
          }
        }
        if (touchedPilotFamilies.length > 0) {
          await invoke("agora-proxy", {
            action: "set-family-visibility", connectionId: connection.id,
            updates: touchedPilotFamilies.map((family) => ({
              familyId: String(family.id),
              showInPos: familyVisibilityBefore.get(String(family.id)) === true,
            })),
          }, { allowFailure: true });
        }
        if (snapshot?.connection) {
          // agora_master_data and winerim_wines are authoritative read-through
          // caches refreshed from each source. Keeping a newer successful read is
          // safer than restoring stale catalog data during a write rollback.
          const deleteExactRows = async (table, ids) => {
            for (const idBatch of chunks(Array.from(ids), 100)) {
              await rest("DELETE", `${table}?id=in.(${idBatch.join(",")})`);
            }
          };
          const restoreRows = async (table, rows) => {
            for (const rowBatch of chunks(rows || [], 250)) {
              await rest("POST", `${table}?on_conflict=id`, rowBatch, {
                Prefer: "resolution=merge-duplicates,return=minimal",
              });
            }
          };
          await deleteExactRows("wine_type_family_mappings", createdRowIds.familyMappings);
          await deleteExactRows("product_mappings", createdRowIds.productMappings);
          await deleteExactRows("winerim_push_tracking", createdRowIds.tracking);
          await deleteExactRows("provider_capabilities", createdRowIds.capabilities);
          await restoreRows("wine_type_family_mappings", snapshot.familyMappings);
          await restoreRows("product_mappings", snapshot.productMappings);
          await restoreRows("winerim_push_tracking", snapshot.tracking);
          await restoreRows("provider_capabilities", snapshot.capabilities);
          const restore = Object.fromEntries(MUTABLE_CONNECTION_FIELDS.map((field) => [field, snapshot.connection[field]]));
          await patchConnection(connection.id, restore);
        } else if (initialConnection.__createdByRunbook) {
          await patchConnection(connection.id, {
            enabled: false,
            sync_mode: "PULL_ONLY",
            catalog_sync_enabled: false,
            auto_push_on_create: false,
            auto_push_on_update: false,
            auto_push_verified_ready: false,
            provider_config: { read_only_onboarding: true, activation_status: "FAILED_ROLLED_BACK" },
          });
        }
      } catch (rollbackError) {
        console.error(`[rollback-warning] ${connection.location_name}: ${rollbackError.message}`);
      }
      await releaseLocks();
      const failedResult = { key: definition.key, locationName: connection.location_name, status: "FAILED_ROLLED_BACK", error: error.message };
      finalResults.push(failedResult);
      await writeFile(path.join(snapshotDir, `${definition.key}-result.json`), JSON.stringify(failedResult, null, 2));
    }
  }

  await writeFile(path.join(snapshotDir, "summary.json"), JSON.stringify(finalResults, null, 2));
  console.log(`\n[summary] ${snapshotDir}`);
  for (const result of finalResults) console.log(`${result.status}\t${result.locationName}\t${result.expectedFormats || 0}`);
  if (finalResults.some((result) => !["LIVE_PENDING_SALE_CANARY", "CATALOG_READY_PENDING_SALE"].includes(result.status))) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[fatal] ${error.message}`);
  process.exitCode = 1;
});
