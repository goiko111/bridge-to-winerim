import { sql, type DatabaseAdapter } from "./db";

export type AgoraFleetReadModelPayload = Readonly<{
  connection: Readonly<{
    id: string;
    location_name: string;
    enabled: boolean;
    write_mode: string | null;
    last_sync_at: string | null;
    last_business_day_synced: string | null;
    catalog_sync_enabled: boolean | null;
    circuit_breaker_paused_until: string | null;
    circuit_breaker_reason: string | null;
    consecutive_failures: number | null;
  }>;
  metrics: Readonly<{
    enabled: boolean;
    writeMode: string | null;
    lastSyncAt: string | null;
    lastBusinessDaySynced: string | null;
    circuitBreakerPausedUntil: string | null;
    consecutiveFailures: number;
    verifiedProducts: number;
    legacyWineVisibleProducts: number;
    mappedSales7d: number;
    salesLines7d: number;
    stockSuccess7d: number;
    stockFailedOpen: number;
    outboundOpen: number;
    outboundFailed: number;
    activeLeases: number;
  }>;
  latestError: string | null;
}>;

type FleetReadModelRow = Record<string, unknown> & {
  payload: unknown;
  observed_at: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExactType(value: unknown, expected: "boolean" | "number" | "string"): boolean {
  return typeof value === expected;
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isPayload(value: unknown): value is AgoraFleetReadModelPayload {
  if (!isRecord(value) || !isRecord(value.connection) || !isRecord(value.metrics)) return false;
  const connection = value.connection;
  const metrics = value.metrics;
  return hasExactType(connection.id, "string")
    && hasExactType(connection.location_name, "string")
    && hasExactType(connection.enabled, "boolean")
    && isNullableString(connection.write_mode)
    && isNullableString(connection.last_sync_at)
    && isNullableString(connection.last_business_day_synced)
    && (connection.catalog_sync_enabled === null || typeof connection.catalog_sync_enabled === "boolean")
    && isNullableString(connection.circuit_breaker_paused_until)
    && isNullableString(connection.circuit_breaker_reason)
    && (connection.consecutive_failures === null || typeof connection.consecutive_failures === "number")
    && hasExactType(metrics.enabled, "boolean")
    && isNullableString(metrics.writeMode)
    && isNullableString(metrics.lastSyncAt)
    && isNullableString(metrics.lastBusinessDaySynced)
    && isNullableString(metrics.circuitBreakerPausedUntil)
    && [
      "consecutiveFailures",
      "verifiedProducts",
      "legacyWineVisibleProducts",
      "mappedSales7d",
      "salesLines7d",
      "stockSuccess7d",
      "stockFailedOpen",
      "outboundOpen",
      "outboundFailed",
      "activeLeases",
    ].every((key) => hasExactType(metrics[key], "number"))
    && isNullableString(value.latestError);
}

export async function loadAgoraFleetReadModel(
  database: DatabaseAdapter,
  maxAgeMinutes = 30,
): Promise<Readonly<{ rows: readonly AgoraFleetReadModelPayload[]; observedAt: string | null }>> {
  const boundedMaxAgeMinutes = Math.min(120, Math.max(5, Math.floor(maxAgeMinutes)));
  const result = await database.query<FleetReadModelRow>(sql`
    SELECT payload, observed_at::text
    FROM public.agora_fleet_read_model
    WHERE observed_at >= now() - make_interval(mins => ${boundedMaxAgeMinutes})
    ORDER BY payload -> 'connection' ->> 'location_name', connection_id
  `);

  const rows = result.rows.map((row) => {
    if (!isPayload(row.payload)) throw new Error("FLEET_READ_MODEL_CORRUPT");
    return row.payload;
  });
  const observedAt = result.rows.reduce<string | null>((latest, row) => (
    latest === null || row.observed_at > latest ? row.observed_at : latest
  ), null);
  return Object.freeze({ rows: Object.freeze(rows), observedAt });
}
