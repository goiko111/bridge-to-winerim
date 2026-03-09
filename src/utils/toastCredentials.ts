/**
 * Toast credential field mapping.
 *
 * The `provider_credentials` table has generic columns. For Toast we map:
 *   merchant_id       → client_id
 *   refresh_token_enc → client_secret  (stored server-side only)
 *   access_token_enc  → access_token   (JWT from Toast auth)
 *   expires_at        → token expiry
 *
 * This helper centralises the mapping so no code reads raw column names.
 */

export interface ToastCredentials {
  clientId: string;
  clientSecret: string;
  accessToken: string | null;
  expiresAt: string | null;
  status: string;
}

/** Column name constants used in the edge function */
export const TOAST_CRED_MAP = {
  CLIENT_ID: "merchant_id",
  CLIENT_SECRET: "refresh_token_enc",
  ACCESS_TOKEN: "access_token_enc",
  EXPIRES_AT: "expires_at",
} as const;

/**
 * Parse a raw provider_credentials row into a typed Toast credential object.
 */
export function parseToastCredentials(row: Record<string, unknown> | null): ToastCredentials | null {
  if (!row) return null;
  return {
    clientId: (row.merchant_id as string) || "",
    clientSecret: (row.refresh_token_enc as string) || "",
    accessToken: (row.access_token_enc as string) || null,
    expiresAt: (row.expires_at as string) || null,
    status: (row.status as string) || "PENDING",
  };
}
