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

export function useCassaConnection() {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [salesPoints, setSalesPoints] = useState<CassaSalesPoint[]>([]);

  const [salesEvents, setSalesEvents] = useState<CassaSalesEvent[]>([]);
  const [loadingSales, setLoadingSales] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ savedEvents: number; savedLines: number } | null>(null);

  const [syncingProducts, setSyncingProducts] = useState(false);
  const [productSyncResult, setProductSyncResult] = useState<{ totalProducts: number; wineCandidates: number } | null>(null);

  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<{ totalSaved: number; totalLines: number; errors: string[] } | null>(null);

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
    setConnectionId(row.id);
    return row.id;
  };

  const updateConnection = async (id: string, data: Record<string, unknown>) => {
    const { error } = await supabase.from("pos_connections").update(data).eq("id", id);
    if (error) throw error;
  };

  const testConnection = async (apiKey: string, winerimApiToken?: string) => {
    setTestStatus("testing");
    setTestError(null);
    let connId = connectionId;
    if (!connId) {
      try {
        connId = await saveConnection({
          locationName: "New Location", apiKey, winerimApiToken,
          syncMode: "PULL_ONLY", syncFrequency: 15, backfillDays: 30,
        });
      } catch (e: any) { setTestStatus("error"); setTestError(e.message); return false; }
    } else {
      await updateConnection(connId, { api_token: apiKey, winerim_api_token: winerimApiToken || null });
    }
    try {
      const { data, error } = await supabase.functions.invoke("cassa-proxy", {
        body: { action: "test", connectionId: connId },
      });
      if (error) { setTestStatus("error"); setTestError(error.message); return false; }
      if (data?.success) {
        setTestStatus("success");
        setSalesPoints(data.salesPoints || []);
        return true;
      } else {
        setTestStatus("error");
        setTestError(data?.message || "Connection failed");
        return false;
      }
    } catch (e: any) { setTestStatus("error"); setTestError(e.message); return false; }
  };

  const fetchSalesPoints = useCallback(async () => {
    if (!connectionId) return;
    try {
      const { data, error } = await supabase.functions.invoke("cassa-proxy", {
        body: { action: "fetch-sales-points", connectionId },
      });
      if (error) throw error;
      setSalesPoints(data?.salesPoints || []);
    } catch (e) { console.error("Failed to fetch sales points:", e); }
  }, [connectionId]);

  const fetchDocuments = useCallback(async (day: string) => {
    if (!connectionId) return;
    setLoadingSales(true); setSalesEvents([]);
    try {
      const { data, error } = await supabase.functions.invoke("cassa-proxy", {
        body: { action: "fetch-documents", connectionId, businessDay: day },
      });
      if (error) throw error;
      setSalesEvents(data?.salesEvents || []);
    } catch (e) { console.error("Failed to fetch documents:", e); }
    finally { setLoadingSales(false); }
  }, [connectionId]);

  const saveSalesToDb = useCallback(async (day: string) => {
    if (!connectionId) return;
    setSaving(true); setSaveResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("cassa-proxy", {
        body: { action: "save-sales", connectionId, businessDay: day },
      });
      if (error) throw error;
      setSaveResult({ savedEvents: data?.savedEvents || 0, savedLines: data?.savedLines || 0 });
    } catch (e) { console.error("Failed to save sales:", e); }
    finally { setSaving(false); }
  }, [connectionId]);

  const syncProducts = useCallback(async () => {
    if (!connectionId) return;
    setSyncingProducts(true); setProductSyncResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("cassa-proxy", {
        body: { action: "sync-products", connectionId },
      });
      if (error) throw error;
      if (data?.success) setProductSyncResult({ totalProducts: data.totalProducts, wineCandidates: data.wineCandidates });
    } catch (e) { console.error("Failed to sync products:", e); }
    finally { setSyncingProducts(false); }
  }, [connectionId]);

  const runBackfill = useCallback(async (daysBack = 30) => {
    if (!connectionId) return;
    setBackfilling(true); setBackfillResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("cassa-proxy", {
        body: { action: "backfill", connectionId, daysBack },
      });
      if (error) throw error;
      if (data?.success) setBackfillResult({ totalSaved: data.totalSaved, totalLines: data.totalLines, errors: data.errors || [] });
    } catch (e) { console.error("Failed to backfill:", e); }
    finally { setBackfilling(false); }
  }, [connectionId]);

  const enableSync = async () => {
    if (!connectionId) return;
    await updateConnection(connectionId, { enabled: true });
  };

  const loadConnection = useCallback(async (id: string) => {
    const { data, error } = await supabase.from("pos_connections").select("*").eq("id", id).single();
    if (error || !data) return null;
    setConnectionId(data.id);
    return data;
  }, []);

  return {
    connectionId, setConnectionId,
    testStatus, testError, testConnection,
    saveConnection, updateConnection, loadConnection,
    salesPoints, fetchSalesPoints,
    salesEvents, loadingSales, fetchDocuments,
    saving, saveResult, saveSalesToDb,
    syncingProducts, productSyncResult, syncProducts,
    backfilling, backfillResult, runBackfill,
    enableSync,
  };
}
