// Resolves the live family where new Agora glasses must be created.
export function pickLiveGlassFamily(
  families: { Id: string | number; Name: string }[] | null | undefined,
  mapping?: { id: string; name: string } | null,
): { id: string; name: string } | null {
  const list = families || [];
  if (mapping?.id) {
    const live = list.find((f) => String(f.Id) === String(mapping.id));
    if (live) return { id: String(live.Id), name: String(live.Name) };
  }
  const copas = list.find((f) => String(f.Name || "").trim().toUpperCase() === "COPAS WINERIM");
  return copas ? { id: String(copas.Id), name: String(copas.Name) } : null;
}
