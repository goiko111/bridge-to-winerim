import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export type IcgConnectionMode = "SQL_SERVER" | "WEB_SERVICE";

export interface IcgTestResult {
  success: boolean;
  status: number;
  message: string;
  tables?: string[];
  version?: string;
}

export interface IcgSqlMapping {
  sales_header: {
    table: string;
    fields: Record<string, string>;
    filter?: string;
    order?: string;
  };
  sales_line: {
    table: string;
    fields: Record<string, string>;
    join_key: string;
  };
  incremental: {
    cursor_field: string;
    date_field: string;
  };
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

export function useIcgConnection() {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [connectionMode, setConnectionMode] = useState<IcgConnectionMode>("SQL_SERVER");
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<IcgTestResult | null>(null);

  // SQL mapping state
  const [sqlMapping, setSqlMapping] = useState<IcgSqlMapping | null>(null);
  const [loadingMapping, setLoadingMapping] = useState(false);

  // Sales state
  const [salesPreview, setSalesPreview] = useState<IcgSalesPreview | null>(null);
  const [loadingSales, setLoadingSales] = useState(false);
  const [incrementalResult, setIncrementalResult] = useState<IcgIncrementalResult | null>(null);
  const [incrementalSyncing, setIncrementalSyncing] = useState(false);
  const [backfillResult, setBackfillResult] = useState<IcgBackfillResult | null>(null);
  const [backfilling, setBackfilling] = useState(false);

  // Query preview
  const [queryPreview, setQueryPreview] = useState<{ header: string; lines: string } | null>(null);
  const [loadingQueryPreview, setLoadingQueryPreview] = useState(false);

  const saveConnection = async (data: {
    locationName: string;
    mode: IcgConnectionMode;
    host: string;
    port: string;
    database: string;
    username: string;
    password: string;
  }) => {
    const providerConfig = {
      connection_mode: data.mode,
      host: data.host,
      port: data.port,
      database: data.database,
      db_username: data.username,
      db_password: data.password,
    };

    const { data: row, error } = await supabase
      .from("pos_connections")
      .insert({
        location_name: data.locationName,
        base_url: `${data.host}:${data.port}`,
        api_token: "icg-managed",
        provider: "icg",
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
    mode: IcgConnectionMode;
    host: string;
    port: string;
    database: string;
    username: string;
    password: string;
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
      await updateConnection(connId, {
        location_name: fields.locationName,
        base_url: `${fields.host}:${fields.port}`,
        provider_config: {
          connection_mode: fields.mode,
          host: fields.host,
          port: fields.port,
          database: fields.database,
          db_username: fields.username,
          db_password: fields.password,
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
      .from("pos_connections")
      .select("*")
      .eq("provider", "icg")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      setConnectionId(data.id);
      const cfg = data.provider_config as any;
      if (cfg?.connection_mode) setConnectionMode(cfg.connection_mode);
      return data;
    }
    return null;
  };

  // ── SQL Mapping ──
  const fetchSqlMapping = useCallback(async () => {
    if (!connectionId) return;
    setLoadingMapping(true);
    try {
      const { data, error } = await supabase.functions.invoke("icg-proxy", {
        body: { action: "get-sql-mapping", connectionId },
      });
      if (error) throw error;
      if (data?.mapping) setSqlMapping(data.mapping);
    } catch (e) { console.error("Failed to fetch SQL mapping:", e); }
    finally { setLoadingMapping(false); }
  }, [connectionId]);

  const updateSqlMapping = useCallback(async (newMapping: Partial<IcgSqlMapping>) => {
    if (!connectionId) return;
    try {
      const { data, error } = await supabase.functions.invoke("icg-proxy", {
        body: { action: "update-sql-mapping", connectionId, sqlMapping: newMapping },
      });
      if (error) throw error;
      if (data?.mapping) setSqlMapping(data.mapping);
      return true;
    } catch (e) { console.error("Failed to update SQL mapping:", e); return false; }
  }, [connectionId]);

  // ── Sales Preview ──
  const fetchSales = useCallback(async (businessDay: string) => {
    if (!connectionId) return;
    setLoadingSales(true);
    setSalesPreview(null);
    try {
      const { data, error } = await supabase.functions.invoke("icg-proxy", {
        body: { action: "fetch-sales", connectionId, businessDay },
      });
      if (error) throw error;
      setSalesPreview(data as IcgSalesPreview);
    } catch (e) { console.error("Failed to fetch ICG sales:", e); }
    finally { setLoadingSales(false); }
  }, [connectionId]);

  // ── Query Preview ──
  const previewQueries = useCallback(async (businessDay: string) => {
    if (!connectionId) return;
    setLoadingQueryPreview(true);
    setQueryPreview(null);
    try {
      const { data, error } = await supabase.functions.invoke("icg-proxy", {
        body: { action: "preview-sales-query", connectionId, businessDay },
      });
      if (error) throw error;
      if (data?.queries) setQueryPreview(data.queries);
    } catch (e) { console.error("Failed to preview queries:", e); }
    finally { setLoadingQueryPreview(false); }
  }, [connectionId]);

  // ── Incremental Sync ──
  const runIncrementalSync = useCallback(async () => {
    if (!connectionId) return;
    setIncrementalSyncing(true);
    setIncrementalResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("icg-proxy", {
        body: { action: "incremental-sync", connectionId },
      });
      if (error) throw error;
      setIncrementalResult(data as IcgIncrementalResult);
    } catch (e) { console.error("Failed ICG incremental sync:", e); }
    finally { setIncrementalSyncing(false); }
  }, [connectionId]);

  // ── Backfill ──
  const runBackfill = useCallback(async (daysBack = 30) => {
    if (!connectionId) return;
    setBackfilling(true);
    setBackfillResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("icg-proxy", {
        body: { action: "backfill", connectionId, daysBack },
      });
      if (error) throw error;
      setBackfillResult(data as IcgBackfillResult);
    } catch (e) { console.error("Failed ICG backfill:", e); }
    finally { setBackfilling(false); }
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
  };
}
