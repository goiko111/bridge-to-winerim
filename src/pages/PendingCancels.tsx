import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

type Item = { id: string; status: string; location: string; wine: string | null; format: string; units: number | null; saleId: number | null; reason: string | null; businessDay: string | null; requestedBy: string; createdAt: string; approvedBy: string | null; readbackState: string | null; errorCode: string | null; canApprove: boolean };

const call = async (body: Record<string, unknown>) => {
  const { data, error } = await supabase.functions.invoke("winerim-sales-cancel", { body });
  if (error) { const ctx = (error as { context?: Response }).context; const j = ctx ? await ctx.json().catch(() => null) : null; throw new Error(j?.message ?? error.message); }
  return data;
};

export default function PendingCancels() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setItems((await call({ action: "LIST" })).items); setErr(null); } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (id: string, action: "APPROVE" | "REJECT") => {
    if (action === "APPROVE" && !confirm("Se anulará la venta en Winerim ahora. ¿Aprobar?")) return;
    setBusy(id);
    try { const r = await call({ action, requestId: id }); toast.success(action === "REJECT" ? "Rechazada" : `Ejecutada: ${r.status} · comprobación ${r.readback?.state ?? "—"}`); }
    catch (e) { toast.error((e as Error).message); }
    setBusy(null); load();
  };

  if (err) return <Card className="p-6 text-sm text-destructive">{err}</Card>;
  if (!items) return <p className="text-sm text-muted-foreground">Cargando…</p>;
  const pending = items.filter((i) => i.status === "PENDING_APPROVAL");
  const done = items.filter((i) => i.status !== "PENDING_APPROVAL");
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Anulaciones pendientes ({pending.length})</h1>
      {pending.length === 0 && <p className="text-sm text-muted-foreground">No hay anulaciones pendientes.</p>}
      {pending.map((i) => (
        <Card key={i.id} className="p-4 space-y-2">
          <div className="flex flex-wrap items-center gap-2"><strong>{i.location}</strong><span>· {i.wine ?? "—"}</span><Badge variant="secondary">{i.format}</Badge><span>{i.units ?? "?"} ud.</span><span className="text-muted-foreground">· día {i.businessDay ?? "—"} · venta Winerim {i.saleId ?? "—"}</span></div>
          <p className="text-sm">{i.reason}</p>
          <p className="text-xs text-muted-foreground">Preparada por {i.requestedBy} el {new Date(i.createdAt).toLocaleString("es-ES")}</p>
          <div className="flex gap-2">
            <Button size="sm" disabled={!i.canApprove || busy === i.id} onClick={() => act(i.id, "APPROVE")}>Aprobar</Button>
            <Button size="sm" variant="outline" disabled={!i.canApprove || busy === i.id} onClick={() => act(i.id, "REJECT")}>Rechazar</Button>
            {!i.canApprove && <span className="text-xs text-muted-foreground self-center">La preparaste tú: debe aprobarla otra persona.</span>}
          </div>
        </Card>
      ))}
      {done.length > 0 && <div className="space-y-2"><h2 className="text-lg font-medium">Historial</h2>{done.map((i) => (
        <p key={i.id} className="text-sm text-muted-foreground">{i.location} · {i.wine} · {i.units} ud. — <strong>{i.status}</strong>{i.approvedBy ? ` por ${i.approvedBy}` : ""}{i.readbackState ? ` · comprobación ${i.readbackState}` : ""}{i.errorCode ? ` · ${i.errorCode}` : ""}</p>))}</div>}
    </div>
  );
}
