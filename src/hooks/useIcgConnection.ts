import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getIcgConfig } from "@/utils/providerConfig";

export type IcgConnectionMode = "SQL_SERVER" | "WEB_SERVICE";

export interface IcgTestResult {
  success: boolean;
  status: number;
  message: string;
  tables?: string[];
  version?: string;
}

export interface IcgSqlMapping {
  sales_header: { table: string; fields: Record<string, string>; filter?: string; order?: string };
  sales_line: { table: string; fields: Record<string, string>; join_key: string };
  incremental: { cursor_field: string; date_field: string };
  catalog_product: { table: string; fields: Record<string, string>; filter?: string; order?: string };
  catalog_family: { table: string; fields: Record<string, string>; order?: string };
  write_price: { table: string; fields: Record<string, string>; template: string };
}

export interface IcgSalesPreview {
  success: boolean;
  salesEvents: any[];
  generatedSQL: string;
  message: string;
}

export interface IcgIncrementalResult {
  success: boolean;
  generatedSQL: string;
  cursor: { last_ticket_id: string | null; last_close_date: string | null };
  message: string;
}

export interface IcgBackfillResult {
  success: boolean;
  daysBack: number;
  queriesGenerated: number;
  sampleQuery: string;
  message: string;
}

export interface IcgCatalogResult {
  success: boolean;
  totalProducts: number;
  upserted: number;
  totalFamilies: number;
  families: { id: string; name: string }[];
  generatedSQL?: { products: string; families: string };
  errors: string[];
  message?: string;
}

export interface IcgWritePriceResult {
  success: boolean;
  dryRun?: boolean;
  pendingApproval?: boolean;
  blocked?: boolean;
  reason?: string;
  taskId?: string;
  generatedSQL: string;
  verifySQL?: string;
  message: string;
}

export interface IcgPendingWrite {
  id: string;
  productId: string;
  price: number;
  sql: string;
  createdAt: string;
}

export function useIcgConnection() {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [connectionMode, setConnectionMode] = useState<IcgConnectionMode>("SQL_SERVER");
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<IcgTestResult | null>(null);

  // SQL mapping
  const [sqlMapping, setSqlMapping] = useState<IcgSqlMapping | null>(null);
  const [loadingMapping, setLoadingMapping] = useState(false);

  // Sales
  const [salesPreview, setSalesPreview] = useState<IcgSalesPreview | null>(null);
  const [loadingSales, setLoadingSales] = useState(false);
  const [incrementalResult, setIncrementalResult] = useState<IcgIncrementalResult | null>(null);
  const [incrementalSyncing, setIncrementalSyncing] = useState(false);
  const [backfillResult, setBackfillResult] = useState<IcgBackfillResult | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [queryPreview, setQueryPreview] = useState<{ header: string; lines: string } | null>(null);
  const [loadingQueryPreview, setLoadingQueryPreview] = useState(false);

  // Catalog
  const [catalogResult, setCatalogResult] = useState<IcgCatalogResult | null>(null);
  const [syncingCatalog, setSyncingCatalog] = useState(false);
  const [catalogQueryPreview, setCatalogQueryPreview] = useState<{ products: string; families: string } | null>(null);
  const [loadingCatalogPreview, setLoadingCatalogPreview] = useState(false);

  // Write
  const [writeResult, setWriteResult] = useState<IcgWritePriceResult | null>(null);
  const [writingPrice, setWritingPrice] = useState(false);
  const [pendingWrites, setPendingWrites] = useState<IcgPendingWrite[]>([]);
  const [loadingPending, setLoadingPending] = useState(false);

  // Write settings
  const [writeEnabled, setWriteEnabled] = useState(false);
  const [requireApproval, setRequireApproval] = useState(true);

  const invoke = async (action: string, extra: Record<string, any> = {}) => {
    const { data, error } = await supabase.functions.invoke("icg-proxy", {
      body: { action, connectionId, ...extra },
    });
    if (error) throw error;
    return data;
  };

  const saveConnection = async (data: {
    locationName: string; mode: IcgConnectionMode;
    host: string; port: string; database: string; username: string; password: string;
  }) => {
    const providerConfig = {
      connection_mode: data.mode, host: data.host, port: data.port,
      database: data.database, db_username: data.username, db_password: data.password,
    };
    const { data: row, error } = await supabase
      .from("pos_connections")
      .insert({
        location_name: data.locationName, base_url: `${data.host}:${data.port}`,
        api_token: "icg-managed", provider: "icg", sync_mode: "PULL_ONLY",
        provider_config: providerConfig,
      } as any)
      .select().single();
    if (error) throw error;
    setConnectionId(row.id);
    return row.id;
  };

  const updateConnection = async (id: string, data: Record<string, unknown>) => {
    const { error } = await supabase.from("pos_connections").update(data as any).eq("id", id);
    if (error) throw error;
  };

  const testConnection = async (fields: {
    locationName: string; mode: IcgConnectionMode;
    host: string; port: string; database: string; username: string; password: string;
  }) => {
    setTestStatus("testing"); setTestError(null); setTestResult(null);
    let connId = connectionId;
    if (!connId) {
      try { connId = await saveConnection(fields); }
      catch (e: any) { setTestStatus("error"); setTestError(e.message); return false; }
    } else {
      await updateConnection(connId, {
        location_name: fields.locationName, base_url: `${fields.host}:${fields.port}`,
        provider_config: {
          connection_mode: fields.mode, host: fields.host, port: fields.port,
          database: fields.database, db_username: fields.username, db_password: fields.password,
        },
      });
    }
    try {
      const { data, error } = await supabase.functions.invoke("icg-proxy", {
        body: { action: "test", connectionId: connId },
      });
      if (error) { setTestStatus("error"); setTestError(error.message); return false; }
      setTestResult(data as IcgTestResult);
      if (data?.success) { setTestStatus("success"); return true; }
      setTestStatus("error"); setTestError(data?.message || "Connection failed"); return false;
    } catch (e: any) { setTestStatus("error"); setTestError(e.message); return false; }
  };

  const loadExistingConnection = async () => {
    const { data } = await supabase
      .from("pos_connections").select("*").eq("provider", "icg")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (data) {
      setConnectionId(data.id);
      const cfg = getIcgConfig(data.provider_config);
      if (cfg.connection_mode) setConnectionMode(cfg.connection_mode as IcgConnectionMode);
      setWriteEnabled(cfg.write_enabled === true);
      setRequireApproval(cfg.require_manual_approval !== false);
      return data;
    }
    return null;
  };

  // ── SQL Mapping ──
  const fetchSqlMapping = useCallback(async () => {
    if (!connectionId) return;
    setLoadingMapping(true);
    try { const d = await invoke("get-sql-mapping"); if (d?.mapping) setSqlMapping(d.mapping); }
    catch (e) { console.error("Failed to fetch SQL mapping:", e); }
    finally { setLoadingMapping(false); }
  }, [connectionId]);

  const updateSqlMapping = useCallback(async (newMapping: Partial<IcgSqlMapping>) => {
    if (!connectionId) return false;
    try { const d = await invoke("update-sql-mapping", { sqlMapping: newMapping }); if (d?.mapping) setSqlMapping(d.mapping); return true; }
    catch (e) { console.error("Failed to update SQL mapping:", e); return false; }
  }, [connectionId]);

  // ── Sales ──
  const fetchSales = useCallback(async (businessDay: string) => {
    if (!connectionId) return;
    setLoadingSales(true); setSalesPreview(null);
    try { const d = await invoke("fetch-sales", { businessDay }); setSalesPreview(d as IcgSalesPreview); }
    catch (e) { console.error("Failed to fetch ICG sales:", e); }
    finally { setLoadingSales(false); }
  }, [connectionId]);

  const previewQueries = useCallback(async (businessDay: string) => {
    if (!connectionId) return;
    setLoadingQueryPreview(true); setQueryPreview(null);
    try { const d = await invoke("preview-sales-query", { businessDay }); if (d?.queries) setQueryPreview(d.queries); }
    catch (e) { console.error("Failed to preview queries:", e); }
    finally { setLoadingQueryPreview(false); }
  }, [connectionId]);

  const runIncrementalSync = useCallback(async () => {
    if (!connectionId) return;
    setIncrementalSyncing(true); setIncrementalResult(null);
    try { const d = await invoke("incremental-sync"); setIncrementalResult(d as IcgIncrementalResult); }
    catch (e) { console.error("Failed ICG incremental sync:", e); }
    finally { setIncrementalSyncing(false); }
  }, [connectionId]);

  const runBackfill = useCallback(async (daysBack = 30) => {
    if (!connectionId) return;
    setBackfilling(true); setBackfillResult(null);
    try { const d = await invoke("backfill", { daysBack }); setBackfillResult(d as IcgBackfillResult); }
    catch (e) { console.error("Failed ICG backfill:", e); }
    finally { setBackfilling(false); }
  }, [connectionId]);

  // ── Catalog ──
  const previewCatalogQueries = useCallback(async () => {
    if (!connectionId) return;
    setLoadingCatalogPreview(true); setCatalogQueryPreview(null);
    try { const d = await invoke("preview-catalog-query"); if (d?.queries) setCatalogQueryPreview(d.queries); }
    catch (e) { console.error("Failed catalog preview:", e); }
    finally { setLoadingCatalogPreview(false); }
  }, [connectionId]);

  const syncCatalog = useCallback(async () => {
    if (!connectionId) return;
    setSyncingCatalog(true); setCatalogResult(null);
    try { const d = await invoke("sync-catalog"); setCatalogResult(d as IcgCatalogResult); }
    catch (e) { console.error("Failed ICG catalog sync:", e); }
    finally { setSyncingCatalog(false); }
  }, [connectionId]);

  // ── Write ──
  const updateWriteSettings = useCallback(async (we: boolean, ra: boolean) => {
    if (!connectionId) return;
    try {
      await invoke("update-write-settings", { writeEnabled: we, requireApproval: ra });
      setWriteEnabled(we);
      setRequireApproval(ra);
    } catch (e) { console.error("Failed to update write settings:", e); }
  }, [connectionId]);

  const writePrice = useCallback(async (productId: string, price: number, dryRun: boolean) => {
    if (!connectionId) return;
    setWritingPrice(true); setWriteResult(null);
    try { const d = await invoke("write-price", { productId, price, dryRun }); setWriteResult(d as IcgWritePriceResult); }
    catch (e) { console.error("Failed ICG write-price:", e); }
    finally { setWritingPrice(false); }
  }, [connectionId]);

  const loadPendingWrites = useCallback(async () => {
    if (!connectionId) return;
    setLoadingPending(true);
    try { const d = await invoke("list-pending-writes"); setPendingWrites(d?.tasks || []); }
    catch (e) { console.error("Failed to load pending writes:", e); }
    finally { setLoadingPending(false); }
  }, [connectionId]);

  const approveWrite = useCallback(async (taskId: string) => {
    if (!connectionId) return;
    try { await invoke("approve-write", { taskId }); await loadPendingWrites(); }
    catch (e) { console.error("Failed to approve write:", e); }
  }, [connectionId, loadPendingWrites]);

  const rejectWrite = useCallback(async (taskId: string, reason?: string) => {
    if (!connectionId) return;
    try { await invoke("reject-write", { taskId, reason }); await loadPendingWrites(); }
    catch (e) { console.error("Failed to reject write:", e); }
  }, [connectionId, loadPendingWrites]);

  const enableSync = useCallback(async () => {
    if (!connectionId) return;
    const { error } = await supabase.from("pos_connections").update({ enabled: true } as any).eq("id", connectionId);
    if (error) throw error;
  }, [connectionId]);

  return {
    connectionId, connectionMode, setConnectionMode,
    testStatus, testError, testResult,
    saveConnection, updateConnection, testConnection,
    loadExistingConnection, setConnectionId,
    // SQL Mapping
    sqlMapping, loadingMapping, fetchSqlMapping, updateSqlMapping,
    // Sales
    salesPreview, loadingSales, fetchSales,
    queryPreview, loadingQueryPreview, previewQueries,
    incrementalResult, incrementalSyncing, runIncrementalSync,
    backfillResult, backfilling, runBackfill,
    // Catalog
    catalogResult, syncingCatalog, syncCatalog,
    catalogQueryPreview, loadingCatalogPreview, previewCatalogQueries,
    // Write
    writeEnabled, requireApproval, updateWriteSettings,
    writeResult, writingPrice, writePrice,
    pendingWrites, loadingPending, loadPendingWrites,
    approveWrite, rejectWrite, enableSync,
  };
}
