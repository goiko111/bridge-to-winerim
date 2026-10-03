// New-product placement from live sibling products (Don Quijote / Albariza
// 2026-10-03): the printer route and the visible family are copied from
// existing products of the same wine type and format, never guessed by name.

export interface PlacementFamily { Id: string | number; Name?: string; ShowInPos?: string | boolean; DeletionDate?: string | null }
export interface PlacementProduct { Id: string | number; FamilyId?: string | number | null; PreparationTypeId?: string | null; PreparationOrderId?: string | null }
export interface ProductKind { wineType: string; format: string }

export function canonicalPlacementType(t: unknown): string {
  const s = String(t || "").trim().toLowerCase();
  if (s === "postre") return "dulce";
  if (s === "generoso") return "fortificado";
  return s;
}

export function canonicalPlacementFormat(f: unknown): string {
  const s = String(f || "").trim().toUpperCase();
  return s === "GLASS" ? "GLASS" : s === "BOTTLE" ? "BOTTLE" : s;
}

export function isFamilyVisible(f: PlacementFamily | undefined | null): boolean {
  if (!f) return false;
  if (String(f.DeletionDate || "").trim()) return false;
  return ["true", "1"].includes(String(f.ShowInPos ?? "").toLowerCase());
}

function mode(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN || (n === bestN && best !== null && v < best)) { best = v; bestN = n; }
  return best;
}

export interface SiblingPlacementInput {
  families: PlacementFamily[];
  products: PlacementProduct[];
  kinds: Map<string, ProductKind>;
  wineType: string | null | undefined;
  format: string;
  excludeProductId?: string;
  /** Routed family: siblings are counted in it even when it is hidden. */
  routedFamilyId?: string;
}

export interface SiblingPlacement {
  siblingCount: number;
  /** Most frequent complete PreparationTypeId/OrderId pair among siblings. */
  preparation: { typeId: string; orderId: string } | null;
  /** Most frequent visible family among siblings. */
  familyId: string | null;
  /** Siblings of the same type+format already living in the routed family (visible or not). */
  routedSiblingCount: number;
}

export function siblingPlacement(input: SiblingPlacementInput): SiblingPlacement {
  const type = canonicalPlacementType(input.wineType);
  const fmt = canonicalPlacementFormat(input.format);
  const visible = new Set(input.families.filter(isFamilyVisible).map((f) => String(f.Id)));
  const sameKind = (p: PlacementProduct): boolean => {
    const id = String(p.Id);
    if (input.excludeProductId && id === input.excludeProductId) return false;
    const k = input.kinds.get(id);
    if (!k || !type) return false;
    return canonicalPlacementType(k.wineType) === type && canonicalPlacementFormat(k.format) === fmt;
  };
  const siblings = input.products.filter((p) => sameKind(p) && visible.has(String(p.FamilyId ?? "")));
  const routedSiblingCount = input.routedFamilyId
    ? input.products.filter((p) => sameKind(p) && String(p.FamilyId ?? "") === String(input.routedFamilyId)).length
    : 0;
  const pairs = siblings
    .filter((p) => String(p.PreparationTypeId || "") && String(p.PreparationOrderId || ""))
    .map((p) => `${p.PreparationTypeId}|${p.PreparationOrderId}`);
  const pair = mode(pairs);
  return {
    siblingCount: siblings.length,
    preparation: pair ? { typeId: pair.split("|")[0], orderId: pair.split("|")[1] } : null,
    familyId: mode(siblings.map((p) => String(p.FamilyId))),
    routedSiblingCount,
  };
}

/**
 * Family for a NEW product: keep the routed family when it is visible, is
 * being created by this import, or already holds siblings of the same
 * type+format (sites selling from hidden Winerim families); else the visible
 * sibling family; else null (do not create).
 */
export function resolveVisibleFamily(
  routedFamilyId: string,
  routedNeedsCreate: boolean,
  families: PlacementFamily[],
  siblingFamilyId: string | null,
  routedSiblingCount = 0,
): { familyId: string | null; reason: string } {
  if (routedNeedsCreate) return { familyId: routedFamilyId, reason: "family_created_visible" };
  const routed = families.find((f) => String(f.Id) === String(routedFamilyId));
  if (isFamilyVisible(routed)) return { familyId: routedFamilyId, reason: "routed_visible" };
  if (routedSiblingCount > 0) return { familyId: routedFamilyId, reason: "routed_hidden_with_siblings" };
  if (siblingFamilyId) return { familyId: siblingFamilyId, reason: "sibling_visible_family" };
  return { familyId: null, reason: "no_visible_family" };
}

/** Printer for a NEW product: explicit route > siblings > connection default. */
export function resolvePreparation(
  explicitRoute: { typeId: string; orderId: string } | null,
  sibling: { typeId: string; orderId: string } | null,
  connectionDefault: { typeId: string; orderId: string },
): { typeId: string; orderId: string; source: "route" | "siblings" | "default" } {
  if (explicitRoute && explicitRoute.typeId && explicitRoute.orderId) return { ...explicitRoute, source: "route" };
  if (sibling) return { ...sibling, source: "siblings" };
  return { ...connectionDefault, source: "default" };
}
