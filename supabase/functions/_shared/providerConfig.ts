/**
 * Typed helpers for reading provider_config JSONB in edge functions.
 * Mirror of src/utils/providerConfig.ts for Deno runtime.
 */

// deno-lint-ignore no-explicit-any
type RawConfig = any;

function parseJson(raw: RawConfig): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

export interface ToastConfig {
  api_hostname: string;
  restaurant_guid?: string;
  client_id?: string;
  client_secret?: string;
  scopes_expected?: string[];
  timezone?: string;
  closeout_hour?: number;
  sync_mode?: "DATE_RANGE" | "BUSINESS_DATE";
  webhook_secret?: string;
  webhook_signature_strict?: boolean;
  circuit_breaker?: { open?: boolean; until?: string | null; lastError?: string | null };
  webhook_diagnostics?: Record<string, unknown>;
  last_orders_sync_cursor?: Record<string, unknown>;
}

export function getToastConfig(raw: RawConfig): ToastConfig {
  const c = parseJson(raw) as ToastConfig;
  c.api_hostname = c.api_hostname || "https://ws-api.toasttab.com";
  return c;
}

export interface SimphonyConfig {
  oidc_base_url?: string;
  cc_base_url?: string;
  client_id?: string;
  client_secret?: string;
  oidc_token_expires_at?: string;
  oidc_refresh_token?: string;
  selected_rvcs?: string[];
  rvc_cursors?: Record<string, { last_business_day?: string; synced_at?: string; last_cursor?: string }>;
  // Auth diagnostics (never contains raw tokens/secrets)
  auth_diagnostics?: {
    last_auth_success_at?: string;
    last_auth_failure_at?: string;
    last_auth_failure_reason?: string;
    token_expires_at?: string;
    endpoint_used?: string;
    attempts_last_acquire?: number;
  };
  // Sync diagnostics (persisted after each save-sales)
  last_sync_diagnostics?: {
    business_day?: string;
    checks_fetched?: number;
    batches_processed?: number;
    line_items_saved?: number;
    retries?: number;
    duration_ms?: number;
    synced_at?: string;
  };
}

export function getSimphonyConfig(raw: RawConfig): SimphonyConfig {
  return parseJson(raw) as SimphonyConfig;
}

export interface BdpEndpointRecord {
  path: string;
  role: "auth" | "sales" | "catalog" | "write";
  last_success_at?: string;
  last_success_status?: number;
  last_error_at?: string;
  last_error_status?: number;
  last_error_body?: string; // first 2KB
  verified_at?: string;
}

export interface BdpConfig {
  port?: number | string;
  user_key?: string;
  password?: string;
  export_profile_code?: string;
  catalog_profile_code?: string;
  import_profile_code?: string;
  discovered_endpoints?: Record<string, BdpEndpointRecord>;
  last_discovery_at?: string;
  // Legacy compat
  discovered_routes?: Record<string, unknown>;
}

export function getBdpConfig(raw: RawConfig): BdpConfig {
  return parseJson(raw) as BdpConfig;
}

export interface HioposConfig {
  integration_mode?: string;
  ingestion_mode?: string;
  store_id?: string;
  timezone?: string;
  business_day_close_hour?: number;
  use_hioffice?: boolean;
  sftp?: { host?: string; port?: string; user?: string; path?: string };
  portalrest?: { base_url?: string; account_id?: string; location_id?: string; api_key?: string; api_secret?: string };
}

export function getHioposConfig(raw: RawConfig): HioposConfig {
  const c = parseJson(raw) as HioposConfig;
  c.timezone = c.timezone || "Europe/Madrid";
  c.business_day_close_hour = c.business_day_close_hour ?? 6;
  return c;
}

export interface TouchBistroConfig {
  integration_mode?: string;
  ingestion_method?: string;
  timezone?: string;
  business_day_close_hour?: number;
  sftp?: { host?: string; port?: string; user?: string; password?: string; path?: string };
  https?: { url?: string };
  private_api?: { base_url?: string; location_id?: string };
}

export function getTouchBistroConfig(raw: RawConfig): TouchBistroConfig {
  const c = parseJson(raw) as TouchBistroConfig;
  c.integration_mode = c.integration_mode || "CSV_REPORTS";
  c.ingestion_method = c.ingestion_method || "MANUAL_UPLOAD";
  c.timezone = c.timezone || "America/New_York";
  c.business_day_close_hour = c.business_day_close_hour ?? 4;
  return c;
}

export interface IcgConfig {
  connection_mode?: string;
  host?: string;
  port?: string;
  database?: string;
  db_username?: string;
  db_password?: string;
  sql_mapping?: Record<string, unknown>;
  write_enabled?: boolean;
  require_manual_approval?: boolean;
}

export function getIcgConfig(raw: RawConfig): IcgConfig {
  const c = parseJson(raw) as IcgConfig;
  c.connection_mode = c.connection_mode || "SQL_SERVER";
  c.port = c.port || "1433";
  c.database = c.database || "FrontRest";
  return c;
}
