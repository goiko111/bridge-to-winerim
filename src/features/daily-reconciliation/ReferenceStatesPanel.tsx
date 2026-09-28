import { useMemo } from "react";
import { buildCsv, referenceState, type Tracking } from "../../../supabase/functions/_shared/reconciliation-v2/closure";
import { CLINIC_PETALOS_2023, CLINIC_PETALOS_2023_PUBLISHED } from "../../../supabase/functions/_shared/reconciliation-v2/fixtures/reference-states";

// Read model de estado por referencia. Hasta tener readback real se muestran solo
// fixtures contractuales, marcados como tales; nada se certifica por inferencia.
export function ReferenceStatesPanel() {
  const rows = useMemo(() => {
    const tracking = new Map<string, Tracking>();
    return [
      { origin: "Fixture real", input: CLINIC_PETALOS_2023, r: referenceState(CLINIC_PETALOS_2023, tracking, "2026-09-28T09:30:00Z") },
      { origin: "Fixture sintético", input: CLINIC_PETALOS_2023_PUBLISHED, r: referenceState(CLINIC_PETALOS_2023_PUBLISHED, new Map(), "2026-09-28T09:30:00Z") },
    ];
  }, []);
  const csv = () => {
    const out = buildCsv(rows.map(({ origin, input, r }) => ({ origen: origin, restaurante: input.restaurantName, menuId: input.menuId, wineId: input.wineId, vino: `${input.name} ${input.vintage}`, formato: input.format, precio_eur: input.priceMinor / 100, stock: input.stock, estado: r.state, incidencia: r.isIncident ? "SI" : "NO", centro_venta: String(r.agora.salesCenter), lista_precios: String(r.agora.priceList), familia: String(r.agora.family), visible: String(r.agora.visible), vendible: String(r.agora.saleable), precio_agora: String(r.agora.priceMinor), fuente_agora: r.agora.source, motivo: r.reason })), { complete: false, reason: "fixtures; sin readback real" });
    const url = URL.createObjectURL(new Blob([out.body], { type: "text/csv" })); const a = document.createElement("a"); a.href = url; a.download = `referencias_${out.filename}`; a.click(); URL.revokeObjectURL(url);
  };
  return <section className="rounded-2xl border bg-card p-5">
    <div className="mb-3 flex items-center justify-between"><div><h2 className="text-lg font-semibold">Estado por referencia</h2><p className="text-xs text-muted-foreground">Fixtures contractuales · sin readback real de Ágora (DESCONOCIDO = sin dato, nunca certificado)</p></div><button className="rounded-lg border px-3 py-2 text-sm" onClick={csv}>CSV (incompleto)</button></div>
    <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-xs uppercase text-muted-foreground"><tr>{["Origen","Restaurante","Vino","Formato","Precio","Stock","Estado","Incidencia","Centro","Lista","Familia","Visible","Vendible","Precio Ágora","Motivo"].map((h) => <th key={h} className="px-2 py-1">{h}</th>)}</tr></thead>
      <tbody>{rows.map(({ origin, input, r }) => <tr key={origin} className="border-t"><td className="px-2 py-1">{origin}</td><td className="px-2 py-1">{input.restaurantName} (menú {input.menuId})</td><td className="px-2 py-1">{input.name} {input.vintage} · #{input.wineId}</td><td className="px-2 py-1">{input.format}</td><td className="px-2 py-1">{input.priceMinor / 100} €</td><td className="px-2 py-1">{input.stock}</td><td className="px-2 py-1 font-medium">{r.state}</td><td className="px-2 py-1">{r.isIncident ? "Sí" : "No"}</td><td className="px-2 py-1">{String(r.agora.salesCenter)}</td><td className="px-2 py-1">{String(r.agora.priceList)}</td><td className="px-2 py-1">{String(r.agora.family)}</td><td className="px-2 py-1">{String(r.agora.visible)}</td><td className="px-2 py-1">{String(r.agora.saleable)}</td><td className="px-2 py-1">{typeof r.agora.priceMinor === "number" ? `${r.agora.priceMinor / 100} €` : r.agora.priceMinor}</td><td className="px-2 py-1 text-muted-foreground">{r.reason}</td></tr>)}</tbody></table></div>
  </section>;
}
