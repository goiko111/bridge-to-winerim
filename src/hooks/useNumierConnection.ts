import { useState, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getNumierConfig, type NumierConfig } from "@/utils/providerConfig";

// ── Canonical types ─────────────────────────────────────────

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

export interface NumierCapabilities {
  healthcheck: boolean;
  read_locations: boolean;
  read_sales: boolean;
  read_categories: boolean;
  read_products: boolean;
  write_catalog: boolean;
}

const DEFAULT_CAPABILITIES: NumierCapabilities = {
  healthcheck: false,
  read_locations: false,
  read_sales: false,
  read_categories: false,
  read_products: false,
  write_catalog: false,
};

export function useNumierConnection() {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);

  const [locations, setLocations] = useState<NumierLocation[]>([]);
  const [loadingLocations, setLoadingLocations] = useState(false);
  const [selectedTpvId, setSelectedTpvId] = useState<string | null>(null);

  const [salesEvents, setSalesEvents] = useState<SalesEvent[]>([]);
  const [loadingSales, setLoadingSales] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ savedEvents: number; savedLines: number } | null>(null);

  const [capabilities, setCapabilities] = useState<NumierCapabilities>(DEFAULT_CAPABILITIES);
  const [config, setConfig] = useState<NumierConfig>({});

  // ── Derived: active TPV id and source ─────────────────────

  const activeTpvId = useMemo(() => {
    if (selectedTpvId || config.selected_tpv_id) return selectedTpvId || config.selected_tpv_id || null;
    const locs = config.discovered_locations || [];
    // Fallback only if exactly one location
    if (locs.length === 1 && locs[0]?.id) return locs[0].id;
    return null;
  }, [selectedTpvId, config]);

  const tpvSource = useMemo((): "selected" | "fallback_single" | "none" => {
    if (selectedTpvId || config.selected_tpv_id) return "selected";
    const locs = config.discovered_locations || [];
    if (locs.length === 1 && locs[0]?.id) return "fallback_single";
    return "none";
  }, [selectedTpvId, config]);

  // ── Connection CRUD ───────────────────────────────────────

  const saveConnection = async (data: {
    locationName: string;
    apiBaseUrl: string;
    apiToken: string;
    syncFrequency?: number;
  }) => {
    const providerConfig: NumierConfig = {
      api_base_url: data.apiBaseUrl,
      auth_mode: "API_KEY",
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
    if (cfg.selected_tpv_id) {
      setSelectedTpvId(cfg.selected_tpv_id);
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

  const testConnection = async (apiBaseUrl: string, apiToken: string, locationNameOverride?: string) => {
    setTestStatus("testing");
    setTestError(null);

    let connId = connectionId;
    if (!connId) {
      try {
        connId = await saveConnection({
          locationName: "Numier Location",
          apiBaseUrl,
          apiToken,
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
        provider_config: { ...config, api_base_url: apiBaseUrl, auth_mode: "API_KEY" },
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

  // ── Select TPV and persist ────────────────────────────────

  const selectTpv = useCallback(async (tpvId: string) => {
    setSelectedTpvId(tpvId);
    if (connectionId) {
      const updatedConfig = { ...config, selected_tpv_id: tpvId };
      setConfig(updatedConfig);
      await supabase
        .from("pos_connections")
        .update({ provider_config: updatedConfig })
        .eq("id", connectionId);
    }
  }, [connectionId, config]);

  // ── Read Locations ────────────────────────────────────────

  const fetchLocations = useCallback(async () => {
    if (!connectionId) return;
    setLoadingLocations(true);
    try {
      const data = await invoke("read-locations");
      if (data?.success) {
        const locs = data.locations || [];
        setLocations(locs);
        setCapabilities((prev) => ({ ...prev, read_locations: true }));
        // Auto-select if only one
        if (locs.length === 1 && !selectedTpvId) {
          await selectTpv(locs[0].id);
        }
      }
    } catch (e) {
      console.error("Failed to fetch locations:", e);
    } finally {
      setLoadingLocations(false);
    }
  }, [connectionId, selectedTpvId, selectTpv]);

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
    connectionId,
    setConnectionId,
    config,
    capabilities,

    testStatus,
    testError,
    testConnection,

    locations,
    loadingLocations,
    fetchLocations,

    selectedTpvId,
    selectTpv,
    activeTpvId,
    tpvSource,

    salesEvents,
    loadingSales,
    fetchSalesForDay,

    saving,
    saveResult,
    saveSalesToDb,

    saveConnection,
    updateConnection,
    loadConnection,
    enableSync,
  };
}
