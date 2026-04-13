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

export interface SalesMetrics {
  pagination: {
    pages_read: number;
    tickets_seen: number;
    unique_ticket_ids: number;
    duplicate_ticket_ids_count: number;
  };
  normalization: {
    events_count: number;
    total_lines: number;
    tickets_without_lines: number;
    lines_with_zero_price: number;
    lines_without_product_id: number;
    business_day_range: { min: string; max: string } | null;
    events_saved?: number;
    lines_saved?: number;
  };
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

  // Separated: location_id vs tpv_id
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [selectedTpvId, setSelectedTpvId] = useState<string | null>(null);
  const [manualTpvOverride, setManualTpvOverride] = useState<string>("");

  const [salesEvents, setSalesEvents] = useState<SalesEvent[]>([]);
  const [loadingSales, setLoadingSales] = useState(false);
  const [salesMetrics, setSalesMetrics] = useState<SalesMetrics | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{
    savedEvents: number;
    savedLines: number;
    pagination?: SalesMetrics["pagination"];
    normalization?: SalesMetrics["normalization"];
  } | null>(null);

  const [capabilities, setCapabilities] = useState<NumierCapabilities>(DEFAULT_CAPABILITIES);
  const [config, setConfig] = useState<NumierConfig>({});

  // Diagnosis state
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosisResult, setDiagnosisResult] = useState<Record<string, unknown> | null>(null);

  // ── Derived: active TPV id (for sales/categories/products) ──
  // Priority: manual_tpv_override > selected_tpv_id > NOTHING
  // We explicitly do NOT fall back to discovered_locations[0].id

  const activeTpvId = useMemo(() => {
    if (manualTpvOverride.trim()) return manualTpvOverride.trim();
    if (selectedTpvId || config.selected_tpv_id) return selectedTpvId || config.selected_tpv_id || null;
    return null;
  }, [manualTpvOverride, selectedTpvId, config]);

  const tpvSource = useMemo((): "manual_override" | "selected" | "none" => {
    if (manualTpvOverride.trim()) return "manual_override";
    if (selectedTpvId || config.selected_tpv_id) return "selected";
    return "none";
  }, [manualTpvOverride, selectedTpvId, config]);

  // ── Derived: active location id (from getLocales, informational) ──
  const activeLocationId = useMemo(() => {
    if (selectedLocationId || config.selected_location_id) return selectedLocationId || config.selected_location_id || null;
    const locs = config.discovered_locations || [];
    if (locs.length === 1 && locs[0]?.id) return locs[0].id;
    return null;
  }, [selectedLocationId, config]);

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
    if (cfg.selected_location_id) {
      setSelectedLocationId(cfg.selected_location_id);
    }
    if (cfg.selected_tpv_id) {
      setSelectedTpvId(cfg.selected_tpv_id);
    }
    if (cfg.manual_tpv_override) {
      setManualTpvOverride(cfg.manual_tpv_override);
    }
    return data;
  }, []);

  // ── Proxy call helper ─────────────────────────────────────

  const invoke = async (action: string, extra: Record<string, unknown> = {}) => {
    const body: Record<string, unknown> = { action, connectionId, ...extra };
    if (manualTpvOverride.trim()) {
      body.manualTpvOverride = manualTpvOverride.trim();
    }
    const { data, error } = await supabase.functions.invoke("numier-proxy", { body });
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
          locationName: locationNameOverride || "Numier Location",
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

  // ── Select Location (from getLocales — informational only) ──

  const selectLocation = useCallback(async (locationId: string) => {
    setSelectedLocationId(locationId);
    if (connectionId) {
      const updatedConfig = { ...config, selected_location_id: locationId };
      setConfig(updatedConfig);
      await supabase
        .from("pos_connections")
        .update({ provider_config: updatedConfig })
        .eq("id", connectionId);
    }
  }, [connectionId, config]);

  // ── Select TPV (the real operational ID for sales/categories/products) ──

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

  // ── Persist manual TPV override ──

  const persistManualTpvOverride = useCallback(async (value: string) => {
    setManualTpvOverride(value);
    if (connectionId) {
      const updatedConfig = { ...config, manual_tpv_override: value.trim() || undefined };
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
        // Auto-select location if only one, but do NOT set it as TPV
        if (locs.length === 1 && !selectedLocationId) {
          await selectLocation(locs[0].id);
        }
      }
    } catch (e) {
      console.error("Failed to fetch locations:", e);
    } finally {
      setLoadingLocations(false);
    }
  }, [connectionId, selectedLocationId, selectLocation]);

  // ── Read Sales (date range) ───────────────────────────────

  const fetchSalesRange = useCallback(async (startDate: string, endDate: string) => {
    if (!connectionId) return;
    setLoadingSales(true);
    setSalesEvents([]);
    setSalesMetrics(null);
    try {
      const data = await invoke("fetch-day", { businessDay: startDate, endDate });
      if (data?.success) {
        setSalesEvents(data.salesEvents || []);
        setCapabilities((prev) => ({ ...prev, read_sales: true }));
        if (data.pagination || data.normalization) {
          setSalesMetrics({
            pagination: data.pagination,
            normalization: data.normalization,
          });
        }
      }
    } catch (e) {
      console.error("Failed to fetch sales:", e);
    } finally {
      setLoadingSales(false);
    }
  }, [connectionId, manualTpvOverride]);

  const fetchSalesForDay = useCallback(async (day: string) => {
    return fetchSalesRange(day, day);
  }, [fetchSalesRange]);

  // ── Save Sales (date range) ───────────────────────────────

  const saveSalesRange = useCallback(async (startDate: string, endDate: string) => {
    if (!connectionId) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const data = await invoke("save-sales", { businessDay: startDate, endDate });
      if (data?.success) {
        setSaveResult({
          savedEvents: data.savedEvents || 0,
          savedLines: data.savedLines || 0,
          pagination: data.pagination,
          normalization: data.normalization,
        });
      }
    } catch (e) {
      console.error("Failed to save sales:", e);
    } finally {
      setSaving(false);
    }
  }, [connectionId, manualTpvOverride]);

  const saveSalesToDb = useCallback(async (day: string) => {
    return saveSalesRange(day, day);
  }, [saveSalesRange]);

  // ── Fetch Sales Chunked ───────────────────────────────────

  const [chunkedResult, setChunkedResult] = useState<Record<string, unknown> | null>(null);
  const [loadingChunked, setLoadingChunked] = useState(false);

  const fetchSalesChunked = useCallback(async (startDate: string, endDate: string, chunkDays = 7) => {
    if (!connectionId) return;
    setLoadingChunked(true);
    setChunkedResult(null);
    setSalesEvents([]);
    setSalesMetrics(null);
    try {
      const data = await invoke("fetch-chunked", { startDate, endDate, chunkDays });
      setChunkedResult(data);
      if (data?.success) {
        setSalesEvents(data.salesEvents || []);
        setCapabilities((prev) => ({ ...prev, read_sales: true }));
        if (data.pagination || data.normalization) {
          setSalesMetrics({ pagination: data.pagination, normalization: data.normalization });
        }
      }
    } catch (e) {
      console.error("Failed to fetch chunked sales:", e);
      setChunkedResult({ success: false, error: (e as Error).message });
    } finally {
      setLoadingChunked(false);
    }
  }, [connectionId, manualTpvOverride]);

  // ── Diagnose TPV ───────────────────────────────────────────

  const diagnoseTpv = useCallback(async (startDate?: string, endDate?: string) => {
    if (!connectionId) return;
    setDiagnosing(true);
    setDiagnosisResult(null);
    try {
      const data = await invoke("diagnose-tpv", { tpvId: activeTpvId, startDate, endDate });
      setDiagnosisResult(data);
    } catch (e) {
      console.error("Diagnosis failed:", e);
      setDiagnosisResult({ success: false, error: (e as Error).message });
    } finally {
      setDiagnosing(false);
    }
  }, [connectionId, activeTpvId]);

  // ── Probe Sales (page 1 only, no save) ────────────────────

  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<Record<string, unknown> | null>(null);

  const probeSales = useCallback(async (startDate: string, endDate: string) => {
    if (!connectionId) return;
    setProbing(true);
    setProbeResult(null);
    try {
      const data = await invoke("probe-sales", { startDate, endDate });
      setProbeResult(data);
    } catch (e) {
      console.error("Probe failed:", e);
      setProbeResult({ success: false, error: (e as Error).message });
    } finally {
      setProbing(false);
    }
  }, [connectionId, manualTpvOverride]);

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

    // Location (from getLocales — informational)
    selectedLocationId,
    selectLocation,
    activeLocationId,

    // TPV (operational — for sales/categories/products)
    selectedTpvId,
    selectTpv,
    activeTpvId,
    tpvSource,
    manualTpvOverride,
    setManualTpvOverride,
    persistManualTpvOverride,

    salesEvents,
    loadingSales,
    salesMetrics,
    fetchSalesForDay,
    fetchSalesRange,

    saving,
    saveResult,
    saveSalesToDb,
    saveSalesRange,

    saveConnection,
    updateConnection,
    loadConnection,
    enableSync,

    diagnosing,
    diagnosisResult,
    diagnoseTpv,

    probing,
    probeResult,
    probeSales,
  };
}
