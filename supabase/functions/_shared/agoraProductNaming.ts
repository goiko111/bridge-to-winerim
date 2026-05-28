export interface AgoraProductNameCandidate {
  productId: string | number;
  baseName: string;
  winerimId?: string | number | null;
}

export interface AgoraExistingProductName {
  Id?: string | number | null;
  Name?: string | null;
}

export function normalizeAgoraProductNameKey(name: string): string {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function suffixCandidates(id: string | number | null | undefined): string[] {
  const raw = String(id ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  const source = digits || raw;
  const candidates = [
    source.length > 3 ? source.slice(-3) : source,
    source.length > 6 ? source.slice(-6) : source,
    source,
  ].filter(Boolean);

  return [...new Set(candidates)];
}

export function buildDuplicateSafeAgoraProductNames(
  candidates: AgoraProductNameCandidate[],
  existingProducts: AgoraExistingProductName[] = [],
): Record<string, string> {
  const existingNameOwners = new Map<string, Set<string>>();

  for (const product of existingProducts) {
    const id = String(product.Id ?? "").trim();
    const name = String(product.Name ?? "").trim();
    if (!id || !name) continue;
    const key = normalizeAgoraProductNameKey(name);
    const owners = existingNameOwners.get(key) ?? new Set<string>();
    owners.add(id);
    existingNameOwners.set(key, owners);
  }

  const byBaseName = new Map<string, AgoraProductNameCandidate[]>();
  for (const candidate of candidates) {
    const baseName = String(candidate.baseName || "").trim();
    const productId = String(candidate.productId ?? "").trim();
    if (!baseName || !productId) continue;
    const key = normalizeAgoraProductNameKey(baseName);
    const group = byBaseName.get(key) ?? [];
    group.push(candidate);
    byBaseName.set(key, group);
  }

  const assignedKeys = new Set<string>();
  const finalNames: Record<string, string> = {};

  function hasExternalOwner(name: string, productId: string): boolean {
    const owners = existingNameOwners.get(normalizeAgoraProductNameKey(name));
    if (!owners) return false;
    return [...owners].some((owner) => owner !== productId);
  }

  function isAvailable(name: string, productId: string): boolean {
    const key = normalizeAgoraProductNameKey(name);
    return !assignedKeys.has(key) && !hasExternalOwner(name, productId);
  }

  for (const group of byBaseName.values()) {
    const sorted = [...group].sort((a, b) => {
      const aId = String(a.productId);
      const bId = String(b.productId);
      return aId.localeCompare(bId, "en", { numeric: true });
    });

    const baseName = String(sorted[0]?.baseName || "").trim();
    const generatedIds = new Set(sorted.map((entry) => String(entry.productId)));
    const externalBaseCollision = [...(existingNameOwners.get(normalizeAgoraProductNameKey(baseName)) ?? new Set<string>())]
      .some((owner) => !generatedIds.has(owner));

    sorted.forEach((entry, index) => {
      const productId = String(entry.productId);
      let finalName = String(entry.baseName || "").trim();

      if (index > 0 || externalBaseCollision || !isAvailable(finalName, productId)) {
        const suffixes = suffixCandidates(entry.winerimId ?? entry.productId);
        finalName = "";
        for (const suffix of suffixes) {
          const candidateName = `${entry.baseName} ${suffix}`.trim();
          if (isAvailable(candidateName, productId)) {
            finalName = candidateName;
            break;
          }
        }
        if (!finalName) {
          finalName = `${entry.baseName} ${productId}`.trim();
        }
      }

      finalNames[productId] = finalName;
      assignedKeys.add(normalizeAgoraProductNameKey(finalName));
    });
  }

  return finalNames;
}
