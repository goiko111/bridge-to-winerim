import { sql, type DatabaseAdapter, type DatabaseTransaction } from "../../middleware-api/src/db";
import {
  createWinerimCatalogInventoryClient,
  type HttpRequestPort,
  type HttpTimerPort,
  type SecretTextPort,
  type WinerimCatalogFormat,
  type WinerimCatalogInventoryWine,
} from "../../middleware-runtime/src/adapters/http";
import { canonicalJson, sha256Hex } from "../../middleware-runtime/src/idempotency";
import type { JsonValue } from "../../middleware-runtime/src/contracts";
import type { WinerimCatalogRefreshPort } from "./catalog";

type ExistingWineRow = Record<string, unknown> & {
  winerim_id: unknown;
  name: unknown;
  vintage: unknown;
  wine_type: unknown;
  is_active: unknown;
  bottle_sale_price: unknown;
  bottle_purchase_price: unknown;
  glass_sale_price: unknown;
  glass_cost_price: unknown;
  magnum_sale_price: unknown;
  magnum_purchase_price: unknown;
};

type CatalogChangeStateRow = Record<string, unknown> & {
  winerim_wine_id: unknown;
  format: unknown;
  status: unknown;
  source_fingerprint: unknown;
};

type CatalogEvidenceRow = Record<string, unknown> & {
  connection_evidence: unknown;
  master_evidence: unknown;
  mapping_evidence: unknown;
  provider_product_evidence: unknown;
  tracking_evidence: unknown;
};

type CatalogChangeState = Readonly<{
  status: "PENDING" | "RUNNING" | "SUCCESS" | "BLOCKED";
  sourceFingerprint: string;
}>;

type CatalogEvidence = Readonly<{
  common: JsonValue;
  masterProducts: readonly Record<string, unknown>[];
  mappings: readonly Record<string, unknown>[];
  providerProducts: readonly Record<string, unknown>[];
  tracking: readonly Record<string, unknown>[];
}>;

export type PostgresWinerimCatalogRefreshOptions = Readonly<{
  database: DatabaseAdapter;
  baseUrl: string;
  allowedHosts: readonly string[];
  request: HttpRequestPort;
  timer: HttpTimerPort;
  maxWines?: number;
}>;

const FORMAT_FIELDS = Object.freeze({
  BOTTLE: ["bottle_sale_price", "bottle_purchase_price"],
  GLASS: ["glass_sale_price", "glass_cost_price"],
  MAGNUM: ["magnum_sale_price", "magnum_purchase_price"],
} as const);

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function decimal(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function variant(
  wine: WinerimCatalogInventoryWine,
  format: WinerimCatalogFormat,
): { salePrice: number | null; costPrice: number | null } {
  const selected = wine.variants.find((item) => item.format === format);
  return {
    salePrice: selected?.salePrice ?? null,
    costPrice: selected?.costPrice ?? null,
  };
}

function rowFormats(row: ExistingWineRow): WinerimCatalogFormat[] {
  const formats: WinerimCatalogFormat[] = [];
  if (decimal(row.bottle_sale_price) !== null) formats.push("BOTTLE");
  if (decimal(row.glass_sale_price) !== null) formats.push("GLASS");
  if (decimal(row.magnum_sale_price) !== null) formats.push("MAGNUM");
  return formats;
}

function changeKey(wineId: string, format: WinerimCatalogFormat): string {
  return `${wineId}:${format}`;
}

async function sourceFingerprint(
  wine: WinerimCatalogInventoryWine,
  format: WinerimCatalogFormat,
): Promise<string> {
  return sha256Hex(canonicalJson({
    winerimId: wine.winerimId,
    name: wine.name,
    vintage: wine.vintage,
    wineType: wine.wineType,
    active: wine.active,
    format,
    ...variant(wine, format),
  } as unknown as JsonValue));
}

async function changeFingerprint(
  wine: WinerimCatalogInventoryWine,
  format: WinerimCatalogFormat,
  evidenceFingerprint: string,
): Promise<string> {
  return sha256Hex(canonicalJson({
    sourceFingerprint: await sourceFingerprint(wine, format),
    evidenceFingerprint,
  }));
}

async function existingFingerprint(
  row: ExistingWineRow,
  format: WinerimCatalogFormat,
): Promise<string> {
  const [saleField, costField] = FORMAT_FIELDS[format];
  return sha256Hex(canonicalJson({
    winerimId: text(row.winerim_id),
    name: text(row.name),
    vintage: text(row.vintage) || null,
    wineType: text(row.wine_type).toLowerCase() || null,
    active: row.is_active === true,
    format,
    salePrice: decimal(row[saleField]),
    costPrice: decimal(row[costField]),
  } as unknown as JsonValue));
}

async function loadExisting(
  database: DatabaseAdapter,
  connectionId: string,
): Promise<Map<string, ExistingWineRow>> {
  const result = await database.query<ExistingWineRow>(sql`
    SELECT
      winerim_id, name, vintage, wine_type, is_active,
      bottle_sale_price, bottle_purchase_price,
      glass_sale_price, glass_cost_price,
      magnum_sale_price, magnum_purchase_price
    FROM public.winerim_wines
    WHERE connection_id = ${connectionId}::uuid
    ORDER BY winerim_id
  `);
  return new Map(result.rows.map((row) => [text(row.winerim_id), row]));
}

function jsonValue(value: unknown): JsonValue {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return JSON.parse(JSON.stringify(parsed ?? null)) as JsonValue;
  } catch {
    throw new Error("CATALOG_EVIDENCE_INVALID");
  }
}

function jsonRecord(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function jsonRecords(value: unknown): readonly Record<string, unknown>[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is Record<string, unknown> => (
        !!item && typeof item === "object" && !Array.isArray(item)
      ))
    : [];
}

function evidenceField(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = text(row[key]);
    if (value) return value;
  }
  return "";
}

function expectedProductId(wineId: string, format: WinerimCatalogFormat): string | null {
  const numericWineId = Number(wineId);
  const offset = format === "GLASS" ? 700000 : format === "MAGNUM" ? 900000 : 500000;
  const productId = numericWineId + offset;
  return Number.isSafeInteger(numericWineId) && numericWineId > 0 && Number.isSafeInteger(productId)
    ? String(productId)
    : null;
}

async function evidenceFingerprintFor(
  evidence: CatalogEvidence,
  wineId: string,
  format: WinerimCatalogFormat,
): Promise<string> {
  const ids = new Set<string>();
  const expected = expectedProductId(wineId, format);
  if (expected) ids.add(expected);
  const sameVariant = (row: Record<string, unknown>) => (
    evidenceField(row, "winerimWineId", "winerim_wine_id") === wineId
    && evidenceField(row, "format", "formatType", "format_type", "saleFormat", "sale_format").toUpperCase() === format
  );
  const mappings = evidence.mappings.filter((row) => {
    if (!sameVariant(row)) return false;
    const providerId = evidenceField(row, "providerProductId", "provider_product_id");
    const agoraId = evidenceField(row, "agoraProductId", "agora_product_id");
    if (providerId) ids.add(providerId);
    if (agoraId) ids.add(agoraId);
    return true;
  });
  const tracking = evidence.tracking.filter((row) => {
    if (!sameVariant(row)) return false;
    const agoraId = evidenceField(row, "agoraProductId", "agora_product_id");
    if (agoraId) ids.add(agoraId);
    return true;
  });
  const providerProducts = evidence.providerProducts.filter((row) => {
    const providerId = evidenceField(row, "providerProductId", "provider_product_id");
    const sameWine = evidenceField(row, "winerimWineId", "winerim_wine_id") === wineId;
    const rowFormat = evidenceField(row, "saleFormat", "sale_format", "format", "formatType", "format_type").toUpperCase();
    const relevant = ids.has(providerId) || (sameWine && rowFormat === format);
    if (relevant && providerId) ids.add(providerId);
    return relevant;
  });
  const masterProducts = evidence.masterProducts.filter((row) => ids.has(
    evidenceField(row, "Id", "id", "ProductId", "productId", "provider_product_id"),
  ));
  return sha256Hex(canonicalJson({
    common: evidence.common,
    productIds: [...ids].sort((left, right) => Number(left) - Number(right)),
    masterProducts,
    mappings,
    providerProducts,
    tracking,
  } as unknown as JsonValue));
}

async function loadCatalogEvidence(
  database: DatabaseAdapter,
  connectionId: string,
): Promise<CatalogEvidence> {
  const result = await database.query<CatalogEvidenceRow>(sql`
    SELECT
      jsonb_build_object(
        'defaultFamilyId', connection.default_family_id,
        'catalogFamilyRouting', connection.provider_config->'catalog_family_routing',
        'agoraCatalogFamilyRouting', connection.provider_config->'agora_catalog_family_routing',
        'agoraProductNaming', connection.provider_config->'agora_product_naming',
        'agoraVintageDisambiguationProductIds', connection.provider_config->'agora_vintage_disambiguation_product_ids',
        'agoraProductNameOverrides', connection.provider_config->'agora_product_name_overrides'
      ) AS connection_evidence,
      COALESCE((
        SELECT jsonb_build_object(
          'families', master.families_json,
          'products', master.products_summary_json
        )
        FROM public.agora_master_data master
        WHERE master.connection_id = connection.id
        ORDER BY master.updated_at DESC, master.fetched_at DESC
        LIMIT 1
      ), '{}'::jsonb) AS master_evidence,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'providerProductId', mapping.provider_product_id,
          'winerimWineId', mapping.winerim_wine_id,
          'format', upper(mapping.format_type),
          'agoraProductId', mapping.agora_product_id,
          'status', mapping.status,
          'matchMethod', mapping.match_method
        ) ORDER BY mapping.provider_product_id)
        FROM public.product_mappings mapping
        WHERE mapping.connection_id = connection.id
      ), '[]'::jsonb) AS mapping_evidence,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'providerProductId', product.provider_product_id,
          'name', product.name,
          'family', product.family,
          'price', product.price,
          'saleFormat', product.sale_format,
          'winerimWineId', product.winerim_wine_id,
          'syncStatus', product.sync_status
        ) ORDER BY product.provider_product_id)
        FROM public.provider_products product
        WHERE product.connection_id = connection.id
      ), '[]'::jsonb) AS provider_product_evidence,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'winerimWineId', tracking.winerim_wine_id,
          'format', tracking.format,
          'agoraProductId', tracking.agora_product_id,
          'agoraFamilyId', tracking.agora_family_id,
          'syncStatus', tracking.sync_status,
          'source', tracking.source
        ) ORDER BY tracking.winerim_wine_id, tracking.format)
        FROM public.winerim_push_tracking tracking
        WHERE tracking.connection_id = connection.id
      ), '[]'::jsonb) AS tracking_evidence
    FROM public.pos_connections connection
    WHERE connection.id = ${connectionId}::uuid
  `);
  if (result.rowCount !== 1) throw new Error("CATALOG_EVIDENCE_UNAVAILABLE");
  const row = result.rows[0];
  const master = jsonRecord(row.master_evidence);
  return {
    common: {
      connection: jsonValue(row.connection_evidence),
      families: jsonValue(master.families ?? []),
    },
    masterProducts: jsonRecords(master.products ?? []),
    mappings: jsonRecords(row.mapping_evidence),
    providerProducts: jsonRecords(row.provider_product_evidence),
    tracking: jsonRecords(row.tracking_evidence),
  };
}

async function loadCatalogChangeStates(
  database: DatabaseAdapter,
  connectionId: string,
): Promise<ReadonlyMap<string, CatalogChangeState>> {
  const result = await database.query<CatalogChangeStateRow>(sql`
    SELECT winerim_wine_id, format, status, source_fingerprint
    FROM public.runtime_catalog_changes
    WHERE connection_id = ${connectionId}::uuid
    ORDER BY winerim_wine_id, format
  `);
  const states = new Map<string, CatalogChangeState>();
  for (const row of result.rows) {
    const wineId = text(row.winerim_wine_id);
    const format = text(row.format).toUpperCase() as WinerimCatalogFormat;
    const status = text(row.status).toUpperCase() as CatalogChangeState["status"];
    const sourceFingerprint = text(row.source_fingerprint).toLowerCase();
    if (
      !/^[1-9][0-9]{0,17}$/.test(wineId)
      || !["BOTTLE", "GLASS", "MAGNUM"].includes(format)
      || !["PENDING", "RUNNING", "SUCCESS", "BLOCKED"].includes(status)
      || !/^[a-f0-9]{64}$/.test(sourceFingerprint)
    ) throw new Error("CATALOG_CHANGE_STATE_INVALID");
    states.set(changeKey(wineId, format), { status, sourceFingerprint });
  }
  return states;
}

async function upsertWine(
  transaction: DatabaseTransaction,
  connectionId: string,
  wine: WinerimCatalogInventoryWine,
): Promise<void> {
  const bottle = variant(wine, "BOTTLE");
  const glass = variant(wine, "GLASS");
  const magnum = variant(wine, "MAGNUM");
  await transaction.query(sql`
    INSERT INTO public.winerim_wines (
      connection_id, winerim_id, name, vintage, wine_type, is_active,
      price, bottle_sale_price, bottle_purchase_price,
      glass_sale_price, glass_cost_price,
      magnum_sale_price, magnum_purchase_price,
      serve_by_glass, pricing_status, pricing_missing_reason, raw_payload
    ) VALUES (
      ${connectionId}::uuid, ${wine.winerimId}, ${wine.name}, ${wine.vintage}, ${wine.wineType}, ${wine.active},
      ${bottle.salePrice}, ${bottle.salePrice}, ${bottle.costPrice},
      ${glass.salePrice}, ${glass.costPrice},
      ${magnum.salePrice}, ${magnum.costPrice},
      ${glass.salePrice !== null},
      ${wine.variants.length > 0 ? "READY" : "MISSING"},
      ${wine.variants.length > 0 ? null : "no_active_prices"},
      ${JSON.stringify(wine.raw)}::jsonb
    )
    ON CONFLICT (connection_id, winerim_id) DO UPDATE SET
      name = EXCLUDED.name,
      vintage = EXCLUDED.vintage,
      wine_type = EXCLUDED.wine_type,
      is_active = EXCLUDED.is_active,
      price = EXCLUDED.price,
      bottle_sale_price = EXCLUDED.bottle_sale_price,
      bottle_purchase_price = EXCLUDED.bottle_purchase_price,
      glass_sale_price = EXCLUDED.glass_sale_price,
      glass_cost_price = EXCLUDED.glass_cost_price,
      magnum_sale_price = EXCLUDED.magnum_sale_price,
      magnum_purchase_price = EXCLUDED.magnum_purchase_price,
      serve_by_glass = EXCLUDED.serve_by_glass,
      pricing_status = EXCLUDED.pricing_status,
      pricing_missing_reason = EXCLUDED.pricing_missing_reason,
      raw_payload = EXCLUDED.raw_payload,
      updated_at = now()
  `);
}

async function queueChange(
  transaction: DatabaseTransaction,
  input: Readonly<{
    connectionId: string;
    wineId: string;
    format: WinerimCatalogFormat;
    fingerprint: string;
    messageId: string;
  }>,
): Promise<void> {
  await transaction.query(sql`
    INSERT INTO public.runtime_catalog_changes (
      connection_id, winerim_wine_id, format, source_fingerprint,
      source_message_id, status, attempt, available_at
    ) VALUES (
      ${input.connectionId}::uuid, ${input.wineId}, ${input.format}, ${input.fingerprint},
      ${input.messageId}, 'PENDING', 0, now()
    )
    ON CONFLICT (connection_id, winerim_wine_id, format) DO UPDATE SET
      source_fingerprint = EXCLUDED.source_fingerprint,
      source_message_id = EXCLUDED.source_message_id,
      status = 'PENDING',
      attempt = 0,
      available_at = now(),
      claimed_at = NULL,
      lease_expires_at = NULL,
      completed_at = NULL,
      last_error = NULL,
      updated_at = now()
    WHERE runtime_catalog_changes.source_fingerprint IS DISTINCT FROM EXCLUDED.source_fingerprint
  `);
}

export function createPostgresWinerimCatalogRefreshPort(
  options: PostgresWinerimCatalogRefreshOptions,
): WinerimCatalogRefreshPort {
  return Object.freeze({
    async refresh(input) {
      const client = createWinerimCatalogInventoryClient({
        baseUrl: options.baseUrl,
        allowedHosts: options.allowedHosts,
        credential: input.credential,
        request: options.request,
        timer: options.timer,
      });
      const inventory = await client.fetchInventory();
      const maximum = Number.isInteger(options.maxWines)
        ? Math.max(1, Math.min(10_000, Number(options.maxWines)))
        : 10_000;
      if (inventory.wines.length > maximum) {
        return { ok: false, httpStatus: 422, message: "CATALOG_INVENTORY_LIMIT_EXCEEDED" };
      }
      const [existing, evidence, changeStates] = await Promise.all([
        loadExisting(options.database, input.connectionId),
        loadCatalogEvidence(options.database, input.connectionId),
        loadCatalogChangeStates(options.database, input.connectionId),
      ]);
      const observed = new Set(inventory.wines.map((wine) => wine.winerimId));
      let changed = 0;
      const pending: Array<Readonly<{
        wine: WinerimCatalogInventoryWine;
        formats: readonly WinerimCatalogFormat[];
        fingerprints: Readonly<Record<WinerimCatalogFormat, string>>;
      }>> = [];

      for (const wine of inventory.wines) {
        const prior = existing.get(wine.winerimId);
        const formats = [...new Set<WinerimCatalogFormat>([
          ...wine.variants.map((item) => item.format),
          ...(prior ? rowFormats(prior) : []),
        ])].sort();
        const fingerprints = {} as Record<WinerimCatalogFormat, string>;
        const changedFormats: WinerimCatalogFormat[] = [];
        for (const format of formats) {
          const source = await sourceFingerprint(wine, format);
          const evidenceFingerprint = await evidenceFingerprintFor(evidence, wine.winerimId, format);
          fingerprints[format] = await changeFingerprint(wine, format, evidenceFingerprint);
          const state = changeStates.get(changeKey(wine.winerimId, format));
          if (state
            ? state.sourceFingerprint !== fingerprints[format]
            : !prior || source !== await existingFingerprint(prior, format)) {
            changedFormats.push(format);
          }
        }
        if (changedFormats.length > 0) changed += changedFormats.length;
        pending.push({ wine, formats: changedFormats, fingerprints });
      }

      for (const [wineId, prior] of existing) {
        if (observed.has(wineId) || prior.is_active !== true) continue;
        const retired: WinerimCatalogInventoryWine = {
          winerimId: wineId,
          name: text(prior.name),
          vintage: text(prior.vintage) || null,
          wineType: text(prior.wine_type).toLowerCase() || null,
          active: false,
          variants: [],
          raw: {},
        };
        const formats = rowFormats(prior);
        const fingerprints = {} as Record<WinerimCatalogFormat, string>;
        const changedFormats: WinerimCatalogFormat[] = [];
        for (const format of formats) {
          const source = await sourceFingerprint(retired, format);
          const evidenceFingerprint = await evidenceFingerprintFor(evidence, wineId, format);
          fingerprints[format] = await changeFingerprint(retired, format, evidenceFingerprint);
          const state = changeStates.get(changeKey(wineId, format));
          if (state
            ? state.sourceFingerprint !== fingerprints[format]
            : source !== await existingFingerprint(prior, format)) {
            changedFormats.push(format);
          }
        }
        changed += changedFormats.length;
        pending.push({ wine: retired, formats: changedFormats, fingerprints });
      }

      if (input.dryRun) {
        return { ok: true, outcome: changed === 0 ? "duplicate" : "complete", changed };
      }

      await options.database.transaction(async (transaction) => {
        for (const item of pending) {
          await upsertWine(transaction, input.connectionId, item.wine);
          for (const format of item.formats) {
            await queueChange(transaction, {
              connectionId: input.connectionId,
              wineId: item.wine.winerimId,
              format,
              fingerprint: item.fingerprints[format],
              messageId: input.messageId,
            });
          }
        }
      }, { isolationLevel: "serializable" });
      return { ok: true, outcome: changed === 0 ? "duplicate" : "complete", changed };
    },
  });
}
