import {
  CatalogFormat,
  CatalogHandlerResult,
  CatalogRequest,
  CatalogRequestAction,
} from "./contracts";

const REQUEST_ACTIONS = new Set<CatalogRequestAction>([
  "catalog.preview",
  "catalog.apply",
  "preview-xml",
  "xml-import",
]);
const FORMATS = new Set<CatalogFormat>(["BOTTLE", "GLASS", "MAGNUM"]);
const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export type CatalogRequestValidation =
  | { ok: true; request: CatalogRequest }
  | { ok: false; result: Extract<CatalogHandlerResult, { ok: false }> };

function failure(
  code: Extract<CatalogHandlerResult, { ok: false }>["error"]["code"],
  message: string,
): CatalogRequestValidation {
  return { ok: false, result: { ok: false, status: 400, error: { code, message } } };
}

function normalizeFormats(value: unknown, action: CatalogRequestAction): readonly CatalogFormat[] | null {
  const defaultFormats: CatalogFormat[] = action === "preview-xml"
    ? ["BOTTLE", "MAGNUM"]
    : ["BOTTLE"];
  if (value === undefined) return defaultFormats;
  if (!Array.isArray(value) || value.length === 0) return null;

  const formats: CatalogFormat[] = [];
  for (const raw of value) {
    const normalized = String(raw || "").trim().toUpperCase();
    const format = normalized === "COPA" ? "GLASS" : normalized;
    if (!FORMATS.has(format as CatalogFormat)) return null;
    if (!formats.includes(format as CatalogFormat)) formats.push(format as CatalogFormat);
  }
  return formats;
}

function normalizeWineSelection(value: unknown): CatalogRequest["wineSelection"] | null {
  if (value === undefined) return { kind: "all" };
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids = [...new Set(value.map((id) => String(id || "").trim()).filter(Boolean))];
  if (ids.length !== value.length || ids.some((id) => !/^\d+$/.test(id) || Number(id) <= 0)) return null;
  return { kind: "ids", ids: ids.sort((left, right) => Number(left) - Number(right)) };
}

export function validateCatalogRequest(value: unknown): CatalogRequestValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return failure("INVALID_REQUEST", "Catalog request must be an object.");
  }

  const input = value as Record<string, unknown>;
  const action = String(input.action || "") as CatalogRequestAction;
  if (!REQUEST_ACTIONS.has(action)) {
    return failure("UNSUPPORTED_ACTION", "Unsupported catalog action.");
  }

  const connectionId = String(input.connectionId || "").trim();
  if (!CONNECTION_ID.test(connectionId)) {
    return failure("INVALID_CONNECTION_ID", "A valid connectionId is required.");
  }

  const formats = normalizeFormats(input.formatTypes ?? input.formats, action);
  if (!formats) return failure("INVALID_FORMAT", "At least one supported catalog format is required.");

  const wineSelection = normalizeWineSelection(input.winerimWineIds ?? input.wineIds);
  if (!wineSelection) return failure("INVALID_WINE_SELECTION", "Wine IDs must be unique positive integers.");

  const canonicalAction = action === "preview-xml" || action === "catalog.preview" ? "preview" : "apply";
  const dryRun = canonicalAction === "preview" ? true : input.dryRun === true;

  return {
    ok: true,
    request: {
      action,
      canonicalAction,
      connectionId,
      dryRun,
      formats,
      wineSelection,
    },
  };
}
