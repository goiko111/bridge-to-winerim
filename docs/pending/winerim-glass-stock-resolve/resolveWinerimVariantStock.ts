// PENDIENTE DE OK DE GOIKO — NO está en supabase/functions/ para que no se publique solo.
// Sustituiría la búsqueda por GET /stock/wine/{id} en agora-proxy (l.~3131-3167).
// Motivo: /stock/wine/{id} solo devuelve formatos con stockActive=true; las copas
// (stockActive=false, lo normal) no salen → "Variant 'copa' not found".
// Fuente: GET /api/v2/wines (prices[]: isGlass, priceId, stockId; glass: bottlePriceId,
// bottleStockId, glassesPerBottle) y, de respaldo, GET /api/v2/stock del restaurante.
// sales/import se envía con format, stockId y priceId de la propia variante (copa → los de la copa).

export type Variant = string; // "botella" | "copa" | "magnum" | ...

export type ResolvedVariant = {
  wineId: string;
  variant: Variant;
  stockId: number;
  priceId: number | null;
  stock: number | null;
  stockActive: boolean | null;
  source: "wines" | "stock";
  /** isActive de la variante en /wines (null si no viene). Copa inactiva: Winerim la acepta si la botella está activa y con partición (respuesta equipo Winerim 2026-09-30). */
  isActive: boolean | null;
  glass?: { bottlePriceId: number | null; bottleStockId: number | null; glassesPerBottle: number | null; serviceable: boolean | null };
};

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function priceVariant(p: Record<string, unknown>, normalize: (s: unknown) => Variant | null): Variant | null {
  if (p.isGlass === true) return "copa";
  return normalize(p.format ?? p.variant ?? p.formatName ?? p.name);
}

/** Índice desde GET /wines: clave `${wineId}:${variant}`. */
export function indexFromWines(wines: unknown[], normalize: (s: unknown) => Variant | null): Map<string, ResolvedVariant> {
  const out = new Map<string, ResolvedVariant>();
  for (const w of wines as Record<string, unknown>[]) {
    const wineId = w?.id != null ? String(w.id) : null;
    if (!wineId || !Array.isArray(w.prices)) continue;
    for (const p of w.prices as Record<string, unknown>[]) {
      const variant = priceVariant(p, normalize);
      const stockId = num(p.stockId);
      if (!variant || !stockId) continue;
      const g = (p.glass ?? null) as Record<string, unknown> | null;
      const key = `${wineId}:${variant}`;
      if (out.has(key)) { out.delete(key); out.set(key + ":AMBIGUOUS", null as unknown as ResolvedVariant); continue; }
      if (out.has(key + ":AMBIGUOUS")) continue;
      out.set(key, {
        wineId, variant, stockId, priceId: num(p.priceId ?? p.id), stock: null, stockActive: null, source: "wines", isActive: typeof p.isActive === "boolean" ? p.isActive as boolean : null,
        ...(variant === "copa" ? { glass: { bottlePriceId: num(g?.bottlePriceId), bottleStockId: num(g?.bottleStockId), glassesPerBottle: num(g?.glassesPerBottle), serviceable: typeof g?.serviceable === "boolean" ? g.serviceable as boolean : null } } : {}),
      });
    }
  }
  return out;
}

/** Índice desde GET /stock del restaurante (incluye stockActive=false). */
export function indexFromStock(rows: unknown[], normalize: (s: unknown) => Variant | null): Map<string, ResolvedVariant> {
  const out = new Map<string, ResolvedVariant>();
  for (const r of rows as Record<string, unknown>[]) {
    const wineId = r?.wineId ?? (r?.wine as Record<string, unknown> | undefined)?.id;
    const variant = normalize(r?.variant ?? r?.format);
    const stockId = num(r?.id);
    if (wineId == null || !variant || !stockId) continue;
    const key = `${wineId}:${variant}`;
    if (out.has(key)) { out.delete(key); out.set(key + ":AMBIGUOUS", null as unknown as ResolvedVariant); continue; }
    if (out.has(key + ":AMBIGUOUS")) continue;
    out.set(key, {
      wineId: String(wineId), variant, stockId, priceId: num(r?.priceId), stock: Number.isFinite(Number(r?.stock)) ? Number(r?.stock) : null,
      stockActive: typeof r?.stockActive === "boolean" ? r.stockActive as boolean : null, source: "stock", isActive: typeof r?.isActive === "boolean" ? r.isActive as boolean : null,
    });
  }
  return out;
}

export type ResolveResult = { ok: true; value: ResolvedVariant } | { ok: false; code: "VARIANT_NOT_FOUND" | "VARIANT_AMBIGUOUS" | "STOCK_ID_MISMATCH" };

/**
 * /wines manda (trae priceId). /stock completa stock/stockActive.
 * Si ambos dan stockId distinto para la misma variante → falla cerrado (no envía).
 * Nunca cae a otra variante (copa ≠ botella).
 */
// Decisión de producto Goiko 2026-09-30 19:35: una venta real se registra aunque la copa
// esté inactiva (oculta) en la carta. isActive se conserva solo para informar.
export function resolveVariant(wineId: string, variant: Variant, wines: Map<string, ResolvedVariant>, stock: Map<string, ResolvedVariant>): ResolveResult {
  return resolveRaw(wineId, variant, wines, stock);
}

function resolveRaw(wineId: string, variant: Variant, wines: Map<string, ResolvedVariant>, stock: Map<string, ResolvedVariant>): ResolveResult {
  const key = `${wineId}:${variant}`;
  if (wines.has(key + ":AMBIGUOUS") || stock.has(key + ":AMBIGUOUS")) return { ok: false, code: "VARIANT_AMBIGUOUS" };
  const w = wines.get(key);
  const s = stock.get(key);
  if (w && s && w.stockId !== s.stockId) return { ok: false, code: "STOCK_ID_MISMATCH" };
  if (w) return { ok: true, value: { ...w, stock: s?.stock ?? null, stockActive: s?.stockActive ?? null, isActive: w.isActive ?? s?.isActive ?? null, priceId: w.priceId ?? s?.priceId ?? null } };
  if (s) return { ok: true, value: s };
  return { ok: false, code: "VARIANT_NOT_FOUND" };
}
