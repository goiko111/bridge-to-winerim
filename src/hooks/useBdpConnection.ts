import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { PostWriteVerificationResult } from "@/types/postWriteVerification";
import { adaptVerificationResult } from "@/components/PostWriteVerificationDisplay";
import { supabase } from "@/integrations/supabase/client";

export interface BdpTestResult {
  success: boolean;
  status: number;
  statusText: string;
  contentType: string | null;
  bodyPreview: string | null;
  message: string;
}

export interface BdpSalesEvent {
  provider_doc_id: string;
  business_day: string;
  ticket_time: string | null;
  doc_type: string;
  total_amount: number;
  total_tax: number;
  total_net: number;
  line_count: number;
  lines: {
    line_index: number;
    provider_product_id: string;
    name: string;
    family: string | null;
    format: string | null;
    quantity: number;
    unit_price: number;
    total_amount: number;
    vat_rate: number;
  }[];
}

export interface BdpCatalogResult {
  success: boolean;
  totalProducts: number;
  upserted: number;
  totalFamilies: number;
  families: { id: string; name: string }[];
  rawProductsPreview?: string;
  errors: string[];
  message?: string;
}

export interface BdpWriteResult {
  success: boolean;
  method?: string;
  status?: number;
  bodyPreview?: string;
  product?: any;
  message?: string;
}

export interface BdpVerifyResult {
  success: boolean;
  exists?: boolean;
  priceValid?: boolean;
  price?: number;
  name?: string;
  message?: string;
  raw?: any;
}

export interface BdpDiscoveryEndpoint {
  ok: boolean;
  status: number;
  critical: boolean;
  role: string;
  label: string;
  path: string;
  bodyPreview?: string;
  attempts: number;
  lastError?: string;
}

export interface BdpDiscoveryResult {
  success: boolean;
  endpoints: Record<string, BdpDiscoveryEndpoint>;
  discoveredRoutes: Record<string, { path: string; status: number; verified_at: string }>;
  capabilities: { canReadSales: boolean; canReadCatalog: boolean; canWrite: boolean; writeMode: string };
}

export function useBdpConnection() {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<BdpTestResult | null>(null);
  const [saving, setSaving] = useState(false);

  // Sales state
  const [salesEvents, setSalesEvents] = useState<BdpSalesEvent[]>([]);
  const [loadingSales, setLoadingSales] = useState(false);
  const [saveResult, setSaveResult] = useState<{ savedEvents: number; savedLines: number; errors: string[] } | null>(null);
  const [savingSales, setSavingSales] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<{ totalSaved: number; totalLines: number; daysProcessed: number; errors: string[] } | null>(null);
  const [incrementalSyncing, setIncrementalSyncing] = useState(false);
  const [incrementalResult, setIncrementalResult] = useState<{ savedEvents: number; savedLines: number; dateRange: { from: string; to: string }; errors: string[] } | null>(null);

  // Catalog state
  const [syncingCatalog, setSyncingCatalog] = useState(false);
  const [catalogResult, setCatalogResult] = useState<BdpCatalogResult | null>(null);

  // Write state
  const [writingProduct, setWritingProduct] = useState(false);
  const [writeResult, setWriteResult] = useState<BdpWriteResult | null>(null);

  // Verify state
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<BdpVerifyResult | null>(null);

  // Discovery state
  const [discovering, setDiscovering] = useState(false);
  const [discoveryResult, setDiscoveryResult] = useState<BdpDiscoveryResult | null>(null);

  const saveConnection = async (data: {
    locationName: string;
    baseUrl: string;
    port: string;
    userKey: string;
    password: string;
    exportProfileCode: string;
    catalogProfileCode?: string;
    importProfileCode?: string;
  }) => {
    const providerConfig = {
      port: data.port,
      user_key: data.userKey,
      password: data.password,
      export_profile_code: data.exportProfileCode,
      catalog_profile_code: data.catalogProfileCode || "",
      import_profile_code: data.importProfileCode || "",
    };

    let baseUrl = data.baseUrl.trim().replace(/\/+$/, "");
    if (baseUrl && !baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
      baseUrl = "http://" + baseUrl;
    }

    const { data: row, error } = await supabase
      .from("pos_connections")
      .insert({
        location_name: data.locationName,
        base_url: baseUrl,
        api_token: "bdp-managed",
        provider: "bdp",
        sync_mode: "PULL_ONLY",
        provider_config: providerConfig,
      } as any)
      .select()
      .single();
    if (error) throw error;
    setConnectionId(row.id);
    return row.id;
  };

  const updateConnection = async (id: string, data: Record<string, unknown>) => {
    const { error } = await supabase.from("pos_connections").update(data as any).eq("id", id);
    if (error) throw error;
  };

  const testConnection = async (fields: {
    locationName: string;
    baseUrl: string;
    port: string;
    userKey: string;
    password: string;
    exportProfileCode: string;
  }) => {
    setTestStatus("testing");
    setTestError(null);
    setTestResult(null);

    let connId = connectionId;

    if (!connId) {
      try {
        connId = await saveConnection(fields);
      } catch (e: any) {
        setTestStatus("error");
        setTestError(e.message);
        return false;
      }
    } else {
      let baseUrl = fields.baseUrl.trim().replace(/\/+$/, "");
      if (baseUrl && !baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
        baseUrl = "http://" + baseUrl;
      }
      await updateConnection(connId, {
        location_name: fields.locationName,
        base_url: baseUrl,
        provider_config: {
          port: fields.port,
          user_key: fields.userKey,
          password: fields.password,
          export_profile_code: fields.exportProfileCode,
        },
      });
    }

    try {
      const { data, error } = await supabase.functions.invoke("bdp-proxy", {
        body: { action: "test", connectionId: connId },
      });
      if (error) { setTestStatus("error"); setTestError(error.message); return false; }
      setTestResult(data as BdpTestResult);
      if (data?.success) { setTestStatus("success"); return true; }
      setTestStatus("error"); setTestError(data?.message || "Connection failed"); return false;
    } catch (e: any) { setTestStatus("error"); setTestError(e.message); return false; }
  };

  const testCustomEndpoint = async (path: string, method = "GET") => {
    if (!connectionId) return null;
    const { data, error } = await supabase.functions.invoke("bdp-proxy", {
      body: { action: "test-custom", connectionId, path, method },
    });
    if (error) return { success: false, message: error.message } as any;
    return data;
  };

  const runDiscover = useCallback(async () => {
    if (!connectionId) return null;
    setDiscovering(true);
    setDiscoveryResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("bdp-proxy", {
        body: { action: "discover", connectionId },
      });
      if (error) {
        setDiscovering(false);
        return { success: false, message: error.message };
      }
      setDiscoveryResult(data as BdpDiscoveryResult);
      setDiscovering(false);
      return data;
    } catch (e: any) {
      setDiscovering(false);
      return { success: false, message: e.message };
    }
  }, [connectionId]);

  const verifyProductV2 = useCallback(async (productId: string) => {
    if (!connectionId) return null;
    const { data, error } = await supabase.functions.invoke("bdp-proxy", {
      body: { action: "verify-product-v2", connectionId, productId },
    });
    if (error) return null;
    return data;
  }, [connectionId]);

  const fetchSales = useCallback(async (day: string) => {
    if (!connectionId) return;
    setLoadingSales(true); setSalesEvents([]);
    try {
      const { data, error } = await supabase.functions.invoke("bdp-proxy", {
        body: { action: "fetch-sales", connectionId, businessDay: day },
      });
      if (error) throw error;
      setSalesEvents(data?.salesEvents || []);
    } catch (e) { console.error("Failed to fetch BDP sales:", e); }
    finally { setLoadingSales(false); }
  }, [connectionId]);

  const saveSalesToDb = useCallback(async (day: string) => {
    if (!connectionId) return;
    setSavingSales(true); setSaveResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("bdp-proxy", {
        body: { action: "save-sales", connectionId, businessDay: day },
      });
      if (error) throw error;
      setSaveResult({ savedEvents: data?.savedEvents || 0, savedLines: data?.savedLines || 0, errors: data?.errors || [] });
    } catch (e) { console.error("Failed to save BDP sales:", e); }
    finally { setSavingSales(false); }
  }, [connectionId]);

  const runBackfill = useCallback(async (daysBack = 30) => {
    if (!connectionId) return;
    setBackfilling(true); setBackfillResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("bdp-proxy", {
        body: { action: "backfill", connectionId, daysBack },
      });
      if (error) throw error;
      setBackfillResult({ totalSaved: data?.totalSaved || 0, totalLines: data?.totalLines || 0, daysProcessed: data?.daysProcessed || daysBack, errors: data?.errors || [] });
    } catch (e) { console.error("Failed BDP backfill:", e); }
    finally { setBackfilling(false); }
  }, [connectionId]);

  const runIncrementalSync = useCallback(async () => {
    if (!connectionId) return;
    setIncrementalSyncing(true); setIncrementalResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("bdp-proxy", {
        body: { action: "incremental-sync", connectionId },
      });
      if (error) throw error;
      setIncrementalResult({ savedEvents: data?.savedEvents || 0, savedLines: data?.savedLines || 0, dateRange: data?.dateRange || { from: "?", to: "?" }, errors: data?.errors || [] });
    } catch (e) { console.error("Failed BDP incremental sync:", e); }
    finally { setIncrementalSyncing(false); }
  }, [connectionId]);

  // ── Catalog ──
  const syncCatalog = useCallback(async () => {
    if (!connectionId) return;
    setSyncingCatalog(true); setCatalogResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("bdp-proxy", {
        body: { action: "sync-catalog", connectionId },
      });
      if (error) throw error;
      setCatalogResult(data as BdpCatalogResult);
    } catch (e) { console.error("Failed BDP catalog sync:", e); }
    finally { setSyncingCatalog(false); }
  }, [connectionId]);

  // ── Write Product ──
  const writeProduct = useCallback(async (product: {
    provider_product_id?: string;
    name: string;
    price: number;
    vat_rate?: number;
    family?: string;
    format?: string;
    code?: string;
  }) => {
    if (!connectionId) return;
    setWritingProduct(true); setWriteResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("bdp-proxy", {
        body: { action: "write-product", connectionId, product },
      });
      if (error) throw error;
      setWriteResult(data as BdpWriteResult);
      return data as BdpWriteResult;
    } catch (e) { console.error("Failed BDP write:", e); return null; }
    finally { setWritingProduct(false); }
  }, [connectionId]);

  // ── Verify Product ──
  const verifyProduct = useCallback(async (productId: string) => {
    if (!connectionId) return;
    setVerifying(true); setVerifyResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("bdp-proxy", {
        body: { action: "verify-product", connectionId, productId },
      });
      if (error) throw error;
      setVerifyResult(data as BdpVerifyResult);
      return data as BdpVerifyResult;
    } catch (e) { console.error("Failed BDP verify:", e); return null; }
    finally { setVerifying(false); }
  }, [connectionId]);

  const loadExistingConnection = async () => {
    const { data } = await supabase
      .from("pos_connections")
      .select("*")
      .eq("provider", "bdp")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (data) {
      setConnectionId(data.id);
      return data;
    }
    return null;
  };

  return {
    connectionId, testStatus, testError, testResult, saving,
    saveConnection, updateConnection, testConnection, testCustomEndpoint,
    loadExistingConnection, setConnectionId,
    // Discovery
    runDiscover, discovering, discoveryResult,
    // Sales
    salesEvents, loadingSales, fetchSales,
    savingSales, saveResult, saveSalesToDb,
    backfilling, backfillResult, runBackfill,
    incrementalSyncing, incrementalResult, runIncrementalSync,
    // Catalog
    syncingCatalog, catalogResult, syncCatalog,
    // Write
    writingProduct, writeResult, writeProduct,
    // Verify
    verifying, verifyResult, verifyProduct,
    verifyProductV2,
  };
}
