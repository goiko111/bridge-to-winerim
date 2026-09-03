function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function normalizeCommercialCode(value: unknown): string | null {
  const normalized = stripDiacritics(String(value ?? ""))
    .toUpperCase()
    .replace(/&AMP;/g, "&")
    .replace(/[^A-Z0-9]/g, "");

  return normalized.length > 0 ? normalized : null;
}

export function extractCommercialCodeFromName(value: unknown): string | null {
  let name = stripDiacritics(String(value ?? ""))
    .replace(/&amp;/gi, "&")
    .toUpperCase()
    .trim();

  if (!name) return null;

  name = name.replace(/^(BOTELLA|BOT\.?|BOTTLE)\s+/, "B ");
  name = name.replace(/^(COPA|GLASS)\s+/, "C ");

  // Generated Agora labels use a format prefix before Winerim's code:
  // "B T31-Semele", "C B303-Binitord", "M MAGNUM 21 - ...".
  name = name.replace(/^(B|C)\s+(?=(?:[A-Z]{1,3}\s*-?\s*\d+[A-Z]?\s*-|MAGNUM\s*\d+[A-Z]?\s*-))/, "");
  name = name.replace(/^M\s+(?=MAGNUM\s*\d+[A-Z]?\s*-)/, "");

  const magnum = name.match(/^MAGNUM\s*(\d+[A-Z]?)\s*-/);
  if (magnum) return normalizeCommercialCode(`MAGNUM${magnum[1]}`);

  const code = name.match(/^([A-Z]{1,3})\s*-?\s*(\d+[A-Z]?)\s*-/);
  if (code) return normalizeCommercialCode(`${code[1]}${code[2]}`);

  return null;
}
