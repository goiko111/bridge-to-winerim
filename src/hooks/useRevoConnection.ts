import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface RevoSalesEvent {
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
    format: string;
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

import type { PostWriteVerificationResult } from "@/types/postWriteVerification";

/** @deprecated Use PostWriteVerificationResult directly */
export type RevoWriteVerificationResult = PostWriteVerificationResult;

export function useRevoConnection() {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);

  const [salesEvents, setSalesEvents] = useState<RevoSalesEvent[]>([]);
  const [loadingSales, setLoadingSales] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ savedEvents: number; savedLines: number } | null>(null);

  const [syncingCatalog, setSyncingCatalog] = useState(false);
  const [catalogSyncResult, setCatalogSyncResult] = useState<{
    totalProducts: number; wineCandidates: number; groups: number; categories: number;
  } | null>(null);

  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<{
    totalSaved: number; totalLines: number; errors: string[];
  } | null>(null);

  const [writeVerification, setWriteVerification] = useState<RevoWriteVerificationResult | null>(null);
  const [verifying, setVerifying] = useState(false);

  const [depValidation, setDepValidation] = useState<{ valid: boolean; missing: { dep: string; message: string; guidance: string }[] } | null>(null);
  const [validatingDeps, setValidatingDeps] = useState(false);

  // Compound token: "tenant|access_token|client_token|webhook_secret"
  const buildToken = (tenant: string, accessToken: string, clientToken: string, webhookSecret: string) =>
    `${tenant}|${accessToken}|${clientToken}|${webhookSecret}`;

  const saveConnection = async (data: {
    locationName: string; tenant: string; accessToken: string; clientToken: string;
    webhookSecret: string; winerimApiToken?: string;
    syncMode: string; syncFrequency: number; backfillDays: number;
  }) => {
    const compoundToken = buildToken(data.tenant, data.accessToken, data.clientToken, data.webhookSecret);
    const { data: row, error } = await supabase
      .from("pos_connections")
      .insert({
        location_name: data.locationName,
        base_url: "https://revoxef.works/api/external",
        api_token: compoundToken,
        winerim_api_token: data.winerimApiToken || null,
        sync_mode: data.syncMode,
        sync_frequency_minutes: data.syncFrequency,
        backfill_days: data.backfillDays,
        provider: "REVO_XEF",
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

  const testConnection = async (
    tenant: string, accessToken: string, clientToken: string,
    webhookSecret: string, winerimApiToken?: string,
  ) => {
    setTestStatus("testing");
    setTestError(null);
    let connId = connectionId;
    if (!connId) {
      try {
        connId = await saveConnection({
          locationName: "New Location", tenant, accessToken, clientToken, webhookSecret,
          winerimApiToken, syncMode: "PULL_ONLY", syncFrequency: 15, backfillDays: 30,
        });
      } catch (e: any) { setTestStatus("error"); setTestError(e.message); return false; }
    } else {
      const compoundToken = buildToken(tenant, accessToken, clientToken, webhookSecret);
      await updateConnection(connId, { api_token: compoundToken, winerim_api_token: winerimApiToken || null });
    }
    try {
      const { data, error } = await supabase.functions.invoke("revo-proxy", {
        body: { action: "test", connectionId: connId },
      });
      if (error) { setTestStatus("error"); setTestError(error.message); return false; }
      if (data?.success) { setTestStatus("success"); return true; }
      setTestStatus("error"); setTestError(data?.message || "Connection failed"); return false;
    } catch (e: any) { setTestStatus("error"); setTestError(e.message); return false; }
  };

  const fetchOrders = useCallback(async (day: string) => {
    if (!connectionId) return;
    setLoadingSales(true); setSalesEvents([]);
    try {
      const { data, error } = await supabase.functions.invoke("revo-proxy", {
        body: { action: "fetch-orders", connectionId, businessDay: day },
      });
      if (error) throw error;
      setSalesEvents(data?.salesEvents || []);
    } catch (e) { console.error("Failed to fetch orders:", e); }
    finally { setLoadingSales(false); }
  }, [connectionId]);

  const saveSalesToDb = useCallback(async (day: string) => {
    if (!connectionId) return;
    setSaving(true); setSaveResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("revo-proxy", {
        body: { action: "save-sales", connectionId, businessDay: day },
      });
      if (error) throw error;
      setSaveResult({ savedEvents: data?.savedEvents || 0, savedLines: data?.savedLines || 0 });
    } catch (e) { console.error("Failed to save sales:", e); }
    finally { setSaving(false); }
  }, [connectionId]);

  const syncCatalog = useCallback(async () => {
    if (!connectionId) return;
    setSyncingCatalog(true); setCatalogSyncResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("revo-proxy", {
        body: { action: "sync-catalog", connectionId },
      });
      if (error) throw error;
      if (data?.success) setCatalogSyncResult({
        totalProducts: data.totalProducts, wineCandidates: data.wineCandidates,
        groups: data.groups, categories: data.categories,
      });
    } catch (e) { console.error("Failed to sync catalog:", e); }
    finally { setSyncingCatalog(false); }
  }, [connectionId]);

  const runBackfill = useCallback(async (daysBack = 30) => {
    if (!connectionId) return;
    setBackfilling(true); setBackfillResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("revo-proxy", {
        body: { action: "backfill", connectionId, daysBack },
      });
      if (error) throw error;
      if (data?.success) setBackfillResult({
        totalSaved: data.totalSaved, totalLines: data.totalLines, errors: data.errors || [],
      });
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

  const verifyWrite = useCallback(async (params: { externalId?: string; revo_item_id?: string; expectedPrice?: number; expectedCategory?: string }) => {
    if (!connectionId) return null;
    setVerifying(true);
    setWriteVerification(null);
    try {
      const { data, error } = await supabase.functions.invoke("revo-proxy", {
        body: { action: "verify-write", connectionId, ...params },
      });
      if (error) throw error;
      setWriteVerification(data);
      return data;
    } catch (e: any) {
      const fail: RevoWriteVerificationResult = {
        success: false, verified_exists: false, verified_prices: false, verified_scope: false,
        errors: [{ code: "VERIFY_CALL_FAILED", message: e.message }], warnings: [],
      };
      setWriteVerification(fail);
      return fail;
    } finally {
      setVerifying(false);
    }
  }, [connectionId]);

  const validateWriteDeps = useCallback(async (itemData: Record<string, unknown>) => {
    if (!connectionId) return null;
    setValidatingDeps(true);
    setDepValidation(null);
    try {
      const { data, error } = await supabase.functions.invoke("revo-proxy", {
        body: { action: "validate-write-deps", connectionId, itemData },
      });
      if (error) throw error;
      setDepValidation(data);
      return data;
    } catch (e: any) {
      const fail = { valid: false, missing: [{ dep: "error", message: e.message, guidance: "Check connection." }] };
      setDepValidation(fail);
      return fail;
    } finally {
      setValidatingDeps(false);
    }
  }, [connectionId]);

  return {
    connectionId, setConnectionId,
    testStatus, testError, testConnection,
    saveConnection, updateConnection, loadConnection,
    salesEvents, loadingSales, fetchOrders,
    saving, saveResult, saveSalesToDb,
    syncingCatalog, catalogSyncResult, syncCatalog,
    backfilling, backfillResult, runBackfill,
    writeVerification, verifying, verifyWrite,
    depValidation, validatingDeps, validateWriteDeps,
    enableSync,
  };
}
