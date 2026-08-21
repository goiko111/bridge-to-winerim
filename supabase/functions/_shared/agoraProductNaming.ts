export interface AgoraProductNameCandidate {
  productId: string | number;
  baseName: string;
  winerimId?: string | number | null;
  vintage?: string | number | null;
}

export interface AgoraExistingProductName {
  Id?: string | number | null;
  Name?: string | null;
}

export interface AgoraProductLabel {
  name: string;
  buttonText: string;
}

export interface AgoraProductNamingPolicy {
  vintageDisambiguationProductIds?: readonly (string | number)[];
  preferVintageForDuplicateNames?: boolean;
}

export function configuredAgoraProductNameOverride(
  providerConfig: Record<string, unknown> | null | undefined,
  productId: string | number,
): string | null {
  const rawOverrides = providerConfig?.agora_product_name_overrides;
  if (!rawOverrides || typeof rawOverrides !== "object" || Array.isArray(rawOverrides)) return null;
  const value = (rawOverrides as Record<string, unknown>)[String(productId)];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeAgoraProductNameKey(name: string): string {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function truncateAgoraButtonText(text: string, maxLen = 20): string {
  const value = String(text || "");
  return value.length <= maxLen ? value : value.substring(0, maxLen);
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

function normalizeVintage(vintage: string | number | null | undefined): string {
  const value = String(vintage ?? "").trim();
  const year = value.match(/\b(18|19|20)\d{2}\b/);
  return year ? year[0] : "";
}

export function buildAgoraButtonText(baseName: string, finalName: string, distinctiveSuffix?: string, maxLen = 20): string {
  const suffix = String(distinctiveSuffix || "").trim();
  if (!suffix) return truncateAgoraButtonText(finalName, maxLen);

  const suffixText = ` ${suffix}`;
  if (suffixText.length >= maxLen) return truncateAgoraButtonText(suffix, maxLen);

  const headLen = maxLen - suffixText.length;
  const head = String(baseName || "").substring(0, headLen).trimEnd();
  return truncateAgoraButtonText(`${head || String(baseName || "").charAt(0)}${suffixText}`, maxLen);
}

export function buildDuplicateSafeAgoraProductLabels(
  candidates: AgoraProductNameCandidate[],
  existingProducts: AgoraExistingProductName[] = [],
  policy: AgoraProductNamingPolicy = {},
): Record<string, AgoraProductLabel> {
  const existingNameOwners = new Map<string, Set<string>>();
  const preferVintageForDuplicateNames = policy.preferVintageForDuplicateNames !== false;
  const vintageDisambiguationProductIds = new Set(
    (policy.vintageDisambiguationProductIds || [])
      .map((id) => String(id ?? "").trim())
      .filter(Boolean),
  );

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
  const finalLabels: Record<string, AgoraProductLabel> = {};

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
    const duplicateGeneratedName = sorted.length > 1;
    const externalBaseCollision = [...(existingNameOwners.get(normalizeAgoraProductNameKey(baseName)) ?? new Set<string>())]
      .some((owner) => !generatedIds.has(owner));

    sorted.forEach((entry, index) => {
      const productId = String(entry.productId);
      let finalName = String(entry.baseName || "").trim();
      let distinctiveSuffix = "";
      let distinctiveSuffixIsVintage = false;
      const vintage = normalizeVintage(entry.vintage);
      const allowVintageDisambiguation = vintageDisambiguationProductIds.has(productId);
      const shouldPreferVintage = Boolean(
        vintage
        && (duplicateGeneratedName || externalBaseCollision)
        && (preferVintageForDuplicateNames || allowVintageDisambiguation),
      );
      const mustDisambiguate = index > 0 || externalBaseCollision || !isAvailable(finalName, productId);

      if (shouldPreferVintage || mustDisambiguate) {
        const suffixes = [
          ...(shouldPreferVintage ? [{ value: vintage, isVintage: true }] : []),
          ...suffixCandidates(entry.winerimId ?? entry.productId).map((value) => ({ value, isVintage: false })),
        ];
        finalName = "";
        for (const suffix of suffixes) {
          const candidateName = `${entry.baseName} ${suffix.value}`.trim();
          if (isAvailable(candidateName, productId)) {
            finalName = candidateName;
            distinctiveSuffix = suffix.value;
            distinctiveSuffixIsVintage = suffix.isVintage;
            break;
          }
        }
        if (!finalName) {
          finalName = `${entry.baseName} ${productId}`.trim();
          distinctiveSuffix = productId;
          distinctiveSuffixIsVintage = false;
        }
      }

      finalLabels[productId] = {
        name: finalName,
        buttonText: distinctiveSuffixIsVintage
          ? buildAgoraButtonText(String(entry.baseName || "").trim(), finalName, distinctiveSuffix)
          : truncateAgoraButtonText(finalName),
      };
      assignedKeys.add(normalizeAgoraProductNameKey(finalName));
    });
  }

  return finalLabels;
}

export function buildDuplicateSafeAgoraProductNames(
  candidates: AgoraProductNameCandidate[],
  existingProducts: AgoraExistingProductName[] = [],
  policy: AgoraProductNamingPolicy = {},
): Record<string, string> {
  const labels = buildDuplicateSafeAgoraProductLabels(candidates, existingProducts, policy);
  return Object.fromEntries(Object.entries(labels).map(([productId, label]) => [productId, label.name]));
}
