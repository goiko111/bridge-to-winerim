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
  label: string;
  status: number;
  contentType: string;
  count: number;
  sample: unknown;
  errorBody?: string;
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
  classification_override: string;
  last_score: number;
  last_reasons: string[];
}

export interface ClassificationConfig {
  id?: string;
  connection_id?: string;
  wine_families_whitelist: string[];
  non_wine_families_blacklist: string[];
  wine_keywords_whitelist: string[];
  non_wine_keywords_blacklist: string[];
  format_whitelist: string[];
  min_wine_price: number;
  max_wine_price: number;
  score_threshold_wine: number;
  score_threshold_not_wine: number;
}

const DEFAULT_CONFIG: ClassificationConfig = {
  wine_families_whitelist: [],
  non_wine_families_blacklist: [],
  wine_keywords_whitelist: [],
  non_wine_keywords_blacklist: [],
  format_whitelist: [],
  min_wine_price: 6,
  max_wine_price: 600,
  score_threshold_wine: 40,
  score_threshold_not_wine: 0,
};

export function useAgoraConnection() {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);

  const [daysWithSales, setDaysWithSales] = useState<string[]>([]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [loadingDays, setLoadingDays] = useState(false);
  const [scanStats, setScanStats] = useState<{ totalScanned: number; totalInvoicesFound: number } | null>(null);
  const [lastClosedDay, setLastClosedDay] = useState<string | null>(null);

  const [salesEvents, setSalesEvents] = useState<SalesEvent[]>([]);
  const [detectedFamilies, setDetectedFamilies] = useState<DetectedFamily[]>([]);
  const [loadingSales, setLoadingSales] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{
    savedEvents: number;
    savedLines: number;
    resolvedLines: number;
    unresolvedLines: number;
    stockSync?: { synced: number; skipped: number; failed: number; checkedDays?: number; errors?: string[] } | null;
    cursorAdvanced?: boolean;
    warning?: string | null;
  } | null>(null);

  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus>({
    catalogEndpoint: null, lastCatalogSyncAt: null, catalogProductCount: 0,
    catalogWineCandidateCount: 0, catalogSyncEnabled: true,
  });
  const [catalogDiscovering, setCatalogDiscovering] = useState(false);
  const [catalogDiscoveryResults, setCatalogDiscoveryResults] = useState<CatalogDiscoveryResult[]>([]);
  const [catalogDiscoverySample, setCatalogDiscoverySample] = useState<unknown>(null);
  const [catalogSyncing, setCatalogSyncing] = useState(false);
  const [catalogSyncResult, setCatalogSyncResult] = useState<{ totalProducts: number; wineCandidates: number } | null>(null);
  const [catalogTestResult, setCatalogTestResult] = useState<{ count: number; sample: unknown[] } | null>(null);
  const [catalogTestingEndpoint, setCatalogTestingEndpoint] = useState(false);
  const [catalogProducts, setCatalogProducts] = useState<ProviderProduct[]>([]);

  // Classification config
  const [classificationConfig, setClassificationConfig] = useState<ClassificationConfig>(DEFAULT_CONFIG);
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeResult, setRecomputeResult] = useState<{ wine: number; notWine: number; needsReview: number } | null>(null);

  const saveConnection = async (data: {
    locationName: string; baseUrl: string; apiToken: string; winerimApiToken?: string;
    syncMode: string; syncFrequency: number; backfillDays: number;
  }) => {
    const { data: row, error } = await supabase
      .from("pos_connections")
      .insert({
        location_name: data.locationName, base_url: data.baseUrl, api_token: data.apiToken,
        winerim_api_token: data.winerimApiToken || null, sync_mode: data.syncMode,
        sync_frequency_minutes: data.syncFrequency, backfill_days: data.backfillDays,
        provider: "agora", enabled: false,
      } as any)
      .select().single();
    if (error) throw error;
    setConnectionId(row.id);
    return row.id;
  };

  const updateConnection = async (id: string, data: Record<string, unknown>) => {
    const { error } = await supabase.from("pos_connections").update(data).eq("id", id);
    if (error) throw error;
  };

  const testConnection = async (baseUrl: string, apiToken: string, winerimApiToken?: string, locationName?: string) => {
    setTestStatus("testing");
    setTestError(null);
    let connId = connectionId;
    let createdForTest = false;
    const cleanupFailedTestConnection = async () => {
      if (!createdForTest || !connId) return;
      await supabase.from("pos_connections").delete().eq("id", connId);
      setConnectionId(null);
    };
    if (!connId) {
      try {
        connId = await saveConnection({
          locationName: locationName?.trim() || "New Agora Location", baseUrl, apiToken, winerimApiToken,
          syncMode: "PULL_ONLY", syncFrequency: 15, backfillDays: 30,
        });
        createdForTest = true;
      } catch (e: any) { setTestStatus("error"); setTestError(e.message); return false; }
    } else {
      await updateConnection(connId, { base_url: baseUrl, api_token: apiToken, winerim_api_token: winerimApiToken || null });
    }
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "test", connectionId: connId },
      });
      if (error) { await cleanupFailedTestConnection(); setTestStatus("error"); setTestError(error.message); return false; }
      if (data?.success) { setTestStatus("success"); return true; }
      else { await cleanupFailedTestConnection(); setTestStatus("error"); setTestError(data?.message || "Connection failed"); return false; }
    } catch (e: any) { await cleanupFailedTestConnection(); setTestStatus("error"); setTestError(e.message); return false; }
  };

  const findDaysWithSales = useCallback(async (daysBack = 60) => {
    if (!connectionId) return;
    setLoadingDays(true); setScanStats(null);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "find-last-business-day", connectionId, daysBack },
      });
      if (error) throw error;
      const days: string[] = data?.daysWithSales || [];
      setDaysWithSales(days);
      setScanStats({ totalScanned: data?.totalScanned || 0, totalInvoicesFound: data?.totalInvoicesFound || 0 });
      setLastClosedDay(data?.lastClosedDay || (days.length > 0 ? days[0] : null));
      if (days.length > 0 && !selectedDay) setSelectedDay(days[0]);
    } catch (e) { console.error("Failed to find business days:", e); }
    finally { setLoadingDays(false); }
  }, [connectionId, selectedDay]);

  const fetchSalesForDay = useCallback(async (day: string) => {
    if (!connectionId) return;
    setLoadingSales(true); setSalesEvents([]); setDetectedFamilies([]);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "fetch-day", connectionId, businessDay: day },
      });
      if (error) throw error;
      setSalesEvents(data?.salesEvents || []);
      setDetectedFamilies(data?.detectedFamilies || []);
    } catch (e) { console.error("Failed to fetch sales:", e); }
    finally { setLoadingSales(false); }
  }, [connectionId]);

  const saveSalesToDb = useCallback(async (day: string) => {
    if (!connectionId) return;
    setSaving(true); setSaveResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "save-sales", connectionId, businessDay: day },
      });
      if (error) throw error;
      setSaveResult({
        savedEvents: data?.savedEvents || 0,
        savedLines: data?.savedLines || 0,
        resolvedLines: data?.resolvedLines || 0,
        unresolvedLines: data?.unresolvedLines || 0,
        stockSync: data?.stockSync || null,
        cursorAdvanced: data?.cursorAdvanced,
        warning: data?.warning || null,
      });
    } catch (e) { console.error("Failed to save sales:", e); }
    finally { setSaving(false); }
  }, [connectionId]);

  const enableSync = async () => {
    if (!connectionId) return;
    await updateConnection(connectionId, { enabled: true });
  };

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
    setCatalogDiscovering(true); setCatalogDiscoveryResults([]); setCatalogDiscoverySample(null);
    try {
      const lastDay = daysWithSales.length > 0 ? daysWithSales[0] : null;
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "discover-catalog", connectionId, lastBusinessDay: lastDay },
      });
      if (error) throw error;
      setCatalogDiscoveryResults(data?.allResults || []);
      if (data?.success) {
        setCatalogDiscoverySample(data.sample);
        setCatalogStatus((prev) => ({ ...prev, catalogEndpoint: data.selectedEndpoint }));
      }
      return data;
    } catch (e) { console.error("Failed to discover catalog:", e); }
    finally { setCatalogDiscovering(false); }
  }, [connectionId, daysWithSales]);

  const syncCatalog = useCallback(async () => {
    if (!connectionId) return;
    setCatalogSyncing(true); setCatalogSyncResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "sync-catalog", connectionId },
      });
      if (error) throw error;
      if (data?.success) {
        setCatalogSyncResult({ totalProducts: data.totalProducts, wineCandidates: data.wineCandidates });
        setCatalogStatus((prev) => ({
          ...prev, lastCatalogSyncAt: new Date().toISOString(),
          catalogProductCount: data.totalProducts, catalogWineCandidateCount: data.wineCandidates,
          catalogEndpoint: data.endpoint,
        }));
      }
      return data;
    } catch (e) { console.error("Failed to sync catalog:", e); }
    finally { setCatalogSyncing(false); }
  }, [connectionId]);

  const testCatalogEndpoint = useCallback(async (filter?: string) => {
    if (!connectionId) return;
    setCatalogTestingEndpoint(true); setCatalogTestResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "test-catalog-endpoint", connectionId, filter },
      });
      if (error) throw error;
      if (data?.success) setCatalogTestResult({ count: data.count, sample: data.sample || [] });
      return data;
    } catch (e) { console.error("Failed to test catalog endpoint:", e); }
    finally { setCatalogTestingEndpoint(false); }
  }, [connectionId]);

  const fetchCatalogProducts = useCallback(async () => {
    if (!connectionId) return;
    const { data, error } = await supabase
      .from("provider_products")
      .select("id, provider_product_id, name, family, vat_rate, sale_format, price, is_wine_candidate, wine_score, wine_reasons, classification_override, last_score, last_reasons")
      .eq("connection_id", connectionId)
      .order("name")
      .limit(1000);
    if (!error && data) {
      setCatalogProducts(data as unknown as ProviderProduct[]);
    }
  }, [connectionId]);

  const toggleCatalogSync = useCallback(async (enabled: boolean) => {
    if (!connectionId) return;
    await updateConnection(connectionId, { catalog_sync_enabled: enabled });
    setCatalogStatus((prev) => ({ ...prev, catalogSyncEnabled: enabled }));
  }, [connectionId]);

  // Derived catalog fallback
  const [buildingDerived, setBuildingDerived] = useState(false);
  const [derivedResult, setDerivedResult] = useState<{ totalProducts: number; wineCandidates: number; daysScanned: number } | null>(null);

  const buildDerivedCatalog = useCallback(async () => {
    if (!connectionId) return;
    setBuildingDerived(true); setDerivedResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "build-derived-catalog", connectionId, daysBack: 30 },
      });
      if (error) throw error;
      if (data?.success) {
        setDerivedResult({ totalProducts: data.totalProducts, wineCandidates: data.wineCandidates, daysScanned: data.daysScanned });
        setCatalogStatus((prev) => ({
          ...prev, lastCatalogSyncAt: new Date().toISOString(),
          catalogProductCount: data.totalProducts, catalogWineCandidateCount: data.wineCandidates,
          catalogEndpoint: "DERIVED_FROM_INVOICES",
        }));
      }
      return data;
    } catch (e) { console.error("Failed to build derived catalog:", e); }
    finally { setBuildingDerived(false); }
  }, [connectionId]);

  // ── Classification config ──

  const loadClassificationConfig = useCallback(async () => {
    if (!connectionId) return;
    const { data } = await supabase
      .from("classification_config")
      .select("*")
      .eq("connection_id", connectionId)
      .single();
    if (data) {
      setClassificationConfig(data as unknown as ClassificationConfig);
    }
  }, [connectionId]);

  const saveClassificationConfig = useCallback(async (config: Partial<ClassificationConfig>) => {
    if (!connectionId) return;
    const payload = { ...config, connection_id: connectionId };
    const { error } = await supabase
      .from("classification_config")
      .upsert(payload as any, { onConflict: "connection_id" });
    if (error) console.error("Failed to save classification config:", error);
    else setClassificationConfig((prev) => ({ ...prev, ...config }));
  }, [connectionId]);

  const recomputeClassification = useCallback(async () => {
    if (!connectionId) return;
    setRecomputing(true); setRecomputeResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "recompute-classification", connectionId },
      });
      if (error) throw error;
      if (data?.success) {
        setRecomputeResult({ wine: data.wine, notWine: data.notWine, needsReview: data.needsReview });
        // Refresh products
        await fetchCatalogProducts();
      }
      return data;
    } catch (e) { console.error("Failed to recompute:", e); }
    finally { setRecomputing(false); }
  }, [connectionId, fetchCatalogProducts]);

  // Override individual product classification
  const overrideProductClassification = useCallback(async (productId: string, override: "WINE" | "NOT_WINE" | "AUTO") => {
    const { error } = await supabase
      .from("provider_products")
      .update({
        classification_override: override,
        is_wine_candidate: override === "AUTO" ? undefined : override === "WINE",
      } as any)
      .eq("id", productId);
    if (!error) {
      setCatalogProducts((prev) =>
        prev.map((p) =>
          p.id === productId
            ? { ...p, classification_override: override, is_wine_candidate: override === "AUTO" ? p.is_wine_candidate : override === "WINE" }
            : p
        )
      );
    }
  }, []);

  // Bulk override
  const bulkOverrideProducts = useCallback(async (productIds: string[], override: "WINE" | "NOT_WINE") => {
    for (const id of productIds) {
      await supabase.from("provider_products").update({
        classification_override: override,
        is_wine_candidate: override === "WINE",
      } as any).eq("id", id);
    }
    setCatalogProducts((prev) =>
      prev.map((p) =>
        productIds.includes(p.id)
          ? { ...p, classification_override: override, is_wine_candidate: override === "WINE" }
          : p
      )
    );
  }, []);

  const loadConnection = useCallback(async (id: string) => {
    const { data, error } = await supabase.from("pos_connections").select("*").eq("id", id).single();
    if (error || !data) return null;
    setConnectionId(data.id);
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
    connectionId, setConnectionId,
    testStatus, testError, testConnection,
    saveConnection, updateConnection, loadConnection,
    daysWithSales, selectedDay, setSelectedDay, loadingDays, findDaysWithSales, scanStats, lastClosedDay,
    salesEvents, detectedFamilies, loadingSales, fetchSalesForDay,
    saving, saveResult, saveSalesToDb,
    enableSync, saveFamilyRules,
    catalogStatus, catalogDiscovering, catalogDiscoveryResults, catalogDiscoverySample,
    catalogSyncing, catalogSyncResult, catalogTestResult, catalogTestingEndpoint,
    catalogProducts, discoverCatalog, syncCatalog, testCatalogEndpoint,
    fetchCatalogProducts, toggleCatalogSync,
    buildingDerived, derivedResult, buildDerivedCatalog,
    // Classification
    classificationConfig, loadClassificationConfig, saveClassificationConfig,
    recomputing, recomputeResult, recomputeClassification,
    overrideProductClassification, bulkOverrideProducts,
  };
}
