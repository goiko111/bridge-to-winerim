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
  toast_api_hostname?: string;
  restaurant_guid?: string;
  client_id?: string;
  client_secret?: string;
  scopes_expected?: string[];
  timezone?: string;
  closeout_hour?: number;
  sync_mode?: "DATE_RANGE" | "BUSINESS_DATE";
  webhook_secret?: string;
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
}

export interface BdpConfig {
  base_url?: string;
  port?: number;
  user_key?: string;
  password?: string;
  export_profile_code?: string;
  catalog_profile_code?: string;
  import_profile_code?: string;
}

export interface HioposConfig {
  hioffice_base_url?: string;
  hioffice_user?: string;
  hioffice_password?: string;
  b2b_bridge_enabled?: boolean;
  import_format?: "CSV" | "XML";
  article_export_path?: string;
  sales_export_path?: string;
}

export interface TouchBistroConfig {
  integration_mode?: "CSV_REPORTS" | "PRIVATE_API";
  timezone?: string;
  business_day_close_time?: string;
  ingestion_method?: "MANUAL_UPLOAD" | "SFTP_PULL" | "HTTPS_PULL";
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
  api_base_url?: string;
  company_code?: string;
  store_code?: string;
  api_user?: string;
  api_password?: string;
  catalog_endpoint?: string;
  sales_endpoint?: string;
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
  c.toast_api_hostname = c.toast_api_hostname || "https://ws-api.toasttab.com";
  return c;
}

export function getSimphonyConfig(raw: RawConfig): SimphonyConfig {
  return parseJson(raw) as SimphonyConfig;
}

export function getBdpConfig(raw: RawConfig): BdpConfig {
  return parseJson(raw) as BdpConfig;
}

export function getHioposConfig(raw: RawConfig): HioposConfig {
  return parseJson(raw) as HioposConfig;
}

export function getTouchBistroConfig(raw: RawConfig): TouchBistroConfig {
  const c = parseJson(raw) as TouchBistroConfig;
  c.integration_mode = c.integration_mode || "CSV_REPORTS";
  c.ingestion_method = c.ingestion_method || "MANUAL_UPLOAD";
  return c;
}

export function getIcgConfig(raw: RawConfig): IcgConfig {
  return parseJson(raw) as IcgConfig;
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
