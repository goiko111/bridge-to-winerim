import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export type ToastSyncMode = "DATE_RANGE" | "BUSINESS_DATE";

export interface ToastSyncCursor {
  mode: ToastSyncMode;
  startDate?: string;
  endDate?: string;
  businessDate?: string;
  page: number;
  lastModified?: string;
}

export interface ToastPreflightResult {
  success: boolean;
  restaurantName?: string;
  timezone?: string;
  closeoutHour?: number;
  message: string;
}

export interface ToastSalesResult {
  success: boolean;
  totalOrders: number;
  totalLines: number;
  duplicatesSkipped: number;
  pagesProcessed: number;
  message: string;
}

export interface ToastMenusResult {
  success: boolean;
  totalMenus: number;
  totalItems: number;
  message: string;
}

export interface ToastScopeCheck {
  scope: string;
  required: boolean;
  status: "ok" | "missing" | "unknown";
}

export interface ToastSyncStatus {
  lastSuccessfulSync: string | null;
  lastError: string | null;
  ordersProcessed: number;
  newOrders: number;
  circuitBreakerOpen: boolean;
  circuitBreakerUntil: string | null;
}

export function useToastConnection() {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);

  const [preflight, setPreflight] = useState<ToastPreflightResult | null>(null);
  const [scopeChecks, setScopeChecks] = useState<ToastScopeCheck[]>([]);
  const [salesSyncing, setSalesSyncing] = useState(false);
  const [salesResult, setSalesResult] = useState<ToastSalesResult | null>(null);
  const [menusSyncing, setMenusSyncing] = useState(false);
  const [menusResult, setMenusResult] = useState<ToastMenusResult | null>(null);
  const [syncStatus, setSyncStatus] = useState<ToastSyncStatus | null>(null);
  const [webhookLastEvent, setWebhookLastEvent] = useState<string | null>(null);

  const callProxy = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    const { data, error } = await supabase.functions.invoke("toast-proxy", {
      body: { action, ...payload },
    });
    if (error) throw new Error(error.message || "Proxy call failed");
    return data;
  }, []);

  const loadExistingConnection = useCallback(async () => {
    const { data } = await supabase.from("pos_connections").select("*")
      .eq("provider", "toast").limit(1).maybeSingle();
    if (data) setConnectionId(data.id);
    return data;
  }, []);

  const saveConnection = useCallback(async (fields: {
    locationName: string;
    apiHostname: string;
    restaurantGuid: string;
    clientId: string;
    clientSecret: string;
    timezone: string;
    closeoutHour: number;
    syncMode: ToastSyncMode;
    webhookSecret?: string;
  }) => {
    const providerConfig = {
      api_hostname: fields.apiHostname,
      restaurant_guid: fields.restaurantGuid,
      timezone: fields.timezone,
      closeout_hour: fields.closeoutHour,
      sync_mode: fields.syncMode,
      webhook_secret: fields.webhookSecret || null,
      scopes_expected: ["orders:read", "restaurants:read"],
    } as unknown as Record<string, never>;

    const row = {
      provider: "toast" as const,
      location_name: fields.locationName,
      base_url: fields.apiHostname,
      api_token: fields.clientId, // clientId stored here; clientSecret in provider_config encrypted
      provider_config: providerConfig,
    };

    if (connectionId) {
      const { error } = await supabase.from("pos_connections").update(row).eq("id", connectionId);
      if (error) throw error;
      // Store secret separately
      await callProxy("store-credentials", {
        connection_id: connectionId,
        client_id: fields.clientId,
        client_secret: fields.clientSecret,
      });
    } else {
      const { data, error } = await supabase.from("pos_connections").insert(row).select().single();
      if (error) throw error;
      setConnectionId(data.id);
      await callProxy("store-credentials", {
        connection_id: data.id,
        client_id: fields.clientId,
        client_secret: fields.clientSecret,
      });
    }
  }, [connectionId, callProxy]);

  const testConnection = useCallback(async () => {
    if (!connectionId) return;
    setTestStatus("testing");
    setTestError(null);
    try {
      const res = await callProxy("preflight", { connection_id: connectionId });
      setPreflight(res);
      setTestStatus(res.success ? "success" : "error");
      if (!res.success) setTestError(res.message);
      return res;
    } catch (e: any) {
      setTestStatus("error");
      setTestError(e.message);
    }
  }, [connectionId, callProxy]);

  const checkScopes = useCallback(async () => {
    if (!connectionId) return;
    try {
      const res = await callProxy("check-scopes", { connection_id: connectionId });
      setScopeChecks(res.scopes || []);
      return res;
    } catch (e: any) {
      console.error("Scope check failed", e);
    }
  }, [connectionId, callProxy]);

  const syncSales = useCallback(async (mode: ToastSyncMode, params: { startDate?: string; endDate?: string; businessDate?: string }) => {
    if (!connectionId) return;
    setSalesSyncing(true);
    setSalesResult(null);
    try {
      const res = await callProxy("sync-sales", { connection_id: connectionId, mode, ...params });
      setSalesResult(res);
      return res;
    } finally {
      setSalesSyncing(false);
    }
  }, [connectionId, callProxy]);

  const syncMenus = useCallback(async () => {
    if (!connectionId) return;
    setMenusSyncing(true);
    setMenusResult(null);
    try {
      const res = await callProxy("sync-menus", { connection_id: connectionId });
      setMenusResult(res);
      return res;
    } finally {
      setMenusSyncing(false);
    }
  }, [connectionId, callProxy]);

  const loadSyncStatus = useCallback(async () => {
    if (!connectionId) return;
    try {
      const res = await callProxy("sync-status", { connection_id: connectionId });
      setSyncStatus(res);
      return res;
    } catch (e: any) {
      console.error("Sync status load failed", e);
    }
  }, [connectionId, callProxy]);

  const loadWebhookStatus = useCallback(async () => {
    if (!connectionId) return;
    const { data } = await supabase.from("webhook_events")
      .select("created_at, event_type")
      .eq("provider", "TOAST")
      .eq("connection_id", connectionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) setWebhookLastEvent(`${data.event_type} — ${data.created_at}`);
  }, [connectionId]);

  return {
    connectionId, testStatus, testError,
    preflight, scopeChecks,
    salesSyncing, salesResult,
    menusSyncing, menusResult,
    syncStatus, webhookLastEvent,
    loadExistingConnection, saveConnection, testConnection,
    checkScopes, syncSales, syncMenus, loadSyncStatus, loadWebhookStatus,
  };
}
