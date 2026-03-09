/**
 * Toast credential field mapping.
 *
 * The `provider_credentials` table now has explicit Toast-specific columns:
 *   toast_client_id     → client_id
 *   toast_client_secret → client_secret (stored server-side only)
 *   toast_access_token  → access_token (JWT from Toast auth)
 *   toast_refresh_token → refresh_token (if applicable)
 *   toast_expires_at    → token expiry
 *
 * Legacy columns are still populated for backward compatibility:
 *   merchant_id       → client_id (legacy)
 *   refresh_token_enc → client_secret (legacy)
 *   access_token_enc  → access_token (legacy)
 *   expires_at        → token expiry (legacy)
 *
 * This helper centralises the mapping so no code reads raw column names.
 */

export interface ToastCredentials {
  clientId: string;
  clientSecret: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
  status: string;
}

/** Column name constants used in the edge function */
export const TOAST_CRED_MAP = {
  // Primary (explicit) columns
  CLIENT_ID: "toast_client_id",
  CLIENT_SECRET: "toast_client_secret",
  ACCESS_TOKEN: "toast_access_token",
  REFRESH_TOKEN: "toast_refresh_token",
  EXPIRES_AT: "toast_expires_at",
  // Legacy columns (backward compat)
  LEGACY_CLIENT_ID: "merchant_id",
  LEGACY_CLIENT_SECRET: "refresh_token_enc",
  LEGACY_ACCESS_TOKEN: "access_token_enc",
  LEGACY_EXPIRES_AT: "expires_at",
} as const;

/**
 * Parse a raw provider_credentials row into a typed Toast credential object.
 * Prefers explicit columns but falls back to legacy for older connections.
 */
export function parseToastCredentials(row: Record<string, unknown> | null): ToastCredentials | null {
  if (!row) return null;
  
  // Prefer new explicit columns, fall back to legacy
  const accessToken = (row.toast_access_token as string) 
    || (row.access_token_enc !== "pending" ? (row.access_token_enc as string) : null) 
    || null;

  return {
    clientId: (row.toast_client_id as string) || (row.merchant_id as string) || "",
    clientSecret: (row.toast_client_secret as string) || (row.refresh_token_enc as string) || "",
    accessToken,
    refreshToken: (row.toast_refresh_token as string) || null,
    expiresAt: (row.toast_expires_at as string) || (row.expires_at as string) || null,
    status: (row.status as string) || "PENDING",
  };
}

/**
 * Check if Toast credentials have a valid (non-expired) access token.
 */
export function hasValidToken(cred: ToastCredentials | null): boolean {
  if (!cred?.accessToken || !cred.expiresAt) return false;
  const expiresAt = new Date(cred.expiresAt).getTime();
  return Date.now() < expiresAt - 30000; // 30s buffer
}
