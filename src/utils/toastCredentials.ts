/**
 * Toast credential field mapping.
 *
 * The `provider_credentials` table uses explicit Toast-specific columns:
 *   toast_client_id     → client_id
 *   toast_client_secret → client_secret (stored server-side only)
 *   toast_access_token  → access_token (JWT from Toast auth)
 *   toast_refresh_token → refresh_token (if applicable)
 *   toast_expires_at    → token expiry
 *
 * The `pos_connections` table uses explicit columns:
 *   base_url            → api_hostname
 *   restaurant_guid     → restaurant GUID
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

/** Column name constants */
export const TOAST_CRED_MAP = {
  CLIENT_ID: "toast_client_id",
  CLIENT_SECRET: "toast_client_secret",
  ACCESS_TOKEN: "toast_access_token",
  REFRESH_TOKEN: "toast_refresh_token",
  EXPIRES_AT: "toast_expires_at",
} as const;

/**
 * Parse a raw provider_credentials row into a typed Toast credential object.
 * Reads only from explicit toast_* columns.
 */
export function parseToastCredentials(row: Record<string, unknown> | null): ToastCredentials | null {
  if (!row) return null;

  return {
    clientId: (row.toast_client_id as string) || "",
    clientSecret: (row.toast_client_secret as string) || "",
    accessToken: (row.toast_access_token as string) || null,
    refreshToken: (row.toast_refresh_token as string) || null,
    expiresAt: (row.toast_expires_at as string) || null,
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