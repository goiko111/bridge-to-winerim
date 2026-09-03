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

export interface CatalogProduct {
  provider_product_id: string;
  name: string;
  family: string;
  price: number;
  is_wine_candidate: boolean;
  wine_score: number;
  wine_reasons: string[];
}

export interface OAuthCredential {
  merchant_id: string;
  status: string;
  scopes: string[];
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CloverState {
  connectionId: string | null;
  testStatus: "idle" | "testing" | "success" | "error";
  testError: string | null;
  merchantName: string | null;
  // OAuth
  oauthStatus: "idle" | "connecting" | "connected" | "error";
  oauthError: string | null;
  oauthCredential: OAuthCredential | null;
  // Days / sales
  daysWithSales: string[];
  selectedDay: string | null;
  loadingDays: boolean;
  scanStats: { totalScanned: number; totalInvoicesFound: number } | null;
  salesEvents: SalesEvent[];
  detectedFamilies: DetectedFamily[];
  loadingSales: boolean;
  // Catalog
  catalogProducts: CatalogProduct[];
  loadingCatalog: boolean;
  catalogStats: { totalProducts: number; wineCandidates: number } | null;
  // Save
  saving: boolean;
  saveResult: { savedEvents: number; savedLines: number } | null;
}

const initialState: CloverState = {
  connectionId: null,
  testStatus: "idle",
  testError: null,
  merchantName: null,
  oauthStatus: "idle",
  oauthError: null,
  oauthCredential: null,
  daysWithSales: [],
  selectedDay: null,
  loadingDays: false,
  scanStats: null,
  salesEvents: [],
  detectedFamilies: [],
  loadingSales: false,
  catalogProducts: [],
  loadingCatalog: false,
  catalogStats: null,
  saving: false,
  saveResult: null,
};

export function useCloverConnection() {
  const [state, setState] = useState<CloverState>(initialState);

  const patch = useCallback((partial: Partial<CloverState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  // ── Save connection (creates a pos_connections row) ──
  const saveConnection = async (data: {
    locationName: string;
    region: string;
    winerimApiToken?: string;
    syncMode: string;
    syncFrequency: number;
    backfillDays: number;
  }) => {
    // For OAuth, we store region as base_url initially (will be updated after OAuth)
    const { data: row, error } = await supabase
      .from("pos_connections")
      .insert({
        location_name: data.locationName || "New Location",
        base_url: data.region, // Just the region base URL initially
        api_token: "OAUTH_PENDING", // Placeholder until OAuth completes
        winerim_api_token: data.winerimApiToken || null,
        provider: "clover",
        sync_mode: data.syncMode,
        sync_frequency_minutes: data.syncFrequency,
        backfill_days: data.backfillDays,
      } as any)
      .select()
      .single();

    if (error) throw error;
    patch({ connectionId: row.id });
    return row.id;
  };

  const updateConnection = async (id: string, data: Record<string, unknown>) => {
    const { error } = await supabase
      .from("pos_connections")
      .update(data)
      .eq("id", id);
    if (error) throw error;
  };

  // ── OAuth: Start flow ──
  const startOAuth = useCallback(async (region: string, locationName: string, winerimApiToken?: string) => {
    patch({ oauthStatus: "connecting", oauthError: null });

    let connId = state.connectionId;
    if (!connId) {
      try {
        connId = await saveConnection({
          locationName,
          region,
          winerimApiToken,
          syncMode: "PULL_ONLY",
          syncFrequency: 15,
          backfillDays: 30,
        });
      } catch (e: any) {
        patch({ oauthStatus: "error", oauthError: e.message });
        return;
      }
    } else {
      // Update region if changed
      await updateConnection(connId, { base_url: region, winerim_api_token: winerimApiToken || null });
    }

    try {
      const { data, error } = await supabase.functions.invoke("clover-oauth", {
        body: { action: "start", connectionId: connId, region },
      });

      if (error) {
        patch({ oauthStatus: "error", oauthError: error.message });
        return;
      }

      if (data?.authorizeUrl) {
        // Open OAuth popup
        const popup = window.open(data.authorizeUrl, "clover-oauth", "width=600,height=700,popup=yes");

        // Listen for OAuth completion via postMessage
        const handler = (event: MessageEvent) => {
          if (event.data?.type === "CLOVER_OAUTH_SUCCESS") {
            window.removeEventListener("message", handler);
            patch({
              oauthStatus: "connected",
              connectionId: event.data.connectionId,
              merchantName: event.data.merchantName || event.data.merchantId,
              testStatus: "success",
            });
          }
        };
        window.addEventListener("message", handler);

        // Fallback: poll for status if popup is blocked or postMessage fails
        const pollInterval = setInterval(async () => {
          if (popup?.closed) {
            clearInterval(pollInterval);
            window.removeEventListener("message", handler);
            // Check if OAuth completed
            const { data: statusData } = await supabase.functions.invoke("clover-oauth", {
              body: { action: "status", connectionId: connId },
            });
            if (statusData?.credential?.status === "CONNECTED") {
              patch({
                oauthStatus: "connected",
                oauthCredential: statusData.credential,
                merchantName: statusData.credential.merchant_id,
                testStatus: "success",
              });
            } else {
              patch({ oauthStatus: "error", oauthError: "OAuth window closed without completing authorization." });
            }
          }
        }, 1500);

        // Clean up after 5 minutes max
        setTimeout(() => {
          clearInterval(pollInterval);
          window.removeEventListener("message", handler);
        }, 5 * 60 * 1000);
      }
    } catch (e: any) {
      patch({ oauthStatus: "error", oauthError: e.message });
    }
  }, [state.connectionId]);

  // ── Test connection (using stored OAuth token) ──
  const testConnection = async () => {
    if (!state.connectionId) return false;
    patch({ testStatus: "testing", testError: null, merchantName: null });

    try {
      const { data, error } = await supabase.functions.invoke("clover-proxy", {
        body: { action: "test", connectionId: state.connectionId },
      });

      if (error) {
        patch({ testStatus: "error", testError: error.message });
        return false;
      }

      if (data?.success) {
        patch({ testStatus: "success", merchantName: data.merchantName || null });
        return true;
      } else {
        patch({ testStatus: "error", testError: data?.message || "Connection failed" });
        return false;
      }
    } catch (e: any) {
      patch({ testStatus: "error", testError: e.message });
      return false;
    }
  };

  // ── Fetch catalog ──
  const fetchCatalog = useCallback(async () => {
    if (!state.connectionId) return;
    patch({ loadingCatalog: true, catalogProducts: [], catalogStats: null });
    try {
      const { data, error } = await supabase.functions.invoke("clover-proxy", {
        body: { action: "fetch-catalog", connectionId: state.connectionId },
      });
      if (error) throw error;
      patch({
        catalogProducts: data?.products || [],
        catalogStats: { totalProducts: data?.totalProducts || 0, wineCandidates: data?.wineCandidates || 0 },
        loadingCatalog: false,
      });
    } catch (e) {
      console.error("Failed to fetch catalog:", e);
      patch({ loadingCatalog: false });
    }
  }, [state.connectionId]);

  // ── Find days with sales ──
  const findDaysWithSales = useCallback(async (daysBack = 60) => {
    if (!state.connectionId) return;
    patch({ loadingDays: true, scanStats: null });
    try {
      const { data, error } = await supabase.functions.invoke("clover-proxy", {
        body: { action: "find-last-business-day", connectionId: state.connectionId, daysBack },
      });
      if (error) throw error;
      const days: string[] = data?.daysWithSales || [];
      patch({
        daysWithSales: days,
        scanStats: { totalScanned: data?.totalScanned || 0, totalInvoicesFound: data?.totalInvoicesFound || 0 },
        selectedDay: days.length > 0 && !state.selectedDay ? days[0] : state.selectedDay,
        loadingDays: false,
      });
    } catch (e) {
      console.error("Failed to find business days:", e);
      patch({ loadingDays: false });
    }
  }, [state.connectionId, state.selectedDay]);

  // ── Fetch sales for a day ──
  const fetchSalesForDay = useCallback(async (day: string) => {
    if (!state.connectionId) return;
    patch({ loadingSales: true, salesEvents: [], detectedFamilies: [] });
    try {
      const { data, error } = await supabase.functions.invoke("clover-proxy", {
        body: { action: "fetch-day", connectionId: state.connectionId, businessDay: day },
      });
      if (error) throw error;
      patch({
        salesEvents: data?.salesEvents || [],
        detectedFamilies: data?.detectedFamilies || [],
        loadingSales: false,
      });
    } catch (e) {
      console.error("Failed to fetch sales:", e);
      patch({ loadingSales: false });
    }
  }, [state.connectionId]);

  // ── Save sales to DB ──
  const saveSalesToDb = useCallback(async (day: string) => {
    if (!state.connectionId) return;
    patch({ saving: true, saveResult: null });
    try {
      const { data, error } = await supabase.functions.invoke("clover-proxy", {
        body: { action: "save-sales", connectionId: state.connectionId, businessDay: day },
      });
      if (error) throw error;
      patch({ saveResult: { savedEvents: data?.savedEvents || 0, savedLines: data?.savedLines || 0 }, saving: false });
    } catch (e) {
      console.error("Failed to save sales:", e);
      patch({ saving: false });
    }
  }, [state.connectionId]);

  // ── Enable sync ──
  const enableSync = async () => {
    if (!state.connectionId) return;
    await updateConnection(state.connectionId, { enabled: true });
  };

  // ── Save family rules ──
  const saveFamilyRules = useCallback(async (families: { name: string; isWine: boolean }[]) => {
    if (!state.connectionId) return;
    for (const f of families) {
      await supabase.from("wine_family_rules").upsert(
        { connection_id: state.connectionId, family_name: f.name, is_wine: f.isWine },
        { onConflict: "connection_id,family_name" }
      );
    }
  }, [state.connectionId]);

  // ── Load existing connection ──
  const loadConnection = useCallback(async (id: string) => {
    const { data, error } = await supabase
      .from("pos_connections")
      .select("*")
      .eq("id", id)
      .single();
    if (error || !data) return null;
    patch({ connectionId: data.id });

    // Check OAuth status
    const { data: credData } = await supabase.functions.invoke("clover-oauth", {
      body: { action: "status", connectionId: id },
    });
    if (credData?.credential?.status === "CONNECTED") {
      patch({
        oauthStatus: "connected",
        oauthCredential: credData.credential,
        merchantName: credData.credential.merchant_id,
        testStatus: "success",
      });
    }

    return data;
  }, []);

  return {
    // State
    connectionId: state.connectionId,
    testStatus: state.testStatus,
    testError: state.testError,
    merchantName: state.merchantName,
    oauthStatus: state.oauthStatus,
    oauthError: state.oauthError,
    oauthCredential: state.oauthCredential,
    daysWithSales: state.daysWithSales,
    selectedDay: state.selectedDay,
    loadingDays: state.loadingDays,
    scanStats: state.scanStats,
    salesEvents: state.salesEvents,
    detectedFamilies: state.detectedFamilies,
    loadingSales: state.loadingSales,
    catalogProducts: state.catalogProducts,
    loadingCatalog: state.loadingCatalog,
    catalogStats: state.catalogStats,
    saving: state.saving,
    saveResult: state.saveResult,
    // Actions
    setSelectedDay: (day: string | null) => patch({ selectedDay: day }),
    setConnectionId: (id: string | null) => patch({ connectionId: id }),
    startOAuth,
    testConnection,
    saveConnection,
    updateConnection,
    loadConnection,
    findDaysWithSales,
    fetchSalesForDay,
    fetchCatalog,
    saveSalesToDb,
    enableSync,
    saveFamilyRules,
  };
}
