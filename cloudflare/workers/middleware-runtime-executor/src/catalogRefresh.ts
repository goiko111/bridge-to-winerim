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

type BlockedChangeRow = Record<string, unknown> & {
  winerim_wine_id: unknown;
  format: unknown;
};

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

async function changeFingerprint(
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

async function loadRetryableBlockedChanges(
  database: DatabaseAdapter,
  connectionId: string,
): Promise<ReadonlySet<string>> {
  const result = await database.query<BlockedChangeRow>(sql`
    SELECT winerim_wine_id, format
    FROM public.runtime_catalog_changes
    WHERE connection_id = ${connectionId}::uuid
      AND status = 'BLOCKED'
      AND attempt < 20
    ORDER BY winerim_wine_id, format
  `);
  const retryable = new Set<string>();
  for (const row of result.rows) {
    const wineId = text(row.winerim_wine_id);
    const format = text(row.format).toUpperCase() as WinerimCatalogFormat;
    if (/^[1-9][0-9]{0,17}$/.test(wineId) && ["BOTTLE", "GLASS", "MAGNUM"].includes(format)) {
      retryable.add(changeKey(wineId, format));
    }
  }
  return retryable;
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
      status = CASE
        WHEN runtime_catalog_changes.source_fingerprint = EXCLUDED.source_fingerprint
          AND runtime_catalog_changes.status = 'SUCCESS'
          THEN runtime_catalog_changes.status
        ELSE 'PENDING'
      END,
      attempt = CASE
        WHEN runtime_catalog_changes.source_fingerprint = EXCLUDED.source_fingerprint
          THEN runtime_catalog_changes.attempt
        ELSE 0
      END,
      available_at = now(),
      claimed_at = CASE
        WHEN runtime_catalog_changes.source_fingerprint = EXCLUDED.source_fingerprint
          AND runtime_catalog_changes.status = 'SUCCESS'
          THEN runtime_catalog_changes.claimed_at
        ELSE NULL
      END,
      completed_at = CASE
        WHEN runtime_catalog_changes.source_fingerprint = EXCLUDED.source_fingerprint
          AND runtime_catalog_changes.status = 'SUCCESS'
          THEN runtime_catalog_changes.completed_at
        ELSE NULL
      END,
      last_error = NULL,
      updated_at = now()
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
      const existing = await loadExisting(options.database, input.connectionId);
      const retryableBlocked = await loadRetryableBlockedChanges(options.database, input.connectionId);
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
          fingerprints[format] = await changeFingerprint(wine, format);
          if (
            !prior
            || fingerprints[format] !== await existingFingerprint(prior, format)
            || retryableBlocked.has(changeKey(wine.winerimId, format))
          ) {
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
        for (const format of formats) fingerprints[format] = await changeFingerprint(retired, format);
        changed += formats.length;
        pending.push({ wine: retired, formats, fingerprints });
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
