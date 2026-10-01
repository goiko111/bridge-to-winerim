import { assertPost, json, parseJson, preflight, requirePlatformAdmin, safeError } from "../_shared/reconciliation-v2/edge.ts";
import { agoraReadAfterClose } from "../_shared/reconciliation-v2/agoraFreshness.ts";
import { activeBinding } from "../_shared/reconciliation-v2/runtime.ts";
import { assertCancelExecutionAllowed, buildCancelPayload, parseCancelResponse, type CancelEntry } from "../_shared/winerimSalesCancel.ts";

// Manual cancellations in Winerim: PREPARE (admin A) -> APPROVE (admin B, distinct) -> EXECUTE -> READBACK.
// Never touches /stock. Every request is persisted with both approvers and the readback.
const BASE = "https://app.winerim.com/api/v2";
const SOURCE_SYSTEM = "agora";
const err = (m: string, status: number, code: string) => Object.assign(new Error(m), { status, code });
const UUID = /^[0-9a-f-]{36}$/i;

type Body = { action?: string; connectionId?: string; requestId?: string; cancels?: CancelEntry[]; reason?: string; businessDay?: string };

async function token(db: Awaited<ReturnType<typeof requirePlatformAdmin>>["db"], connectionId: string) {
  const { data } = await db.from("pos_connections").select("winerim_api_token").eq("id", connectionId).maybeSingle();
  const t = String(data?.winerim_api_token ?? "").trim();
  if (!t) throw err("La conexión no tiene clave de Winerim", 409, "WINERIM_TOKEN_MISSING");
  return t;
}

async function readback(tok: string, correlationId: string) {
  const r = await fetch(`${BASE}/sales/status?correlationId=${encodeURIComponent(correlationId)}`, { headers: { Accept: "application/json", "WINERIM-API-TOKEN": tok } });
  const body = await r.json().catch(() => null);
  return { http: r.status, state: (body as { state?: string } | null)?.state ?? null, body };
}

Deno.serve(async (request) => {
  const options = preflight(request); if (options) return options;
  try {
    assertPost(request);
    const { db, userId } = await requirePlatformAdmin(request);
    const body = await parseJson<Body>(request);
    const action = String(body?.action ?? "");

    if (action === "PREPARE") {
      if (!body.connectionId || !UUID.test(body.connectionId)) throw err("connectionId inválido", 400, "INVALID_CONNECTION");
      // Gate: the day must be closed AND Ágora read successfully after the close; otherwise vanished tickets may just be unread invoices.
      if (!body.businessDay || !/^\d{4}-\d{2}-\d{2}$/.test(body.businessDay)) throw err("businessDay obligatorio", 400, "BUSINESS_DAY_REQUIRED");
      const binding = await activeBinding(db as never, body.connectionId);
      const { data: conn } = await db.from("pos_connections").select("last_sync_at").eq("id", body.connectionId).maybeSingle();
      const fresh = agoraReadAfterClose(binding, body.businessDay, conn?.last_sync_at ?? null);
      if (!fresh.ok) throw Object.assign(err("Ágora no se ha leído bien después del cierre del día", 409, "AGORA_NOT_READ_AFTER_CLOSE"), { details: fresh });
      const correlationId = `cancel-${crypto.randomUUID()}`;
      const payload = buildCancelPayload(SOURCE_SYSTEM, correlationId, (body.cancels ?? []).map((c) => ({ ...c, reason: c.reason ?? body.reason })));
      const { data, error } = await db.from("winerim_cancel_requests").insert({ connection_id: body.connectionId, correlation_id: correlationId, payload, requested_by: userId }).select("id,status,correlation_id").single();
      if (error) throw err("No se pudo registrar la petición", 500, "CANCEL_PREPARE_FAILED");
      return json(request, { ok: true, request: data, payload });
    }

    if (!body.requestId || !UUID.test(body.requestId)) throw err("requestId inválido", 400, "INVALID_REQUEST_ID");
    const { data: row } = await db.from("winerim_cancel_requests").select("*").eq("id", body.requestId).maybeSingle();
    if (!row) throw err("Petición no encontrada", 404, "CANCEL_NOT_FOUND");

    if (action === "APPROVE" || action === "REJECT") {
      if (row.status !== "PENDING_APPROVAL") throw err("La petición no está pendiente", 409, "CANCEL_NOT_PENDING");
      if (row.requested_by === userId) throw err("La aprobación debe hacerla otra persona", 403, "CANCEL_SELF_APPROVAL");
      const patch = action === "APPROVE" ? { status: "APPROVED", approved_by: userId, approved_at: new Date().toISOString() } : { status: "REJECTED", approved_by: userId, approved_at: new Date().toISOString() };
      const { error } = await db.from("winerim_cancel_requests").update(patch).eq("id", row.id).eq("status", "PENDING_APPROVAL");
      if (error) throw err("No se pudo guardar la aprobación", 500, "CANCEL_APPROVE_FAILED");
      return json(request, { ok: true, status: patch.status });
    }

    if (action === "EXECUTE") {
      if (row.status !== "APPROVED") throw err("La petición no está aprobada", 409, "CANCEL_NOT_APPROVED");
      assertCancelExecutionAllowed({ approvedBy: row.requested_by, secondCheckBy: row.approved_by });
      const { data: claimed } = await db.from("winerim_cancel_requests").update({ status: "EXECUTING", executed_at: new Date().toISOString() }).eq("id", row.id).eq("status", "APPROVED").select("id");
      if (!claimed?.length) throw err("Otra ejecución está en curso", 409, "CANCEL_ALREADY_EXECUTING");
      const tok = await token(db, row.connection_id);
      const res = await fetch(`${BASE}/sales/cancel`, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "WINERIM-API-TOKEN": tok, "X-Correlation-Id": row.correlation_id }, body: JSON.stringify(row.payload) });
      const resBody = await res.json().catch(() => null);
      let status = "DONE"; let parsed: unknown = null; let errorCode: string | null = null;
      try {
        const p = parseCancelResponse(res.status, resBody, row.payload); parsed = p;
        status = p.requiresReadback ? "NEEDS_READBACK" : p.perEntry.some((e) => e.next !== "DONE") ? "MANUAL" : "DONE";
      } catch (e) { status = "NEEDS_READBACK"; errorCode = String((e as { code?: string }).code ?? "CANCEL_RESPONSE_INVALID"); }
      const rb = await readback(tok, row.correlation_id);
      await db.from("winerim_cancel_requests").update({ status, response: { http: res.status, body: resBody, parsed }, readback: rb, error_code: errorCode }).eq("id", row.id);
      return json(request, { ok: status === "DONE", status, http: res.status, parsed, readback: { http: rb.http, state: rb.state } });
    }

    if (action === "READBACK") {
      const rb = await readback(await token(db, row.connection_id), row.correlation_id);
      await db.from("winerim_cancel_requests").update({ readback: rb, ...(rb.state === "CONFIRMED" && row.status === "NEEDS_READBACK" ? { status: "DONE" } : {}) }).eq("id", row.id);
      return json(request, { ok: true, readback: rb });
    }

    throw err("Acción no permitida", 400, "INVALID_ACTION");
  } catch (error) {
    return safeError(request, error);
  }
});
