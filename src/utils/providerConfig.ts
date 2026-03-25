/**
 * Typed helpers for reading provider_config JSONB per provider.
 * Centralizes parsing/validation so hooks and edge functions
 * don't scatter ad-hoc reads everywhere.
 */

import type { Json } from "@/integrations/supabase/types";

// ── Per-provider config shapes ──────────────────────────────

export interface AgoraConfig {
  selected_sale_center_ids?: string[];
  default_wine_family_name?: string;
  default_bottle_format_name?: string;
  default_glass_format_name?: string;
  default_family_id?: string;
  default_vat_id?: string;
  default_vat_rate?: number;
  default_preparation_type_id?: string;
  default_preparation_order_id?: string;
  default_warehouse_id?: string;
  write_mode?: string;
  catalog_endpoint?: string;
  catalog_sync_enabled?: boolean;
}

export interface ToastConfig {
  api_hostname?: string;
  restaurant_guid?: string;
  client_id?: string;
  client_secret?: string;
  scopes_expected?: string[];
  timezone?: string;
  closeout_hour?: number;
  sync_mode?: "DATE_RANGE" | "BUSINESS_DATE";
  webhook_secret?: string;
  webhook_signature_strict?: boolean;
  circuit_breaker?: {
    open?: boolean;
    until?: string | null;
    lastError?: string | null;
  };
  webhook_diagnostics?: Record<string, unknown>;
  last_orders_sync_cursor?: {
    mode?: string;
    startDate?: string;
    endDate?: string;
    businessDate?: string;
    page?: number;
    lastModified?: string;
  };
}

export interface SimphonyConfig {
  org_short_name?: string;
  loc_ref?: string;
  rvc_ref?: string;
  bi_api_base?: string;
  ccapi_base?: string;
  client_id?: string;
  client_secret?: string;
  bi_report_ids?: string[];
  webhook_url?: string;
  webhook_secret?: string;
  oidc_base_url?: string;
  cc_base_url?: string;
  oidc_token_expires_at?: string;
  oidc_refresh_token?: string;
  selected_rvcs?: string[];
  rvc_cursors?: Record<string, { last_business_day?: string; synced_at?: string }>;
  auth_diagnostics?: {
    last_auth_success_at?: string;
    last_auth_failure_at?: string;
    last_auth_failure_reason?: string;
    token_expires_at?: string;
    endpoint_used?: string;
    attempts_last_acquire?: number;
  };
}

export interface BdpConfig {
  base_url?: string;
  port?: number | string;
  user_key?: string;
  password?: string;
  export_profile_code?: string;
  catalog_profile_code?: string;
  import_profile_code?: string;
  discovered_routes?: Record<string, unknown>;
  last_discovery_at?: string;
}

export interface HioposConfig {
  integration_mode?: "FILES" | "PORTALREST_ORDERS_API";
  ingestion_mode?: "MANUAL_UPLOAD" | "SFTP_PULL";
  store_id?: string;
  timezone?: string;
  business_day_close_hour?: number;
  use_hioffice?: boolean;
  sftp?: {
    host?: string;
    port?: string;
    user?: string;
    path?: string;
  };
  portalrest?: {
    base_url?: string;
    account_id?: string;
    location_id?: string;
    api_key?: string;
    api_secret?: string;
  };
}

export interface TouchBistroConfig {
  integration_mode?: "CSV_REPORTS" | "PRIVATE_API";
  ingestion_method?: "MANUAL_UPLOAD" | "SFTP_PULL" | "HTTPS_PULL";
  timezone?: string;
  business_day_close_time?: string;
  business_day_close_hour?: number;
  sftp?: {
    host?: string;
    port?: string;
    user?: string;
    password?: string;
    path?: string;
  };
  https?: {
    url?: string;
  };
  private_api?: {
    base_url?: string;
    location_id?: string;
  };
  // Legacy flat fields (kept for back-compat)
  sftp_host?: string;
  sftp_port?: number;
  sftp_user?: string;
  sftp_password?: string;
  sftp_path?: string;
  https_signed_url?: string;
  private_api_base_url?: string;
  private_api_key?: string;
}

export interface IcgConfig {
  connection_mode?: "SQL_SERVER" | "REST_API";
  host?: string;
  port?: string;
  database?: string;
  db_username?: string;
  db_password?: string;
  api_base_url?: string;
  company_code?: string;
  store_code?: string;
  api_user?: string;
  api_password?: string;
  catalog_endpoint?: string;
  sales_endpoint?: string;
  sql_mapping?: Record<string, unknown>;
  write_enabled?: boolean;
  require_manual_approval?: boolean;
}

export interface NumierConfig {
  /** Base URL of Numier API (e.g. https://api.numier.com or on-prem host) */
  api_base_url?: string;
  /** Auth mode: API_KEY, BASIC, OAUTH */
  auth_mode?: "API_KEY" | "BASIC" | "OAUTH";
  /** API key if auth_mode = API_KEY */
  api_key?: string;
  /** Username for BASIC auth */
  username?: string;
  /** Password for BASIC auth */
  password?: string;
  /** Location / store identifier inside Numier */
  location_id?: string;
  /** Timezone for business-day calculation */
  timezone?: string;
  /** Hour at which the business day closes (0-23) */
  business_day_close_hour?: number;
  /** Discovered locations from read_locations */
  discovered_locations?: { id: string; name: string; address?: string }[];
  /** Capabilities explicitly verified */
  verified_capabilities?: {
    healthcheck?: boolean;
    read_locations?: boolean;
    read_sales?: boolean;
    read_catalog?: boolean;
    write_catalog?: boolean;
  };
}

// ── Generic raw type ────────────────────────────────────────

type RawConfig = Json | null | undefined;

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

// ── Typed getters ───────────────────────────────────────────

export function getAgoraConfig(raw: RawConfig): AgoraConfig {
  return parseJson(raw) as AgoraConfig;
}

export function getToastConfig(raw: RawConfig): ToastConfig {
  const c = parseJson(raw) as ToastConfig;
  c.api_hostname = c.api_hostname || "https://ws-api.toasttab.com";
  return c;
}

export function getSimphonyConfig(raw: RawConfig): SimphonyConfig {
  return parseJson(raw) as SimphonyConfig;
}

export function getBdpConfig(raw: RawConfig): BdpConfig {
  return parseJson(raw) as BdpConfig;
}

export function getHioposConfig(raw: RawConfig): HioposConfig {
  const c = parseJson(raw) as HioposConfig;
  c.integration_mode = c.integration_mode || "FILES";
  c.timezone = c.timezone || "Europe/Madrid";
  c.business_day_close_hour = c.business_day_close_hour ?? 6;
  return c;
}

export function getTouchBistroConfig(raw: RawConfig): TouchBistroConfig {
  const c = parseJson(raw) as TouchBistroConfig;
  c.integration_mode = c.integration_mode || "CSV_REPORTS";
  c.ingestion_method = c.ingestion_method || "MANUAL_UPLOAD";
  c.timezone = c.timezone || "America/New_York";
  c.business_day_close_hour = c.business_day_close_hour ?? 4;
  return c;
}

export function getIcgConfig(raw: RawConfig): IcgConfig {
  const c = parseJson(raw) as IcgConfig;
  c.connection_mode = c.connection_mode || "SQL_SERVER";
  c.port = c.port || "1433";
  c.database = c.database || "FrontRest";
  return c;
}

// ── Dispatcher (optional convenience) ───────────────────────

export function getProviderConfig<T = Record<string, unknown>>(
  provider: string,
  raw: RawConfig,
): T {
  const map: Record<string, (r: RawConfig) => unknown> = {
    agora: getAgoraConfig,
    AGORA: getAgoraConfig,
    TOAST: getToastConfig,
    toast: getToastConfig,
    SIMPHONY: getSimphonyConfig,
    simphony: getSimphonyConfig,
    BDP_NET: getBdpConfig,
    bdp_net: getBdpConfig,
    bdp: getBdpConfig,
    BDP: getBdpConfig,
    HIOPOS: getHioposConfig,
    hiopos: getHioposConfig,
    TOUCHBISTRO: getTouchBistroConfig,
    touchbistro: getTouchBistroConfig,
    ICG: getIcgConfig,
    icg: getIcgConfig,
  };
  const getter = map[provider];
  return (getter ? getter(raw) : parseJson(raw)) as T;
}
