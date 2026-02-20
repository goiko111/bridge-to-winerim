import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface CassaSalesPoint {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface CassaSalesEvent {
  provider_doc_id: string;
  business_day: string;
  doc_type: string;
  total_amount: number;
  total_tax: number;
  total_net: number;
  line_count: number;
  lines: {
    provider_product_id: string;
    name: string;
    family: string;
    quantity: number;
    unit_price: number;
    total_amount: number;
    vat_rate: number;
    is_wine_candidate: boolean;
    wine_score?: number;
    wine_reasons?: string[];
  }[];
}

interface CassaState {
  connectionId: string | null;
  testStatus: "idle" | "testing" | "success" | "error";
  testError: string | null;
  diagnostics: any[] | null;
  salesPoints: CassaSalesPoint[];
  salesEvents: CassaSalesEvent[];
  loadingSales: boolean;
  saving: boolean;
  saveResult: { savedEvents: number; savedLines: number } | null;
  syncingProducts: boolean;
  productSyncResult: { totalProducts: number; wineCandidates: number } | null;
  backfilling: boolean;
  backfillResult: { totalSaved: number; totalLines: number; errors: string[] } | null;
}

const initialState: CassaState = {
  connectionId: null,
  testStatus: "idle",
  testError: null,
  diagnostics: null,
  salesPoints: [],
  salesEvents: [],
  loadingSales: false,
  saving: false,
  saveResult: null,
  syncingProducts: false,
  productSyncResult: null,
  backfilling: false,
  backfillResult: null,
};

export function useCassaConnection() {
  const [state, setState] = useState<CassaState>(initialState);

  const patch = useCallback((partial: Partial<CassaState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  const saveConnection = async (data: {
    locationName: string; apiKey: string; winerimApiToken?: string;
    syncMode: string; syncFrequency: number; backfillDays: number;
    selectedSalesPointIds?: string[];
  }) => {
    const baseUrl = "https://api.cassanova.com";
    const { data: row, error } = await supabase
      .from("pos_connections")
      .insert({
        location_name: data.locationName,
        base_url: baseUrl,
        api_token: data.apiKey,
        winerim_api_token: data.winerimApiToken || null,
        sync_mode: data.syncMode,
        sync_frequency_minutes: data.syncFrequency,
        backfill_days: data.backfillDays,
        provider: "CASSA_IN_CLOUD",
      } as any)
      .select().single();
    if (error) throw error;
    patch({ connectionId: row.id });
    return row.id;
  };

  const updateConnection = async (id: string, data: Record<string, unknown>) => {
    const { error } = await supabase.from("pos_connections").update(data).eq("id", id);
    if (error) throw error;
  };

  const testConnection = async (apiKey: string, winerimApiToken?: string) => {
    patch({ testStatus: "testing", testError: null, diagnostics: null });
    let connId = state.connectionId;
    if (!connId) {
      try {
        connId = await saveConnection({
          locationName: "New Location", apiKey, winerimApiToken,
          syncMode: "PULL_ONLY", syncFrequency: 15, backfillDays: 30,
        });
      } catch (e: any) { patch({ testStatus: "error", testError: e.message }); return false; }
    } else {
      await updateConnection(connId, { api_token: apiKey, winerim_api_token: winerimApiToken || null });
    }
    try {
      const { data, error } = await supabase.functions.invoke("cassa-proxy", {
        body: { action: "test", connectionId: connId },
      });
      if (data?.diagnostics) patch({ diagnostics: data.diagnostics });
      if (error) { patch({ testStatus: "error", testError: error.message }); return false; }
      if (data?.success) {
        patch({ testStatus: "success", salesPoints: data.salesPoints || [] });
        return true;
      } else {
        patch({ testStatus: "error", testError: data?.message || data?.error || "Connection failed" });
        return false;
      }
    } catch (e: any) { patch({ testStatus: "error", testError: e.message }); return false; }
  };

  const fetchSalesPoints = useCallback(async () => {
    if (!state.connectionId) return;
    try {
      const { data, error } = await supabase.functions.invoke("cassa-proxy", {
        body: { action: "fetch-sales-points", connectionId: state.connectionId },
      });
      if (error) throw error;
      patch({ salesPoints: data?.salesPoints || [] });
    } catch (e) { console.error("Failed to fetch sales points:", e); }
  }, [state.connectionId, patch]);

  const fetchDocuments = useCallback(async (day: string) => {
    if (!state.connectionId) return;
    patch({ loadingSales: true, salesEvents: [] });
    try {
      const { data, error } = await supabase.functions.invoke("cassa-proxy", {
        body: { action: "fetch-documents", connectionId: state.connectionId, businessDay: day },
      });
      if (error) throw error;
      patch({ salesEvents: data?.salesEvents || [], loadingSales: false });
    } catch (e) { console.error("Failed to fetch documents:", e); patch({ loadingSales: false }); }
  }, [state.connectionId, patch]);

  const saveSalesToDb = useCallback(async (day: string) => {
    if (!state.connectionId) return;
    patch({ saving: true, saveResult: null });
    try {
      const { data, error } = await supabase.functions.invoke("cassa-proxy", {
        body: { action: "save-sales", connectionId: state.connectionId, businessDay: day },
      });
      if (error) throw error;
      patch({ saveResult: { savedEvents: data?.savedEvents || 0, savedLines: data?.savedLines || 0 }, saving: false });
    } catch (e) { console.error("Failed to save sales:", e); patch({ saving: false }); }
  }, [state.connectionId, patch]);

  const syncProducts = useCallback(async () => {
    if (!state.connectionId) return;
    patch({ syncingProducts: true, productSyncResult: null });
    try {
      const { data, error } = await supabase.functions.invoke("cassa-proxy", {
        body: { action: "sync-products", connectionId: state.connectionId },
      });
      if (error) throw error;
      if (data?.success) patch({ productSyncResult: { totalProducts: data.totalProducts, wineCandidates: data.wineCandidates }, syncingProducts: false });
      else patch({ syncingProducts: false });
    } catch (e) { console.error("Failed to sync products:", e); patch({ syncingProducts: false }); }
  }, [state.connectionId, patch]);

  const runBackfill = useCallback(async (daysBack = 30) => {
    if (!state.connectionId) return;
    patch({ backfilling: true, backfillResult: null });
    try {
      const { data, error } = await supabase.functions.invoke("cassa-proxy", {
        body: { action: "backfill", connectionId: state.connectionId, daysBack },
      });
      if (error) throw error;
      if (data?.success) patch({ backfillResult: { totalSaved: data.totalSaved, totalLines: data.totalLines, errors: data.errors || [] }, backfilling: false });
      else patch({ backfilling: false });
    } catch (e) { console.error("Failed to backfill:", e); patch({ backfilling: false }); }
  }, [state.connectionId, patch]);

  const enableSync = async () => {
    if (!state.connectionId) return;
    await updateConnection(state.connectionId, { enabled: true });
  };

  const loadConnection = useCallback(async (id: string) => {
    const { data, error } = await supabase.from("pos_connections").select("*").eq("id", id).single();
    if (error || !data) return null;
    patch({ connectionId: data.id });
    return data;
  }, [patch]);

  return {
    connectionId: state.connectionId,
    setConnectionId: (id: string | null) => patch({ connectionId: id }),
    testStatus: state.testStatus,
    testError: state.testError,
    testConnection,
    diagnostics: state.diagnostics,
    saveConnection,
    updateConnection,
    loadConnection,
    salesPoints: state.salesPoints,
    fetchSalesPoints,
    salesEvents: state.salesEvents,
    loadingSales: state.loadingSales,
    fetchDocuments,
    saving: state.saving,
    saveResult: state.saveResult,
    saveSalesToDb,
    syncingProducts: state.syncingProducts,
    productSyncResult: state.productSyncResult,
    syncProducts,
    backfilling: state.backfilling,
    backfillResult: state.backfillResult,
    runBackfill,
    enableSync,
  };
}
