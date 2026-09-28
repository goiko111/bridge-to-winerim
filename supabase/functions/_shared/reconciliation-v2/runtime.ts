import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { createWinerimFleetClient } from "./winerimFleetClient.ts";
export { addBusinessDays, bindingCutoffHour, bindingTimezone, businessWindow, zonedInstant } from "./time.ts";

export const MAX_PAGES = 100;
export const SALES_LAG_MS = 60_000;
export const DAILY_OVERLAP_MS = 24 * 60 * 60 * 1000;

export type ActiveBinding = {
  connection_id: string;
  winerim_restaurant_id: number;
  status: "ACTIVE";
  metadata: Record<string, unknown>;
};

export function fleetClient() {
  const token = Deno.env.get("WINERIM_FLEET_READ_TOKEN") ?? "";
  if (!token) throw Object.assign(new Error("Falta WINERIM_FLEET_READ_TOKEN"), { status: 503, code: "MISSING_FLEET_TOKEN" });
  return createWinerimFleetClient({ token });
}

export async function activeBinding(db: SupabaseClient, connectionId: string): Promise<ActiveBinding> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(connectionId)) {
    throw Object.assign(new Error("connectionId inválido"), { status: 400, code: "INVALID_CONNECTION_ID" });
  }
  const { data, error } = await db.from("winerim_restaurant_bindings")
    .select("connection_id,winerim_restaurant_id,status,metadata")
    .eq("connection_id", connectionId).eq("status", "ACTIVE").maybeSingle();
  if (error) throw Object.assign(new Error("No se pudo leer el binding"), { status: 500, code: "BINDING_READ_FAILED" });
  if (!data) throw Object.assign(new Error("Conexión no vinculada o excluida"), { status: 409, code: "BINDING_NOT_ACTIVE" });
  return data as ActiveBinding;
}

export async function checkpoint(db: SupabaseClient, connectionId: string, stream: string) {
  const { data, error } = await db.from("winerim_sync_checkpoints").select("*")
    .eq("connection_id", connectionId).eq("stream", stream).maybeSingle();
  if (error) throw Object.assign(new Error("No se pudo leer el checkpoint"), { status: 500, code: "CHECKPOINT_READ_FAILED" });
  return data;
}

export async function claim(db: SupabaseClient, connectionId: string, stream: string, ownerId: string): Promise<void> {
  const { data, error } = await db.rpc("reconciliation_v2_claim_lock", {
    p_connection_id: connectionId, p_stream: stream, p_owner_id: ownerId, p_ttl_seconds: 600,
  });
  if (error) throw Object.assign(new Error("No se pudo adquirir el bloqueo"), { status: 500, code: "LOCK_FAILED" });
  if (data !== true) throw Object.assign(new Error("Otro proceso mantiene el bloqueo"), { status: 409, code: "LOCK_BUSY" });
}

export async function release(db: SupabaseClient, connectionId: string, stream: string, ownerId: string): Promise<void> {
  const { error } = await db.rpc("reconciliation_v2_release_lock", {
    p_connection_id: connectionId, p_stream: stream, p_owner_id: ownerId,
  });
  if (error) throw Object.assign(new Error("No se pudo liberar el bloqueo"), { status: 500, code: "LOCK_RELEASE_FAILED" });
}

export function changedSinceFrom(value: string | null | undefined, now = Date.now()): string {
  const base = value ? Date.parse(value) : now - DAILY_OVERLAP_MS;
  return new Date(Math.min(base - DAILY_OVERLAP_MS, now - SALES_LAG_MS)).toISOString();
}
