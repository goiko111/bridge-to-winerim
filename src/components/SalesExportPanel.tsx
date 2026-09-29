import { useState } from "react";
import { Download, Loader2, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface Props {
  connectionId: string | null;
  connectionName?: string | null;
}

const PAGE = 1000;

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function firstOfMonthISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function SalesExportPanel({ connectionId, connectionName }: Props) {
  const { toast } = useToast();
  const [from, setFrom] = useState(firstOfMonthISO());
  const [to, setTo] = useState(todayISO());
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    if (!connectionId) return;
    if (!from || !to || from > to) {
      toast({ title: "Rango de fechas no válido", variant: "destructive" });
      return;
    }
    setExporting(true);
    try {
      // 1) Tickets del rango (paginado)
      const events: { id: string; business_day: string; provider_doc_id: string | null }[] = [];
      let offset = 0;
      for (;;) {
        const { data, error } = await supabase
          .from("sales_events")
          .select("id, business_day, provider_doc_id")
          .eq("connection_id", connectionId)
          .gte("business_day", from)
          .lte("business_day", to)
          .order("business_day")
          .range(offset, offset + PAGE - 1);
        if (error) throw error;
        events.push(...(data ?? []));
        if (!data || data.length < PAGE) break;
        offset += PAGE;
      }

      if (events.length === 0) {
        toast({ title: "Sin ventas en ese periodo", description: "No hay tickets guardados entre esas fechas." });
        return;
      }

      const eventById = new Map(events.map((e) => [e.id, e]));
      const eventIds = events.map((e) => e.id);

      // 2) Líneas de esos tickets (por lotes de 200 tickets)
      const lines: Record<string, unknown>[] = [];
      const CHUNK = 200;
      for (let i = 0; i < eventIds.length; i += CHUNK) {
        const chunk = eventIds.slice(i, i + CHUNK);
        let offset = 0;
        for (;;) {
          const { data, error } = await supabase
            .from("sales_line_items")
            .select("sales_event_id, provider_sold_at, provider_product_id, name, family, format, quantity, unit_price, total_amount, vat_rate, is_wine_candidate, mapped, winerim_product_id")
            .in("sales_event_id", chunk)
            .order("provider_sold_at")
            .range(offset, offset + PAGE - 1);
          if (error) throw error;
          lines.push(...(data ?? []));
          if (!data || data.length < PAGE) break;
          offset += PAGE;
        }
      }

      // 3) CSV
      const header = ["dia", "ticket", "fecha_hora", "producto_agora", "producto", "familia", "formato", "cantidad", "precio_unitario", "importe", "iva", "es_vino", "mapeado", "vino_winerim"];
      const rows = lines.map((l) => {
        const ev = eventById.get(l.sales_event_id as string);
        return [
          ev?.business_day ?? "",
          ev?.provider_doc_id ?? "",
          l.provider_sold_at ?? "",
          l.provider_product_id ?? "",
          l.name ?? "",
          l.family ?? "",
          l.format ?? "",
          l.quantity ?? "",
          l.unit_price ?? "",
          l.total_amount ?? "",
          l.vat_rate ?? "",
          l.is_wine_candidate ? "t" : "f",
          l.mapped ? "t" : "f",
          l.winerim_product_id ?? "",
        ].map(csvEscape).join(",");
      });
      const csv = [header.join(","), ...rows].join("\n");

      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const slug = (connectionName ?? "restaurante").toLowerCase().replace(/[^a-z0-9]+/g, "_");
      a.href = url;
      a.download = `ventas_${slug}_${from}_a_${to}.csv`;
      a.click();
      URL.revokeObjectURL(url);

      toast({ title: "Exportación lista", description: `${events.length} tickets, ${lines.length} líneas.` });
    } catch (err) {
      toast({ title: "Error al exportar", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 backdrop-blur-sm p-5 space-y-4">
      <div className="flex items-center gap-2">
        <FileSpreadsheet className="h-5 w-5 text-primary" />
        <h3 className="text-lg font-semibold text-foreground">Exportar ventas</h3>
      </div>
      <p className="text-sm text-muted-foreground">
        Descarga un CSV con todas las líneas de venta del restaurante seleccionado entre dos fechas.
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="export-from">Desde</Label>
          <Input id="export-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="export-to">Hasta</Label>
          <Input id="export-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </div>
        <Button onClick={handleExport} disabled={!connectionId || exporting}>
          {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
          {exporting ? "Exportando…" : "Descargar CSV"}
        </Button>
      </div>
      {!connectionId && (
        <p className="text-sm text-muted-foreground">Selecciona primero un restaurante para poder exportar.</p>
      )}
    </div>
  );
}
