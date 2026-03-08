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

export function useIcgConnection() {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [connectionMode, setConnectionMode] = useState<IcgConnectionMode>("SQL_SERVER");
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<IcgTestResult | null>(null);

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
      .single();
    if (data) {
      setConnectionId(data.id);
      const cfg = data.provider_config as any;
      if (cfg?.connection_mode) setConnectionMode(cfg.connection_mode);
      return data;
    }
    return null;
  };

  return {
    connectionId, connectionMode, setConnectionMode,
    testStatus, testError, testResult,
    saveConnection, updateConnection, testConnection,
    loadExistingConnection, setConnectionId,
  };
}
