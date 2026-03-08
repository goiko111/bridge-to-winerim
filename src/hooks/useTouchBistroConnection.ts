import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export type TBIntegrationMode = "CSV_REPORTS" | "PRIVATE_API";
export type TBIngestionMethod = "MANUAL_UPLOAD" | "SFTP_PULL" | "HTTPS_PULL";

export type TBReportType = "MENU_ITEM_SALES" | "PAYMENTS" | "BILLS" | "ITEMS" | "UNKNOWN";

export interface TBDetectedFile {
  name: string;
  reportType: TBReportType;
  headers: string[];
  rowCount: number;
  storagePath: string;
}

export interface TBSalesImportResult {
  success: boolean;
  totalEvents: number;
  totalLines: number;
  duplicatesSkipped: number;
  rowsFailed: number;
  failReasons: string[];
  message: string;
}

export interface TBReconciliation {
  date: string;
  billsTotal: number;
  paymentsTotal: number;
  diff: number;
  mismatch: boolean;
}

export interface TBCatalogImportResult {
  success: boolean;
  totalProducts: number;
  inserted: number;
  updated: number;
  matched: number;
  message: string;
}

export interface TBPricingDiagnostics {
  total: number;
  ready: number;
  missing: number;
  bottleCoverage: number;
  glassCoverage: number;
  magnumCoverage: number;
}

export interface TBApiDiscoveryResult {
  success: boolean;
  endpoints: { path: string; status: number; snippet: string }[];
  message: string;
}

export interface TBDebugBundle {
  connectionSettings: Record<string, unknown>;
  importedFiles: TBDetectedFile[];
  parseErrors: string[];
  reconciliation: TBReconciliation[];
  generatedAt: string;
}

export function useTouchBistroConnection() {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);

  // Files
  const [detectedFiles, setDetectedFiles] = useState<TBDetectedFile[]>([]);
  const [uploading, setUploading] = useState(false);

  // Sales import
  const [salesImporting, setSalesImporting] = useState(false);
  const [salesImportResult, setSalesImportResult] = useState<TBSalesImportResult | null>(null);

  // Reconciliation
  const [reconciliation, setReconciliation] = useState<TBReconciliation[]>([]);

  // Catalog
  const [catalogImporting, setCatalogImporting] = useState(false);
  const [catalogImportResult, setCatalogImportResult] = useState<TBCatalogImportResult | null>(null);

  // Pricing
  const [pricingDiagnostics, setPricingDiagnostics] = useState<TBPricingDiagnostics | null>(null);

  // API discovery
  const [apiDiscovering, setApiDiscovering] = useState(false);
  const [apiDiscoveryResult, setApiDiscoveryResult] = useState<TBApiDiscoveryResult | null>(null);

  // Debug bundle
  const [debugBundle, setDebugBundle] = useState<TBDebugBundle | null>(null);

  const callProxy = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    const { data, error } = await supabase.functions.invoke("touchbistro-proxy", {
      body: { action, ...payload },
    });
    if (error) throw new Error(error.message || "Proxy call failed");
    return data;
  }, []);

  const loadExistingConnection = useCallback(async () => {
    const { data } = await supabase.from("pos_connections").select("*")
      .eq("provider", "touchbistro").limit(1).maybeSingle();
    if (data) setConnectionId(data.id);
    return data;
  }, []);

  const saveConnection = useCallback(async (fields: {
    locationName: string;
    integrationMode: TBIntegrationMode;
    ingestionMethod: TBIngestionMethod;
    timezone: string;
    businessDayCloseHour: number;
    sftpHost?: string; sftpPort?: string; sftpUser?: string; sftpPassword?: string; sftpPath?: string;
    httpsUrl?: string;
    apiBaseUrl?: string; apiKey?: string; apiClientId?: string; apiClientSecret?: string; apiLocationId?: string;
  }) => {
    const providerConfig: Record<string, unknown> = {
      integration_mode: fields.integrationMode,
      ingestion_method: fields.ingestionMethod,
      timezone: fields.timezone,
      business_day_close_hour: fields.businessDayCloseHour,
    };
    if (fields.ingestionMethod === "SFTP_PULL") {
      providerConfig.sftp = {
        host: fields.sftpHost, port: fields.sftpPort,
        user: fields.sftpUser, path: fields.sftpPath,
      };
    }
    if (fields.ingestionMethod === "HTTPS_PULL") {
      providerConfig.https = { url: fields.httpsUrl };
    }
    if (fields.integrationMode === "PRIVATE_API") {
      providerConfig.private_api = {
        base_url: fields.apiBaseUrl,
        location_id: fields.apiLocationId,
      };
    }

    const row = {
      provider: "touchbistro" as const,
      location_name: fields.locationName,
      base_url: fields.apiBaseUrl || "csv-mode",
      api_token: fields.apiKey || "csv-mode",
      provider_config: providerConfig as unknown as Record<string, never>,
    };

    if (connectionId) {
      const { error } = await supabase.from("pos_connections").update(row).eq("id", connectionId);
      if (error) throw error;
    } else {
      const { data, error } = await supabase.from("pos_connections").insert(row).select().single();
      if (error) throw error;
      setConnectionId(data.id);
    }
  }, [connectionId]);

  const testConnection = useCallback(async () => {
    if (!connectionId) return;
    setTestStatus("testing");
    setTestError(null);
    try {
      const res = await callProxy("test", { connection_id: connectionId });
      setTestStatus(res.success ? "success" : "error");
      if (!res.success) setTestError(res.message);
    } catch (e: any) {
      setTestStatus("error");
      setTestError(e.message);
    }
  }, [connectionId, callProxy]);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (!connectionId) return;
    setUploading(true);
    const detected: TBDetectedFile[] = [];
    try {
      for (const file of files) {
        const path = `${connectionId}/${Date.now()}_${file.name}`;
        const { error } = await supabase.storage.from("touchbistro-imports").upload(path, file);
        if (error) throw error;

        const res = await callProxy("detect-report", { connection_id: connectionId, file_path: path });
        detected.push({
          name: file.name,
          reportType: res.report_type || "UNKNOWN",
          headers: res.headers || [],
          rowCount: res.row_count || 0,
          storagePath: path,
        });
      }
      setDetectedFiles((prev) => [...prev, ...detected]);
    } finally {
      setUploading(false);
    }
    return detected;
  }, [connectionId, callProxy]);

  const importSales = useCallback(async (filePaths: string[]) => {
    if (!connectionId) return;
    setSalesImporting(true);
    setSalesImportResult(null);
    try {
      const res = await callProxy("import-sales", { connection_id: connectionId, file_paths: filePaths });
      setSalesImportResult(res);
      return res;
    } finally {
      setSalesImporting(false);
    }
  }, [connectionId, callProxy]);

  const importBillsPayments = useCallback(async (billPaths: string[], paymentPaths: string[]) => {
    if (!connectionId) return;
    setSalesImporting(true);
    try {
      const res = await callProxy("import-bills-payments", {
        connection_id: connectionId, bill_paths: billPaths, payment_paths: paymentPaths,
      });
      setSalesImportResult(res.salesResult);
      setReconciliation(res.reconciliation || []);
      return res;
    } finally {
      setSalesImporting(false);
    }
  }, [connectionId, callProxy]);

  const importCatalog = useCallback(async (filePaths: string[]) => {
    if (!connectionId) return;
    setCatalogImporting(true);
    setCatalogImportResult(null);
    try {
      const res = await callProxy("import-catalog", { connection_id: connectionId, file_paths: filePaths });
      setCatalogImportResult(res);
      return res;
    } finally {
      setCatalogImporting(false);
    }
  }, [connectionId, callProxy]);

  const loadPricingDiagnostics = useCallback(async () => {
    if (!connectionId) return;
    const { data } = await supabase.from("winerim_wines")
      .select("pricing_status, bottle_sale_price, glass_sale_price, magnum_sale_price")
      .eq("connection_id", connectionId);
    if (!data) return;
    const total = data.length;
    const ready = data.filter((w) => w.pricing_status === "READY").length;
    const missing = total - ready;
    const bottleCoverage = total ? Math.round((data.filter((w) => w.bottle_sale_price && w.bottle_sale_price > 0).length / total) * 100) : 0;
    const glassCoverage = total ? Math.round((data.filter((w) => w.glass_sale_price && w.glass_sale_price > 0).length / total) * 100) : 0;
    const magnumCoverage = total ? Math.round((data.filter((w) => w.magnum_sale_price && w.magnum_sale_price > 0).length / total) * 100) : 0;
    setPricingDiagnostics({ total, ready, missing, bottleCoverage, glassCoverage, magnumCoverage });
  }, [connectionId]);

  const discoverApi = useCallback(async () => {
    if (!connectionId) return;
    setApiDiscovering(true);
    try {
      const res = await callProxy("api-discover", { connection_id: connectionId });
      setApiDiscoveryResult(res);
      return res;
    } finally {
      setApiDiscovering(false);
    }
  }, [connectionId, callProxy]);

  const exportDebugBundle = useCallback(async () => {
    if (!connectionId) return;
    try {
      const res = await callProxy("debug-bundle", { connection_id: connectionId });
      setDebugBundle(res.bundle);
      // Trigger download
      const blob = new Blob([JSON.stringify(res.bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `touchbistro-debug-${connectionId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      return res.bundle;
    } catch (e: any) {
      console.error("Debug bundle export failed", e);
      throw e;
    }
  }, [connectionId, callProxy]);

  return {
    connectionId, testStatus, testError,
    detectedFiles, uploading,
    salesImporting, salesImportResult,
    reconciliation,
    catalogImporting, catalogImportResult,
    pricingDiagnostics,
    apiDiscovering, apiDiscoveryResult,
    debugBundle,
    loadExistingConnection, saveConnection, testConnection,
    uploadFiles, importSales, importBillsPayments, importCatalog,
    loadPricingDiagnostics, discoverApi, exportDebugBundle,
  };
}
