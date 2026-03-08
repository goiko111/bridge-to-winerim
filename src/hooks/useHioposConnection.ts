import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export type HioposIngestionMode = "MANUAL_UPLOAD" | "SFTP_DROP";

export interface HioposSalesImportResult {
  success: boolean;
  totalEvents: number;
  totalLines: number;
  duplicatesSkipped: number;
  message: string;
}

export interface HioposCatalogImportResult {
  success: boolean;
  totalProducts: number;
  inserted: number;
  updated: number;
  message: string;
}

export interface HioposExportResult {
  success: boolean;
  totalWines: number;
  downloadUrl: string;
  format: "csv" | "xml";
  message: string;
}

export interface PendingWrite {
  id: string;
  task_type: string;
  status: string;
  payload_json: any;
  created_at: string;
}

export function useHioposConnection() {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);

  // Sales import
  const [salesImporting, setSalesImporting] = useState(false);
  const [salesImportResult, setSalesImportResult] = useState<HioposSalesImportResult | null>(null);
  const [lastImportedFile, setLastImportedFile] = useState<string | null>(null);

  // Catalog import
  const [catalogImporting, setCatalogImporting] = useState(false);
  const [catalogImportResult, setCatalogImportResult] = useState<HioposCatalogImportResult | null>(null);

  // Export / write
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<HioposExportResult | null>(null);

  // HiOffice
  const [hiofficeMode, setHiofficeMode] = useState(false);
  const [bundleStatus, setBundleStatus] = useState<"idle" | "generating" | "ready" | "sent">("idle");

  const saveConnection = async (data: {
    locationName: string;
    ingestionMode: HioposIngestionMode;
    storeId?: string;
    timezone: string;
    sftpHost?: string;
    sftpPort?: string;
    sftpUser?: string;
    sftpPassword?: string;
    sftpPath?: string;
    useHioffice?: boolean;
  }) => {
    const providerConfig: Record<string, unknown> = {
      integration_mode: "EXPORT_FILES",
      ingestion_mode: data.ingestionMode,
      store_id: data.storeId || null,
      timezone: data.timezone,
      use_hioffice: data.useHioffice || false,
    };
    if (data.ingestionMode === "SFTP_DROP") {
      providerConfig.sftp = {
        host: data.sftpHost,
        port: data.sftpPort || "22",
        user: data.sftpUser,
        password: data.sftpPassword,
        path: data.sftpPath || "/",
      };
    }

    const { data: row, error } = await supabase
      .from("pos_connections")
      .insert({
        location_name: data.locationName,
        base_url: "file://local",
        api_token: "none",
        provider: "hiopos",
        sync_mode: "PULL_ONLY",
        sync_frequency_minutes: 0,
        backfill_days: 30,
        provider_config: providerConfig,
      } as any)
      .select()
      .single();

    if (error) throw error;
    setConnectionId(row.id);

    // Create capabilities
    await supabase.from("provider_capabilities").insert({
      connection_id: row.id,
      provider: "HIOPOS",
      can_read_sales: true,
      can_read_catalog: true,
      can_write_products: "NO",
    } as any);

    return row.id;
  };

  const updateConnection = async (id: string, data: Record<string, unknown>) => {
    const { error } = await supabase.from("pos_connections").update(data).eq("id", id);
    if (error) throw error;
  };

  const loadExistingConnection = useCallback(async () => {
    const { data, error } = await supabase
      .from("pos_connections")
      .select("*")
      .eq("provider", "hiopos")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    setConnectionId(data.id);
    const cfg = data.provider_config as any;
    if (cfg?.use_hioffice) setHiofficeMode(true);
    return data;
  }, []);

  const testConnection = async () => {
    setTestStatus("testing");
    setTestError(null);
    // For file-based provider, "test" just validates config exists
    if (!connectionId) {
      setTestStatus("error");
      setTestError("No connection saved yet");
      return false;
    }
    try {
      const { data, error } = await supabase.functions.invoke("hiopos-proxy", {
        body: { action: "test", connectionId },
      });
      if (error) throw error;
      if (data?.success) { setTestStatus("success"); return true; }
      setTestStatus("error");
      setTestError(data?.message || "Validation failed");
      return false;
    } catch (e: any) {
      setTestStatus("error");
      setTestError(e.message);
      return false;
    }
  };

  // ── Sales import ──
  const uploadSalesFile = useCallback(async (file: File, dateFrom?: string, dateTo?: string, store?: string, register?: string) => {
    if (!connectionId) return;
    setSalesImporting(true);
    setSalesImportResult(null);
    try {
      const filePath = `${connectionId}/sales/${Date.now()}_${file.name}`;
      const { error: uploadErr } = await supabase.storage.from("hiopos-imports").upload(filePath, file);
      if (uploadErr) throw uploadErr;

      const { data, error } = await supabase.functions.invoke("hiopos-proxy", {
        body: {
          action: "import-sales",
          connectionId,
          filePath,
          fileName: file.name,
          dateFrom,
          dateTo,
          store,
          register,
        },
      });
      if (error) throw error;
      setSalesImportResult(data);
      setLastImportedFile(file.name);
    } catch (e: any) {
      setSalesImportResult({ success: false, totalEvents: 0, totalLines: 0, duplicatesSkipped: 0, message: e.message });
    } finally {
      setSalesImporting(false);
    }
  }, [connectionId]);

  // ── Catalog import ──
  const uploadCatalogFile = useCallback(async (file: File) => {
    if (!connectionId) return;
    setCatalogImporting(true);
    setCatalogImportResult(null);
    try {
      const filePath = `${connectionId}/catalog/${Date.now()}_${file.name}`;
      const { error: uploadErr } = await supabase.storage.from("hiopos-imports").upload(filePath, file);
      if (uploadErr) throw uploadErr;

      const { data, error } = await supabase.functions.invoke("hiopos-proxy", {
        body: { action: "import-catalog", connectionId, filePath, fileName: file.name },
      });
      if (error) throw error;
      setCatalogImportResult(data);
    } catch (e: any) {
      setCatalogImportResult({ success: false, totalProducts: 0, inserted: 0, updated: 0, message: e.message });
    } finally {
      setCatalogImporting(false);
    }
  }, [connectionId]);

  // ── Export / write file generator ──
  const generateImportFile = useCallback(async (format: "csv" | "xml" = "csv", useHioffice = false) => {
    if (!connectionId) return;
    setExporting(true);
    setExportResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("hiopos-proxy", {
        body: { action: "generate-import-file", connectionId, format, useHioffice },
      });
      if (error) throw error;
      setExportResult(data);
      if (useHioffice) setBundleStatus("ready");
    } catch (e: any) {
      setExportResult({ success: false, totalWines: 0, downloadUrl: "", format, message: e.message });
    } finally {
      setExporting(false);
    }
  }, [connectionId]);

  const markBundleSent = useCallback(() => setBundleStatus("sent"), []);

  const enableSync = async () => {
    if (!connectionId) return;
    await updateConnection(connectionId, { enabled: true });
  };

  return {
    connectionId, setConnectionId,
    testStatus, testError, testConnection,
    saveConnection, updateConnection, loadExistingConnection,
    // Sales
    salesImporting, salesImportResult, lastImportedFile, uploadSalesFile,
    // Catalog
    catalogImporting, catalogImportResult, uploadCatalogFile,
    // Export
    exporting, exportResult, generateImportFile,
    // HiOffice
    hiofficeMode, setHiofficeMode, bundleStatus, setBundleStatus, markBundleSent,
    enableSync,
  };
}
