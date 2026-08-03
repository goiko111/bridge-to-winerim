export interface AgoraProductNameCandidate {
  productId: string | number;
  baseName: string;
  winerimId?: string | number | null;
  vintage?: string | number | null;
}

export interface AgoraExistingProductName {
  Id?: string | number | null;
  Name?: string | null;
  ButtonText?: string | null;
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

function technicalFormatPrefix(value: string): string {
  return String(value || "").trim().match(/^(B|C|M)\b/i)?.[1]?.toUpperCase() || "";
}

function compactStableSuffix(value: string | number | null | undefined): string {
  const text = String(value ?? "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(-7);
}

export function buildAgoraButtonText(baseName: string, finalName: string, distinctiveSuffix?: string, maxLen = 20): string {
  const suffix = String(distinctiveSuffix || "").trim();
  if (!suffix) return truncateAgoraButtonText(finalName, maxLen);

  const suffixText = ` ${suffix}`;
  if (suffixText.length >= maxLen) {
    const formatPrefix = technicalFormatPrefix(baseName);
    if (!formatPrefix) return truncateAgoraButtonText(suffix, maxLen);
    return `${formatPrefix} ${truncateAgoraButtonText(suffix, maxLen - formatPrefix.length - 1)}`;
  }

  const headLen = maxLen - suffixText.length;
  const head = String(baseName || "").substring(0, headLen).trimEnd();
  return truncateAgoraButtonText(`${head || String(baseName || "").charAt(0)}${suffixText}`, maxLen);
}

function resolveAgoraButtonTextCollisions(
  candidates: AgoraProductNameCandidate[],
  existingProducts: AgoraExistingProductName[],
  labels: Record<string, AgoraProductLabel>,
  maxLen = 20,
): void {
  const entries = candidates
    .map((candidate) => ({
      candidate,
      productId: String(candidate.productId ?? "").trim(),
      baseName: String(candidate.baseName || "").trim(),
      vintage: normalizeVintage(candidate.vintage),
      initialButtonKey: normalizeAgoraProductNameKey(
        labels[String(candidate.productId ?? "").trim()]?.buttonText || "",
      ),
    }))
    .filter((entry) => entry.productId && entry.baseName && labels[entry.productId]);

  const generatedOwners = new Map<string, string[]>();
  const baseNameOwners = new Map<string, string[]>();
  for (const entry of entries) {
    generatedOwners.set(entry.initialButtonKey, [
      ...(generatedOwners.get(entry.initialButtonKey) ?? []),
      entry.productId,
    ]);
    const baseKey = normalizeAgoraProductNameKey(entry.baseName);
    baseNameOwners.set(baseKey, [...(baseNameOwners.get(baseKey) ?? []), entry.productId]);
  }

  const existingButtonOwners = new Map<string, Set<string>>();
  for (const product of existingProducts) {
    const id = String(product.Id ?? "").trim();
    const buttonText = String(product.ButtonText ?? "").trim();
    if (!id || !buttonText) continue;
    const key = normalizeAgoraProductNameKey(buttonText);
    const owners = existingButtonOwners.get(key) ?? new Set<string>();
    owners.add(id);
    existingButtonOwners.set(key, owners);
  }

  function hasExternalButtonOwner(buttonText: string, productId: string): boolean {
    const owners = existingButtonOwners.get(normalizeAgoraProductNameKey(buttonText));
    return Boolean(owners && [...owners].some((owner) => owner !== productId));
  }

  function needsResolution(entry: typeof entries[number]): boolean {
    const label = labels[entry.productId];
    const generated = generatedOwners.get(entry.initialButtonKey) ?? [];
    const duplicateBaseName = (
      baseNameOwners.get(normalizeAgoraProductNameKey(entry.baseName)) ?? []
    ).length > 1;
    const vintageWasLost = Boolean(
      entry.vintage && duplicateBaseName && !label.buttonText.includes(entry.vintage),
    );
    return generated.length > 1
      || hasExternalButtonOwner(label.buttonText, entry.productId)
      || vintageWasLost;
  }

  const usedButtonKeys = new Set<string>();
  for (const entry of entries) {
    if (!needsResolution(entry)) {
      usedButtonKeys.add(normalizeAgoraProductNameKey(labels[entry.productId].buttonText));
    }
  }

  const pending = entries
    .filter(needsResolution)
    .sort((left, right) => left.productId.localeCompare(right.productId, "en", { numeric: true }));

  for (const entry of pending) {
    const label = labels[entry.productId];
    const collisionGroup = entries.filter((candidate) => (
      candidate.initialButtonKey === entry.initialButtonKey
      || normalizeAgoraProductNameKey(candidate.baseName) === normalizeAgoraProductNameKey(entry.baseName)
    ));
    const vintageCount = entry.vintage
      ? collisionGroup.filter((candidate) => candidate.vintage === entry.vintage).length
      : 0;
    const id = entry.candidate.winerimId ?? entry.candidate.productId;
    const identifiers = [...suffixCandidates(id), compactStableSuffix(entry.productId)];
    const suffixes = [
      ...(entry.vintage && vintageCount === 1 ? [entry.vintage] : []),
      ...(entry.vintage ? identifiers.map((identifier) => `${entry.vintage}-${identifier}`) : []),
      ...identifiers,
    ];

    let resolved = "";
    for (const suffix of [...new Set(suffixes)]) {
      const candidate = buildAgoraButtonText(entry.baseName, label.name, suffix, maxLen);
      const key = normalizeAgoraProductNameKey(candidate);
      if (!usedButtonKeys.has(key) && !hasExternalButtonOwner(candidate, entry.productId)) {
        resolved = candidate;
        break;
      }
    }

    for (let attempt = 0; !resolved; attempt += 1) {
      const suffix = `${compactStableSuffix(entry.productId)}-${attempt.toString(36)}`;
      const candidate = buildAgoraButtonText(entry.baseName, label.name, suffix, maxLen);
      const key = normalizeAgoraProductNameKey(candidate);
      if (!usedButtonKeys.has(key) && !hasExternalButtonOwner(candidate, entry.productId)) {
        resolved = candidate;
      }
    }

    label.buttonText = resolved;
    usedButtonKeys.add(normalizeAgoraProductNameKey(resolved));
  }
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

  resolveAgoraButtonTextCollisions(candidates, existingProducts, finalLabels);

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
