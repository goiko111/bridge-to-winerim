#!/usr/bin/env node

/**
 * Controlled Agora catalog reconciliation.
 *
 * Read-only by default. Production writes require both --apply and the
 * explicit confirmation flag. The script only mutates Winerim-owned products,
 * refuses to start with an active queue, processes small batches, and performs
 * a forced fresh audit after every batch.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_ENV_FILE = path.resolve(".env");
const CONFIRM_FLAG = "--confirm-production-catalog-reconciliation";
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 520, 522, 523, 524]);

function parseArgs(argv) {
  const args = {
    apply: false,
    confirmed: false,
    hideRetired: false,
    recoverExactOwnership: false,
    recoverLegacyPrefixOwnership: false,
    directXmlBatches: false,
    ownershipOverrides: [],
    allowLargeCatalog: false,
    batchSize: 10,
    maxChanges: 250,
    targets: [],
    envFile: process.env.LOVABLE_ENV_FILE || DEFAULT_ENV_FILE,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg === CONFIRM_FLAG) args.confirmed = true;
    else if (arg === "--hide-retired") args.hideRetired = true;
    else if (arg === "--recover-exact-ownership") args.recoverExactOwnership = true;
    else if (arg === "--recover-legacy-prefix-ownership") args.recoverLegacyPrefixOwnership = true;
    else if (arg === "--direct-xml-batches") args.directXmlBatches = true;
    else if (arg === "--ownership-override") args.ownershipOverrides.push(String(argv[++index] || ""));
    else if (arg === "--allow-large-catalog") args.allowLargeCatalog = true;
    else if (arg === "--batch-size") args.batchSize = Number(argv[++index]);
    else if (arg === "--max-changes") args.maxChanges = Number(argv[++index]);
    else if (arg === "--target") args.targets.push(...String(argv[++index] || "").split(",").filter(Boolean));
    else if (arg === "--env-file") args.envFile = argv[++index];
    else if (arg === "--help") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.batchSize) || args.batchSize < 1 || args.batchSize > 25) {
    throw new Error("--batch-size must be an integer between 1 and 25");
  }
  if (!Number.isInteger(args.maxChanges) || args.maxChanges < 1) {
    throw new Error("--max-changes must be a positive integer");
  }
  return args;
}

function usage() {
  return `Usage:
  node scripts/reconcile-agora-catalog.mjs --target "Casa Nene,Kava"
  node scripts/reconcile-agora-catalog.mjs --target "Casa Nene" --apply ${CONFIRM_FLAG} --hide-retired --recover-exact-ownership
  node scripts/reconcile-agora-catalog.mjs --target "Sa Vida" --apply ${CONFIRM_FLAG} --direct-xml-batches --batch-size 10 --allow-large-catalog
  node scripts/reconcile-agora-catalog.mjs --target "Sa Vida" --apply ${CONFIRM_FLAG} --recover-legacy-prefix-ownership --ownership-override "665339:165339:BOTTLE"

Default mode is strictly read-only. Catalogs with more than 250 required
changes also require --allow-large-catalog. Credentials are never printed.`;
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
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function canonicalProductName(value, format) {
  const normalized = normalize(value);
  const prefixes = format === "GLASS"
    ? ["copa ", "c "]
    : format === "MAGNUM"
    ? ["magnum ", "m "]
    : ["botella ", "bot ", "b "];
  const prefix = prefixes.find((candidate) => normalized.startsWith(candidate));
  return prefix ? normalized.slice(prefix.length).trim() : normalized;
}

function ownershipKey(item) {
  return `${item.productId}:${item.expectedWinerimWineId}:${String(item.expectedFormat || "").toUpperCase()}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function configuredHiddenGlassVariants(connection) {
  const providerConfig = connection?.provider_config && typeof connection.provider_config === "object"
    ? connection.provider_config
    : {};
  if (providerConfig.publish_hidden_glass_variants !== true) return [];
  const configured = Array.isArray(providerConfig.agora_hidden_glass_variants)
    ? providerConfig.agora_hidden_glass_variants
    : [];
  return configured.flatMap((item) => {
    const winerimId = String(item?.winerim_id || item?.winerimWineId || "").trim();
    const name = String(item?.name || "").trim();
    const glassSalePrice = Number(item?.glass_sale_price ?? item?.price ?? 0);
    const bottleSalePrice = Number(item?.bottle_sale_price ?? 0);
    if (!winerimId || !name || !positive(glassSalePrice) || item?.enabled === false) return [];
    return [{
      winerim_id: winerimId,
      name,
      wine_type: item?.wine_type ? String(item.wine_type).toLowerCase() : null,
      glass_sale_price: glassSalePrice,
      bottle_sale_price: positive(bottleSalePrice) ? bottleSalePrice : undefined,
      publish_bottle: item?.publish_bottle === true,
    }];
  });
}

function mergeConfiguredHiddenGlassVariants(connection, wineRows) {
  const byId = new Map(wineRows.map((wine) => [String(wine.winerim_id), { ...wine }]));
  for (const configured of configuredHiddenGlassVariants(connection)) {
    const existing = byId.get(configured.winerim_id) || {};
    const bottleSalePrice = configured.bottle_sale_price;
    const allowInactiveBottle = configured.publish_bottle === true && positive(bottleSalePrice);
    byId.set(configured.winerim_id, {
      ...existing,
      winerim_id: configured.winerim_id,
      name: configured.name,
      wine_type: configured.wine_type || existing.wine_type || null,
      is_active: existing.is_active ?? false,
      glass_sale_price: configured.glass_sale_price,
      bottle_sale_price: allowInactiveBottle ? bottleSalePrice : existing.bottle_sale_price ?? null,
      _agora_allow_inactive_glass: true,
      _agora_allow_inactive_bottle: allowInactiveBottle,
    });
  }
  return [...byId.values()];
}

function expectedFormats(wine) {
  const formats = [];
  if ((wine.is_active !== false || wine._agora_allow_inactive_bottle === true) && positive(wine.bottle_sale_price)) {
    formats.push("BOTTLE");
  }
  if ((wine.is_active !== false || wine._agora_allow_inactive_glass === true) && positive(wine.glass_sale_price)) {
    formats.push("GLASS");
  }
  if (wine.is_active !== false && positive(wine.magnum_sale_price)) formats.push("MAGNUM");
  return formats;
}

function formatIsUnavailable(wine, format) {
  if (!wine) return true;
  if (wine.is_active === false && !(
    (format === "GLASS" && wine._agora_allow_inactive_glass === true) ||
    (format === "BOTTLE" && wine._agora_allow_inactive_bottle === true)
  )) return true;
  if (format === "BOTTLE") return !positive(wine.bottle_sale_price);
  if (format === "GLASS") return !positive(wine.glass_sale_price);
  if (format === "MAGNUM") return !positive(wine.magnum_sale_price);
  return true;
}

function field(row, ...names) {
  for (const name of names) {
    if (row && row[name] !== undefined && row[name] !== null) return row[name];
  }
  return null;
}

function truthy(value) {
  return value === true || value === 1 || ["true", "1", "yes"].includes(String(value || "").toLowerCase());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.targets.length === 0) throw new Error("At least one --target is required");
  if (args.apply && !args.confirmed) throw new Error(`Production writes require ${CONFIRM_FLAG}`);

  const fileEnv = parseDotEnv(await readFile(args.envFile, "utf8"));
  const env = { ...fileEnv, ...process.env };
  const backendUrl = String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || "").replace(/\/$/, "");
  const backendKey = env.SUPABASE_SERVICE_ROLE_KEY || env.LOVABLE_CLOUD_SERVICE_ROLE_KEY ||
    env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "";
  if (!backendUrl || !backendKey) throw new Error("Missing Lovable Cloud URL/key in the selected env file");

  const authHeaders = {
    apikey: backendKey,
    Authorization: `Bearer ${backendKey}`,
    "Content-Type": "application/json",
  };

  const request = async (url, options = {}, attempts = 4) => {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 150_000);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        const text = await response.text();
        let data = null;
        if (text) {
          try { data = JSON.parse(text); } catch { data = text; }
        }
        if (response.ok) return { response, data };
        if (!RETRYABLE_STATUS.has(response.status) || attempt === attempts) {
          throw new Error(`HTTP ${response.status}: ${typeof data === "string" ? data.slice(0, 800) : JSON.stringify(data).slice(0, 800)}`);
        }
        lastError = new Error(`HTTP ${response.status}`);
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

  const rest = async (method, resource, body, headers = {}) => {
    const { data, response } = await request(`${backendUrl}/rest/v1/${resource}`, {
      method,
      headers: { ...authHeaders, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: 60_000,
    });
    return { data, response };
  };

  const restAll = async (resource, pageSize = 1000) => {
    const rows = [];
    for (let offset = 0; ; offset += pageSize) {
      const { data } = await rest("GET", resource, undefined, { Range: `${offset}-${offset + pageSize - 1}` });
      if (!Array.isArray(data)) throw new Error(`Expected an array from ${resource}`);
      rows.push(...data);
      if (data.length < pageSize) break;
    }
    return rows;
  };

  const invoke = async (action, body, { allowFailure = false } = {}) => {
    const { data } = await request(`${backendUrl}/functions/v1/agora-proxy`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ action, ...body }),
      timeoutMs: 180_000,
    });
    if (!allowFailure && data && typeof data === "object" && data.success === false) {
      throw new Error(`${action}: ${data.error || data.reason || JSON.stringify(data).slice(0, 800)}`);
    }
    return data;
  };

  const allConnections = await restAll("pos_connections?provider=eq.agora&select=*&order=id.asc");
  const targets = args.targets.map((requested) => {
    const normalized = normalize(requested);
    const exact = allConnections.find((row) => normalize(row.location_name) === normalized);
    const partial = allConnections.filter((row) => normalize(row.location_name).includes(normalized));
    const connection = exact || (partial.length === 1 ? partial[0] : null);
    if (!connection) throw new Error(`Agora connection not found or ambiguous: ${requested}`);
    return connection;
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = path.resolve("docs/operations", `agora-catalog-reconciliation-${stamp}`);
  if (args.apply) await mkdir(reportDir, { recursive: true });
  const results = [];

  const activeQueue = async (connectionId) => restAll(
    `outbound_tasks?connection_id=eq.${connectionId}&status=in.(QUEUED,RUNNING)&select=id,task_type,status,created_at,payload_json&order=id.asc`,
  );

  const processQueue = async (connectionId) => {
    let last = null;
    for (let attempt = 0; attempt < 120; attempt++) {
      last = await invoke("process-xml-outbound-queue", { connectionId, serverLoop: false });
      if (last?.breakerTripped || last?.reason === "circuit_breaker_active") {
        throw new Error(`Circuit breaker stopped queue processing: ${JSON.stringify(last).slice(0, 600)}`);
      }
      const remaining = await activeQueue(connectionId);
      if (remaining.length === 0) return last;
      await sleep(900);
    }
    throw new Error(`Queue did not drain: ${JSON.stringify(last).slice(0, 600)}`);
  };

  for (const connection of targets) {
    const startedAt = new Date().toISOString();
    const result = {
      connectionId: connection.id,
      locationName: connection.location_name,
      mode: args.apply ? "APPLY" : "READ_ONLY",
      startedAt,
      connection: {
        enabled: connection.enabled,
        writeMode: connection.write_mode,
        autoPushOnCreate: connection.auto_push_on_create,
        autoPushOnUpdate: connection.auto_push_on_update,
        autoPushVerifiedReady: connection.auto_push_verified_ready,
        breakerPausedUntil: connection.circuit_breaker_paused_until,
        activationStatus: connection.provider_config?.activation_status || null,
      },
    };
    console.log(`\n[${args.apply ? "apply" : "audit"}] ${connection.location_name}`);
    try {
      const queueBefore = await activeQueue(connection.id);
      result.activeQueueBefore = queueBefore.length;
      if (args.apply && queueBefore.length > 0) {
        throw new Error(`Refusing to reconcile with ${queueBefore.length} pre-existing active tasks`);
      }

      const auditBefore = await invoke("audit-winerim-products", { connectionId: connection.id });
      result.auditBefore = {
        expected: auditBefore.expected,
        matched: auditBefore.matched,
        missing: auditBefore.missing,
        different: auditBefore.different,
        unownedExisting: auditBefore.unownedExisting,
      };
      result.differencesBefore = (auditBefore.details || []).filter((item) => item.status !== "MATCH");
      console.log(`  fresh: ${auditBefore.matched}/${auditBefore.expected} match, missing=${auditBefore.missing}, different=${auditBefore.different}, unowned=${auditBefore.unownedExisting}`);

      const cachedWineRows = await restAll(
        `winerim_wines?connection_id=eq.${connection.id}&select=winerim_id,name,is_active,bottle_sale_price,glass_sale_price,magnum_sale_price&order=winerim_id.asc`,
      );
      const wineRows = mergeConfiguredHiddenGlassVariants(connection, cachedWineRows);
      const wineById = new Map(wineRows.map((wine) => [String(wine.winerim_id), wine]));
      result.eligibleFormats = wineRows.reduce((sum, wine) => sum + expectedFormats(wine).length, 0);

      if (!args.apply) {
        result.status = Number(auditBefore.missing || 0) === 0 && Number(auditBefore.different || 0) === 0
          ? "PASS"
          : "NEEDS_RECONCILIATION";
        results.push(result);
        continue;
      }

      const exactRecoverable = [];
      const legacyPrefixRecoverable = [];
      const overrideRecoverable = [];
      if (args.recoverExactOwnership || args.recoverLegacyPrefixOwnership || args.ownershipOverrides.length > 0) {
        const allTracking = await restAll(
          `winerim_push_tracking?connection_id=eq.${connection.id}&source=eq.WINERIM&select=agora_product_id,winerim_wine_id,format,source,sync_status&order=winerim_wine_id.asc,format.asc`,
        );
        const allMappings = await restAll(
          `product_mappings?connection_id=eq.${connection.id}&select=provider_product_id,winerim_wine_id,format_type,status,match_method&order=provider_product_id.asc`,
        );
        const priorTrackingKeys = new Set(allTracking
          .filter((row) => row.agora_product_id)
          .map((row) => `${row.agora_product_id}:${row.winerim_wine_id}:${String(row.format || "").toUpperCase()}`));
        const mappingByProductId = new Map();
        for (const row of allMappings) {
          const rows = mappingByProductId.get(String(row.provider_product_id)) || [];
          rows.push(row);
          mappingByProductId.set(String(row.provider_product_id), rows);
        }
        const requestedOverrides = new Set(args.ownershipOverrides);
        for (const item of auditBefore.details || []) {
          const key = ownershipKey(item);
          if (args.recoverExactOwnership && item.status === "MATCH" && !item.ownedByWinerim && priorTrackingKeys.has(key)) {
            exactRecoverable.push(item);
          }
          if (args.recoverLegacyPrefixOwnership && item.status === "DIFFERENT" && !item.ownedByWinerim &&
              canonicalProductName(item.actualName, item.expectedFormat) === canonicalProductName(item.expectedName, item.expectedFormat)) {
            legacyPrefixRecoverable.push(item);
          }
          if (requestedOverrides.has(key) && item.status === "DIFFERENT" && !item.ownedByWinerim) {
            overrideRecoverable.push(item);
          }
        }
        const foundOverrideKeys = new Set(overrideRecoverable.map(ownershipKey));
        const missingOverrides = [...requestedOverrides].filter((key) => !foundOverrideKeys.has(key));
        if (missingOverrides.length > 0) {
          throw new Error(`Ownership overrides did not match current unowned differences: ${missingOverrides.join(",")}`);
        }
        const ownershipRecoverable = [...new Map(
          [...exactRecoverable, ...legacyPrefixRecoverable, ...overrideRecoverable].map((item) => [ownershipKey(item), item]),
        ).values()];
        for (const item of ownershipRecoverable) {
          const conflicts = (mappingByProductId.get(String(item.productId)) || []).filter((row) =>
            row.status === "CONFIRMED" && (
              String(row.winerim_wine_id) !== String(item.expectedWinerimWineId) ||
              String(row.format_type || "").toUpperCase() !== String(item.expectedFormat || "").toUpperCase()
            )
          );
          if (conflicts.length > 0) {
            throw new Error(`Ownership recovery conflict for Agora product ${item.productId}`);
          }
        }
        if (ownershipRecoverable.length > 0) {
          const now = new Date().toISOString();
          const mappings = ownershipRecoverable.map((item) => ({
            connection_id: connection.id,
            provider_product_id: String(item.productId),
            provider_product_name: String(item.actualName || item.expectedName || ""),
            winerim_wine_id: String(item.expectedWinerimWineId),
            winerim_wine_name: wineById.get(String(item.expectedWinerimWineId))?.name || String(item.expectedName || ""),
            match_method: overrideRecoverable.includes(item)
              ? "XML_IMPORT_OWNERSHIP_RECOVERY_EXPLICIT"
              : legacyPrefixRecoverable.includes(item)
              ? "XML_IMPORT_OWNERSHIP_RECOVERY_LEGACY_PREFIX"
              : "XML_IMPORT_OWNERSHIP_RECOVERY",
            match_score: 100,
            match_reasons: overrideRecoverable.includes(item)
              ? ["Explicit reviewed ownership override", "Deterministic Winerim product ID"]
              : legacyPrefixRecoverable.includes(item)
              ? ["Exact canonical name after legacy format prefix removal", "Deterministic Winerim product ID"]
              : ["Exact fresh catalog match", "Prior Winerim tracking for the same product and format"],
            status: "CONFIRMED",
            format_type: String(item.expectedFormat || "").toUpperCase(),
            agora_product_id: String(item.productId),
            last_synced_at: now,
            last_sync_error: null,
          }));
          const tracking = ownershipRecoverable.map((item) => ({
            connection_id: connection.id,
            winerim_wine_id: String(item.expectedWinerimWineId),
            format: String(item.expectedFormat || "").toUpperCase(),
            agora_product_id: String(item.productId),
            agora_family_id: item.expectedFamilyId ? String(item.expectedFamilyId) : null,
            source: "WINERIM",
            sync_status: "VERIFIED",
            task_id: null,
            last_error: null,
            pushed_at: now,
            verified_at: now,
          }));
          await rest("POST", "product_mappings?on_conflict=connection_id,provider_product_id", mappings, {
            Prefer: "resolution=merge-duplicates,return=minimal",
          });
          await rest("POST", "winerim_push_tracking?on_conflict=connection_id,winerim_wine_id,format", tracking, {
            Prefer: "resolution=merge-duplicates,return=minimal",
          });
        }
      }
      result.recoveredExactOwnership = exactRecoverable.length;
      result.recoveredLegacyPrefixOwnership = legacyPrefixRecoverable.length;
      result.recoveredExplicitOwnership = overrideRecoverable.length;

      const recoveredOwnershipCount = exactRecoverable.length + legacyPrefixRecoverable.length + overrideRecoverable.length;
      const freshAfterRecovery = recoveredOwnershipCount > 0
        ? await invoke("audit-winerim-products", { connectionId: connection.id })
        : auditBefore;
      const mutableDetails = (freshAfterRecovery.details || []).filter((item) =>
        item.status === "MISSING" || (item.status === "DIFFERENT" && item.ownedByWinerim)
      ).sort((left, right) => {
        const transitionPriority = (item) => {
          const expectedName = String(item.expectedName || "").trim();
          const actualName = String(item.actualName || "").trim();
          if (actualName && expectedName.startsWith(`${actualName} `)) return 0;
          if (expectedName && actualName.startsWith(`${expectedName} `)) return 2;
          return 1;
        };
        return transitionPriority(left) - transitionPriority(right);
      });
      const unsafeUnowned = (freshAfterRecovery.details || []).filter((item) =>
        item.status !== "MISSING" && item.status !== "MATCH" && !item.ownedByWinerim
      );
      result.unsafeUnowned = unsafeUnowned;
      if (unsafeUnowned.length > 0) {
        throw new Error(`${unsafeUnowned.length} non-matching existing products do not have proven Winerim ownership`);
      }
      if (mutableDetails.length > args.maxChanges && !args.allowLargeCatalog) {
        throw new Error(`${mutableDetails.length} changes exceed safety limit ${args.maxChanges}; use --allow-large-catalog after review`);
      }

      const formatsByWine = new Map();
      for (const item of mutableDetails) {
        if (!item.expectedWinerimWineId || !item.expectedFormat) continue;
        const formats = formatsByWine.get(String(item.expectedWinerimWineId)) || new Set();
        formats.add(String(item.expectedFormat).toUpperCase());
        formatsByWine.set(String(item.expectedWinerimWineId), formats);
      }
      const groups = new Map();
      for (const [wineId, formatSet] of formatsByWine) {
        const signature = [...formatSet].sort().join("+");
        const ids = groups.get(signature) || [];
        ids.push(wineId);
        groups.set(signature, ids);
      }

      result.catalogBatches = [];
      for (const [signature, ids] of groups) {
        for (const batch of chunks(ids, args.batchSize)) {
          let writeResult;
          if (args.directXmlBatches) {
            const directResult = await invoke("xml-import", {
              connectionId: connection.id,
              winerimWineIds: batch,
              formatTypes: signature.split("+"),
              dryRun: false,
            });
            if (directResult?.success !== true) {
              throw new Error(
                `Direct XML batch failed for ${batch.join(",")}: ${JSON.stringify({
                  success: directResult?.success,
                  status: directResult?.status,
                  verification: directResult?.verification,
                }).slice(0, 1200)}`,
              );
            }
            if (directResult?.verification?.success === false) {
              // Agora can acknowledge the import before export-master exposes
              // every changed product. The forced fresh audit below remains the
              // authority; give the read model a short convergence window.
              await sleep(2_000);
            }
            writeResult = {
              mode: "DIRECT_XML_BATCH",
              queued: 0,
              status: directResult.status,
              inlineVerificationSuccess: directResult?.verification?.success !== false,
              verification: directResult.verification?.summary || null,
            };
          } else {
            const queueResult = await invoke("queue-xml-outbound", {
              connectionId: connection.id,
              winerimWineIds: batch,
              formatTypes: signature.split("+"),
            });
            await processQueue(connection.id);
            writeResult = { mode: "OUTBOUND_QUEUE", queued: queueResult.queued };
          }
          const fullBatchAudit = await invoke("audit-winerim-products", {
            connectionId: connection.id,
          });
          const batchWineIds = new Set(batch.map(String));
          const batchFormats = new Set(signature.split("+"));
          const batchDetails = (fullBatchAudit.details || []).filter((item) =>
            batchWineIds.has(String(item.expectedWinerimWineId || "")) &&
            batchFormats.has(String(item.expectedFormat || "").toUpperCase())
          );
          const batchAudit = {
            expected: batchDetails.length,
            matched: batchDetails.filter((item) => item.status === "MATCH").length,
            missing: batchDetails.filter((item) => item.status === "MISSING").length,
            different: batchDetails.filter((item) => item.status === "DIFFERENT").length,
            unownedExisting: batchDetails.filter((item) => item.status === "DIFFERENT" && !item.ownedByWinerim).length,
          };
          result.catalogBatches.push({
            signature,
            wineIds: batch,
            ...writeResult,
            audit: batchAudit,
            issues: batchDetails.filter((item) => item.status !== "MATCH"),
          });
          if (Number(batchAudit.missing || 0) > 0 || Number(batchAudit.different || 0) > 0 || Number(batchAudit.unownedExisting || 0) > 0) {
            throw new Error(`Batch verification failed for ${batch.join(",")}: ${JSON.stringify(result.catalogBatches.at(-1).audit)}`);
          }
        }
      }

      if (args.directXmlBatches && result.catalogBatches.length > 0) {
        const directVerification = await invoke("verify-products", {
          connectionId: connection.id,
        });
        result.directVerification = directVerification;
        if (directVerification?.success === false) {
          throw new Error(
            `Direct XML final verification failed: ${JSON.stringify(directVerification).slice(0, 1200)}`,
          );
        }
      }

      result.retiredCandidates = [];
      if (args.hideRetired) {
        await invoke("sync-master-data", { connectionId: connection.id, preserveWriteMode: true });
        const [trackingRows, masterRows] = await Promise.all([
          restAll(`winerim_push_tracking?connection_id=eq.${connection.id}&source=eq.WINERIM&select=agora_product_id,winerim_wine_id,format,source,sync_status`),
          restAll(`agora_master_data?connection_id=eq.${connection.id}&select=products_summary_json`),
        ]);
        const products = Array.isArray(masterRows[0]?.products_summary_json) ? masterRows[0].products_summary_json : [];
        const productById = new Map(products.map((product) => [String(field(product, "Id", "id", "ProductId", "product_id") || ""), product]));
        const retired = trackingRows.filter((tracking) => {
          const wine = wineById.get(String(tracking.winerim_wine_id));
          if (!formatIsUnavailable(wine, String(tracking.format || "").toUpperCase())) return false;
          const product = productById.get(String(tracking.agora_product_id || ""));
          return Boolean(product && (
            truthy(field(product, "UseAsDirectSale", "useAsDirectSale", "use_as_direct_sale")) ||
            truthy(field(product, "SaleableAsMain", "saleableAsMain", "saleable_as_main"))
          ));
        });
        result.retiredCandidates = retired;

        const retiredByWine = new Map();
        for (const row of retired) {
          const current = retiredByWine.get(String(row.winerim_wine_id)) || [];
          current.push(row);
          retiredByWine.set(String(row.winerim_wine_id), current);
        }
        const hideTasks = [];
        for (const [wineId, rows] of retiredByWine) {
          hideTasks.push({
            connection_id: connection.id,
            task_type: "AGORA_HIDE_PRODUCT",
            status: "QUEUED",
            payload_json: {
              _winerim_wine_id: wineId,
              _product_ids: rows.map((row) => String(row.agora_product_id)),
              _formats: rows.map((row) => String(row.format || "").toUpperCase()),
              _wine_name: wineById.get(wineId)?.name || "Winerim retired product",
              _trigger_source: "CONTROLLED_CATALOG_RECONCILIATION_RETIRED",
            },
          });
        }
        if (hideTasks.length > 0) {
          await rest("POST", "outbound_tasks", hideTasks, { Prefer: "return=minimal" });
          await processQueue(connection.id);
          await invoke("verify-products", { connectionId: connection.id });
        }
      }

      const auditAfter = await invoke("audit-winerim-products", { connectionId: connection.id });
      result.auditAfter = {
        expected: auditAfter.expected,
        matched: auditAfter.matched,
        missing: auditAfter.missing,
        different: auditAfter.different,
        unownedExisting: auditAfter.unownedExisting,
      };
      result.differencesAfter = (auditAfter.details || []).filter((item) => item.status !== "MATCH");
      result.activeQueueAfter = (await activeQueue(connection.id)).length;
      result.status = Number(auditAfter.missing || 0) === 0 && Number(auditAfter.different || 0) === 0 &&
        Number(auditAfter.unownedExisting || 0) === 0 && result.activeQueueAfter === 0
        ? "PASS"
        : "FAIL";
      result.finishedAt = new Date().toISOString();
      console.log(`  final: ${auditAfter.matched}/${auditAfter.expected} match, missing=${auditAfter.missing}, different=${auditAfter.different}, unowned=${auditAfter.unownedExisting}, retiredHidden=${result.retiredCandidates.length}`);
    } catch (error) {
      result.status = "ERROR";
      result.error = error instanceof Error ? error.message : String(error);
      result.finishedAt = new Date().toISOString();
      console.error(`  ERROR: ${result.error}`);
    }
    results.push(result);
    if (args.apply) {
      await writeFile(path.join(reportDir, `${normalize(connection.location_name).replace(/\s+/g, "-")}.json`), `${JSON.stringify(result, null, 2)}\n`);
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? "APPLY" : "READ_ONLY",
    results,
  };
  if (args.apply) await writeFile(path.join(reportDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${JSON.stringify(summary, null, 2)}`);
  if (results.some((result) => result.status === "ERROR" || result.status === "FAIL")) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
