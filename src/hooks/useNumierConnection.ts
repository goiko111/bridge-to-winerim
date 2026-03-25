import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getNumierConfig, type NumierConfig } from "@/utils/providerConfig";

// ── Canonical types (shared with other providers) ───────────

export interface SalesLineItem {
  provider_product_id: string;
  name: string;
  format: string;
  family: string;
  quantity: number;
  unit_price: number;
  total_amount: number;
  vat_rate: number;
  is_wine_candidate: boolean;
}

export interface SalesEvent {
  provider_doc_id: string;
  business_day: string;
  doc_type: string;
  total_amount: number;
  total_tax: number;
  total_net: number;
  line_count: number;
  lines: SalesLineItem[];
}

export interface NumierLocation {
  id: string;
  name: string;
  address?: string;
}

/**
 * Capabilities map — tracks what's been verified for this connection.
 */
export interface NumierCapabilities {
  healthcheck: boolean;
  read_locations: boolean;
  read_sales: boolean;
  read_catalog: boolean;   // stub
  write_catalog: boolean;  // stub
}

const DEFAULT_CAPABILITIES: NumierCapabilities = {
  healthcheck: false,
  read_locations: false,
  read_sales: false,
  read_catalog: false,
  write_catalog: false,
};

export function useNumierConnection() {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);

  const [locations, setLocations] = useState<NumierLocation[]>([]);
  const [loadingLocations, setLoadingLocations] = useState(false);

  const [salesEvents, setSalesEvents] = useState<SalesEvent[]>([]);
  const [loadingSales, setLoadingSales] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ savedEvents: number; savedLines: number } | null>(null);

  const [capabilities, setCapabilities] = useState<NumierCapabilities>(DEFAULT_CAPABILITIES);
  const [config, setConfig] = useState<NumierConfig>({});

  // ── Connection CRUD ───────────────────────────────────────

  const saveConnection = async (data: {
    locationName: string;
    apiBaseUrl: string;
    apiToken: string;
    authMode: string;
    syncFrequency?: number;
  }) => {
    const providerConfig: NumierConfig = {
      api_base_url: data.apiBaseUrl,
      auth_mode: data.authMode as NumierConfig["auth_mode"],
    };

    const { data: row, error } = await supabase
      .from("pos_connections")
      .insert({
        location_name: data.locationName,
        base_url: data.apiBaseUrl,
        api_token: data.apiToken,
        provider: "numier",
        sync_mode: "PULL_ONLY",
        sync_frequency_minutes: data.syncFrequency || 15,
        backfill_days: 30,
        provider_config: providerConfig,
      } as any)
      .select()
      .single();

    if (error) throw error;
    setConnectionId(row.id);
    setConfig(getNumierConfig(row.provider_config));
    return row.id;
  };

  const updateConnection = async (id: string, data: Record<string, unknown>) => {
    const { error } = await supabase
      .from("pos_connections")
      .update(data)
      .eq("id", id);
    if (error) throw error;
  };

  const loadConnection = useCallback(async (id: string) => {
    const { data, error } = await supabase
      .from("pos_connections")
      .select("*")
      .eq("id", id)
      .single();
    if (error || !data) return null;
    setConnectionId(data.id);
    const cfg = getNumierConfig(data.provider_config);
    setConfig(cfg);
    if (cfg.verified_capabilities) {
      setCapabilities({ ...DEFAULT_CAPABILITIES, ...cfg.verified_capabilities });
    }
    if (cfg.discovered_locations) {
      setLocations(cfg.discovered_locations);
    }
    return data;
  }, []);

  // ── Proxy call helper ─────────────────────────────────────

  const invoke = async (action: string, extra: Record<string, unknown> = {}) => {
    const { data, error } = await supabase.functions.invoke("numier-proxy", {
      body: { action, connectionId, ...extra },
    });
    if (error) throw error;
    return data;
  };

  // ── Test / Healthcheck ────────────────────────────────────

  const testConnection = async (apiBaseUrl: string, apiToken: string, authMode = "API_KEY") => {
    setTestStatus("testing");
    setTestError(null);

    let connId = connectionId;
    if (!connId) {
      try {
        connId = await saveConnection({
          locationName: "Numier Location",
          apiBaseUrl,
          apiToken,
          authMode,
        });
      } catch (e: unknown) {
        setTestStatus("error");
        setTestError((e as Error).message);
        return false;
      }
    } else {
      await updateConnection(connId, {
        base_url: apiBaseUrl,
        api_token: apiToken,
        provider_config: { ...config, api_base_url: apiBaseUrl, auth_mode: authMode },
      });
    }

    try {
      const res = await supabase.functions.invoke("numier-proxy", {
        body: { action: "test", connectionId: connId },
      });
      if (res.error) throw res.error;

      if (res.data?.success) {
        setTestStatus("success");
        setCapabilities((prev) => ({ ...prev, healthcheck: true }));
        return true;
      }
      setTestStatus("error");
      setTestError(res.data?.message || "Connection failed");
      return false;
    } catch (e: unknown) {
      setTestStatus("error");
      setTestError((e as Error).message);
      return false;
    }
  };

  // ── Read Locations ────────────────────────────────────────

  const fetchLocations = useCallback(async () => {
    if (!connectionId) return;
    setLoadingLocations(true);
    try {
      const data = await invoke("read-locations");
      if (data?.success) {
        setLocations(data.locations || []);
        setCapabilities((prev) => ({ ...prev, read_locations: true }));
      }
    } catch (e) {
      console.error("Failed to fetch locations:", e);
    } finally {
      setLoadingLocations(false);
    }
  }, [connectionId]);

  // ── Read Sales ────────────────────────────────────────────

  const fetchSalesForDay = useCallback(async (day: string) => {
    if (!connectionId) return;
    setLoadingSales(true);
    setSalesEvents([]);
    try {
      const data = await invoke("fetch-day", { businessDay: day });
      if (data?.success) {
        setSalesEvents(data.salesEvents || []);
        setCapabilities((prev) => ({ ...prev, read_sales: true }));
      }
    } catch (e) {
      console.error("Failed to fetch sales:", e);
    } finally {
      setLoadingSales(false);
    }
  }, [connectionId]);

  // ── Save Sales ────────────────────────────────────────────

  const saveSalesToDb = useCallback(async (day: string) => {
    if (!connectionId) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const data = await invoke("save-sales", { businessDay: day });
      if (data?.success) {
        setSaveResult({ savedEvents: data.savedEvents || 0, savedLines: data.savedLines || 0 });
      }
    } catch (e) {
      console.error("Failed to save sales:", e);
    } finally {
      setSaving(false);
    }
  }, [connectionId]);

  // ── Enable Sync ───────────────────────────────────────────

  const enableSync = async () => {
    if (!connectionId) return;
    await updateConnection(connectionId, { enabled: true });
  };

  return {
    // Connection state
    connectionId,
    setConnectionId,
    config,
    capabilities,

    // Test
    testStatus,
    testError,
    testConnection,

    // Locations
    locations,
    loadingLocations,
    fetchLocations,

    // Sales
    salesEvents,
    loadingSales,
    fetchSalesForDay,

    // Save
    saving,
    saveResult,
    saveSalesToDb,

    // Lifecycle
    saveConnection,
    updateConnection,
    loadConnection,
    enableSync,
  };
}
