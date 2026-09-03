import { sql, type DatabaseAdapter, type DatabaseTransaction } from "../../middleware-api/src/db";
import type { AgoraFleetReadModelPayload } from "../../middleware-api/src/agoraFleetReadModel";

const DEFAULT_CONCURRENCY = 2;

type FleetSourceRow = Record<string, unknown> & {
  connection_id: string;
  location_name: string;
  enabled: boolean;
  write_mode: string | null;
  last_sync_at: string | null;
  last_business_day_synced: string | null;
  catalog_sync_enabled: boolean | null;
  circuit_breaker_paused_until: string | null;
  circuit_breaker_reason: string | null;
  consecutive_failures: number | string | null;
  verified_products: number | string | null;
  master_data: unknown;
  stock_error: string | null;
  outbound_error: string | null;
  mapped_sales_7d: number | string | null;
  sales_lines_7d: number | string | null;
  stock_success_7d: number | string | null;
  stock_failed_open: number | string | null;
  outbound_open: number | string | null;
  outbound_failed: number | string | null;
  active_leases: number | string | null;
};

type PersistedFleetRow = Readonly<{
  connectionId: string;
  payload: AgoraFleetReadModelPayload;
  sourceHash: string;
}>;

export type FleetReadModelRefreshSummary = Readonly<{
  observedAt: string;
  connections: number;
  concurrency: number;
  sourceHashCount: number;
  phasesMs: Readonly<{
    discover: number;
    plan: number;
    execute: number;
    certify: number;
    total: number;
  }>;
}>;

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function compactError(value: unknown): string | null {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() === "true";
}

function looksLikeWine(value: string): boolean {
  return /\b(vino|vinos|tinto|tintos|blanco|blancos|rosado|rosados|copa|copas|magnum|espumoso|espumosos|champagne|cava|dulce|dulces|generoso|generosos|bodega|ribera|rioja)\b/i.test(value);
}

function countLegacyWineVisibleProducts(masterData: unknown): number {
  const master = (masterData || {}) as {
    families_json?: Array<Record<string, unknown>>;
    products_summary_json?: Array<Record<string, unknown>>;
  };
  const families = Array.isArray(master.families_json) ? master.families_json : [];
  const products = Array.isArray(master.products_summary_json) ? master.products_summary_json : [];
  const familyById = new Map(families.map((family) => [String(family.Id || ""), family]));

  return products.filter((product) => {
    const family = familyById.get(String(product.FamilyId || ""));
    const familyName = String(family?.Name || "");
    const productName = String(product.Name || "");
    const isWinerim = familyName.toUpperCase().includes("WINERIM")
      || productName.startsWith("B ")
      || productName.startsWith("C ")
      || productName.startsWith("M ");
    if (isWinerim || !looksLikeWine(`${familyName} ${productName}`)) return false;
    return asBool(family?.ShowInPos, true)
      && !family?.DeletionDate
      && asBool(product.UseAsDirectSale, true)
      && asBool(product.SaleableAsMain, true)
      && !product.DeletionDate;
  }).length;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const output = new Array<Output>(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

async function discover(transaction: DatabaseTransaction, observedAt: string): Promise<readonly FleetSourceRow[]> {
  const result = await transaction.query<FleetSourceRow>(sql`
    WITH connections AS MATERIALIZED (
      SELECT * FROM public.pos_connections WHERE provider = 'agora'
    ), verified AS (
      SELECT connection_id, count(*)::int AS verified_products
      FROM public.winerim_push_tracking
      WHERE sync_status = 'VERIFIED'
      GROUP BY connection_id
    ), latest_master AS (
      SELECT DISTINCT ON (connection_id)
        connection_id,
        jsonb_build_object(
          'families_json', families_json,
          'products_summary_json', products_summary_json
        ) AS master_data
      FROM public.agora_master_data
      ORDER BY connection_id, fetched_at DESC NULLS LAST
    ), sales AS (
      SELECT
        connection_id,
        count(*) FILTER (WHERE winerim_product_id IS NOT NULL)::int AS mapped_sales_7d,
        count(*)::int AS sales_lines_7d
      FROM public.sales_line_items
      WHERE created_at >= ${observedAt}::timestamptz - interval '7 days'
      GROUP BY connection_id
    ), stock AS (
      SELECT
        connection_id,
        count(*) FILTER (
          WHERE status = 'SUCCESS' AND created_at >= ${observedAt}::timestamptz - interval '7 days'
        )::int AS stock_success_7d,
        count(*) FILTER (WHERE status IN ('FAILED', 'BLOCKED', 'PENDING'))::int AS stock_failed_open
      FROM public.stock_sync_log
      WHERE (
        status = 'SUCCESS'
        AND created_at >= ${observedAt}::timestamptz - interval '7 days'
      ) OR status IN ('FAILED', 'BLOCKED', 'PENDING')
      GROUP BY connection_id
    ), latest_stock_error AS (
      SELECT DISTINCT ON (connection_id)
        connection_id,
        concat(coalesce(product_name, 'Stock'), ': ', coalesce(error_message, '')) AS stock_error
      FROM public.stock_sync_log
      WHERE status IN ('FAILED', 'BLOCKED')
      ORDER BY connection_id, created_at DESC, id DESC
    ), outbound AS (
      SELECT
        connection_id,
        count(*) FILTER (WHERE status IN ('QUEUED', 'RUNNING'))::int AS outbound_open,
        count(*) FILTER (WHERE status IN ('FAILED', 'BLOCKED'))::int AS outbound_failed
      FROM public.outbound_tasks
      WHERE status IN ('QUEUED', 'RUNNING', 'FAILED', 'BLOCKED')
      GROUP BY connection_id
    ), latest_outbound_error AS (
      SELECT DISTINCT ON (connection_id)
        connection_id,
        concat(coalesce(task_type, 'Outbound'), ': ', coalesce(last_error, blocked_reason, '')) AS outbound_error
      FROM public.outbound_tasks
      WHERE status IN ('FAILED', 'BLOCKED')
      ORDER BY connection_id, updated_at DESC, id DESC
    ), leases AS (
      SELECT connection_id, count(*)::int AS active_leases
      FROM public.runtime_idempotency
      WHERE status = 'RUNNING' AND lease_expires_at > ${observedAt}::timestamptz
      GROUP BY connection_id
    )
    SELECT
      connection.id::text AS connection_id,
      connection.location_name,
      connection.enabled,
      connection.write_mode,
      connection.last_sync_at::text,
      connection.last_business_day_synced::text,
      connection.catalog_sync_enabled,
      connection.circuit_breaker_paused_until::text,
      connection.circuit_breaker_reason,
      connection.consecutive_failures,
      coalesce(verified.verified_products, 0)::int AS verified_products,
      latest_master.master_data,
      latest_stock_error.stock_error,
      latest_outbound_error.outbound_error,
      coalesce(sales.mapped_sales_7d, 0)::int AS mapped_sales_7d,
      coalesce(sales.sales_lines_7d, 0)::int AS sales_lines_7d,
      coalesce(stock.stock_success_7d, 0)::int AS stock_success_7d,
      coalesce(stock.stock_failed_open, 0)::int AS stock_failed_open,
      coalesce(outbound.outbound_open, 0)::int AS outbound_open,
      coalesce(outbound.outbound_failed, 0)::int AS outbound_failed,
      coalesce(leases.active_leases, 0)::int AS active_leases
    FROM connections connection
    LEFT JOIN verified ON verified.connection_id = connection.id
    LEFT JOIN latest_master ON latest_master.connection_id = connection.id
    LEFT JOIN sales ON sales.connection_id = connection.id
    LEFT JOIN stock ON stock.connection_id = connection.id
    LEFT JOIN latest_stock_error ON latest_stock_error.connection_id = connection.id
    LEFT JOIN outbound ON outbound.connection_id = connection.id
    LEFT JOIN latest_outbound_error ON latest_outbound_error.connection_id = connection.id
    LEFT JOIN leases ON leases.connection_id = connection.id
    ORDER BY connection.id
  `);
  return result.rows;
}

async function planRow(row: FleetSourceRow): Promise<PersistedFleetRow> {
  const payload: AgoraFleetReadModelPayload = Object.freeze({
    connection: Object.freeze({
      id: row.connection_id,
      location_name: row.location_name,
      enabled: row.enabled,
      write_mode: row.write_mode,
      last_sync_at: row.last_sync_at,
      last_business_day_synced: row.last_business_day_synced,
      catalog_sync_enabled: row.catalog_sync_enabled,
      circuit_breaker_paused_until: row.circuit_breaker_paused_until,
      circuit_breaker_reason: row.circuit_breaker_reason,
      consecutive_failures: row.consecutive_failures === null ? null : count(row.consecutive_failures),
    }),
    latestError: compactError(row.stock_error || row.outbound_error),
    metrics: Object.freeze({
      enabled: row.enabled,
      writeMode: row.write_mode,
      lastSyncAt: row.last_sync_at,
      lastBusinessDaySynced: row.last_business_day_synced,
      circuitBreakerPausedUntil: row.circuit_breaker_paused_until,
      consecutiveFailures: count(row.consecutive_failures),
      verifiedProducts: count(row.verified_products),
      legacyWineVisibleProducts: countLegacyWineVisibleProducts(row.master_data),
      mappedSales7d: count(row.mapped_sales_7d),
      salesLines7d: count(row.sales_lines_7d),
      stockSuccess7d: count(row.stock_success_7d),
      stockFailedOpen: count(row.stock_failed_open),
      outboundOpen: count(row.outbound_open),
      outboundFailed: count(row.outbound_failed),
      activeLeases: count(row.active_leases),
    }),
  });
  return Object.freeze({ connectionId: row.connection_id, payload, sourceHash: await sha256(payload) });
}

async function persist(
  transaction: DatabaseTransaction,
  observedAt: string,
  rows: readonly PersistedFleetRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await transaction.query(sql`
    INSERT INTO public.agora_fleet_read_model (
      connection_id, payload, source_hash, observed_at, updated_at
    )
    SELECT source."connectionId", source.payload, source."sourceHash", ${observedAt}::timestamptz, now()
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS source(
      "connectionId" uuid,
      payload jsonb,
      "sourceHash" text
    )
    ON CONFLICT (connection_id) DO UPDATE SET
      payload = excluded.payload,
      source_hash = excluded.source_hash,
      observed_at = excluded.observed_at,
      updated_at = excluded.updated_at
  `);
}

async function certify(
  transaction: DatabaseTransaction,
  observedAt: string,
  expectedConnections: number,
): Promise<number> {
  const result = await transaction.query<Record<string, unknown> & { connections: number | string; hashes: number | string }>(sql`
    SELECT count(*)::int AS connections, count(DISTINCT source_hash)::int AS hashes
    FROM public.agora_fleet_read_model
    WHERE observed_at = ${observedAt}::timestamptz
  `);
  const connections = count(result.rows[0]?.connections);
  if (connections !== expectedConnections) throw new Error("FLEET_READ_MODEL_READBACK_MISMATCH");
  return count(result.rows[0]?.hashes);
}

export async function refreshAgoraFleetReadModel(
  database: DatabaseAdapter,
  observedAt = new Date().toISOString(),
  concurrency = DEFAULT_CONCURRENCY,
  now: () => number = () => Date.now(),
): Promise<FleetReadModelRefreshSummary> {
  const startedAt = now();
  const sourceRows = await database.transaction(
    (transaction) => discover(transaction, observedAt),
    { isolationLevel: "repeatable-read", readOnly: true },
  );
  const discoveredAt = now();
  const boundedConcurrency = Math.min(DEFAULT_CONCURRENCY, Math.max(1, Math.floor(concurrency)));
  const planned = await mapWithConcurrency(sourceRows, boundedConcurrency, planRow);
  const plannedAt = now();
  let sourceHashCount = 0;
  let executedAt = plannedAt;
  let certifiedAt = plannedAt;
  await database.transaction(async (transaction) => {
    await persist(transaction, observedAt, planned);
    executedAt = now();
    sourceHashCount = await certify(transaction, observedAt, planned.length);
    certifiedAt = now();
  }, { isolationLevel: "read-committed" });
  const completedAt = certifiedAt;
  return Object.freeze({
    observedAt,
    connections: planned.length,
    concurrency: boundedConcurrency,
    sourceHashCount,
    phasesMs: Object.freeze({
      discover: discoveredAt - startedAt,
      plan: plannedAt - discoveredAt,
      execute: executedAt - plannedAt,
      certify: certifiedAt - executedAt,
      total: completedAt - startedAt,
    }),
  });
}
