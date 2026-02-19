import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

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
  wine_score?: number;
  wine_reasons?: string[];
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

export interface DetectedFamily {
  name: string;
  suggestedWine: boolean;
  confidence: "high" | "medium" | "low";
  itemCount: number;
}

export interface CatalogDiscoveryResult {
  filter: string;
  status: number;
  contentType: string;
  count: number;
  sample: unknown;
}

export interface CatalogStatus {
  catalogEndpoint: string | null;
  lastCatalogSyncAt: string | null;
  catalogProductCount: number;
  catalogWineCandidateCount: number;
  catalogSyncEnabled: boolean;
}

export interface ProviderProduct {
  id: string;
  provider_product_id: string;
  name: string;
  family: string | null;
  vat_rate: number;
  sale_format: string | null;
  price: number;
  is_wine_candidate: boolean;
  wine_score: number;
  wine_reasons: string[];
}

export function useAgoraConnection() {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);

  // Business day state
  const [daysWithSales, setDaysWithSales] = useState<string[]>([]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [loadingDays, setLoadingDays] = useState(false);
  const [scanStats, setScanStats] = useState<{ totalScanned: number; totalInvoicesFound: number } | null>(null);

  // Sales data
  const [salesEvents, setSalesEvents] = useState<SalesEvent[]>([]);
  const [detectedFamilies, setDetectedFamilies] = useState<DetectedFamily[]>([]);
  const [loadingSales, setLoadingSales] = useState(false);

  // Save status
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ savedEvents: number; savedLines: number } | null>(null);

  // Catalog state
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus>({
    catalogEndpoint: null,
    lastCatalogSyncAt: null,
    catalogProductCount: 0,
    catalogWineCandidateCount: 0,
    catalogSyncEnabled: true,
  });
  const [catalogDiscovering, setCatalogDiscovering] = useState(false);
  const [catalogDiscoveryResults, setCatalogDiscoveryResults] = useState<CatalogDiscoveryResult[]>([]);
  const [catalogDiscoverySample, setCatalogDiscoverySample] = useState<unknown>(null);
  const [catalogSyncing, setCatalogSyncing] = useState(false);
  const [catalogSyncResult, setCatalogSyncResult] = useState<{ totalProducts: number; wineCandidates: number } | null>(null);
  const [catalogTestResult, setCatalogTestResult] = useState<{ count: number; sample: unknown[] } | null>(null);
  const [catalogTestingEndpoint, setCatalogTestingEndpoint] = useState(false);
  const [catalogProducts, setCatalogProducts] = useState<ProviderProduct[]>([]);

  const saveConnection = async (data: {
    locationName: string;
    baseUrl: string;
    apiToken: string;
    winerimApiToken?: string;
    syncMode: string;
    syncFrequency: number;
    backfillDays: number;
  }) => {
    const { data: row, error } = await supabase
      .from("pos_connections")
      .insert({
        location_name: data.locationName,
        base_url: data.baseUrl,
        api_token: data.apiToken,
        winerim_api_token: data.winerimApiToken || null,
        sync_mode: data.syncMode,
        sync_frequency_minutes: data.syncFrequency,
        backfill_days: data.backfillDays,
      } as any)
      .select()
      .single();

    if (error) throw error;
    setConnectionId(row.id);
    return row.id;
  };

  const updateConnection = async (id: string, data: Record<string, unknown>) => {
    const { error } = await supabase
      .from("pos_connections")
      .update(data)
      .eq("id", id);
    if (error) throw error;
  };

  const testConnection = async (baseUrl: string, apiToken: string, winerimApiToken?: string) => {
    setTestStatus("testing");
    setTestError(null);

    let connId = connectionId;
    if (!connId) {
      try {
        connId = await saveConnection({
          locationName: "New Location",
          baseUrl,
          apiToken,
          winerimApiToken,
          syncMode: "PULL_ONLY",
          syncFrequency: 15,
          backfillDays: 30,
        });
      } catch (e: any) {
        setTestStatus("error");
        setTestError(e.message);
        return false;
      }
    } else {
      await updateConnection(connId, { base_url: baseUrl, api_token: apiToken, winerim_api_token: winerimApiToken || null });
    }

    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "test", connectionId: connId },
      });

      if (error) {
        setTestStatus("error");
        setTestError(error.message);
        return false;
      }

      if (data?.success) {
        setTestStatus("success");
        return true;
      } else {
        setTestStatus("error");
        setTestError(data?.message || "Connection failed");
        return false;
      }
    } catch (e: any) {
      setTestStatus("error");
      setTestError(e.message);
      return false;
    }
  };

  const findDaysWithSales = useCallback(async (daysBack = 60) => {
    if (!connectionId) return;
    setLoadingDays(true);
    setScanStats(null);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "find-last-business-day", connectionId, daysBack },
      });
      if (error) throw error;
      const days: string[] = data?.daysWithSales || [];
      setDaysWithSales(days);
      setScanStats({
        totalScanned: data?.totalScanned || 0,
        totalInvoicesFound: data?.totalInvoicesFound || 0,
      });
      if (days.length > 0 && !selectedDay) {
        setSelectedDay(days[0]);
      }
    } catch (e) {
      console.error("Failed to find business days:", e);
    } finally {
      setLoadingDays(false);
    }
  }, [connectionId, selectedDay]);

  const fetchSalesForDay = useCallback(async (day: string) => {
    if (!connectionId) return;
    setLoadingSales(true);
    setSalesEvents([]);
    setDetectedFamilies([]);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "fetch-day", connectionId, businessDay: day },
      });
      if (error) throw error;
      setSalesEvents(data?.salesEvents || []);
      setDetectedFamilies(data?.detectedFamilies || []);
    } catch (e) {
      console.error("Failed to fetch sales:", e);
    } finally {
      setLoadingSales(false);
    }
  }, [connectionId]);

  const saveSalesToDb = useCallback(async (day: string) => {
    if (!connectionId) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "save-sales", connectionId, businessDay: day },
      });
      if (error) throw error;
      setSaveResult({ savedEvents: data?.savedEvents || 0, savedLines: data?.savedLines || 0 });
    } catch (e) {
      console.error("Failed to save sales:", e);
    } finally {
      setSaving(false);
    }
  }, [connectionId]);

  const enableSync = async () => {
    if (!connectionId) return;
    await updateConnection(connectionId, { enabled: true });
  };

  // Wine family rules
  const saveFamilyRules = useCallback(async (families: { name: string; isWine: boolean }[]) => {
    if (!connectionId) return;
    for (const f of families) {
      await supabase.from("wine_family_rules").upsert(
        { connection_id: connectionId, family_name: f.name, is_wine: f.isWine },
        { onConflict: "connection_id,family_name" }
      );
    }
  }, [connectionId]);

  // ── Catalog methods ──

  const discoverCatalog = useCallback(async () => {
    if (!connectionId) return;
    setCatalogDiscovering(true);
    setCatalogDiscoveryResults([]);
    setCatalogDiscoverySample(null);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "discover-catalog", connectionId },
      });
      if (error) throw error;
      setCatalogDiscoveryResults(data?.allResults || []);
      if (data?.success) {
        setCatalogDiscoverySample(data.sample);
        setCatalogStatus((prev) => ({ ...prev, catalogEndpoint: data.selectedEndpoint }));
      }
      return data;
    } catch (e) {
      console.error("Failed to discover catalog:", e);
    } finally {
      setCatalogDiscovering(false);
    }
  }, [connectionId]);

  const syncCatalog = useCallback(async () => {
    if (!connectionId) return;
    setCatalogSyncing(true);
    setCatalogSyncResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "sync-catalog", connectionId },
      });
      if (error) throw error;
      if (data?.success) {
        setCatalogSyncResult({ totalProducts: data.totalProducts, wineCandidates: data.wineCandidates });
        setCatalogStatus((prev) => ({
          ...prev,
          lastCatalogSyncAt: new Date().toISOString(),
          catalogProductCount: data.totalProducts,
          catalogWineCandidateCount: data.wineCandidates,
          catalogEndpoint: data.endpoint,
        }));
      }
      return data;
    } catch (e) {
      console.error("Failed to sync catalog:", e);
    } finally {
      setCatalogSyncing(false);
    }
  }, [connectionId]);

  const testCatalogEndpoint = useCallback(async (filter?: string) => {
    if (!connectionId) return;
    setCatalogTestingEndpoint(true);
    setCatalogTestResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "test-catalog-endpoint", connectionId, filter },
      });
      if (error) throw error;
      if (data?.success) {
        setCatalogTestResult({ count: data.count, sample: data.sample || [] });
      }
      return data;
    } catch (e) {
      console.error("Failed to test catalog endpoint:", e);
    } finally {
      setCatalogTestingEndpoint(false);
    }
  }, [connectionId]);

  const fetchCatalogProducts = useCallback(async () => {
    if (!connectionId) return;
    const { data, error } = await supabase
      .from("provider_products")
      .select("id, provider_product_id, name, family, vat_rate, sale_format, price, is_wine_candidate, wine_score, wine_reasons")
      .eq("connection_id", connectionId)
      .order("name")
      .limit(500);
    if (!error && data) {
      setCatalogProducts(data as unknown as ProviderProduct[]);
    }
  }, [connectionId]);

  const toggleCatalogSync = useCallback(async (enabled: boolean) => {
    if (!connectionId) return;
    await updateConnection(connectionId, { catalog_sync_enabled: enabled });
    setCatalogStatus((prev) => ({ ...prev, catalogSyncEnabled: enabled }));
  }, [connectionId]);

  const loadConnection = useCallback(async (id: string) => {
    const { data, error } = await supabase
      .from("pos_connections")
      .select("*")
      .eq("id", id)
      .single();
    if (error || !data) return null;
    setConnectionId(data.id);
    // Load catalog status from connection
    const conn = data as any;
    setCatalogStatus({
      catalogEndpoint: conn.catalog_endpoint || null,
      lastCatalogSyncAt: conn.last_catalog_sync_at || null,
      catalogProductCount: conn.catalog_product_count || 0,
      catalogWineCandidateCount: conn.catalog_wine_candidate_count || 0,
      catalogSyncEnabled: conn.catalog_sync_enabled ?? true,
    });
    return data;
  }, []);

  return {
    connectionId,
    setConnectionId,
    testStatus,
    testError,
    testConnection,
    saveConnection,
    updateConnection,
    loadConnection,
    // Business days
    daysWithSales,
    selectedDay,
    setSelectedDay,
    loadingDays,
    findDaysWithSales,
    scanStats,
    // Sales
    salesEvents,
    detectedFamilies,
    loadingSales,
    fetchSalesForDay,
    // Persist
    saving,
    saveResult,
    saveSalesToDb,
    // Sync
    enableSync,
    // Families
    saveFamilyRules,
    // Catalog
    catalogStatus,
    catalogDiscovering,
    catalogDiscoveryResults,
    catalogDiscoverySample,
    catalogSyncing,
    catalogSyncResult,
    catalogTestResult,
    catalogTestingEndpoint,
    catalogProducts,
    discoverCatalog,
    syncCatalog,
    testCatalogEndpoint,
    fetchCatalogProducts,
    toggleCatalogSync,
  };
}
