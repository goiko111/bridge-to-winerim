const LOCAL_MIDDLEWARE_API_URL = "http://127.0.0.1:8787";
const STAGING_UI_HOST = "staging.middleware.winerim.wine";
const PRODUCTION_UI_HOST = "middleware.winerim.wine";
const STAGING_API_URL = "https://api-staging.middleware.winerim.wine";
const PRODUCTION_API_URL = "https://api.middleware.winerim.wine";

export function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function resolveMiddlewareApiUrl(configuredUrl?: string, currentOrigin?: string): string {
  const configured = String(configuredUrl || "").trim();
  if (configured) return stripTrailingSlashes(configured);

  if (currentOrigin) {
    try {
      const origin = new URL(currentOrigin);
      if (origin.hostname === STAGING_UI_HOST) return STAGING_API_URL;
      if (origin.hostname === PRODUCTION_UI_HOST) return PRODUCTION_API_URL;
    } catch {
      // Fall back to local dev below.
    }
  }

  return LOCAL_MIDDLEWARE_API_URL;
}
