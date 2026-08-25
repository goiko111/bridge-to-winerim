export interface AgoraHiddenGlassVariantPolicy {
  winerim_id: string;
  name: string;
  wine_type?: string | null;
  glass_sale_price: number;
  bottle_sale_price?: number;
  publish_bottle?: boolean;
  source?: string;
  captured_at?: string;
}

type WineLike = Record<string, unknown>;

function positiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  const parsed = String(value ?? "").trim();
  return parsed || undefined;
}

/**
 * A connection snapshot may make a Winerim variant publishable even when it is
 * absent from the public menu. It is an eligibility fallback, not an authority
 * over fresher per-format catalog values.
 */
export function mergeAgoraHiddenGlassPolicy(
  wine: WineLike | null | undefined,
  configured: AgoraHiddenGlassVariantPolicy,
): WineLike {
  const liveWine = wine || {};
  const liveGlassPrice = positiveNumber(liveWine.glass_sale_price);
  const liveBottlePrice = positiveNumber(liveWine.bottle_sale_price);
  const configuredBottlePrice = positiveNumber(configured.bottle_sale_price);
  const allowInactiveBottle = configured.publish_bottle === true &&
    (liveBottlePrice !== undefined || configuredBottlePrice !== undefined);

  return {
    ...liveWine,
    winerim_id: configured.winerim_id,
    id: liveWine.id || configured.winerim_id,
    name: nonEmptyString(liveWine.name) || configured.name,
    wine_type: nonEmptyString(liveWine.wine_type) || configured.wine_type || null,
    glass_sale_price: liveGlassPrice ?? configured.glass_sale_price,
    bottle_sale_price: allowInactiveBottle
      ? liveBottlePrice ?? configuredBottlePrice
      : liveWine.bottle_sale_price ?? null,
    serve_by_glass: true,
    raw_payload: {
      ...((liveWine.raw_payload && typeof liveWine.raw_payload === "object")
        ? liveWine.raw_payload as Record<string, unknown>
        : {}),
      agora_hidden_glass_variant: {
        source: configured.source || "CONNECTION_OVERRIDE",
        captured_at: configured.captured_at || null,
        glass_price_source: liveGlassPrice !== undefined
          ? "WINERIM_LIVE_FORMAT_PRICE"
          : "CONNECTION_SNAPSHOT_FALLBACK",
        bottle_price_source: liveBottlePrice !== undefined
          ? "WINERIM_LIVE_FORMAT_PRICE"
          : "CONNECTION_SNAPSHOT_FALLBACK",
      },
    },
    _agora_allow_inactive_glass: true,
    _agora_allow_inactive_bottle: allowInactiveBottle,
  };
}
